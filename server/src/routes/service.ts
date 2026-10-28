/**
 * Service-Einsätze: Einsatz beim Kunden planen, Bericht vor Ort (Arbeit, Fahrt, Material), Unterschrift des Kunden,
 * Bericht als PDF per E-Mail und Rechnung mit einem Klick.
 */
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { sendMail } from '../services/mail';
import { staffOf, toRow } from '../lib/rows';
import { Pdf } from '../lib/pdf';
import { invoiceApi } from './invoices';

const work = z.object({ date: z.string().date().nullable().default(null), text: z.string().max(500).default(''), hours: z.number().min(0).max(24), userId: z.string().uuid().nullable().default(null) });
const material = z.object({ text: z.string().trim().min(1).max(300), qty: z.number().min(0), unit: z.string().max(20).default('Stk'), price: z.number().min(0).default(0), articleId: z.string().uuid().nullable().default(null) });
const jobBody = z.object({
  accountId: z.string().uuid().nullable().default(null), contactName: z.string().max(200).default(''), contactPhone: z.string().max(60).default(''), address: z.string().max(500).default(''),
  title: z.string().trim().min(1).max(300), description: z.string().max(10000).default(''), asset: z.string().max(300).default(''),
  technicianIds: z.array(z.string().uuid()).max(20).default([]), startAt: z.string().datetime({ offset: true }).nullable().default(null), endAt: z.string().datetime({ offset: true }).nullable().default(null),
  status: z.enum(['planned', 'on_way', 'in_progress', 'done', 'invoiced', 'cancelled']).default('planned'), report: z.string().max(20000).default(''),
  work: z.array(work).max(100).default([]), materials: z.array(material).max(300).default([]), travelKm: z.number().min(0).max(100000).default(0),
  projectId: z.string().uuid().nullable().default(null), ticketId: z.string().uuid().nullable().default(null), contractId: z.string().uuid().nullable().default(null),
});
type Stroke = [number, number][];

