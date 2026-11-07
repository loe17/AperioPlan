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
import { safeName, storeFile } from '../services/files';
import { moveMessages, normalizeAddresses, setFlags, syncAccount, type MailAccount } from '../services/mailbox';
import { sendNow, type OutboxPayload } from '../services/mailOutbox';
import { ownAccount } from './mailAccounts';
import { sendStoredFile } from './files';

export default async function mailboxRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const account = (u: AuthUser, accountId?: string | null) => ownAccount(sql, u, accountId);

  async function message(u: AuthUser, id: string) {
    const [m] = await sql<{ id: string; uid: string; folder_id: string; path: string; seen: boolean; flagged: boolean; subject: string; message_id: string | null; text_body: string;
      html_body: string | null; from_addr: string; to_addrs: string; cc_addrs: string; date: Date; attachments: { name: string; path: string; size: number; mime: string; cid: string | null }[];
      thread_key: string | null; project_id: string | null; account_id: string }[]>`
      select m.*, f.path from mail_messages m join mail_folders f on f.id = m.folder_id join mail_accounts a on a.id = m.account_id where m.id = ${id} and a.owner_id = ${u.id}`;
    if (!m) throw notFound('Nachricht nicht gefunden');
    const [a] = await sql<MailAccount[]>`select * from mail_accounts where id = ${m.account_id}`;
    return { a: a!, m };
  }

  app.post('/mailbox/sync', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ folder: z.string().optional(), accountId: z.string().uuid().optional() }), req.body ?? {});
    const list = b.accountId ? [await account(u, b.accountId)] : await sql<MailAccount[]>`select * from mail_accounts where owner_id = ${u.id}`;
    if (!list.length) throw badRequest('Noch kein E-Mail-Konto eingerichtet');
    let fetched = 0;
    const errors: string[] = [];
    for (const a of list) {
      try { fetched += (await syncAccount(ctx, a, b.folder)).fetched; } catch (e) { errors.push(`${a.email}: ${(e as Error).message}`); }
    }
    if (errors.length === list.length) throw badRequest(`Abruf fehlgeschlagen – ${errors.join('; ')}`);
    return { fetched, errors };
  });

  // ------------------------------------------------ Ordner und Nachrichten
  app.get('/mailbox/folders', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ accountId: z.string().uuid().optional() }), req.query);
    const a = await account(u, q.accountId);
    return sql`select id, path, name, special_use as "specialUse", delimiter, total, unseen,
      (select count(*)::int from mail_messages m where m.folder_id = f.id and not m.seen) as "localUnseen" from mail_folders f where account_id = ${a.id} order by sort, path`;
  });

  app.get('/mailbox/messages', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ accountId: z.string().uuid().optional(), folderId: z.string().uuid().optional(), q: z.string().optional(), unread: z.coerce.boolean().optional(), flagged: z.coerce.boolean().optional(),
      before: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(150) }), req.query);
    let accountId = q.accountId ?? null;
    if (!accountId && q.folderId) accountId = (await sql<{ account_id: string }[]>`select account_id from mail_folders where id = ${q.folderId}`)[0]?.account_id ?? null;
    const a = await account(u, accountId);
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
    const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['seen', 'unseen', 'flag', 'unflag', 'move', 'delete']), folderId: z.string().uuid().optional() }), req.body);
    const all = await sql<{ id: string; uid: string; folder_id: string; path: string; special_use: string | null; account_id: string }[]>`select m.id, m.uid, m.folder_id, f.path, f.special_use, m.account_id
      from mail_messages m join mail_folders f on f.id = m.folder_id join mail_accounts ac on ac.id = m.account_id where ac.owner_id = ${u.id} and m.id = any(${b.ids})`;
    if (!all.length) return { ok: true, count: 0 };
    const a = await account(u, all[0]!.account_id);
    const rows = all.filter((r) => r.account_id === a.id);
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
    if (u.role === 'guest') throw forbidden();
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const path = `.aperio/mail/u-${u.id}/ausgang/${randomUUID()}/${name}`;
      const r = await storage.write(path, part.file);
      out.push({ name, path, size: r.size });
    }
    return out;
  });

  const draftBody = z.object({
    accountId: z.string().uuid().optional(),
    to: z.string().default(''), cc: z.string().default(''), bcc: z.string().default(''), subject: z.string().max(998).default(''), html: z.string().max(4_000_000).default(''),
    replyOf: z.string().uuid().nullable().default(null), forwardOf: z.string().uuid().nullable().default(null),
    attachments: z.array(z.object({ name: z.string(), path: z.string(), size: z.number() })).default([]),
    /** Dateien aus Projekten anhängen */
    fileIds: z.array(z.string().uuid()).default([]),
  });

  app.get('/mailbox/drafts', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ accountId: z.string().uuid().optional() }), req.query);
    return sql`select d.id, d.account_id as "accountId", d.to_addrs as "to", d.cc_addrs as cc, d.bcc_addrs as bcc, d.subject, d.html, d.reply_of as "replyOf", d.attachments, d.updated_at as "updatedAt"
      from mail_drafts d join mail_accounts a on a.id = d.account_id where a.owner_id = ${u.id} ${q.accountId ? sql`and d.account_id = ${q.accountId}` : sql``} order by d.updated_at desc`;
  });

  app.put('/mailbox/drafts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(draftBody, req.body);
    const a = await account(u, b.accountId);
    const [other] = await sql`select 1 from mail_drafts d join mail_accounts x on x.id = d.account_id where d.id = ${id} and x.owner_id <> ${u.id}`;
    if (other) throw forbidden();
    await sql`insert into mail_drafts (id, account_id, to_addrs, cc_addrs, bcc_addrs, subject, html, reply_of, attachments)
      values (${id}, ${a.id}, ${b.to}, ${b.cc}, ${b.bcc}, ${b.subject}, ${b.html}, ${b.replyOf}, ${sql.json(b.attachments)})
      on conflict (id) do update set account_id = excluded.account_id, to_addrs = excluded.to_addrs, cc_addrs = excluded.cc_addrs, bcc_addrs = excluded.bcc_addrs, subject = excluded.subject,
        html = excluded.html, reply_of = excluded.reply_of, attachments = excluded.attachments, updated_at = now()`;
    return { ok: true };
  });

  app.delete('/mailbox/drafts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from mail_drafts d using mail_accounts a where d.id = ${id} and a.id = d.account_id and a.owner_id = ${u.id}`;
    return { ok: true };
  });

  /**
   * Senden: Die Kennung (clientKey) kommt aus dem Schreibfenster – doppelt ankommende Klicks verschicken nichts doppelt.
   * Bei einer kurzen Störung landet die E-Mail im Postausgang und wird automatisch nachgeschickt.
   */
  app.post('/mailbox/send', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(draftBody.extend({ draftId: z.string().uuid().optional(), clientKey: z.string().min(8).max(64).optional() }), req.body);
    const a = await account(u, b.accountId);
    if (!normalizeAddresses(b.to)) throw badRequest('Bitte einen Empfänger angeben');
    const attachments: { filename: string; storagePath: string }[] = [];
    const cleanup = new Set<string>();
    for (const x of b.attachments) {
      if (!x.path.startsWith(`.aperio/mail/u-${u.id}/ausgang/`) && !x.path.startsWith(`.aperio/mail/${a.id}/`)) throw forbidden();
      if (x.path.includes('..')) throw forbidden();
      attachments.push({ filename: x.name, storagePath: x.path });
      if (x.path.includes('/ausgang/')) cleanup.add(x.path.split('/').slice(0, -1).join('/'));
    }
    for (const fid of b.fileIds) {
      const [f] = await sql<{ path: string; name: string; project_id: string | null }[]>`select path, name, project_id from files where id = ${fid}`;
      if (!f) continue;
      if (f.project_id) await projectAccess(sql, u, f.project_id); else if (u.role !== 'admin') continue;
      attachments.push({ filename: f.name, storagePath: f.path });
    }
    let inReplyTo: string | null = null, references: string | null = null;
    if (b.replyOf || b.forwardOf) {
      const { m } = await message(u, (b.replyOf ?? b.forwardOf)!);
      if (b.replyOf) { inReplyTo = m.message_id; references = [m.thread_key?.startsWith('s:') ? null : m.thread_key, m.message_id].filter(Boolean).join(' ') || null; }
      if (b.forwardOf) for (const x of m.attachments) if (!x.cid || !b.html.includes(x.cid.replace(/[<>]/g, ''))) attachments.push({ filename: x.name, storagePath: x.path });
    }
    const text = b.html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n');
    const domain = a.email.split('@')[1] ?? 'aperio.local';
    const payload: OutboxPayload = { to: normalizeAddresses(b.to), cc: normalizeAddresses(b.cc), bcc: normalizeAddresses(b.bcc), subject: b.subject, html: b.html, text,
      inReplyTo, references, messageId: `<${randomUUID()}@${domain}>`, attachments, replyOf: b.replyOf, cleanup: [...cleanup] };
    const r = await sendNow(ctx, a, b.clientKey ?? randomUUID(), payload);
    if (b.draftId) await sql`delete from mail_drafts where id = ${b.draftId} and account_id in (select id from mail_accounts where owner_id = ${u.id})`;
    if (r.status === 'queued') return { ok: true, queued: true, message: `${r.problem.text} Die E-Mail liegt im Postausgang und wird automatisch nachgeschickt.` };
    if (r.status === 'pending') return { ok: true, pending: true, message: 'Die E-Mail wird bereits verschickt.' };
    return { ok: true, messageId: r.messageId, duplicate: r.status === 'duplicate' };
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
