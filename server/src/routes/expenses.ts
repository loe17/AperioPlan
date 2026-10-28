/**
 * Spesen und Reisekosten: Abrechnung mit Belegen, Verpflegungspauschalen und Kilometergeld,
 * Freigabe durch Vorgesetzte, Auszahlung durch die Buchhaltung.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EXPENSE_KINDS, perDiem, type MealDay } from '@aperio/shared';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { safeName } from '../services/files';
import { staffOf, toRow } from '../lib/rows';
import { Pdf, eur } from '../lib/pdf';
import { writeXlsx } from '../lib/xlsx';

const TZ = () => process.env.TZ || 'Europe/Berlin';
const local = (d: Date) => d.toLocaleString('sv-SE', { timeZone: TZ() }).replace(' ', 'T').slice(0, 16);
const r2 = (n: number) => Math.round(n * 100) / 100;
const reportBody = z.object({
  title: z.string().trim().min(1).max(200), purpose: z.string().max(2000).default(''), destination: z.string().max(300).default(''), country: z.string().length(2).default('DE'),
  startAt: z.string().datetime({ offset: true }).nullable().default(null), endAt: z.string().datetime({ offset: true }).nullable().default(null),
  meals: z.record(z.string(), z.object({ breakfast: z.boolean().optional(), lunch: z.boolean().optional(), dinner: z.boolean().optional() })).default({}),
  projectId: z.string().uuid().nullable().default(null),
});
const itemBody = z.object({ date: z.string().date(), kind: z.enum(['receipt', 'mileage', 'lodging', 'travel', 'other']), category: z.string().max(100).default(''), description: z.string().max(500).default(''),
  amount: z.coerce.number().min(0).default(0), vatRate: z.coerce.number().min(0).max(100).default(19), km: z.coerce.number().min(0).nullable().default(null), paidBy: z.enum(['self', 'company']).default('self') });

export default async function expenseRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const changed = (userId?: string) => { ctx.hub.publish('global', 'expenses.changed', {}); void userId; };
  const isManager = async (u: AuthUser) => u.role === 'admin' || (await ctx.settings.get('expenses')).managerIds.includes(u.id);

  async function approverFor(userId: string): Promise<string[]> {
    const s = await ctx.settings.get('expenses');
    if (s.approverIds.length) return s.approverIds.filter((x) => x !== userId);
    const leads = await sql<{ user_id: string }[]>`select distinct l.user_id from team_members m join team_members l on l.team_id = m.team_id and l.is_lead
      where m.user_id = ${userId} and l.user_id <> ${userId}`;
    if (leads.length) return leads.map((r) => r.user_id);
    return (await sql<{ id: string }[]>`select id from users where role = 'admin' and active and id <> ${userId}`).map((r) => r.id);
  }
  async function load(id: string) {
    const [r] = await sql<any[]>`select e.id, e.number, e.user_id as "userId", u.display_name as "userName", e.title, e.purpose, e.destination, e.country, e.start_at as "startAt", e.end_at as "endAt",
      e.meals, e.project_id as "projectId", p.number as "projectNumber", e.status, e.approver_id as "approverId", ap.display_name as "approverName", e.decided_at as "decidedAt", e.decision_note as "decisionNote",
      e.paid_at as "paidAt", e.created_at as "createdAt", e.updated_at as "updatedAt"
      from exp_reports e join users u on u.id = e.user_id left join users ap on ap.id = e.approver_id left join projects p on p.id = e.project_id where e.id = ${id}`;
    if (!r) throw notFound('Abrechnung nicht gefunden');
    const items = await sql`select id, date::text, kind, category, description, amount::float as amount, vat_rate::float as "vatRate", km::float as km, paid_by as "paidBy",
      receipt_path is not null as "hasReceipt", receipt_name as "receiptName" from exp_items where report_id = ${id} order by date, created_at`;
    return decorate(r, items);
  }
  async function decorate(r: any, items: any[]) {
    const kmRate = (await ctx.settings.get('expenses')).kmRate;
    const pd = r.startAt && r.endAt && r.country === 'DE' ? perDiem(local(new Date(r.startAt)), local(new Date(r.endAt)), r.meals as Record<string, MealDay>) : { days: [], total: 0 };
    const lines = items.map((i: any) => ({ ...i, refund: i.paidBy === 'company' ? 0 : i.kind === 'mileage' ? r2((i.km ?? 0) * kmRate) : i.amount }));
    const total = r2(pd.total + lines.reduce((s: number, i: any) => s + i.refund, 0));
    return { ...r, items: lines, perDiem: pd, kmRate, total };
  }
  const canSee = async (u: AuthUser, r: any) => {
    if (r.userId === u.id || r.approverId === u.id || (await isManager(u))) return;
    if ((await approverFor(r.userId)).includes(u.id)) return;
    throw forbidden();
  };

  app.get('/expenses/reports', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ scope: z.enum(['mine', 'approve', 'all']).default('mine'), status: z.string().max(20).optional() }), req.query);
    if (q.scope === 'all' && !(await isManager(u))) throw forbidden();
    const rows = await sql<any[]>`select e.id, e.number, e.user_id as "userId", u.display_name as "userName", e.title, e.destination, e.country, e.start_at as "startAt", e.end_at as "endAt", e.meals,
      e.status, e.approver_id as "approverId", e.created_at as "createdAt", e.paid_at as "paidAt" from exp_reports e join users u on u.id = e.user_id
      where ${q.scope === 'mine' ? sql`e.user_id = ${u.id}` : q.scope === 'approve' ? sql`e.status = 'submitted' and e.approver_id = ${u.id}` : sql`true`}
      ${q.status ? sql`and e.status = ${q.status}` : sql``} order by e.created_at desc limit 500`;
    const items = rows.length ? await sql<any[]>`select report_id, kind, amount::float as amount, km::float as km, paid_by as "paidBy" from exp_items where report_id = any(${rows.map((r) => r.id)})` : [];
    return Promise.all(rows.map(async (r) => { const d = await decorate(r, items.filter((i) => i.report_id === r.id)); delete d.items; return d; }));
  });
  app.get('/expenses/reports/:id', async (req) => {
    const u = staffOf(req);
    const r = await load(parse(idParam, req.params).id);
    await canSee(u, r);
    return { ...r, canDecide: r.status === 'submitted' && (r.approverId === u.id || (await isManager(u))) && r.userId !== u.id, isManager: await isManager(u) };
  });
  app.post('/expenses/reports', async (req) => {
    const u = staffOf(req);
    const b = parse(reportBody, req.body);
    const number = await nextNumber(sql, 'expense', (await ctx.settings.get('numbers')).expense ?? 'SP-{JJ}-{NNNN}', async (n) => (await sql`select 1 from exp_reports where number = ${n}`).length > 0);
    const [r] = await sql<{ id: string }[]>`insert into exp_reports ${sql({ ...toRow(sql, b, ['meals']), number, user_id: u.id })} returning id`;
    changed();
    return { id: r!.id, number };
  });
  const own = async (u: AuthUser, id: string) => {
    const [r] = await sql<{ user_id: string; status: string }[]>`select user_id, status from exp_reports where id = ${id}`;
    if (!r) throw notFound();
    if (r.user_id !== u.id && !(await isManager(u))) throw forbidden();
    if (!['draft', 'rejected'].includes(r.status)) throw badRequest('Die Abrechnung ist eingereicht und lässt sich nicht mehr ändern.');
    return r;
  };
  app.patch('/expenses/reports/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await own(u, id);
    const row = toRow(sql, parse(patchSchema(reportBody), req.body), ['meals']);
    if (Object.keys(row).length) await sql`update exp_reports set ${sql(row)}, updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/expenses/reports/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await own(u, id);
    await sql`delete from exp_reports where id = ${id}`;
    changed();
    return { ok: true };
  });
  /** Position mit Beleg (Foto oder PDF) */
  app.post('/expenses/reports/:id/items', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await own(u, id);
    const fields: Record<string, string> = {};
    let receipt: { path: string; name: string } | null = null;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'beleg.jpg');
          const path = `.aperio/expenses/${id}/${randomUUID()}-${name}`;
          await storage.write(path, part.file);
          receipt = { path, name };
        } else fields[part.fieldname] = String(part.value);
      }
    } else Object.assign(fields, req.body as object);
    const b = parse(itemBody, fields);
    if (b.kind === 'mileage' && !b.km) throw badRequest('Bitte die gefahrenen Kilometer angeben.');
    const [i] = await sql<{ id: string }[]>`insert into exp_items ${sql({ ...toRow(sql, b), report_id: id, receipt_path: receipt?.path ?? null, receipt_name: receipt?.name ?? null })} returning id`;
    await sql`update exp_reports set updated_at = now() where id = ${id}`;
    changed();
    return { id: i!.id };
  });
  app.delete('/expenses/items/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [i] = await sql<{ report_id: string }[]>`select report_id from exp_items where id = ${id}`;
    if (!i) throw notFound();
    await own(u, i.report_id);
    await sql`delete from exp_items where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.get('/expenses/items/:id/receipt', async (req, reply) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [i] = await sql<{ report_id: string; receipt_path: string | null; receipt_name: string }[]>`select report_id, receipt_path, receipt_name from exp_items where id = ${id}`;
    if (!i?.receipt_path) throw notFound();
    await canSee(u, await load(i.report_id));
    const ext = i.receipt_name.split('.').pop()?.toLowerCase();
    reply.header('content-type', ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg').header('content-disposition', `inline; filename="${encodeURIComponent(i.receipt_name)}"`);
    return reply.send(storage.read(i.receipt_path));
  });

  app.post('/expenses/reports/:id/submit', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await own(u, id);
    const r = await load(id);
    if (!r.items.length && !r.perDiem.total) throw badRequest('Die Abrechnung ist leer.');
    if (r.items.some((i: any) => i.kind !== 'mileage' && i.paidBy === 'self' && !i.hasReceipt && i.amount > 0)) throw badRequest('Bitte zu jeder Auslage einen Beleg anhängen.');
    const approvers = await approverFor(r.userId);
    await sql`update exp_reports set status = 'submitted', approver_id = ${approvers[0] ?? null}, decided_at = null, decision_note = '', updated_at = now() where id = ${id}`;
    await notify(ctx, approvers, { kind: 'expenses.submit', title: `Reisekosten zur Freigabe: ${r.userName}`, body: `${r.number} ${r.title} – ${eur(r.total)}`, link: `/expenses?tab=approve&report=${id}` }, u.id);
    await audit(sql, u, { action: 'expenses.submit', entityType: 'exp_report', entityId: id, summary: `${r.number} eingereicht (${eur(r.total)})` });
    changed();
    return { ok: true };
  });
  app.post('/expenses/reports/:id/decide', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().max(1000).default('') }), req.body);
    const r = await load(id);
    if (r.status !== 'submitted') throw badRequest('Die Abrechnung wartet nicht auf Freigabe.');
    if (r.userId === u.id) throw forbidden('Die eigene Abrechnung kann man nicht selbst freigeben.');
    if (!(await isManager(u)) && !(await approverFor(r.userId)).includes(u.id)) throw forbidden();
    if (!b.approve && !b.note.trim()) throw badRequest('Bitte die Ablehnung begründen.');
    await sql`update exp_reports set status = ${b.approve ? 'approved' : 'rejected'}, approver_id = ${u.id}, decided_at = now(), decision_note = ${b.note}, updated_at = now() where id = ${id}`;
    await notify(ctx, [r.userId], { kind: 'expenses.decision', title: `Reisekosten ${b.approve ? 'freigegeben' : 'abgelehnt'}: ${r.title}`, body: b.note || `${r.number} – ${eur(r.total)}`, link: `/expenses?report=${id}` }, u.id);
    if (b.approve) {
      const s = await ctx.settings.get('expenses');
      await notify(ctx, s.managerIds, { kind: 'expenses.approved', title: `Reisekosten auszahlen: ${r.userName}`, body: `${r.number} – ${eur(r.total)}`, link: `/expenses?tab=all&report=${id}` }, u.id);
    }
    await audit(sql, u, { action: `expenses.${b.approve ? 'approve' : 'reject'}`, entityType: 'exp_report', entityId: id, summary: r.number });
    changed();
    return { ok: true };
  });
  app.post('/expenses/reports/:id/paid', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    if (!(await isManager(u))) throw forbidden('Nur die Buchhaltung meldet Auszahlungen.');
    const r = await load(id);
    if (r.status !== 'approved') throw badRequest('Nur freigegebene Abrechnungen lassen sich auszahlen.');
    await sql`update exp_reports set status = 'paid', paid_at = now(), updated_at = now() where id = ${id}`;
    await notify(ctx, [r.userId], { kind: 'expenses.paid', title: `Reisekosten ausgezahlt: ${r.title}`, body: eur(r.total), link: `/expenses?report=${id}` }, u.id);
    await audit(sql, u, { action: 'expenses.paid', entityType: 'exp_report', entityId: id, summary: `${r.number} ausgezahlt` });
    changed();
    return { ok: true };
  });

  app.get('/expenses/reports/:id/pdf', async (req, reply) => {
    const u = staffOf(req);
    const r = await load(parse(idParam, req.params).id);
    await canSee(u, r);
    const company = (await ctx.settings.get('company')).name;
    const pdf = new Pdf(`Reisekostenabrechnung ${r.number}`, company);
    const dt = (v: string | null) => (v ? new Date(v).toLocaleString('de-DE', { timeZone: TZ(), dateStyle: 'medium', timeStyle: 'short' }) : '–');
    pdf.paragraph(`Reisekostenabrechnung ${r.number}`, { size: 16, bold: true, gap: 4 });
    pdf.paragraph(r.title, { size: 12, gap: 8 });
    pdf.table([{ label: '', width: 120 }, { label: '', width: 375 }], [['Mitarbeiter', r.userName], ['Reiseziel', [r.destination, r.country !== 'DE' ? r.country : ''].filter(Boolean).join(', ') || '–'],
      ['Anlass', r.purpose || '–'], ['Beginn', dt(r.startAt)], ['Ende', dt(r.endAt)], ['Projekt', r.projectNumber ?? '–']]);
    if (r.perDiem.days.length) {
      pdf.paragraph('Verpflegungspauschalen', { bold: true, gap: 4 });
      pdf.table([{ label: 'Tag', width: 120 }, { label: 'Pauschale', width: 125, align: 'right' }, { label: 'Kürzung Mahlzeiten', width: 125, align: 'right' }, { label: 'Betrag', width: 125, align: 'right' }],
        r.perDiem.days.map((d: any) => [new Date(`${d.date}T12:00:00`).toLocaleDateString('de-DE'), eur(d.base), d.cut ? `-${eur(d.cut)}` : '', eur(d.amount)]));
    }
    if (r.items.length) {
      pdf.paragraph('Auslagen', { bold: true, gap: 4 });
      pdf.table([{ label: 'Datum', width: 70 }, { label: 'Art', width: 110 }, { label: 'Beschreibung', width: 170 }, { label: 'Beleg', width: 70, align: 'right' }, { label: 'Erstattung', width: 75, align: 'right' }],
        r.items.map((i: any) => [new Date(`${i.date}T12:00:00`).toLocaleDateString('de-DE'), [EXPENSE_KINDS[i.kind], i.category].filter(Boolean).join(' / '),
          `${i.description}${i.kind === 'mileage' ? ` (${i.km} km × ${r.kmRate.toFixed(2).replace('.', ',')} €)` : ''}${i.paidBy === 'company' ? ' – von der Firma bezahlt' : ''}`, i.kind === 'mileage' ? '' : eur(i.amount), eur(i.refund)]));
    }
    pdf.paragraph(`Erstattungsbetrag: ${eur(r.total)}`, { bold: true, size: 12, gap: 10 });
    pdf.paragraph(`Status: ${{ draft: 'Entwurf', submitted: 'eingereicht', approved: `freigegeben von ${r.approverName} am ${dt(r.decidedAt)}`, rejected: 'abgelehnt', paid: `ausgezahlt am ${dt(r.paidAt)}` }[r.status as string]}`, { size: 9, color: '#374151' });
    pdf.footer((p, n) => `${company} · ${r.number} · Seite ${p} von ${n}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${r.number}.pdf"`);
    return reply.send(pdf.toBuffer());
  });
  app.get('/expenses/export.xlsx', async (req, reply) => {
    const u = staffOf(req);
    if (!(await isManager(u))) throw forbidden();
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const ids = await sql<{ id: string }[]>`select id from exp_reports where status in ('approved', 'paid') and coalesce(decided_at, created_at)::date between ${q.from} and ${q.to} order by created_at`;
    const rows: (string | number)[][] = [['Nummer', 'Mitarbeiter', 'Reise', 'Beginn', 'Ende', 'Verpflegung', 'Auslagen', 'Kilometer', 'Erstattung', 'Status']];
    for (const { id } of ids) {
      const r = await load(id);
      rows.push([r.number, r.userName, r.title, r.startAt ? local(new Date(r.startAt)).replace('T', ' ') : '', r.endAt ? local(new Date(r.endAt)).replace('T', ' ') : '', r.perDiem.total,
        r2(r.items.filter((i: any) => i.kind !== 'mileage').reduce((s: number, i: any) => s + i.refund, 0)), r2(r.items.filter((i: any) => i.kind === 'mileage').reduce((s: number, i: any) => s + i.refund, 0)), r.total, r.status === 'paid' ? 'ausgezahlt' : 'freigegeben']);
    }
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Reisekosten_${q.from}_${q.to}.xlsx"`);
    return reply.send(writeXlsx([{ name: 'Reisekosten', rows, widths: [14, 22, 30, 16, 16, 12, 12, 12, 12, 12] }]));
  });
}
