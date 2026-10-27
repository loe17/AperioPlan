import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { forbidden } from '../lib/errors';

/** Lückenloses Änderungsprotokoll: Wer? Wann? Was? */
export default async function auditRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  app.get('/audit', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({
      projectId: z.string().uuid().optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      userId: z.string().uuid().optional(),
      before: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    else if (u.role !== 'admin') throw forbidden('Das Gesamtprotokoll sehen nur Administratoren');
    return sql`select id::int, at, user_id as "userId", user_name as "userName", action, entity_type as "entityType",
      entity_id as "entityId", project_id as "projectId", summary, details from audit_log
      where true
      ${q.projectId ? sql`and project_id = ${q.projectId}` : sql``}
      ${q.entityType ? sql`and entity_type = ${q.entityType}` : sql``}
      ${q.entityId ? sql`and entity_id = ${q.entityId}` : sql``}
      ${q.userId ? sql`and user_id = ${q.userId}` : sql``}
      ${q.before ? sql`and id < ${q.before}` : sql``}
      order by id desc limit ${q.limit}`;
  });
}
