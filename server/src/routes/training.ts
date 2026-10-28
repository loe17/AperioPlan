/**
 * Unterweisungen und Schulungen: Pflichtunterweisungen mit Wiederholungsintervall, Inhalt online lesen,
 * Verständnisfragen beantworten und bestätigen, Präsenzschulungen mit Teilnehmerliste, Übersicht und Nachweis.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { safeName } from '../services/files';
import { staffOf, toRow, today } from '../lib/rows';
import { writeXlsx } from '../lib/xlsx';

const addMonths = (d: string, m: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const question = z.object({ q: z.string().trim().min(1).max(500), options: z.array(z.string().trim().min(1).max(300)).min(2).max(6), correct: z.number().int().min(0) });
const courseBody = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(2000).default(''), content: z.string().max(100000).default(''), kind: z.enum(['instruction', 'training']).default('instruction'),
  intervalMonths: z.number().int().min(1).max(120).nullable().default(12), audience: z.object({ all: z.boolean().default(true), teamIds: z.array(z.string().uuid()).default([]), userIds: z.array(z.string().uuid()).default([]) }).default({ all: true, teamIds: [], userIds: [] }),
  quiz: z.array(question).max(30).default([]), passScore: z.number().int().min(0).max(100).default(80), active: z.boolean().default(true),
});
type Course = { id: string; title: string; interval_months: number | null; audience: { all: boolean; teamIds: string[]; userIds: string[] }; created_at: Date; active: boolean; kind: string };
type Status = { status: 'ok' | 'due' | 'overdue' | 'open'; completedAt: string | null; validUntil: string | null; due: string | null };

/** Stand einer Person für eine Unterweisung */
export function courseStatus(c: { interval_months: number | null; created_at: Date }, last: { completed_at: Date; valid_until: string | null } | undefined, ref = today()): Status {
  if (!last) { const due = c.created_at.toISOString().slice(0, 10); return { status: due < ref ? 'overdue' : 'open', completedAt: null, validUntil: null, due }; }
  const done = last.completed_at.toISOString().slice(0, 10);
  if (!last.valid_until) return { status: 'ok', completedAt: done, validUntil: null, due: null };
  if (last.valid_until < ref) return { status: 'overdue', completedAt: done, validUntil: last.valid_until, due: last.valid_until };
  if (last.valid_until <= addDays(ref, 30)) return { status: 'due', completedAt: done, validUntil: last.valid_until, due: last.valid_until };
  return { status: 'ok', completedAt: done, validUntil: last.valid_until, due: last.valid_until };
}

async function audienceOf(ctx: AppContext, c: Course): Promise<string[]> {
  const { sql } = ctx;
  if (c.audience.all) return (await sql<{ id: string }[]>`select id from users where active and role <> 'guest' and deleted_at is null`).map((r) => r.id);
  const t = c.audience.teamIds.length ? (await sql<{ user_id: string }[]>`select user_id from team_members where team_id = any(${c.audience.teamIds})`).map((r) => r.user_id) : [];
  const ids = [...new Set([...t, ...c.audience.userIds])];
  return ids.length ? (await sql<{ id: string }[]>`select id from users where id = any(${ids}) and active and deleted_at is null`).map((r) => r.id) : [];
}
async function lastRecords(ctx: AppContext) {
  const rows = await ctx.sql<{ course_id: string; user_id: string; completed_at: Date; valid_until: string | null }[]>`select distinct on (course_id, user_id) course_id, user_id, completed_at, valid_until::text
    from trn_records order by course_id, user_id, completed_at desc`;
  return new Map(rows.map((r) => [`${r.course_id}:${r.user_id}`, r]));
}

export async function trainingDaily(ctx: AppContext) {
  const { sql } = ctx;
  if (!(await ctx.settings.get('apps')).installed.includes('training')) return;
  const courses = await sql<Course[]>`select id, title, interval_months, audience, created_at, active, kind from trn_courses where active`;
  const last = await lastRecords(ctx);
  for (const c of courses) {
    for (const uid of await audienceOf(ctx, c)) {
      const s = courseStatus(c, last.get(`${c.id}:${uid}`));
      if (s.status === 'ok' || !s.due) continue;
      const r = await sql`insert into trn_reminders (course_id, user_id, due) values (${c.id}, ${uid}, ${s.due}) on conflict do nothing`;
      if (r.count) await notify(ctx, [uid], { kind: 'training.due', title: `${c.kind === 'instruction' ? 'Unterweisung' : 'Schulung'} fällig: ${c.title}`, body: s.status === 'overdue' ? 'überfällig' : `bis ${new Date(`${s.due}T12:00:00`).toLocaleDateString('de-DE')}`, link: `/training?course=${c.id}` });
    }
  }
}

