/**
 * Kundenanfragen (Helpdesk): Tickets aus Kontaktformular, Telefon oder E-Mail, Antworten per E-Mail,
 * Verlauf für den Kunden über einen persönlichen Link, Reaktionszeiten, interne Notizen und Textbausteine.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { sendMail } from '../services/mail';
import { staffOf, toRow } from '../lib/rows';

type Prio = 'low' | 'normal' | 'high' | 'urgent';
const ticketBody = z.object({
  subject: z.string().trim().min(1).max(300), accountId: z.string().uuid().nullable().default(null), contactName: z.string().max(200).default(''),
  email: z.string().max(200).default(''), phone: z.string().max(60).default(''), status: z.enum(['new', 'open', 'waiting', 'solved', 'closed']).default('open'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), category: z.string().max(100).default(''), assigneeId: z.string().uuid().nullable().default(null),
  channel: z.enum(['web', 'email', 'phone', 'internal']).default('phone'),
});

export default async function helpdeskRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, config } = ctx;
  const changed = () => ctx.hub.publish('global', 'helpdesk.changed', {});
  const installed = async () => (await ctx.settings.get('apps')).installed.includes('helpdesk');
  const portal = (token: string) => `${config.publicUrl}/support/t/${token}`;
  const dueAt = async (prio: Prio) => new Date(Date.now() + (await ctx.settings.get('helpdesk')).sla[prio] * 3600_000);

  async function create(b: z.infer<typeof ticketBody>, message: string, author: { userId?: string; name: string }) {
    const number = await nextNumber(sql, 'ticket', (await ctx.settings.get('numbers')).ticket ?? 'T{JJ}-{NNNNN}', async (n) => (await sql`select 1 from hd_tickets where number = ${n}`).length > 0);
    let accountId = b.accountId;
    if (!accountId && b.email) {
      const [c] = await sql<{ account_id: string }[]>`select account_id from crm_contacts where lower(email) = ${b.email.toLowerCase()} limit 1`;
      accountId = c?.account_id ?? null;
    }
    const token = randomBytes(18).toString('base64url');
    const [t] = await sql<{ id: string }[]>`insert into hd_tickets ${sql({ ...toRow(sql, { ...b, accountId }), number, token, due_at: await dueAt(b.priority) })} returning id`;
    if (message.trim()) await sql`insert into hd_messages (ticket_id, user_id, author_name, body) values (${t!.id}, ${author.userId ?? null}, ${author.name}, ${message})`;
    return { id: t!.id, number, token };
  }
  async function mailCustomer(t: { email: string; number: string; subject: string; token: string; contact_name: string }, text: string) {
    if (!t.email) return false;
    const h = await ctx.settings.get('helpdesk');
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    await sendMail(ctx, { to: t.email, subject: `[${t.number}] ${t.subject}`,
      text: `Guten Tag${t.contact_name ? ` ${t.contact_name}` : ''},\n\n${text}\n\nDen Verlauf Ihrer Anfrage sehen und beantworten Sie hier:\n${portal(t.token)}\n\n${h.signature || `Mit freundlichen Grüßen\n${company}`}` });
    return true;
  }
  const staffRecipients = async (assignee: string | null) => assignee ? [assignee]
    : (await sql<{ id: string }[]>`select id from users where active and role = 'admin'`).map((r) => r.id);

  // ------------------------------------------------ Mitarbeiter
  const cols = sql`t.id, t.number, t.subject, t.account_id as "accountId", a.name as "accountName", t.contact_name as "contactName", t.email, t.phone, t.status, t.priority, t.category,
    t.assignee_id as "assigneeId", u.display_name as "assigneeName", t.channel, t.due_at as "dueAt", t.first_response_at as "firstResponseAt", t.solved_at as "solvedAt", t.rating,
    t.created_at as "createdAt", t.updated_at as "updatedAt", (t.first_response_at is null and t.status in ('new', 'open') and t.due_at < now()) as breached,
    (select count(*)::int from hd_messages m where m.ticket_id = t.id) as messages`;
  const from = sql`hd_tickets t left join crm_accounts a on a.id = t.account_id left join users u on u.id = t.assignee_id`;
  app.get('/helpdesk/overview', async (req) => {
    staffOf(req);
    const [k] = await sql`select count(*) filter (where status = 'new')::int as new, count(*) filter (where status in ('new', 'open'))::int as open,
      count(*) filter (where status = 'waiting')::int as waiting, count(*) filter (where status in ('new', 'open') and assignee_id is null)::int as unassigned,
      count(*) filter (where first_response_at is null and status in ('new', 'open') and due_at < now())::int as breached,
      count(*) filter (where solved_at > now() - interval '30 days')::int as solved30,
      round(avg(extract(epoch from first_response_at - created_at) / 3600) filter (where first_response_at > now() - interval '30 days')::numeric, 1)::float as "avgResponseHours",
      round(avg(rating) filter (where rating is not null)::numeric, 1)::float as rating from hd_tickets`;
    return k;
  });
  app.get('/helpdesk/tickets', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ status: z.string().max(20).optional(), mine: z.coerce.boolean().optional(), unassigned: z.coerce.boolean().optional(), accountId: z.string().uuid().optional(), q: z.string().max(100).optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${cols} from ${from} where true
      ${q.status === 'active' ? sql`and t.status in ('new', 'open', 'waiting')` : q.status ? sql`and t.status = ${q.status}` : sql``}
      ${q.mine ? sql`and t.assignee_id = ${u.id}` : sql``} ${q.unassigned ? sql`and t.assignee_id is null` : sql``} ${q.accountId ? sql`and t.account_id = ${q.accountId}` : sql``}
      ${like ? sql`and (t.number ilike ${like} or t.subject ilike ${like} or t.email ilike ${like} or t.contact_name ilike ${like} or a.name ilike ${like})` : sql``}
      order by (t.status in ('solved', 'closed')), case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.due_at nulls last limit 1000`;
  });
  app.get('/helpdesk/tickets/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [t] = await sql<any[]>`select ${cols}, t.token from ${from} where t.id = ${id}`;
    if (!t) throw notFound('Ticket nicht gefunden');
    const messages = await sql`select m.id, m.user_id as "userId", coalesce(us.display_name, m.author_name) as author, m.body, m.internal, m.created_at as "createdAt"
      from hd_messages m left join users us on us.id = m.user_id where m.ticket_id = ${id} order by m.created_at`;
    const jobs = (await ctx.settings.get('apps')).installed.includes('service') ? await sql`select id, number, status from svc_jobs where ticket_id = ${id}` : [];
    return { ...t, portalUrl: portal(t.token), messages, jobs };
  });
  app.post('/helpdesk/tickets', async (req) => {
    const u = staffOf(req);
    const b = parse(ticketBody.extend({ message: z.string().max(20000).default(''), notifyCustomer: z.boolean().default(false) }), req.body);
    const { message, notifyCustomer, ...rest } = b;
    const t = await create(rest, message, { userId: u.id, name: u.displayName });
    if (notifyCustomer) {
      const h = await ctx.settings.get('helpdesk');
      await mailCustomer({ email: rest.email, number: t.number, subject: rest.subject, token: t.token, contact_name: rest.contactName }, h.autoReply.replace('{nummer}', t.number));
    }
    if (rest.assigneeId && rest.assigneeId !== u.id) await notify(ctx, [rest.assigneeId], { kind: 'helpdesk.assigned', title: `Ticket zugewiesen: ${rest.subject}`, body: t.number, link: `/helpdesk?ticket=${t.id}` }, u.id);
    await audit(sql, u, { action: 'helpdesk.ticket.create', entityType: 'hd_ticket', entityId: t.id, summary: `${t.number} ${rest.subject}` });
    changed();
    return { id: t.id, number: t.number };
  });
  app.patch('/helpdesk/tickets/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(ticketBody), req.body);
    const [cur] = await sql<{ number: string; subject: string; assignee_id: string | null; priority: Prio; status: string }[]>`select number, subject, assignee_id, priority, status from hd_tickets where id = ${id}`;
    if (!cur) throw notFound();
    const row = toRow(sql, b);
    if (b.priority && b.priority !== cur.priority) row.due_at = await dueAt(b.priority);
    if (b.status === 'solved' || b.status === 'closed') row.solved_at = sql`coalesce(solved_at, now())`;
    else if (b.status) row.solved_at = null;
    if (b.status && b.status !== 'new' && cur.status === 'new' && !b.assigneeId && !cur.assignee_id) row.assignee_id = u.id;
    if (Object.keys(row).length) await sql`update hd_tickets set ${sql(row)}, updated_at = now() where id = ${id}`;
    if (b.assigneeId && b.assigneeId !== cur.assignee_id) await notify(ctx, [b.assigneeId], { kind: 'helpdesk.assigned', title: `Ticket zugewiesen: ${cur.subject}`, body: cur.number, link: `/helpdesk?ticket=${id}` }, u.id);
    await audit(sql, u, { action: 'helpdesk.ticket.update', entityType: 'hd_ticket', entityId: id, summary: `${cur.number}: ${Object.keys(b).join(', ')}` });
    changed();
    return { ok: true };
  });
  /** Antworten (per E-Mail an den Kunden) oder interne Notiz */
  app.post('/helpdesk/tickets/:id/messages', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(20000), internal: z.boolean().default(false), status: z.enum(['open', 'waiting', 'solved']).optional() }), req.body);
    const [t] = await sql<{ email: string; number: string; subject: string; token: string; contact_name: string; first_response_at: Date | null; assignee_id: string | null }[]>`
      select email, number, subject, token, contact_name, first_response_at, assignee_id from hd_tickets where id = ${id}`;
    if (!t) throw notFound();
    await sql`insert into hd_messages (ticket_id, user_id, author_name, body, internal) values (${id}, ${u.id}, ${u.displayName}, ${b.body}, ${b.internal})`;
    let mailed = false;
    if (!b.internal) {
      mailed = await mailCustomer(t, b.body);
      const status = b.status ?? 'waiting';
      await sql`update hd_tickets set status = ${status}, first_response_at = coalesce(first_response_at, now()), assignee_id = coalesce(assignee_id, ${u.id}),
        solved_at = ${status === 'solved' ? sql`coalesce(solved_at, now())` : null}, updated_at = now() where id = ${id}`;
    } else {
      await sql`update hd_tickets set updated_at = now() where id = ${id}`;
      if (t.assignee_id && t.assignee_id !== u.id) await notify(ctx, [t.assignee_id], { kind: 'helpdesk.note', title: `Notiz zu ${t.number}`, body: b.body.slice(0, 140), link: `/helpdesk?ticket=${id}` }, u.id);
    }
    changed();
    return { ok: true, mailed };
  });
  app.delete('/helpdesk/tickets/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    if (u.role !== 'admin') throw badRequest('Nur Administratoren löschen Tickets – sonst bitte schließen.');
    await sql`delete from hd_tickets where id = ${id}`;
    changed();
    return { ok: true };
  });
  // Textbausteine
  app.get('/helpdesk/canned', async (req) => { staffOf(req); return sql`select id, title, body from hd_canned order by title`; });
  app.post('/helpdesk/canned', async (req) => {
    staffOf(req);
    const b = parse(z.object({ title: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(10000) }), req.body);
    const [c] = await sql<{ id: string }[]>`insert into hd_canned (title, body) values (${b.title}, ${b.body}) returning id`;
    return { id: c!.id };
  });
  app.delete('/helpdesk/canned/:id', async (req) => { staffOf(req); await sql`delete from hd_canned where id = ${parse(idParam, req.params).id}`; return { ok: true }; });

  // ------------------------------------------------ Öffentlich (ohne Anmeldung)
  app.get('/pub/support', async () => {
    if (!(await installed())) throw notFound();
    const h = await ctx.settings.get('helpdesk');
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    return { enabled: h.publicForm, categories: h.categories, company };
  });
  app.post('/pub/support/tickets', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    if (!(await installed()) || !(await ctx.settings.get('helpdesk')).publicForm) throw notFound();
    const b = parse(z.object({ name: z.string().trim().min(2).max(200), email: z.string().trim().email().max(200), phone: z.string().max(60).default(''), company: z.string().max(200).default(''),
      subject: z.string().trim().min(3).max(300), message: z.string().trim().min(5).max(20000), category: z.string().max(100).default(''), website: z.string().max(0).default('') }), req.body);
    const t = await create({ subject: b.subject, accountId: null, contactName: b.name, email: b.email, phone: b.phone, status: 'new', priority: 'normal', category: b.category, assigneeId: null, channel: 'web' },
      `${b.company ? `Firma: ${b.company}\n\n` : ''}${b.message}`, { name: b.name });
    const h = await ctx.settings.get('helpdesk');
    await mailCustomer({ email: b.email, number: t.number, subject: b.subject, token: t.token, contact_name: b.name }, h.autoReply.replace('{nummer}', t.number)).catch(() => undefined);
    await notify(ctx, await staffRecipients(null), { kind: 'helpdesk.new', title: `Neue Kundenanfrage: ${b.subject}`, body: `${t.number} von ${b.name}`, link: `/helpdesk?ticket=${t.id}` });
    changed();
    return { number: t.number, token: t.token };
  });
  const byToken = async (token: string) => {
    if (!(await installed())) throw notFound();
    const [t] = await sql<{ id: string; number: string; subject: string; status: string; created_at: Date; assignee_id: string | null; rating: number | null; contact_name: string }[]>`
      select id, number, subject, status, created_at, assignee_id, rating, contact_name from hd_tickets where token = ${token}`;
    if (!t) throw notFound('Anfrage nicht gefunden');
    return t;
  };
  app.get('/pub/support/t/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(60) }), req.params);
    const t = await byToken(token);
    const messages = await sql`select coalesce(u.display_name, m.author_name) as author, m.user_id is not null as staff, m.body, m.created_at as "createdAt"
      from hd_messages m left join users u on u.id = m.user_id where m.ticket_id = ${t.id} and not m.internal order by m.created_at`;
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    return { number: t.number, subject: t.subject, status: t.status, createdAt: t.created_at, rating: t.rating, company, messages };
  });
  app.post('/pub/support/t/:token/reply', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(60) }), req.params);
    const b = parse(z.object({ message: z.string().trim().min(1).max(20000) }), req.body);
    const t = await byToken(token);
    if (t.status === 'closed') throw badRequest('Diese Anfrage ist abgeschlossen. Bitte eine neue Anfrage stellen.');
    await sql`insert into hd_messages (ticket_id, author_name, body) values (${t.id}, ${t.contact_name || 'Kunde'}, ${b.message})`;
    await sql`update hd_tickets set status = 'open', solved_at = null, updated_at = now() where id = ${t.id}`;
    await notify(ctx, await staffRecipients(t.assignee_id), { kind: 'helpdesk.reply', title: `Antwort des Kunden: ${t.subject}`, body: t.number, link: `/helpdesk?ticket=${t.id}` });
    changed();
    return { ok: true };
  });
  app.post('/pub/support/t/:token/rate', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(60) }), req.params);
    const b = parse(z.object({ rating: z.number().int().min(1).max(5) }), req.body);
    const t = await byToken(token);
    if (!['solved', 'closed'].includes(t.status)) throw badRequest('Bewerten geht nach Abschluss der Anfrage.');
    await sql`update hd_tickets set rating = ${b.rating} where id = ${t.id}`;
    changed();
    return { ok: true };
  });
}
