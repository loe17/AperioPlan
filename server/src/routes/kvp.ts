/** KVP-Verbesserungsbox: digitaler Ideenkasten mit Einsparpotenzial, Zuständigkeit und Fotos (Kapitel 12). */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { safeName } from '../services/files';
import { sendStoredFile } from './files';

const STATUS = ['new', 'review', 'accepted', 'implemented', 'rejected'] as const;
const STATUS_LABEL: Record<string, string> = { new: 'Neu', review: 'In Prüfung', accepted: 'Angenommen', implemented: 'Umgesetzt', rejected: 'Abgelehnt' };

export default async function kvpRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  const select = sql`k.id, k.number, k.title, k.description, k.team_id as "teamId", t.name as "teamName", t.icon as "teamIcon",
    k.savings_eur::float as "savingsEur", k.lead_id as "leadId", l.display_name as "leadName", k.status, k.decision_note as "decisionNote",
    k.created_by as "createdBy", c.display_name as "createdByName", k.created_at as "createdAt", k.updated_at as "updatedAt",
    coalesce((select json_agg(json_build_object('id', ph.id, 'name', ph.name) order by ph.created_at) from kvp_photos ph where ph.idea_id = k.id), '[]') as photos,
    (select count(*)::int from comments cm where cm.entity_type = 'kvp' and cm.entity_id = k.id) as "commentCount"`;
  const from = sql`kvp_ideas k left join teams t on t.id = k.team_id left join users l on l.id = k.lead_id left join users c on c.id = k.created_by`;

  app.get('/kvp', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const q = parse(z.object({ status: z.enum(STATUS).optional(), teamId: z.string().uuid().optional(), mine: z.coerce.boolean().optional() }), req.query);
    return sql`select ${select} from ${from} where true
      ${q.status ? sql`and k.status = ${q.status}` : sql``} ${q.teamId ? sql`and k.team_id = ${q.teamId}` : sql``}
      ${q.mine ? sql`and (k.created_by = ${u.id} or k.lead_id = ${u.id})` : sql``}
      order by k.created_at desc`;
  });

  app.get('/kvp/stats', async (req) => {
    requireUser(req);
    const [s] = await sql`select count(*)::int as total, count(*) filter (where status = 'implemented')::int as implemented,
      count(*) filter (where status in ('new', 'review'))::int as open,
      coalesce(sum(savings_eur) filter (where status in ('accepted', 'implemented')), 0)::float as savings from kvp_ideas`;
    return s;
  });

  app.get('/kvp/:id', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const [k] = await sql`select ${select} from ${from} where k.id = ${id}`;
    if (!k) throw notFound();
    return k;
  });

  const body = z.object({
    title: z.string().trim().min(3).max(200),
    description: z.string().default(''),
    teamId: z.string().uuid().nullable().default(null),
    savingsEur: z.number().min(0).nullable().default(null),
    leadId: z.string().uuid().nullable().default(null),
  });

  app.post('/kvp', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(body, req.body);
    let leadId = b.leadId;
    if (!leadId && b.teamId) leadId = (await sql<{ user_id: string }[]>`select user_id from team_members where team_id = ${b.teamId} and is_lead limit 1`)[0]?.user_id ?? null;
    const [k] = await sql<{ id: string; number: number }[]>`insert into kvp_ideas (title, description, team_id, savings_eur, lead_id, created_by)
      values (${b.title}, ${b.description}, ${b.teamId}, ${b.savingsEur}, ${leadId}, ${u.id}) returning id, number`;
    await audit(sql, u, { action: 'kvp.create', entityType: 'kvp', entityId: k!.id, summary: `KVP-Idee #${k!.number} „${b.title}“ eingereicht` });
    await notify(ctx, [leadId], { kind: 'kvp', title: `Neue Verbesserungsidee #${k!.number}`, body: b.title, link: `/kvp?idea=${k!.id}` }, u.id);
    return k;
  });

  app.patch('/kvp/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [k] = await sql<{ created_by: string; lead_id: string | null; status: string; number: number; title: string }[]>`select created_by, lead_id, status, number, title from kvp_ideas where id = ${id}`;
    if (!k) throw notFound();
    const b = parse(patchSchema(body).extend({ status: z.enum(STATUS).optional(), decisionNote: z.string().optional() }), req.body);
    const isLead = u.role === 'admin' || k.lead_id === u.id || u.role === 'teamlead';
    const isOwner = k.created_by === u.id;
    if (!isLead && !(isOwner && k.status === 'new' && !b.status)) throw forbidden('Bearbeiten nur durch Einreicher (solange neu) oder zuständige Teamleitung');
    if ((b.status || b.decisionNote !== undefined) && !isLead) throw forbidden('Den Status setzt die zuständige Teamleitung');
    await sql`update kvp_ideas set title = coalesce(${b.title ?? null}, title), description = coalesce(${b.description ?? null}, description),
      team_id = ${b.teamId === undefined ? sql`team_id` : b.teamId}, savings_eur = ${b.savingsEur === undefined ? sql`savings_eur` : b.savingsEur},
      lead_id = ${b.leadId === undefined ? sql`lead_id` : b.leadId}, status = coalesce(${b.status ?? null}, status),
      decision_note = coalesce(${b.decisionNote ?? null}, decision_note), updated_at = now() where id = ${id}`;
    if (b.status && b.status !== k.status) {
      await audit(sql, u, { action: 'kvp.status', entityType: 'kvp', entityId: id, summary: `KVP #${k.number}: ${STATUS_LABEL[k.status]} → ${STATUS_LABEL[b.status]}` });
      await notify(ctx, [k.created_by], { kind: 'kvp', title: `Ihre Idee #${k.number}: ${STATUS_LABEL[b.status]}`, body: b.decisionNote ?? k.title, link: `/kvp?idea=${id}` }, u.id);
    }
    if (b.leadId && b.leadId !== k.lead_id) await notify(ctx, [b.leadId], { kind: 'kvp', title: `KVP-Idee #${k.number} zugewiesen`, body: k.title, link: `/kvp?idea=${id}` }, u.id);
    return { ok: true };
  });

  app.delete('/kvp/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [k] = await sql<{ created_by: string; status: string }[]>`select created_by, status from kvp_ideas where id = ${id}`;
    if (!k) throw notFound();
    if (u.role !== 'admin' && !(k.created_by === u.id && k.status === 'new')) throw forbidden();
    await sql`delete from kvp_ideas where id = ${id}`;
    return { ok: true };
  });

  app.post('/kvp/:id/photos', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [k] = await sql`select 1 from kvp_ideas where id = ${id}`;
    if (!k) throw notFound();
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (!/^image\//.test(part.mimetype)) throw badRequest('Nur Bilder erlaubt');
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'foto.jpg');
      const path = `KVP/${id}/${Date.now()}_${name}`;
      await storage.write(path, part.file);
      const [ph] = await sql`insert into kvp_photos (idea_id, path, name) values (${id}, ${path}, ${name}) returning id, name`;
      out.push(ph);
    }
    await audit(sql, u, { action: 'kvp.photo', entityType: 'kvp', entityId: id, summary: `${out.length} Foto(s) hinzugefügt` });
    return out;
  });

  app.get('/kvp/photos/:id', async (req, reply) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const [ph] = await sql<{ path: string; name: string }[]>`select path, name from kvp_photos where id = ${id}`;
    if (!ph) throw notFound();
    return sendStoredFile(ctx, reply, ph.path, ph.name, true);
  });

  app.delete('/kvp/photos/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [ph] = await sql<{ path: string; created_by: string }[]>`select ph.path, k.created_by from kvp_photos ph join kvp_ideas k on k.id = ph.idea_id where ph.id = ${id}`;
    if (!ph) throw notFound();
    if (ph.created_by !== u.id && u.role !== 'admin') throw forbidden();
    await sql`delete from kvp_photos where id = ${id}`;
    await storage.remove(ph.path);
    return { ok: true };
  });
}
