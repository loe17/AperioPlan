import type { FastifyInstance } from 'fastify';
import { PROJECT_MODULES } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, requireRole } from '../lib/auth';
import { projectAccess, visibleProjects } from '../lib/access';
import { badRequest } from '../lib/errors';
import { audit } from '../services/audit';
import { allocateProjectNumber, createProjectFolders, normalizeModules } from '../services/projects';

const projectBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().default(''),
  icon: z.string().max(40).default('rocket'),
  parentId: z.string().uuid().nullable().default(null),
  teamId: z.string().uuid().nullable().default(null),
  status: z.enum(['planned', 'active', 'paused', 'done', 'archived']).default('active'),
  visibility: z.enum(['company', 'team', 'members']).default('company'),
  modules: z.array(z.enum(PROJECT_MODULES)).optional(),
  customer: z.string().default(''),
  startDate: z.string().date().nullable().default(null),
  dueDate: z.string().date().nullable().default(null),
  number: z.string().trim().regex(/^[\w-]+$/).optional(),
});

const projectCols = (sql: AppContext['sql']) => sql`p.id, p.number, p.name, p.description, p.icon, p.parent_id as "parentId",
  p.team_id as "teamId", p.status, p.visibility, p.modules, p.customer, p.start_date as "startDate", p.due_date as "dueDate",
  p.folder_path as "folderPath", p.created_at as "createdAt", p.updated_at as "updatedAt"`;

