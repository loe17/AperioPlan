/**
 * Zeiterfassung (Kapitel 11): Projekt-Stempeluhr, Buchungen, Korrekturanfragen mit Genehmigung, Auswertungen.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { approversOf, canApprove, reviewableUserIds } from '../services/approvers';

const entrySelect = (sql: AppContext['sql']) => sql`e.id, e.user_id as "userId", u.display_name as "userName", e.project_id as "projectId",
  p.number as "projectNumber", p.name as "projectName", e.task_id as "taskId", t.number as "taskNumber", t.title as "taskTitle",
  e.started_at as "startedAt", e.ended_at as "endedAt", e.note, e.source,
  round((extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) / 3600)::numeric, 2)::float as hours`;
const entryFrom = (sql: AppContext['sql']) => sql`time_entries e join users u on u.id = e.user_id
  left join projects p on p.id = e.project_id left join tasks t on t.id = e.task_id`;

export default async function timeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  const round = async (d: Date) => {
    const { roundMinutes } = await ctx.settings.get('time');
    if (!roundMinutes || roundMinutes <= 1) return d;
    const ms = roundMinutes * 60000;
    return new Date(Math.round(d.getTime() / ms) * ms);
  };

  async function checkTarget(u: AuthUser, projectId: string | null | undefined, taskId: string | null | undefined) {
    if (taskId) {
      const [t] = await sql<{ project_id: string }[]>`select project_id from tasks where id = ${taskId}`;
      if (!t) throw notFound('Aufgabe nicht gefunden');
      if (projectId && projectId !== t.project_id) throw badRequest('Aufgabe gehört nicht zum Projekt');
      projectId = t.project_id;
    }
    if (projectId) await projectAccess(sql, u, projectId, 'write');
    return projectId ?? null;
  }

  // ------------------------------------------------ Stempeluhr
  app.get('/time/current', async (req) => {
    const u = requireUser(req);
    const [e] = await sql`select ${entrySelect(sql)} from ${entryFrom(sql)} where e.user_id = ${u.id} and e.ended_at is null`;
    const [today] = await sql<{ h: number }[]>`select coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - greatest(started_at, date_trunc('day', now())))) / 3600), 0)::float as h
      from time_entries where user_id = ${u.id} and coalesce(ended_at, now()) > date_trunc('day', now())`;
    const [week] = await sql<{ h: number }[]>`select coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - greatest(started_at, date_trunc('week', now())))) / 3600), 0)::float as h
      from time_entries where user_id = ${u.id} and coalesce(ended_at, now()) > date_trunc('week', now())`;
    return { running: e ?? null, todayHours: today!.h, weekHours: week!.h, settings: await ctx.settings.get('time') };
  });

  /** Einstempeln – eine laufende Buchung wird automatisch beendet (Projektwechsel per Klick) */
  app.post('/time/clock-in', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({ projectId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(), note: z.string().default('') }), req.body ?? {});
    const projectId = await checkTarget(u, b.projectId, b.taskId);
    const now = await round(new Date());
    const entry = await sql.begin(async (tx) => {
      await tx`update time_entries set ended_at = greatest(${now}, started_at + interval '1 minute'), updated_at = now() where user_id = ${u.id} and ended_at is null`;
      const [e] = await tx<{ id: string }[]>`insert into time_entries (user_id, project_id, task_id, started_at, note, source)
        values (${u.id}, ${projectId}, ${b.taskId ?? null}, ${now}, ${b.note}, 'clock') returning id`;
      return e!;
    });
    const [full] = await sql`select ${entrySelect(sql)} from ${entryFrom(sql)} where e.id = ${entry.id}`;
    ctx.hub.toUser(u.id, 'time.changed', full);
    if (projectId) ctx.hub.publish(`project:${projectId}`, 'task.changed', {});
    return full;
  });

  app.post('/time/clock-out', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ note: z.string().optional() }), req.body ?? {});
    const now = await round(new Date());
    const [e] = await sql<{ id: string; project_id: string | null }[]>`update time_entries set ended_at = greatest(${now}, started_at + interval '1 minute'),
      note = coalesce(${b.note ?? null}, note), updated_at = now() where user_id = ${u.id} and ended_at is null returning id, project_id`;
    if (!e) throw badRequest('Die Stempeluhr läuft nicht');
    const [full] = await sql`select ${entrySelect(sql)} from ${entryFrom(sql)} where e.id = ${e.id}`;
    ctx.hub.toUser(u.id, 'time.changed', null);
    if (e.project_id) ctx.hub.publish(`project:${e.project_id}`, 'task.changed', {});
    return full;
  });

  app.patch('/time/current', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ note: z.string() }), req.body);
    await sql`update time_entries set note = ${b.note}, updated_at = now() where user_id = ${u.id} and ended_at is null`;
    return { ok: true };
  });

  // ------------------------------------------------ Buchungen
  app.get('/time/entries', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date(), userId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }), req.query);
    const userId = q.userId ?? (q.projectId ? undefined : u.id);
    if (userId && userId !== u.id) {
      const ids = await reviewableUserIds(sql, u);
      if (ids !== 'all' && !ids.includes(userId)) throw forbidden('Nur Teamleitung und Administratoren sehen fremde Zeiten');
    }
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    return sql`select ${entrySelect(sql)} from ${entryFrom(sql)}
      where e.started_at < (${q.to}::date + 1) and coalesce(e.ended_at, now()) > ${q.from}::date
      ${userId ? sql`and e.user_id = ${userId}` : sql``}
      ${q.projectId ? sql`and e.project_id = ${q.projectId}` : sql``}
      order by e.started_at desc`;
  });

  /** Direkte Buchung durch Teamleitung/Administration (z. B. nach Rücksprache) */
  app.post('/time/entries', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({
      userId: z.string().uuid().optional(), projectId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(),
      startedAt: z.string().datetime({ offset: true }), endedAt: z.string().datetime({ offset: true }), note: z.string().default(''),
    }), req.body);
    const userId = b.userId ?? u.id;
    if (!(await canApprove(sql, u, userId))) throw forbidden('Eigene Zeiten bitte per Korrekturanfrage nachtragen');
    const projectId = await checkTarget(u, b.projectId, b.taskId);
    if (new Date(b.endedAt) <= new Date(b.startedAt)) throw badRequest('Ende muss nach dem Beginn liegen');
    const [e] = await sql`insert into time_entries (user_id, project_id, task_id, started_at, ended_at, note, source)
      values (${userId}, ${projectId}, ${b.taskId ?? null}, ${b.startedAt}, ${b.endedAt}, ${b.note}, 'manual') returning id`;
    await audit(sql, u, { action: 'time.manual', entityType: 'time_entry', entityId: e!.id, projectId, summary: `Zeit nachgetragen für Mitarbeiter`, details: b });
    return e;
  });

  // ------------------------------------------------ Korrekturanfragen (Was? Welche Zeit? Warum?)
  app.post('/time/corrections', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({
      kind: z.enum(['add', 'change', 'delete']),
      entryId: z.string().uuid().optional(),
      projectId: z.string().uuid().nullable().optional(),
      taskId: z.string().uuid().nullable().optional(),
      newStartedAt: z.string().datetime({ offset: true }).optional(),
      newEndedAt: z.string().datetime({ offset: true }).optional(),
      what: z.string().trim().min(2, 'Bitte angeben, was korrigiert werden soll'),
      reason: z.string().trim().min(3, 'Bitte einen Grund angeben'),
    }), req.body);
    if (b.kind !== 'add') {
      if (!b.entryId) throw badRequest('Buchung fehlt');
      const [e] = await sql`select 1 from time_entries where id = ${b.entryId} and user_id = ${u.id}`;
      if (!e) throw notFound('Buchung nicht gefunden');
    }
    if (b.kind !== 'delete') {
      if (!b.newStartedAt || !b.newEndedAt) throw badRequest('Bitte Beginn und Ende angeben');
      if (new Date(b.newEndedAt) <= new Date(b.newStartedAt)) throw badRequest('Ende muss nach dem Beginn liegen');
    }
    const projectId = await checkTarget(u, b.projectId, b.taskId);
    const [c] = await sql`insert into time_corrections (user_id, entry_id, kind, project_id, task_id, new_started_at, new_ended_at, what, reason)
      values (${u.id}, ${b.entryId ?? null}, ${b.kind}, ${projectId}, ${b.taskId ?? null}, ${b.newStartedAt ?? null}, ${b.newEndedAt ?? null}, ${b.what}, ${b.reason})
      returning id`;
    await notify(ctx, await approversOf(sql, u.id), { kind: 'time.correction', title: `Korrekturanfrage von ${u.displayName}`, body: `${b.what} – ${b.reason}`, link: '/time?tab=review' });
    return c;
  });

  const correctionSelect = (sql: AppContext['sql']) => sql`c.id, c.user_id as "userId", u.display_name as "userName", c.entry_id as "entryId", c.kind,
    c.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", c.task_id as "taskId", t.title as "taskTitle",
    c.new_started_at as "newStartedAt", c.new_ended_at as "newEndedAt", c.what, c.reason, c.status, c.review_note as "reviewNote",
    rv.display_name as "reviewerName", c.reviewed_at as "reviewedAt", c.created_at as "createdAt",
    e.started_at as "oldStartedAt", e.ended_at as "oldEndedAt"`;
  const correctionFrom = (sql: AppContext['sql']) => sql`time_corrections c join users u on u.id = c.user_id left join projects p on p.id = c.project_id
    left join tasks t on t.id = c.task_id left join users rv on rv.id = c.reviewer_id left join time_entries e on e.id = c.entry_id`;

  app.get('/time/corrections', async (req) => {
    const u = requireUser(req);
    const { scope } = parse(z.object({ scope: z.enum(['mine', 'review']).default('mine') }), req.query);
    if (scope === 'mine') return sql`select ${correctionSelect(sql)} from ${correctionFrom(sql)} where c.user_id = ${u.id} order by c.created_at desc limit 200`;
    const ids = await reviewableUserIds(sql, u);
    if (ids !== 'all' && !ids.length) return [];
    return sql`select ${correctionSelect(sql)} from ${correctionFrom(sql)} where c.user_id <> ${u.id}
      ${ids === 'all' ? sql`` : sql`and c.user_id = any(${ids})`} order by (c.status = 'pending') desc, c.created_at desc limit 300`;
  });

  app.post('/time/corrections/:id/decide', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().default('') }), req.body);
    const [c] = await sql<any[]>`select * from time_corrections where id = ${id}`;
    if (!c) throw notFound();
    if (c.status !== 'pending') throw badRequest('Bereits entschieden');
    if (!(await canApprove(sql, u, c.user_id))) throw forbidden('Nur die zuständige Teamleitung kann entscheiden');
    await sql.begin(async (tx) => {
      if (b.approve) {
        if (c.kind === 'add') {
          await tx`insert into time_entries (user_id, project_id, task_id, started_at, ended_at, note, source)
            values (${c.user_id}, ${c.project_id}, ${c.task_id}, ${c.new_started_at}, ${c.new_ended_at}, ${c.what}, 'correction')`;
        } else if (c.kind === 'change') {
          await tx`update time_entries set started_at = ${c.new_started_at}, ended_at = ${c.new_ended_at}, project_id = coalesce(${c.project_id}, project_id),
            task_id = coalesce(${c.task_id}, task_id), source = 'correction', updated_at = now() where id = ${c.entry_id}`;
        } else {
          await tx`delete from time_entries where id = ${c.entry_id}`;
        }
      }
      await tx`update time_corrections set status = ${b.approve ? 'approved' : 'rejected'}, reviewer_id = ${u.id}, reviewed_at = now(),
        review_note = ${b.note}, updated_at = now() where id = ${id}`;
    });
    await audit(sql, u, { action: 'time.correction', entityType: 'time_correction', entityId: id, projectId: c.project_id,
      summary: `Zeitkorrektur ${b.approve ? 'genehmigt' : 'abgelehnt'}: ${c.what}` });
    await notify(ctx, [c.user_id], { kind: 'time.decision', title: `Korrekturanfrage ${b.approve ? 'genehmigt' : 'abgelehnt'}`, body: `${c.what}${b.note ? ` – ${b.note}` : ''}`, link: '/time?tab=corrections' });
    return { ok: true };
  });

  // ------------------------------------------------ Auswertungen
  app.get('/projects/:id/time', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    const byUser = await sql`select u.id as "userId", u.display_name as "userName", sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) / 3600)::float as hours
      from time_entries e join users u on u.id = e.user_id where e.project_id = ${id} group by u.id order by hours desc`;
    const byTask = await sql`select t.id as "taskId", t.number, t.title, t.estimate_hours::float as "estimateHours",
      sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) / 3600)::float as hours
      from time_entries e left join tasks t on t.id = e.task_id where e.project_id = ${id} group by t.id order by hours desc`;
    const byMonth = await sql`select to_char(date_trunc('month', e.started_at), 'YYYY-MM') as month, sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) / 3600)::float as hours
      from time_entries e where e.project_id = ${id} group by 1 order by 1`;
    const recent = await sql`select ${entrySelect(sql)} from ${entryFrom(sql)} where e.project_id = ${id} order by e.started_at desc limit 100`;
    return { byUser, byTask, byMonth, recent, total: byUser.reduce((s, r) => s + Number(r.hours), 0) };
  });

  /** Export als CSV (Lohnbuchhaltung / Projektcontrolling) */
  app.get('/time/export', async (req, reply) => {
    const u = requireUser(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date(), userId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }), req.query);
    const ids = await reviewableUserIds(sql, u);
    if (q.projectId) await projectAccess(sql, u, q.projectId, 'manage');
    const userFilter = q.userId ? [q.userId] : q.projectId ? null : ids === 'all' ? null : [u.id, ...ids];
    if (q.userId && q.userId !== u.id && ids !== 'all' && !ids.includes(q.userId)) throw forbidden();
    const rows = await sql`select ${entrySelect(sql)} from ${entryFrom(sql)}
      where e.started_at >= ${q.from}::date and e.started_at < (${q.to}::date + 1) and e.ended_at is not null
      ${userFilter ? sql`and e.user_id = any(${userFilter})` : sql``}
      ${q.projectId ? sql`and e.project_id = ${q.projectId}` : sql``}
      order by u.display_name, e.started_at`;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmt = (d: Date) => new Date(d).toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' });
    const lines = [['Mitarbeiter', 'Projekt', 'Aufgabe', 'Beginn', 'Ende', 'Stunden', 'Notiz', 'Art'].join(';')];
    for (const r of rows) lines.push([r.userName, r.projectNumber ? `${r.projectNumber} ${r.projectName}` : '', r.taskTitle ?? '', fmt(r.startedAt), fmt(r.endedAt),
      String(r.hours).replace('.', ','), r.note, { clock: 'Stempeluhr', manual: 'Nachtrag', correction: 'Korrektur' }[r.source as string]].map(esc).join(';'));
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="Zeiten_${q.from}_${q.to}.csv"`);
    return '﻿' + lines.join('\r\n');
  });
}
