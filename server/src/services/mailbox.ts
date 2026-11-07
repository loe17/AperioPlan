/**
 * Persönliche Postfächer: IMAP-Ordner werden zwischengespeichert (schnelle Liste, Suche, Unterhaltungen),
 * jede Aktion (gelesen, markieren, verschieben, löschen) geht sofort auch an den Mail-Server.
 *
 * Seit 0.4.0: je Postfach nur EINE Verbindung, die einige Minuten offen bleibt; alle Aufträge laufen nacheinander.
 * Viele Anbieter (z. B. netcup) erlauben nur wenige gleichzeitige Verbindungen – vorher ließ das Senden scheitern.
 * Feste Zeitgrenzen, verständliche Fehlermeldungen, Verlauf je Postfach und ein Postausgang mit Nachsenden.
 */
import { ImapFlow, type ListResponse } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import { HttpError } from '../lib/errors';
import { openSecret } from './secrets';
import { safeName } from './files';
import { FakeImap, fakeSmtp, isFakeHost } from './mailFake';
import { accessTokenFor } from './mailOAuth';

export interface MailAccount {
  id: string; user_id: string | null; owner_id: string; email: string; display_name: string; imap_host: string; imap_port: number; imap_secure: boolean;
  smtp_host: string; smtp_port: number; smtp_secure: boolean; username: string; password_sealed: string; signature_html: string;
  auth_kind: 'password' | 'microsoft' | 'google'; oauth_sealed: string | null; folder_map: Record<string, string>; provider: string; label: string;
  sig_new: string; sig_reply: string; sort: number; last_sync_at?: Date | null; last_error?: string | null;
}
interface Folder { id: string; path: string; uidvalidity: string | null; last_uid: string; special_use: string | null }

/** Teile von ImapFlow, die hier genutzt werden (auch vom nachgebildeten Server erfüllt) */
export type Imap = Pick<ImapFlow, 'list' | 'status' | 'getMailboxLock' | 'fetch' | 'messageFlagsAdd' | 'messageFlagsRemove' | 'messageMove' | 'messageDelete' | 'append' | 'logout' | 'close'> & { usable: boolean; mailbox: ImapFlow['mailbox'] };

const addr = (a: AddressObject | AddressObject[] | undefined) =>
  !a ? '' : (Array.isArray(a) ? a : [a]).flatMap((x) => x.value.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address ?? ''))).join(', ');

