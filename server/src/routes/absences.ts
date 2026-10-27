/**
 * Urlaubsverwaltung und DSGVO-sauberer Teamkalender (Kapitel 11).
 * Kollegen sehen ausschließlich, WER WANN „Abwesend“ ist – keine Gründe, keine Krankheiten, keine Notizen.
 */
import type { FastifyInstance } from 'fastify';
import { countWorkingDays, germanHolidays, GERMAN_STATES } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { approversOf, canApprove, reviewableUserIds } from '../services/approvers';

export default async function absenceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  async function holidaySet(from: string, to: string) {
    const rows = await sql<{ day: string }[]>`select day::text as day from holidays where day between ${from} and ${to}`;
    return new Set(rows.map((r) => r.day));
  }

  async function balance(userId: string, year: number) {
    const [u] = await sql<{ days: number }[]>`select vacation_days_per_year::float as days from users where id = ${userId}`;
    const [adj] = await sql<{ days: number }[]>`select coalesce(sum(days), 0)::float as days from vacation_adjustments where user_id = ${userId} and year = ${year}`;
    const rows = await sql<{ status: string; days: number }[]>`select status, sum(days)::float as days from absences
      where user_id = ${userId} and kind = 'vacation' and extract(year from start_date) = ${year} and status in ('pending', 'approved') group by status`;
    const taken = rows.find((r) => r.status === 'approved')?.days ?? 0;
    const pending = rows.find((r) => r.status === 'pending')?.days ?? 0;
    const entitlement = (u?.days ?? 0) + (adj?.days ?? 0);
    return { year, entitlement, base: u?.days ?? 0, adjustments: adj?.days ?? 0, taken, pending, remaining: entitlement - taken - pending };
  }

  // ------------------------------------------------ Feiertage
  app.get('/holidays', async (req) => {
    requireUser(req);
    const { year } = parse(z.object({ year: z.coerce.number().int().default(new Date().getFullYear()) }), req.query);
    return sql`select day::text as day, name from holidays where extract(year from day) = ${year} order by day`;
  });

  app.post('/holidays/generate', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ year: z.number().int().min(2000).max(2100), state: z.enum(Object.keys(GERMAN_STATES) as [string, ...string[]]) }), req.body);
    const list = germanHolidays(b.year, b.state);
    await sql.begin(async (tx) => {
      await tx`delete from holidays where extract(year from day) = ${b.year}`;
      for (const h of list) await tx`insert into holidays (day, name) values (${h.day}, ${h.name})`;
    });
    await audit(sql, u, { action: 'holidays.generate', entityType: 'holidays', entityId: String(b.year), summary: `Feiertage ${b.year} für ${GERMAN_STATES[b.state]} übernommen` });
    return list;
  });

  app.put('/holidays', async (req) => {
    requireRole(req, 'admin');
    const b = parse(z.object({ year: z.number().int(), holidays: z.array(z.object({ day: z.string().date(), name: z.string().min(1) })) }), req.body);
    await sql.begin(async (tx) => {
      await tx`delete from holidays where extract(year from day) = ${b.year}`;
      for (const h of b.holidays) await tx`insert into holidays (day, name) values (${h.day}, ${h.name}) on conflict (day) do update set name = excluded.name`;
    });
    return { ok: true };
  });

  // ------------------------------------------------ Urlaubskonto
  app.get('/absences/balance', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ year: z.coerce.number().int().default(new Date().getFullYear()), userId: z.string().uuid().optional() }), req.query);
    const userId = q.userId ?? u.id;
    if (userId !== u.id && !(await canApprove(sql, u, userId))) throw forbidden();
    return balance(userId, q.year);
  });

  app.post('/absences/adjustments', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ userId: z.string().uuid(), year: z.number().int(), days: z.number().min(-100).max(100), note: z.string().default('') }), req.body);
    await sql`insert into vacation_adjustments (user_id, year, days, note) values (${b.userId}, ${b.year}, ${b.days}, ${b.note})`;
    await audit(sql, u, { action: 'vacation.adjust', entityType: 'user', entityId: b.userId, summary: `Urlaubskonto ${b.year}: ${b.days > 0 ? '+' : ''}${b.days} Tage (${b.note})` });
    return { ok: true };
  });

  app.get('/absences/adjustments', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ userId: z.string().uuid().optional(), year: z.coerce.number().int().optional() }), req.query);
    const userId = q.userId ?? u.id;
    if (userId !== u.id && u.role !== 'admin') throw forbidden();
    return sql`select id, year, days::float as days, note, created_at as "createdAt" from vacation_adjustments
      where user_id = ${userId} ${q.year ? sql`and year = ${q.year}` : sql``} order by year desc, created_at desc`;
  });

  // ------------------------------------------------ Anträge
  const absenceSelect = sql`a.id, a.user_id as "userId", u.display_name as "userName", a.kind, a.start_date::text as "startDate", a.end_date::text as "endDate",
    a.half_day_start as "halfDayStart", a.half_day_end as "halfDayEnd", a.days::float as days, a.note, a.status,
    ap.display_name as "approverName", a.decided_at as "decidedAt", a.created_at as "createdAt"`;

  app.get('/absences', async (req) => {
    const u = requireUser(req);
    const { year } = parse(z.object({ year: z.coerce.number().int().optional() }), req.query);
    return sql`select ${absenceSelect} from absences a join users u on u.id = a.user_id left join users ap on ap.id = a.approver_id
      where a.user_id = ${u.id} ${year ? sql`and extract(year from a.start_date) = ${year}` : sql``} order by a.start_date desc`;
  });

  app.post('/absences/preview', async (req) => {
    requireUser(req);
    const b = parse(z.object({ startDate: z.string().date(), endDate: z.string().date(), halfDayStart: z.boolean().default(false), halfDayEnd: z.boolean().default(false) }), req.body);
    if (b.endDate < b.startDate) throw badRequest('Ende vor Beginn');
    return { days: countWorkingDays(b.startDate, b.endDate, await holidaySet(b.startDate, b.endDate), b.halfDayStart, b.halfDayEnd) };
  });

  app.post('/absences', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({
      kind: z.enum(['vacation', 'other']).default('vacation'),
      startDate: z.string().date(), endDate: z.string().date(),
      halfDayStart: z.boolean().default(false), halfDayEnd: z.boolean().default(false),
      note: z.string().max(1000).default(''),
    }), req.body);
    if (b.endDate < b.startDate) throw badRequest('Das Ende liegt vor dem Beginn');
    if (b.startDate.slice(0, 4) !== b.endDate.slice(0, 4)) throw badRequest('Bitte Anträge über den Jahreswechsel getrennt stellen');
    const days = countWorkingDays(b.startDate, b.endDate, await holidaySet(b.startDate, b.endDate), b.halfDayStart, b.halfDayEnd);
    if (days <= 0) throw badRequest('Im gewählten Zeitraum liegen keine Arbeitstage');
    const [overlap] = await sql`select 1 from absences where user_id = ${u.id} and status in ('pending', 'approved')
      and start_date <= ${b.endDate} and end_date >= ${b.startDate}`;
    if (overlap) throw badRequest('Für diesen Zeitraum besteht bereits ein Antrag');
    if (b.kind === 'vacation') {
      const bal = await balance(u.id, Number(b.startDate.slice(0, 4)));
      if (bal.remaining < days) throw badRequest(`Nicht genügend Resturlaub (verfügbar: ${bal.remaining}, beantragt: ${days})`);
    }
    const [a] = await sql<{ id: string }[]>`insert into absences (user_id, kind, start_date, end_date, half_day_start, half_day_end, days, note)
      values (${u.id}, ${b.kind}, ${b.startDate}, ${b.endDate}, ${b.halfDayStart}, ${b.halfDayEnd}, ${days}, ${b.note}) returning id`;
    await audit(sql, u, { action: 'absence.request', entityType: 'absence', entityId: a!.id, summary: `Abwesenheit beantragt (${b.startDate} – ${b.endDate}, ${days} Tage)` });
    await notify(ctx, await approversOf(sql, u.id), { kind: 'absence.request', title: `${b.kind === 'vacation' ? 'Urlaubsantrag' : 'Abwesenheit'} von ${u.displayName}`,
      body: `${b.startDate} bis ${b.endDate} (${days} Tage)`, link: '/absences?tab=review' });
    return { id: a!.id, days };
  });

  app.post('/absences/:id/cancel', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [a] = await sql<{ user_id: string; status: string; start_date: string }[]>`select user_id, status, start_date::text from absences where id = ${id}`;
    if (!a || a.user_id !== u.id) throw notFound();
    if (a.status === 'approved' && a.start_date <= new Date().toISOString().slice(0, 10)) throw badRequest('Bereits begonnene Abwesenheiten bitte mit der Teamleitung klären');
    await sql`update absences set status = 'cancelled', updated_at = now() where id = ${id}`;
    if (a.status === 'approved') await notify(ctx, await approversOf(sql, u.id), { kind: 'absence.cancel', title: `${u.displayName} hat eine genehmigte Abwesenheit storniert`, link: '/absences?tab=review' });
    return { ok: true };
  });

  app.get('/absences/review', async (req) => {
    const u = requireUser(req);
    const ids = await reviewableUserIds(sql, u);
    if (ids !== 'all' && !ids.length) return [];
    const rows = await sql`select ${absenceSelect} from absences a join users u on u.id = a.user_id left join users ap on ap.id = a.approver_id
      where a.user_id <> ${u.id} ${ids === 'all' ? sql`` : sql`and a.user_id = any(${ids})`} and a.status <> 'cancelled'
      order by (a.status = 'pending') desc, a.start_date desc limit 300`;
    // Resturlaub zur Entscheidungshilfe
    const out = [];
    for (const r of rows) out.push({ ...r, balance: r.status === 'pending' ? await balance(r.userId as string, Number(String(r.startDate).slice(0, 4))) : null });
    return out;
  });

  app.post('/absences/:id/decide', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().default('') }), req.body);
    const [a] = await sql<{ user_id: string; status: string; start_date: string; end_date: string; days: number }[]>`
      select user_id, status, start_date::text, end_date::text, days::float from absences where id = ${id}`;
    if (!a) throw notFound();
    if (a.status !== 'pending') throw badRequest('Bereits entschieden');
    if (!(await canApprove(sql, u, a.user_id))) throw forbidden('Nur die zuständige Teamleitung kann entscheiden');
    await sql`update absences set status = ${b.approve ? 'approved' : 'rejected'}, approver_id = ${u.id}, decided_at = now(), updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'absence.decide', entityType: 'absence', entityId: id, summary: `Abwesenheit ${a.start_date} – ${a.end_date} ${b.approve ? 'genehmigt' : 'abgelehnt'}` });
    await notify(ctx, [a.user_id], { kind: 'absence.decision', title: `Antrag ${b.approve ? 'genehmigt ✅' : 'abgelehnt'}`, body: `${a.start_date} bis ${a.end_date}${b.note ? ` – ${b.note}` : ''}`, link: '/absences' });
    return { ok: true };
  });

  // ------------------------------------------------ DSGVO-sauberer Teamkalender
  app.get('/calendar/team', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const q = parse(z.object({ from: z.string().date(), to: z.string().date(), teamId: z.string().uuid().optional() }), req.query);
    const reviewable = await reviewableUserIds(sql, u);
    // Bewusst nur: wer, von wann bis wann, halber Tag. Keine Art, kein Grund, keine Notiz.
    const rows = await sql<{ userId: string; userName: string; startDate: string; endDate: string; halfDayStart: boolean; halfDayEnd: boolean; status: string }[]>`
      select a.user_id as "userId", u.display_name as "userName", a.start_date::text as "startDate", a.end_date::text as "endDate",
        a.half_day_start as "halfDayStart", a.half_day_end as "halfDayEnd", a.status
      from absences a join users u on u.id = a.user_id
      where a.status in ('approved', 'pending') and a.start_date <= ${q.to} and a.end_date >= ${q.from}
      ${q.teamId ? sql`and exists (select 1 from team_members tm where tm.team_id = ${q.teamId} and tm.user_id = a.user_id)` : sql``}
      order by a.start_date`;
    return rows
      .filter((r) => r.status === 'approved' || r.userId === u.id || reviewable === 'all' || reviewable.includes(r.userId))
      .map((r) => ({ ...r, label: 'Abwesend', status: r.status === 'pending' ? 'pending' : undefined }));
  });

  /** Mein Kalender: eigene Fristen, eigene Abwesenheiten (mit Details) und Feiertage */
  app.get('/calendar/me', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const tasks = await sql`select t.id, t.number, t.title, t.due_date::text as "dueDate", t.status, t.milestone, p.id as "projectId", p.number as "projectNumber"
      from tasks t join projects p on p.id = t.project_id where t.assignee_id = ${u.id} and t.due_date between ${q.from} and ${q.to} order by t.due_date`;
    const absences = await sql`select id, kind, start_date::text as "startDate", end_date::text as "endDate", status, half_day_start as "halfDayStart", half_day_end as "halfDayEnd"
      from absences where user_id = ${u.id} and status in ('pending', 'approved') and start_date <= ${q.to} and end_date >= ${q.from}`;
    const holidays = await sql`select day::text as day, name from holidays where day between ${q.from} and ${q.to}`;
    return { tasks, absences, holidays };
  });
}
