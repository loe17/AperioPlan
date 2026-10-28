/**
 * Instandhaltung: Wartungspläne je Anlage (aus dem Inventar), Aufträge für geplante Wartung und Störungen,
 * Checklisten, Arbeitszeit, Kosten und Stillstand. Fällige Wartungen werden jeden Morgen zu Aufträgen.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { safeName } from '../services/files';
import { staffOf, toRow, addDays, today } from '../lib/rows';
import { Pdf } from '../lib/pdf';

const check = z.object({ text: z.string().trim().min(1).max(300), done: z.boolean().default(false), note: z.string().max(500).default('') });
const planBody = z.object({
  assetId: z.string().uuid(), title: z.string().trim().min(1).max(200), intervalDays: z.number().int().min(1).max(3650), nextDue: z.string().date(),
  leadDays: z.number().int().min(0).max(90).default(7), checklist: z.array(check).max(100).default([]), responsibleId: z.string().uuid().nullable().default(null),
  estimateMinutes: z.number().int().min(0).max(100000).default(0), active: z.boolean().default(true),
});
const orderBody = z.object({
  assetId: z.string().uuid().nullable().default(null), kind: z.enum(['preventive', 'corrective']).default('corrective'), title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(''), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).default('open'), machineDown: z.boolean().default(false),
  assigneeId: z.string().uuid().nullable().default(null), dueDate: z.string().date().nullable().default(null), checklist: z.array(check).max(100).default([]),
  workMinutes: z.number().int().min(0).max(1000000).default(0), materialCost: z.number().min(0).default(0), externalCost: z.number().min(0).default(0), report: z.string().max(20000).default(''),
});

export async function maintenanceDaily(ctx: AppContext) {
  const { sql } = ctx;
  if (!(await ctx.settings.get('apps')).installed.includes('maintenance')) return;
  const due = await sql<{ id: string; asset_id: string; title: string; next_due: string; checklist: unknown; responsible_id: string | null; number: string; name: string; holder_id: string | null }[]>`
    select p.id, p.asset_id, p.title, p.next_due::text, p.checklist, p.responsible_id, a.number, a.name, a.holder_id from mnt_plans p join inv_assets a on a.id = p.asset_id
    where p.active and a.status in ('active', 'repair') and p.next_due - p.lead_days <= current_date
      and not exists (select 1 from mnt_orders o where o.plan_id = p.id and o.status not in ('done', 'cancelled'))
      and not exists (select 1 from mnt_orders o where o.plan_id = p.id and o.due_date = p.next_due)`;
  const s = await ctx.settings.get('numbers');
  for (const p of due) {
    const number = await nextNumber(sql, 'maintenance', s.maintenance ?? 'IH-{JJJJ}-{NNNN}', async (n) => (await sql`select 1 from mnt_orders where number = ${n}`).length > 0);
    const [o] = await sql<{ id: string }[]>`insert into mnt_orders (number, asset_id, plan_id, kind, title, due_date, checklist, assignee_id)
      values (${number}, ${p.asset_id}, ${p.id}, 'preventive', ${p.title}, ${p.next_due}, ${sql.json(p.checklist as never)}, ${p.responsible_id}) returning id`;
    await notify(ctx, [p.responsible_id ?? p.holder_id], { kind: 'maintenance.due', title: `Wartung fällig: ${p.title}`, body: `${p.number} ${p.name} – bis ${new Date(`${p.next_due}T12:00:00`).toLocaleDateString('de-DE')}`, link: `/maintenance?order=${o!.id}` });
  }
}

export default async function maintenanceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const changed = () => ctx.hub.publish('global', 'maintenance.changed', {});
  const nextNo = async () => nextNumber(sql, 'maintenance', (await ctx.settings.get('numbers')).maintenance ?? 'IH-{JJJJ}-{NNNN}', async (n) => (await sql`select 1 from mnt_orders where number = ${n}`).length > 0);

  const orderCols = sql`o.id, o.number, o.asset_id as "assetId", a.number as "assetNumber", a.name as "assetName", a.location as "assetLocation", o.plan_id as "planId", o.kind, o.title, o.description,
    o.priority, o.status, o.machine_down as "machineDown", o.reported_by as "reportedBy", rb.display_name as "reportedByName", o.assignee_id as "assigneeId", asg.display_name as "assigneeName",
    o.due_date::text as "dueDate", o.checklist, o.started_at as "startedAt", o.finished_at as "finishedAt", o.work_minutes as "workMinutes", o.material_cost::float as "materialCost",
    o.external_cost::float as "externalCost", o.report, o.photos, o.created_at as "createdAt", o.updated_at as "updatedAt",
    (o.status not in ('done', 'cancelled') and o.due_date < current_date) as overdue`;
  const orderFrom = sql`mnt_orders o left join inv_assets a on a.id = o.asset_id left join users rb on rb.id = o.reported_by left join users asg on asg.id = o.assignee_id`;

  app.get('/maintenance/overview', async (req) => {
    staffOf(req);
    const [k] = await sql<{ open: number; overdue: number; down: number; urgent: number; due14: number; doneMonth: number }[]>`select
      (select count(*)::int from mnt_orders where status not in ('done', 'cancelled')) as open,
      (select count(*)::int from mnt_orders where status not in ('done', 'cancelled') and due_date < current_date) as overdue,
      (select count(distinct asset_id)::int from mnt_orders where status not in ('done', 'cancelled') and machine_down) as down,
      (select count(*)::int from mnt_orders where status not in ('done', 'cancelled') and priority = 'urgent') as urgent,
      (select count(*)::int from mnt_plans where active and next_due <= current_date + 14) as due14,
      (select count(*)::int from mnt_orders where status = 'done' and finished_at >= date_trunc('month', now())) as "doneMonth"`;
    const plans = await sql`select p.id, p.title, p.next_due::text as "nextDue", p.interval_days as "intervalDays", a.id as "assetId", a.number as "assetNumber", a.name as "assetName",
      u.display_name as "responsibleName" from mnt_plans p join inv_assets a on a.id = p.asset_id left join users u on u.id = p.responsible_id
      where p.active and p.next_due <= current_date + 30 order by p.next_due limit 50`;
    return { ...k, plans };
  });

  // ------------------------------------------------ Aufträge
  app.get('/maintenance/orders', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ status: z.string().max(20).optional(), assetId: z.string().uuid().optional(), mine: z.coerce.boolean().optional(), q: z.string().max(100).optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${orderCols} from ${orderFrom} where true
      ${q.status === 'active' ? sql`and o.status not in ('done', 'cancelled')` : q.status ? sql`and o.status = ${q.status}` : sql``}
      ${q.assetId ? sql`and o.asset_id = ${q.assetId}` : sql``} ${q.mine ? sql`and o.assignee_id = ${u.id}` : sql``}
      ${like ? sql`and (o.title ilike ${like} or o.number ilike ${like} or a.name ilike ${like} or a.number ilike ${like})` : sql``}
      order by (o.status in ('done', 'cancelled')), case o.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, o.due_date nulls last, o.created_at desc limit 1000`;
  });
  app.get('/maintenance/orders/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [o] = await sql`select ${orderCols} from ${orderFrom} where o.id = ${id}`;
    if (!o) throw notFound('Auftrag nicht gefunden');
    return o;
  });
  /** Störung melden oder Auftrag anlegen – das darf jeder Mitarbeiter */
  app.post('/maintenance/orders', async (req) => {
    const u = staffOf(req);
    const b = parse(orderBody, req.body);
    const number = await nextNo();
    const [o] = await sql<{ id: string }[]>`insert into mnt_orders ${sql({ ...toRow(sql, b, ['checklist']), number, reported_by: u.id })} returning id`;
    if (b.machineDown && b.assetId) await sql`update inv_assets set status = 'repair' where id = ${b.assetId} and status = 'active'`;
    // Verantwortliche informieren: zugewiesene Person, sonst Verantwortlicher des Wartungsplans bzw. Halter der Anlage
    let to: (string | null)[] = [b.assigneeId];
    if (!b.assigneeId && b.assetId) to = (await sql<{ id: string | null }[]>`select coalesce((select responsible_id from mnt_plans where asset_id = ${b.assetId} and responsible_id is not null limit 1), holder_id) as id from inv_assets where id = ${b.assetId}`).map((r) => r.id);
    await notify(ctx, to, { kind: 'maintenance.order', title: `${b.kind === 'corrective' ? 'Störung gemeldet' : 'Wartungsauftrag'}: ${b.title}`, body: `${number}${b.machineDown ? ' – Maschine steht' : ''}`, link: `/maintenance?order=${o!.id}` }, u.id);
    await audit(sql, u, { action: 'maintenance.order.create', entityType: 'mnt_order', entityId: o!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: o!.id, number };
  });
  app.patch('/maintenance/orders/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(orderBody), req.body);
    const [cur] = await sql<{ status: string; plan_id: string | null; asset_id: string | null; assignee_id: string | null; title: string; number: string; machine_down: boolean }[]>`
      select status, plan_id, asset_id, assignee_id, title, number, machine_down from mnt_orders where id = ${id}`;
    if (!cur) throw notFound();
    const row = toRow(sql, b, ['checklist']);
    if (b.status === 'in_progress' && cur.status !== 'in_progress') row.started_at = sql`coalesce(started_at, now())`;
    if (b.status === 'done' && cur.status !== 'done') row.finished_at = sql`now()`;
    if (b.status && b.status !== 'done') row.finished_at = null;
    if (Object.keys(row).length) await sql`update mnt_orders set ${sql(row)}, updated_at = now() where id = ${id}`;
    if (b.status === 'done' && cur.status !== 'done') {
      // Wartungsplan fortschreiben und Anlage wieder freigeben
      if (cur.plan_id) await sql`update mnt_plans set next_due = current_date + interval_days where id = ${cur.plan_id}`;
      if (cur.asset_id) {
        const [open] = await sql`select 1 from mnt_orders where asset_id = ${cur.asset_id} and machine_down and status not in ('done', 'cancelled')`;
        if (!open) await sql`update inv_assets set status = 'active' where id = ${cur.asset_id} and status = 'repair'`;
      }
    }
    if (b.assigneeId && b.assigneeId !== cur.assignee_id) await notify(ctx, [b.assigneeId], { kind: 'maintenance.order', title: `Auftrag zugewiesen: ${cur.title}`, body: cur.number, link: `/maintenance?order=${id}` }, u.id);
    if (b.machineDown && cur.asset_id) await sql`update inv_assets set status = 'repair' where id = ${cur.asset_id} and status = 'active'`;
    await audit(sql, u, { action: 'maintenance.order.update', entityType: 'mnt_order', entityId: id, summary: `${cur.number}: ${Object.keys(b).join(', ')}` });
    changed();
    return { ok: true };
  });
  app.delete('/maintenance/orders/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [o] = await sql<{ number: string; reported_by: string | null; status: string }[]>`select number, reported_by, status from mnt_orders where id = ${id}`;
    if (!o) throw notFound();
    if (u.role !== 'admin' && o.reported_by !== u.id) throw badRequest('Nur wer den Auftrag angelegt hat oder ein Administrator kann ihn löschen. Sonst bitte „storniert“ wählen.');
    await sql`delete from mnt_orders where id = ${id}`;
    await audit(sql, u, { action: 'maintenance.order.delete', entityType: 'mnt_order', entityId: id, summary: o.number });
    changed();
    return { ok: true };
  });
  app.post('/maintenance/orders/:id/photos', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [o] = await sql<{ photos: { id: string; name: string; path: string }[] }[]>`select photos from mnt_orders where id = ${id}`;
    if (!o) throw notFound();
    const added: { id: string; name: string; path: string }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const pid = randomUUID();
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'foto.jpg');
      const path = `.aperio/maintenance/${id}/${pid}-${name}`;
      await storage.write(path, part.file);
      added.push({ id: pid, name, path });
    }
    await sql`update mnt_orders set photos = ${sql.json([...o.photos, ...added] as never)}, updated_at = now() where id = ${id}`;
    changed();
    return added.map(({ id: pid, name }) => ({ id: pid, name }));
  });
  app.get('/maintenance/orders/:id/photos/:pid', async (req, reply) => {
    staffOf(req);
    const p = parse(z.object({ id: z.string().uuid(), pid: z.string().uuid() }), req.params);
    const [o] = await sql<{ photos: { id: string; name: string; path: string }[] }[]>`select photos from mnt_orders where id = ${p.id}`;
    const f = o?.photos.find((x) => x.id === p.pid);
    if (!f) throw notFound();
    const ext = f.name.split('.').pop()?.toLowerCase();
    reply.header('content-type', ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg');
    return reply.send(storage.read(f.path));
  });
  app.get('/maintenance/orders/:id/pdf', async (req, reply) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [o] = await sql<any[]>`select ${orderCols} from ${orderFrom} where o.id = ${id}`;
    if (!o) throw notFound();
    const company = (await ctx.settings.get('company')).name;
    const pdf = new Pdf(`Instandhaltungsauftrag ${o.number}`, company);
    pdf.paragraph(`${o.kind === 'corrective' ? 'Störungsauftrag' : 'Wartungsauftrag'} ${o.number}`, { size: 16, bold: true, gap: 4 });
    pdf.paragraph(o.title, { size: 12, gap: 10 });
    const d = (v: string | null) => (v ? new Date(v.length === 10 ? `${v}T12:00:00` : v).toLocaleDateString('de-DE') : '–');
    pdf.table([{ label: '', width: 140 }, { label: '', width: 355 }], [
      ['Anlage', o.assetNumber ? `${o.assetNumber} ${o.assetName}${o.assetLocation ? ` (${o.assetLocation})` : ''}` : '–'], ['Priorität', { low: 'niedrig', normal: 'normal', high: 'hoch', urgent: 'dringend' }[o.priority as string] ?? o.priority],
      ['Gemeldet', `${d(o.createdAt)} von ${o.reportedByName ?? '–'}`], ['Zuständig', o.assigneeName ?? '–'], ['Fällig', d(o.dueDate)], ['Erledigt', d(o.finishedAt)],
      ['Arbeitszeit', o.workMinutes ? `${(o.workMinutes / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Std.` : '–'], ['Kosten', `Material ${o.materialCost.toFixed(2)} €, Fremdleistung ${o.externalCost.toFixed(2)} €`],
    ]);
    if (o.description) { pdf.paragraph('Beschreibung', { bold: true, gap: 2 }); pdf.paragraph(o.description, { gap: 10 }); }
    if (o.checklist.length) {
      pdf.paragraph('Checkliste', { bold: true, gap: 4 });
      pdf.table([{ label: 'Punkt', width: 300 }, { label: 'erledigt', width: 60 }, { label: 'Bemerkung', width: 135 }], o.checklist.map((c: any) => [c.text, c.done ? 'ja' : 'nein', c.note]));
    }
    if (o.report) { pdf.paragraph('Bericht', { bold: true, gap: 2 }); pdf.paragraph(o.report, { gap: 10 }); }
    pdf.y += 30; pdf.ensure(40);
    pdf.line(pdf.margin, pdf.y, pdf.margin + 200, pdf.y); pdf.line(pdf.margin + 290, pdf.y, pdf.margin + 495, pdf.y);
    pdf.text(pdf.margin, pdf.y + 4, 'Datum, Unterschrift Techniker', { size: 8, color: '#6b7280' }); pdf.text(pdf.margin + 290, pdf.y + 4, 'Abnahme', { size: 8, color: '#6b7280' });
    pdf.footer((p, n) => `${company} · ${o.number} · Seite ${p} von ${n}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${o.number}.pdf"`);
    return reply.send(pdf.toBuffer());
  });

  // ------------------------------------------------ Wartungspläne
  const planCols = sql`p.id, p.asset_id as "assetId", a.number as "assetNumber", a.name as "assetName", p.title, p.interval_days as "intervalDays", p.next_due::text as "nextDue",
    p.lead_days as "leadDays", p.checklist, p.responsible_id as "responsibleId", u.display_name as "responsibleName", p.estimate_minutes as "estimateMinutes", p.active`;
  app.get('/maintenance/plans', async (req) => {
    staffOf(req);
    const q = parse(z.object({ assetId: z.string().uuid().optional() }), req.query);
    return sql`select ${planCols} from mnt_plans p join inv_assets a on a.id = p.asset_id left join users u on u.id = p.responsible_id
      where true ${q.assetId ? sql`and p.asset_id = ${q.assetId}` : sql``} order by p.active desc, p.next_due`;
  });
  app.post('/maintenance/plans', async (req) => {
    const u = staffOf(req);
    const b = parse(planBody, req.body);
    const [p] = await sql<{ id: string }[]>`insert into mnt_plans ${sql(toRow(sql, b, ['checklist']))} returning id`;
    await audit(sql, u, { action: 'maintenance.plan.create', entityType: 'mnt_plan', entityId: p!.id, summary: b.title });
    changed();
    return { id: p!.id };
  });
  app.patch('/maintenance/plans/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(planBody), req.body);
    const row = toRow(sql, b, ['checklist']);
    if (Object.keys(row).length) await sql`update mnt_plans set ${sql(row)} where id = ${id}`;
    await audit(sql, u, { action: 'maintenance.plan.update', entityType: 'mnt_plan', entityId: id, summary: Object.keys(b).join(', ') });
    changed();
    return { ok: true };
  });
  app.delete('/maintenance/plans/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from mnt_plans where id = ${id}`;
    await audit(sql, u, { action: 'maintenance.plan.delete', entityType: 'mnt_plan', entityId: id, summary: 'Wartungsplan gelöscht' });
    changed();
    return { ok: true };
  });
  /** Wartung sofort als Auftrag anlegen (vorgezogen) */
  app.post('/maintenance/plans/:id/order', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [p] = await sql<{ asset_id: string; title: string; checklist: unknown; responsible_id: string | null; next_due: string }[]>`select asset_id, title, checklist, responsible_id, next_due::text from mnt_plans where id = ${id}`;
    if (!p) throw notFound();
    const [open] = await sql<{ id: string }[]>`select id from mnt_orders where plan_id = ${id} and status not in ('done', 'cancelled')`;
    if (open) return { id: open.id };
    const number = await nextNo();
    const [o] = await sql<{ id: string }[]>`insert into mnt_orders (number, asset_id, plan_id, kind, title, due_date, checklist, assignee_id, reported_by)
      values (${number}, ${p.asset_id}, ${id}, 'preventive', ${p.title}, ${p.next_due < today() ? today() : p.next_due}, ${sql.json(p.checklist as never)}, ${p.responsible_id}, ${u.id}) returning id`;
    changed();
    return { id: o!.id };
  });

  /** Anlagenakte: Pläne, Aufträge und Kennzahlen einer Maschine */
  app.get('/maintenance/assets/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const [a] = await sql`select id, number, name, location, status, manufacturer, model, serial_no as "serialNo" from inv_assets where id = ${id}`;
    if (!a) throw notFound();
    const since = addDays(today(), -365);
    const [k] = await sql<{ failures: number; downMinutes: number; workMinutes: number; cost: number }[]>`select
      count(*) filter (where kind = 'corrective')::int as failures,
      coalesce(sum(extract(epoch from (coalesce(finished_at, now()) - coalesce(started_at, created_at))) / 60) filter (where machine_down), 0)::int as "downMinutes",
      coalesce(sum(work_minutes), 0)::int as "workMinutes", coalesce(sum(material_cost + external_cost), 0)::float as cost
      from mnt_orders where asset_id = ${id} and created_at >= ${since} and status <> 'cancelled'`;
    const plans = await sql`select ${planCols} from mnt_plans p join inv_assets a on a.id = p.asset_id left join users u on u.id = p.responsible_id where p.asset_id = ${id} order by p.next_due`;
    const orders = await sql`select ${orderCols} from ${orderFrom} where o.asset_id = ${id} order by o.created_at desc limit 200`;
    return { asset: a, kpi: { ...k, mtbfDays: k!.failures ? Math.round(365 / k!.failures) : null }, plans, orders };
  });

}