export default async function trainingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const changed = () => ctx.hub.publish('global', 'training.changed', {});
  const isManager = async (u: AuthUser) => u.role === 'admin' || (await ctx.settings.get('training')).managerIds.includes(u.id);
  const manager = async (req: Parameters<typeof staffOf>[0]) => { const u = staffOf(req); if (!(await isManager(u))) throw forbidden('Schulungen verwalten Administratoren und Schulungsverantwortliche.'); return u; };
  const cols = sql`id, title, description, content, kind, interval_months as "intervalMonths", audience, quiz, pass_score as "passScore", files, active, created_at as "createdAt", updated_at as "updatedAt"`;

  app.get('/training/mine', async (req) => {
    const u = staffOf(req);
    const courses = await sql<(Course & { description: string })[]>`select id, title, description, interval_months, audience, created_at, active, kind from trn_courses where active order by title`;
    const last = await lastRecords(ctx);
    const out = [];
    for (const c of courses) if ((await audienceOf(ctx, c)).includes(u.id)) out.push({ id: c.id, title: c.title, description: c.description, kind: c.kind, intervalMonths: c.interval_months, ...courseStatus(c, last.get(`${c.id}:${u.id}`)) });
    return { courses: out, manager: await isManager(u) };
  });
  app.get('/training/courses', async (req) => {
    await manager(req);
    const courses = await sql<any[]>`select ${cols} from trn_courses order by active desc, title`;
    const last = await lastRecords(ctx);
    const out = [];
    for (const c of courses) {
      const users = await audienceOf(ctx, { ...c, interval_months: c.intervalMonths, created_at: c.createdAt });
      const st = users.map((uid) => courseStatus({ interval_months: c.intervalMonths, created_at: c.createdAt }, last.get(`${c.id}:${uid}`)).status);
      out.push({ ...c, people: users.length, ok: st.filter((s) => s === 'ok').length, overdue: st.filter((s) => s === 'overdue').length });
    }
    return out;
  });
  app.get('/training/courses/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [c] = await sql<any[]>`select ${cols} from trn_courses where id = ${id}`;
    if (!c) throw notFound('Schulung nicht gefunden');
    const mgr = await isManager(u);
    // Lernende sehen die Fragen ohne Lösung
    if (!mgr) c.quiz = c.quiz.map((q: { q: string; options: string[] }) => ({ q: q.q, options: q.options }));
    const records = await sql`select r.id, r.completed_at as "completedAt", r.valid_until::text as "validUntil", r.score, r.method, r.trainer, r.note, u.display_name as "userName", r.user_id as "userId"
      from trn_records r join users u on u.id = r.user_id where r.course_id = ${id} ${mgr ? sql`` : sql`and r.user_id = ${u.id}`} order by r.completed_at desc limit 1000`;
    return { ...c, records, manager: mgr };
  });
  app.post('/training/courses', async (req) => {
    const u = await manager(req);
    const b = parse(courseBody, req.body);
    for (const q of b.quiz) if (q.correct >= q.options.length) throw badRequest(`Frage „${q.q}“: richtige Antwort fehlt.`);
    const [c] = await sql<{ id: string }[]>`insert into trn_courses ${sql({ ...toRow(sql, b, ['audience', 'quiz']), created_by: u.id })} returning id`;
    await audit(sql, u, { action: 'training.course.create', entityType: 'trn_course', entityId: c!.id, summary: b.title });
    changed();
    return { id: c!.id };
  });
  app.patch('/training/courses/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(courseBody), req.body);
    const row = toRow(sql, b, ['audience', 'quiz']);
    if (Object.keys(row).length) await sql`update trn_courses set ${sql(row)}, updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/training/courses/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from trn_records where course_id = ${id}`;
    if (n!.n) throw badRequest('Es gibt Nachweise zu dieser Schulung – bitte deaktivieren statt löschen.');
    await sql`delete from trn_courses where id = ${id}`;
    await audit(sql, u, { action: 'training.course.delete', entityType: 'trn_course', entityId: id, summary: 'Schulung gelöscht' });
    changed();
    return { ok: true };
  });
  app.post('/training/courses/:id/files', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const [c] = await sql<{ files: { id: string; name: string; path: string }[] }[]>`select files from trn_courses where id = ${id}`;
    if (!c) throw notFound();
    const add: { id: string; name: string; path: string }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'unterlage.pdf');
      const fid = randomUUID();
      const path = `.aperio/training/${id}/${fid}-${name}`;
      await storage.write(path, part.file);
      add.push({ id: fid, name, path });
    }
    await sql`update trn_courses set files = ${sql.json([...c.files, ...add] as never)}, updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.get('/training/courses/:id/files/:fid', async (req, reply) => {
    staffOf(req);
    const p = parse(z.object({ id: z.string().uuid(), fid: z.string().uuid() }), req.params);
    const [c] = await sql<{ files: { id: string; name: string; path: string }[] }[]>`select files from trn_courses where id = ${p.id}`;
    const f = c?.files.find((x) => x.id === p.fid);
    if (!f) throw notFound();
    reply.header('content-type', /\.pdf$/i.test(f.name) ? 'application/pdf' : 'application/octet-stream').header('content-disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    return reply.send(storage.read(f.path));
  });
  /** Online abschließen: Fragen beantworten und Teilnahme bestätigen */
  app.post('/training/courses/:id/complete', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ answers: z.array(z.number().int().min(0)).max(30).default([]), confirm: z.literal(true, { message: 'Bitte bestätigen, dass du den Inhalt gelesen und verstanden hast.' }) }), req.body);
    const [c] = await sql<{ quiz: { q: string; options: string[]; correct: number }[]; pass_score: number; interval_months: number | null; title: string; active: boolean }[]>`
      select quiz, pass_score, interval_months, title, active from trn_courses where id = ${id}`;
    if (!c || !c.active) throw notFound();
    let score: number | null = null;
    if (c.quiz.length) {
      const right = c.quiz.filter((q, i) => b.answers[i] === q.correct).length;
      score = Math.round((right / c.quiz.length) * 100);
      if (score < c.pass_score) {
        const wrong = c.quiz.map((q, i) => (b.answers[i] === q.correct ? null : i + 1)).filter(Boolean);
        throw Object.assign(badRequest(`${score} % richtig – nötig sind ${c.pass_score} %. Bitte noch einmal lesen und die Fragen ${wrong.join(', ')} prüfen.`), { details: { score, wrong } });
      }
    }
    const valid = c.interval_months ? addMonths(today(), c.interval_months) : null;
    await sql`insert into trn_records (course_id, user_id, valid_until, score, method, confirmed_by) values (${id}, ${u.id}, ${valid}, ${score}, 'online', ${u.id})`;
    await audit(sql, u, { action: 'training.complete', entityType: 'trn_course', entityId: id, summary: `${c.title} abgeschlossen${score !== null ? ` (${score} %)` : ''}` });
    changed();
    return { ok: true, score, validUntil: valid };
  });
  /** Präsenzschulung: Teilnahme mehrerer Personen erfassen */
  app.post('/training/courses/:id/attendance', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ userIds: z.array(z.string().uuid()).min(1).max(500), date: z.string().date(), trainer: z.string().max(200).default(''), note: z.string().max(1000).default('') }), req.body);
    const [c] = await sql<{ interval_months: number | null; title: string }[]>`select interval_months, title from trn_courses where id = ${id}`;
    if (!c) throw notFound();
    const valid = c.interval_months ? addMonths(b.date, c.interval_months) : null;
    for (const uid of b.userIds) await sql`insert into trn_records (course_id, user_id, completed_at, valid_until, method, trainer, confirmed_by, note) values (${id}, ${uid}, ${`${b.date}T12:00:00Z`}, ${valid}, 'presence', ${b.trainer}, ${u.id}, ${b.note})`;
    await audit(sql, u, { action: 'training.attendance', entityType: 'trn_course', entityId: id, summary: `${c.title}: ${b.userIds.length} Teilnehmer am ${b.date}` });
    changed();
    return { ok: true };
  });
  app.delete('/training/records/:id', async (req) => { await manager(req); await sql`delete from trn_records where id = ${parse(idParam, req.params).id}`; changed(); return { ok: true }; });
  app.get('/training/matrix', async (req) => {
    await manager(req);
    const courses = await sql<Course[]>`select id, title, interval_months, audience, created_at, active, kind from trn_courses where active order by title`;
    const people = await sql<{ id: string; displayName: string }[]>`select id, display_name as "displayName" from users where active and role <> 'guest' and deleted_at is null order by display_name`;
    const last = await lastRecords(ctx);
    const cells: Record<string, Status | null> = {};
    for (const c of courses) {
      const aud = new Set(await audienceOf(ctx, c));
      for (const p of people) cells[`${c.id}:${p.id}`] = aud.has(p.id) ? courseStatus(c, last.get(`${c.id}:${p.id}`)) : null;
    }
    return { courses: courses.map((c) => ({ id: c.id, title: c.title })), people, cells };
  });
  app.get('/training/records.xlsx', async (req, reply) => {
    await manager(req);
    const rows = await sql<any[]>`select c.title, u.display_name as name, r.completed_at, r.valid_until::text as valid, r.method, r.score, r.trainer, r.note from trn_records r
      join trn_courses c on c.id = r.course_id join users u on u.id = r.user_id order by c.title, u.display_name, r.completed_at desc`;
    const buf = writeXlsx([{ name: 'Nachweise', rows: [['Schulung', 'Mitarbeiter', 'Datum', 'gültig bis', 'Art', 'Ergebnis %', 'Trainer', 'Bemerkung'],
      ...rows.map((r) => [r.title, r.name, new Date(r.completed_at).toLocaleDateString('de-DE'), r.valid ? new Date(`${r.valid}T12:00:00`).toLocaleDateString('de-DE') : 'unbegrenzt', r.method === 'online' ? 'online' : 'Präsenz', r.score ?? '', r.trainer, r.note])],
      widths: [34, 24, 12, 12, 10, 10, 20, 30] }]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="Unterweisungsnachweise.xlsx"');
    return reply.send(buf);
  });
}