const SPECIAL_SORT: Record<string, number> = { '\\Inbox': 0, '\\Drafts': 2, '\\Sent': 3, '\\Archive': 4, '\\Junk': 5, '\\Trash': 6 };
const SPECIAL_NAME: Record<string, string> = { '\\Inbox': 'Posteingang', '\\Drafts': 'Entwürfe', '\\Sent': 'Gesendet', '\\Archive': 'Archiv', '\\Junk': 'Spam', '\\Trash': 'Papierkorb' };
export const SPECIAL_KEYS: Record<string, string> = { sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', junk: '\\Junk', archive: '\\Archive' };
/** Meldet der Server nicht, welcher Ordner welcher ist: nach dem Namen zuordnen */
const BY_NAME: [RegExp, string][] = [
  [/^(sent|sent items|sent messages|sent mail|gesendet|gesendete (objekte|elemente|e-mails|nachrichten))$/i, '\\Sent'],
  [/^(drafts|draft|entw(ü|ue)rfe)$/i, '\\Drafts'],
  [/^(trash|deleted|deleted items|deleted messages|papierkorb|gel(ö|oe)schte (objekte|elemente))$/i, '\\Trash'],
  [/^(junk|spam|junk e-mail|junk-e-mail|bulk mail)$/i, '\\Junk'],
  [/^(archive|archiv)$/i, '\\Archive'],
];
export function guessSpecial(path: string, delimiter = '/') {
  const leaf = path.split(delimiter).pop() ?? path;
  return BY_NAME.find(([re]) => re.test(leaf.trim()))?.[1] ?? null;
}

const testing = () => process.env.NODE_ENV === 'test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, testing() ? Math.min(ms, 30) : ms));

// ------------------------------------------------------------------ Fehler in Klartext
export interface MailProblem { text: string; tip: string; transient: boolean; auth: boolean }
export function explainMailError(e: unknown, phase: 'imap' | 'smtp', a?: { imap_host?: string; smtp_host?: string; imap_port?: number; smtp_port?: number }): MailProblem {
  const err = e as { message?: string; code?: string; responseCode?: number; authenticationFailed?: boolean; response?: string };
  const msg = `${err.message ?? ''} ${err.response ?? ''}`;
  const host = phase === 'imap' ? a?.imap_host : a?.smtp_host;
  const port = phase === 'imap' ? a?.imap_port : a?.smtp_port;
  const what = phase === 'imap' ? 'Der Server für eingehende Post' : 'Der Server für ausgehende Post';
  if (err.authenticationFailed || err.code === 'EAUTH' || err.responseCode === 535 || err.responseCode === 534 || /authenticat|invalid credentials|login failed|AUTHENTICATIONFAILED|password/i.test(msg)) {
    return { auth: true, transient: false, text: `${what} hat Benutzername oder Passwort abgelehnt.`, tip: 'Passwort prüfen. Bei manchen Anbietern ist ein App-Passwort nötig, oder der Zugriff per Mailprogramm muss im Postfach des Anbieters erst erlaubt werden.' };
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || /ENOTFOUND|getaddrinfo/i.test(msg)) {
    return { auth: false, transient: err.code === 'EAI_AGAIN', text: `Der Server „${host ?? '?'}“ wurde nicht gefunden.`, tip: 'Den Servernamen prüfen. Er steht im Kundenbereich Ihres Anbieters (bei netcup unter „Mailprogramme konfigurieren“).' };
  }
  if (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
    return { auth: false, transient: false, text: `${what} lehnt Verbindungen auf Anschluss ${port ?? '?'} ab.`, tip: phase === 'imap' ? 'Üblich sind 993 (SSL/TLS) oder 143 (STARTTLS).' : 'Üblich sind 465 (SSL/TLS) oder 587 (STARTTLS).' };
  }
  if (/certificate|self.signed|SSL routines|wrong version number|tls|EPROTO/i.test(msg)) {
    return { auth: false, transient: false, text: 'Die verschlüsselte Verbindung kam nicht zustande.', tip: 'Verschlüsselung und Anschluss passen vermutlich nicht zusammen: 993 bzw. 465 = SSL/TLS, 143 bzw. 587 = STARTTLS.' };
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ETIMEOUT' || err.code === 'ECONNRESET' || err.code === 'ESOCKET' || /timed? ?out|Greeting never received|socket hang up|ECONNRESET|connection closed/i.test(msg)) {
    return { auth: false, transient: true, text: `${what} antwortet nicht (Zeitüberschreitung oder Verbindung abgebrochen).`, tip: 'Meist nur kurz. Bleibt es dabei: Servername und Anschluss prüfen, eine Firewall könnte den Anschluss sperren.' };
  }
  if ([421, 450, 451, 452, 454].includes(err.responseCode ?? 0) || /too many|try again later|temporar|rate limit|throttl/i.test(msg)) {
    return { auth: false, transient: true, text: `${what} ist gerade überlastet oder meldet zu viele Verbindungen.`, tip: 'AperioPlan versucht es automatisch erneut.' };
  }
  if (err.responseCode === 552 || /size|too large|zu gro/i.test(msg)) {
    return { auth: false, transient: false, text: 'Die E-Mail ist für den Server zu groß.', tip: 'Anhänge verkleinern oder als Link aus dem Projekt verschicken.' };
  }
  if ([550, 551, 553, 554].includes(err.responseCode ?? 0) || err.code === 'EENVELOPE') {
    return { auth: false, transient: false, text: `Der Server hat die E-Mail abgelehnt: ${(err.response ?? err.message ?? '').slice(0, 200)}`, tip: 'Empfängeradressen prüfen. Manche Server erlauben nur die eigene Adresse als Absender.' };
  }
  return { auth: false, transient: false, text: `Unerwarteter Fehler: ${(err.message ?? String(e)).slice(0, 200)}`, tip: 'Bitte im Verlauf des Postfachs nachsehen oder die Verbindung testen.' };
}

// ------------------------------------------------------------------ Verlauf
export async function logEvent(ctx: AppContext, accountId: string, level: 'info' | 'warn' | 'error', text: string) {
  try {
    await ctx.sql`insert into mail_events (account_id, level, text) values (${accountId}, ${level}, ${text.slice(0, 1000)})`;
    if (Math.random() < 0.1) await ctx.sql`delete from mail_events where account_id = ${accountId} and id < (select id from mail_events where account_id = ${accountId} order by id desc offset 200 limit 1)`;
  } catch { /* Verlauf ist nicht kritisch */ }
}

// ------------------------------------------------------------------ Verbindungen
async function credentials(ctx: AppContext, a: MailAccount): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (a.auth_kind !== 'password') return { user: a.username, accessToken: await accessTokenFor(ctx, a) };
  return { user: a.username, pass: (await openSecret(ctx, a.password_sealed)) ?? '' };
}

