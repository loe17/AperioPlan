/**
 * Einsatzplanung: Wochenplan mit Schichten je Mitarbeiter, Vorlagen, offene Schichten zum Übernehmen,
 * Urlaub und Feiertage im Blick, Veröffentlichen mit Benachrichtigung.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden } from '../lib/errors';
import { notify } from '../services/notify';
import { staffOf, toRow, addDays } from '../lib/rows';

const time = z.string().regex(/^\d{2}:\d{2}$/);
const shiftBody = z.object({ userId: z.string().uuid().nullable().default(null), date: z.string().date(), startTime: time, endTime: time, role: z.string().max(100).default(''),
  location: z.string().max(200).default(''), color: z.string().max(20).default(''), projectId: z.string().uuid().nullable().default(null), note: z.string().max(1000).default('') });

export default async function planningRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'planning.changed', {});
  const isPlanner = async (u: AuthUser) => {
    if (u.role === 'admin' || (await ctx.settings.get('planning')).plannerIds.includes(u.id)) return true;
    const [l] = await sql`select 1 from team_members where user_id = ${u.id} and is_lead limit 1`;
    return Boolean(l);
  };
  const planner = async (req: Parameters<typeof staffOf>[0]) => { const u = staffOf(req); if (!(await isPlanner(u))) throw forbidden('Pläne bearbeiten Teamleiter und Planer.'); return u; };
  const cols = sql`s.id, s.user_id as "userId", s.date::text, to_char(s.start_time, 'HH24:MI') as "startTime", to_char(s.end_time, 'HH24:MI') as "endTime", s.role, s.location, s.color,
    s.project_id as "projectId", s.note, s.published`;
  const hours = (a: string, b: string) => { const [h1, m1] = a.split(':').map(Number) as [number, number]; const [h2, m2] = b.split(':').map(Number) as [number, number]; let d = h2 * 60 + m2 - (h1 * 60 + m1); if (d <= 0) d += 1440; return d / 60; };

  app.get('/planning/week', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ from: z.string().date(), teamId: z.string().uuid().optional() }), req.query);
    const to = addDays(q.from, 6);
    const planning = await isPlanner(u);
    const users = await sql<{ id: string; displayName: string }[]>`select u.id, u.display_name as "displayName" from users u where u.active and u.role <> 'guest' and u.deleted_at is null
      ${q.teamId ? sql`and exists (select 1 from team_members m where m.user_id = u.id and m.team_id = ${q.teamId})` : sql``} order by u.display_name`;
    const shifts = await sql<any[]>`select ${cols} from plan_shifts s where s.date between ${q.from} and ${to} ${planning ? sql`` : sql`and s.published`}
      ${q.teamId ? sql`and (s.user_id is null or s.user_id = any(${users.map((x) => x.id)}))` : sql``} order by s.date, s.start_time`;
    const absences = await sql`select user_id as "userId", start_date::text as "startDate", end_date::text as "endDate", status from absences where status in ('approved', 'pending') and start_date <= ${to} and end_date >= ${q.from}`;
    const holidays = await sql`select day::text, name from holidays where day between ${q.from} and ${to}`;
    const sum = new Map<string, number>();
    for (const s of shifts) if (s.userId) sum.set(s.userId, (sum.get(s.userId) ?? 0) + hours(s.startTime, s.endTime));
    return { from: q.from, to, planner: planning, users: users.map((x) => ({ ...x, hours: Math.round((sum.get(x.id) ?? 0) * 10) / 10 })), shifts, absences, holidays,
      unpublished: shifts.filter((s) => !s.published).length };
  });
  app.get('/planning/mine', async (req) => {
    const u = staffOf(req);
    return sql`select ${cols} from plan_shifts s where s.user_id = ${u.id} and s.published and s.date >= current_date order by s.date, s.start_time limit 60`;
  });
  app.get('/planning/open', async (req) => {
    staffOf(req);
    return sql`select ${cols} from plan_shifts s where s.user_id is null and s.published and s.date >= current_date order by s.date, s.start_time limit 100`;
  });
  app.post('/planning/shifts', async (req) => {
    const u = await planner(req);
    const b = parse(shiftBody, req.body);
    const [s] = await sql<{ id: string }[]>`insert into plan_shifts ${sql({ ...toRow(sql, b), created_by: u.id })} returning id`;
    changed();
    return { id: s!.id };
  });
  app.patch('/planning/shifts/:id', async (req) => {
    await planner(req);
    const { id } = parse(idParam, req.params);
    const row = toRow(sql, parse(patchSchema(shiftBody), req.body));
    if (Object.keys(row).length) await sql`update plan_shifts set ${sql(row)}, published = false where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/planning/shifts/:id', async (req) => {
    await planner(req);
    const { id } = parse(idParam, req.params);
    const [s] = await sql<{ user_id: string | null; published: boolean; date: string }[]>`delete from plan_shifts where id = ${id} returning user_id, published, date::text`;
    if (s?.published && s.user_id) await notify(ctx, [s.user_id], { kind: 'planning.removed', title: 'Schicht entfällt', body: new Date(`${s.date}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' }), link: '/planning' });
    changed();
    return { ok: true };
  });
  /** Offene Schicht übernehmen */
  app.post('/planning/shifts/:id/claim', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [s] = await sql<{ id: string; date: string; created_by: string | null }[]>`update plan_shifts set user_id = ${u.id} where id = ${id} and user_id is null and published returning id, date::text, created_by`;
    if (!s) throw badRequest('Die Schicht ist schon vergeben.');
    await notify(ctx, [s.created_by], { kind: 'planning.claimed', title: `${u.displayName} übernimmt eine offene Schicht`, body: new Date(`${s.date}T12:00:00`).toLocaleDateString('de-DE'), link: '/planning' }, u.id);
    changed();
    return { ok: true };
  });
  app.post('/planning/copy', async (req) => {
    const u = await planner(req);
    const b = parse(z.object({ from: z.string().date(), to: z.string().date(), replace: z.boolean().default(false) }), req.body);
    const diff = Math.round((Date.parse(b.to) - Date.parse(b.from)) / 86400000);
    if (diff === 0) throw badRequest('Quelle und Ziel sind gleich.');
    if (b.replace) await sql`delete from plan_shifts where date between ${b.to} and ${addDays(b.to, 6)} and not published`;
    const r = await sql`insert into plan_shifts (user_id, date, start_time, end_time, role, location, color, project_id, note, created_by)
      select user_id, date + ${diff}::int, start_time, end_time, role, location, color, project_id, note, ${u.id} from plan_shifts where date between ${b.from} and ${addDays(b.from, 6)}`;
    changed();
    return { copied: r.count };
  });
  app.post('/planning/publish', async (req) => {
    const u = await planner(req);
    const b = parse(z.object({ from: z.string().date() }), req.body);
    const to = addDays(b.from, 6);
    const rows = await sql<{ user_id: string | null }[]>`update plan_shifts set published = true where date between ${b.from} and ${to} and not published returning user_id`;
    const people = [...new Set(rows.map((r) => r.user_id).filter(Boolean) as string[])];
    const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    await notify(ctx, people, { kind: 'planning.published', title: 'Neuer Einsatzplan', body: `Woche ${fmt(b.from)} – ${fmt(to)}`, link: '/planning' }, u.id);
    if (rows.some((r) => !r.user_id)) {
      const all = (await sql<{ id: string }[]>`select id from users where active and role <> 'guest' and deleted_at is null`).map((r) => r.id);
      await notify(ctx, all.filter((x) => !people.includes(x)), { kind: 'planning.open', title: 'Offene Schichten zu vergeben', body: `Woche ${fmt(b.from)} – ${fmt(to)}`, link: '/planning' }, u.id);
    }
    changed();
    return { published: rows.length, notified: people.length };
  });
  // Vorlagen
  const tplBody = z.object({ name: z.string().trim().min(1).max(60), startTime: time, endTime: time, role: z.string().max(100).default(''), color: z.string().max(20).default('#4f46e5') });
  app.get('/planning/templates', async (req) => {
    staffOf(req);
    return sql`select id, name, to_char(start_time, 'HH24:MI') as "startTime", to_char(end_time, 'HH24:MI') as "endTime", role, color from plan_templates order by start_time`;
  });
  app.post('/planning/templates', async (req) => {
    await planner(req);
    const [t] = await sql<{ id: string }[]>`insert into plan_templates ${sql(toRow(sql, parse(tplBody, req.body)))} returning id`;
    return { id: t!.id };
  });
  app.delete('/planning/templates/:id', async (req) => {
    await planner(req);
    await sql`delete from plan_templates where id = ${parse(idParam, req.params).id}`;
    return { ok: true };
  });
}
