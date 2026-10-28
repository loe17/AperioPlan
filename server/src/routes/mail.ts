import type { FastifyInstance } from 'fastify';
import { posix } from 'node:path';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { projectAccess, visibleProjects } from '../lib/access';
import { forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { sendMail, syncMail, testMail } from '../services/mail';
import { sendStoredFile } from './files';

export default async function mailRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  const listSelect = sql`m.id, m.direction, m.from_addr as "from", m.to_addrs as "to", m.subject, m.date, m.seen,
    m.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", m.task_id as "taskId",
    jsonb_array_length(m.attachments) as "attachmentCount", left(m.text_body, 160) as preview`;

  app.get('/mail', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const q = parse(z.object({ projectId: z.string().uuid().optional(), filter: z.enum(['all', 'unassigned', 'sent']).default('all'), q: z.string().optional() }), req.query);
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${listSelect} from mail_messages m left join projects p on p.id = m.project_id
      where m.account_id is null and (m.project_id is null or exists (select 1 from projects p where p.id = m.project_id and ${visibleProjects(sql, u)}))
      ${q.projectId ? sql`and m.project_id = ${q.projectId}` : sql``}
      ${q.filter === 'unassigned' ? sql`and m.project_id is null and m.direction = 'in'` : q.filter === 'sent' ? sql`and m.direction = 'out'` : sql``}
      ${like ? sql`and (m.subject ilike ${like} or m.from_addr ilike ${like} or m.text_body ilike ${like})` : sql``}
      order by m.date desc nulls last limit 300`;
  });

  app.get('/mail/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [m] = await sql<any[]>`select m.*, p.number as "projectNumber", p.name as "projectName" from mail_messages m left join projects p on p.id = m.project_id where m.id = ${id}`;
    if (!m) throw notFound();
    if (m.account_id) {
      // persönliches Postfach: nur der Inhaber – oder alle mit Zugriff aufs Projekt, wenn sie einem Projekt zugeordnet wurde
      const [own] = await sql`select 1 from mail_accounts where id = ${m.account_id} and user_id = ${u.id}`;
      if (!own && !m.project_id) throw notFound();
    }
    if (m.project_id) await projectAccess(sql, u, m.project_id);
    else if (u.role === 'guest') throw forbidden();
    if (!m.seen && !m.account_id) await sql`update mail_messages set seen = true where id = ${id}`;
    return {
      id: m.id, messageId: m.message_id, direction: m.direction, from: m.from_addr, to: m.to_addrs, cc: m.cc_addrs, subject: m.subject, date: m.date,
      text: m.text_body, html: m.html_body, attachments: m.attachments.map((a: any, i: number) => ({ index: i, name: a.name, size: a.size, mime: a.mime })),
      projectId: m.project_id, projectNumber: m.projectNumber, projectName: m.projectName, taskId: m.task_id,
    };
  });

  app.get('/mail/:id/attachments/:index', async (req, reply) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0) }), req.params);
    const [m] = await sql<{ attachments: { name: string; path: string }[]; project_id: string | null }[]>`select attachments, project_id from mail_messages where id = ${p.id}`;
    if (!m) throw notFound();
    if (m.project_id) await projectAccess(sql, u, m.project_id);
    const a = m.attachments[p.index];
    if (!a) throw notFound();
    return sendStoredFile(ctx, reply, a.path, a.name);
  });

  /** E-Mail einem Projekt / einer Aufgabe zuordnen; Anhänge werden in den Projektordner übernommen */
  /** E-Mail einem Kunden im CRM zuordnen (erscheint dann im Verlauf des Kunden) */
  app.post('/mail/:id/crm', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ accountId: z.string().uuid().nullable() }), req.body);
    await sql`update mail_messages set crm_account_id = ${b.accountId}, updated_at = now() where id = ${id}`;
    if (b.accountId) await sql`update crm_accounts set last_contact_at = greatest(coalesce(last_contact_at, now()), now()) where id = ${b.accountId}`;
    return { ok: true };
  });

  app.post('/mail/:id/assign', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ projectId: z.string().uuid().nullable(), taskId: z.string().uuid().nullable().default(null), copyAttachments: z.boolean().default(true) }), req.body);
    const [m] = await sql<{ attachments: { name: string; path: string }[]; subject: string }[]>`select attachments, subject from mail_messages where id = ${id}`;
    if (!m) throw notFound();
    let folder: string | null = null;
    if (b.projectId) folder = (await projectAccess(sql, u, b.projectId, 'edit')).folder_path;
    await sql`update mail_messages set project_id = ${b.projectId}, task_id = ${b.taskId}, assigned_by = ${u.id}, updated_at = now() where id = ${id}`;
    if (b.projectId && folder && b.copyAttachments) {
      for (const a of m.attachments) {
        const target = `${folder}/03_Doku/Mail/${posix.basename(a.path)}`;
        if (!(await storage.stat(target))) await storage.copy(a.path, target);
      }
    }
    if (b.projectId) await audit(sql, u, { action: 'mail.assign', entityType: 'mail', entityId: id, projectId: b.projectId, summary: `E-Mail „${m.subject}“ zugeordnet` });
    return { ok: true };
  });

  app.post('/mail/send', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({
      to: z.string().min(3), cc: z.string().optional(), subject: z.string().min(1), text: z.string().default(''),
      projectId: z.string().uuid().nullable().default(null), taskId: z.string().uuid().nullable().default(null), replyTo: z.string().uuid().optional(),
    }), req.body);
    if (b.projectId) await projectAccess(sql, u, b.projectId);
    let inReplyTo: string | undefined;
    if (b.replyTo) inReplyTo = (await sql<{ message_id: string }[]>`select message_id from mail_messages where id = ${b.replyTo}`)[0]?.message_id;
    const signature = `\n\n--\n${u.displayName}`;
    const info = await sendMail(ctx, { to: b.to, cc: b.cc, subject: b.subject, text: b.text + signature, inReplyTo });
    const [row] = await sql`insert into mail_messages (message_id, mailbox, direction, from_addr, to_addrs, cc_addrs, subject, date, text_body, project_id, task_id, sent_by, seen)
      values (${info.messageId}, 'SENT', 'out', ${info.from}, ${b.to}, ${b.cc ?? ''}, ${b.subject}, now(), ${b.text + signature}, ${b.projectId}, ${b.taskId}, ${u.id}, true) returning id`;
    await audit(sql, u, { action: 'mail.send', entityType: 'mail', entityId: row!.id, projectId: b.projectId, summary: `E-Mail an ${b.to}: ${b.subject}` });
    return row;
  });

  app.post('/mail/sync', async (req) => {
    requireUser(req);
    return syncMail(ctx);
  });

  app.post('/settings/mail/test', async (req) => {
    requireRole(req, 'admin');
    const s = await ctx.settings.mergeSecrets('mail', { ...(await ctx.settings.get('mail')), ...(req.body as object) });
    try { return { ok: true, message: await testMail(s) }; } catch (e) { return { ok: false, message: (e as Error).message }; }
  });
}
