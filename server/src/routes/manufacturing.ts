/**
 * Fertigung: Arbeitsplätze, Fertigungsaufträge (auch direkt aus einer CAD-Baugruppe mit Stückliste),
 * Arbeitspläne mit Arbeitsgängen, Rückmeldung am Arbeitsplatz (Start/Stopp/Fertig mit Gut- und Ausschussmenge)
 * und Materialentnahme aus dem Lager.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { nextNumber } from '../services/numbers';
import { bookMove } from '../services/warehouse';
import { staffOf, toRow } from '../lib/rows';

const op = z.object({ id: z.string().min(1).max(40).default(() => randomUUID().slice(0, 8)), workcenterId: z.string().uuid().nullable().default(null), name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''), setupMin: z.number().min(0).default(0), minPerUnit: z.number().min(0).default(0),
  status: z.enum(['open', 'running', 'done']).default('open'), qtyDone: z.number().min(0).default(0), qtyScrap: z.number().min(0).default(0), actualMin: z.number().min(0).default(0) });
const bomLine = z.object({ cadItemId: z.string().uuid().nullable().default(null), articleId: z.string().uuid().nullable().default(null), number: z.string().max(100).default(''),
  designation: z.string().max(300), qty: z.number().min(0), unit: z.string().max(20).default('Stk'), procurement: z.enum(['make', 'buy', 'standard']).default('buy'), issued: z.number().min(0).default(0) });
const orderBody = z.object({ title: z.string().trim().min(1).max(300), projectId: z.string().uuid().nullable().default(null), cadItemId: z.string().uuid().nullable().default(null),
  articleId: z.string().uuid().nullable().default(null), qty: z.number().positive().default(1), status: z.enum(['planned', 'released', 'in_progress', 'done', 'cancelled']).default('planned'),
  priority: z.number().int().min(0).max(9).default(0), startDate: z.string().date().nullable().default(null), dueDate: z.string().date().nullable().default(null),
  bom: z.array(bomLine).max(2000).default([]), operations: z.array(op).max(100).default([]), notes: z.string().max(10000).default('') });
type Op = z.infer<typeof op>;

export default async function manufacturingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'manufacturing.changed', {});
  const nextNo = async () => nextNumber(sql, 'mfgOrder', (await ctx.settings.get('numbers')).mfgOrder ?? 'FA-{JJJJ}-{NNNN}', async (n) => (await sql`select 1 from mfg_orders where number = ${n}`).length > 0);

  // ------------------------------------------------ Arbeitsplätze
  app.get('/manufacturing/workcenters', async (req) => {
    staffOf(req);
    return sql`select id, name, hourly_rate::float as "hourlyRate", hours_per_day::float as "hoursPerDay", active from mfg_workcenters order by active desc, name`;
  });
  const wcBody = z.object({ name: z.string().trim().min(1).max(100), hourlyRate: z.number().min(0).default(0), hoursPerDay: z.number().min(0).max(24).default(8), active: z.boolean().default(true) });
  app.post('/manufacturing/workcenters', async (req) => {
    staffOf(req);
    const b = parse(wcBody, req.body);
    const [w] = await sql<{ id: string }[]>`insert into mfg_workcenters ${sql(toRow(sql, b))} returning id`.catch((e: Error) => { throw /unique/.test(e.message) ? badRequest('Diesen Arbeitsplatz gibt es schon.') : e; });
    changed();
    return { id: w!.id };
  });
  app.patch('/manufacturing/workcenters/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const row = toRow(sql, parse(patchSchema(wcBody), req.body));
    if (Object.keys(row).length) await sql`update mfg_workcenters set ${sql(row)} where id = ${id}`;
    changed();
    return { ok: true };
  });

  // ------------------------------------------------ Aufträge
  const cols = sql`o.id, o.number, o.title, o.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", o.cad_item_id as "cadItemId", o.article_id as "articleId",
    o.qty::float as qty, o.qty_done::float as "qtyDone", o.qty_scrap::float as "qtyScrap", o.status, o.priority, o.start_date::text as "startDate", o.due_date::text as "dueDate",
    o.bom, o.operations, o.notes, o.created_at as "createdAt", o.updated_at as "updatedAt", (o.status not in ('done', 'cancelled') and o.due_date < current_date) as overdue`;
  app.get('/manufacturing/orders', async (req) => {
    staffOf(req);
    const q = parse(z.object({ status: z.string().max(20).optional(), projectId: z.string().uuid().optional(), q: z.string().max(100).optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${cols} from mfg_orders o left join projects p on p.id = o.project_id where true
      ${q.status === 'active' ? sql`and o.status not in ('done', 'cancelled')` : q.status ? sql`and o.status = ${q.status}` : sql``}
      ${q.projectId ? sql`and o.project_id = ${q.projectId}` : sql``} ${like ? sql`and (o.number ilike ${like} or o.title ilike ${like} or p.number ilike ${like})` : sql``}
      order by (o.status in ('done', 'cancelled')), o.priority desc, o.due_date nulls last, o.created_at desc limit 1000`;
  });
  app.get('/manufacturing/orders/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [o] = await sql`select ${cols} from mfg_orders o left join projects p on p.id = o.project_id where o.id = ${id}`;
    if (!o) throw notFound('Fertigungsauftrag nicht gefunden');
    const feedback = await sql`select f.id, f.op, f.kind, f.minutes, f.qty_good::float as "qtyGood", f.qty_scrap::float as "qtyScrap", f.note, f.at, u.display_name as "userName"
      from mfg_feedback f left join users u on u.id = f.user_id where f.order_id = ${id} order by f.at desc limit 500`;
    return { ...o, feedback };
  });
  app.post('/manufacturing/orders', async (req) => {
    const u = staffOf(req);
    const b = parse(orderBody, req.body);
    const number = await nextNo();
    const [o] = await sql<{ id: string }[]>`insert into mfg_orders ${sql({ ...toRow(sql, b, ['bom', 'operations']), number, created_by: u.id })} returning id`;
    await audit(sql, u, { action: 'manufacturing.order.create', entityType: 'mfg_order', entityId: o!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: o!.id, number };
  });
  /** Auftrag aus einer Baugruppe der CAD-Bridge: Stückliste aufgelöst, Kaufteile mit Lagerartikel verknüpft */
  app.post('/manufacturing/orders/from-cad', async (req) => {
    const u = staffOf(req);
    const b = parse(z.object({ cadItemId: z.string().uuid(), qty: z.number().positive().default(1), dueDate: z.string().date().nullable().default(null), templateId: z.string().uuid().optional() }), req.body);
    const [root] = await sql<{ id: string; designation: string; project_id: string; base_number: string; type: string }[]>`select id, designation, project_id, base_number, type from cad_items where id = ${b.cadItemId}`;
    if (!root) throw notFound('CAD-Teil nicht gefunden');
    const rows = await sql<{ id: string; total: number; base_number: string; designation: string; procurement: 'make' | 'buy' | 'standard'; type: string; leaf: boolean; article_id: string | null; unit: string | null; article_number: string | null }[]>`
      with recursive down(child_id, total, depth, path) as (
        select child_id, quantity::numeric, 1, array[parent_id, child_id] from cad_references where parent_id = ${b.cadItemId}
        union all
        select r.child_id, down.total * r.quantity, down.depth + 1, down.path || r.child_id from cad_references r join down on r.parent_id = down.child_id
        where not r.child_id = any(down.path) and down.depth < 20)
      select c.id, sum(d.total)::float as total, c.base_number, c.designation, c.procurement, c.type,
        not exists (select 1 from cad_references r where r.parent_id = c.id) as leaf, w.id as article_id, w.unit, w.number as article_number
      from down d join cad_items c on c.id = d.child_id left join wh_articles w on w.cad_item_id = c.id and w.active
      group by c.id, w.id order by c.base_number`;
    // Stückliste: Kauf- und Normteile sowie Eigenfertigungsteile ohne eigene Unterstruktur (Rohteile)
    const bom = rows.filter((r) => r.leaf || r.procurement !== 'make').map((r) => ({ cadItemId: r.id, articleId: r.article_id, number: r.article_number ?? r.base_number, designation: r.designation,
      qty: Math.round(r.total * b.qty * 1000) / 1000, unit: r.unit ?? 'Stk', procurement: r.procurement, issued: 0 }));
    let operations: Op[] = [];
    if (b.templateId) {
      const [t] = await sql<{ operations: Op[] }[]>`select operations from mfg_orders where id = ${b.templateId}`;
      operations = (t?.operations ?? []).map((x) => ({ ...x, status: 'open', qtyDone: 0, qtyScrap: 0, actualMin: 0 }));
    }
    if (!operations.length) operations = [{ id: randomUUID().slice(0, 8), workcenterId: null, name: rows.some((r) => r.type === 'assembly') || root.type === 'assembly' ? 'Montage' : 'Fertigung', description: '', setupMin: 0, minPerUnit: 0, status: 'open', qtyDone: 0, qtyScrap: 0, actualMin: 0 }];
    const number = await nextNo();
    const [o] = await sql<{ id: string }[]>`insert into mfg_orders (number, title, project_id, cad_item_id, qty, due_date, bom, operations, created_by)
      values (${number}, ${`${root.base_number} ${root.designation}`}, ${root.project_id}, ${root.id}, ${b.qty}, ${b.dueDate}, ${sql.json(bom as never)}, ${sql.json(operations as never)}, ${u.id}) returning id`;
    await audit(sql, u, { action: 'manufacturing.order.create', entityType: 'mfg_order', entityId: o!.id, summary: `${number} aus CAD ${root.base_number}` });
    changed();
    return { id: o!.id, number, bomLines: bom.length };
  });
  app.patch('/manufacturing/orders/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(orderBody), req.body);
    const row = toRow(sql, b, ['bom', 'operations']);
    if (Object.keys(row).length) await sql`update mfg_orders set ${sql(row)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'manufacturing.order.update', entityType: 'mfg_order', entityId: id, summary: Object.keys(b).join(', ') });
    changed();
    return { ok: true };
  });
  app.delete('/manufacturing/orders/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [o] = await sql<{ status: string; number: string }[]>`select status, number from mfg_orders where id = ${id}`;
    if (!o) throw notFound();
    if (!['planned', 'cancelled'].includes(o.status)) throw badRequest('Nur geplante oder stornierte Aufträge lassen sich löschen.');
    await sql`delete from mfg_orders where id = ${id}`;
    await audit(sql, u, { action: 'manufacturing.order.delete', entityType: 'mfg_order', entityId: id, summary: o.number });
    changed();
    return { ok: true };
  });

  /** Rückmeldung am Arbeitsplatz */
  app.post('/manufacturing/orders/:id/feedback', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ op: z.number().int().min(0), kind: z.enum(['start', 'stop', 'done']), qtyGood: z.number().min(0).default(0), qtyScrap: z.number().min(0).default(0), note: z.string().max(1000).default('') }), req.body);
    return sql.begin(async (tx) => {
      const [o] = await tx<{ status: string; operations: Op[]; qty: string; number: string }[]>`select status, operations, qty, number from mfg_orders where id = ${id} for update`;
      if (!o) throw notFound();
      if (['done', 'cancelled', 'planned'].includes(o.status)) throw badRequest(o.status === 'planned' ? 'Der Auftrag ist noch nicht freigegeben.' : 'Der Auftrag ist abgeschlossen.');
      const ops = o.operations;
      const cur = ops[b.op];
      if (!cur) throw badRequest('Arbeitsgang nicht gefunden');
      // Laufzeit seit dem letzten Start dieses Benutzers an diesem Arbeitsgang
      let minutes = 0;
      if (b.kind !== 'start') {
        const [last] = await tx<{ kind: string; at: Date }[]>`select kind, at from mfg_feedback where order_id = ${id} and op = ${b.op} and user_id = ${u.id} order by at desc limit 1`;
        if (last?.kind === 'start') minutes = Math.max(0, Math.round((Date.now() - last.at.getTime()) / 60000));
      }
      await tx`insert into mfg_feedback (order_id, op, user_id, kind, minutes, qty_good, qty_scrap, note) values (${id}, ${b.op}, ${u.id}, ${b.kind}, ${minutes}, ${b.qtyGood}, ${b.qtyScrap}, ${b.note})`;
      cur.actualMin = (cur.actualMin ?? 0) + minutes;
      cur.qtyDone = (cur.qtyDone ?? 0) + b.qtyGood;
      cur.qtyScrap = (cur.qtyScrap ?? 0) + b.qtyScrap;
      cur.status = b.kind === 'start' ? 'running' : b.kind === 'done' ? 'done' : 'open';
      let status = o.status === 'released' ? 'in_progress' : o.status;
      const last = ops.length - 1;
      let qtyDone: number | null = null, qtyScrap: number | null = null;
      if (b.op === last) { qtyDone = cur.qtyDone; qtyScrap = ops.reduce((s, x) => s + (x.qtyScrap ?? 0), 0); }
      if (ops.every((x) => x.status === 'done')) status = 'done';
      await tx`update mfg_orders set operations = ${tx.json(ops as never)}, status = ${status}, ${qtyDone !== null ? tx`qty_done = ${qtyDone}, qty_scrap = ${qtyScrap},` : tx``} updated_at = now() where id = ${id}`;
      changed();
      return { ok: true, minutes, status };
    });
  });
  /** Arbeitsvorrat je Arbeitsplatz: freigegebene Aufträge, deren vorheriger Arbeitsgang erledigt ist */
  app.get('/manufacturing/queue', async (req) => {
    staffOf(req);
    const q = parse(z.object({ workcenterId: z.string().uuid().optional() }), req.query);
    const orders = await sql<{ id: string; number: string; title: string; qty: number; due_date: string | null; priority: number; operations: Op[]; project_number: string | null }[]>`
      select o.id, o.number, o.title, o.qty::float as qty, o.due_date::text, o.priority, o.operations, p.number as project_number from mfg_orders o left join projects p on p.id = o.project_id
      where o.status in ('released', 'in_progress') order by o.priority desc, o.due_date nulls last`;
    const out: unknown[] = [];
    for (const o of orders) {
      o.operations.forEach((x, i) => {
        if (x.status === 'done') return;
        if (i > 0 && o.operations[i - 1]!.status !== 'done' && x.status !== 'running') return;
        if (q.workcenterId && x.workcenterId !== q.workcenterId) return;
        out.push({ orderId: o.id, number: o.number, title: o.title, projectNumber: o.project_number, qty: o.qty, dueDate: o.due_date, priority: o.priority, op: i, operation: x });
      });
    }
    return out;
  });
  /** Material aus dem Lager für den Auftrag entnehmen */
  app.post('/manufacturing/orders/:id/issue', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ index: z.number().int().min(0), qty: z.number().positive(), locationId: z.string().uuid(), lot: z.string().max(100).default('') })).min(1).max(500) }), req.body);
    const [o] = await sql<{ bom: z.infer<typeof bomLine>[]; project_id: string | null; number: string }[]>`select bom, project_id, number from mfg_orders where id = ${id}`;
    if (!o) throw notFound();
    for (const l of b.lines) {
      const line = o.bom[l.index];
      if (!line?.articleId) throw badRequest(`Position ${l.index + 1} ist keinem Lagerartikel zugeordnet.`);
      await bookMove(sql, u, { kind: 'issue', articleId: line.articleId, qty: l.qty, fromLocationId: l.locationId, lot: l.lot, projectId: o.project_id, note: `Fertigungsauftrag ${o.number}` });
      line.issued = Math.round(((line.issued ?? 0) + l.qty) * 1000) / 1000;
    }
    await sql`update mfg_orders set bom = ${sql.json(o.bom as never)}, updated_at = now() where id = ${id}`;
    ctx.hub.publish('global', 'warehouse.changed', {});
    changed();
    return { ok: true };
  });
  /** Plantafel: Auslastung je Arbeitsplatz (Vorgabezeit offener Arbeitsgänge) */
  app.get('/manufacturing/load', async (req) => {
    staffOf(req);
    const wcs = await sql<{ id: string; name: string; hours_per_day: number }[]>`select id, name, hours_per_day::float from mfg_workcenters where active order by name`;
    const orders = await sql<{ id: string; number: string; title: string; qty: number; due_date: string | null; operations: Op[] }[]>`select id, number, title, qty::float as qty, due_date::text, operations
      from mfg_orders where status in ('planned', 'released', 'in_progress') order by due_date nulls last`;
    return wcs.map((w) => {
      const ops = orders.flatMap((o) => o.operations.map((x, i) => ({ o, x, i })).filter(({ x }) => x.workcenterId === w.id && x.status !== 'done')
        .map(({ o, x, i }) => ({ orderId: o.id, number: o.number, title: o.title, dueDate: o.due_date, op: i, name: x.name, hours: Math.round(((x.setupMin + x.minPerUnit * Math.max(0, o.qty - x.qtyDone)) / 60) * 10) / 10 })));
      const hours = Math.round(ops.reduce((s, x) => s + x.hours, 0) * 10) / 10;
      return { id: w.id, name: w.name, hoursPerDay: w.hours_per_day, hours, days: w.hours_per_day ? Math.round((hours / w.hours_per_day) * 10) / 10 : null, ops };
    });
  });
}
