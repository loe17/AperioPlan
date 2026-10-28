/**
 * Einkauf: je Projekt alle zu beschaffenden Teile – automatisch aus der CAD-Stückliste (Kauf- und Normteile)
 * plus eigene Positionen. Status von „Offen“ bis „Geliefert“, Bestellungen mit Nummer und PDF, Wareneingang,
 * Übersicht über alle Projekte und Benachrichtigungen (Liefertermin, Teil nach Bestellung geändert).
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { writeXlsx } from '../lib/xlsx';
import { Pdf, eur, num } from '../lib/pdf';

const STATUSES = ['open', 'requested', 'ordered', 'confirmed', 'partial', 'delivered', 'cancelled'] as const;
export const PURCHASE_STATUS_LABEL: Record<string, string> = { open: 'Offen', requested: 'Angefragt', ordered: 'Bestellt', confirmed: 'Bestätigt', partial: 'Teilweise geliefert', delivered: 'Geliefert', cancelled: 'Storniert' };

const itemBody = z.object({
  number: z.string().max(80).default(''),
  designation: z.string().trim().min(1).max(300),
  manufacturer: z.string().max(120).default(''),
  manufacturerNo: z.string().max(120).default(''),
  supplierId: z.string().uuid().nullable().default(null),
  supplierOrderNo: z.string().max(120).default(''),
  qty: z.number().min(0).default(1),
  unit: z.string().max(20).default('Stk'),
  unitPrice: z.number().min(0).nullable().default(null),
  discount: z.number().min(0).max(100).default(0),
  costCenter: z.string().max(60).default(''),
  note: z.string().max(5000).default(''),
  status: z.enum(STATUSES).default('open'),
  requestedAt: z.string().date().nullable().default(null),
  orderedAt: z.string().date().nullable().default(null),
  plannedDelivery: z.string().date().nullable().default(null),
  confirmedDelivery: z.string().date().nullable().default(null),
  attachments: z.array(z.object({ fileId: z.string().uuid(), name: z.string(), size: z.number() })).default([]),
});

const itemCols = (sql: AppContext['sql']) => sql`i.id, i.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", i.source, i.cad_item_id as "cadItemId",
  i.revision_at_order as "revisionAtOrder", c.revision as "cadRevision", i.revision_warning as "revisionWarning", i.number, i.designation, i.manufacturer,
  i.manufacturer_no as "manufacturerNo", i.supplier_id as "supplierId", s.name as "supplierName", i.supplier_order_no as "supplierOrderNo",
  i.qty::float as qty, i.unit, i.unit_price::float as "unitPrice", i.discount::float as discount,
  (i.qty * coalesce(i.unit_price, 0) * (1 - i.discount / 100))::float as total, i.cost_center as "costCenter", i.note, i.status,
  i.requested_at::text as "requestedAt", i.ordered_at::text as "orderedAt", i.planned_delivery::text as "plannedDelivery",
  i.confirmed_delivery::text as "confirmedDelivery", i.delivered_qty::float as "deliveredQty", i.delivered_at::text as "deliveredAt",
  i.order_id as "orderId", o.number as "orderNumber", i.attachments, i.sort, i.created_at as "createdAt", i.updated_at as "updatedAt",
  coalesce(i.confirmed_delivery, i.planned_delivery) < current_date and i.status in ('ordered', 'confirmed', 'partial') as overdue`;
const itemFrom = (sql: AppContext['sql']) => sql`purchase_items i join projects p on p.id = i.project_id left join crm_accounts s on s.id = i.supplier_id
  left join cad_items c on c.id = i.cad_item_id left join purchase_orders o on o.id = i.order_id`;

/** Wer bekommt Einkaufs-Hinweise? Alle mit dem Werkzeug „Einkauf“ (bzw. Administratoren) */
export async function purchasingUsers(ctx: AppContext): Promise<string[]> {
  const rows = await ctx.sql<{ id: string; tools: string[] | null; role: string; dept_tools: string[] | null }[]>`select u.id, u.tools, u.role, t.default_tools as dept_tools
    from users u left join teams t on t.id = u.department_id where u.active and u.deleted_at is null and u.role <> 'guest'`;
  const explicit = rows.filter((r) => (r.tools ?? r.dept_tools)?.includes('purchasing'));
  return (explicit.length ? explicit : rows.filter((r) => r.role === 'admin')).map((r) => r.id);
}

