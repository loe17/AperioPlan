import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { notFound } from '../lib/errors';

/** Whiteboard: freie Zeichenfläche mit Haftnotizen, Formen, Linien und Freihand-Strichen */
export default async function whiteboardRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  app.get('/projects/:id/whiteboards', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    return sql`select id, name, updated_at as "updatedAt" from whiteboards where project_id = ${id} order by created_at`;
  });

  app.post('/projects/:id/whiteboards', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id, 'edit');
    const b = parse(z.object({ name: z.string().trim().min(1).default('Whiteboard') }), req.body ?? {});
    const [w] = await sql`insert into whiteboards (project_id, name) values (${id}, ${b.name}) returning id, name`;
    return w;
  });

  app.get('/whiteboards/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [w] = await sql<{ project_id: string }[]>`select id, project_id, name, data, updated_at as "updatedAt" from whiteboards where id = ${id}`;
    if (!w) throw notFound();
    await projectAccess(sql, u, w.project_id);
    return w;
  });

  app.put('/whiteboards/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [w] = await sql<{ project_id: string }[]>`select project_id from whiteboards where id = ${id}`;
    if (!w) throw notFound();
    await projectAccess(sql, u, w.project_id, 'edit');
    const b = parse(z.object({ name: z.string().optional(), data: z.object({ items: z.array(z.record(z.string(), z.unknown())) }).optional() }), req.body);
    const [r] = await sql`update whiteboards set name = coalesce(${b.name ?? null}, name),
      data = ${b.data ? sql.json(b.data as never) : sql`data`}, updated_at = now() where id = ${id} returning updated_at as "updatedAt"`;
    ctx.hub.publish(`project:${w.project_id}`, 'whiteboard.changed', { id, by: u.id, data: b.data, updatedAt: r!.updatedAt }, u.id);
    return { ok: true, updatedAt: r!.updatedAt };
  });

  app.delete('/whiteboards/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [w] = await sql<{ project_id: string }[]>`select project_id from whiteboards where id = ${id}`;
    if (!w) throw notFound();
    await projectAccess(sql, u, w.project_id, 'edit');
    await sql`delete from whiteboards where id = ${id}`;
    return { ok: true };
  });
}
