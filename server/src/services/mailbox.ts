/**
 * Persönliches Firmen-Postfach: IMAP-Ordner werden zwischengespeichert (schnelle Liste, Suche, Unterhaltungen),
 * jede Aktion (gelesen, markieren, verschieben, löschen) geht sofort auch an den Mail-Server.
 * Senden per SMTP, die gesendete Nachricht wird im Ordner „Gesendet“ abgelegt.
 */
import { ImapFlow, type ListResponse } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import { badRequest, HttpError } from '../lib/errors';
import { openSecret } from './secrets';
import { safeName } from './files';

export interface MailAccount {
  id: string; user_id: string; email: string; display_name: string; imap_host: string; imap_port: number; imap_secure: boolean;
  smtp_host: string; smtp_port: number; smtp_secure: boolean; username: string; password_sealed: string; signature_html: string;
}
interface Folder { id: string; path: string; uidvalidity: string | null; last_uid: string; special_use: string | null }

const addr = (a: AddressObject | AddressObject[] | undefined) =>
  !a ? '' : (Array.isArray(a) ? a : [a]).flatMap((x) => x.value.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address ?? ''))).join(', ');

const SPECIAL_SORT: Record<string, number> = { '\\Inbox': 0, '\\Drafts': 2, '\\Sent': 3, '\\Archive': 4, '\\Junk': 5, '\\Trash': 6 };
const SPECIAL_NAME: Record<string, string> = { '\\Inbox': 'Posteingang', '\\Drafts': 'Entwürfe', '\\Sent': 'Gesendet', '\\Archive': 'Archiv', '\\Junk': 'Spam', '\\Trash': 'Papierkorb' };

async function password(ctx: AppContext, a: MailAccount) {
  return (await openSecret(ctx, a.password_sealed)) ?? '';
}

export async function imapFor(ctx: AppContext, a: MailAccount) {
  const c = new ImapFlow({ host: a.imap_host, port: a.imap_port, secure: a.imap_secure, auth: { user: a.username, pass: await password(ctx, a) }, logger: false,
    tls: { rejectUnauthorized: process.env.MAIL_TLS_STRICT !== 'false' } });
  await c.connect();
  return c;
}

export async function smtpFor(ctx: AppContext, a: MailAccount) {
  return nodemailer.createTransport({ host: a.smtp_host, port: a.smtp_port, secure: a.smtp_secure, auth: { user: a.username, pass: await password(ctx, a) } });
}

/** Verbindung prüfen, bevor das Konto gespeichert wird */
export async function testAccount(ctx: AppContext, a: MailAccount) {
  const c = await imapFor(ctx, a).catch((e: Error) => { throw badRequest(`Posteingang (IMAP) nicht erreichbar: ${e.message}`); });
  const st = await c.status('INBOX', { messages: true, unseen: true }).catch(() => null);
  await c.logout().catch(() => {});
  await (await smtpFor(ctx, a)).verify().catch((e: Error) => { throw badRequest(`Postausgang (SMTP) nicht erreichbar: ${e.message}`); });
  return st ? `Verbunden – ${st.messages} Nachrichten im Posteingang, ${st.unseen} ungelesen` : 'Verbunden';
}

/** Unterhaltung: erste Nachricht der References-Kette, sonst Betreff ohne Re:/AW:/WG: */
function threadKey(refs: string | string[] | undefined, inReplyTo: string | undefined, messageId: string | undefined, subject: string) {
  const list = Array.isArray(refs) ? refs : refs ? refs.split(/\s+/) : [];
  if (list[0]) return list[0];
  if (inReplyTo) return inReplyTo;
  const s = subject.replace(/^\s*((re|aw|wg|fw|fwd|antw)\s*(\[\d+\])?:\s*)+/gi, '').trim().toLowerCase();
  return s ? `s:${s}` : messageId ?? null;
}

