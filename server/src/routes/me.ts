import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { visibleProjects } from '../lib/access';

export default async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  // ------------------------------------------------ Benachrichtigungen (Glocke)
  app.get('/notifications', async (req) => {
    const u = requireUser(req);
    return sql`select id, kind, title, body, link, read_at as "readAt", created_at as "createdAt"
      from notifications where user_id = ${u.id} order by created_at desc limit 100`;
  });
  app.post('/notifications/read', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ ids: z.array(z.string().uuid()).optional() }), req.body ?? {});
    if (b.ids?.length) await sql`update notifications set read_at = now() where user_id = ${u.id} and id = any(${b.ids})`;
    else await sql`update notifications set read_at = now() where user_id = ${u.id} and read_at is null`;
    return { ok: true };
  });

  // ------------------------------------------------ Favoriten
  app.get('/favorites', async (req) => {
    const u = requireUser(req);
    return sql`select f.entity_type as "entityType", f.entity_id as "entityId", p.number, p.name, p.icon
      from favorites f join projects p on p.id = f.entity_id and f.entity_type = 'project'
      where f.user_id = ${u.id} and ${visibleProjects(sql, u)} order by p.number`;
  });
  app.put('/favorites/:type/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ type: z.enum(['project']), id: z.string().uuid() }), req.params);
    await sql`insert into favorites (user_id, entity_type, entity_id) values (${u.id}, ${p.type}, ${p.id}) on conflict do nothing`;
    return { ok: true };
  });
  app.delete('/favorites/:type/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ type: z.enum(['project']), id: z.string().uuid() }), req.params);
    await sql`delete from favorites where user_id = ${u.id} and entity_type = ${p.type} and entity_id = ${p.id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Private Notizen
  app.get('/notes', async (req) => {
    const u = requireUser(req);
    return sql`select id, title, body, updated_at as "updatedAt" from private_notes where user_id = ${u.id} order by updated_at desc`;
  });
  app.post('/notes', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ title: z.string().default(''), body: z.string().default('') }), req.body ?? {});
    const [n] = await sql`insert into private_notes (user_id, title, body) values (${u.id}, ${b.title}, ${b.body})
      returning id, title, body, updated_at as "updatedAt"`;
    return n;
  });
  app.patch('/notes/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ title: z.string().optional(), body: z.string().optional() }), req.body);
    await sql`update private_notes set title = coalesce(${b.title ?? null}, title), body = coalesce(${b.body ?? null}, body),
      updated_at = now() where id = ${id} and user_id = ${u.id}`;
    return { ok: true };
  });
  app.delete('/notes/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from private_notes where id = ${id} and user_id = ${u.id}`;
    return { ok: true };
  });
}
