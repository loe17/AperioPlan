/**
 * Änderungsmanagement: Änderungsanträge mit betroffenen Teilen (CAD, PCB, Lagerartikel), Auswirkungen,
 * Prüfung durch mehrere Freigeber, Kommentarverlauf und Umsetzung.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { staffOf, toRow } from '../lib/rows';
import { Pdf } from '../lib/pdf';

const item = z.object({ type: z.enum(['cad', 'pcb', 'article', 'other']), id: z.string().uuid().nullable().default(null), number: z.string().max(100).default(''),
  designation: z.string().max(300).default(''), revision: z.number().int().nullable().default(null), action: z.enum(['change', 'new', 'obsolete']).default('change'), note: z.string().max(1000).default('') });
const changeBody = z.object({
  title: z.string().trim().min(1).max(300), reason: z.string().max(10000).default(''), description: z.string().max(20000).default(''),
  kind: z.enum(['change', 'deviation', 'new']).default('change'), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  projectId: z.string().uuid().nullable().default(null), items: z.array(item).max(500).default([]),
  impact: z.object({ stock: z.enum(['use', 'rework', 'scrap', 'none']).default('use'), cost: z.number().nullable().default(null), production: z.string().max(2000).default(''), customer: z.string().max(2000).default(''), notes: z.string().max(5000).default('') }).default({ stock: 'use', cost: null, production: '', customer: '', notes: '' }),
  approverIds: z.array(z.string().uuid()).max(20).default([]), effectiveDate: z.string().date().nullable().default(null), ownerId: z.string().uuid().nullable().default(null),
});
interface Approver { userId: string; decision: 'approve' | 'reject' | null; at: string | null; comment: string }

export const PLM_STATUS: Record<string, string> = { draft: 'Entwurf', review: 'in Prüfung', approved: 'freigegeben', rejected: 'abgelehnt', implemented: 'umgesetzt', cancelled: 'zurückgezogen' };

export default async function plmRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'plm.changed', {});
  const cols = sql`c.id, c.number, c.title, c.reason, c.description, c.kind, c.priority, c.status, c.project_id as "projectId", p.number as "projectNumber", p.name as "projectName",
    c.items, c.impact, c.approvers, c.effective_date::text as "effectiveDate", c.requested_by as "requestedBy", rq.display_name as "requestedByName", c.owner_id as "ownerId",
    ow.display_name as "ownerName", c.decided_at as "decidedAt", c.implemented_at as "implementedAt", c.created_at as "createdAt", c.updated_at as "updatedAt"`;
  const from = sql`plm_changes c left join projects p on p.id = c.project_id left join users rq on rq.id = c.requested_by left join users ow on ow.id = c.owner_id`;
  const load = async (id: string) => {
    const [c] = await sql<any[]>`select ${cols} from ${from} where c.id = ${id}`;
    if (!c) throw notFound('Änderungsantrag nicht gefunden');
    return c;
  };

  app.get('/plm/changes', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ status: z.string().max(20).optional(), mine: z.coerce.boolean().optional(), q: z.string().max(100).optional(), itemId: z.string().uuid().optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${cols} from ${from} where true
      ${q.status === 'open' ? sql`and c.status in ('draft', 'review', 'approved')` : q.status ? sql`and c.status = ${q.status}` : sql``}
      ${q.mine ? sql`and (c.requested_by = ${u.id} or c.owner_id = ${u.id} or c.approvers @> ${sql.json([{ userId: u.id }] as never)})` : sql``}
      ${like ? sql`and (c.number ilike ${like} or c.title ilike ${like} or c.items::text ilike ${like})` : sql``}
      ${q.itemId ? sql`and c.items @> ${sql.json([{ id: q.itemId }] as never)}` : sql``}
      order by (c.status in ('implemented', 'rejected', 'cancelled')), c.created_at desc limit 1000`;
  });
  app.get('/plm/changes/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const c = await load(id);
    const comments = await sql`select m.id, m.body, m.decision, m.created_at as "createdAt", u.display_name as "userName", m.user_id as "userId" from plm_comments m left join users u on u.id = m.user_id
      where m.change_id = ${id} order by m.created_at`;
    return { ...c, comments };
  });
  app.post('/plm/changes', async (req) => {
    const u = staffOf(req);
    const b = parse(changeBody, req.body);
    const number = await nextNumber(sql, 'change', (await ctx.settings.get('numbers')).change ?? 'AE-{JJJJ}-{NNN}', async (n) => (await sql`select 1 from plm_changes where number = ${n}`).length > 0);
    const { approverIds, ...rest } = b;
    const approvers: Approver[] = approverIds.map((userId) => ({ userId, decision: null, at: null, comment: '' }));
    const [c] = await sql<{ id: string }[]>`insert into plm_changes ${sql({ ...toRow(sql, { ...rest, approvers, ownerId: b.ownerId ?? u.id }, ['items', 'impact', 'approvers']), number, requested_by: u.id })} returning id`;
    await audit(sql, u, { action: 'plm.change.create', entityType: 'plm_change', entityId: c!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: c!.id, number };
  });
  app.patch('/plm/changes/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(changeBody), req.body);
    const c = await load(id);
    if (!['draft', 'rejected'].includes(c.status) && (b.items || b.description || b.reason)) throw badRequest('In der Prüfung lässt sich der Inhalt nicht mehr ändern. Bitte zuerst zurück in den Entwurf.');
    const { approverIds, ...rest } = b;
    const row = toRow(sql, rest, ['items', 'impact']);
    if (approverIds) {
      const old = c.approvers as Approver[];
      row.approvers = sql.json(approverIds.map((userId) => old.find((a) => a.userId === userId) ?? { userId, decision: null, at: null, comment: '' }) as never);
    }
    if (Object.keys(row).length) await sql`update plm_changes set ${sql(row)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'plm.change.update', entityType: 'plm_change', entityId: id, summary: `${c.number}: ${Object.keys(b).join(', ')}` });
    changed();
    return { ok: true };
  });
  /** Zur Prüfung geben: Entscheidungen zurücksetzen und Prüfer benachrichtigen */
  app.post('/plm/changes/:id/submit', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const c = await load(id);
    if (!['draft', 'rejected'].includes(c.status)) throw badRequest('Der Antrag ist schon in Prüfung.');
    const approvers = (c.approvers as Approver[]).map((a) => ({ ...a, decision: null, at: null, comment: '' }));
    if (!approvers.length) throw badRequest('Bitte mindestens einen Prüfer auswählen.');
    if (!c.items.length && c.kind !== 'new') throw badRequest('Bitte die betroffenen Teile angeben.');
    await sql`update plm_changes set status = 'review', approvers = ${sql.json(approvers as never)}, decided_at = null, updated_at = now() where id = ${id}`;
    await notify(ctx, approvers.map((a) => a.userId), { kind: 'plm.review', title: `Änderungsantrag zur Prüfung: ${c.title}`, body: c.number, link: `/plm?change=${id}` }, u.id);
    await audit(sql, u, { action: 'plm.change.submit', entityType: 'plm_change', entityId: id, summary: `${c.number} zur Prüfung` });
    changed();
    return { ok: true };
  });
  app.post('/plm/changes/:id/decide', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(5000).default('') }), req.body);
    const c = await load(id);
    if (c.status !== 'review') throw badRequest('Der Antrag ist nicht in Prüfung.');
    const approvers = c.approvers as Approver[];
    const me = approvers.find((a) => a.userId === u.id);
    if (!me) throw forbidden('Du bist für diesen Antrag nicht als Prüfer eingetragen.');
    if (b.decision === 'reject' && !b.comment.trim()) throw badRequest('Bitte die Ablehnung begründen.');
    Object.assign(me, { decision: b.decision, at: new Date().toISOString(), comment: b.comment });
    const status = approvers.some((a) => a.decision === 'reject') ? 'rejected' : approvers.every((a) => a.decision === 'approve') ? 'approved' : 'review';
    await sql`update plm_changes set approvers = ${sql.json(approvers as never)}, status = ${status}, decided_at = ${status === 'review' ? null : sql`now()`}, updated_at = now() where id = ${id}`;
    await sql`insert into plm_comments (change_id, user_id, body, decision) values (${id}, ${u.id}, ${b.comment || (b.decision === 'approve' ? 'Freigegeben' : 'Abgelehnt')}, ${b.decision})`;
    if (status !== 'review') await notify(ctx, [c.requestedBy, c.ownerId], { kind: 'plm.decision', title: `Änderungsantrag ${PLM_STATUS[status]}: ${c.title}`, body: c.number, link: `/plm?change=${id}` }, u.id);
    await audit(sql, u, { action: `plm.change.${b.decision}`, entityType: 'plm_change', entityId: id, summary: `${c.number} ${b.decision === 'approve' ? 'freigegeben' : 'abgelehnt'}` });
    changed();
    return { ok: true, status };
  });
  app.post('/plm/changes/:id/status', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ status: z.enum(['draft', 'implemented', 'cancelled']) }), req.body);
    const c = await load(id);
    if (b.status === 'implemented' && c.status !== 'approved') throw badRequest('Umsetzen lässt sich nur ein freigegebener Antrag.');
    if (b.status === 'draft' && !['review', 'rejected', 'cancelled'].includes(c.status)) throw badRequest('Zurück in den Entwurf geht nur aus Prüfung, Ablehnung oder Rückzug.');
    if (u.role !== 'admin' && u.id !== c.ownerId && u.id !== c.requestedBy) throw forbidden('Nur Antragsteller, Verantwortlicher oder Administrator.');
    await sql`update plm_changes set status = ${b.status}, implemented_at = ${b.status === 'implemented' ? sql`now()` : null}, updated_at = now() where id = ${id}`;
    if (b.status === 'implemented') await notify(ctx, [c.requestedBy, ...(c.approvers as Approver[]).map((a) => a.userId)], { kind: 'plm.done', title: `Änderung umgesetzt: ${c.title}`, body: c.number, link: `/plm?change=${id}` }, u.id);
    await audit(sql, u, { action: 'plm.change.status', entityType: 'plm_change', entityId: id, summary: `${c.number} → ${PLM_STATUS[b.status]}` });
    changed();
    return { ok: true };
  });
  app.post('/plm/changes/:id/comments', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
    const c = await load(id);
    await sql`insert into plm_comments (change_id, user_id, body) values (${id}, ${u.id}, ${b.body})`;
    await notify(ctx, [c.requestedBy, c.ownerId, ...(c.approvers as Approver[]).map((a) => a.userId)], { kind: 'plm.comment', title: `Kommentar zu ${c.number}`, body: b.body.slice(0, 140), link: `/plm?change=${id}` }, u.id);
    changed();
    return { ok: true };
  });
  app.delete('/plm/changes/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const c = await load(id);
    if (c.status !== 'draft') throw badRequest('Nur Entwürfe lassen sich löschen – sonst „zurückziehen“.');
    if (u.role !== 'admin' && u.id !== c.requestedBy) throw forbidden();
    await sql`delete from plm_changes where id = ${id}`;
    changed();
    return { ok: true };
  });

  /** Teile suchen: CAD-Teile, Leiterplatten, Lagerartikel */
  app.get('/plm/items', async (req) => {
    staffOf(req);
    const q = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    const like = `%${q.q}%`;
    const { installed } = await ctx.settings.get('apps');
    const cad = installed.includes('cad') ? await sql`select 'cad' as type, id, base_number as number, designation, revision, state from cad_items where (base_number ilike ${like} or designation ilike ${like}) and type <> 'drawing' order by base_number limit 20` : [];
    const pcb = installed.includes('pcb') ? await sql`select 'pcb' as type, id, number, designation, revision, state from pcb_boards where number ilike ${like} or designation ilike ${like} order by number limit 10` : [];
    const art = installed.includes('warehouse') ? await sql`select 'article' as type, id, number, name as designation, null::int as revision, null as state from wh_articles where number ilike ${like} or name ilike ${like} order by number limit 10` : [];
    return [...cad, ...pcb, ...art];
  });

  app.get('/plm/changes/:id/pdf', async (req, reply) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const c = await load(id);
    const names = new Map((await sql<{ id: string; display_name: string }[]>`select id, display_name from users where id = any(${(c.approvers as Approver[]).map((a) => a.userId)})`).map((x) => [x.id, x.display_name]));
    const company = (await ctx.settings.get('company')).name;
    const pdf = new Pdf(`Änderungsantrag ${c.number}`, company);
    pdf.paragraph(`Änderungsantrag ${c.number}`, { size: 16, bold: true, gap: 4 });
    pdf.paragraph(c.title, { size: 12, gap: 10 });
    const d = (v: string | null) => (v ? new Date(v.length === 10 ? `${v}T12:00:00` : v).toLocaleDateString('de-DE') : '–');
    pdf.table([{ label: '', width: 130 }, { label: '', width: 365 }], [
      ['Art', { change: 'Änderung', deviation: 'Abweichungsgenehmigung', new: 'Neuteil' }[c.kind as string] ?? c.kind], ['Status', PLM_STATUS[c.status] ?? c.status],
      ['Projekt', c.projectNumber ? `${c.projectNumber} ${c.projectName}` : '–'], ['Antragsteller', `${c.requestedByName ?? '–'} am ${d(c.createdAt)}`], ['Verantwortlich', c.ownerName ?? '–'], ['Gültig ab', d(c.effectiveDate)],
    ]);
    for (const [label, text] of [['Grund', c.reason], ['Beschreibung', c.description]] as const) if (text) { pdf.paragraph(label, { bold: true, gap: 2 }); pdf.paragraph(text, { gap: 8 }); }
    if (c.items.length) {
      pdf.paragraph('Betroffene Teile', { bold: true, gap: 4 });
      pdf.table([{ label: 'Nummer', width: 120 }, { label: 'Benennung', width: 215 }, { label: 'Stand', width: 45 }, { label: 'Maßnahme', width: 115 }],
        c.items.map((i: any) => [i.number, i.designation, i.revision ?? '', { change: 'ändern', new: 'neu', obsolete: 'auslaufen lassen' }[i.action as string] ?? i.action]));
    }
    const imp = c.impact;
    pdf.paragraph('Auswirkungen', { bold: true, gap: 2 });
    pdf.paragraph([`Bestand: ${{ use: 'aufbrauchen', rework: 'nacharbeiten', scrap: 'verschrotten', none: 'keiner' }[imp.stock as string] ?? imp.stock}`, imp.cost !== null ? `Kosten: ${Number(imp.cost).toLocaleString('de-DE')} €` : '', imp.production ? `Fertigung: ${imp.production}` : '', imp.customer ? `Kunde: ${imp.customer}` : '', imp.notes].filter(Boolean).join('\n'), { gap: 8 });
    pdf.paragraph('Freigabe', { bold: true, gap: 4 });
    pdf.table([{ label: 'Prüfer', width: 160 }, { label: 'Entscheidung', width: 90 }, { label: 'Datum', width: 70 }, { label: 'Bemerkung', width: 175 }],
      (c.approvers as Approver[]).map((a) => [names.get(a.userId) ?? '–', a.decision === 'approve' ? 'freigegeben' : a.decision === 'reject' ? 'abgelehnt' : 'offen', d(a.at), a.comment]));
    pdf.footer((p, n) => `${company} · ${c.number} · Seite ${p} von ${n}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${c.number}.pdf"`);
    return reply.send(pdf.toBuffer());
  });
}
