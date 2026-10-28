/**
 * Integrierte E-Mail-Verwaltung: gemeinsames Projektpostfach per IMAP abrufen, per SMTP senden
 * und Nachrichten Projekten/Aufgaben zuordnen (automatisch, wenn die Projektnummer im Betreff steht).
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import type { MailSettings } from './settings';
import { badRequest, HttpError } from '../lib/errors';
import { safeName } from './files';

const addr = (a: AddressObject | AddressObject[] | undefined) =>
  !a ? '' : (Array.isArray(a) ? a : [a]).flatMap((x) => x.value.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address ?? ''))).join(', ');

const smtpTransport = (s: MailSettings) => nodemailer.createTransport({
  host: s.smtpHost, port: s.smtpPort, secure: s.smtpSecure,
  // Interne Relays (z. B. Exchange) arbeiten oft ohne Anmeldung
  ...(s.user ? { auth: { user: s.user, pass: s.password } } : {}),
});

function imapClient(s: MailSettings) {
  return new ImapFlow({ host: s.imapHost, port: s.imapPort, secure: s.imapSecure, auth: { user: s.user, pass: s.password }, logger: false });
}

export async function testMail(s: MailSettings): Promise<string> {
  const c = imapClient(s);
  await c.connect();
  const st = await c.status('INBOX', { messages: true, unseen: true });
  await c.logout();
  await smtpTransport(s).verify();
  return st ? `IMAP und SMTP erreichbar – ${st.messages} Nachrichten im Posteingang (${st.unseen} ungelesen)` : 'IMAP und SMTP erreichbar';
}

/** Projektnummer im Betreff erkennen: [0100], 0100-A, PRJ-2026-0042 */
async function autoAssign(ctx: AppContext, subject: string): Promise<string | null> {
  const candidates = [...subject.matchAll(/\b([A-Z]{2,5}-\d{4}-\d{3,6}|\d{4}(?:-[A-Z])?)\b/g)].map((m) => m[1]!);
  for (const c of candidates) {
    const [p] = await ctx.sql<{ id: string }[]>`select id from projects where number = ${c}`;
    if (p) return p.id;
  }
  return null;
}

export async function syncMail(ctx: AppContext, limit = 200): Promise<{ fetched: number }> {
  const s = await ctx.settings.get('mail');
  if (!s.enabled || !s.imapHost) return { fetched: 0 };
  const client = imapClient(s);
  await client.connect();
  let fetched = 0;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const [last] = await ctx.sql<{ uid: number }[]>`select max(uid)::int as uid from mail_messages where mailbox = 'INBOX' and direction = 'in' and account_id is null`;
      const status = await client.status('INBOX', { messages: true, uidNext: true });
      const from = last?.uid ? last.uid + 1 : Math.max(1, Number((status && status.uidNext) || 1) - limit);
      for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true, flags: true }, { uid: true })) {
        if (!msg.source || (last?.uid && msg.uid <= last.uid)) continue;
        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId ?? `uid-${msg.uid}@${s.imapHost}`;
        const [exists] = await ctx.sql`select 1 from mail_messages where message_id = ${messageId} and account_id is null`;
        if (exists) continue;
        const projectId = await autoAssign(ctx, parsed.subject ?? '');
        const [row] = await ctx.sql<{ id: string }[]>`insert into mail_messages (message_id, mailbox, uid, direction, from_addr, to_addrs, cc_addrs, subject, date,
            text_body, html_body, project_id, seen)
          values (${messageId}, 'INBOX', ${msg.uid}, 'in', ${addr(parsed.from)}, ${addr(parsed.to)}, ${addr(parsed.cc)}, ${parsed.subject ?? ''},
            ${parsed.date ?? new Date()}, ${parsed.text ?? ''}, ${typeof parsed.html === 'string' ? parsed.html : null}, ${projectId},
            ${msg.flags?.has('\\Seen') ?? false})
          returning id`;
        const atts = [];
        for (const a of parsed.attachments) {
          const name = safeName(a.filename ?? 'anhang.bin');
          const path = `Mail/${row!.id}/${name}`;
          await ctx.storage.write(path, Readable.from([a.content]));
          atts.push({ name, path, size: a.size, mime: a.contentType });
        }
        if (atts.length) await ctx.sql`update mail_messages set attachments = ${ctx.sql.json(atts)} where id = ${row!.id}`;
        fetched++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  if (fetched) ctx.hub.publish('global', 'mail.new', { count: fetched });
  return { fetched };
}

/** Für Tests: E-Mails nur sammeln statt senden */
export const testOutbox: { enabled: boolean; messages: { to: string; cc?: string; subject: string; text: string; attachments: string[] }[] } = { enabled: false, messages: [] };

export async function sendMail(ctx: AppContext, opts: { to: string; cc?: string; subject: string; text: string; inReplyTo?: string; attachments?: { path: string; name: string }[] }) {
  if (testOutbox.enabled) {
    testOutbox.messages.push({ to: opts.to, cc: opts.cc, subject: opts.subject, text: opts.text, attachments: (opts.attachments ?? []).map((a) => a.name) });
    return { messageId: `test-${testOutbox.messages.length}`, from: 'test@aperio' };
  }
  const s = await ctx.settings.get('mail');
  if (!s.enabled || !s.smtpHost) throw badRequest('Kein E-Mail-Konto eingerichtet');
  const info = await smtpTransport(s).sendMail({
    from: s.from || s.user, to: opts.to, cc: opts.cc, subject: opts.subject, text: opts.text,
    inReplyTo: opts.inReplyTo, references: opts.inReplyTo,
    attachments: opts.attachments?.map((a) => ({ filename: a.name, path: ctx.storage.abs(a.path) })),
  }).catch((e: Error) => { throw new HttpError(502, `E-Mail-Versand fehlgeschlagen: ${e.message}`); });
  return { messageId: info.messageId, from: s.from || s.user };
}
