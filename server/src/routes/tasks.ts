import type { FastifyInstance } from 'fastify';
import { TASK_PRIORITIES, TASK_STATUSES } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess, visibleProjects } from '../lib/access';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';

const taskBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().default(''),
  status: z.enum(TASK_STATUSES).default('todo'),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  assigneeId: z.string().uuid().nullable().default(null),
  teamId: z.string().uuid().nullable().default(null),
  startDate: z.string().date().nullable().default(null),
  dueDate: z.string().date().nullable().default(null),
  estimateHours: z.number().min(0).nullable().default(null),
  milestone: z.boolean().default(false),
});

const STATUS_LABEL: Record<string, string> = { todo: 'Zu erledigen', in_progress: 'In Arbeit', review: 'Prüfung', done: 'Fertig' };

export const taskSelect = (sql: AppContext['sql']) => sql`
  t.id, t.project_id as "projectId", t.number, t.title, t.description, t.status, t.priority,
  t.assignee_id as "assigneeId", a.display_name as "assigneeName", t.team_id as "teamId", tm.name as "teamName",
  t.start_date as "startDate", t.due_date as "dueDate", t.estimate_hours::float as "estimateHours", t.milestone, t.sort,
  t.created_at as "createdAt", t.updated_at as "updatedAt", t.completed_at as "completedAt",
  (select count(*)::int from comments c where c.entity_type = 'task' and c.entity_id = t.id) as "commentCount",
  (select coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) / 3600), 0)::float
     from time_entries e where e.task_id = t.id) as "hoursBooked",
  coalesce((select array_agg(d.depends_on_id) from task_dependencies d where d.task_id = t.id), '{}') as "dependsOn",
  coalesce((select array_agg(w.user_id) from task_watchers w where w.task_id = t.id), '{}') as "watchers"`;

const taskFrom = (sql: AppContext['sql']) => sql`tasks t left join users a on a.id = t.assignee_id left join teams tm on tm.id = t.team_id`;