/** Neue, nicht geteilte Verbindung (Test im Assistenten, Abruf beim Einrichten) */
export async function connectImap(ctx: AppContext, a: MailAccount, auth?: { user: string; pass?: string; accessToken?: string }): Promise<Imap> {
  const creds = auth ?? (await credentials(ctx, a));
  const c = isFakeHost(a.imap_host)
    ? new FakeImap({ host: a.imap_host, auth: creds })
    : new ImapFlow({ host: a.imap_host, port: a.imap_port, secure: a.imap_secure, auth: creds, logger: false,
      connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 120_000, disableAutoIdle: true,
      tls: { rejectUnauthorized: process.env.MAIL_TLS_STRICT !== 'false' } });
  (c as unknown as { on: (e: string, f: () => void) => void }).on('error', () => { /* wird über den Auftrag gemeldet */ });
  await c.connect();
  return c as unknown as Imap;
}

export async function smtpFor(ctx: AppContext, a: MailAccount, auth?: { user: string; pass?: string; accessToken?: string }) {
  const creds = auth ?? (await credentials(ctx, a));
  if (isFakeHost(a.smtp_host)) return fakeSmtp({ host: a.smtp_host, auth: creds });
  return nodemailer.createTransport({
    host: a.smtp_host, port: a.smtp_port, secure: a.smtp_secure,
    auth: creds.accessToken ? { type: 'OAuth2', user: creds.user, accessToken: creds.accessToken } : { user: creds.user, pass: creds.pass },
    connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000,
    tls: { rejectUnauthorized: process.env.MAIL_TLS_STRICT !== 'false' },
  });
}

interface Slot { client: Imap | null; chain: Promise<unknown>; idle: NodeJS.Timeout | null; account: MailAccount }
const slots = new Map<string, Slot>();
const IDLE_MS = 2 * 60_000;

/**
 * Auftrag mit der (einen) Verbindung des Postfachs ausführen. Aufträge laufen nacheinander;
 * die Verbindung bleibt nach dem letzten Auftrag noch zwei Minuten offen.
 */
export function withImap<T>(ctx: AppContext, a: MailAccount, fn: (c: Imap) => Promise<T>): Promise<T> {
  let slot = slots.get(a.id);
  if (!slot) { slot = { client: null, chain: Promise.resolve(), idle: null, account: a }; slots.set(a.id, slot); }
  slot.account = a;
  const s = slot;
  const run = async () => {
    if (s.idle) { clearTimeout(s.idle); s.idle = null; }
    try {
      if (!s.client || !s.client.usable) {
        s.client = null;
        s.client = await connectImap(ctx, s.account);
      }
      return await fn(s.client);
    } catch (e) {
      const c = s.client; s.client = null;
      try { c?.close(); } catch { /* schon zu */ }
      throw e;
    } finally {
      s.idle = setTimeout(() => { const c = s.client; s.client = null; s.idle = null; if (c) void c.logout().catch(() => {}); }, IDLE_MS);
      s.idle.unref?.();
    }
  };
  const p = s.chain.then(run, run);
  s.chain = p.catch(() => {});
  return p;
}

