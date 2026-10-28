/**
 * CRM – alles über einen Kunden (oder Lieferanten) an einer Stelle, angelehnt an SuiteCRM:
 * Firmen, Ansprechpartner, Notizen, Gesprächsprotokolle, Termine, Verlauf, Verkaufschancen, Angebote, Reklamationen,
 * Import aus Excel/CSV/Outlook (vCard) und Export als Excel.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { readTable, writeXlsx } from '../lib/xlsx';
import { Pdf, eur, num } from '../lib/pdf';
import { safeName, storeFile } from '../services/files';

const KINDS = ['customer', 'supplier', 'both'] as const;
const accountBody = z.object({
  kind: z.enum(KINDS).default('customer'),
  status: z.enum(['prospect', 'customer', 'former']).default('customer'),
  name: z.string().trim().min(1).max(200),
  street: z.string().max(200).default(''),
  zip: z.string().max(20).default(''),
  city: z.string().max(100).default(''),
  country: z.string().max(100).default('Deutschland'),
  industry: z.string().max(100).default(''),
  paymentTerms: z.string().max(200).default(''),
  website: z.string().max(200).default(''),
  phone: z.string().max(60).default(''),
  email: z.string().max(200).default(''),
  vatId: z.string().max(40).default(''),
  ownerId: z.string().uuid().nullable().default(null),
  notes: z.string().max(20000).default(''),
  custom: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

const contactBody = z.object({
  salutation: z.string().max(40).default(''),
  firstName: z.string().max(100).default(''),
  lastName: z.string().trim().min(1).max(100),
  position: z.string().max(100).default(''),
  department: z.string().max(100).default(''),
  phone: z.string().max(60).default(''),
  mobile: z.string().max(60).default(''),
  email: z.string().max(200).default(''),
  birthday: z.string().date().nullable().default(null),
  preferredChannel: z.enum(['', 'phone', 'mobile', 'email', 'visit']).default(''),
  isPrimary: z.boolean().default(false),
  notes: z.string().max(5000).default(''),
});

const agreement = z.object({ text: z.string().trim().min(1).max(1000), assigneeId: z.string().uuid().nullable().default(null), dueDate: z.string().date().nullable().default(null), projectId: z.string().uuid().nullable().default(null), taskId: z.string().uuid().nullable().default(null) });
const minutesBody = z.object({
  heldAt: z.string().datetime({ offset: true }),
  topic: z.string().trim().min(1).max(300),
  contactIds: z.array(z.string().uuid()).default([]),
  userIds: z.array(z.string().uuid()).default([]),
  otherParticipants: z.string().max(1000).default(''),
  discussed: z.string().max(50000).default(''),
  agreements: z.array(agreement).max(100).default([]),
});

const STAGES = ['request', 'offer', 'negotiation', 'won', 'lost'] as const;
const STAGE_LABEL: Record<string, string> = { request: 'Anfrage', offer: 'Angebot', negotiation: 'Verhandlung', won: 'Gewonnen', lost: 'Verloren' };
const STAGE_PROB: Record<string, number> = { request: 10, offer: 40, negotiation: 70, won: 100, lost: 0 };
const oppBody = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(300),
  stage: z.enum(STAGES).default('request'),
  value: z.number().min(0).nullable().default(null),
  probability: z.number().int().min(0).max(100).optional(),
  expectedClose: z.string().date().nullable().default(null),
  ownerId: z.string().uuid().nullable().default(null),
  lostReason: z.string().max(1000).default(''),
  description: z.string().max(20000).default(''),
  sort: z.number().optional(),
});

const position = z.object({
  text: z.string().max(500).default(''), description: z.string().max(5000).default(''), qty: z.number().default(1), unit: z.string().max(20).default('Stk'),
  price: z.number().default(0), discount: z.number().min(0).max(100).default(0), optional: z.boolean().default(false),
});
const quoteBody = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().nullable().default(null),
  opportunityId: z.string().uuid().nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  calculationId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(300),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected']).default('draft'),
  quoteDate: z.string().date().optional(),
  validUntil: z.string().date().nullable().optional(),
  intro: z.string().max(10000).optional(),
  outro: z.string().max(10000).optional(),
  positions: z.array(position).max(500).default([]),
  vatRate: z.number().min(0).max(100).optional(),
});

const caseBody = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  type: z.enum(['complaint', 'service', 'question']).default('complaint'),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50000).default(''),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  status: z.enum(['open', 'in_progress', 'waiting', 'closed']).default('open'),
  resolution: z.string().max(20000).default(''),
  assigneeId: z.string().uuid().nullable().default(null),
});

type Position = z.infer<typeof position>;
export const positionTotal = (p: Position) => (p.optional ? 0 : p.qty * p.price * (1 - p.discount / 100));

export default async function crmRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const deny = (u: AuthUser) => { if (u.role === 'guest') throw forbidden(); };

  const accountCols = sql`a.id, a.number, a.kind, a.status, a.name, a.street, a.zip, a.city, a.country, a.industry, a.payment_terms as "paymentTerms",
    a.website, a.phone, a.email, a.vat_id as "vatId", a.owner_id as "ownerId", o.display_name as "ownerName", a.notes, a.custom,
    a.last_contact_at as "lastContactAt", a.created_at as "createdAt", a.updated_at as "updatedAt"`;
  const contactCols = sql`c.id, c.account_id as "accountId", c.salutation, c.first_name as "firstName", c.last_name as "lastName", c.position, c.department,
    c.phone, c.mobile, c.email, c.birthday::text as birthday, c.preferred_channel as "preferredChannel", c.is_primary as "isPrimary", c.notes`;

  async function loadAccount(id: string) {
    const [a] = await sql<{ id: string; name: string; number: string; owner_id: string | null; kind: string }[]>`select id, name, number, owner_id, kind from crm_accounts where id = ${id}`;
    if (!a) throw notFound('Kunde nicht gefunden');
    return a;
  }
  const touch = (accountId: string, at: Date = new Date()) => sql`update crm_accounts set last_contact_at = greatest(coalesce(last_contact_at, ${at}), ${at}) where id = ${accountId}`;

  async function newAccountNumber(kind: string) {
    const n = await ctx.settings.get('numbers');
    return nextNumber(sql, kind === 'supplier' ? 'supplier' : 'customer', kind === 'supplier' ? n.supplier : n.customer,
      async (x) => (await sql`select 1 from crm_accounts where number = ${x}`).length > 0);
  }

  // ------------------------------------------------ Firmen
  app.get('/crm/accounts', async (req) => {
    const u = requireUser(req); deny(u);
    const q = parse(z.object({ q: z.string().optional(), kind: z.enum(['customer', 'supplier', 'all']).default('all'), status: z.string().optional(), ownerId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }), req.query);
    const like = q.q ? `%${q.q.trim().toLowerCase()}%` : null;
    return sql`select ${accountCols},
        (select count(*)::int from crm_contacts c where c.account_id = a.id) as "contactCount",
        (select json_build_object('name', trim(c.first_name || ' ' || c.last_name), 'email', c.email, 'phone', coalesce(nullif(c.phone, ''), c.mobile))
           from crm_contacts c where c.account_id = a.id order by c.is_primary desc, c.created_at limit 1) as "primaryContact",
        (select count(*)::int from crm_opportunities op where op.account_id = a.id and op.stage not in ('won', 'lost')) as "openOpportunities",
        (select count(*)::int from projects p where p.customer_id = a.id) as "projectCount"
      from crm_accounts a left join users o on o.id = a.owner_id
      where true
      ${q.kind === 'customer' ? sql`and a.kind in ('customer', 'both')` : q.kind === 'supplier' ? sql`and a.kind in ('supplier', 'both')` : sql``}
      ${q.status ? sql`and a.status = ${q.status}` : sql``}
      ${q.ownerId ? sql`and a.owner_id = ${q.ownerId}` : sql``}
      ${like ? sql`and (lower(a.name) like ${like} or lower(a.number) like ${like} or lower(a.city) like ${like}
         or exists (select 1 from crm_contacts c where c.account_id = a.id and lower(c.first_name || ' ' || c.last_name || ' ' || c.email) like ${like}))` : sql``}
      order by a.name limit ${q.limit}`;
  });

  app.post('/crm/accounts', async (req) => {
    const u = requireUser(req); deny(u);
    const b = parse(accountBody.extend({ number: z.string().trim().max(40).optional() }), req.body);
    if (b.number && (await sql`select 1 from crm_accounts where number = ${b.number}`).length) throw badRequest(`Nummer ${b.number} ist bereits vergeben`);
    const number = b.number || (await newAccountNumber(b.kind));
    const [a] = await sql<{ id: string; number: string }[]>`insert into crm_accounts (number, kind, status, name, street, zip, city, country, industry, payment_terms,
        website, phone, email, vat_id, owner_id, notes, custom, created_by)
      values (${number}, ${b.kind}, ${b.status}, ${b.name}, ${b.street}, ${b.zip}, ${b.city}, ${b.country}, ${b.industry}, ${b.paymentTerms},
        ${b.website}, ${b.phone}, ${b.email}, ${b.vatId}, ${b.ownerId ?? u.id}, ${b.notes}, ${sql.json(b.custom)}, ${u.id}) returning id, number`;
    await audit(sql, u, { action: 'crm.account.create', entityType: 'crm_account', entityId: a!.id, summary: `${b.kind === 'supplier' ? 'Lieferant' : 'Kunde'} ${a!.number} „${b.name}“ angelegt` });
    return { ...a, name: b.name };
  });

  app.get('/crm/accounts/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [a] = await sql`select ${accountCols} from crm_accounts a left join users o on o.id = a.owner_id where a.id = ${id}`;
    if (!a) throw notFound('Kunde nicht gefunden');
    const contacts = await sql`select ${contactCols} from crm_contacts c where c.account_id = ${id} order by c.is_primary desc, c.last_name, c.first_name`;
    const projects = await sql`select p.id, p.number, p.name, p.status, p.icon from projects p where p.customer_id = ${id} order by p.number desc`;
    const [stats] = await sql`select
        (select coalesce(sum(value), 0)::float from crm_opportunities where account_id = ${id} and stage not in ('won', 'lost')) as "pipeline",
        (select coalesce(sum(total_net), 0)::float from crm_quotes where account_id = ${id} and status = 'accepted') as "acceptedQuotes",
        (select count(*)::int from crm_cases where account_id = ${id} and status <> 'closed') as "openCases"`;
    return { ...a, contacts, projects, stats };
  });

  app.patch('/crm/accounts/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const a = await loadAccount(id);
    const b = parse(patchSchema(accountBody), req.body);
    await sql`update crm_accounts set kind = coalesce(${b.kind ?? null}, kind), status = coalesce(${b.status ?? null}, status), name = coalesce(${b.name ?? null}, name),
      street = coalesce(${b.street ?? null}, street), zip = coalesce(${b.zip ?? null}, zip), city = coalesce(${b.city ?? null}, city),
      country = coalesce(${b.country ?? null}, country), industry = coalesce(${b.industry ?? null}, industry),
      payment_terms = coalesce(${b.paymentTerms ?? null}, payment_terms), website = coalesce(${b.website ?? null}, website),
      phone = coalesce(${b.phone ?? null}, phone), email = coalesce(${b.email ?? null}, email), vat_id = coalesce(${b.vatId ?? null}, vat_id),
      owner_id = ${b.ownerId === undefined ? sql`owner_id` : b.ownerId}, notes = coalesce(${b.notes ?? null}, notes),
      custom = ${b.custom ? sql.json(b.custom) : sql`custom`}, updated_at = now() where id = ${id}`;
    if (b.name && b.name !== a.name) await sql`update projects set customer = ${b.name} where customer_id = ${id}`;
    await audit(sql, u, { action: 'crm.account.update', entityType: 'crm_account', entityId: id, summary: `${a.number} „${b.name ?? a.name}“ geändert`, details: b });
    return { ok: true };
  });

  app.delete('/crm/accounts/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const a = await loadAccount(id);
    if (u.role !== 'admin' && a.owner_id !== u.id) throw forbidden('Nur der zuständige Mitarbeiter oder ein Administrator löscht Kunden');
    const [used] = await sql<{ p: number; q: number }[]>`select (select count(*)::int from projects where customer_id = ${id}) as p, (select count(*)::int from crm_quotes where account_id = ${id}) as q`;
    if (used && (used.p || used.q)) throw badRequest(`Der Kunde hat noch ${used.p} Projekte und ${used.q} Angebote – bitte stattdessen den Status auf „ehemalig“ setzen`);
    await sql`delete from crm_accounts where id = ${id}`;
    await audit(sql, u, { action: 'crm.account.delete', entityType: 'crm_account', entityId: id, summary: `${a.number} „${a.name}“ gelöscht` });
    return { ok: true };
  });

  // ------------------------------------------------ Ansprechpartner
  async function setPrimary(accountId: string, contactId: string) {
    await sql`update crm_contacts set is_primary = (id = ${contactId}) where account_id = ${accountId}`;
  }

  app.get('/crm/contacts', async (req) => {
    const u = requireUser(req); deny(u);
    const q = parse(z.object({ accountId: z.string().uuid().optional(), q: z.string().optional() }), req.query);
    const like = q.q ? `%${q.q.toLowerCase()}%` : null;
    return sql`select ${contactCols}, a.name as "accountName" from crm_contacts c join crm_accounts a on a.id = c.account_id
      where ${q.accountId ? sql`c.account_id = ${q.accountId}` : sql`true`} ${like ? sql`and lower(c.first_name || ' ' || c.last_name || ' ' || c.email || ' ' || a.name) like ${like}` : sql``}
      order by c.last_name limit 500`;
  });

  app.post('/crm/accounts/:id/contacts', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    await loadAccount(id);
    const b = parse(contactBody, req.body);
    const first = !(await sql`select 1 from crm_contacts where account_id = ${id}`).length;
    const [c] = await sql<{ id: string }[]>`insert into crm_contacts (account_id, salutation, first_name, last_name, position, department, phone, mobile, email, birthday, preferred_channel, is_primary, notes)
      values (${id}, ${b.salutation}, ${b.firstName}, ${b.lastName}, ${b.position}, ${b.department}, ${b.phone}, ${b.mobile}, ${b.email}, ${b.birthday}, ${b.preferredChannel}, ${b.isPrimary || first}, ${b.notes}) returning id`;
    if (b.isPrimary) await setPrimary(id, c!.id);
    return c;
  });

  app.patch('/crm/contacts/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [c] = await sql<{ account_id: string }[]>`select account_id from crm_contacts where id = ${id}`;
    if (!c) throw notFound('Ansprechpartner nicht gefunden');
    const b = parse(patchSchema(contactBody), req.body);
    await sql`update crm_contacts set salutation = coalesce(${b.salutation ?? null}, salutation), first_name = coalesce(${b.firstName ?? null}, first_name),
      last_name = coalesce(${b.lastName ?? null}, last_name), position = coalesce(${b.position ?? null}, position), department = coalesce(${b.department ?? null}, department),
      phone = coalesce(${b.phone ?? null}, phone), mobile = coalesce(${b.mobile ?? null}, mobile), email = coalesce(${b.email ?? null}, email),
      birthday = ${b.birthday === undefined ? sql`birthday` : b.birthday}, preferred_channel = coalesce(${b.preferredChannel ?? null}, preferred_channel),
      notes = coalesce(${b.notes ?? null}, notes), updated_at = now() where id = ${id}`;
    if (b.isPrimary) await setPrimary(c.account_id, id);
    return { ok: true };
  });

  app.delete('/crm/contacts/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    await sql`delete from crm_contacts where id = ${id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Notizen
  app.post('/crm/accounts/:id/notes', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const a = await loadAccount(id);
    const b = parse(z.object({ body: z.string().trim().min(1).max(50000), contactId: z.string().uuid().nullable().default(null),
      attachments: z.array(z.object({ fileId: z.string().uuid(), name: z.string(), size: z.number() })).default([]), notify: z.array(z.string().uuid()).default([]) }), req.body);
    const [n] = await sql`insert into crm_notes (account_id, contact_id, user_id, body, attachments) values (${id}, ${b.contactId}, ${u.id}, ${b.body}, ${sql.json(b.attachments)}) returning id`;
    await touch(id);
    const mentions = [...b.body.matchAll(/@([\w.-]+)/g)].map((m) => m[1]!.toLowerCase());
    const targets = (await sql<{ id: string }[]>`select id from users where (lower(username) = any(${mentions}) or id = any(${b.notify})) and active`).map((x) => x.id);
    await notify(ctx, targets, { kind: 'crm.mention', title: `${u.displayName} hat dich bei ${a.name} erwähnt`, body: b.body.slice(0, 200), link: `/crm/${id}?tab=timeline` }, u.id);
    return n;
  });

  /** Anhänge zu Notizen – liegen unter CRM/<Kundennummer>_<Name>/ */
  app.post('/crm/accounts/:id/upload', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const a = await loadAccount(id);
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const f = await storeFile(ctx, { projectId: null, path: `CRM/${safeName(`${a.number}_${a.name}`)}/${stamp}_${name}`, stream: part.file, userId: u.id, via: 'CRM' });
      out.push({ fileId: f.id, name, size: f.size });
    }
    return out;
  });

  app.delete('/crm/notes/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [n] = await sql<{ user_id: string }[]>`select user_id from crm_notes where id = ${id}`;
    if (!n) throw notFound();
    if (n.user_id !== u.id && u.role !== 'admin') throw forbidden('Nur eigene Notizen');
    await sql`delete from crm_notes where id = ${id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Gesprächsprotokolle
  const minutesCols = sql`m.id, m.account_id as "accountId", m.held_at as "heldAt", m.topic, m.contact_ids as "contactIds", m.user_ids as "userIds",
    m.other_participants as "otherParticipants", m.discussed, m.agreements, m.created_by as "createdBy", cu.display_name as "createdByName", m.created_at as "createdAt"`;

  app.get('/crm/minutes/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [m] = await sql`select ${minutesCols} from crm_minutes m left join users cu on cu.id = m.created_by where m.id = ${id}`;
    if (!m) throw notFound();
    return m;
  });

  /** Vereinbarte Punkte mit Projekt und Frist werden zu Aufgaben */
  async function agreementsToTasks(u: AuthUser, accountName: string, list: z.infer<typeof agreement>[]) {
    for (const ag of list) {
      if (ag.taskId || !ag.projectId) continue;
      await projectAccess(sql, u, ag.projectId, 'edit');
      const t = await sql.begin(async (tx) => {
        const [p] = await tx<{ task_seq: number }[]>`update projects set task_seq = task_seq + 1 where id = ${ag.projectId} returning task_seq`;
        const [row] = await tx<{ id: string }[]>`insert into tasks (project_id, number, title, description, assignee_id, due_date, created_by)
          values (${ag.projectId}, ${p!.task_seq}, ${ag.text.slice(0, 500)}, ${`Vereinbart mit ${accountName}`}, ${ag.assigneeId}, ${ag.dueDate}, ${u.id}) returning id`;
        return row!;
      });
      ag.taskId = t.id;
      ctx.hub.publish(`project:${ag.projectId}`, 'task.created', { id: t.id });
      if (ag.assigneeId) await notify(ctx, [ag.assigneeId], { kind: 'task.assigned', title: `Aufgabe aus Gespräch mit ${accountName}: ${ag.text.slice(0, 120)}`, link: `/projects/${ag.projectId}?task=${t.id}` }, u.id);
    }
  }

  app.post('/crm/accounts/:id/minutes', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const a = await loadAccount(id);
    const b = parse(minutesBody, req.body);
    await agreementsToTasks(u, a.name, b.agreements);
    const [m] = await sql<{ id: string }[]>`insert into crm_minutes (account_id, held_at, topic, contact_ids, user_ids, other_participants, discussed, agreements, created_by)
      values (${id}, ${b.heldAt}, ${b.topic}, ${b.contactIds}, ${b.userIds}, ${b.otherParticipants}, ${b.discussed}, ${sql.json(b.agreements)}, ${u.id}) returning id`;
    await touch(id, new Date(b.heldAt));
    await notify(ctx, b.userIds.filter((x) => x !== u.id), { kind: 'crm.minutes', title: `Gesprächsprotokoll ${a.name}: ${b.topic}`, link: `/crm/${id}?tab=timeline` }, u.id);
    return m;
  });

  app.patch('/crm/minutes/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ account_id: string }[]>`select account_id from crm_minutes where id = ${id}`;
    if (!cur) throw notFound();
    const a = await loadAccount(cur.account_id);
    const b = parse(patchSchema(minutesBody), req.body);
    if (b.agreements) await agreementsToTasks(u, a.name, b.agreements);
    await sql`update crm_minutes set held_at = coalesce(${b.heldAt ?? null}, held_at), topic = coalesce(${b.topic ?? null}, topic),
      contact_ids = coalesce(${b.contactIds ?? null}, contact_ids), user_ids = coalesce(${b.userIds ?? null}, user_ids),
      other_participants = coalesce(${b.otherParticipants ?? null}, other_participants), discussed = coalesce(${b.discussed ?? null}, discussed),
      agreements = ${b.agreements ? sql.json(b.agreements) : sql`agreements`}, updated_at = now() where id = ${id}`;
    return { ok: true };
  });

  app.delete('/crm/minutes/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    await sql`delete from crm_minutes where id = ${id}`;
    return { ok: true };
  });

  app.get('/crm/minutes/:id/pdf', async (req, reply) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [m] = await sql<{ account_id: string; held_at: Date; topic: string; contact_ids: string[]; user_ids: string[]; other_participants: string; discussed: string; agreements: z.infer<typeof agreement>[] }[]>`select * from crm_minutes where id = ${id}`;
    if (!m) throw notFound();
    const a = await loadAccount(m.account_id);
    const contacts = await sql<{ n: string }[]>`select trim(first_name || ' ' || last_name) as n from crm_contacts where id = any(${m.contact_ids})`;
    const people = await sql<{ id: string; n: string }[]>`select id, display_name as n from users where id = any(${[...m.user_ids, ...m.agreements.map((x) => x.assigneeId).filter(Boolean) as string[]]})`;
    const company = await ctx.settings.get('company');
    const pdf = new Pdf(`Gesprächsprotokoll ${a.name}`, company.name);
    pdf.text(pdf.margin, pdf.y, company.name, { size: 9, color: '#6b7280' }); pdf.y += 18;
    pdf.paragraph(`Gesprächsprotokoll: ${m.topic}`, { size: 16, bold: true, gap: 8 });
    pdf.paragraph(`${a.number} ${a.name} · ${m.held_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' })}`, { color: '#4b5563' });
    pdf.paragraph(`Teilnehmer: ${[...contacts.map((c) => c.n), ...people.filter((p) => m.user_ids.includes(p.id)).map((p) => p.n), m.other_participants].filter(Boolean).join(', ')}`, { gap: 12 });
    pdf.paragraph('Besprochen', { size: 12, bold: true });
    pdf.paragraph(m.discussed || '–', { gap: 12 });
    if (m.agreements.length) {
      pdf.paragraph('Vereinbarte Punkte', { size: 12, bold: true });
      pdf.table([{ label: 'Nr.', width: 30 }, { label: 'Was', width: 285 }, { label: 'Wer', width: 110 }, { label: 'Bis wann', width: 70 }],
        m.agreements.map((x, i) => [String(i + 1), x.text, people.find((p) => p.id === x.assigneeId)?.n ?? '', x.dueDate ? new Date(x.dueDate).toLocaleDateString('de-DE') : '']));
    }
    pdf.footer((p, t) => `${company.name} · Gesprächsprotokoll ${a.name} · Seite ${p} von ${t}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Protokoll_${encodeURIComponent(a.name)}.pdf"`);
    return pdf.toBuffer();
  });

  // ------------------------------------------------ Verlauf (360-Grad-Sicht)
  app.get('/crm/accounts/:id/timeline', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    await loadAccount(id);
    const emails = (await sql<{ email: string }[]>`select lower(email) as email from crm_contacts where account_id = ${id} and email <> ''
      union select lower(email) from crm_accounts where id = ${id} and email <> ''`).map((r) => r.email);
    const items = await sql`
      select 'note' as type, n.id, n.created_at as at, n.body as title, '' as detail, n.user_id as "userId", us.display_name as "userName", n.attachments as extra
        from crm_notes n left join users us on us.id = n.user_id where n.account_id = ${id}
      union all select 'minutes', m.id, m.held_at, m.topic, left(m.discussed, 300), m.created_by, us.display_name, m.agreements
        from crm_minutes m left join users us on us.id = m.created_by where m.account_id = ${id}
      union all select 'event', e.id, e.starts_at, e.title, e.location, e.owner_id, us.display_name, null
        from calendar_events e left join users us on us.id = e.owner_id where e.crm_account_id = ${id}
      union all select 'opportunity', o.id, o.created_at, o.title, o.stage, o.owner_id, us.display_name, to_jsonb(o.value)
        from crm_opportunities o left join users us on us.id = o.owner_id where o.account_id = ${id}
      union all select 'quote', q.id, q.created_at, q.number || ' ' || q.title, q.status, q.created_by, us.display_name, to_jsonb(q.total_net)
        from crm_quotes q left join users us on us.id = q.created_by where q.account_id = ${id}
      union all select 'case', c.id, c.created_at, c.number || ' ' || c.title, c.status, c.created_by, us.display_name, null
        from crm_cases c left join users us on us.id = c.created_by where c.account_id = ${id}
      union all select 'project', p.id, p.created_at, p.number || ' ' || p.name, p.status, p.created_by, us.display_name, null
        from projects p left join users us on us.id = p.created_by where p.customer_id = ${id}
      union all select 'mail', mm.id, coalesce(mm.date, mm.created_at), mm.subject, mm.from_addr, mm.sent_by, null, to_jsonb(mm.direction)
        from mail_messages mm where mm.crm_account_id = ${id}
          or (${emails.length > 0} and exists (select 1 from unnest(${emails}::text[]) e where lower(mm.from_addr || ' ' || mm.to_addrs || ' ' || mm.cc_addrs) like '%' || e || '%'))
      order by at desc limit 300`;
    return items;
  });

  // ------------------------------------------------ Verkaufschancen
  const oppCols = sql`o.id, o.account_id as "accountId", a.name as "accountName", a.number as "accountNumber", o.contact_id as "contactId", o.title, o.stage,
    o.value::float as value, o.probability, o.expected_close::text as "expectedClose", o.owner_id as "ownerId", us.display_name as "ownerName",
    o.project_id as "projectId", p.number as "projectNumber", o.lost_reason as "lostReason", o.description, o.sort, o.closed_at as "closedAt", o.created_at as "createdAt"`;
  const oppFrom = sql`crm_opportunities o join crm_accounts a on a.id = o.account_id left join users us on us.id = o.owner_id left join projects p on p.id = o.project_id`;

  app.get('/crm/opportunities', async (req) => {
    const u = requireUser(req); deny(u);
    const q = parse(z.object({ accountId: z.string().uuid().optional(), open: z.coerce.boolean().optional() }), req.query);
    return sql`select ${oppCols} from ${oppFrom} where ${q.accountId ? sql`o.account_id = ${q.accountId}` : sql`true`}
      ${q.open ? sql`and o.stage not in ('won', 'lost')` : sql`and (o.stage not in ('won', 'lost') or o.closed_at > now() - interval '120 days')`}
      order by o.sort, o.created_at`;
  });

  app.post('/crm/opportunities', async (req) => {
    const u = requireUser(req); deny(u);
    const b = parse(oppBody, req.body);
    await loadAccount(b.accountId);
    const [o] = await sql<{ id: string }[]>`insert into crm_opportunities (account_id, contact_id, title, stage, value, probability, expected_close, owner_id, lost_reason, description, sort, created_by, closed_at)
      values (${b.accountId}, ${b.contactId}, ${b.title}, ${b.stage}, ${b.value}, ${b.probability ?? STAGE_PROB[b.stage]!}, ${b.expectedClose}, ${b.ownerId ?? u.id}, ${b.lostReason}, ${b.description},
        ${b.sort ?? Date.now() / 1000}, ${u.id}, ${b.stage === 'won' || b.stage === 'lost' ? new Date() : null}) returning id`;
    await touch(b.accountId);
    return o;
  });

  app.patch('/crm/opportunities/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ stage: string; title: string; account_id: string; owner_id: string | null }[]>`select stage, title, account_id, owner_id from crm_opportunities where id = ${id}`;
    if (!cur) throw notFound('Verkaufschance nicht gefunden');
    const b = parse(patchSchema(oppBody).omit({ accountId: true }), req.body);
    const prob = b.probability ?? (b.stage && b.stage !== cur.stage ? STAGE_PROB[b.stage] : undefined);
    await sql`update crm_opportunities set contact_id = ${b.contactId === undefined ? sql`contact_id` : b.contactId}, title = coalesce(${b.title ?? null}, title),
      stage = coalesce(${b.stage ?? null}, stage), value = ${b.value === undefined ? sql`value` : b.value}, probability = coalesce(${prob ?? null}, probability),
      expected_close = ${b.expectedClose === undefined ? sql`expected_close` : b.expectedClose}, owner_id = ${b.ownerId === undefined ? sql`owner_id` : b.ownerId},
      lost_reason = coalesce(${b.lostReason ?? null}, lost_reason), description = coalesce(${b.description ?? null}, description), sort = coalesce(${b.sort ?? null}, sort),
      closed_at = case when ${b.stage ?? null}::text in ('won', 'lost') and stage not in ('won', 'lost') then now() when ${b.stage ?? null}::text in ('request', 'offer', 'negotiation') then null else closed_at end,
      updated_at = now() where id = ${id}`;
    if (b.stage && b.stage !== cur.stage) {
      await audit(sql, u, { action: 'crm.opportunity', entityType: 'crm_opportunity', entityId: id, summary: `„${cur.title}“: ${STAGE_LABEL[cur.stage]} → ${STAGE_LABEL[b.stage]}` });
      if (cur.owner_id && cur.owner_id !== u.id) await notify(ctx, [cur.owner_id], { kind: 'crm.opportunity', title: `Verkaufschance „${cur.title}“: ${STAGE_LABEL[b.stage]}`, link: `/crm/${cur.account_id}?tab=opportunities` }, u.id);
    }
    return { ok: true };
  });

  app.delete('/crm/opportunities/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    await sql`delete from crm_opportunities where id = ${id}`;
    return { ok: true };
  });

  /** Gewonnen → Projekt mit einem Klick (Projekt selbst wird über /projects angelegt und hier verknüpft) */
  app.post('/crm/opportunities/:id/project', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ projectId: z.string().uuid() }), req.body);
    await projectAccess(sql, u, b.projectId);
    await sql`update crm_opportunities set project_id = ${b.projectId}, stage = 'won', probability = 100, closed_at = coalesce(closed_at, now()) where id = ${id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Angebote
  const quoteCols = sql`q.id, q.number, q.account_id as "accountId", a.name as "accountName", q.contact_id as "contactId", q.opportunity_id as "opportunityId",
    q.project_id as "projectId", q.calculation_id as "calculationId", q.title, q.status, q.quote_date::text as "quoteDate", q.valid_until::text as "validUntil",
    q.intro, q.outro, q.positions, q.vat_rate::float as "vatRate", q.total_net::float as "totalNet", q.created_by as "createdBy", us.display_name as "createdByName",
    q.created_at as "createdAt", q.updated_at as "updatedAt"`;
  const quoteFrom = sql`crm_quotes q join crm_accounts a on a.id = q.account_id left join users us on us.id = q.created_by`;

  app.get('/crm/quotes', async (req) => {
    const u = requireUser(req); deny(u);
    const q = parse(z.object({ accountId: z.string().uuid().optional(), opportunityId: z.string().uuid().optional() }), req.query);
    return sql`select ${quoteCols} from ${quoteFrom} where true ${q.accountId ? sql`and q.account_id = ${q.accountId}` : sql``}
      ${q.opportunityId ? sql`and q.opportunity_id = ${q.opportunityId}` : sql``} order by q.created_at desc limit 500`;
  });

  app.get('/crm/quotes/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [q] = await sql`select ${quoteCols} from ${quoteFrom} where q.id = ${id}`;
    if (!q) throw notFound('Angebot nicht gefunden');
    return q;
  });

  app.post('/crm/quotes', async (req) => {
    const u = requireUser(req); deny(u);
    const b = parse(quoteBody, req.body);
    const a = await loadAccount(b.accountId);
    if (b.projectId) await projectAccess(sql, u, b.projectId);
    const n = await ctx.settings.get('numbers');
    const lh = await ctx.settings.get('letterhead');
    const number = await nextNumber(sql, 'quote', n.quote, async (x) => (await sql`select 1 from crm_quotes where number = ${x}`).length > 0, { customer: a.number });
    const today = new Date().toISOString().slice(0, 10);
    const valid = new Date(Date.now() + lh.quoteValidityDays * 86400000).toISOString().slice(0, 10);
    const total = b.positions.reduce((s, p) => s + positionTotal(p), 0);
    const [q] = await sql<{ id: string; number: string }[]>`insert into crm_quotes (number, account_id, contact_id, opportunity_id, project_id, calculation_id, title, status, quote_date, valid_until,
        intro, outro, positions, vat_rate, total_net, created_by)
      values (${number}, ${b.accountId}, ${b.contactId}, ${b.opportunityId}, ${b.projectId}, ${b.calculationId}, ${b.title}, ${b.status}, ${b.quoteDate ?? today}, ${b.validUntil === undefined ? valid : b.validUntil},
        ${b.intro ?? lh.quoteIntro}, ${b.outro ?? lh.quoteOutro}, ${sql.json(b.positions)}, ${b.vatRate ?? lh.vatRate}, ${total}, ${u.id}) returning id, number`;
    if (b.opportunityId) await sql`update crm_opportunities set stage = 'offer', probability = greatest(probability, 40) where id = ${b.opportunityId} and stage = 'request'`;
    await audit(sql, u, { action: 'crm.quote.create', entityType: 'crm_quote', entityId: q!.id, summary: `Angebot ${q!.number} für ${a.name} angelegt` });
    return q;
  });

  app.patch('/crm/quotes/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ number: string; status: string; account_id: string; opportunity_id: string | null }[]>`select number, status, account_id, opportunity_id from crm_quotes where id = ${id}`;
    if (!cur) throw notFound('Angebot nicht gefunden');
    const b = parse(patchSchema(quoteBody).omit({ accountId: true }), req.body);
    const total = b.positions ? b.positions.reduce((s, p) => s + positionTotal(p), 0) : null;
    await sql`update crm_quotes set contact_id = ${b.contactId === undefined ? sql`contact_id` : b.contactId}, opportunity_id = ${b.opportunityId === undefined ? sql`opportunity_id` : b.opportunityId},
      project_id = ${b.projectId === undefined ? sql`project_id` : b.projectId}, calculation_id = ${b.calculationId === undefined ? sql`calculation_id` : b.calculationId},
      title = coalesce(${b.title ?? null}, title), status = coalesce(${b.status ?? null}, status), quote_date = coalesce(${b.quoteDate ?? null}, quote_date),
      valid_until = ${b.validUntil === undefined ? sql`valid_until` : b.validUntil}, intro = coalesce(${b.intro ?? null}, intro), outro = coalesce(${b.outro ?? null}, outro),
      positions = ${b.positions ? sql.json(b.positions) : sql`positions`}, vat_rate = coalesce(${b.vatRate ?? null}, vat_rate),
      total_net = coalesce(${total}, total_net), updated_at = now() where id = ${id}`;
    if (b.status && b.status !== cur.status) {
      await audit(sql, u, { action: 'crm.quote.status', entityType: 'crm_quote', entityId: id, summary: `Angebot ${cur.number}: ${b.status}` });
      if (b.status === 'sent') await touch(cur.account_id);
      if (cur.opportunity_id && b.status === 'accepted') await sql`update crm_opportunities set stage = 'won', probability = 100, closed_at = coalesce(closed_at, now()) where id = ${cur.opportunity_id}`;
      if (cur.opportunity_id && b.status === 'sent') await sql`update crm_opportunities set stage = 'negotiation', probability = greatest(probability, 70) where id = ${cur.opportunity_id} and stage in ('request', 'offer')`;
    }
    return { ok: true };
  });

  app.delete('/crm/quotes/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [q] = await sql<{ status: string; number: string }[]>`select status, number from crm_quotes where id = ${id}`;
    if (!q) throw notFound();
    if (q.status !== 'draft' && u.role !== 'admin') throw forbidden('Versendete Angebote bleiben erhalten – nur Entwürfe lassen sich löschen');
    await sql`delete from crm_quotes where id = ${id}`;
    await audit(sql, u, { action: 'crm.quote.delete', entityType: 'crm_quote', entityId: id, summary: `Angebot ${q.number} gelöscht` });
    return { ok: true };
  });

  app.get('/crm/quotes/:id/pdf', async (req, reply) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [q] = await sql<{ number: string; title: string; quote_date: string; valid_until: string | null; intro: string; outro: string; positions: Position[]; vat_rate: string;
      account_id: string; contact_id: string | null; created_by: string | null }[]>`select number, title, quote_date::text, valid_until::text, intro, outro, positions, vat_rate, account_id, contact_id, created_by from crm_quotes where id = ${id}`;
    if (!q) throw notFound();
    const [a] = await sql<{ name: string; street: string; zip: string; city: string; country: string; number: string; payment_terms: string }[]>`select name, street, zip, city, country, number, payment_terms from crm_accounts where id = ${q.account_id}`;
    const [c] = q.contact_id ? await sql<{ salutation: string; first_name: string; last_name: string }[]>`select salutation, first_name, last_name from crm_contacts where id = ${q.contact_id}` : [];
    const [author] = q.created_by ? await sql<{ display_name: string; email: string | null; phone: string }[]>`select display_name, email, phone from users where id = ${q.created_by}` : [];
    const company = await ctx.settings.get('company');
    const lh = await ctx.settings.get('letterhead');
    const pdf = new Pdf(`Angebot ${q.number}`, company.name);
    const L = pdf.margin, R = pdf.width - pdf.margin;
    pdf.text(L, pdf.y, company.name, { size: 14, bold: true });
    if (lh.address) pdf.text(L, pdf.y + 18, lh.address.replace(/\n/g, ' · '), { size: 8, color: '#6b7280' });
    pdf.y += 60;
    for (const l of [a!.name, c ? `${c.salutation} ${c.first_name} ${c.last_name}`.trim() : '', a!.street, `${a!.zip} ${a!.city}`.trim(), a!.country !== 'Deutschland' ? a!.country : ''].filter(Boolean)) {
      pdf.text(L, pdf.y, l, { size: 10 }); pdf.y += 13;
    }
    const metaY = pdf.y - 60;
    const meta: [string, string][] = [['Angebot', q.number], ['Datum', new Date(q.quote_date).toLocaleDateString('de-DE')], ['Kunden-Nr.', a!.number],
      ...(q.valid_until ? [['Gültig bis', new Date(q.valid_until).toLocaleDateString('de-DE')] as [string, string]] : []), ...(author ? [['Ansprechpartner', author.display_name] as [string, string]] : [])];
    meta.forEach(([k, v], i) => { pdf.text(380, metaY + i * 13, k, { size: 9, color: '#6b7280' }); pdf.text(460, metaY + i * 13, v, { size: 9 }); });
    pdf.y = Math.max(pdf.y, metaY + meta.length * 13) + 30;
    pdf.paragraph(`Angebot ${q.number}: ${q.title}`, { size: 14, bold: true, gap: 10 });
    pdf.paragraph(`${c ? `Sehr geehrte${c.salutation === 'Herr' ? 'r Herr' : c.salutation === 'Frau' ? ' Frau' : ''} ${c.salutation ? c.last_name : `${c.first_name} ${c.last_name}`.trim()},` : 'Sehr geehrte Damen und Herren,'}`, { gap: 6 });
    if (q.intro) pdf.paragraph(q.intro, { gap: 12 });
    let total = 0;
    const rows = q.positions.map((p, i) => {
      const t = positionTotal(p);
      total += t;
      return [String(i + 1), p.description ? `${p.text}\n${p.description}` : p.text, `${num(p.qty)} ${p.unit}`, eur(p.price), p.discount ? `${num(p.discount)} %` : '', p.optional ? `(${eur(p.qty * p.price * (1 - p.discount / 100))})` : eur(t)];
    });
    pdf.table([{ label: 'Pos.', width: 32 }, { label: 'Bezeichnung', width: 223 }, { label: 'Menge', width: 60, align: 'right' }, { label: 'Einzelpreis', width: 70, align: 'right' },
      { label: 'Rabatt', width: 40, align: 'right' }, { label: 'Gesamt', width: 70, align: 'right' }], rows, { zebra: true });
    const vat = total * Number(q.vat_rate) / 100;
    pdf.ensure(60);
    for (const [k, v, bold] of [['Summe netto', eur(total), false], [`zzgl. ${num(Number(q.vat_rate))} % MwSt.`, eur(vat), false], ['Gesamtbetrag', eur(total + vat), true]] as [string, string, boolean][]) {
      pdf.text(330, pdf.y, k, { bold }); pdf.text(R - 120, pdf.y, v, { bold, align: 'right', width: 120 }); pdf.y += 15;
    }
    if (q.positions.some((p) => p.optional)) pdf.paragraph('Positionen in Klammern sind optional und nicht in der Summe enthalten.', { size: 8, color: '#6b7280' });
    pdf.y += 10;
    pdf.paragraph(`Zahlungsbedingungen: ${a!.payment_terms || lh.paymentTerms}`, { size: 9 });
    if (q.outro) pdf.paragraph(q.outro, { gap: 10 });
    pdf.paragraph('Mit freundlichen Grüßen', { gap: 2 });
    pdf.paragraph(author?.display_name ?? company.name);
    pdf.footer((p, t) => `${lh.footer || company.name} · Seite ${p} von ${t}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Angebot_${q.number}.pdf"`);
    return pdf.toBuffer();
  });

  // ------------------------------------------------ Reklamationen und Serviceanfragen
  const caseCols = sql`c.id, c.number, c.account_id as "accountId", a.name as "accountName", c.contact_id as "contactId", c.project_id as "projectId", p.number as "projectNumber",
    c.type, c.title, c.description, c.priority, c.status, c.resolution, c.assignee_id as "assigneeId", us.display_name as "assigneeName",
    c.created_at as "createdAt", c.closed_at as "closedAt", extract(epoch from (coalesce(c.closed_at, now()) - c.created_at))::float / 3600 as "hoursOpen"`;
  const caseFrom = sql`crm_cases c join crm_accounts a on a.id = c.account_id left join users us on us.id = c.assignee_id left join projects p on p.id = c.project_id`;

  app.get('/crm/cases', async (req) => {
    const u = requireUser(req); deny(u);
    const q = parse(z.object({ accountId: z.string().uuid().optional(), open: z.coerce.boolean().optional() }), req.query);
    return sql`select ${caseCols} from ${caseFrom} where true ${q.accountId ? sql`and c.account_id = ${q.accountId}` : sql``} ${q.open ? sql`and c.status <> 'closed'` : sql``}
      order by (c.status = 'closed'), case c.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, c.created_at desc limit 500`;
  });

  app.post('/crm/cases', async (req) => {
    const u = requireUser(req); deny(u);
    const b = parse(caseBody, req.body);
    const a = await loadAccount(b.accountId);
    const n = await ctx.settings.get('numbers');
    const number = await nextNumber(sql, 'case', n.case, async (x) => (await sql`select 1 from crm_cases where number = ${x}`).length > 0, { customer: a.number });
    const [c] = await sql<{ id: string }[]>`insert into crm_cases (number, account_id, contact_id, project_id, type, title, description, priority, status, resolution, assignee_id, created_by, closed_at)
      values (${number}, ${b.accountId}, ${b.contactId}, ${b.projectId}, ${b.type}, ${b.title}, ${b.description}, ${b.priority}, ${b.status}, ${b.resolution}, ${b.assigneeId}, ${u.id},
        ${b.status === 'closed' ? new Date() : null}) returning id`;
    await touch(b.accountId);
    if (b.assigneeId && b.assigneeId !== u.id) await notify(ctx, [b.assigneeId], { kind: 'crm.case', title: `Reklamation ${number} zugewiesen: ${b.title}`, body: a.name, link: `/crm/${b.accountId}?tab=cases` }, u.id);
    return { id: c!.id, number };
  });

  app.patch('/crm/cases/:id', async (req) => {
    const u = requireUser(req); deny(u);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ number: string; assignee_id: string | null; account_id: string; title: string; status: string }[]>`select number, assignee_id, account_id, title, status from crm_cases where id = ${id}`;
    if (!cur) throw notFound();
    const b = parse(patchSchema(caseBody).omit({ accountId: true }), req.body);
    await sql`update crm_cases set contact_id = ${b.contactId === undefined ? sql`contact_id` : b.contactId}, project_id = ${b.projectId === undefined ? sql`project_id` : b.projectId},
      type = coalesce(${b.type ?? null}, type), title = coalesce(${b.title ?? null}, title), description = coalesce(${b.description ?? null}, description),
      priority = coalesce(${b.priority ?? null}, priority), status = coalesce(${b.status ?? null}, status), resolution = coalesce(${b.resolution ?? null}, resolution),
      assignee_id = ${b.assigneeId === undefined ? sql`assignee_id` : b.assigneeId},
      closed_at = case when ${b.status ?? null}::text = 'closed' and status <> 'closed' then now() when ${b.status ?? null}::text in ('open', 'in_progress', 'waiting') then null else closed_at end,
      updated_at = now() where id = ${id}`;
    if (b.assigneeId && b.assigneeId !== cur.assignee_id && b.assigneeId !== u.id)
      await notify(ctx, [b.assigneeId], { kind: 'crm.case', title: `Reklamation ${cur.number} zugewiesen: ${cur.title}`, link: `/crm/${cur.account_id}?tab=cases` }, u.id);
    if (b.status && b.status !== cur.status) await audit(sql, u, { action: 'crm.case.status', entityType: 'crm_case', entityId: id, summary: `Reklamation ${cur.number}: ${b.status}` });
    return { ok: true };
  });

  app.delete('/crm/cases/:id', async (req) => {
    const u = requireUser(req); deny(u);
    if (u.role !== 'admin') throw forbidden('Nur Administratoren löschen Reklamationen');
    const { id } = parse(idParam, req.params);
    await sql`delete from crm_cases where id = ${id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Übersicht
  app.get('/crm/dashboard', async (req) => {
    const u = requireUser(req); deny(u);
    const [k] = await sql`select
        (select count(*)::int from crm_accounts where kind in ('customer', 'both') and status = 'customer') as customers,
        (select count(*)::int from crm_accounts where status = 'prospect') as prospects,
        (select count(*)::int from crm_opportunities where stage not in ('won', 'lost')) as "openOpportunities",
        (select coalesce(sum(value), 0)::float from crm_opportunities where stage not in ('won', 'lost')) as pipeline,
        (select coalesce(sum(value * probability / 100.0), 0)::float from crm_opportunities where stage not in ('won', 'lost')) as weighted,
        (select coalesce(sum(value), 0)::float from crm_opportunities where stage = 'won' and closed_at > date_trunc('year', now())) as "wonThisYear",
        (select count(*)::int from crm_cases where status <> 'closed') as "openCases",
        (select count(*)::int from crm_quotes where status = 'sent') as "openQuotes"`;
    const byStage = await sql`select stage, count(*)::int as count, coalesce(sum(value), 0)::float as value from crm_opportunities
      where stage not in ('won', 'lost') or closed_at > now() - interval '90 days' group by stage`;
    const upcoming = await sql`select e.id, e.title, e.starts_at as "startsAt", a.id as "accountId", a.name as "accountName" from calendar_events e join crm_accounts a on a.id = e.crm_account_id
      where e.starts_at between now() and now() + interval '14 days' order by e.starts_at limit 10`;
    const quiet = await sql`select a.id, a.number, a.name, a.last_contact_at as "lastContactAt", o.display_name as "ownerName" from crm_accounts a left join users o on o.id = a.owner_id
      where a.status = 'customer' and a.kind in ('customer', 'both') and (a.last_contact_at is null or a.last_contact_at < now() - interval '90 days')
      order by a.last_contact_at nulls first limit 15`;
    const closing = await sql`select ${oppCols} from ${oppFrom} where o.stage not in ('won', 'lost') and o.expected_close is not null order by o.expected_close limit 8`;
    return { ...k, byStage, upcoming, quiet, closing };
  });

  // ------------------------------------------------ Import und Export
  const FIELDS: Record<string, { label: string; match: RegExp }> = {
    name: { label: 'Firma', match: /^(firma|firmenname|unternehmen|company|name|kunde|organisation|organization)$/i },
    number: { label: 'Kundennummer', match: /^(kunden-?nr\.?|kundennummer|nummer|nr\.?|number|customer ?(no|number|id))$/i },
    street: { label: 'Straße', match: /^(stra(ß|ss)e|adresse|street|address|geschäftlich straße|business street)$/i },
    zip: { label: 'PLZ', match: /^(plz|postleitzahl|zip|postal ?code|geschäftlich postleitzahl|business postal code)$/i },
    city: { label: 'Ort', match: /^(ort|stadt|city|geschäftlich ort|business city)$/i },
    country: { label: 'Land', match: /^(land|country|geschäftlich land\/region|business country\/region)$/i },
    phone: { label: 'Telefon Firma', match: /^(telefon|tel\.?|phone|telefon geschäftlich|business phone)$/i },
    email: { label: 'E-Mail Firma', match: /^(e-?mail|mail)$/i },
    website: { label: 'Webseite', match: /^(web|webseite|website|homepage|internet|webpage)$/i },
    industry: { label: 'Branche', match: /^(branche|industry)$/i },
    vatId: { label: 'USt-IdNr.', match: /^(ust-?id(nr\.?)?|vat( id)?)$/i },
    contactSalutation: { label: 'Anrede', match: /^(anrede|salutation|title)$/i },
    contactFirstName: { label: 'Vorname', match: /^(vorname|first ?name|given ?name)$/i },
    contactLastName: { label: 'Nachname', match: /^(nachname|last ?name|surname|family ?name)$/i },
    contactEmail: { label: 'E-Mail Ansprechpartner', match: /^(e-?mail-?adresse|e-?mail address|ansprechpartner e-?mail)$/i },
    contactPhone: { label: 'Telefon Ansprechpartner', match: /^(durchwahl|telefon ansprechpartner|mobile phone|mobiltelefon|handy)$/i },
    contactPosition: { label: 'Position', match: /^(position|funktion|job ?title|position\/funktion)$/i },
  };

  function parseVcards(text: string): string[][] {
    const rows: string[][] = [['Firma', 'Anrede', 'Vorname', 'Nachname', 'E-Mail-Adresse', 'Telefon', 'Mobiltelefon', 'Position', 'Straße', 'PLZ', 'Ort', 'Land', 'Webseite']];
    for (const card of text.replace(/\r\n[ \t]/g, '').split(/BEGIN:VCARD/i).slice(1)) {
      const get = (k: string) => new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, 'im').exec(card)?.[1]?.trim() ?? '';
      const [last = '', first = '', , prefix = ''] = get('N').split(';');
      const adr = get('ADR').split(';');
      const tel = [...card.matchAll(/^TEL([^:\n]*):(.*)$/gim)];
      const work = tel.find((t) => /work|voice/i.test(t[1]!))?.[2] ?? tel[0]?.[2] ?? '';
      const cell = tel.find((t) => /cell/i.test(t[1]!))?.[2] ?? '';
      rows.push([get('ORG').split(';')[0] ?? '', prefix, first, last, get('EMAIL'), work.trim(), cell.trim(), get('TITLE'), adr[2] ?? '', adr[5] ?? '', adr[3] ?? '', adr[6] ?? '', get('URL')]);
    }
    return rows;
  }

  app.post('/crm/import/preview', async (req) => {
    const u = requireUser(req); deny(u);
    const file = await req.file();
    if (!file) throw badRequest('Keine Datei');
    const buf = await file.toBuffer();
    const isVcf = /\.vcf$/i.test(file.filename) || /^BEGIN:VCARD/i.test(buf.subarray(0, 20).toString().trim());
    const rows = isVcf ? parseVcards(buf.toString('utf8')) : readTable(buf);
    if (rows.length < 2) throw badRequest('Die Datei enthält keine Zeilen');
    if (rows.length > 5001) throw badRequest('Höchstens 5000 Zeilen auf einmal');
    const header = rows[0]!.map((h) => h.trim());
    const mapping: Record<number, string> = {};
    const used = new Set<string>();
    header.forEach((h, i) => { const f = Object.entries(FIELDS).find(([k, v]) => !used.has(k) && v.match.test(h)); if (f) { mapping[i] = f[0]; used.add(f[0]); } });
    return { header, rows: rows.slice(1), mapping, fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.label])) };
  });

  app.post('/crm/import', async (req) => {
    const u = requireUser(req); deny(u);
    const b = parse(z.object({ rows: z.array(z.array(z.string())).max(5000), mapping: z.record(z.string(), z.string()), kind: z.enum(KINDS).default('customer'),
      onDuplicate: z.enum(['skip', 'update', 'create']).default('skip') }), req.body);
    const col = (row: string[], f: string) => { const i = Object.entries(b.mapping).find(([, v]) => v === f)?.[0]; return i === undefined ? '' : (row[Number(i)] ?? '').trim(); };
    if (!Object.values(b.mapping).includes('name')) throw badRequest('Bitte die Spalte für den Firmennamen zuordnen');
    let created = 0, updated = 0, skipped = 0, contacts = 0;
    const byName = new Map<string, string>();
    for (const row of b.rows) {
      const name = col(row, 'name');
      if (!name) { skipped++; continue; }
      const key = name.toLowerCase();
      let id = byName.get(key) ?? (await sql<{ id: string }[]>`select id from crm_accounts where lower(name) = ${key} limit 1`)[0]?.id;
      const data = { street: col(row, 'street'), zip: col(row, 'zip'), city: col(row, 'city'), country: col(row, 'country') || 'Deutschland', phone: col(row, 'phone'),
        email: col(row, 'email'), website: col(row, 'website'), industry: col(row, 'industry'), vat_id: col(row, 'vatId') };
      if (id && !byName.has(key)) {
        if (b.onDuplicate === 'skip') { skipped++; byName.set(key, id); }
        else if (b.onDuplicate === 'update') {
          await sql`update crm_accounts set street = coalesce(nullif(${data.street}, ''), street), zip = coalesce(nullif(${data.zip}, ''), zip), city = coalesce(nullif(${data.city}, ''), city),
            phone = coalesce(nullif(${data.phone}, ''), phone), email = coalesce(nullif(${data.email}, ''), email), website = coalesce(nullif(${data.website}, ''), website),
            industry = coalesce(nullif(${data.industry}, ''), industry), vat_id = coalesce(nullif(${data.vat_id}, ''), vat_id), updated_at = now() where id = ${id}`;
          updated++; byName.set(key, id);
        } else id = undefined;
      }
      if (!id) {
        const want = col(row, 'number');
        const number = want && !(await sql`select 1 from crm_accounts where number = ${want}`).length ? want : await newAccountNumber(b.kind);
        const [a] = await sql<{ id: string }[]>`insert into crm_accounts (number, kind, name, street, zip, city, country, phone, email, website, industry, vat_id, owner_id, created_by)
          values (${number}, ${b.kind}, ${name}, ${data.street}, ${data.zip}, ${data.city}, ${data.country}, ${data.phone}, ${data.email}, ${data.website}, ${data.industry}, ${data.vat_id}, ${u.id}, ${u.id}) returning id`;
        id = a!.id; created++; byName.set(key, id);
      }
      const last = col(row, 'contactLastName');
      if (last) {
        const email = col(row, 'contactEmail');
        const exists = email ? (await sql`select 1 from crm_contacts where account_id = ${id} and lower(email) = ${email.toLowerCase()}`).length : (await sql`select 1 from crm_contacts where account_id = ${id} and lower(last_name) = ${last.toLowerCase()} and lower(first_name) = ${col(row, 'contactFirstName').toLowerCase()}`).length;
        if (!exists) {
          const first = !(await sql`select 1 from crm_contacts where account_id = ${id}`).length;
          await sql`insert into crm_contacts (account_id, salutation, first_name, last_name, email, phone, position, is_primary)
            values (${id}, ${col(row, 'contactSalutation')}, ${col(row, 'contactFirstName')}, ${last}, ${email}, ${col(row, 'contactPhone')}, ${col(row, 'contactPosition')}, ${first})`;
          contacts++;
        }
      }
    }
    await audit(sql, u, { action: 'crm.import', entityType: 'crm_account', summary: `CRM-Import: ${created} neu, ${updated} aktualisiert, ${contacts} Ansprechpartner, ${skipped} übersprungen` });
    return { created, updated, skipped, contacts };
  });

  app.get('/crm/export.xlsx', async (req, reply) => {
    const u = requireUser(req); deny(u);
    const q = parse(z.object({ kind: z.enum(['customer', 'supplier', 'all']).default('all') }), req.query);
    const accounts = await sql<Record<string, unknown>[]>`select a.*, o.display_name as owner from crm_accounts a left join users o on o.id = a.owner_id
      where ${q.kind === 'all' ? sql`true` : q.kind === 'customer' ? sql`a.kind in ('customer', 'both')` : sql`a.kind in ('supplier', 'both')`} order by a.number`;
    const contacts = await sql<Record<string, unknown>[]>`select c.*, a.number, a.name from crm_contacts c join crm_accounts a on a.id = c.account_id order by a.number, c.last_name`;
    const KIND: Record<string, string> = { customer: 'Kunde', supplier: 'Lieferant', both: 'Kunde und Lieferant' };
    const STATUS: Record<string, string> = { prospect: 'Interessent', customer: 'Kunde', former: 'ehemalig' };
    const buf = writeXlsx([
      { name: 'Firmen', widths: [12, 36, 16, 12, 30, 8, 20, 14, 18, 28, 26, 20, 18, 18], rows: [
        ['Nummer', 'Name', 'Art', 'Status', 'Straße', 'PLZ', 'Ort', 'Land', 'Telefon', 'E-Mail', 'Webseite', 'Branche', 'USt-IdNr.', 'Zuständig', 'Zahlungsbedingungen', 'Letzter Kontakt'],
        ...accounts.map((a) => [a.number, a.name, KIND[a.kind as string], STATUS[a.status as string], a.street, a.zip, a.city, a.country, a.phone, a.email, a.website, a.industry, a.vat_id, a.owner, a.payment_terms, a.last_contact_at as Date | null] as (string | Date | null)[]),
      ] },
      { name: 'Ansprechpartner', widths: [12, 30, 10, 16, 20, 20, 18, 18, 18, 28, 12], rows: [
        ['Kunden-Nr.', 'Firma', 'Anrede', 'Vorname', 'Nachname', 'Position', 'Abteilung', 'Telefon', 'Mobil', 'E-Mail', 'Hauptkontakt'],
        ...contacts.map((c) => [c.number, c.name, c.salutation, c.first_name, c.last_name, c.position, c.department, c.phone, c.mobile, c.email, c.is_primary ? 'ja' : ''] as string[]),
      ] },
    ]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="CRM_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return buf;
  });

  // ------------------------------------------------ Doppelte Kunden zusammenführen (Administrator)
  const norm = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\b(gmbh|ag|kg|ohg|ug|co|mbh|e\.?\s?k|se|inc|ltd|haftungsbeschränkt)\b/g, '').replace(/[^a-z0-9]/g, '');

  app.get('/crm/duplicates', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    const rows = await sql<{ id: string; number: string; name: string; city: string; projects: number }[]>`select a.id, a.number, a.name, a.city,
      (select count(*)::int from projects p where p.customer_id = a.id) as projects from crm_accounts a order by a.name`;
    type Row = (typeof rows)[number];
    const groups = new Map<string, Row[]>();
    for (const r of rows) { const k = norm(r.name); if (!k) continue; groups.set(k, [...(groups.get(k) ?? []), r]); }
    return [...groups.values()].filter((g) => g.length > 1);
  });

  app.post('/crm/accounts/:id/merge', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ intoId: z.string().uuid() }), req.body);
    if (id === b.intoId) throw badRequest('Bitte zwei verschiedene Kunden wählen');
    const from = await loadAccount(id), into = await loadAccount(b.intoId);
    await sql.begin(async (tx) => {
      for (const t of ['crm_contacts', 'crm_notes', 'crm_minutes', 'crm_opportunities', 'crm_quotes', 'crm_cases'])
        await tx.unsafe(`update ${t} set account_id = $1 where account_id = $2`, [into.id, from.id]);
      await tx`update projects set customer_id = ${into.id}, customer = ${into.name} where customer_id = ${from.id}`;
      await tx`update calendar_events set crm_account_id = ${into.id} where crm_account_id = ${from.id}`;
      await tx`update mail_messages set crm_account_id = ${into.id} where crm_account_id = ${from.id}`;
      await tx`delete from crm_accounts where id = ${from.id}`;
    });
    await audit(sql, u, { action: 'crm.merge', entityType: 'crm_account', entityId: into.id, summary: `${from.number} „${from.name}“ mit ${into.number} „${into.name}“ zusammengeführt` });
    return { ok: true };
  });
}