/**
 * Kauf- und Normteile aus der CAD-Bridge übernehmen. Menge = Gesamtmenge über alle Baugruppen des Projekts.
 * Neue Teile kommen als „Offen“ dazu; bei offenen Positionen wird die Menge aktualisiert.
 */
export async function syncFromCad(ctx: AppContext, projectId: string, userId: string | null) {
  const { sql } = ctx;
  const parts = await sql<{ id: string; number: string; designation: string; properties: Record<string, string>; procurement: string }[]>`
    select c.id, c.base_number || '-' || lpad(c.revision::text, 2, '0') as number, c.designation, c.properties, c.procurement
    from cad_items c where c.project_id = ${projectId} and c.type <> 'drawing' and c.procurement in ('buy', 'standard') and c.state <> 'obsolete'`;
  if (!parts.length) return { added: 0, updated: 0 };
  // Gesamtmengen: von allen obersten Baugruppen ausgehend die Mengen multiplizieren
  const totals = await sql<{ child_id: string; total: number }[]>`with recursive tops as (
      select c.id from cad_items c where c.project_id = ${projectId} and c.type = 'assembly'
        and not exists (select 1 from cad_references r join cad_items pc on pc.id = r.parent_id where r.child_id = c.id and pc.project_id = ${projectId})),
    down(child_id, total, depth, path) as (
      select r.child_id, r.quantity::numeric, 1, array[r.parent_id, r.child_id] from cad_references r where r.parent_id in (select id from tops)
      union all
      select r.child_id, down.total * r.quantity, down.depth + 1, down.path || r.child_id from cad_references r join down on r.parent_id = down.child_id
        where not r.child_id = any(down.path) and down.depth < 20)
    select child_id, sum(total)::float as total from down group by child_id`;
  const qtyOf = new Map(totals.map((t) => [t.child_id, t.total]));
  let added = 0, updated = 0;
  for (const p of parts) {
    const qty = qtyOf.get(p.id) ?? 1;
    const [cur] = await sql<{ id: string; status: string; qty: string }[]>`select id, status, qty from purchase_items where project_id = ${projectId} and cad_item_id = ${p.id} and status <> 'cancelled'`;
    if (!cur) {
      await sql`insert into purchase_items (project_id, source, cad_item_id, number, designation, manufacturer, manufacturer_no, qty, created_by, sort)
        values (${projectId}, 'cad', ${p.id}, ${p.number}, ${p.designation}, ${p.properties?.Hersteller ?? ''}, ${p.properties?.Herstellernummer ?? p.properties?.Norm ?? ''}, ${qty}, ${userId}, ${Date.now() / 1000})`;
      added++;
    } else if (cur.status === 'open' && Number(cur.qty) !== qty) {
      await sql`update purchase_items set qty = ${qty}, number = ${p.number}, designation = ${p.designation}, updated_at = now() where id = ${cur.id}`;
      updated++;
    } else if (cur.status !== 'open' && Number(cur.qty) < qty) {
      await sql`update purchase_items set note = trim(note || ${`\nMenge laut Stückliste jetzt ${num(qty)} (bestellt ${num(Number(cur.qty))})`}), updated_at = now() where id = ${cur.id}`;
      updated++;
    }
  }
  if (added || updated) ctx.hub.publish(`project:${projectId}`, 'purchasing.changed', {});
  return { added, updated };
}

/** Wird von der CAD-Bridge aufgerufen, wenn ein bereits bestelltes Teil einen neuen Versionsstand bekommt */
export async function warnRevisedPart(ctx: AppContext, cadItemId: string, newNumber: string, reason: string, by: string) {
  const rows = await ctx.sql<{ id: string; project_id: string; designation: string; pnum: string }[]>`update purchase_items i set revision_warning = true, updated_at = now()
    from projects p where p.id = i.project_id and i.cad_item_id = ${cadItemId} and i.status in ('requested', 'ordered', 'confirmed', 'partial')
    returning i.id, i.project_id, i.designation, p.number as pnum`;
  for (const r of rows) {
    await notify(ctx, await purchasingUsers(ctx), { kind: 'purchasing.revised', title: `Achtung: bestelltes Teil geändert – ${newNumber}`,
      body: `${r.pnum} · ${r.designation}\nGrund: ${reason}\nBitte beim Lieferanten prüfen, ob noch der alte Stand geliefert wird.`, link: `/projects/${r.project_id}?tab=purchasing` }, by);
  }
}