/** Verbindung schließen (nach Änderung der Zugangsdaten oder beim Entfernen) */
export function dropConnection(accountId: string) {
  const s = slots.get(accountId);
  if (!s) return;
  slots.delete(accountId);
  if (s.idle) clearTimeout(s.idle);
  const c = s.client; s.client = null;
  if (c) void s.chain.then(() => c.logout().catch(() => {}));
}

export async function closeAllConnections() {
  for (const id of [...slots.keys()]) dropConnection(id);
}

// ------------------------------------------------------------------ Abruf
/** Unterhaltung: erste Nachricht der References-Kette, sonst Betreff ohne Re:/AW:/WG: */
function threadKey(refs: string | string[] | undefined, inReplyTo: string | undefined, messageId: string | undefined, subject: string) {
  const list = Array.isArray(refs) ? refs : refs ? refs.split(/\s+/) : [];
  if (list[0]) return list[0];
  if (inReplyTo) return inReplyTo;
  const s = subject.replace(/^\s*((re|aw|wg|fw|fwd|antw)\s*(\[\d+\])?:\s*)+/gi, '').trim().toLowerCase();
  return s ? `s:${s}` : messageId ?? null;
}

async function syncFolders(ctx: AppContext, a: MailAccount, c: Imap) {
  const list = (await c.list()).filter((f: ListResponse) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent')).slice(0, 60);
  const keep: string[] = [];
  const mapped = new Map(Object.entries(a.folder_map ?? {}).map(([k, path]) => [path, SPECIAL_KEYS[k]]));
  const taken = new Set(list.map((f) => f.specialUse).filter(Boolean));
  for (const f of list) {
    let special = mapped.get(f.path) ?? f.specialUse ?? (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null);
    if (!special) { const g = guessSpecial(f.path, f.delimiter ?? '/'); if (g && !taken.has(g)) { special = g; taken.add(g); } }
    const name = special ? SPECIAL_NAME[special] ?? f.name : f.name;
    keep.push(f.path);
    await ctx.sql`insert into mail_folders (account_id, path, name, special_use, delimiter, sort) values (${a.id}, ${f.path}, ${name}, ${special}, ${f.delimiter ?? '/'}, ${special ? SPECIAL_SORT[special] ?? 50 : 100})
      on conflict (account_id, path) do update set name = excluded.name, special_use = excluded.special_use, sort = excluded.sort`;
  }
  await ctx.sql`delete from mail_folders where account_id = ${a.id} and not (path = any(${keep}))`;
}

/** Neue Nachrichten eines Ordners holen, Markierungen abgleichen, gelöschte entfernen */
async function syncFolder(ctx: AppContext, a: MailAccount, c: Imap, f: Folder, initial = 200) {
  const lock = await c.getMailboxLock(f.path);
  let fetched = 0;
  try {
    const mb = c.mailbox;
    if (!mb || typeof mb === 'boolean') return 0;
    const validity = String(mb.uidValidity);
    let lastUid = Number(f.last_uid);
    if (f.uidvalidity && f.uidvalidity !== validity) {
      await ctx.sql`delete from mail_messages where folder_id = ${f.id}`;
      lastUid = 0;
    }
    if (mb.exists > 0) {
      const range = lastUid ? `${lastUid + 1}:*` : `${Math.max(1, mb.exists - initial + 1)}:*`;
      for await (const msg of c.fetch(range, { uid: true, flags: true, source: true }, lastUid ? { uid: true } : {})) {
        if (!msg.source || msg.uid <= lastUid) continue;
        const p = await simpleParser(msg.source);
        const [row] = await ctx.sql<{ id: string }[]>`insert into mail_messages (account_id, folder_id, message_id, mailbox, uid, direction, from_addr, to_addrs, cc_addrs,
            subject, date, text_body, html_body, seen, flagged, answered, thread_key, in_reply_to)
          values (${a.id}, ${f.id}, ${p.messageId ?? null}, ${f.path}, ${msg.uid}, ${f.special_use === '\\Sent' ? 'out' : 'in'}, ${addr(p.from)}, ${addr(p.to)}, ${addr(p.cc)},
            ${p.subject ?? ''}, ${p.date ?? new Date()}, ${p.text ?? ''}, ${typeof p.html === 'string' ? p.html : null},
            ${msg.flags?.has('\\Seen') ?? false}, ${msg.flags?.has('\\Flagged') ?? false}, ${msg.flags?.has('\\Answered') ?? false},
            ${threadKey(p.references, p.inReplyTo, p.messageId, p.subject ?? '')}, ${p.inReplyTo ?? null})
          on conflict (folder_id, uid) where folder_id is not null do nothing returning id`;
        if (row && p.attachments.length) {
          const atts = [];
          for (const att of p.attachments) {
            if (att.contentDisposition === 'inline' && att.cid && !att.filename) {
              // eingebettete Bilder (z. B. Logo in der Signatur) für die Anzeige behalten
              const name = safeName(`inline-${att.cid.replace(/[^\w.-]/g, '')}.${(att.contentType.split('/')[1] ?? 'bin').replace(/[^\w]/g, '')}`);
              const path = `.aperio/mail/${a.id}/${row.id}/${name}`;
              await ctx.storage.write(path, Readable.from([att.content]));
              atts.push({ name, path, size: att.size, mime: att.contentType, cid: att.cid });
              continue;
            }
            const name = safeName(att.filename ?? 'anhang.bin');
            const path = `.aperio/mail/${a.id}/${row.id}/${name}`;
            await ctx.storage.write(path, Readable.from([att.content]));
            atts.push({ name, path, size: att.size, mime: att.contentType, cid: att.cid ?? null });
          }
          await ctx.sql`update mail_messages set attachments = ${ctx.sql.json(atts)} where id = ${row.id}`;
        }
        lastUid = Math.max(lastUid, msg.uid);
        fetched++;
      }
      // Markierungen und Löschungen der zwischengespeicherten Nachrichten abgleichen
      const local = await ctx.sql<{ uid: string }[]>`select uid from mail_messages where folder_id = ${f.id} order by uid desc limit 500`;
      if (local.length) {
        const min = Number(local[local.length - 1]!.uid);
        const seen = new Map<number, Set<string>>();
        for await (const msg of c.fetch(`${min}:*`, { uid: true, flags: true }, { uid: true })) seen.set(msg.uid, msg.flags ?? new Set());
        for (const l of local) {
          const uid = Number(l.uid);
          const flags = seen.get(uid);
          if (!flags) await ctx.sql`delete from mail_messages where folder_id = ${f.id} and uid = ${uid}`;
          else await ctx.sql`update mail_messages set seen = ${flags.has('\\Seen')}, flagged = ${flags.has('\\Flagged')}, answered = ${flags.has('\\Answered')}
            where folder_id = ${f.id} and uid = ${uid} and (seen, flagged, answered) is distinct from (${flags.has('\\Seen')}, ${flags.has('\\Flagged')}, ${flags.has('\\Answered')})`;
        }
      }
    } else await ctx.sql`delete from mail_messages where folder_id = ${f.id}`;
    const st = await c.status(f.path, { messages: true, unseen: true }).catch(() => null);
    const counts = st ? { total: st.messages ?? 0, unseen: st.unseen ?? 0 } : { total: 0, unseen: 0 };
    await ctx.sql`update mail_folders set uidvalidity = ${validity}, last_uid = ${lastUid}, total = ${counts.total}, unseen = ${counts.unseen} where id = ${f.id}`;
  } finally {
    lock.release();
  }
  return fetched;
}

const running = new Map<string, Promise<{ fetched: number }>>();

/** Abruf eines Postfachs; läuft schon einer, wird auf diesen gewartet statt einen zweiten zu starten */
export function syncAccount(ctx: AppContext, a: MailAccount, onlyFolder?: string): Promise<{ fetched: number }> {
  const key = onlyFolder ? `${a.id}:${onlyFolder}` : a.id;
  const busy = running.get(a.id) ?? running.get(key);
  if (busy) return busy;
  const p = doSync(ctx, a, onlyFolder).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

async function doSync(ctx: AppContext, a: MailAccount, onlyFolder?: string) {
  let fetched = 0;
  try {
    fetched = await withImap(ctx, a, async (c) => {
      if (!onlyFolder) await syncFolders(ctx, a, c);
      const folders = await ctx.sql<Folder[]>`select id, path, uidvalidity::text, last_uid::text, special_use from mail_folders where account_id = ${a.id}
        ${onlyFolder ? ctx.sql`and path = ${onlyFolder}` : ctx.sql``} order by sort, name`;
      let n = 0;
      for (const [i, f] of folders.entries()) {
        n += await syncFolder(ctx, a, c, f);
        if (!onlyFolder) ctx.hub.toUser(a.owner_id, 'mailbox.progress', { accountId: a.id, done: i + 1, total: folders.length, fetched: n });
      }
      return n;
    });
    const [prev] = await ctx.sql<{ last_error: string | null }[]>`select last_error from mail_accounts where id = ${a.id}`;
    await ctx.sql`update mail_accounts set last_sync_at = now(), last_error = null where id = ${a.id}`;
    if (prev?.last_error) await logEvent(ctx, a.id, 'info', 'Abruf klappt wieder.');
    if (fetched) await logEvent(ctx, a.id, 'info', fetched === 1 ? '1 neue E-Mail abgerufen' : `${fetched} neue E-Mails abgerufen`);
  } catch (e) {
    const x = explainMailError(e, 'imap', a);
    const [prev] = await ctx.sql<{ last_error: string | null }[]>`select last_error from mail_accounts where id = ${a.id}`;
    await ctx.sql`update mail_accounts set last_sync_at = now(), last_error = ${x.text} where id = ${a.id}`;
    if (prev?.last_error !== x.text) await logEvent(ctx, a.id, x.transient ? 'warn' : 'error', `Abruf fehlgeschlagen: ${x.text} ${x.tip}`);
    throw Object.assign(new Error(x.text), { problem: x });
  }
  if (fetched) ctx.hub.toUser(a.owner_id, 'mailbox.changed', { accountId: a.id, fetched });
  return { fetched };
}

export async function syncAllMailboxes(ctx: AppContext) {
  const accounts = await ctx.sql<MailAccount[]>`select * from mail_accounts where owner_id is not null`;
  for (const a of accounts) {
    if (running.has(a.id)) continue;
    try { await syncAccount(ctx, a); } catch { /* Fehler steht am Konto */ }
  }
}

/** Markierungen am Server setzen */
export async function setFlags(ctx: AppContext, a: MailAccount, folderPath: string, uids: number[], flags: { seen?: boolean; flagged?: boolean; answered?: boolean }) {
  if (!uids.length) return;
  await withImap(ctx, a, async (c) => {
    const lock = await c.getMailboxLock(folderPath);
    try {
      const set = uids.join(',');
      if (flags.seen !== undefined) await (flags.seen ? c.messageFlagsAdd(set, ['\\Seen'], { uid: true }) : c.messageFlagsRemove(set, ['\\Seen'], { uid: true }));
      if (flags.flagged !== undefined) await (flags.flagged ? c.messageFlagsAdd(set, ['\\Flagged'], { uid: true }) : c.messageFlagsRemove(set, ['\\Flagged'], { uid: true }));
      if (flags.answered) await c.messageFlagsAdd(set, ['\\Answered'], { uid: true });
    } finally { lock.release(); }
  });
}

/** Verschieben (auch in den Papierkorb); im Papierkorb wird endgültig gelöscht */
export async function moveMessages(ctx: AppContext, a: MailAccount, folderPath: string, uids: number[], target: string | null) {
  if (!uids.length) return;
  await withImap(ctx, a, async (c) => {
    const lock = await c.getMailboxLock(folderPath);
    try {
      if (target) await c.messageMove(uids.join(','), target, { uid: true });
      else await c.messageDelete(uids.join(','), { uid: true });
    } finally { lock.release(); }
  });
}

// ------------------------------------------------------------------ Senden
export interface OutgoingMail {
  to: string; cc?: string; bcc?: string; subject: string; html: string; text?: string; inReplyTo?: string | null; references?: string | null;
  attachments: { filename: string; path?: string; content?: Buffer; contentType?: string }[];
  messageId?: string;
}

export const fromHeader = (a: Pick<MailAccount, 'display_name' | 'email'>) => (a.display_name ? `"${a.display_name.replace(/["\\]/g, '')}" <${a.email}>` : a.email);

/** Adresslisten wie in Outlook auch mit Semikolon getrennt */
export const normalizeAddresses = (s: string | undefined) => (s ?? '').split(/[;,\n]/).map((x) => x.trim()).filter(Boolean).join(', ');

function buildMail(a: MailAccount, m: OutgoingMail) {
  return {
    from: fromHeader(a), to: normalizeAddresses(m.to), cc: normalizeAddresses(m.cc) || undefined, bcc: normalizeAddresses(m.bcc) || undefined,
    subject: m.subject, html: m.html, text: m.text, inReplyTo: m.inReplyTo ?? undefined, references: m.references ?? undefined,
    attachments: m.attachments, messageId: m.messageId, attachDataUrls: true,
  };
}

/**
 * Per SMTP verschicken. Bei kurzen Störungen (überlastet, zu viele Verbindungen, Zeitüberschreitung)
 * bis zu dreimal mit Pause. Wirft einen HttpError mit verständlicher Meldung und .problem.
 */
export async function smtpSend(ctx: AppContext, a: MailAccount, m: OutgoingMail, attempts = 3) {
  const mail = buildMail(a, m);
  let last: MailProblem | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const info = await (await smtpFor(ctx, a)).sendMail(mail as never);
      return { messageId: (info as { messageId: string }).messageId, mail };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      last = explainMailError(e, 'smtp', a);
      if (!last.transient || i === attempts) break;
      await logEvent(ctx, a.id, 'warn', `Senden: ${last.text} Neuer Versuch …`);
      await sleep(i === 1 ? 2000 : 5000);
    }
  }
  throw Object.assign(new HttpError(502, `Senden fehlgeschlagen: ${last!.text} ${last!.tip}`), { problem: last });
}

