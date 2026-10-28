import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { visibleProjects } from '../lib/access';

/** Globale Blitzsuche (Strg + K): Projekte, Aufgaben, Baugruppen/Teile, Dateien, Mitarbeiter, KVP */
export default async function searchRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  app.get('/search', async (req) => {
    const u = requireUser(req);
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const taskNo = /^p?(\d+)$/i.exec(q)?.[1];

    const [projects, tasks, cad, files, users, kvp, knowledge] = await Promise.all([
      sql`select p.id, p.number, p.name, p.icon from projects p
        where (p.number ilike ${like} or p.name ilike ${like} or p.customer ilike ${like}) and ${visibleProjects(sql, u)}
        order by p.number limit 8`,
      sql`select t.id, t.number, t.title, t.status, p.id as "projectId", p.number as "projectNumber" from tasks t join projects p on p.id = t.project_id
        where (t.title ilike ${like} ${taskNo ? sql`or t.number = ${Number(taskNo)}` : sql``}) and ${visibleProjects(sql, u)}
        order by t.updated_at desc limit 8`,
      sql`select c.id, c.base_number as "baseNumber", c.revision, c.designation, c.type, c.state, p.id as "projectId"
        from cad_items c join projects p on p.id = c.project_id
        where (c.base_number ilike ${like} or c.designation ilike ${like} or c.properties::text ilike ${like}) and ${visibleProjects(sql, u)}
        order by c.base_number limit 8`,
      sql`select f.id, f.name, f.path, p.id as "projectId" from files f join projects p on p.id = f.project_id
        where f.name ilike ${like} and ${visibleProjects(sql, u)} order by f.updated_at desc limit 8`,
      u.role === 'guest' ? [] : sql`select id, display_name as "displayName", username, email from users
        where active and role <> 'guest' and (display_name ilike ${like} or username ilike ${like} or email ilike ${like}) limit 6`,
      u.role === 'guest' ? [] : sql`select id, number, title, status from kvp_ideas where title ilike ${like} or description ilike ${like} order by created_at desc limit 5`,
      u.role === 'guest' || !u.tools.includes('knowledge') ? [] : sql`select a.id, a.title, a.icon from kb_articles a join kb_articles r on r.id = a.root_id
        where a.archived_at is null and (a.title ilike ${like} or a.text ilike ${like})
          and (a.scope = 'workspace' or r.owner_id = ${u.id} or (a.scope = 'shared' and exists (select 1 from kb_members m where m.article_id = a.root_id and m.user_id = ${u.id})))
        order by (a.title ilike ${like}) desc, a.updated_at desc limit 6`,
    ]);
    return { projects, tasks, cad, files, users, kvp, knowledge };
  });
}