export default async function serviceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const changed = () => ctx.hub.publish('global', 'service.changed', {});
  const cols = sql`j.id, j.number, j.account_id as "accountId", a.name as "accountName", a.number as "accountNumber", j.contact_name as "contactName", j.contact_phone as "contactPhone",
    j.address, j.title, j.description, j.asset, j.technician_ids as "technicianIds", j.start_at as "startAt", j.end_at as "endAt", j.status, j.report, j.work, j.materials,
    j.travel_km::float as "travelKm", j.signature is not null as "signed", j.signed_by as "signedBy", j.signed_at as "signedAt", j.invoice_id as "invoiceId", i.number as "invoiceNumber",
    j.project_id as "projectId", p.number as "projectNumber", j.ticket_id as "ticketId", j.contract_id as "contractId", j.created_at as "createdAt", j.updated_at as "updatedAt"`;
  const from = sql`svc_jobs j left join crm_accounts a on a.id = j.account_id left join crm_invoices i on i.id = j.invoice_id left join projects p on p.id = j.project_id`;
  const load = async (id: string) => {
    const [j] = await sql<any[]>`select ${cols}, j.signature from ${from} where j.id = ${id}`;
    if (!j) throw notFound('Einsatz nicht gefunden');
    return j;
  };

  app.get('/service/jobs', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ status: z.string().max(20).optional(), mine: z.coerce.boolean().optional(), from: z.string().date().optional(), to: z.string().date().optional(),
      accountId: z.string().uuid().optional(), q: z.string().max(100).optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${cols} from ${from} where true
      ${q.status === 'open' ? sql`and j.status in ('planned', 'on_way', 'in_progress')` : q.status === 'billable' ? sql`and j.status = 'done' and j.invoice_id is null` : q.status ? sql`and j.status = ${q.status}` : sql``}
      ${q.mine ? sql`and j.technician_ids @> ${sql.json([u.id] as never)}` : sql``} ${q.accountId ? sql`and j.account_id = ${q.accountId}` : sql``}
      ${q.from ? sql`and j.start_at >= ${q.from}` : sql``} ${q.to ? sql`and j.start_at < ${q.to}::date + 1` : sql``}
      ${like ? sql`and (j.number ilike ${like} or j.title ilike ${like} or a.name ilike ${like} or j.address ilike ${like})` : sql``}
      order by (j.status in ('done', 'invoiced', 'cancelled')), j.start_at nulls last, j.created_at desc limit 1000`;
  });
  app.get('/service/jobs/:id', async (req) => {
    staffOf(req);
    const j = await load(parse(idParam, req.params).id);
    delete j.signature;
    return j;
  });
  app.post('/service/jobs', async (req) => {
    const u = staffOf(req);
    const b = parse(jobBody, req.body);
    const number = await nextNumber(sql, 'service', (await ctx.settings.get('numbers')).service ?? 'SE-{JJJJ}-{NNNN}', async (n) => (await sql`select 1 from svc_jobs where number = ${n}`).length > 0);
    // Adresse vom Kunden übernehmen, wenn keine angegeben
    let address = b.address;
    if (!address && b.accountId) {
      const [a] = await sql<{ street: string; zip: string; city: string }[]>`select street, zip, city from crm_accounts where id = ${b.accountId}`;
      if (a) address = [a.street, `${a.zip} ${a.city}`.trim()].filter(Boolean).join(', ');
    }
    const [j] = await sql<{ id: string }[]>`insert into svc_jobs ${sql({ ...toRow(sql, { ...b, address }, ['technicianIds', 'work', 'materials']), number, created_by: u.id })} returning id`;
    await notify(ctx, b.technicianIds, { kind: 'service.job', title: `Service-Einsatz: ${b.title}`, body: `${number}${b.startAt ? ` am ${new Date(b.startAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : ''}`, link: `/service?job=${j!.id}` }, u.id);
    await audit(sql, u, { action: 'service.job.create', entityType: 'svc_job', entityId: j!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: j!.id, number };
  });
  app.patch('/service/jobs/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(jobBody), req.body);
    const cur = await load(id);
    if (cur.status === 'invoiced' && (b.work || b.materials || b.travelKm !== undefined)) throw badRequest('Der Einsatz ist abgerechnet – Leistungen lassen sich nicht mehr ändern.');
    if (cur.signed && (b.work || b.materials || b.report !== undefined || b.travelKm !== undefined) && (JSON.stringify(b.work ?? cur.work) !== JSON.stringify(cur.work) || JSON.stringify(b.materials ?? cur.materials) !== JSON.stringify(cur.materials) || (b.report ?? cur.report) !== cur.report || (b.travelKm ?? cur.travelKm) !== cur.travelKm)) {
      throw badRequest('Der Bericht ist unterschrieben. Zum Ändern zuerst die Unterschrift entfernen.');
    }
    const row = toRow(sql, b, ['technicianIds', 'work', 'materials']);
    if (Object.keys(row).length) await sql`update svc_jobs set ${sql(row)}, updated_at = now() where id = ${id}`;
    const added = (b.technicianIds ?? []).filter((t) => !cur.technicianIds.includes(t));
    if (added.length) await notify(ctx, added, { kind: 'service.job', title: `Service-Einsatz: ${cur.title}`, body: cur.number, link: `/service?job=${id}` }, u.id);
    await audit(sql, u, { action: 'service.job.update', entityType: 'svc_job', entityId: id, summary: `${cur.number}: ${Object.keys(b).join(', ')}` });
    changed();
    return { ok: true };
  });
  app.delete('/service/jobs/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const cur = await load(id);
    if (cur.invoiceId) throw badRequest('Abgerechnete Einsätze lassen sich nicht löschen.');
    await sql`delete from svc_jobs where id = ${id}`;
    await audit(sql, u, { action: 'service.job.delete', entityType: 'svc_job', entityId: id, summary: cur.number });
    changed();
    return { ok: true };
  });

  /** Unterschrift des Kunden (Striche, Koordinaten 0..1) */
  app.post('/service/jobs/:id/sign', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(200), strokes: z.array(z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).max(2000)).min(1).max(200), aspect: z.number().min(1).max(10).default(3) }), req.body);
    const cur = await load(id);
    if (cur.signed) throw badRequest('Bereits unterschrieben.');
    const points = b.strokes.reduce((s, x) => s + x.length, 0);
    if (points < 5) throw badRequest('Die Unterschrift ist zu kurz.');
    await sql`update svc_jobs set signature = ${sql.json({ strokes: b.strokes, aspect: b.aspect } as never)}, signed_by = ${b.name}, signed_at = now(),
      status = case when status in ('planned', 'on_way', 'in_progress') then 'done' else status end, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'service.job.sign', entityType: 'svc_job', entityId: id, summary: `${cur.number} unterschrieben von ${b.name}` });
    changed();
    return { ok: true };
  });
  app.delete('/service/jobs/:id/sign', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const cur = await load(id);
    if (cur.invoiceId) throw badRequest('Der Einsatz ist abgerechnet.');
    await sql`update svc_jobs set signature = null, signed_by = '', signed_at = null, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'service.job.unsign', entityType: 'svc_job', entityId: id, summary: `${cur.number}: Unterschrift entfernt` });
    changed();
    return { ok: true };
  });

  async function reportPdf(j: any): Promise<Buffer> {
    const inv = await ctx.settings.get('invoicing');
    const company = inv.legalName || (await ctx.settings.get('company')).name;
    const techs = j.technicianIds.length ? (await sql<{ display_name: string }[]>`select display_name from users where id = any(${j.technicianIds})`).map((x) => x.display_name) : [];
    const pdf = new Pdf(`Servicebericht ${j.number}`, company);
    const L = pdf.margin;
    pdf.text(L, pdf.y, company, { size: 13, bold: true });
    pdf.text(L, pdf.y + 16, [inv.street, `${inv.zip} ${inv.city}`, inv.contactPhone].filter((x) => x && x.trim()).join(' · '), { size: 7, color: '#6b7280' });
    pdf.text(330, pdf.y, `Servicebericht ${j.number}`, { size: 12, bold: true });
    pdf.y += 44;
    const dt = (v: string | null) => (v ? new Date(v).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
    pdf.table([{ label: '', width: 110 }, { label: '', width: 385 }], [
      ['Kunde', [j.accountName, j.accountNumber ? `(${j.accountNumber})` : ''].filter(Boolean).join(' ') || '–'], ['Ansprechpartner', [j.contactName, j.contactPhone].filter(Boolean).join(', ') || '–'],
      ['Einsatzort', j.address || '–'], ['Anlage / Gerät', j.asset || '–'], ['Termin', dt(j.startAt)], ['Techniker', techs.join(', ') || '–'],
    ]);
    pdf.paragraph(j.title, { bold: true, size: 11, gap: 3 });
    if (j.description) pdf.paragraph(j.description, { gap: 8, color: '#374151' });
    if (j.report) { pdf.paragraph('Durchgeführte Arbeiten', { bold: true, gap: 3 }); pdf.paragraph(j.report, { gap: 10 }); }
    const num = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
    const rows: string[][] = [
      ...j.work.map((w: any) => [w.date ? new Date(`${w.date}T12:00:00`).toLocaleDateString('de-DE') : '', w.text || 'Arbeitszeit', `${num(w.hours)} Std.`]),
      ...(j.travelKm ? [['', 'Fahrt', `${num(j.travelKm)} km`]] : []),
      ...j.materials.map((m: any) => ['', m.text, `${num(m.qty)} ${m.unit}`]),
    ];
    if (rows.length) pdf.table([{ label: 'Datum', width: 80 }, { label: 'Leistung / Material', width: 315 }, { label: 'Menge', width: 100, align: 'right' }], rows);
    pdf.ensure(110);
    pdf.y += 10;
    pdf.paragraph('Die Arbeiten wurden wie beschrieben ausgeführt.', { size: 9, gap: 6 });
    const y0 = pdf.y;
    if (j.signature) pdf.signature(j.signature.strokes as Stroke[], L, y0, 220, 60, j.signature.aspect);
    pdf.line(L, y0 + 64, L + 220, y0 + 64, 0.6, '#9ca3af');
    pdf.text(L, y0 + 68, j.signedBy ? `${j.signedBy}, ${dt(j.signedAt)}` : 'Unterschrift Kunde', { size: 8, color: '#6b7280' });
    pdf.line(L + 275, y0 + 64, L + 495, y0 + 64, 0.6, '#9ca3af');
    pdf.text(L + 275, y0 + 68, `Techniker${techs[0] ? `: ${techs[0]}` : ''}`, { size: 8, color: '#6b7280' });
    pdf.y = y0 + 90;
    pdf.footer((p, n) => `${company} · ${j.number} · Seite ${p} von ${n}`);
    return pdf.toBuffer();
  }
  app.get('/service/jobs/:id/pdf', async (req, reply) => {
    staffOf(req);
    const j = await load(parse(idParam, req.params).id);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Servicebericht_${j.number}.pdf"`);
    return reply.send(await reportPdf(j));
  });
  app.post('/service/jobs/:id/mail', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ to: z.string().email() }), req.body);
    const j = await load(id);
    const path = `.aperio/service/${id}/Servicebericht_${j.number}.pdf`;
    await storage.write(path, Readable.from(await reportPdf(j)));
    const s = await ctx.settings.get('service');
    await sendMail(ctx, { to: b.to, subject: `Servicebericht ${j.number} – ${j.title}`, text: s.mailText, attachments: [{ path, name: `Servicebericht_${j.number}.pdf` }] });
    await audit(sql, u, { action: 'service.job.mail', entityType: 'svc_job', entityId: id, summary: `${j.number} an ${b.to}` });
    return { ok: true };
  });
  /** Rechnungsentwurf aus Arbeitszeit, Fahrt und Material */
  app.post('/service/jobs/:id/invoice', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const j = await load(id);
    if (!j.accountId) throw badRequest('Bitte zuerst einen Kunden wählen.');
    if (j.invoiceId) throw badRequest(`Bereits abgerechnet mit ${j.invoiceNumber}.`);
    const s = await ctx.settings.get('service');
    const hours = j.work.reduce((a: number, w: any) => a + w.hours, 0);
    const positions = [
      ...(hours ? [{ text: 'Arbeitszeit Servicetechniker', description: j.title, qty: Math.round(hours * 100) / 100, unit: 'Std', price: s.hourlyRate }] : []),
      ...(j.travelKm ? [{ text: 'Fahrtkosten', qty: j.travelKm, unit: 'km', price: s.kmRate }] : []),
      ...(s.travelFlat ? [{ text: 'Anfahrtspauschale', qty: 1, unit: 'psch', price: s.travelFlat }] : []),
      ...j.materials.filter((m: any) => m.qty > 0).map((m: any) => ({ text: m.text, qty: m.qty, unit: m.unit || 'Stk', price: m.price })),
    ];
    if (!positions.length) throw badRequest('Keine Leistungen erfasst.');
    if (!invoiceApi.createDraft) throw badRequest('Rechnungen sind nicht verfügbar.');
    const day = (j.startAt ? new Date(j.startAt) : new Date()).toISOString().slice(0, 10);
    const r = await invoiceApi.createDraft(u, { accountId: j.accountId, projectId: j.projectId, title: `Service-Einsatz ${j.number}: ${j.title}`, serviceFrom: day, serviceTo: day,
      orderReference: j.number, positions });
    await sql`update svc_jobs set invoice_id = ${r.id}, status = 'invoiced', updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'service.job.invoice', entityType: 'svc_job', entityId: id, summary: `${j.number}: Rechnungsentwurf erstellt` });
    changed();
    return { invoiceId: r.id };
  });
}
