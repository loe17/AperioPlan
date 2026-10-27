import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { audit } from '../services/audit';

export default async function teamRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  app.get('/teams', async (req) => {
    requireUser(req);
    return sql`select t.id, t.name, t.icon, t.description, t.parent_id as "parentId", t.sort,
      coalesce(json_agg(json_build_object('userId', tm.user_id, 'isLead', tm.is_lead, 'displayName', u.display_name))
        filter (where tm.user_id is not null), '[]') as members
      from teams t left join team_members tm on tm.team_id = t.id left join users u on u.id = tm.user_id
      group by t.id order by t.sort, t.name`;
  });

  const teamBody = z.object({
    name: z.string().trim().min(1),
    icon: z.string().max(40).default('team'),
    description: z.string().default(''),
    parentId: z.string().uuid().nullable().default(null),
    sort: z.number().int().default(0),
  });

  app.post('/teams', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(teamBody, req.body);
    const [t] = await sql`insert into teams (name, icon, description, parent_id, sort)
      values (${b.name}, ${b.icon}, ${b.description}, ${b.parentId}, ${b.sort}) returning id`;
    await audit(sql, u, { action: 'team.create', entityType: 'team', entityId: t!.id, summary: `Team ${b.name} angelegt` });
    return t;
  });

  app.patch('/teams/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(teamBody), req.body);
    await sql`update teams set name = coalesce(${b.name ?? null}, name), icon = coalesce(${b.icon ?? null}, icon),
      description = coalesce(${b.description ?? null}, description), sort = coalesce(${b.sort ?? null}, sort),
      parent_id = ${b.parentId === undefined ? sql`parent_id` : b.parentId} where id = ${id}`;
    await audit(sql, u, { action: 'team.update', entityType: 'team', entityId: id, summary: `Team geändert`, details: b });
    return { ok: true };
  });

  app.delete('/teams/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    await sql`delete from teams where id = ${id}`;
    await audit(sql, u, { action: 'team.delete', entityType: 'team', entityId: id, summary: `Team gelöscht` });
    return { ok: true };
  });

  app.put('/teams/:id/members', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ members: z.array(z.object({ userId: z.string().uuid(), isLead: z.boolean().default(false) })) }), req.body);
    await sql.begin(async (tx) => {
      await tx`delete from team_members where team_id = ${id}`;
      for (const m of b.members) await tx`insert into team_members (team_id, user_id, is_lead) values (${id}, ${m.userId}, ${m.isLead})`;
    });
    await audit(sql, u, { action: 'team.members', entityType: 'team', entityId: id, summary: `Teammitglieder geändert (${b.members.length})` });
    return { ok: true };
  });
}
