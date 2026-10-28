/**
 * Persönliches Firmen-Postfach – Aufbau wie Outlook: Ordner, Nachrichtenliste, Lesebereich, Verfassen.
 * Zusätzlich: E-Mail einem Projekt oder Kunden zuordnen, Anhänge im Projektordner ablegen, Aufgabe aus E-Mail.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { sealSecret } from '../services/secrets';
import { safeName, storeFile } from '../services/files';
import { moveMessages, sendFromAccount, setFlags, syncAccount, testAccount, type MailAccount } from '../services/mailbox';
import { sendStoredFile } from './files';

const accountBody = z.object({
  email: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben'),
  displayName: z.string().max(120).default(''),
  imapHost: z.string().trim().min(1), imapPort: z.number().int().default(993), imapSecure: z.boolean().default(true),
  smtpHost: z.string().trim().min(1), smtpPort: z.number().int().default(587), smtpSecure: z.boolean().default(false),
  username: z.string().trim().min(1), password: z.string().optional(), signatureHtml: z.string().max(20000).default(''),
});

/** Bekannte Anbieter: Server werden aus der E-Mail-Adresse vorgeschlagen */
const PRESETS: Record<string, Partial<z.infer<typeof accountBody>>> = {
  'gmail.com': { imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  'googlemail.com': { imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  'outlook.com': { imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'hotmail.com': { imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'gmx.de': { imapHost: 'imap.gmx.net', smtpHost: 'mail.gmx.net', smtpPort: 587 },
  'gmx.net': { imapHost: 'imap.gmx.net', smtpHost: 'mail.gmx.net', smtpPort: 587 },
  'web.de': { imapHost: 'imap.web.de', smtpHost: 'smtp.web.de', smtpPort: 587 },
  't-online.de': { imapHost: 'secureimap.t-online.de', smtpHost: 'securesmtp.t-online.de', smtpPort: 465, smtpSecure: true },
  'mailbox.org': { imapHost: 'imap.mailbox.org', smtpHost: 'smtp.mailbox.org', smtpPort: 465, smtpSecure: true },
  'ionos.de': { imapHost: 'imap.ionos.de', smtpHost: 'smtp.ionos.de', smtpPort: 465, smtpSecure: true },
  'strato.de': { imapHost: 'imap.strato.de', smtpHost: 'smtp.strato.de', smtpPort: 465, smtpSecure: true },
};

export default async function mailboxRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  async function account(u: AuthUser): Promise<MailAccount> {
    const [a] = await sql<MailAccount[]>`select * from mail_accounts where user_id = ${u.id}`;
    if (!a) throw badRequest('Noch kein E-Mail-Konto eingerichtet');
    return a;
  }
  async function message(u: AuthUser, id: string) {
    const a = await account(u);
    const [m] = await sql<{ id: string; uid: string; folder_id: string; path: string; seen: boolean; flagged: boolean; subject: string; message_id: string | null; text_body: string;
      html_body: string | null; from_addr: string; to_addrs: string; cc_addrs: string; date: Date; attachments: { name: string; path: string; size: number; mime: string; cid: string | null }[];
      thread_key: string | null; project_id: string | null }[]>`
      select m.*, f.path from mail_messages m join mail_folders f on f.id = m.folder_id where m.id = ${id} and m.account_id = ${a.id}`;
    if (!m) throw notFound('Nachricht nicht gefunden');
    return { a, m };
  }

  // ------------------------------------------------ Konto
  app.get('/mailbox/account', async (req) => {
    const u = requireUser(req);
    const [a] = await sql`select id, email, display_name as "displayName", imap_host as "imapHost", imap_port as "imapPort", imap_secure as "imapSecure",
      smtp_host as "smtpHost", smtp_port as "smtpPort", smtp_secure as "smtpSecure", username, signature_html as "signatureHtml",
      last_sync_at as "lastSyncAt", last_error as "lastError" from mail_accounts where user_id = ${u.id}`;
    return a ?? null;
  });

  app.get('/mailbox/preset', async (req) => {
    requireUser(req);
    const { email } = parse(z.object({ email: z.string() }), req.query);
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    return PRESETS[domain] ?? { imapHost: `imap.${domain}`, smtpHost: `smtp.${domain}`, imapPort: 993, imapSecure: true, smtpPort: 587, smtpSecure: false };
  });

  app.put('/mailbox/account', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(accountBody, req.body);
    const [cur] = await sql<MailAccount[]>`select * from mail_accounts where user_id = ${u.id}`;
    if (!cur && !b.password) throw badRequest('Bitte das Passwort angeben');
    const sealed = b.password ? await sealSecret(ctx, b.password) : cur!.password_sealed;
    const draft = { id: cur?.id ?? 'neu', user_id: u.id, email: b.email, display_name: b.displayName || u.displayName, imap_host: b.imapHost, imap_port: b.imapPort, imap_secure: b.imapSecure,
      smtp_host: b.smtpHost, smtp_port: b.smtpPort, smtp_secure: b.smtpSecure, username: b.username, password_sealed: sealed, signature_html: b.signatureHtml } as MailAccount;
    const changedServer = !cur || b.password || cur.imap_host !== b.imapHost || cur.smtp_host !== b.smtpHost || cur.username !== b.username;
    const message = changedServer ? await testAccount(ctx, draft) : 'Gespeichert';
    if (cur && cur.imap_host !== b.imapHost) await sql`delete from mail_folders where account_id = ${cur.id}`;
    const [row] = await sql<MailAccount[]>`insert into mail_accounts (user_id, email, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_sealed, signature_html)
      values (${u.id}, ${draft.email}, ${draft.display_name}, ${draft.imap_host}, ${draft.imap_port}, ${draft.imap_secure}, ${draft.smtp_host}, ${draft.smtp_port}, ${draft.smtp_secure},
        ${draft.username}, ${sealed}, ${draft.signature_html})
      on conflict (user_id) do update set email = excluded.email, display_name = excluded.display_name, imap_host = excluded.imap_host, imap_port = excluded.imap_port,
        imap_secure = excluded.imap_secure, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_secure = excluded.smtp_secure, username = excluded.username,
        password_sealed = excluded.password_sealed, signature_html = excluded.signature_html returning *`;
    void syncAccount(ctx, row!).catch(() => {});
    return { ok: true, message };
  });

  app.delete('/mailbox/account', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    await sql`update mail_messages set account_id = null, folder_id = null where account_id = ${a.id} and project_id is not null`;
    await sql`delete from mail_accounts where id = ${a.id}`;
    await storage.remove(`.aperio/mail/${a.id}`);
    return { ok: true };
  });

  app.post('/mailbox/sync', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ folder: z.string().optional() }), req.body ?? {});
    try { return await syncAccount(ctx, await account(u), b.folder); } catch (e) { throw badRequest(`Abruf fehlgeschlagen: ${(e as Error).message}`); }
  });

  // ------------------------------------------------ Ordner und Nachrichten
  app.get('/mailbox/folders', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    return sql`select id, path, name, special_use as "specialUse", delimiter, total, unseen,
      (select count(*)::int from mail_messages m where m.folder_id = f.id and not m.seen) as "localUnseen" from mail_folders f where account_id = ${a.id} order by sort, path`;
  });

  app.get('/mailbox/messages', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    const q = parse(z.object({ folderId: z.string().uuid().optional(), q: z.string().optional(), unread: z.coerce.boolean().optional(), flagged: z.coerce.boolean().optional(),
      before: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(150) }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select m.id, m.folder_id as "folderId", m.from_addr as "from", m.to_addrs as "to", m.subject, m.date, m.seen, m.flagged, m.answered, m.thread_key as "threadKey",
        jsonb_array_length(m.attachments) as "attachmentCount", left(regexp_replace(m.text_body, '\\s+', ' ', 'g'), 180) as preview,
        m.project_id as "projectId", p.number as "projectNumber", m.crm_account_id as "crmAccountId", c.name as "crmAccountName", m.direction
      from mail_messages m left join projects p on p.id = m.project_id left join crm_accounts c on c.id = m.crm_account_id
      where m.account_id = ${a.id} ${q.folderId && !like ? sql`and m.folder_id = ${q.folderId}` : sql``}
      ${q.unread ? sql`and not m.seen` : sql``} ${q.flagged ? sql`and m.flagged` : sql``}
      ${like ? sql`and (m.subject ilike ${like} or m.from_addr ilike ${like} or m.to_addrs ilike ${like} or m.text_body ilike ${like})` : sql``}
      ${q.before ? sql`and m.date < ${q.before}` : sql``}
      order by m.date desc nulls last limit ${q.limit}`;
  });

  app.get('/mailbox/messages/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { a, m } = await message(u, id);
    if (!m.seen) {
      await sql`update mail_messages set seen = true where id = ${id}`;
      void setFlags(ctx, a, m.path, [Number(m.uid)], { seen: true }).catch(() => {});
    }
    const thread = m.thread_key ? await sql`select m.id, m.from_addr as "from", m.date, m.subject, m.seen, f.name as "folder" from mail_messages m join mail_folders f on f.id = m.folder_id
      where m.account_id = ${a.id} and m.thread_key = ${m.thread_key} order by m.date` : [];
    const [p] = m.project_id ? await sql`select number, name from projects where id = ${m.project_id}` : [];
    return {
      id: m.id, folderId: m.folder_id, messageId: m.message_id, from: m.from_addr, to: m.to_addrs, cc: m.cc_addrs, subject: m.subject, date: m.date, flagged: m.flagged,
      text: m.text_body, html: m.html_body, attachments: m.attachments.map((x, i) => ({ index: i, name: x.name, size: x.size, mime: x.mime, cid: x.cid })),
      thread, projectId: m.project_id, projectNumber: p?.number ?? null, projectName: p?.name ?? null,
    };
  });

  app.get('/mailbox/messages/:id/attachments/:index', async (req, reply) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0) }), req.params);
    const q = parse(z.object({ inline: z.coerce.boolean().default(false) }), req.query);
    const { m } = await message(u, p.id);
    const att = m.attachments[p.index];
    if (!att) throw notFound();
    return sendStoredFile(ctx, reply, att.path, att.name, q.inline);
  });

  /** gelesen/ungelesen, markieren, verschieben, löschen – für eine oder mehrere Nachrichten */
  app.post('/mailbox/messages/bulk', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['seen', 'unseen', 'flag', 'unflag', 'move', 'delete']), folderId: z.string().uuid().optional() }), req.body);
    const rows = await sql<{ id: string; uid: string; folder_id: string; path: string; special_use: string | null }[]>`select m.id, m.uid, m.folder_id, f.path, f.special_use
      from mail_messages m join mail_folders f on f.id = m.folder_id where m.account_id = ${a.id} and m.id = any(${b.ids})`;
    const byFolder = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) byFolder.set(r.path, [...(byFolder.get(r.path) ?? []), r]);
    let target: { id: string; path: string } | undefined;
    if (b.action === 'move') {
      [target] = await sql<{ id: string; path: string }[]>`select id, path from mail_folders where id = ${b.folderId ?? null} and account_id = ${a.id}`;
      if (!target) throw badRequest('Zielordner fehlt');
    }
    const [trash] = await sql<{ id: string; path: string }[]>`select id, path from mail_folders where account_id = ${a.id} and special_use = '\\Trash' limit 1`;
    for (const [path, list] of byFolder) {
      const uids = list.map((r) => Number(r.uid));
      const ids = list.map((r) => r.id);
      if (b.action === 'seen' || b.action === 'unseen') {
        await setFlags(ctx, a, path, uids, { seen: b.action === 'seen' });
        await sql`update mail_messages set seen = ${b.action === 'seen'} where id = any(${ids})`;
      } else if (b.action === 'flag' || b.action === 'unflag') {
        await setFlags(ctx, a, path, uids, { flagged: b.action === 'flag' });
        await sql`update mail_messages set flagged = ${b.action === 'flag'} where id = any(${ids})`;
      } else {
        const inTrash = list[0]!.special_use === '\\Trash';
        const dest = b.action === 'move' ? target!.path : inTrash || !trash ? null : trash.path;
        await moveMessages(ctx, a, path, uids, dest);
        // die verschobenen Nachrichten holt der nächste Abgleich des Zielordners neu (neue UID)
        await sql`delete from mail_messages where id = any(${ids}) and project_id is null and crm_account_id is null`;
        await sql`update mail_messages set account_id = null, folder_id = null where id = any(${ids})`;
      }
    }
    if (b.action === 'move' || b.action === 'delete') void syncAccount(ctx, a, b.action === 'move' ? target!.path : trash?.path).catch(() => {});
    return { ok: true, count: rows.length };
  });

  // ------------------------------------------------ Verfassen, Entwürfe, Senden
  /** Anhang für eine neue Nachricht hochladen (liegt bis zum Senden zwischen) */
  app.post('/mailbox/uploads', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const path = `.aperio/mail/${a.id}/ausgang/${randomUUID()}/${name}`;
      const r = await storage.write(path, part.file);
      out.push({ name, path, size: r.size });
    }
    return out;
  });

  const draftBody = z.object({
    to: z.string().default(''), cc: z.string().default(''), bcc: z.string().default(''), subject: z.string().max(998).default(''), html: z.string().max(2_000_000).default(''),
    replyOf: z.string().uuid().nullable().default(null), forwardOf: z.string().uuid().nullable().default(null),
    attachments: z.array(z.object({ name: z.string(), path: z.string(), size: z.number() })).default([]),
    /** Dateien aus Projekten anhängen */
    fileIds: z.array(z.string().uuid()).default([]),
  });

  app.get('/mailbox/drafts', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    return sql`select id, to_addrs as "to", cc_addrs as cc, bcc_addrs as bcc, subject, html, reply_of as "replyOf", attachments, updated_at as "updatedAt"
      from mail_drafts where account_id = ${a.id} order by updated_at desc`;
  });

  app.put('/mailbox/drafts/:id', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    const { id } = parse(idParam, req.params);
    const b = parse(draftBody, req.body);
    await sql`insert into mail_drafts (id, account_id, to_addrs, cc_addrs, bcc_addrs, subject, html, reply_of, attachments)
      values (${id}, ${a.id}, ${b.to}, ${b.cc}, ${b.bcc}, ${b.subject}, ${b.html}, ${b.replyOf}, ${sql.json(b.attachments)})
      on conflict (id) do update set to_addrs = excluded.to_addrs, cc_addrs = excluded.cc_addrs, bcc_addrs = excluded.bcc_addrs, subject = excluded.subject,
        html = excluded.html, reply_of = excluded.reply_of, attachments = excluded.attachments, updated_at = now() where mail_drafts.account_id = ${a.id}`;
    return { ok: true };
  });

  app.delete('/mailbox/drafts/:id', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    const { id } = parse(idParam, req.params);
    await sql`delete from mail_drafts where id = ${id} and account_id = ${a.id}`;
    return { ok: true };
  });

  app.post('/mailbox/send', async (req) => {
    const u = requireUser(req);
    const a = await account(u);
    const b = parse(draftBody.extend({ draftId: z.string().uuid().optional() }), req.body);
    if (!b.to.trim()) throw badRequest('Bitte einen Empfänger angeben');
    const attachments: { filename: string; path: string }[] = [];
    for (const x of b.attachments) {
      if (!x.path.startsWith(`.aperio/mail/${a.id}/`)) throw forbidden();
      attachments.push({ filename: x.name, path: storage.abs(x.path) });
    }
    for (const fid of b.fileIds) {
      const [f] = await sql<{ path: string; name: string; project_id: string | null }[]>`select path, name, project_id from files where id = ${fid}`;
      if (!f) continue;
      if (f.project_id) await projectAccess(sql, u, f.project_id); else if (u.role !== 'admin') continue;
      attachments.push({ filename: f.name, path: storage.abs(f.path) });
    }
    let inReplyTo: string | null = null, references: string | null = null;
    if (b.replyOf || b.forwardOf) {
      const { m } = await message(u, (b.replyOf ?? b.forwardOf)!);
      if (b.replyOf) { inReplyTo = m.message_id; references = [m.thread_key?.startsWith('s:') ? null : m.thread_key, m.message_id].filter(Boolean).join(' ') || null; }
      if (b.forwardOf) for (const x of m.attachments) attachments.push({ filename: x.name, path: storage.abs(x.path) });
    }
    const text = b.html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const r = await sendFromAccount(ctx, a, { to: b.to, cc: b.cc, bcc: b.bcc, subject: b.subject, html: b.html, text, inReplyTo, references, attachments });
    if (b.replyOf) {
      const { m } = await message(u, b.replyOf);
      await sql`update mail_messages set answered = true where id = ${m.id}`;
      void setFlags(ctx, a, m.path, [Number(m.uid)], {}).catch(() => {});
    }
    if (b.draftId) await sql`delete from mail_drafts where id = ${b.draftId} and account_id = ${a.id}`;
    await storage.remove(`.aperio/mail/${a.id}/ausgang`).catch(() => {});
    return { ok: true, messageId: r.messageId };
  });

  // ------------------------------------------------ Was Outlook nicht kann
  /** Einem Projekt und/oder Kunden zuordnen; Anhänge wahlweise im Projektordner ablegen */
  app.post('/mailbox/messages/:id/assign', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { m } = await message(u, id);
    const b = parse(z.object({ projectId: z.string().uuid().nullable().optional(), crmAccountId: z.string().uuid().nullable().optional(),
      saveAttachments: z.array(z.number().int().min(0)).default([]), folder: z.string().max(300).default('03_Doku/Mail') }), req.body);
    let saved = 0;
    if (b.projectId) {
      const p = await projectAccess(sql, u, b.projectId, 'edit');
      if (b.saveAttachments.length && p.folder_path) {
        for (const i of b.saveAttachments) {
          const att = m.attachments[i];
          if (!att) continue;
          const target = posix.join(p.folder_path, b.folder.replace(/\.\./g, ''), att.name);
          await storeFile(ctx, { projectId: b.projectId, path: target, stream: storage.read(att.path), userId: u.id, via: `E-Mail: ${m.subject}`.slice(0, 120) });
          saved++;
        }
        if (saved) ctx.hub.publish(`project:${b.projectId}`, 'files.changed', {});
      }
    }
    await sql`update mail_messages set project_id = ${b.projectId === undefined ? sql`project_id` : b.projectId},
      crm_account_id = ${b.crmAccountId === undefined ? sql`crm_account_id` : b.crmAccountId}, assigned_by = ${u.id}, updated_at = now() where id = ${id}`;
    if (b.crmAccountId) await sql`update crm_accounts set last_contact_at = greatest(coalesce(last_contact_at, ${m.date}), ${m.date}) where id = ${b.crmAccountId}`;
    if (b.projectId) await audit(sql, u, { action: 'mail.assign', entityType: 'mail', entityId: id, projectId: b.projectId, summary: `E-Mail „${m.subject}“ zugeordnet${saved ? `, ${saved} Anhänge abgelegt` : ''}` });
    return { ok: true, saved };
  });

  /** Aufgabe aus einer E-Mail */
  app.post('/mailbox/messages/:id/task', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { m } = await message(u, id);
    const b = parse(z.object({ projectId: z.string().uuid(), title: z.string().trim().min(1).max(500), assigneeId: z.string().uuid().nullable().default(null), dueDate: z.string().date().nullable().default(null) }), req.body);
    await projectAccess(sql, u, b.projectId, 'edit');
    const t = await sql.begin(async (tx) => {
      const [p] = await tx<{ task_seq: number }[]>`update projects set task_seq = task_seq + 1 where id = ${b.projectId} returning task_seq`;
      const desc = `Aus E-Mail von ${m.from_addr} (${m.date.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}):\n\n${m.text_body.slice(0, 4000)}`;
      const [row] = await tx<{ id: string }[]>`insert into tasks (project_id, number, title, description, assignee_id, due_date, created_by) values (${b.projectId}, ${p!.task_seq}, ${b.title}, ${desc}, ${b.assigneeId}, ${b.dueDate}, ${u.id}) returning id`;
      return row!;
    });
    await sql`update mail_messages set project_id = coalesce(project_id, ${b.projectId}), task_id = ${t.id} where id = ${id}`;
    ctx.hub.publish(`project:${b.projectId}`, 'task.created', { id: t.id });
    if (b.assigneeId && b.assigneeId !== u.id) await notify(ctx, [b.assigneeId], { kind: 'task.assigned', title: `Aufgabe zugewiesen: ${b.title}`, link: `/projects/${b.projectId}?task=${t.id}` }, u.id);
    return t;
  });
}