/** Kopie in „Gesendet“ ablegen (viele Server machen das nicht selbst) – im Hintergrund */
export async function fileSentCopy(ctx: AppContext, a: MailAccount, mail: Record<string, unknown>, messageId: string) {
  const [sent] = await ctx.sql<{ path: string }[]>`select path from mail_folders where account_id = ${a.id} and special_use = '\\Sent' limit 1`;
  if (!sent) { await logEvent(ctx, a.id, 'warn', 'Keine Kopie abgelegt: Der Ordner „Gesendet“ ist nicht bekannt. Bitte unter Konto → Ordner zuordnen.'); return; }
  // Google und Microsoft legen die Kopie selbst ab
  if (a.auth_kind !== 'password' || /(^|\.)gmail\.com$|office365\.com$|outlook\.com$/i.test(a.smtp_host)) { void syncAccount(ctx, a, sent.path).catch(() => {}); return; }
  try {
    const raw = await new MailComposer({ ...mail, messageId } as never).compile().build();
    await withImap(ctx, a, (c) => c.append(sent.path, raw, ['\\Seen']));
    void syncAccount(ctx, a, sent.path).catch(() => {});
  } catch (e) {
    await logEvent(ctx, a.id, 'warn', `Die E-Mail wurde verschickt, aber die Kopie in „Gesendet“ klappte nicht: ${explainMailError(e, 'imap', a).text}`);
  }
}

/** Senden und in „Gesendet“ ablegen (für andere Programmteile, wartet nicht auf die Kopie) */
export async function sendFromAccount(ctx: AppContext, a: MailAccount, m: OutgoingMail) {
  const r = await smtpSend(ctx, a, m);
  void fileSentCopy(ctx, a, r.mail as unknown as Record<string, unknown>, r.messageId);
  return { messageId: r.messageId };
}

export const _test = { guessSpecial, normalizeAddresses };