/** Liefertermine: 3 Tage vorher und bei Überschreitung (einmal täglich) */
export async function deliveryReminders(ctx: AppContext) {
  const rows = await ctx.sql<{ id: string; project_id: string; designation: string; due: string; pnum: string; created_by: string | null; overdue: boolean }[]>`
    select i.id, i.project_id, i.designation, coalesce(i.confirmed_delivery, i.planned_delivery)::text as due, p.number as pnum, i.created_by,
      coalesce(i.confirmed_delivery, i.planned_delivery) < current_date as overdue
    from purchase_items i join projects p on p.id = i.project_id
    where i.status in ('ordered', 'confirmed', 'partial') and coalesce(i.confirmed_delivery, i.planned_delivery) <= current_date + 3
      and (i.reminded_on is null or i.reminded_on < current_date)
      and (coalesce(i.confirmed_delivery, i.planned_delivery) = current_date + 3 or coalesce(i.confirmed_delivery, i.planned_delivery) < current_date)`;
  if (!rows.length) return;
  const buyers = await purchasingUsers(ctx);
  for (const r of rows) {
    await ctx.sql`update purchase_items set reminded_on = current_date where id = ${r.id}`;
    await notify(ctx, [...buyers, r.created_by], { kind: 'purchasing.due', title: r.overdue ? `Lieferung überfällig: ${r.designation}` : `Lieferung in 3 Tagen: ${r.designation}`,
      body: `${r.pnum} · Termin ${new Date(r.due).toLocaleDateString('de-DE')}`, link: `/projects/${r.project_id}?tab=purchasing` });
  }
}

/** Wareneingang zu einer Einkaufsposition buchen (auch aus dem Lager heraus) */
export async function bookPurchaseReceipt(ctx: AppContext, u: AuthUser, id: string, b: { qty: number; receivedAt?: string; note: string }) {
  const { sql } = ctx;
  const [cur] = await sql<{ id: string; project_id: string; designation: string; qty: string; delivered_qty: string; created_by: string | null }[]>`
    select id, project_id, designation, qty, delivered_qty, created_by from purchase_items where id = ${id}`;
  if (!cur) throw notFound('Position nicht gefunden');
  await projectAccess(sql, u, cur.project_id, 'write');
  const delivered = Number(cur.delivered_qty) + b.qty;
  const status = delivered >= Number(cur.qty) ? 'delivered' : 'partial';
  const day = b.receivedAt ?? new Date().toISOString().slice(0, 10);
  await sql`insert into purchase_receipts (item_id, qty, received_at, note, user_id) values (${id}, ${b.qty}, ${day}, ${b.note}, ${u.id})`;
  await sql`update purchase_items set delivered_qty = ${delivered}, status = ${status}, delivered_at = ${status === 'delivered' ? day : null},
    updated_at = now() where id = ${id}`;
  const [p] = await sql<{ number: string }[]>`select number from projects where id = ${cur.project_id}`;
  const leads = await sql<{ user_id: string }[]>`select user_id from project_members where project_id = ${cur.project_id} and role = 'owner'`;
  await notify(ctx, [...leads.map((l) => l.user_id), cur.created_by], { kind: 'purchasing.received', title: `${status === 'delivered' ? 'Geliefert' : 'Teillieferung'}: ${cur.designation}`,
    body: `${p!.number} · ${num(b.qty)} angekommen${status === 'partial' ? ` (insgesamt ${num(delivered)} von ${num(Number(cur.qty))})` : ''}`, link: `/projects/${cur.project_id}?tab=purchasing` }, u.id);
  await audit(sql, u, { action: 'purchasing.receipt', entityType: 'purchase_item', entityId: id, projectId: cur.project_id, summary: `Wareneingang ${cur.designation}: ${num(b.qty)}` });
  ctx.hub.publish(`project:${cur.project_id}`, 'purchasing.changed', {});
  return { ok: true, status };
}

