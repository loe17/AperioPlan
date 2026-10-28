/**
 * Messen und Veranstaltungen: Planung mit Checkliste, Budget, Kosten und Standdienst, Messekontakte (Leads) mit Übernahme ins CRM,
 * öffentliche Anmeldeseite für eigene Veranstaltungen.
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
import { writeXlsx } from '../lib/xlsx';

const check = z.object({ text: z.string().trim().min(1).max(300), done: z.boolean().default(false), due: z.string().date().nullable().default(null), userId: z.string().uuid().nullable().default(null), note: z.string().max(500).default('') });
const staffSlot = z.object({ userId: z.string().uuid(), date: z.string().date(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/), role: z.string().max(100).default('') });
const eventBody = z.object({
  name: z.string().trim().min(1).max(300), kind: z.enum(['fair', 'event', 'workshop', 'other']).default('fair'), location: z.string().max(300).default(''),
  startDate: z.string().date(), endDate: z.string().date(), status: z.enum(['idea', 'planned', 'confirmed', 'done', 'cancelled']).default('planned'), description: z.string().max(20000).default(''),
  budget: z.number().min(0).nullable().default(null), ownerId: z.string().uuid().nullable().default(null), projectId: z.string().uuid().nullable().default(null),
  checklist: z.array(check).max(300).default([]), staff: z.array(staffSlot).max(500).default([]), registrationOpen: z.boolean().default(false), maxAttendees: z.number().int().min(1).nullable().default(null),
});
const leadBody = z.object({ name: z.string().trim().min(1).max(200), company: z.string().max(200).default(''), email: z.string().max(200).default(''), phone: z.string().max(60).default(''),
  interest: z.string().max(500).default(''), notes: z.string().max(5000).default(''), rating: z.enum(['hot', 'warm', 'cold']).default('warm'), followUp: z.string().date().nullable().default(null) });

/** Standard-Checkliste für eine Messe */
export const FAIR_CHECKLIST = ['Standfläche buchen', 'Standbau / Messestand beauftragen', 'Strom, Internet und Möbel bestellen', 'Exponate auswählen und Transport planen', 'Prospekte und Give-aways bestellen',
  'Hotel und Anreise buchen', 'Ausstellerausweise bestellen', 'Kunden einladen (Freikarten)', 'Standdienst einteilen', 'Nachbereitung: Kontakte nachfassen'];

