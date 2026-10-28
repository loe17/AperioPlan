/**
 * Qualität: Prüfpläne mit Merkmalen, Prüfungen mit Messwerten und Protokoll, Messmittel mit Kalibrierfristen, 8D-Reports.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EIGHT_D, EIGHT_D_STATUS, evaluateCharacteristic, evaluateInspection, INSPECTION_KIND, stats, type Characteristic } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { safeName } from '../services/files';
import { staffOf, toRow } from '../lib/rows';
import { Pdf } from '../lib/pdf';

const charSchema = z.object({
  id: z.string().min(1).max(40), name: z.string().trim().min(1).max(200), kind: z.enum(['measure', 'attribute']),
  nominal: z.number().nullable().optional(), lower: z.number().nullable().optional(), upper: z.number().nullable().optional(), unit: z.string().max(20).optional(),
  method: z.string().max(200).optional(), values: z.array(z.union([z.number(), z.boolean(), z.null()])).max(500).optional(), note: z.string().max(1000).optional(),
});
const planBody = z.object({ title: z.string().trim().min(1).max(200), object: z.string().max(300).default(''), articleId: z.string().uuid().nullable().default(null),
  characteristics: z.array(charSchema).max(200).default([]), sample: z.string().max(300).default(''), active: z.boolean().default(true) });
const inspectionBody = z.object({
  planId: z.string().uuid().nullable().default(null), title: z.string().trim().min(1).max(200), kind: z.enum(['incoming', 'production', 'final', 'other']).default('incoming'),
  reference: z.string().max(200).default(''), projectId: z.string().uuid().nullable().default(null), supplierId: z.string().uuid().nullable().default(null), lot: z.string().max(100).default(''),
  qty: z.number().nullable().default(null), characteristics: z.array(charSchema).max(200).default([]), result: z.enum(['open', 'pass', 'fail', 'conditional']).optional(), notes: z.string().max(10000).default(''),
});
const gaugeBody = z.object({ name: z.string().trim().min(1).max(200), kind: z.string().max(100).default(''), manufacturer: z.string().max(100).default(''), serialNo: z.string().max(100).default(''),
  range: z.string().max(100).default(''), resolution: z.string().max(50).default(''), location: z.string().max(200).default(''), holderId: z.string().uuid().nullable().default(null),
  intervalMonths: z.number().int().min(1).max(120).default(12), nextDue: z.string().date().nullable().default(null), status: z.enum(['ok', 'blocked', 'retired']).default('ok'), notes: z.string().max(5000).default('') });
const eightBody = z.object({ title: z.string().trim().min(1).max(200), source: z.enum(['customer', 'supplier', 'internal']).default('customer'), accountId: z.string().uuid().nullable().default(null),
  projectId: z.string().uuid().nullable().default(null), reference: z.string().max(200).default(''), status: z.enum(['open', 'containment', 'analysis', 'actions', 'verification', 'closed']).default('open'),
  ownerId: z.string().uuid().nullable().default(null), team: z.array(z.string().uuid()).max(30).default([]), d: z.record(z.string(), z.string().max(20000)).default({}), dueDate: z.string().date().nullable().default(null) });

const addMonths = (d: string, m: number) => { const x = new Date(`${d}T12:00:00Z`); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + m); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };

export async function qualityDaily(ctx: AppContext) {
  const { sql } = ctx;
  if (!(await ctx.settings.get('apps')).installed.includes('quality')) return;
  const due = await sql<{ id: string; number: string; name: string; next_due: string; holder_id: string | null; stage: string }[]>`select id, number, name, next_due::text, holder_id,
      case when next_due <= current_date then 'due' else 'early' end as stage from qm_gauges
    where status = 'ok' and next_due is not null and ((next_due <= current_date and (reminded_for is null or reminded_for < next_due)) or (next_due > current_date and next_due <= current_date + 14 and reminded_for is null))`;
  const admins = (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id);
  for (const g of due) {
    await notify(ctx, g.holder_id ? [g.holder_id] : admins, { kind: 'quality.gauge', title: `${g.stage === 'due' ? 'Kalibrierung fällig' : 'Kalibrierung bald fällig'}: ${g.name}`,
      body: `${g.number} – fällig am ${new Date(`${g.next_due}T12:00:00`).toLocaleDateString('de-DE')}`, link: `/quality?tab=gauges&gauge=${g.id}` });
    await sql`update qm_gauges set reminded_for = ${g.stage === 'due' ? sql`next_due` : sql`current_date`} where id = ${g.id}`;
  }
}

export default async function qualityRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const changed = () => ctx.hub.publish('global', 'quality.changed', {});
  const num = async (key: string, def: string, table: string) => nextNumber(sql, key, (await ctx.settings.get('numbers'))[key] ?? def, async (n) => (await sql`select 1 from ${sql(table)} where number = ${n}`).length > 0);

  app.get('/quality/overview', async (req) => {
    staffOf(req);
    const [k] = await sql`select (select count(*)::int from qm_inspections where result = 'open') as "openInspections",
      (select count(*)::int from qm_inspections where result = 'fail' and created_at > now() - interval '30 days') as "failed30",
      (select count(*)::int from qm_inspections where created_at > now() - interval '30 days') as "inspections30",
      (select count(*)::int from qm_gauges where status = 'ok' and next_due < current_date) as "gaugesOverdue",
      (select count(*)::int from qm_gauges where status = 'ok' and next_due between current_date and current_date + 30) as "gaugesDue30",
      (select count(*)::int from qm_8d where status <> 'closed') as "open8d"`;
    return k;
  });

  // ------------------------------------------------ Prüfpläne
  const planCols = sql`p.id, p.number, p.title, p.object, p.article_id as "articleId", w.number as "articleNumber", w.name as "articleName", p.characteristics, p.sample, p.active, p.updated_at as "updatedAt"`;
  app.get('/quality/plans', async (req) => {
    staffOf(req);
    return sql`select ${planCols} from qm_plans p left join wh_articles w on w.id = p.article_id order by p.active desc, p.number`;
  });
  app.post('/quality/plans', async (req) => {
    const u = staffOf(req);
    const b = parse(planBody, req.body);
    const number = await num('qmPlan', 'PP-{NNNN}', 'qm_plans');
    const [p] = await sql<{ id: string }[]>`insert into qm_plans ${sql({ ...toRow(sql, b, ['characteristics']), number, created_by: u.id })} returning id`;
    await audit(sql, u, { action: 'quality.plan.create', entityType: 'qm_plan', entityId: p!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: p!.id, number };
  });
  app.patch('/quality/plans/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(planBody), req.body);
    const row = toRow(sql, b, ['characteristics']);
    if (Object.keys(row).length) await sql`update qm_plans set ${sql(row)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'quality.plan.update', entityType: 'qm_plan', entityId: id, summary: Object.keys(b).join(', ') });
    changed();
    return { ok: true };
  });
  app.delete('/quality/plans/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from qm_plans where id = ${id}`;
    await audit(sql, u, { action: 'quality.plan.delete', entityType: 'qm_plan', entityId: id, summary: 'Prüfplan gelöscht' });
    changed();
    return { ok: true };
  });

  // ------------------------------------------------ Prüfungen
  const inspCols = sql`i.id, i.number, i.plan_id as "planId", p.number as "planNumber", i.title, i.kind, i.reference, i.project_id as "projectId", pr.number as "projectNumber",
    i.supplier_id as "supplierId", s.name as "supplierName", i.lot, i.qty::float as qty, i.characteristics, i.result, i.notes, i.inspector_id as "inspectorId", u.display_name as "inspectorName",
    i.inspected_at as "inspectedAt", i.created_at as "createdAt"`;
  const inspFrom = sql`qm_inspections i left join qm_plans p on p.id = i.plan_id left join projects pr on pr.id = i.project_id left join crm_accounts s on s.id = i.supplier_id left join users u on u.id = i.inspector_id`;
  app.get('/quality/inspections', async (req) => {
    staffOf(req);
    const q = parse(z.object({ result: z.string().max(20).optional(), q: z.string().max(100).optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${inspCols} from ${inspFrom} where true ${q.result ? sql`and i.result = ${q.result}` : sql``}
      ${like ? sql`and (i.number ilike ${like} or i.title ilike ${like} or i.reference ilike ${like} or i.lot ilike ${like} or s.name ilike ${like})` : sql``}
      order by (i.result = 'open') desc, i.created_at desc limit 1000`;
  });
  app.get('/quality/inspections/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [i] = await sql`select ${inspCols} from ${inspFrom} where i.id = ${id}`;
    if (!i) throw notFound('Prüfung nicht gefunden');
    return i;
  });
  app.post('/quality/inspections', async (req) => {
    const u = staffOf(req);
    const b = parse(inspectionBody, req.body);
    let chars = b.characteristics as Characteristic[];
    if (b.planId && !chars.length) {
      const [p] = await sql<{ characteristics: Characteristic[] }[]>`select characteristics from qm_plans where id = ${b.planId}`;
      if (!p) throw notFound('Prüfplan nicht gefunden');
      chars = p.characteristics.map((c) => ({ ...c, values: [] }));
    }
    const number = await num('inspection', 'PR-{JJJJ}-{NNNN}', 'qm_inspections');
    const [i] = await sql<{ id: string }[]>`insert into qm_inspections ${sql({ ...toRow(sql, { ...b, characteristics: chars, result: evaluateInspection(chars) }, ['characteristics']), number, inspector_id: u.id })} returning id`;
    await audit(sql, u, { action: 'quality.inspection.create', entityType: 'qm_inspection', entityId: i!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: i!.id, number };
  });
  app.patch('/quality/inspections/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(inspectionBody), req.body);
    const row = toRow(sql, b, ['characteristics']);
    // Ergebnis automatisch aus den Merkmalen, außer es wird ausdrücklich gesetzt („mit Auflage freigegeben“)
    if (b.characteristics && !b.result) row.result = evaluateInspection(b.characteristics as Characteristic[]);
    if (row.result && row.result !== 'open') { row.inspected_at = sql`coalesce(inspected_at, now())`; row.inspector_id = u.id; }
    if (Object.keys(row).length) await sql`update qm_inspections set ${sql(row)} where id = ${id}`;
    const [i] = await sql<{ result: string; number: string; title: string; supplier_id: string | null }[]>`select result, number, title, supplier_id from qm_inspections where id = ${id}`;
    if (!i) throw notFound();
    if (row.result === 'fail') {
      const admins = (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id);
      await notify(ctx, admins, { kind: 'quality.fail', title: `Prüfung nicht in Ordnung: ${i.title}`, body: i.number, link: `/quality?tab=inspections&inspection=${id}` }, u.id);
    }
    await audit(sql, u, { action: 'quality.inspection.update', entityType: 'qm_inspection', entityId: id, summary: `${i.number}: ${Object.keys(b).join(', ')}` });
    changed();
    return { ok: true, result: i.result };
  });
  app.delete('/quality/inspections/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from qm_inspections where id = ${id}`;
    await audit(sql, u, { action: 'quality.inspection.delete', entityType: 'qm_inspection', entityId: id, summary: 'Prüfung gelöscht' });
    changed();
    return { ok: true };
  });
  const fmtN = (n: number | null | undefined, digits = 3) => (n === null || n === undefined ? '' : n.toLocaleString('de-DE', { maximumFractionDigits: digits }));
  app.get('/quality/inspections/:id/pdf', async (req, reply) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [i] = await sql<any[]>`select ${inspCols} from ${inspFrom} where i.id = ${id}`;
    if (!i) throw notFound();
    const company = (await ctx.settings.get('company')).name;
    const pdf = new Pdf(`Prüfprotokoll ${i.number}`, company);
    pdf.paragraph(`Prüfprotokoll ${i.number}`, { size: 16, bold: true, gap: 4 });
    pdf.paragraph(i.title, { size: 12, gap: 10 });
    const RES: Record<string, string> = { open: 'offen', pass: 'in Ordnung', fail: 'nicht in Ordnung', conditional: 'mit Auflage freigegeben' };
    pdf.table([{ label: '', width: 120 }, { label: '', width: 375 }], [
      ['Prüfart', INSPECTION_KIND[i.kind] ?? i.kind], ['Prüfplan', i.planNumber ?? '–'], ['Bezug', [i.reference, i.projectNumber, i.supplierName].filter(Boolean).join(' · ') || '–'],
      ['Charge / Menge', [i.lot, i.qty !== null ? fmtN(i.qty) : ''].filter(Boolean).join(' / ') || '–'], ['Prüfer', i.inspectorName ?? '–'],
      ['Datum', i.inspectedAt ? new Date(i.inspectedAt).toLocaleDateString('de-DE') : '–'], [{ text: 'Ergebnis', bold: true }, { text: RES[i.result] ?? i.result, bold: true }],
    ]);
    pdf.paragraph('Merkmale', { bold: true, gap: 4 });
    pdf.table([{ label: 'Merkmal', width: 150 }, { label: 'Soll / Toleranz', width: 105 }, { label: 'Messwerte', width: 150 }, { label: 'Mittel / Cpk', width: 50 }, { label: 'Erg.', width: 40 }],
      (i.characteristics as Characteristic[]).map((c) => {
        const st = stats(c);
        const tol = c.kind === 'attribute' ? 'i. O. / n. i. O.' : `${fmtN(c.nominal)} ${c.unit ?? ''} (${fmtN(c.lower)} … ${fmtN(c.upper)})`;
        const vals = (c.values ?? []).map((v) => (typeof v === 'boolean' ? (v ? 'i. O.' : 'n. i. O.') : fmtN(v as number))).filter(Boolean).join('; ');
        const r = evaluateCharacteristic(c);
        return [c.name + (c.method ? ` (${c.method})` : ''), tol, vals || '–', st ? `${fmtN(st.mean)}${st.cpk !== null ? ` / ${fmtN(st.cpk, 2)}` : ''}` : '', r === 'pass' ? 'i. O.' : r === 'fail' ? 'n. i. O.' : 'offen'];
      }), { size: 8 });
    if (i.notes) { pdf.paragraph('Bemerkungen', { bold: true, gap: 2 }); pdf.paragraph(i.notes); }
    pdf.footer((p, n) => `${company} · ${i.number} · Seite ${p} von ${n}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${i.number}.pdf"`);
    return reply.send(pdf.toBuffer());
  });

  // ------------------------------------------------ Messmittel
  const gaugeCols = sql`g.id, g.number, g.name, g.kind, g.manufacturer, g.serial_no as "serialNo", g.range, g.resolution, g.location, g.holder_id as "holderId", u.display_name as "holderName",
    g.interval_months as "intervalMonths", g.next_due::text as "nextDue", g.status, g.notes, (g.status = 'ok' and g.next_due < current_date) as overdue,
    (select max(date)::text from qm_calibrations c where c.gauge_id = g.id) as "lastCalibration"`;
  app.get('/quality/gauges', async (req) => {
    staffOf(req);
    return sql`select ${gaugeCols} from qm_gauges g left join users u on u.id = g.holder_id order by (g.status = 'retired'), g.next_due nulls last, g.number`;
  });
  app.get('/quality/gauges/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [g] = await sql`select ${gaugeCols} from qm_gauges g left join users u on u.id = g.holder_id where g.id = ${id}`;
    if (!g) throw notFound();
    const calibrations = await sql`select c.id, c.date::text, c.result, c.by_whom as "byWhom", c.certificate_name as "certificateName", c.certificate_path is not null as "hasCertificate", c.notes,
      u.display_name as "userName" from qm_calibrations c left join users u on u.id = c.user_id where c.gauge_id = ${id} order by c.date desc`;
    return { ...g, calibrations };
  });
  app.post('/quality/gauges', async (req) => {
    const u = staffOf(req);
    const b = parse(gaugeBody, req.body);
    const number = await num('gauge', 'MM-{NNNN}', 'qm_gauges');
    const [g] = await sql<{ id: string }[]>`insert into qm_gauges ${sql({ ...toRow(sql, b), number })} returning id`;
    await audit(sql, u, { action: 'quality.gauge.create', entityType: 'qm_gauge', entityId: g!.id, summary: `${number} ${b.name}` });
    changed();
    return { id: g!.id, number };
  });
  app.patch('/quality/gauges/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(gaugeBody), req.body);
    const row = toRow(sql, b);
    if (b.nextDue !== undefined) row.reminded_for = null;
    if (Object.keys(row).length) await sql`update qm_gauges set ${sql(row)} where id = ${id}`;
    await audit(sql, u, { action: 'quality.gauge.update', entityType: 'qm_gauge', entityId: id, summary: Object.keys(b).join(', ') });
    changed();
    return { ok: true };
  });
  app.delete('/quality/gauges/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from qm_gauges where id = ${id}`;
    await audit(sql, u, { action: 'quality.gauge.delete', entityType: 'qm_gauge', entityId: id, summary: 'Messmittel gelöscht' });
    changed();
    return { ok: true };
  });
  /** Kalibrierung eintragen (mit Zertifikat); bei „in Ordnung“ bzw. „justiert“ verschiebt sich die nächste Fälligkeit */
  app.post('/quality/gauges/:id/calibrations', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [g] = await sql<{ interval_months: number }[]>`select interval_months from qm_gauges where id = ${id}`;
    if (!g) throw notFound();
    const fields: Record<string, string> = {};
    let cert: { path: string; name: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'zertifikat.pdf');
        const path = `.aperio/quality/gauges/${id}/${randomUUID()}-${name}`;
        await storage.write(path, part.file);
        cert = { path, name };
      } else fields[part.fieldname] = String(part.value);
    }
    const b = parse(z.object({ date: z.string().date(), result: z.enum(['ok', 'adjusted', 'failed']), byWhom: z.string().max(200).default(''), notes: z.string().max(2000).default('') }), fields);
    await sql`insert into qm_calibrations (gauge_id, date, result, by_whom, certificate_path, certificate_name, notes, user_id)
      values (${id}, ${b.date}, ${b.result}, ${b.byWhom}, ${cert?.path ?? null}, ${cert?.name ?? null}, ${b.notes}, ${u.id})`;
    if (b.result === 'failed') await sql`update qm_gauges set status = 'blocked' where id = ${id}`;
    else await sql`update qm_gauges set next_due = ${addMonths(b.date, g.interval_months)}, status = 'ok', reminded_for = null where id = ${id}`;
    await audit(sql, u, { action: 'quality.gauge.calibration', entityType: 'qm_gauge', entityId: id, summary: `Kalibrierung ${b.result}` });
    changed();
    return { ok: true };
  });
  app.get('/quality/calibrations/:id/certificate', async (req, reply) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [c] = await sql<{ certificate_path: string | null; certificate_name: string }[]>`select certificate_path, certificate_name from qm_calibrations where id = ${id}`;
    if (!c?.certificate_path) throw notFound();
    reply.header('content-type', /\.pdf$/i.test(c.certificate_name) ? 'application/pdf' : 'application/octet-stream').header('content-disposition', `inline; filename="${encodeURIComponent(c.certificate_name)}"`);
    return reply.send(storage.read(c.certificate_path));
  });

  // ------------------------------------------------ 8D-Reports
  const eightCols = sql`e.id, e.number, e.title, e.source, e.account_id as "accountId", a.name as "accountName", e.project_id as "projectId", p.number as "projectNumber", e.reference, e.status,
    e.owner_id as "ownerId", o.display_name as "ownerName", e.team, e.d, e.due_date::text as "dueDate", e.closed_at as "closedAt", e.created_at as "createdAt", e.updated_at as "updatedAt",
    (e.status <> 'closed' and e.due_date < current_date) as overdue`;
  const eightFrom = sql`qm_8d e left join crm_accounts a on a.id = e.account_id left join projects p on p.id = e.project_id left join users o on o.id = e.owner_id`;
  app.get('/quality/8d', async (req) => {
    staffOf(req);
    return sql`select ${eightCols} from ${eightFrom} order by (e.status = 'closed'), e.created_at desc limit 1000`;
  });
  app.get('/quality/8d/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [e] = await sql`select ${eightCols} from ${eightFrom} where e.id = ${id}`;
    if (!e) throw notFound();
    return e;
  });
  app.post('/quality/8d', async (req) => {
    const u = staffOf(req);
    const b = parse(eightBody, req.body);
    const number = await num('eightD', '8D-{JJJJ}-{NNN}', 'qm_8d');
    const [e] = await sql<{ id: string }[]>`insert into qm_8d ${sql({ ...toRow(sql, { ...b, ownerId: b.ownerId ?? u.id }, ['team', 'd']), number, created_by: u.id })} returning id`;
    await notify(ctx, [...b.team, b.ownerId], { kind: 'quality.8d', title: `8D-Report: ${b.title}`, body: number, link: `/quality?tab=8d&report=${e!.id}` }, u.id);
    await audit(sql, u, { action: 'quality.8d.create', entityType: 'qm_8d', entityId: e!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: e!.id, number };
  });
  app.patch('/quality/8d/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(eightBody), req.body);
    const row = toRow(sql, b, ['team', 'd']);
    if (b.status === 'closed') row.closed_at = sql`coalesce(closed_at, now())`;
    else if (b.status) row.closed_at = null;
    if (b.d) { const [cur] = await sql<{ d: Record<string, string> }[]>`select d from qm_8d where id = ${id}`; if (!cur) throw notFound(); row.d = sql.json({ ...cur.d, ...b.d } as never); }
    if (Object.keys(row).length) await sql`update qm_8d set ${sql(row)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'quality.8d.update', entityType: 'qm_8d', entityId: id, summary: Object.keys(b).join(', ') });
    changed();
    return { ok: true };
  });
  app.delete('/quality/8d/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    if (u.role !== 'admin') throw badRequest('Nur Administratoren löschen 8D-Reports.');
    await sql`delete from qm_8d where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.get('/quality/8d/:id/pdf', async (req, reply) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [e] = await sql<any[]>`select ${eightCols} from ${eightFrom} where e.id = ${id}`;
    if (!e) throw notFound();
    const team = e.team.length ? (await sql<{ display_name: string }[]>`select display_name from users where id = any(${e.team})`).map((x) => x.display_name) : [];
    const company = (await ctx.settings.get('company')).name;
    const pdf = new Pdf(`8D-Report ${e.number}`, company);
    pdf.paragraph(`8D-Report ${e.number}`, { size: 16, bold: true, gap: 4 });
    pdf.paragraph(e.title, { size: 12, gap: 10 });
    pdf.table([{ label: '', width: 120 }, { label: '', width: 375 }], [
      ['Herkunft', { customer: 'Kundenreklamation', supplier: 'Lieferantenreklamation', internal: 'intern' }[e.source as string] ?? e.source], ['Kunde / Lieferant', e.accountName ?? '–'],
      ['Bezug', [e.reference, e.projectNumber].filter(Boolean).join(' · ') || '–'], ['Verantwortlich', e.ownerName ?? '–'], ['Team', team.join(', ') || '–'],
      ['Status', EIGHT_D_STATUS[e.status] ?? e.status], ['Eröffnet', new Date(e.createdAt).toLocaleDateString('de-DE')], ['Abgeschlossen', e.closedAt ? new Date(e.closedAt).toLocaleDateString('de-DE') : '–'],
    ]);
    for (const s of EIGHT_D) {
      pdf.paragraph(s.title, { bold: true, size: 11, gap: 3 });
      pdf.paragraph(e.d[s.key]?.trim() || '–', { gap: 10 });
    }
    pdf.footer((p, n) => `${company} · ${e.number} · Seite ${p} von ${n}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${e.number}.pdf"`);
    return reply.send(pdf.toBuffer());
  });
}