export default async function purchasingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const cols = itemCols(sql), from = itemFrom(sql);

  async function loadItem(u: AuthUser, id: string) {
    const [i] = await sql<{ id: string; project_id: string; status: string; designation: string; qty: string; delivered_qty: string; cad_item_id: string | null; created_by: string | null }[]>`
      select id, project_id, status, designation, qty, delivered_qty, cad_item_id, created_by from purchase_items where id = ${id}`;
    if (!i) throw notFound('Position nicht gefunden');
    await projectAccess(sql, u, i.project_id, 'write');
    return i;
  }

  app.get('/purchasing/projects/:id/items', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    return sql`select ${cols} from ${from} where i.project_id = ${id} order by i.status = 'cancelled', i.sort, i.created_at`;
  });

  app.post('/purchasing/projects/:id/sync', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id, 'write');
    return syncFromCad(ctx, id, u.id);
  });

  app.post('/purchasing/projects/:id/items', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id, 'write');
    const b = parse(itemBody, req.body);
    const [i] = await sql<{ id: string }[]>`insert into purchase_items (project_id, number, designation, manufacturer, manufacturer_no, supplier_id, supplier_order_no, qty, unit, unit_price, discount,
        cost_center, note, status, requested_at, ordered_at, planned_delivery, confirmed_delivery, attachments, created_by, sort)
      values (${id}, ${b.number}, ${b.designation}, ${b.manufacturer}, ${b.manufacturerNo}, ${b.supplierId}, ${b.supplierOrderNo}, ${b.qty}, ${b.unit}, ${b.unitPrice}, ${b.discount},
        ${b.costCenter}, ${b.note}, ${b.status}, ${b.requestedAt}, ${b.orderedAt}, ${b.plannedDelivery}, ${b.confirmedDelivery}, ${sql.json(b.attachments)}, ${u.id}, ${Date.now() / 1000}) returning id`;
    ctx.hub.publish(`project:${id}`, 'purchasing.changed', {});
    return i;
  });

  /** Status-Folge: das Datum zum Status wird automatisch gesetzt */
  function statusDates(status: string | undefined) {
    if (status === 'requested') return sql`requested_at = coalesce(requested_at, current_date),`;
    if (status === 'ordered') return sql`ordered_at = coalesce(ordered_at, current_date), revision_at_order = coalesce(revision_at_order, (select revision from cad_items c where c.id = purchase_items.cad_item_id)),`;
    return sql``;
  }

  app.patch('/purchasing/items/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const cur = await loadItem(u, id);
    const b = parse(patchSchema(itemBody).extend({ sort: z.number().optional(), revisionWarning: z.literal(false).optional() }), req.body);
    const reqAt = b.requestedAt !== undefined ? sql`${b.requestedAt}::date` : b.status === 'requested' ? sql`coalesce(requested_at, current_date)` : sql`requested_at`;
    const ordAt = b.orderedAt !== undefined ? sql`${b.orderedAt}::date` : b.status === 'ordered' ? sql`coalesce(ordered_at, current_date)` : sql`ordered_at`;
    await sql`update purchase_items set
      revision_at_order = ${b.status === 'ordered' ? sql`coalesce(revision_at_order, (select revision from cad_items c where c.id = purchase_items.cad_item_id))` : sql`revision_at_order`},
      number = coalesce(${b.number ?? null}, number), designation = coalesce(${b.designation ?? null}, designation), manufacturer = coalesce(${b.manufacturer ?? null}, manufacturer),
      manufacturer_no = coalesce(${b.manufacturerNo ?? null}, manufacturer_no), supplier_id = ${b.supplierId === undefined ? sql`supplier_id` : b.supplierId},
      supplier_order_no = coalesce(${b.supplierOrderNo ?? null}, supplier_order_no), qty = coalesce(${b.qty ?? null}, qty), unit = coalesce(${b.unit ?? null}, unit),
      unit_price = ${b.unitPrice === undefined ? sql`unit_price` : b.unitPrice}, discount = coalesce(${b.discount ?? null}, discount),
      cost_center = coalesce(${b.costCenter ?? null}, cost_center), note = coalesce(${b.note ?? null}, note), status = coalesce(${b.status ?? null}, status),
      requested_at = ${reqAt}, ordered_at = ${ordAt},
      planned_delivery = ${b.plannedDelivery === undefined ? sql`planned_delivery` : b.plannedDelivery},
      confirmed_delivery = ${b.confirmedDelivery === undefined ? sql`confirmed_delivery` : b.confirmedDelivery},
      attachments = ${b.attachments ? sql.json(b.attachments) : sql`attachments`}, sort = coalesce(${b.sort ?? null}, sort),
      revision_warning = ${b.revisionWarning === false ? false : sql`revision_warning`}, updated_at = now() where id = ${id}`;
    if (b.status && b.status !== cur.status)
      await audit(sql, u, { action: 'purchasing.status', entityType: 'purchase_item', entityId: id, projectId: cur.project_id, summary: `${cur.designation}: ${PURCHASE_STATUS_LABEL[cur.status]} → ${PURCHASE_STATUS_LABEL[b.status]}` });
    ctx.hub.publish(`project:${cur.project_id}`, 'purchasing.changed', {});
    const [full] = await sql`select ${cols} from ${from} where i.id = ${id}`;
    return full;
  });

  app.delete('/purchasing/items/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const cur = await loadItem(u, id);
    if (cur.status !== 'open') throw badRequest('Nur offene Positionen lassen sich löschen – sonst bitte stornieren');
    await sql`delete from purchase_items where id = ${id}`;
    ctx.hub.publish(`project:${cur.project_id}`, 'purchasing.changed', {});
    return { ok: true };
  });

  /** Mehrere Positionen gemeinsam ändern, z. B. auf „Bestellt“ setzen; mit Lieferant entsteht eine Bestellung mit Nummer */
  app.post('/purchasing/bulk', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), status: z.enum(STATUSES).optional(), supplierId: z.string().uuid().nullable().optional(),
      plannedDelivery: z.string().date().nullable().optional(), createOrder: z.boolean().default(false), note: z.string().max(2000).default('') }), req.body);
    const items = [];
    for (const id of b.ids) items.push(await loadItem(u, id));
    let orderId: string | null = null, orderNumber: string | null = null;
    if (b.createOrder) {
      if (!b.supplierId) throw badRequest('Für eine Bestellung bitte einen Lieferanten wählen');
      const projects = [...new Set(items.map((i) => i.project_id))];
      const n = await ctx.settings.get('numbers');
      orderNumber = await nextNumber(sql, 'order', n.order, async (x) => (await sql`select 1 from purchase_orders where number = ${x}`).length > 0);
      const [o] = await sql<{ id: string }[]>`insert into purchase_orders (number, project_id, supplier_id, note, created_by) values (${orderNumber}, ${projects.length === 1 ? projects[0]! : null}, ${b.supplierId}, ${b.note}, ${u.id}) returning id`;
      orderId = o!.id;
    }
    const status = b.status ?? (b.createOrder ? 'ordered' : undefined);
    await sql`update purchase_items set ${statusDates(status)} status = coalesce(${status ?? null}, status),
      supplier_id = ${b.supplierId === undefined ? sql`supplier_id` : b.supplierId}, planned_delivery = ${b.plannedDelivery === undefined ? sql`planned_delivery` : b.plannedDelivery},
      order_id = coalesce(${orderId}, order_id), updated_at = now() where id = any(${b.ids})`;
    for (const p of new Set(items.map((i) => i.project_id))) ctx.hub.publish(`project:${p}`, 'purchasing.changed', {});
    if (status) await audit(sql, u, { action: 'purchasing.bulk', entityType: 'purchase_item', projectId: items[0]!.project_id, summary: `${b.ids.length} Positionen → ${PURCHASE_STATUS_LABEL[status]}${orderNumber ? ` (Bestellung ${orderNumber})` : ''}` });
    return { ok: true, orderId, orderNumber };
  });

  /** Wareneingang buchen (auch Teillieferungen) – die Projektleitung erfährt es */
  app.post('/purchasing/items/:id/receipts', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ qty: z.number().positive(), receivedAt: z.string().date().optional(), note: z.string().max(2000).default('') }), req.body);
    return bookPurchaseReceipt(ctx, u, id, b);
  });

  app.get('/purchasing/items/:id/receipts', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadItem(u, id);
    return sql`select r.id, r.qty::float as qty, r.received_at::text as "receivedAt", r.note, us.display_name as "userName" from purchase_receipts r left join users us on us.id = r.user_id where r.item_id = ${id} order by r.created_at`;
  });

  // ------------------------------------------------ Übersicht über alle Projekte
  app.get('/purchasing/items', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ status: z.string().optional(), overdue: z.coerce.boolean().optional(), supplierId: z.string().uuid().optional() }), req.query);
    return sql`select ${cols} from ${from} where (${u.role === 'admin'} or p.visibility = 'company' or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = ${u.id}))
      ${q.status === 'active' ? sql`and i.status not in ('delivered', 'cancelled')` : q.status ? sql`and i.status = ${q.status}` : sql``}
      ${q.overdue ? sql`and coalesce(i.confirmed_delivery, i.planned_delivery) < current_date and i.status in ('ordered', 'confirmed', 'partial')` : sql``}
      ${q.supplierId ? sql`and i.supplier_id = ${q.supplierId}` : sql``}
      order by coalesce(i.confirmed_delivery, i.planned_delivery) nulls last, p.number limit 2000`;
  });

  app.get('/purchasing/dashboard', async (req) => {
    requireUser(req);
    const [k] = await sql`select
        count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'requested')::int as requested,
        count(*) filter (where status in ('ordered', 'confirmed', 'partial'))::int as ordered,
        count(*) filter (where status in ('ordered', 'confirmed', 'partial') and coalesce(confirmed_delivery, planned_delivery) < current_date)::int as overdue,
        count(*) filter (where revision_warning and status not in ('delivered', 'cancelled'))::int as warnings,
        coalesce(sum(qty * coalesce(unit_price, 0) * (1 - discount / 100)) filter (where status not in ('open', 'requested', 'cancelled')), 0)::float as "orderedValue"
      from purchase_items`;
    const projects = await sql`select p.id, p.number, p.name, p.budget::float as budget,
        coalesce(sum(i.qty * coalesce(i.unit_price, 0) * (1 - i.discount / 100)) filter (where i.status not in ('open', 'requested', 'cancelled')), 0)::float as spent,
        coalesce(sum(i.qty * coalesce(i.unit_price, 0) * (1 - i.discount / 100)) filter (where i.status in ('open', 'requested')), 0)::float as planned,
        count(*) filter (where i.status not in ('delivered', 'cancelled'))::int as "openItems"
      from projects p join purchase_items i on i.project_id = p.id where p.status not in ('archived') group by p.id order by p.number`;
    const suppliers = await sql`select s.id, s.name, count(*)::int as deliveries,
        count(*) filter (where i.delivered_at <= coalesce(i.confirmed_delivery, i.planned_delivery))::int as "onTime"
      from purchase_items i join crm_accounts s on s.id = i.supplier_id where i.status = 'delivered' and coalesce(i.confirmed_delivery, i.planned_delivery) is not null
      group by s.id order by deliveries desc limit 20`;
    const upcoming = await sql`select ${cols} from ${from} where i.status in ('ordered', 'confirmed', 'partial')
      and coalesce(i.confirmed_delivery, i.planned_delivery) between current_date - 30 and current_date + 14 order by coalesce(i.confirmed_delivery, i.planned_delivery)`;
    return { ...k, projects, suppliers, upcoming };
  });

  // ------------------------------------------------ Export und Bestellung als PDF
  app.get('/purchasing/projects/:id/export.xlsx', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const p = await projectAccess(sql, u, id);
    const rows = await sql<any[]>`select ${cols} from ${from} where i.project_id = ${id} order by i.sort`;
    const buf = writeXlsx([{ name: 'Einkauf', widths: [24, 34, 18, 18, 26, 16, 8, 8, 12, 8, 12, 14, 12, 12, 12, 12, 14, 30], rows: [
      ['Nummer', 'Benennung', 'Hersteller', 'Hersteller-Nr.', 'Lieferant', 'Bestell-Nr. Lieferant', 'Menge', 'Einheit', 'Einzelpreis', 'Rabatt %', 'Gesamt', 'Status', 'Angefragt', 'Bestellt', 'Geplant', 'Bestätigt', 'Geliefert', 'Bemerkung'],
      ...rows.map((r) => [r.number, r.designation, r.manufacturer, r.manufacturerNo, r.supplierName, r.supplierOrderNo, r.qty, r.unit, r.unitPrice, r.discount, r.total,
        PURCHASE_STATUS_LABEL[r.status], r.requestedAt, r.orderedAt, r.plannedDelivery, r.confirmedDelivery, r.deliveredAt, r.note]),
    ] }]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Einkauf_${p.number}.xlsx"`);
    return buf;
  });

  app.get('/purchasing/orders/:id/pdf', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [o] = await sql<{ number: string; order_date: string; supplier_id: string | null; note: string; created_by: string | null }[]>`select number, order_date::text, supplier_id, note, created_by from purchase_orders where id = ${id}`;
    if (!o) throw notFound();
    const items = await sql<any[]>`select ${cols} from ${from} where i.order_id = ${id} order by p.number, i.sort`;
    if (items[0]) await projectAccess(sql, u, items[0].projectId);
    const [s] = o.supplier_id ? await sql<{ name: string; street: string; zip: string; city: string; number: string }[]>`select name, street, zip, city, number from crm_accounts where id = ${o.supplier_id}` : [];
    const company = await ctx.settings.get('company');
    const lh = await ctx.settings.get('letterhead');
    const [author] = o.created_by ? await sql<{ display_name: string }[]>`select display_name from users where id = ${o.created_by}` : [];
    const pdf = new Pdf(`Bestellung ${o.number}`, company.name);
    pdf.text(pdf.margin, pdf.y, company.name, { size: 14, bold: true });
    if (lh.address) pdf.text(pdf.margin, pdf.y + 18, lh.address.replace(/\n/g, ' · '), { size: 8, color: '#6b7280' });
    pdf.y += 60;
    for (const l of [s?.name, s?.street, `${s?.zip ?? ''} ${s?.city ?? ''}`.trim()].filter(Boolean) as string[]) { pdf.text(pdf.margin, pdf.y, l); pdf.y += 13; }
    pdf.text(380, pdf.y - 39, 'Bestellung', { size: 9, color: '#6b7280' }); pdf.text(460, pdf.y - 39, o.number, { size: 9 });
    pdf.text(380, pdf.y - 26, 'Datum', { size: 9, color: '#6b7280' }); pdf.text(460, pdf.y - 26, new Date(o.order_date).toLocaleDateString('de-DE'), { size: 9 });
    if (s?.number) { pdf.text(380, pdf.y - 13, 'Lieferanten-Nr.', { size: 9, color: '#6b7280' }); pdf.text(460, pdf.y - 13, s.number, { size: 9 }); }
    pdf.y += 30;
    pdf.paragraph(`Bestellung ${o.number}`, { size: 14, bold: true, gap: 8 });
    pdf.paragraph('Sehr geehrte Damen und Herren, hiermit bestellen wir zu Ihren bekannten Bedingungen:', { gap: 10 });
    let total = 0;
    pdf.table([{ label: 'Pos.', width: 30 }, { label: 'Artikel', width: 205 }, { label: 'Ihre Art.-Nr.', width: 80 }, { label: 'Menge', width: 55, align: 'right' }, { label: 'Preis', width: 60, align: 'right' }, { label: 'Gesamt', width: 65, align: 'right' }],
      items.map((i, k) => { total += i.total; return [String(k + 1), `${i.designation}${i.manufacturer ? `\n${i.manufacturer} ${i.manufacturerNo}` : ''}${i.number ? `\nunsere Nr. ${i.number}` : ''}`, i.supplierOrderNo, `${num(i.qty)} ${i.unit}`, i.unitPrice != null ? eur(i.unitPrice) : '', i.unitPrice != null ? eur(i.total) : '']; }), { zebra: true });
    pdf.text(330, pdf.y, 'Summe netto', { bold: true }); pdf.text(pdf.width - pdf.margin - 120, pdf.y, eur(total), { bold: true, align: 'right', width: 120 }); pdf.y += 20;
    const due = items.map((i) => i.plannedDelivery).filter(Boolean).sort()[0];
    if (due) pdf.paragraph(`Gewünschter Liefertermin: ${new Date(due).toLocaleDateString('de-DE')}`);
    pdf.paragraph(`Projekt: ${[...new Set(items.map((i) => `${i.projectNumber} ${i.projectName}`))].join(', ')} – bitte auf Lieferschein und Rechnung angeben.`);
    if (o.note) pdf.paragraph(o.note);
    pdf.paragraph('Bitte bestätigen Sie uns die Bestellung mit Liefertermin.', { gap: 10 });
    pdf.paragraph('Mit freundlichen Grüßen'); pdf.paragraph(author?.display_name ?? company.name);
    pdf.footer((p, t) => `${lh.footer || company.name} · Seite ${p} von ${t}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Bestellung_${o.number}.pdf"`);
    return pdf.toBuffer();
  });
}