async function syncFolders(ctx: AppContext, a: MailAccount, c: ImapFlow) {
  const list = (await c.list()).filter((f: ListResponse) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent')).slice(0, 60);
  const keep: string[] = [];
  for (const f of list) {
    const special = f.specialUse ?? (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null);
    const name = special ? SPECIAL_NAME[special] ?? f.name : f.name;
    keep.push(f.path);
    await ctx.sql`insert into mail_folders (account_id, path, name, special_use, delimiter, sort) values (${a.id}, ${f.path}, ${name}, ${special}, ${f.delimiter ?? '/'}, ${special ? SPECIAL_SORT[special] ?? 50 : 100})
      on conflict (account_id, path) do update set name = excluded.name, special_use = excluded.special_use, sort = excluded.sort`;
  }
  await ctx.sql`delete from mail_folders where account_id = ${a.id} and not (path = any(${keep}))`;
}

/** Neue Nachrichten eines Ordners holen, Markierungen abgleichen, gelöschte entfernen */
async function syncFolder(ctx: AppContext, a: MailAccount, c: ImapFlow, f: Folder, initial = 200) {
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
            if (att.contentDisposition === 'inline' && att.cid && !att.filename) continue;
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

export async function syncAccount(ctx: AppContext, a: MailAccount, onlyFolder?: string) {
  let c: ImapFlow | null = null;
  let fetched = 0;
  try {
    c = await imapFor(ctx, a);
    if (!onlyFolder) await syncFolders(ctx, a, c);
    const folders = await ctx.sql<Folder[]>`select id, path, uidvalidity::text, last_uid::text, special_use from mail_folders where account_id = ${a.id}
      ${onlyFolder ? ctx.sql`and path = ${onlyFolder}` : ctx.sql``} order by sort, name`;
    for (const f of folders) fetched += await syncFolder(ctx, a, c, f);
    await ctx.sql`update mail_accounts set last_sync_at = now(), last_error = null where id = ${a.id}`;
  } catch (e) {
    await ctx.sql`update mail_accounts set last_sync_at = now(), last_error = ${(e as Error).message} where id = ${a.id}`;
    throw e;
  } finally {
    await c?.logout().catch(() => {});
  }
  if (fetched) ctx.hub.toUser(a.user_id, 'mailbox.changed', { fetched });
  return { fetched };
}

export async function syncAllMailboxes(ctx: AppContext) {
  const accounts = await ctx.sql<MailAccount[]>`select * from mail_accounts`;
  for (const a of accounts) { try { await syncAccount(ctx, a); } catch { /* Fehler steht am Konto */ } }
}

/** Markierungen am Server setzen */
export async function setFlags(ctx: AppContext, a: MailAccount, folderPath: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) {
  if (!uids.length) return;
  const c = await imapFor(ctx, a);
  try {
    const lock = await c.getMailboxLock(folderPath);
    try {
      const set = uids.join(',');
      if (flags.seen !== undefined) await (flags.seen ? c.messageFlagsAdd(set, ['\\Seen'], { uid: true }) : c.messageFlagsRemove(set, ['\\Seen'], { uid: true }));
      if (flags.flagged !== undefined) await (flags.flagged ? c.messageFlagsAdd(set, ['\\Flagged'], { uid: true }) : c.messageFlagsRemove(set, ['\\Flagged'], { uid: true }));
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
}

/** Verschieben (auch in den Papierkorb); im Papierkorb wird endgültig gelöscht */
export async function moveMessages(ctx: AppContext, a: MailAccount, folderPath: string, uids: number[], target: string | null) {
  if (!uids.length) return;
  const c = await imapFor(ctx, a);
  try {
    const lock = await c.getMailboxLock(folderPath);
    try {
      if (target) await c.messageMove(uids.join(','), target, { uid: true });
      else await c.messageDelete(uids.join(','), { uid: true });
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
}

export interface OutgoingMail {
  to: string; cc?: string; bcc?: string; subject: string; html: string; text?: string; inReplyTo?: string | null; references?: string | null;
  attachments: { filename: string; path?: string; content?: Buffer; contentType?: string }[];
}

/** Senden und in „Gesendet“ ablegen */
export async function sendFromAccount(ctx: AppContext, a: MailAccount, m: OutgoingMail) {
  const from = a.display_name ? `"${a.display_name.replace(/"/g, '')}" <${a.email}>` : a.email;
  const mail = { from, to: m.to, cc: m.cc || undefined, bcc: m.bcc || undefined, subject: m.subject, html: m.html, text: m.text,
    inReplyTo: m.inReplyTo ?? undefined, references: m.references ?? undefined, attachments: m.attachments };
  const info = await (await smtpFor(ctx, a)).sendMail(mail).catch((e: Error) => { throw new HttpError(502, `Senden fehlgeschlagen: ${e.message}`); });
  // Kopie in den Ordner „Gesendet“ (viele Server machen das nicht selbst)
  const [sent] = await ctx.sql<{ path: string }[]>`select path from mail_folders where account_id = ${a.id} and special_use = '\\Sent' limit 1`;
  if (sent) {
    try {
      const raw = await new MailComposer({ ...mail, messageId: info.messageId }).compile().build();
      const c = await imapFor(ctx, a);
      try { await c.append(sent.path, raw, ['\\Seen']); } finally { await c.logout().catch(() => {}); }
      void syncAccount(ctx, a, sent.path).catch(() => {});
    } catch { /* Ablage in „Gesendet“ ist nicht kritisch */ }
  }
  return { messageId: info.messageId };
}
