/**
 * Lager (wie Odoo Inventory, bewusst schlank): Lagerorte, Artikel, Bestände je Ort und Charge/Seriennummer,
 * Wareneingang aus dem Einkauf, Entnahme für Projekte, Umlagern, Mindestbestand mit Bestellvorschlag, Inventur.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { projectAccess } from '../lib/access';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { bookMove, locationSubtree } from '../services/warehouse';
import { bookPurchaseReceipt } from './purchasing';
import { writeXlsx } from '../lib/xlsx';
import { safeName } from '../services/files';
import { sendStoredFile } from './files';

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const articleBody = z.object({
  number: z.string().trim().max(60).default(''),
  name: z.string().trim().min(1).max(300),
  description: z.string().max(5000).default(''),
  category: z.string().trim().max(100).default(''),
  unit: z.string().trim().min(1).max(20).default('Stk'),
  manufacturer: z.string().max(120).default(''),
  manufacturerNo: z.string().max(120).default(''),
  supplierId: z.string().uuid().nullable().default(null),
  supplierNo: z.string().max(120).default(''),
  purchasePrice: z.number().min(0).nullable().default(null),
  barcode: z.string().trim().max(120).nullable().default(null),
  minQty: z.number().min(0).default(0),
  reorderQty: z.number().min(0).default(0),
  tracking: z.enum(['none', 'lot', 'serial']).default('none'),
  defaultLocationId: z.string().uuid().nullable().default(null),
  cadItemId: z.string().uuid().nullable().default(null),
  active: z.boolean().default(true),
});

export default async function warehouseRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const staff = (req: Parameters<typeof requireUser>[0]) => { const u = requireUser(req); if (u.role === 'guest') throw forbidden(); return u; };
  const changed = () => ctx.hub.publish('global', 'warehouse.changed', {});

  // ------------------------------------------------ Lagerorte
  app.get('/warehouse/locations', async (req) => {
    staff(req);
    return sql`select l.id, l.parent_id as "parentId", l.name, l.code, l.kind, l.active, l.sort,
      (select count(distinct s.article_id)::int from wh_stock s where s.location_id = l.id and s.qty > 0) as articles
      from wh_locations l order by l.sort, l.name`;
  });
  const locBody = z.object({ name: z.string().trim().min(1).max(120), parentId: z.string().uuid().nullable().default(null), code: z.string().trim().max(60).nullable().default(null),
    kind: z.enum(['warehouse', 'zone', 'shelf', 'bin']).default('shelf'), active: z.boolean().default(true) });
  app.post('/warehouse/locations', async (req) => {
    const u = staff(req);
    const b = parse(locBody, req.body);
    const id = randomUUID();
    const code = b.code || `L-${id.slice(0, 6).toUpperCase()}`;
    const s = (await sql<{ s: number }[]>`select coalesce(max(sort), 0) + 10 as s from wh_locations`)[0]!.s;
    await sql`insert into wh_locations (id, parent_id, name, code, kind, active, sort) values (${id}, ${b.parentId}, ${b.name}, ${code}, ${b.kind}, ${b.active}, ${s})`;
    await audit(sql, u, { action: 'warehouse.location', entityType: 'wh_location', entityId: id, summary: `Lagerort angelegt: ${b.name}` });
    changed();
    return { id, code };
  });
  app.patch('/warehouse/locations/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(locBody), req.body);
    if (b.parentId) {
      if ((await locationSubtree(sql, id)).includes(b.parentId)) throw badRequest('Ein Lagerort kann nicht in sich selbst liegen.');
    }
    await sql`update wh_locations set name = coalesce(${b.name ?? null}, name), code = coalesce(${b.code ?? null}, code), kind = coalesce(${b.kind ?? null}, kind),
      active = coalesce(${b.active ?? null}, active), parent_id = ${b.parentId === undefined ? sql`parent_id` : b.parentId} where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/warehouse/locations/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [busy] = await sql`select 1 from wh_stock where location_id = ${id} and qty > 0 union all select 1 from wh_locations where parent_id = ${id} limit 1`;
    if (busy) throw badRequest('Der Lagerort ist nicht leer oder hat Unterorte. Stattdessen stilllegen?');
    const [used] = await sql`select 1 from wh_moves where from_location_id = ${id} or to_location_id = ${id} limit 1`;
    if (used) await sql`update wh_locations set active = false where id = ${id}`;
    else await sql`delete from wh_locations where id = ${id}`;
    changed();
    return { ok: true, deactivated: Boolean(used) };
  });

  // ------------------------------------------------ Artikel
  const stockSum = sql`coalesce((select sum(s.qty) from wh_stock s where s.article_id = a.id), 0)`;
  const openPurchase = sql`coalesce((select sum(greatest(pi.qty - pi.delivered_qty, 0)) from purchase_items pi where pi.wh_article_id = a.id and pi.status in ('open', 'requested', 'ordered', 'confirmed', 'partial')), 0)`;
  const articleCols = sql`a.id, a.number, a.name, a.description, a.category, a.unit, a.manufacturer, a.manufacturer_no as "manufacturerNo",
    a.supplier_id as "supplierId", sup.name as "supplierName", a.supplier_no as "supplierNo", a.purchase_price::float as "purchasePrice", a.barcode,
    a.min_qty::float as "minQty", a.reorder_qty::float as "reorderQty", a.tracking, a.default_location_id as "defaultLocationId", dl.name as "defaultLocationName",
    a.cad_item_id as "cadItemId", a.image_path is not null as "hasImage", a.active, a.updated_at as "updatedAt",
    ${stockSum}::float as stock, ${openPurchase}::float as "onOrder", (${stockSum} * coalesce(a.purchase_price, 0))::float as value`;
  const articleFrom = sql`wh_articles a left join crm_accounts sup on sup.id = a.supplier_id left join wh_locations dl on dl.id = a.default_location_id`;

  app.get('/warehouse/articles', async (req) => {
    staff(req);
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), category: z.string().max(100).optional(), low: z.coerce.boolean().optional(),
      locationId: z.string().uuid().optional(), inactive: z.coerce.boolean().optional() }), req.query);
    const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => '\\' + c)}%` : null;
    const locs = q.locationId ? await locationSubtree(sql, q.locationId) : null;
    return sql`select ${articleCols} from ${articleFrom}
      where ${q.inactive ? sql`true` : sql`a.active`}
        ${like ? sql`and (a.number ilike ${like} or a.name ilike ${like} or a.manufacturer_no ilike ${like} or a.barcode ilike ${like} or a.supplier_no ilike ${like} or a.description ilike ${like})` : sql``}
        ${q.category ? sql`and a.category = ${q.category}` : sql``}
        ${q.low ? sql`and a.min_qty > 0 and ${stockSum} + ${openPurchase} < a.min_qty` : sql``}
        ${locs ? sql`and exists (select 1 from wh_stock s where s.article_id = a.id and s.location_id = any(${locs}) and s.qty > 0)` : sql``}
      order by a.number limit 2000`;
  });

  app.get('/warehouse/articles/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [a] = await sql`select ${articleCols} from ${articleFrom} where a.id = ${id}`;
    if (!a) throw notFound('Artikel nicht gefunden');
    const stock = await sql`select s.location_id as "locationId", l.name as "locationName", l.code as "locationCode", s.lot, s.qty::float as qty
      from wh_stock s join wh_locations l on l.id = s.location_id where s.article_id = ${id} and s.qty > 0 order by l.name, s.lot`;
    const moves = await sql`select m.id, m.kind, m.qty::float as qty, m.lot, m.note, m.created_at as "createdAt", m.unit_price::float as "unitPrice",
      fl.name as "fromName", tl.name as "toName", p.id as "projectId", p.number as "projectNumber", p.name as "projectName", us.display_name as "userName"
      from wh_moves m left join wh_locations fl on fl.id = m.from_location_id left join wh_locations tl on tl.id = m.to_location_id
      left join projects p on p.id = m.project_id left join users us on us.id = m.user_id where m.article_id = ${id} order by m.created_at desc limit 200`;
    const purchases = await sql`select pi.id, pi.status, (pi.qty - pi.delivered_qty)::float as open, pi.planned_delivery::text as "plannedDelivery", p.number as "projectNumber", pi.project_id as "projectId"
      from purchase_items pi join projects p on p.id = pi.project_id where pi.wh_article_id = ${id} and pi.status in ('open', 'requested', 'ordered', 'confirmed', 'partial') order by pi.created_at`;
    return { ...a, stockByLocation: stock, moves, purchases };
  });

  async function articleNumber(given: string) {
    if (given) {
      const [dup] = await sql`select 1 from wh_articles where number = ${given}`;
      if (dup) throw badRequest(`Die Artikelnummer ${given} gibt es schon.`);
      return given;
    }
    const nums = await ctx.settings.get('numbers');
    return nextNumber(sql, 'article', nums.article, async (x) => (await sql`select 1 from wh_articles where number = ${x}`).length > 0);
  }
  const insertArticle = async (b: z.infer<typeof articleBody>) => {
    const id = randomUUID();
    const number = await articleNumber(b.number);
    await sql`insert into wh_articles (id, number, name, description, category, unit, manufacturer, manufacturer_no, supplier_id, supplier_no, purchase_price, barcode,
      min_qty, reorder_qty, tracking, default_location_id, cad_item_id, active)
      values (${id}, ${number}, ${b.name}, ${b.description}, ${b.category}, ${b.unit}, ${b.manufacturer}, ${b.manufacturerNo}, ${b.supplierId}, ${b.supplierNo},
        ${b.purchasePrice}, ${b.barcode || null}, ${b.minQty}, ${b.reorderQty}, ${b.tracking}, ${b.defaultLocationId}, ${b.cadItemId}, ${b.active})`;
    return { id, number };
  };

  app.post('/warehouse/articles', async (req) => {
    const u = staff(req);
    const b = parse(articleBody, req.body);
    try {
      const r = await insertArticle(b);
      await audit(sql, u, { action: 'warehouse.article', entityType: 'wh_article', entityId: r.id, summary: `Artikel angelegt: ${r.number} ${b.name}` });
      changed();
      return r;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw badRequest('Dieser Barcode ist schon einem anderen Artikel zugeordnet.');
      throw e;
    }
  });

  app.patch('/warehouse/articles/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(articleBody), req.body);
    const [cur] = await sql<{ tracking: string; number: string }[]>`select tracking, number from wh_articles where id = ${id}`;
    if (!cur) throw notFound();
    if (b.tracking && b.tracking !== cur.tracking) {
      const [has] = await sql`select 1 from wh_stock where article_id = ${id} and qty > 0`;
      if (has) throw badRequest('Die Verfolgung (Charge/Seriennummer) lässt sich nur ändern, solange kein Bestand da ist.');
    }
    if (b.number && b.number !== cur.number) await articleNumber(b.number);
    const set = <T>(v: T | undefined) => (v === undefined ? null : v);
    try {
      await sql`update wh_articles set number = coalesce(${set(b.number) || null}, number), name = coalesce(${set(b.name)}, name), description = coalesce(${set(b.description)}, description),
        category = coalesce(${set(b.category)}, category), unit = coalesce(${set(b.unit)}, unit), manufacturer = coalesce(${set(b.manufacturer)}, manufacturer),
        manufacturer_no = coalesce(${set(b.manufacturerNo)}, manufacturer_no), supplier_id = ${b.supplierId === undefined ? sql`supplier_id` : b.supplierId},
        supplier_no = coalesce(${set(b.supplierNo)}, supplier_no), purchase_price = ${b.purchasePrice === undefined ? sql`purchase_price` : b.purchasePrice},
        barcode = ${b.barcode === undefined ? sql`barcode` : b.barcode || null}, min_qty = coalesce(${set(b.minQty)}, min_qty), reorder_qty = coalesce(${set(b.reorderQty)}, reorder_qty),
        tracking = coalesce(${set(b.tracking)}, tracking), default_location_id = ${b.defaultLocationId === undefined ? sql`default_location_id` : b.defaultLocationId},
        cad_item_id = ${b.cadItemId === undefined ? sql`cad_item_id` : b.cadItemId}, active = coalesce(${set(b.active)}, active), updated_at = now() where id = ${id}`;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw badRequest('Dieser Barcode ist schon einem anderen Artikel zugeordnet.');
      throw e;
    }
    changed();
    return { ok: true };
  });

  app.delete('/warehouse/articles/:id', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [has] = await sql`select 1 from wh_stock where article_id = ${id} and qty > 0`;
    if (has) throw badRequest('Der Artikel hat noch Bestand. Bitte zuerst ausbuchen.');
    const [moved] = await sql`select 1 from wh_moves where article_id = ${id} limit 1`;
    if (moved) await sql`update wh_articles set active = false where id = ${id}`;
    else await sql`delete from wh_articles where id = ${id}`;
    await audit(sql, u, { action: 'warehouse.article', entityType: 'wh_article', entityId: id, summary: moved ? 'Artikel stillgelegt' : 'Artikel gelöscht' });
    changed();
    return { ok: true, deactivated: Boolean(moved) };
  });

  app.post('/warehouse/articles/:id/image', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const file = await req.file();
    if (!file) throw badRequest('Kein Bild');
    if (!/\.(png|jpe?g|webp|gif)$/i.test(file.filename)) throw badRequest('Bitte ein Bild (PNG, JPG, WebP) wählen.');
    const path = `.aperio/warehouse/${id}/${randomUUID().slice(0, 8)}_${safeName(file.filename)}`;
    const r = await storage.write(path, file.file);
    if (r.size > 10 * 1024 * 1024) { await storage.remove(path).catch(() => {}); throw badRequest('Bild größer als 10 MB'); }
    const [old] = await sql<{ image_path: string | null }[]>`select image_path from wh_articles where id = ${id}`;
    await sql`update wh_articles set image_path = ${path} where id = ${id}`;
    if (old?.image_path) await storage.remove(old.image_path).catch(() => {});
    return { ok: true };
  });
  app.get('/warehouse/articles/:id/image', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [a] = await sql<{ image_path: string | null }[]>`select image_path from wh_articles where id = ${id}`;
    if (!a?.image_path) throw notFound();
    return sendStoredFile(ctx, reply, a.image_path, a.image_path.split('/').pop()!, true);
  });

  /** Scannen: Barcode, Artikelnummer, Lagerort-Code oder Link aus einem QR-Etikett */
  app.get('/warehouse/lookup', async (req) => {
    staff(req);
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(500) }), req.query);
    const m = code.match(/\/warehouse\/(article|location)\/([0-9a-f-]{36})/);
    if (m) return { type: m[1], id: m[2] };
    const [a] = await sql<{ id: string }[]>`select id from wh_articles where barcode = ${code} or number = ${code} or (manufacturer_no <> '' and manufacturer_no = ${code}) order by active desc limit 1`;
    if (a) return { type: 'article', id: a.id };
    const [l] = await sql<{ id: string }[]>`select id from wh_locations where code = ${code}`;
    if (l) return { type: 'location', id: l.id };
    throw notFound(`Nichts gefunden zu „${code}“.`);
  });

  const stockOf = async (articleId: string) => Number((await sql<{ q: string }[]>`select coalesce(sum(qty), 0) as q from wh_stock where article_id = ${articleId}`)[0]!.q);
  /** Mindestbestand gerade unterschritten: Lager-Verantwortliche benachrichtigen */
  async function lowStockCheck(articleId: string, before: number, by: string) {
    const [a] = await sql<{ number: string; name: string; min_qty: string; unit: string }[]>`select number, name, min_qty, unit from wh_articles where id = ${articleId}`;
    const min = Number(a?.min_qty ?? 0);
    const now = await stockOf(articleId);
    if (!a || min <= 0 || before < min || now >= min) return;
    const users = await sql<{ id: string; tools: string[] | null; dept_tools: string[] | null; role: string }[]>`select u.id, u.tools, t.default_tools as dept_tools, u.role
      from users u left join teams t on t.id = u.department_id where u.active and u.deleted_at is null and u.role <> 'guest'`;
    const to = users.filter((x) => (x.tools ?? x.dept_tools)?.includes('warehouse')).map((x) => x.id);
    await notify(ctx, to.length ? to : users.filter((x) => x.role === 'admin').map((x) => x.id), { kind: 'warehouse.low', title: `Mindestbestand unterschritten: ${a.number} ${a.name}`,
      body: `Noch ${now.toLocaleString('de-DE')} ${a.unit} (Mindestbestand ${min.toLocaleString('de-DE')})`, link: `/warehouse?tab=reorder` }, by);
  }

  // ------------------------------------------------ Bewegungen
  const moveBody = z.object({
    kind: z.enum(['receipt', 'issue', 'transfer', 'adjust', 'return']), articleId: z.string().uuid(), qty: z.number().positive(),
    fromLocationId: z.string().uuid().nullable().default(null), toLocationId: z.string().uuid().nullable().default(null), lot: z.string().trim().max(120).default(''),
    projectId: z.string().uuid().nullable().default(null), note: z.string().max(2000).default(''), unitPrice: z.number().min(0).nullable().default(null),
  });
  app.post('/warehouse/moves', async (req) => {
    const u = staff(req);
    const b = parse(moveBody, req.body);
    if (b.projectId) await projectAccess(sql, u, b.projectId, 'write');
    if ((b.kind === 'issue' || b.kind === 'return') && !b.projectId && !b.note.trim()) throw badRequest('Bitte ein Projekt oder einen Grund angeben.');
    const before = await stockOf(b.articleId);
    const id = await bookMove(sql, u, b);
    await lowStockCheck(b.articleId, before, u.id);
    changed();
    if (b.projectId) ctx.hub.publish(`project:${b.projectId}`, 'warehouse.changed', {});
    return { id };
  });

  app.get('/warehouse/moves', async (req) => {
    staff(req);
    const q = parse(z.object({ kind: z.string().max(20).optional(), projectId: z.string().uuid().optional(), from: z.string().date().optional(), to: z.string().date().optional(),
      limit: z.coerce.number().int().min(1).max(2000).default(300) }), req.query);
    return sql`select m.id, m.kind, m.qty::float as qty, m.lot, m.note, m.created_at as "createdAt", m.unit_price::float as "unitPrice",
      a.id as "articleId", a.number as "articleNumber", a.name as "articleName", a.unit, fl.name as "fromName", tl.name as "toName",
      p.id as "projectId", p.number as "projectNumber", us.display_name as "userName"
      from wh_moves m join wh_articles a on a.id = m.article_id left join wh_locations fl on fl.id = m.from_location_id left join wh_locations tl on tl.id = m.to_location_id
      left join projects p on p.id = m.project_id left join users us on us.id = m.user_id
      where true ${q.kind ? sql`and m.kind = ${q.kind}` : sql``} ${q.projectId ? sql`and m.project_id = ${q.projectId}` : sql``}
        ${q.from ? sql`and m.created_at >= ${q.from}` : sql``} ${q.to ? sql`and m.created_at < ${q.to}::date + 1` : sql``}
      order by m.created_at desc limit ${q.limit}`;
  });

  /** Material eines Projekts (Entnahmen minus Rückgaben) mit Wert */
  app.get('/warehouse/projects/:id/material', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    const rows = await sql`select a.id as "articleId", a.number, a.name, a.unit,
      sum(case when m.kind = 'issue' then m.qty else -m.qty end)::float as qty,
      sum((case when m.kind = 'issue' then m.qty else -m.qty end) * coalesce(m.unit_price, 0))::float as value
      from wh_moves m join wh_articles a on a.id = m.article_id where m.project_id = ${id} and m.kind in ('issue', 'return')
      group by a.id order by a.number`;
    return { rows, total: rows.reduce((s, r) => s + Number(r.value), 0) };
  });

  // ------------------------------------------------ Einkauf: Wareneingang und Nachbestellung
  app.get('/warehouse/incoming', async (req) => {
    staff(req);
    return sql`select pi.id, pi.designation, pi.number, pi.manufacturer_no as "manufacturerNo", (pi.qty - pi.delivered_qty)::float as open, pi.unit, pi.status,
      coalesce(pi.confirmed_delivery, pi.planned_delivery)::text as "expected", p.id as "projectId", p.number as "projectNumber", p.name as "projectName",
      s.name as "supplierName", o.number as "orderNumber",
      coalesce(pi.wh_article_id, (select a.id from wh_articles a where a.active and ((pi.cad_item_id is not null and a.cad_item_id = pi.cad_item_id)
        or (pi.number <> '' and a.number = pi.number) or (pi.manufacturer_no <> '' and a.manufacturer_no = pi.manufacturer_no)) limit 1)) as "articleId"
      from purchase_items pi join projects p on p.id = pi.project_id left join crm_accounts s on s.id = pi.supplier_id left join purchase_orders o on o.id = pi.order_id
      where pi.status in ('ordered', 'confirmed', 'partial') order by coalesce(pi.confirmed_delivery, pi.planned_delivery) nulls last, pi.created_at limit 500`;
  });

  /**
   * Wareneingang aus dem Einkauf: bucht die Lieferung in der Einkaufsposition und – je nach Ziel –
   * ins Lager (Lagerort) oder direkt ins Projekt (Zugang und sofortige Entnahme werden protokolliert).
   */
  app.post('/warehouse/receive', async (req) => {
    const u = staff(req);
    const b = parse(z.object({ purchaseItemId: z.string().uuid(), qty: z.number().positive(), locationId: z.string().uuid(), lot: z.string().trim().max(120).default(''),
      articleId: z.string().uuid().nullable().default(null), createArticle: z.boolean().default(false), toProject: z.boolean().default(false), note: z.string().max(2000).default('') }), req.body);
    const [pi] = await sql<{ id: string; project_id: string; designation: string; number: string; manufacturer: string; manufacturer_no: string; supplier_id: string | null;
      supplier_order_no: string; unit: string; unit_price: string | null; discount: string; cad_item_id: string | null; wh_article_id: string | null }[]>`
      select id, project_id, designation, number, manufacturer, manufacturer_no, supplier_id, supplier_order_no, unit, unit_price, discount, cad_item_id, wh_article_id from purchase_items where id = ${b.purchaseItemId}`;
    if (!pi) throw notFound('Einkaufsposition nicht gefunden');
    let articleId = b.articleId ?? pi.wh_article_id;
    if (!articleId && b.createArticle) {
      articleId = (await insertArticle(parse(articleBody, { number: '', name: pi.designation, unit: pi.unit || 'Stk', manufacturer: pi.manufacturer, manufacturerNo: pi.manufacturer_no,
        supplierId: pi.supplier_id, supplierNo: pi.supplier_order_no, purchasePrice: pi.unit_price === null ? null : Number(pi.unit_price) * (1 - Number(pi.discount) / 100),
        cadItemId: pi.cad_item_id, defaultLocationId: b.locationId }))).id;
    }
    if (!articleId) throw badRequest('Bitte einen Lagerartikel wählen oder anlegen lassen.');
    const price = pi.unit_price === null ? null : Number(pi.unit_price) * (1 - Number(pi.discount) / 100);
    const r = await bookPurchaseReceipt(ctx, u, pi.id, { qty: b.qty, note: b.note });
    await sql`update purchase_items set wh_article_id = ${articleId} where id = ${pi.id}`;
    if (price !== null) await sql`update wh_articles set purchase_price = ${price} where id = ${articleId}`;
    await bookMove(sql, u, { kind: 'receipt', articleId, qty: b.qty, toLocationId: b.locationId, lot: b.lot, purchaseItemId: pi.id, unitPrice: price, note: b.note || 'Wareneingang Einkauf' });
    if (b.toProject) await bookMove(sql, u, { kind: 'issue', articleId, qty: b.qty, fromLocationId: b.locationId, lot: b.lot, projectId: pi.project_id, purchaseItemId: pi.id, unitPrice: price, note: 'direkt ins Projekt' });
    changed();
    return { ...r, articleId };
  });

  /** Bestellvorschlag: Bestand + bestellte Menge unter Mindestbestand */
  app.get('/warehouse/reorder', async (req) => {
    staff(req);
    return sql`select ${articleCols}, greatest(a.reorder_qty, a.min_qty - ${stockSum} - ${openPurchase})::float as suggest
      from ${articleFrom} where a.active and a.min_qty > 0 and ${stockSum} + ${openPurchase} < a.min_qty order by sup.name nulls last, a.number`;
  });
  app.post('/warehouse/reorder', async (req) => {
    const u = staff(req);
    const b = parse(z.object({ projectId: z.string().uuid(), items: z.array(z.object({ articleId: z.string().uuid(), qty: z.number().positive() })).min(1).max(500) }), req.body);
    await projectAccess(sql, u, b.projectId, 'edit');
    const ids: string[] = [];
    for (const it of b.items) {
      const [a] = await sql<{ number: string; name: string; manufacturer: string; manufacturer_no: string; supplier_id: string | null; supplier_no: string; unit: string; purchase_price: string | null }[]>`
        select number, name, manufacturer, manufacturer_no, supplier_id, supplier_no, unit, purchase_price from wh_articles where id = ${it.articleId}`;
      if (!a) continue;
      const s = (await sql<{ s: number }[]>`select coalesce(max(sort), 0) + 1000 as s from purchase_items where project_id = ${b.projectId}`)[0]!.s;
      const [row] = await sql<{ id: string }[]>`insert into purchase_items (project_id, source, number, designation, manufacturer, manufacturer_no, supplier_id, supplier_order_no,
        qty, unit, unit_price, note, status, sort, wh_article_id, created_by)
        values (${b.projectId}, 'manual', ${a.number}, ${a.name}, ${a.manufacturer}, ${a.manufacturer_no}, ${a.supplier_id}, ${a.supplier_no}, ${it.qty}, ${a.unit},
          ${a.purchase_price}, 'Lagernachschub', 'open', ${s}, ${it.articleId}, ${u.id}) returning id`;
      ids.push(row!.id);
    }
    ctx.hub.publish(`project:${b.projectId}`, 'purchasing.changed', {});
    changed();
    return { created: ids.length };
  });

  // ------------------------------------------------ Inventur
  app.get('/warehouse/counts', async (req) => {
    staff(req);
    return sql`select c.id, c.name, c.status, c.created_at as "createdAt", c.done_at as "doneAt", l.name as "locationName", us.display_name as "createdByName",
      (select count(*)::int from wh_count_lines x where x.count_id = c.id) as lines,
      (select count(*)::int from wh_count_lines x where x.count_id = c.id and x.counted is not null) as counted
      from wh_counts c left join wh_locations l on l.id = c.location_id left join users us on us.id = c.created_by order by c.created_at desc limit 100`;
  });
  app.post('/warehouse/counts', async (req) => {
    const u = staff(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(200), locationId: z.string().uuid().nullable().default(null) }), req.body);
    const [open] = await sql`select 1 from wh_counts where status = 'open' and (location_id is null or ${b.locationId}::uuid is null or location_id = ${b.locationId})`;
    if (open) throw badRequest('Für diesen Bereich läuft schon eine Inventur. Bitte erst abschließen.');
    const locs = b.locationId ? await locationSubtree(sql, b.locationId) : null;
    const [c] = await sql<{ id: string }[]>`insert into wh_counts (name, location_id, created_by) values (${b.name}, ${b.locationId}, ${u.id}) returning id`;
    await sql`insert into wh_count_lines (count_id, article_id, location_id, lot, expected)
      select ${c!.id}, s.article_id, s.location_id, s.lot, s.qty from wh_stock s join wh_articles a on a.id = s.article_id
      where s.qty > 0 ${locs ? sql`and s.location_id = any(${locs})` : sql``}`;
    return c;
  });
  app.get('/warehouse/counts/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [c] = await sql`select c.id, c.name, c.status, c.location_id as "locationId", l.name as "locationName", c.created_at as "createdAt", c.done_at as "doneAt"
      from wh_counts c left join wh_locations l on l.id = c.location_id where c.id = ${id}`;
    if (!c) throw notFound();
    const lines = await sql`select x.id, x.article_id as "articleId", a.number, a.name, a.unit, a.barcode, x.location_id as "locationId", l.name as "locationName", l.code as "locationCode",
      x.lot, x.expected::float as expected, x.counted::float as counted, us.display_name as "countedBy", x.counted_at as "countedAt"
      from wh_count_lines x join wh_articles a on a.id = x.article_id join wh_locations l on l.id = x.location_id left join users us on us.id = x.counted_by
      where x.count_id = ${id} order by l.name, a.number, x.lot`;
    return { ...c, lines };
  });
  async function openCount(id: string) {
    const [c] = await sql<{ status: string }[]>`select status from wh_counts where id = ${id}`;
    if (!c) throw notFound();
    if (c.status !== 'open') throw badRequest('Diese Inventur ist abgeschlossen.');
  }
  app.put('/warehouse/counts/:id/lines/:lineId', async (req) => {
    const u = staff(req);
    const p = parse(z.object({ id: z.string().uuid(), lineId: z.string().uuid() }), req.params);
    await openCount(p.id);
    const { counted } = parse(z.object({ counted: z.number().min(0).nullable() }), req.body);
    await sql`update wh_count_lines set counted = ${counted}, counted_by = ${counted === null ? null : u.id}, counted_at = ${counted === null ? null : sql`now()`} where id = ${p.lineId} and count_id = ${p.id}`;
    ctx.hub.publish('global', 'warehouse.count', { id: p.id });
    return { ok: true };
  });
  /** gefundener Artikel, der laut Bestand nicht dort sein sollte */
  app.post('/warehouse/counts/:id/lines', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    await openCount(id);
    const b = parse(z.object({ articleId: z.string().uuid(), locationId: z.string().uuid(), lot: z.string().trim().max(120).default(''), counted: z.number().min(0) }), req.body);
    const [r] = await sql<{ id: string }[]>`insert into wh_count_lines (count_id, article_id, location_id, lot, expected, counted, counted_by, counted_at)
      values (${id}, ${b.articleId}, ${b.locationId}, ${b.lot}, 0, ${b.counted}, ${u.id}, now())
      on conflict (count_id, article_id, location_id, lot) do update set counted = excluded.counted, counted_by = excluded.counted_by, counted_at = now() returning id`;
    ctx.hub.publish('global', 'warehouse.count', { id });
    return r;
  });
  /** Abschließen: Differenzen werden als Inventurkorrektur gebucht; ungezählte Positionen bleiben unverändert */
  app.post('/warehouse/counts/:id/finish', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    await openCount(id);
    const lines = await sql<{ article_id: string; location_id: string; lot: string; counted: string }[]>`
      select article_id, location_id, lot, counted from wh_count_lines where count_id = ${id} and counted is not null`;
    let changes = 0;
    for (const l of lines) {
      const [s] = await sql<{ qty: string }[]>`select qty from wh_stock where article_id = ${l.article_id} and location_id = ${l.location_id} and lot = ${l.lot}`;
      const diff = Number(l.counted) - Number(s?.qty ?? 0);
      if (Math.abs(diff) < 1e-9) continue;
      await bookMove(sql, u, { kind: 'adjust', articleId: l.article_id, qty: Math.abs(diff), lot: l.lot, countId: id, note: 'Inventur',
        ...(diff > 0 ? { toLocationId: l.location_id } : { fromLocationId: l.location_id }) });
      changes++;
    }
    await sql`update wh_counts set status = 'done', done_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'warehouse.count', entityType: 'wh_count', entityId: id, summary: `Inventur abgeschlossen, ${changes} Korrektur(en)` });
    changed();
    return { ok: true, changes };
  });
  app.delete('/warehouse/counts/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    await openCount(id);
    await sql`update wh_counts set status = 'cancelled', done_at = now() where id = ${id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Export
  app.get('/warehouse/export.xlsx', async (req, reply) => {
    staff(req);
    const rows = await sql<{ number: string; name: string; category: string; location: string | null; lot: string; qty: string | null; unit: string; price: string | null; min_qty: string }[]>`
      select a.number, a.name, a.category, l.name as location, coalesce(s.lot, '') as lot, s.qty, a.unit, a.purchase_price as price, a.min_qty
      from wh_articles a left join wh_stock s on s.article_id = a.id and s.qty > 0 left join wh_locations l on l.id = s.location_id
      where a.active order by a.number, l.name, s.lot`;
    const head = ['Artikel-Nr.', 'Bezeichnung', 'Kategorie', 'Lagerort', 'Charge/Seriennr.', 'Menge', 'Einheit', 'Einkaufspreis', 'Wert', 'Mindestbestand'];
    const data = rows.map((r) => [r.number, r.name, r.category, r.location ?? '', r.lot, n(r.qty) ?? 0, r.unit, n(r.price) ?? '', (n(r.qty) ?? 0) * (n(r.price) ?? 0), n(r.min_qty) ?? 0]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Lagerbestand_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return writeXlsx([{ name: 'Lagerbestand', widths: [14, 36, 16, 20, 18, 10, 8, 14, 14, 12], rows: [head, ...data] }]);
  });

}