export default async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  app.get('/projects', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({
      status: z.string().optional(), teamId: z.string().uuid().optional(),
      parentId: z.string().optional(), includeArchived: z.coerce.boolean().default(false),
    }), req.query);
    return sql`select ${projectCols(sql)}, t.name as "teamName", t.icon as "teamIcon",
      (select count(*)::int from tasks where project_id = p.id and status <> 'done') as "openTasks",
      (select count(*)::int from tasks where project_id = p.id) as "totalTasks",
      (select count(*)::int from projects c where c.parent_id = p.id) as "childCount",
      exists (select 1 from favorites f where f.user_id = ${u.id} and f.entity_type = 'project' and f.entity_id = p.id) as favorite
      from projects p left join teams t on t.id = p.team_id
      where ${visibleProjects(sql, u)}
      ${q.status ? sql`and p.status = ${q.status}` : q.includeArchived ? sql`` : sql`and p.status <> 'archived'`}
      ${q.teamId ? sql`and p.team_id = ${q.teamId}` : sql``}
      ${q.parentId === 'root' ? sql`and p.parent_id is null` : q.parentId ? sql`and p.parent_id = ${q.parentId}` : sql``}
      order by p.number`;
  });

  app.post('/projects', async (req) => {
    const u = requireRole(req, 'member');
    const b = parse(projectBody, req.body);
    if (b.parentId) await projectAccess(sql, u, b.parentId, 'manage');
    if (b.number && u.role !== 'admin') throw badRequest('Nur Administratoren dürfen Projektnummern frei vergeben');
    const defaults = await ctx.settings.get('defaultModules');
    const project = await sql.begin(async (tx) => {
      const { number, seq, year } = await allocateProjectNumber(tx, ctx, b.parentId, b.number);
      const [p] = await tx<{ id: string; number: string }[]>`insert into projects
        (number, seq, year, name, description, icon, parent_id, team_id, status, visibility, modules, customer, start_date, due_date, created_by)
        values (${number}, ${seq}, ${year}, ${b.name}, ${b.description}, ${b.icon}, ${b.parentId}, ${b.teamId}, ${b.status}, ${b.visibility},
          ${tx.json(normalizeModules(b.modules, defaults))}, ${b.customer}, ${b.startDate}, ${b.dueDate}, ${u.id})
        returning id, number`;
      await tx`insert into project_members (project_id, user_id, role) values (${p!.id}, ${u.id}, 'owner')`;
      await tx`insert into chat_channels (kind, project_id, name) values ('project', ${p!.id}, ${number + ' ' + b.name})`;
      const folder = await createProjectFolders(ctx, tx, p!.id, number, b.name, b.parentId);
      return { ...p!, folderPath: folder };
    });
    await audit(sql, u, { action: 'project.create', entityType: 'project', entityId: project.id, projectId: project.id,
      summary: `Projekt ${project.number} „${b.name}“ angelegt` });
    return project;
  });

  app.get('/projects/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const access = await projectAccess(sql, u, id);
    const [p] = await sql`select ${projectCols(sql)}, p.report, t.name as "teamName", t.icon as "teamIcon",
      exists (select 1 from favorites f where f.user_id = ${u.id} and f.entity_type = 'project' and f.entity_id = p.id) as favorite
      from projects p left join teams t on t.id = p.team_id where p.id = ${id}`;
    const members = await sql`select pm.user_id as "userId", pm.role, u.display_name as "displayName", u.avatar_color as "avatarColor"
      from project_members pm join users u on u.id = pm.user_id where pm.project_id = ${id} order by u.display_name`;
    const children = await sql`select ${projectCols(sql)} from projects p where p.parent_id = ${id} and ${visibleProjects(sql, u)} order by p.number`;
    const parent = p!.parentId ? (await sql`select id, number, name, icon from projects where id = ${p!.parentId}`)[0] ?? null : null;
    const [chat] = await sql`select id from chat_channels where project_id = ${id} and kind = 'project'`;
    const storage = await ctx.settings.get('storage');
    return { ...p, members, children, parent, chatChannelId: chat?.id ?? null, canEdit: access.canEdit, canManage: access.canManage,
      networkPath: storage.networkPath && p!.folderPath ? `${storage.networkPath.replace(/[\\/]$/, '')}\\${String(p!.folderPath).replace(/\//g, '\\')}` : null };
  });

  app.patch('/projects/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id, 'manage');
    const b = parse(patchSchema(projectBody).omit({ number: true, parentId: true }), req.body);
    await sql`update projects set
      name = coalesce(${b.name ?? null}, name), description = coalesce(${b.description ?? null}, description),
      icon = coalesce(${b.icon ?? null}, icon), team_id = ${b.teamId === undefined ? sql`team_id` : b.teamId},
      status = coalesce(${b.status ?? null}, status), visibility = coalesce(${b.visibility ?? null}, visibility),
      modules = ${b.modules ? sql.json(b.modules) : sql`modules`}, customer = coalesce(${b.customer ?? null}, customer),
      start_date = ${b.startDate === undefined ? sql`start_date` : b.startDate},
      due_date = ${b.dueDate === undefined ? sql`due_date` : b.dueDate}, updated_at = now()
      where id = ${id}`;
    await audit(sql, u, { action: 'project.update', entityType: 'project', entityId: id, projectId: id, summary: 'Projekt geändert', details: b });
    ctx.hub.publish(`project:${id}`, 'project.updated', { id });
    return { ok: true };
  });

  app.put('/projects/:id/members', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id, 'manage');
    const b = parse(z.object({ members: z.array(z.object({ userId: z.string().uuid(), role: z.enum(['owner', 'member', 'viewer']) })) }), req.body);
    if (!b.members.some((m) => m.role === 'owner')) throw badRequest('Mindestens ein Projektverantwortlicher wird benötigt');
    await sql.begin(async (tx) => {
      await tx`delete from project_members where project_id = ${id}`;
      for (const m of b.members) await tx`insert into project_members (project_id, user_id, role) values (${id}, ${m.userId}, ${m.role})`;
    });
    await audit(sql, u, { action: 'project.members', entityType: 'project', entityId: id, projectId: id, summary: `Projektmitglieder geändert (${b.members.length})` });
    return { ok: true };
  });

  // ------------------------------------------------ Abschlussbericht
  app.put('/projects/:id/report', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id, 'edit');
    const b = parse(z.object({
      goals: z.string().default(''), result: z.string().default(''), costsPlanned: z.number().nullable().default(null),
      costsActual: z.number().nullable().default(null), lessons: z.string().default(''),
      acceptedBy: z.string().default(''), acceptedAt: z.string().nullable().default(null), notes: z.string().default(''),
    }), req.body);
    await sql`update projects set report = ${sql.json(b)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'project.report', entityType: 'project', entityId: id, projectId: id, summary: 'Abschlussbericht aktualisiert' });
    return { ok: true };
  });

  // ------------------------------------------------ Allgemeine Dokumente (0100-DOK-001)
}