export default async function taskRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  async function loadTask(u: AuthUser, id: string, need: 'read' | 'edit' = 'read') {
    const [t] = await sql<{ id: string; project_id: string; number: number; title: string; status: string; assignee_id: string | null }[]>`
      select id, project_id, number, title, status, assignee_id from tasks where id = ${id}`;
    if (!t) throw notFound('Aufgabe nicht gefunden');
    const p = await projectAccess(sql, u, t.project_id, need);
    return { t, p };
  }

  app.get('/projects/:id/tasks', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    return sql`select ${taskSelect(sql)} from ${taskFrom(sql)} where t.project_id = ${id} order by t.status, t.sort, t.number`;
  });

  /** Mein Schreibtisch: mir zugewiesene offene Aufgaben über alle Projekte */
  app.get('/tasks/mine', async (req) => {
    const u = requireUser(req);
    return sql`select ${taskSelect(sql)}, p.number as "projectNumber", p.name as "projectName", p.icon as "projectIcon"
      from ${taskFrom(sql)} join projects p on p.id = t.project_id
      where t.assignee_id = ${u.id} and t.status <> 'done' and ${visibleProjects(sql, u)}
      order by t.due_date nulls last, t.priority desc limit 200`;
  });

  app.post('/projects/:id/tasks', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const p = await projectAccess(sql, u, id, 'edit');
    const b = parse(taskBody, req.body);
    const task = await sql.begin(async (tx) => {
      const task_seq = (await tx<{ task_seq: number }[]>`update projects set task_seq = task_seq + 1 where id = ${id} returning task_seq`)[0]!.task_seq;
      const s = (await tx<{ s: number }[]>`select coalesce(max(sort), 0) + 1000 as s from tasks where project_id = ${id} and status = ${b.status}`)[0]!.s;
      const [t] = await tx`insert into tasks (project_id, number, title, description, status, priority, assignee_id, team_id,
        start_date, due_date, estimate_hours, milestone, sort, created_by, completed_at)
        values (${id}, ${task_seq}, ${b.title}, ${b.description}, ${b.status}, ${b.priority}, ${b.assigneeId}, ${b.teamId},
        ${b.startDate}, ${b.dueDate}, ${b.estimateHours}, ${b.milestone}, ${s}, ${u.id}, ${b.status === 'done' ? new Date() : null})
        returning id`;
      return t!;
    });
    const [full] = await sql`select ${taskSelect(sql)} from ${taskFrom(sql)} where t.id = ${task.id}`;
    await audit(sql, u, { action: 'task.create', entityType: 'task', entityId: task.id, projectId: id, summary: `Aufgabe P${full!.number} „${b.title}“ angelegt` });
    ctx.hub.publish(`project:${id}`, 'task.changed', full);
    await notify(ctx, [b.assigneeId], { kind: 'task.assigned', title: `Neue Aufgabe: ${b.title}`, body: `${p.number} ${p.name}`, link: `/projects/${id}?task=${task.id}` }, u.id);
    return full;
  });

  app.get('/tasks/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadTask(u, id);
    const [t] = await sql`select ${taskSelect(sql)}, p.number as "projectNumber", p.name as "projectName"
      from ${taskFrom(sql)} join projects p on p.id = t.project_id where t.id = ${id}`;
    return t;
  });

  app.patch('/tasks/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { t, p } = await loadTask(u, id, 'edit');
    const b = parse(patchSchema(taskBody).extend({ sort: z.number().optional() }), req.body);
    await sql`update tasks set
      title = coalesce(${b.title ?? null}, title), description = coalesce(${b.description ?? null}, description),
      status = coalesce(${b.status ?? null}, status), priority = coalesce(${b.priority ?? null}, priority),
      assignee_id = ${b.assigneeId === undefined ? sql`assignee_id` : b.assigneeId},
      team_id = ${b.teamId === undefined ? sql`team_id` : b.teamId},
      start_date = ${b.startDate === undefined ? sql`start_date` : b.startDate},
      due_date = ${b.dueDate === undefined ? sql`due_date` : b.dueDate},
      estimate_hours = ${b.estimateHours === undefined ? sql`estimate_hours` : b.estimateHours},
      milestone = coalesce(${b.milestone ?? null}, milestone), sort = coalesce(${b.sort ?? null}, sort),
      completed_at = case when ${b.status ?? null}::text = 'done' and status <> 'done' then now()
                          when ${b.status ?? null}::text is not null and ${b.status ?? null}::text <> 'done' then null else completed_at end,
      updated_at = now()
      where id = ${id}`;
    const [full] = await sql`select ${taskSelect(sql)} from ${taskFrom(sql)} where t.id = ${id}`;
    const changes = Object.keys(b).filter((k) => k !== 'sort');
    if (changes.length) {
      await audit(sql, u, { action: 'task.update', entityType: 'task', entityId: id, projectId: t.project_id,
        summary: b.status && b.status !== t.status ? `P${t.number}: Status ${STATUS_LABEL[t.status]} → ${STATUS_LABEL[b.status]}` : `P${t.number} geändert (${changes.join(', ')})`,
        details: b });
    }
    ctx.hub.publish(`project:${t.project_id}`, 'task.changed', full);
    if (b.assigneeId && b.assigneeId !== t.assignee_id)
      await notify(ctx, [b.assigneeId], { kind: 'task.assigned', title: `Aufgabe zugewiesen: ${full!.title}`, body: `${p.number} ${p.name}`, link: `/projects/${t.project_id}?task=${id}` }, u.id);
    if (b.status && b.status !== t.status) {
      const watchers = await sql<{ user_id: string }[]>`select user_id from task_watchers where task_id = ${id}`;
      await notify(ctx, watchers.map((w) => w.user_id), { kind: 'task.status', title: `P${t.number} ${full!.title}: ${STATUS_LABEL[b.status]}`, body: `${p.number} ${p.name}`, link: `/projects/${t.project_id}?task=${id}` }, u.id);
    }
    if (b.status === 'review' && t.status !== 'review') {
      const leads = await sql<{ user_id: string }[]>`select user_id from project_members where project_id = ${t.project_id} and role = 'owner'`;
      await notify(ctx, leads.map((l) => l.user_id), { kind: 'task.review', title: `Zur Prüfung: ${full!.title}`, body: `${p.number} ${p.name}`, link: `/projects/${t.project_id}?task=${id}` }, u.id);
    }
    return full;
  });

  /** Personen, die bei Änderungen und Kommentaren dieser Aufgabe benachrichtigt werden */
  app.put('/tasks/:id/watchers', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { t, p } = await loadTask(u, id, 'edit');
    const b = parse(z.object({ userIds: z.array(z.string().uuid()).max(200) }), req.body);
    const before = (await sql<{ user_id: string }[]>`select user_id from task_watchers where task_id = ${id}`).map((r) => r.user_id);
    await sql.begin(async (tx) => {
      await tx`delete from task_watchers where task_id = ${id}`;
      for (const uid of new Set(b.userIds)) await tx`insert into task_watchers (task_id, user_id) values (${id}, ${uid}) on conflict do nothing`;
    });
    const added = b.userIds.filter((x) => !before.includes(x));
    await notify(ctx, added, { kind: 'task.watch', title: `${u.displayName} hält dich zu „${t.title}“ auf dem Laufenden`, body: `${p.number} ${p.name}`, link: `/projects/${t.project_id}?task=${id}` }, u.id);
    const [full] = await sql`select ${taskSelect(sql)} from ${taskFrom(sql)} where t.id = ${id}`;
    ctx.hub.publish(`project:${t.project_id}`, 'task.changed', full);
    return full;
  });

  app.delete('/tasks/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { t } = await loadTask(u, id, 'edit');
    await sql`delete from tasks where id = ${id}`;
    await audit(sql, u, { action: 'task.delete', entityType: 'task', entityId: id, projectId: t.project_id, summary: `Aufgabe P${t.number} „${t.title}“ gelöscht` });
    ctx.hub.publish(`project:${t.project_id}`, 'task.deleted', { id });
    return { ok: true };
  });

  /** Abhängigkeiten für das Gantt-Diagramm: Welche Aufgabe blockiert welche? */
  app.put('/tasks/:id/dependencies', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { t } = await loadTask(u, id, 'edit');
    const b = parse(z.object({ dependsOn: z.array(z.string().uuid()) }), req.body);
    // Kreisbezüge verhindern
    for (const dep of b.dependsOn) {
      const [cycle] = await sql`with recursive chain(id) as (
          select depends_on_id from task_dependencies where task_id = ${dep}
          union select d.depends_on_id from task_dependencies d join chain c on d.task_id = c.id)
        select 1 from chain where id = ${id}`;
      if (cycle || dep === id) throw badRequest('Diese Abhängigkeit würde einen Kreis erzeugen');
    }
    const valid = b.dependsOn.length ? await sql<{ id: string }[]>`select id from tasks where id = any(${b.dependsOn}) and project_id = ${t.project_id}` : [];
    await sql.begin(async (tx) => {
      await tx`delete from task_dependencies where task_id = ${id}`;
      for (const v of valid) await tx`insert into task_dependencies (task_id, depends_on_id) values (${id}, ${v.id})`;
    });
    const [full] = await sql`select ${taskSelect(sql)} from ${taskFrom(sql)} where t.id = ${id}`;
    ctx.hub.publish(`project:${t.project_id}`, 'task.changed', full);
    return full;
  });

  // ------------------------------------------------ Kommentare (Aufgaben, KVP, CAD, Dateien)
  async function checkEntity(u: AuthUser, type: string, id: string) {
    if (type === 'task') return (await loadTask(u, id)).t.project_id;
    if (type === 'cad_item') {
      const [c] = await sql<{ project_id: string }[]>`select project_id from cad_items where id = ${id}`;
      if (!c) throw notFound();
      await projectAccess(sql, u, c.project_id);
      return c.project_id;
    }
    if (type === 'kvp') {
      const [k] = await sql`select 1 from kvp_ideas where id = ${id}`;
      if (!k) throw notFound();
      return null;
    }
    throw badRequest('Unbekannter Typ');
  }

  app.get('/comments/:type/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ type: z.enum(['task', 'cad_item', 'kvp']), id: z.string().uuid() }), req.params);
    await checkEntity(u, p.type, p.id);
    return sql`select c.id, c.body, c.user_id as "userId", us.display_name as "userName", c.created_at as "createdAt"
      from comments c left join users us on us.id = c.user_id
      where c.entity_type = ${p.type} and c.entity_id = ${p.id} order by c.created_at`;
  });

  app.post('/comments/:type/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ type: z.enum(['task', 'cad_item', 'kvp']), id: z.string().uuid() }), req.params);
    const projectId = await checkEntity(u, p.type, p.id);
    const b = parse(z.object({ body: z.string().trim().min(1).max(20000), notify: z.array(z.string().uuid()).max(200).default([]) }), req.body);
    const [c] = await sql`insert into comments (entity_type, entity_id, user_id, body) values (${p.type}, ${p.id}, ${u.id}, ${b.body})
      returning id, body, user_id as "userId", created_at as "createdAt"`;
    const out = { ...c, userName: u.displayName };
    if (projectId) ctx.hub.publish(`project:${projectId}`, 'comment.created', { entityType: p.type, entityId: p.id, comment: out });
    // @Erwähnungen benachrichtigen
    const mentions = [...b.body.matchAll(/@([\w.-]+)/g)].map((m) => m[1]!);
    if (mentions.length || b.notify.length) {
      const users = await sql<{ id: string }[]>`select id from users where (lower(username) = any(${mentions.map((m) => m.toLowerCase())}) or id = any(${b.notify})) and active`;
      await notify(ctx, users.map((x) => x.id), { kind: 'mention', title: `${u.displayName} hat dich erwähnt`, body: b.body.slice(0, 200),
        link: p.type === 'task' && projectId ? `/projects/${projectId}?task=${p.id}` : p.type === 'kvp' ? `/kvp?idea=${p.id}` : undefined }, u.id);
    }
    if (p.type === 'task') {
      const [t] = await sql<{ assignee_id: string | null; created_by: string | null; title: string }[]>`select assignee_id, created_by, title from tasks where id = ${p.id}`;
      const watchers = (await sql<{ user_id: string }[]>`select user_id from task_watchers where task_id = ${p.id}`).map((w) => w.user_id);
      await notify(ctx, [t?.assignee_id, t?.created_by, ...watchers], { kind: 'comment', title: `Kommentar zu „${t?.title}“`, body: b.body.slice(0, 200), link: `/projects/${projectId}?task=${p.id}` }, u.id);
    }
    return out;
  });

  app.delete('/comments/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from comments where id = ${id} and (user_id = ${u.id} or ${u.role === 'admin'})`;
    return { ok: true };
  });
}
