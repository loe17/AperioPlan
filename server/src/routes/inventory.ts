/**
 * Inventar: Geräte, Maschinen und Ausstattung mit Inventarnummer, QR-Etikett, Standort, Verantwortlichen,
 * Prüfterminen (z. B. DGUV V3), Abschreibung, Übergaben mit Protokoll und Inventur per Scan.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addMonths, ASSET_STATUS, bookValue, depreciationSchedule } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { safeName } from '../services/files';
import { writeXlsx } from '../lib/xlsx';
import { Pdf } from '../lib/pdf';
import { sendStoredFile } from './files';

const assetBody = z.object({
  number: z.string().trim().max(60).default(''),
  name: z.string().trim().min(1).max(300),
  category: z.string().trim().max(100).default(''),
  manufacturer: z.string().max(120).default(''),
  model: z.string().max(120).default(''),
  serialNo: z.string().max(120).default(''),
  location: z.string().max(200).default(''),
  holderId: z.string().uuid().nullable().default(null),
  teamId: z.string().uuid().nullable().default(null),
  resourceId: z.string().uuid().nullable().default(null),
  supplierId: z.string().uuid().nullable().default(null),
  purchaseDate: z.string().date().nullable().default(null),
  purchasePrice: z.number().min(0).nullable().default(null),
  warrantyUntil: z.string().date().nullable().default(null),
  depreciationYears: z.number().min(0).max(100).nullable().default(null),
  status: z.enum(['active', 'repair', 'retired', 'lost']).default('active'),
  notes: z.string().max(10000).default(''),
});
type AssetBody = z.infer<typeof assetBody>;
const COLS: [keyof AssetBody, string][] = [['name', 'name'], ['category', 'category'], ['manufacturer', 'manufacturer'], ['model', 'model'], ['serialNo', 'serial_no'],
  ['location', 'location'], ['holderId', 'holder_id'], ['teamId', 'team_id'], ['resourceId', 'resource_id'], ['supplierId', 'supplier_id'], ['purchaseDate', 'purchase_date'],
  ['purchasePrice', 'purchase_price'], ['warrantyUntil', 'warranty_until'], ['depreciationYears', 'depreciation_years'], ['status', 'status'], ['notes', 'notes']];

export async function inspectionReminders(ctx: AppContext) {
  const { sql } = ctx;
  const { installed } = await ctx.settings.get('apps');
  if (!installed.includes('inventory')) return;
  // 14 Tage vorher und am Fälligkeitstag, jeweils einmal (reminded_for: Tag der letzten Erinnerung)
  const due = await sql<{ id: string; kind: string; next_date: string; asset_id: string; number: string; name: string; responsible_id: string | null; holder_id: string | null; stage: 'early' | 'due' }[]>`
    select i.id, i.kind, i.next_date::text, a.id as asset_id, a.number, a.name, i.responsible_id, a.holder_id,
      case when i.next_date <= current_date then 'due' else 'early' end as stage
    from inv_inspections i join inv_assets a on a.id = i.asset_id
    where a.status in ('active', 'repair') and i.next_date is not null and (
      (i.next_date <= current_date and (i.reminded_for is null or i.reminded_for < i.next_date))
      or (i.next_date > current_date and i.next_date <= current_date + 14 and i.reminded_for is null))`;
  const admins = (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id);
  for (const d of due) {
    const to = [d.responsible_id ?? d.holder_id].filter(Boolean) as string[];
    await notify(ctx, to.length ? to : admins, { kind: 'inventory.inspection', title: `${d.stage === 'due' ? 'Prüfung fällig' : 'Prüfung bald fällig'}: ${d.kind}`,
      body: `${d.number} ${d.name} – fällig am ${new Date(`${d.next_date}T12:00:00`).toLocaleDateString('de-DE')}`, link: `/inventory/${d.asset_id}` });
    await sql`update inv_inspections set reminded_for = ${d.stage === 'due' ? sql`next_date` : sql`current_date`} where id = ${d.id}`;
  }
}

export default async function inventoryRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const staff = (req: Parameters<typeof requireUser>[0]) => { const u = requireUser(req); if (u.role === 'guest') throw forbidden(); return u; };

  const cols = sql`a.id, a.number, a.name, a.category, a.manufacturer, a.model, a.serial_no as "serialNo", a.location, a.holder_id as "holderId", h.display_name as "holderName",
    a.team_id as "teamId", t.name as "teamName", a.resource_id as "resourceId", a.supplier_id as "supplierId", s.name as "supplierName",
    a.purchase_date::text as "purchaseDate", a.purchase_price::float as "purchasePrice", a.warranty_until::text as "warrantyUntil", a.depreciation_years::float as "depreciationYears",
    a.status, a.retired_at::text as "retiredAt", a.notes, a.image_path is not null as "hasImage", a.attachments, a.last_seen_at as "lastSeenAt", ls.display_name as "lastSeenBy",
    (select min(i.next_date)::text from inv_inspections i where i.asset_id = a.id) as "nextInspection", a.updated_at as "updatedAt"`;
  const from = sql`inv_assets a left join users h on h.id = a.holder_id left join teams t on t.id = a.team_id left join crm_accounts s on s.id = a.supplier_id left join users ls on ls.id = a.last_seen_by`;
  const withValue = <T extends { purchasePrice: number | null; purchaseDate: string | null; depreciationYears: number | null }>(r: T) =>
    ({ ...r, bookValue: bookValue(r.purchasePrice, r.purchaseDate, r.depreciationYears) });

  app.get('/inventory/assets', async (req) => {
    staff(req);
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), status: z.string().max(20).optional(), category: z.string().max(100).optional(),
      holderId: z.string().uuid().optional(), due: z.coerce.number().int().min(0).max(365).optional(), notSeenSince: z.string().date().optional() }), req.query);
    const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => '\\' + c)}%` : null;
    const rows = await sql<any[]>`select ${cols} from ${from} where true
      ${q.status ? (q.status === 'all' ? sql`` : sql`and a.status = ${q.status}`) : sql`and a.status in ('active', 'repair')`}
      ${like ? sql`and (a.number ilike ${like} or a.name ilike ${like} or a.serial_no ilike ${like} or a.model ilike ${like} or a.manufacturer ilike ${like} or a.location ilike ${like} or h.display_name ilike ${like})` : sql``}
      ${q.category ? sql`and a.category = ${q.category}` : sql``} ${q.holderId ? sql`and a.holder_id = ${q.holderId}` : sql``}
      ${q.due !== undefined ? sql`and exists (select 1 from inv_inspections i where i.asset_id = a.id and i.next_date <= current_date + ${q.due}::int)` : sql``}
      ${q.notSeenSince ? sql`and (a.last_seen_at is null or a.last_seen_at < ${q.notSeenSince})` : sql``}
      order by a.number limit 5000`;
    return rows.map(withValue);
  });

  app.get('/inventory/assets/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [a] = await sql<any[]>`select ${cols} from ${from} where a.id = ${id}`;
    if (!a) throw notFound('Inventar nicht gefunden');
    const inspections = await sql`select i.id, i.kind, i.interval_months as "intervalMonths", i.last_date::text as "lastDate", i.next_date::text as "nextDate",
      i.responsible_id as "responsibleId", us.display_name as "responsibleName", i.notes,
      coalesce((select json_agg(json_build_object('id', l.id, 'date', l.date::text, 'result', l.result, 'notes', l.notes, 'attachments', l.attachments, 'userName', lu.display_name) order by l.date desc)
        from inv_inspection_log l left join users lu on lu.id = l.user_id where l.inspection_id = i.id), '[]') as log
      from inv_inspections i left join users us on us.id = i.responsible_id where i.asset_id = ${id} order by i.next_date nulls last`;
    const handovers = await sql`select h.id, h.date::text, h.note, h.confirmed_at as "confirmedAt", f.display_name as "fromName", t.display_name as "toName", h.to_user_id as "toUserId"
      from inv_handovers h left join users f on f.id = h.from_user_id left join users t on t.id = h.to_user_id where h.asset_id = ${id} order by h.created_at desc`;
    return { ...withValue(a), inspections, handovers, depreciation: depreciationSchedule(a.purchasePrice, a.purchaseDate, a.depreciationYears) };
  });

  async function assetNumber(given: string) {
    if (given) {
      const [dup] = await sql`select 1 from inv_assets where number = ${given}`;
      if (dup) throw badRequest(`Die Inventarnummer ${given} gibt es schon.`);
      return given;
    }
    const nums = await ctx.settings.get('numbers');
    return nextNumber(sql, 'asset', nums.asset, async (x) => (await sql`select 1 from inv_assets where number = ${x}`).length > 0);
  }

  app.post('/inventory/assets', async (req) => {
    const u = staff(req);
    const b = parse(assetBody, req.body);
    const id = randomUUID();
    const number = await assetNumber(b.number);
    await sql`insert into inv_assets (id, number, name, category, manufacturer, model, serial_no, location, holder_id, team_id, resource_id, supplier_id,
      purchase_date, purchase_price, warranty_until, depreciation_years, status, notes, created_by)
      values (${id}, ${number}, ${b.name}, ${b.category}, ${b.manufacturer}, ${b.model}, ${b.serialNo}, ${b.location}, ${b.holderId}, ${b.teamId}, ${b.resourceId}, ${b.supplierId},
        ${b.purchaseDate}, ${b.purchasePrice}, ${b.warrantyUntil}, ${b.depreciationYears}, ${b.status}, ${b.notes}, ${u.id})`;
    await audit(sql, u, { action: 'inventory.create', entityType: 'inv_asset', entityId: id, summary: `Inventar angelegt: ${number} ${b.name}` });
    return { id, number };
  });

  app.patch('/inventory/assets/:id', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(assetBody.partial(), req.body);
    const [cur] = await sql<{ number: string; status: string }[]>`select number, status from inv_assets where id = ${id}`;
    if (!cur) throw notFound();
    if (b.number && b.number !== cur.number) await assetNumber(b.number);
    const sets = COLS.filter(([k]) => b[k] !== undefined).map(([k, c]) => sql`${sql(c)} = ${b[k] as never}`);
    if (b.number && b.number !== cur.number) sets.push(sql`number = ${b.number}`);
    if (b.status && b.status !== cur.status) sets.push(sql`retired_at = ${b.status === 'retired' || b.status === 'lost' ? sql`current_date` : null}`);
    if (sets.length) {
      let q = sql`update inv_assets set updated_at = now()`;
      for (const s of sets) q = sql`${q}, ${s}`;
      await sql`${q} where id = ${id}`;
    }
    if (b.status && b.status !== cur.status) await audit(sql, u, { action: 'inventory.status', entityType: 'inv_asset', entityId: id, summary: `${cur.number}: ${ASSET_STATUS[b.status]}` });
    return { ok: true };
  });

  app.delete('/inventory/assets/:id', async (req) => {
    const u = staff(req);
    if (u.role !== 'admin') throw forbidden('Inventar löschen dürfen nur Administratoren – bitte stattdessen ausmustern.');
    const { id } = parse(idParam, req.params);
    const [a] = await sql<{ number: string }[]>`delete from inv_assets where id = ${id} returning number`;
    if (a) await storage.remove(`.aperio/inventory/${id}`).catch(() => {});
    await audit(sql, u, { action: 'inventory.delete', entityType: 'inv_asset', entityId: id, summary: `Inventar gelöscht: ${a?.number}` });
    return { ok: true };
  });

  app.post('/inventory/assets/:id/duplicate', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [a] = await sql<any[]>`select * from inv_assets where id = ${id}`;
    if (!a) throw notFound();
    const nid = randomUUID();
    const number = await assetNumber('');
    await sql`insert into inv_assets (id, number, name, category, manufacturer, model, location, team_id, supplier_id, purchase_date, purchase_price, warranty_until, depreciation_years, notes, created_by)
      values (${nid}, ${number}, ${a.name}, ${a.category}, ${a.manufacturer}, ${a.model}, ${a.location}, ${a.team_id}, ${a.supplier_id}, ${a.purchase_date}, ${a.purchase_price},
        ${a.warranty_until}, ${a.depreciation_years}, ${a.notes}, ${u.id})`;
    await sql`insert into inv_inspections (asset_id, kind, interval_months, next_date, responsible_id, notes)
      select ${nid}, kind, interval_months, next_date, responsible_id, notes from inv_inspections where asset_id = ${id}`;
    return { id: nid, number };
  });

  /** Inventur per Scan: „gesehen“ */
  app.post('/inventory/assets/:id/seen', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ location: z.string().max(200).optional() }), req.body ?? {});
    const [a] = await sql`update inv_assets set last_seen_at = now(), last_seen_by = ${u.id}, location = coalesce(${b.location ?? null}, location) where id = ${id} returning id`;
    if (!a) throw notFound();
    return { ok: true };
  });

  app.get('/inventory/lookup', async (req) => {
    staff(req);
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(500) }), req.query);
    const m = code.match(/\/inventory\/([0-9a-f-]{36})/);
    if (m) return { id: m[1] };
    const [a] = await sql<{ id: string }[]>`select id from inv_assets where number = ${code} or (serial_no <> '' and serial_no = ${code}) limit 1`;
    if (!a) throw notFound(`Kein Inventar zu „${code}“.`);
    return a;
  });

  // ------------------------------------------------ Bild und Dateien
  app.post('/inventory/assets/:id/files', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ image: z.coerce.boolean().optional() }), req.query);
    const [a] = await sql<{ attachments: { name: string; path: string; size: number }[]; image_path: string | null }[]>`select attachments, image_path from inv_assets where id = ${id}`;
    if (!a) throw notFound();
    const out: { name: string; path: string; size: number }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const path = `.aperio/inventory/${id}/${randomUUID().slice(0, 8)}_${name}`;
      const r = await storage.write(path, part.file);
      if (r.size > 30 * 1024 * 1024) { await storage.remove(path).catch(() => {}); throw badRequest('Datei größer als 30 MB'); }
      out.push({ name, path, size: r.size });
    }
    if (q.image) {
      if (!out[0] || !/\.(png|jpe?g|webp|gif)$/i.test(out[0].name)) throw badRequest('Bitte ein Bild wählen.');
      await sql`update inv_assets set image_path = ${out[0].path} where id = ${id}`;
      if (a.image_path) await storage.remove(a.image_path).catch(() => {});
    } else {
      await sql`update inv_assets set attachments = ${sql.json([...a.attachments, ...out] as never)}, updated_at = now() where id = ${id}`;
    }
    return out;
  });
  app.delete('/inventory/assets/:id/files', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const { path } = parse(z.object({ path: z.string().max(500) }), req.query);
    const [a] = await sql<{ attachments: { path: string }[] }[]>`select attachments from inv_assets where id = ${id}`;
    if (!a) throw notFound();
    await sql`update inv_assets set attachments = ${sql.json(a.attachments.filter((x) => x.path !== path) as never)} where id = ${id}`;
    if (path.startsWith(`.aperio/inventory/${id}/`)) await storage.remove(path).catch(() => {});
    return { ok: true };
  });
  app.get('/inventory/file', async (req, reply) => {
    staff(req);
    const { path } = parse(z.object({ path: z.string().regex(/^\.aperio\/inventory\/[0-9a-f-]{36}\/[^/]+$/).max(500) }), req.query);
    return sendStoredFile(ctx, reply, path, path.split('/').pop()!.replace(/^[0-9a-f]{8}_/, ''), /\.(png|jpe?g|webp|gif|pdf)$/i.test(path));
  });
  app.get('/inventory/assets/:id/image', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [a] = await sql<{ image_path: string | null }[]>`select image_path from inv_assets where id = ${id}`;
    if (!a?.image_path) throw notFound();
    return sendStoredFile(ctx, reply, a.image_path, a.image_path.split('/').pop()!, true);
  });

  // ------------------------------------------------ Prüfungen
  const inspBody = z.object({ kind: z.string().trim().min(1).max(120), intervalMonths: z.number().int().min(1).max(240).default(12),
    lastDate: z.string().date().nullable().default(null), nextDate: z.string().date().nullable().default(null),
    responsibleId: z.string().uuid().nullable().default(null), notes: z.string().max(5000).default('') });
  app.post('/inventory/assets/:id/inspections', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(inspBody, req.body);
    const next = b.nextDate ?? (b.lastDate ? addMonths(b.lastDate, b.intervalMonths) : new Date().toISOString().slice(0, 10));
    const [r] = await sql`insert into inv_inspections (asset_id, kind, interval_months, last_date, next_date, responsible_id, notes)
      values (${id}, ${b.kind}, ${b.intervalMonths}, ${b.lastDate}, ${next}, ${b.responsibleId}, ${b.notes}) returning id`;
    return r;
  });
  app.patch('/inventory/inspections/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(inspBody.partial(), req.body);
    await sql`update inv_inspections set kind = coalesce(${b.kind ?? null}, kind), interval_months = coalesce(${b.intervalMonths ?? null}, interval_months),
      next_date = ${b.nextDate === undefined ? sql`next_date` : b.nextDate}, responsible_id = ${b.responsibleId === undefined ? sql`responsible_id` : b.responsibleId},
      notes = coalesce(${b.notes ?? null}, notes), reminded_for = null where id = ${id}`;
    return { ok: true };
  });
  app.delete('/inventory/inspections/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from inv_inspections where id = ${id}`;
    return { ok: true };
  });
  /** Prüfung durchgeführt: Ergebnis eintragen, nächster Termin = Datum + Intervall */
  app.post('/inventory/inspections/:id/log', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ date: z.string().date(), result: z.enum(['ok', 'defect', 'failed']), notes: z.string().max(5000).default(''),
      attachments: z.array(z.object({ name: z.string(), path: z.string(), size: z.number() })).max(20).default([]) }), req.body);
    const [i] = await sql<{ interval_months: number; asset_id: string; kind: string }[]>`select interval_months, asset_id, kind from inv_inspections where id = ${id}`;
    if (!i) throw notFound();
    if (b.attachments.some((x) => !x.path.startsWith(`.aperio/inventory/${i.asset_id}/`))) throw badRequest('Ungültiger Anhang');
    await sql`insert into inv_inspection_log (inspection_id, date, result, notes, attachments, user_id) values (${id}, ${b.date}, ${b.result}, ${b.notes}, ${sql.json(b.attachments as never)}, ${u.id})`;
    const next = addMonths(b.date, i.interval_months);
    await sql`update inv_inspections set last_date = ${b.date}, next_date = ${next}, reminded_for = null where id = ${id}`;
    if (b.result === 'failed') await sql`update inv_assets set status = 'repair', updated_at = now() where id = ${i.asset_id} and status = 'active'`;
    await audit(sql, u, { action: 'inventory.inspection', entityType: 'inv_asset', entityId: i.asset_id, summary: `${i.kind}: ${b.result === 'ok' ? 'bestanden' : b.result === 'defect' ? 'Mängel' : 'nicht bestanden'}` });
    return { ok: true, nextDate: next };
  });
  app.get('/inventory/inspections', async (req) => {
    staff(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(0).max(730).default(30) }), req.query);
    return sql`select i.id, i.kind, i.next_date::text as "nextDate", i.last_date::text as "lastDate", i.interval_months as "intervalMonths",
      a.id as "assetId", a.number, a.name, a.location, us.display_name as "responsibleName", i.next_date < current_date as overdue
      from inv_inspections i join inv_assets a on a.id = i.asset_id left join users us on us.id = i.responsible_id
      where a.status in ('active', 'repair') and i.next_date <= current_date + ${days}::int order by i.next_date`;
  });

  // ------------------------------------------------ Übergaben
  app.post('/inventory/assets/:id/handover', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ toUserId: z.string().uuid().nullable(), note: z.string().max(2000).default(''), date: z.string().date().optional(), location: z.string().max(200).optional() }), req.body);
    const [a] = await sql<{ holder_id: string | null; number: string; name: string }[]>`select holder_id, number, name from inv_assets where id = ${id}`;
    if (!a) throw notFound();
    const [h] = await sql<{ id: string }[]>`insert into inv_handovers (asset_id, from_user_id, to_user_id, date, note, created_by)
      values (${id}, ${a.holder_id}, ${b.toUserId}, ${b.date ?? new Date().toISOString().slice(0, 10)}, ${b.note}, ${u.id}) returning id`;
    await sql`update inv_assets set holder_id = ${b.toUserId}, location = coalesce(${b.location ?? null}, location), updated_at = now() where id = ${id}`;
    if (b.toUserId) await notify(ctx, [b.toUserId], { kind: 'inventory.handover', title: `Übergabe an Sie: ${a.number} ${a.name}`, body: 'Bitte den Empfang bestätigen.', link: `/inventory/${id}` }, u.id);
    await audit(sql, u, { action: 'inventory.handover', entityType: 'inv_asset', entityId: id, summary: `Übergabe ${a.number}` });
    return h;
  });
  app.post('/inventory/handovers/:id/confirm', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [h] = await sql<{ to_user_id: string | null }[]>`select to_user_id from inv_handovers where id = ${id}`;
    if (!h) throw notFound();
    if (h.to_user_id !== u.id) throw forbidden('Nur die empfangende Person kann bestätigen.');
    await sql`update inv_handovers set confirmed_at = coalesce(confirmed_at, now()) where id = ${id}`;
    return { ok: true };
  });
  app.get('/inventory/handovers/:id/pdf', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [h] = await sql<any[]>`select h.date::text, h.note, h.confirmed_at, f.display_name as from_name, t.display_name as to_name,
      a.number, a.name, a.manufacturer, a.model, a.serial_no, a.location from inv_handovers h join inv_assets a on a.id = h.asset_id
      left join users f on f.id = h.from_user_id left join users t on t.id = h.to_user_id where h.id = ${id}`;
    if (!h) throw notFound();
    const company = await ctx.settings.get('company');
    const pdf = new Pdf(`Übergabeprotokoll ${h.number}`, company.name);
    pdf.text(pdf.margin, pdf.y, company.name, { size: 10, color: '#666666' }); pdf.y += 24;
    pdf.text(pdf.margin, pdf.y, 'Übergabeprotokoll', { size: 18, bold: true }); pdf.y += 30;
    pdf.table([{ label: 'Angabe', width: 160 }, { label: 'Wert', width: 335 }], [
      ['Inventarnummer', h.number], ['Gegenstand', h.name], ['Hersteller / Modell', [h.manufacturer, h.model].filter(Boolean).join(' ') || '–'],
      ['Seriennummer', h.serial_no || '–'], ['Standort', h.location || '–'], ['Datum der Übergabe', new Date(`${h.date}T12:00:00`).toLocaleDateString('de-DE')],
      ['Übergeben von', h.from_name ?? '–'], ['Übernommen von', h.to_name ?? 'zurück an die Firma'],
    ]);
    pdf.y += 10;
    if (h.note) pdf.paragraph(`Bemerkung: ${h.note}`);
    pdf.y += 10;
    pdf.paragraph('Der Empfänger bestätigt, den Gegenstand in ordnungsgemäßem Zustand erhalten zu haben, und verpflichtet sich zu sorgfältigem Umgang.', { size: 9 });
    pdf.y += 40;
    if (h.confirmed_at) pdf.paragraph(`Empfang in AperioPlan bestätigt am ${new Date(h.confirmed_at).toLocaleString('de-DE')} durch ${h.to_name}.`, { size: 9 });
    else {
      pdf.line(pdf.margin, pdf.y, pdf.margin + 200, pdf.y); pdf.line(pdf.margin + 280, pdf.y, pdf.margin + 480, pdf.y); pdf.y += 6;
      pdf.text(pdf.margin, pdf.y, 'Übergeben (Datum, Unterschrift)', { size: 8 }); pdf.text(pdf.margin + 280, pdf.y, 'Übernommen (Datum, Unterschrift)', { size: 8 });
    }
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Uebergabe_${h.number}.pdf"`);
    return pdf.toBuffer();
  });

  // ------------------------------------------------ Anlagenverzeichnis
  app.get('/inventory/export.xlsx', async (req, reply) => {
    staff(req);
    const rows = await sql<any[]>`select ${cols} from ${from} order by a.number`;
    const year = new Date().getFullYear();
    const head = ['Inventar-Nr.', 'Bezeichnung', 'Kategorie', 'Hersteller', 'Modell', 'Seriennr.', 'Standort', 'Verantwortlich', 'Status', 'Anschaffung', 'Anschaffungswert',
      'Nutzungsdauer (Jahre)', `AfA ${year}`, `Restbuchwert 31.12.${year}`, 'Nächste Prüfung'];
    const data = rows.map((a) => {
      const sched = depreciationSchedule(a.purchasePrice, a.purchaseDate, a.depreciationYears);
      return [a.number, a.name, a.category, a.manufacturer, a.model, a.serialNo, a.location, a.holderName ?? '', ASSET_STATUS[a.status] ?? a.status,
        a.purchaseDate ?? '', a.purchasePrice ?? '', a.depreciationYears ?? '', sched.find((r) => r.year === year)?.amount ?? 0,
        bookValue(a.purchasePrice, a.purchaseDate, a.depreciationYears) ?? '', a.nextInspection ?? ''];
    });
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Anlagenverzeichnis_${year}.xlsx"`);
    return writeXlsx([{ name: 'Inventar', widths: [12, 30, 14, 14, 14, 14, 18, 18, 12, 12, 14, 10, 12, 14, 12], rows: [head, ...data] }]);
  });

}