export default async function eventRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, config } = ctx;
  const changed = () => ctx.hub.publish('global', 'events.changed', {});
  const cols = sql`e.id, e.name, e.kind, e.location, e.start_date::text as "startDate", e.end_date::text as "endDate", e.status, e.description, e.budget::float as budget,
    e.owner_id as "ownerId", o.display_name as "ownerName", e.project_id as "projectId", e.checklist, e.staff, e.public_token as "publicToken", e.registration_open as "registrationOpen",
    e.max_attendees as "maxAttendees", e.updated_at as "updatedAt",
    (select coalesce(sum(amount), 0)::float from ev_costs c where c.event_id = e.id) as costs,
    (select count(*)::int from ev_leads l where l.event_id = e.id) as leads,
    (select coalesce(sum(persons), 0)::int from ev_registrations r where r.event_id = e.id and r.status <> 'cancelled') as registrations`;
  const from = sql`ev_events e left join users o on o.id = e.owner_id`;
  const decorate = (e: any) => ({ ...e, publicUrl: e.publicToken ? `${config.publicUrl}/event/${e.publicToken}` : null, costPerLead: e.leads ? Math.round((e.costs / e.leads) * 100) / 100 : null });

  app.get('/events', async (req) => {
    staffOf(req);
    const q = parse(z.object({ past: z.coerce.boolean().optional() }), req.query);
    return (await sql`select ${cols} from ${from} where ${q.past ? sql`e.end_date < current_date` : sql`e.end_date >= current_date`} order by e.start_date ${q.past ? sql`desc` : sql`asc`}`).map(decorate);
  });
  app.get('/events/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [e] = await sql`select ${cols} from ${from} where e.id = ${id}`;
    if (!e) throw notFound('Veranstaltung nicht gefunden');
    const costList = await sql`select id, text, category, amount::float as amount, date::text from ev_costs where event_id = ${id} order by date nulls last, created_at`;
    const leadList = await sql`select l.id, l.name, l.company, l.email, l.phone, l.interest, l.notes, l.rating, l.follow_up::text as "followUp", l.account_id as "accountId", a.name as "accountName",
      u.display_name as "createdByName", l.created_at as "createdAt" from ev_leads l left join crm_accounts a on a.id = l.account_id left join users u on u.id = l.created_by where l.event_id = ${id} order by l.created_at desc`;
    const regs = await sql`select id, name, company, email, persons, note, status, created_at as "createdAt" from ev_registrations where event_id = ${id} order by created_at`;
    return { ...decorate(e), costList, leadList, registrationList: regs };
  });
  app.post('/events', async (req) => {
    const u = staffOf(req);
    const b = parse(eventBody.extend({ template: z.boolean().default(true) }), req.body);
    const { template, ...rest } = b;
    if (rest.endDate < rest.startDate) throw badRequest('Das Ende liegt vor dem Beginn.');
    const checklist = rest.checklist.length || !template || rest.kind !== 'fair' ? rest.checklist : FAIR_CHECKLIST.map((text) => ({ text, done: false, due: null, userId: null, note: '' }));
    const [e] = await sql<{ id: string }[]>`insert into ev_events ${sql(toRow(sql, { ...rest, checklist, ownerId: rest.ownerId ?? u.id }, ['checklist', 'staff']))} returning id`;
    await audit(sql, u, { action: 'events.create', entityType: 'ev_event', entityId: e!.id, summary: rest.name });
    changed();
    return { id: e!.id };
  });
  app.patch('/events/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(eventBody), req.body);
    const [cur] = await sql<{ staff: z.infer<typeof staffSlot>[]; name: string; public_token: string | null }[]>`select staff, name, public_token from ev_events where id = ${id}`;
    if (!cur) throw notFound();
    const row = toRow(sql, b, ['checklist', 'staff']);
    if (b.registrationOpen && !cur.public_token) row.public_token = randomBytes(15).toString('base64url');
    if (Object.keys(row).length) await sql`update ev_events set ${sql(row)}, updated_at = now() where id = ${id}`;
    if (b.staff) {
      const added = [...new Set(b.staff.map((s) => s.userId))].filter((x) => !cur.staff.some((s) => s.userId === x));
      await notify(ctx, added, { kind: 'events.staff', title: `Standdienst: ${cur.name}`, body: 'Du bist für den Standdienst eingeteilt.', link: `/events?event=${id}` }, u.id);
    }
    changed();
    return { ok: true };
  });
  app.delete('/events/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from ev_events where id = ${id}`;
    await audit(sql, u, { action: 'events.delete', entityType: 'ev_event', entityId: id, summary: 'Veranstaltung gelöscht' });
    changed();
    return { ok: true };
  });

  // Kosten
  app.post('/events/:id/costs', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ text: z.string().trim().min(1).max(300), category: z.string().max(100).default(''), amount: z.number(), date: z.string().date().nullable().default(null) }), req.body);
    await sql`insert into ev_costs (event_id, text, category, amount, date) values (${id}, ${b.text}, ${b.category}, ${b.amount}, ${b.date})`;
    changed();
    return { ok: true };
  });
  app.delete('/events/costs/:id', async (req) => { staffOf(req); await sql`delete from ev_costs where id = ${parse(idParam, req.params).id}`; changed(); return { ok: true }; });

  // Messekontakte
  app.post('/events/:id/leads', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(leadBody, req.body);
    const [l] = await sql<{ id: string }[]>`insert into ev_leads ${sql({ ...toRow(sql, b), event_id: id, created_by: u.id })} returning id`;
    changed();
    return { id: l!.id };
  });
  app.patch('/events/leads/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const row = toRow(sql, parse(patchSchema(leadBody), req.body));
    if (Object.keys(row).length) await sql`update ev_leads set ${sql(row)} where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/events/leads/:id', async (req) => { staffOf(req); await sql`delete from ev_leads where id = ${parse(idParam, req.params).id}`; changed(); return { ok: true }; });
  /** Kontakt ins CRM übernehmen: vorhandene Firma (gleicher Name oder E-Mail) oder neuer Interessent, mit Ansprechpartner und Notiz */
  app.post('/events/leads/:id/to-crm', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    if (!(await ctx.settings.get('apps')).installed.includes('crm')) throw badRequest('Dafür wird das CRM benötigt.');
    const [l] = await sql<{ name: string; company: string; email: string; phone: string; interest: string; notes: string; rating: string; follow_up: string | null; account_id: string | null; event_name: string }[]>`
      select l.name, l.company, l.email, l.phone, l.interest, l.notes, l.rating, l.follow_up::text, l.account_id, e.name as event_name from ev_leads l join ev_events e on e.id = l.event_id where l.id = ${id}`;
    if (!l) throw notFound();
    if (l.account_id) return { accountId: l.account_id };
    const company = l.company.trim() || l.name;
    let [acc] = await sql<{ id: string }[]>`select a.id from crm_accounts a where lower(a.name) = ${company.toLowerCase()}
      or (${l.email} <> '' and exists (select 1 from crm_contacts c where c.account_id = a.id and lower(c.email) = ${l.email.toLowerCase()})) limit 1`;
    if (!acc) {
      const n = await ctx.settings.get('numbers');
      const number = await nextNumber(sql, 'customer', n.customer, async (x) => (await sql`select 1 from crm_accounts where number = ${x}`).length > 0);
      [acc] = await sql<{ id: string }[]>`insert into crm_accounts (number, kind, status, name, email, phone, owner_id, created_by) values (${number}, 'customer', 'prospect', ${company}, ${l.company ? '' : l.email}, ${l.company ? '' : l.phone}, ${u.id}, ${u.id}) returning id`;
    }
    const parts = l.name.trim().split(/\s+/);
    const last = parts.length > 1 ? parts.pop()! : l.name;
    if (l.company.trim()) await sql`insert into crm_contacts (account_id, first_name, last_name, email, phone) values (${acc!.id}, ${parts.join(' ')}, ${last}, ${l.email}, ${l.phone})`;
    await sql`insert into crm_notes (account_id, user_id, body) values (${acc!.id}, ${u.id}, ${`Kontakt auf „${l.event_name}“ (${{ hot: 'heiß', warm: 'warm', cold: 'kalt' }[l.rating]}): ${[l.interest, l.notes].filter(Boolean).join(' – ') || 'ohne Notiz'}`})`;
    await sql`update ev_leads set account_id = ${acc!.id} where id = ${id}`;
    await audit(sql, u, { action: 'events.lead.crm', entityType: 'crm_account', entityId: acc!.id, summary: `Messekontakt ${l.name} übernommen` });
    changed();
    return { accountId: acc!.id };
  });
  app.get('/events/:id/leads.xlsx', async (req, reply) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [e] = await sql<{ name: string }[]>`select name from ev_events where id = ${id}`;
    if (!e) throw notFound();
    const rows = await sql<any[]>`select l.name, l.company, l.email, l.phone, l.interest, l.notes, l.rating, l.follow_up::text as follow_up, u.display_name as by from ev_leads l left join users u on u.id = l.created_by where l.event_id = ${id} order by l.created_at`;
    const buf = writeXlsx([{ name: 'Kontakte', rows: [['Name', 'Firma', 'E-Mail', 'Telefon', 'Interesse', 'Notizen', 'Bewertung', 'Nachfassen', 'Erfasst von'],
      ...rows.map((r) => [r.name, r.company, r.email, r.phone, r.interest, r.notes, { hot: 'heiß', warm: 'warm', cold: 'kalt' }[r.rating as string] ?? r.rating, r.follow_up ?? '', r.by ?? ''])], widths: [24, 24, 28, 18, 30, 40, 10, 12, 18] }]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Kontakte_${encodeURIComponent(e.name)}.xlsx"`);
    return reply.send(buf);
  });
  app.patch('/events/registrations/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ status: z.enum(['registered', 'cancelled', 'attended']) }), req.body);
    await sql`update ev_registrations set status = ${b.status} where id = ${id}`;
    changed();
    return { ok: true };
  });

  // ------------------------------------------------ Öffentliche Anmeldung
  const pubEvent = async (token: string) => {
    if (!(await ctx.settings.get('apps')).installed.includes('events')) throw notFound();
    const [e] = await sql<{ id: string; name: string; location: string; start_date: string; end_date: string; description: string; registration_open: boolean; max_attendees: number | null; owner_id: string | null; taken: number }[]>`
      select id, name, location, start_date::text, end_date::text, description, registration_open, max_attendees, owner_id,
        (select coalesce(sum(persons), 0)::int from ev_registrations r where r.event_id = e.id and r.status <> 'cancelled') as taken from ev_events e where public_token = ${token}`;
    if (!e) throw notFound('Veranstaltung nicht gefunden');
    return e;
  };
  app.get('/pub/event/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(60) }), req.params);
    const e = await pubEvent(token);
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    return { name: e.name, location: e.location, startDate: e.start_date, endDate: e.end_date, description: e.description, open: e.registration_open,
      seatsLeft: e.max_attendees ? Math.max(0, e.max_attendees - e.taken) : null, company };
  });
  app.post('/pub/event/:token', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(60) }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(200), company: z.string().max(200).default(''), email: z.string().trim().email().max(200), persons: z.number().int().min(1).max(20).default(1),
      note: z.string().max(2000).default(''), website: z.string().max(0).default('') }), req.body);
    const e = await pubEvent(token);
    if (!e.registration_open) throw badRequest('Die Anmeldung ist geschlossen.');
    if (e.max_attendees && e.taken + b.persons > e.max_attendees) throw badRequest('Leider sind nicht mehr genug Plätze frei.');
    const t = randomBytes(15).toString('base64url');
    await sql`insert into ev_registrations (event_id, name, company, email, persons, note, token) values (${e.id}, ${b.name}, ${b.company}, ${b.email}, ${b.persons}, ${b.note}, ${t})`;
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    const d = (x: string) => new Date(`${x}T12:00:00`).toLocaleDateString('de-DE');
    await sendMail(ctx, { to: b.email, subject: `Anmeldung bestätigt: ${e.name}`, text: `Guten Tag ${b.name},\n\nvielen Dank für Ihre Anmeldung zu „${e.name}“ am ${d(e.start_date)}${e.end_date !== e.start_date ? ` bis ${d(e.end_date)}` : ''}${e.location ? ` in ${e.location}` : ''} (${b.persons} Person${b.persons > 1 ? 'en' : ''}).\n\nWir freuen uns auf Sie!\n\nMit freundlichen Grüßen\n${company}` }).catch(() => undefined);
    await notify(ctx, [e.owner_id], { kind: 'events.registration', title: `Neue Anmeldung: ${e.name}`, body: `${b.name}${b.company ? ` (${b.company})` : ''}, ${b.persons} Person(en)`, link: `/events?event=${e.id}` });
    changed();
    return { ok: true };
  });
}
