/**
 * Wartungs- und Serviceverträge: wiederkehrende Rechnungen (monatlich bis jährlich, im Voraus oder nachträglich),
 * Kündigungsfristen und automatische Verlängerung, Anlagen und Besuche je Vertrag.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { staffOf, toRow, today } from '../lib/rows';
import { invoiceApi } from './invoices';
import { loadUser } from '../lib/auth';

const position = z.object({ text: z.string().trim().min(1).max(300), description: z.string().max(2000).default(''), qty: z.number().min(0), unit: z.string().max(20).default('psch'), price: z.number() });
const contractBody = z.object({
  accountId: z.string().uuid(), title: z.string().trim().min(1).max(300), kind: z.enum(['maintenance', 'service', 'rental', 'license', 'other']).default('maintenance'),
  startDate: z.string().date(), endDate: z.string().date().nullable().default(null), intervalMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).default(12),
  billing: z.enum(['advance', 'arrears']).default('advance'), nextInvoiceDate: z.string().date().nullable().optional(), positions: z.array(position).max(100).default([]),
  auto: z.enum(['off', 'draft', 'send']).default('draft'), noticeMonths: z.number().int().min(0).max(36).default(3), renewMonths: z.number().int().min(0).max(60).default(12),
  status: z.enum(['draft', 'active', 'paused', 'cancelled', 'ended']).default('active'), ownerId: z.string().uuid().nullable().default(null),
  assets: z.array(z.object({ id: z.string().uuid().nullable().default(null), name: z.string().max(300) })).max(200).default([]), visitsPerYear: z.number().int().min(0).max(365).default(0),
  slaHours: z.number().int().min(0).max(1000).nullable().default(null), notes: z.string().max(10000).default(''),
});

export const addMonthsIso = (d: string, m: number) => {
  const x = new Date(`${d}T12:00:00Z`); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + m);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10);
};
const minusDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
const net = (p: { qty: number; price: number }[]) => Math.round(p.reduce((s, x) => s + x.qty * x.price, 0) * 100) / 100;

/** Abrechnungszeitraum zur fälligen Rechnung */
export function periodFor(c: { billing: string; intervalMonths: number }, invoiceDate: string) {
  if (c.billing === 'advance') return { from: invoiceDate, to: minusDay(addMonthsIso(invoiceDate, c.intervalMonths)) };
  return { from: addMonthsIso(invoiceDate, -c.intervalMonths), to: minusDay(invoiceDate) };
}
/** Spätester Kündigungstermin vor dem aktuellen Laufzeitende */
export function noticeDeadline(c: { startDate: string; endDate: string | null; noticeMonths: number; renewMonths: number }, ref = today()): { end: string; deadline: string } | null {
  if (!c.endDate) return null;
  let end = c.endDate;
  while (c.renewMonths > 0 && addMonthsIso(end, -c.noticeMonths) < ref) end = addMonthsIso(end, c.renewMonths);
  return { end, deadline: addMonthsIso(end, -c.noticeMonths) };
}

type Row = { id: string; number: string; account_id: string; title: string; billing: string; interval_months: number; next_invoice_date: string; positions: z.infer<typeof position>[];
  auto: string; end_date: string | null; cancelled_to: string | null; owner_id: string | null; created_by: string | null; renew_months: number; status: string };

export async function contractsDaily(ctx: AppContext) {
  const { sql } = ctx;
  if (!(await ctx.settings.get('apps')).installed.includes('contracts')) return;
  const due = await sql<Row[]>`select id, number, account_id, title, billing, interval_months, next_invoice_date::text, positions, auto, end_date::text, cancelled_to::text, owner_id, created_by, renew_months, status
    from ctr_contracts where status = 'active' and auto <> 'off' and next_invoice_date <= current_date`;
  // Rückstände nachholen (z. B. nach Ausfall oder beim Anlegen rückwirkender Verträge), höchstens zwei Jahre je Lauf
  for (const c of due) {
    let row: Row = c;
    for (let k = 0; k < 24 && row.next_invoice_date <= today() && row.status === 'active'; k++) {
      const r = await invoiceContract(ctx, row, null).catch(() => null);
      const [n] = await sql<Row[]>`select id, number, account_id, title, billing, interval_months, next_invoice_date::text, positions, auto, end_date::text, cancelled_to::text, owner_id, created_by, renew_months, status
        from ctr_contracts where id = ${c.id}`;
      if (!n || (!r && n.next_invoice_date === row.next_invoice_date)) break;
      row = n;
    }
  }
  // Kündigungsfristen: 30 Tage vorher erinnern
  const all = await sql<{ id: string; number: string; title: string; start_date: string; end_date: string | null; notice_months: number; renew_months: number; owner_id: string | null; notice_reminded_for: string | null }[]>`
    select id, number, title, start_date::text, end_date::text, notice_months, renew_months, owner_id, notice_reminded_for::text from ctr_contracts where status = 'active' and end_date is not null`;
  const admins = (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id);
  for (const c of all) {
    const n = noticeDeadline({ startDate: c.start_date, endDate: c.end_date, noticeMonths: c.notice_months, renewMonths: c.renew_months });
    if (!n || n.deadline > addMonthsIso(today(), 1) || c.notice_reminded_for === n.deadline) continue;
    await notify(ctx, c.owner_id ? [c.owner_id] : admins, { kind: 'contracts.notice', title: `Kündigungsfrist: ${c.title}`,
      body: `${c.number} – kündbar bis ${new Date(`${n.deadline}T12:00:00`).toLocaleDateString('de-DE')} zum ${new Date(`${n.end}T12:00:00`).toLocaleDateString('de-DE')}`, link: `/contracts?contract=${c.id}` });
    await sql`update ctr_contracts set notice_reminded_for = ${n.deadline} where id = ${c.id}`;
  }
}

/** Eine Vertragsrechnung erzeugen und das nächste Rechnungsdatum fortschreiben */
async function invoiceContract(ctx: AppContext, c: Row, user: AuthUser | null) {
  const { sql } = ctx;
  const p = periodFor({ billing: c.billing, intervalMonths: c.interval_months }, c.next_invoice_date);
  const limit = c.cancelled_to ?? (c.renew_months ? null : c.end_date);
  if (limit && p.from > limit) { await sql`update ctr_contracts set status = 'ended' where id = ${c.id}`; return null; }
  const [dup] = await sql`select 1 from ctr_invoices where contract_id = ${c.id} and period_from = ${p.from}`;
  if (dup) { await sql`update ctr_contracts set next_invoice_date = ${addMonthsIso(c.next_invoice_date, c.interval_months)} where id = ${c.id}`; return null; }
  const u = user ?? (c.owner_id ? await loadUser(sql, c.owner_id) : null) ?? (c.created_by ? await loadUser(sql, c.created_by) : null);
  if (!u || !invoiceApi.createDraft) throw new Error('Kein Benutzer für die Vertragsrechnung');
  const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('de-DE');
  const r = await invoiceApi.createDraft(u, { accountId: c.account_id, title: `${c.title} (${fmt(p.from)} – ${fmt(p.to)})`, serviceFrom: p.from, serviceTo: p.to, orderReference: `Vertrag ${c.number}`,
    positions: c.positions.map((x) => ({ text: x.text, description: x.description || undefined, qty: x.qty, unit: x.unit, price: x.price })) });
  await sql`insert into ctr_invoices (contract_id, invoice_id, period_from, period_to) values (${c.id}, ${r.id}, ${p.from}, ${p.to})`;
  await sql`update ctr_contracts set next_invoice_date = ${addMonthsIso(c.next_invoice_date, c.interval_months)}, updated_at = now() where id = ${c.id}`;
  let sentTo: string | null = null;
  if (c.auto === 'send' && !user && invoiceApi.finalizeAndSend) sentTo = (await invoiceApi.finalizeAndSend(u, r.id).catch(() => ({ sentTo: null }))).sentTo;
  if (!user) await notify(ctx, [u.id], { kind: 'contracts.invoice', title: `Vertragsrechnung ${sentTo ? 'versendet' : 'erstellt'}: ${c.title}`, body: `${c.number} · ${fmt(p.from)} – ${fmt(p.to)}`, link: `/crm?tab=invoices` });
  return { invoiceId: r.id, period: p };
}

export default async function contractRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'contracts.changed', {});
  const cols = sql`c.id, c.number, c.account_id as "accountId", a.name as "accountName", a.number as "accountNumber", c.title, c.kind, c.start_date::text as "startDate", c.end_date::text as "endDate",
    c.interval_months as "intervalMonths", c.billing, c.next_invoice_date::text as "nextInvoiceDate", c.positions, c.auto, c.notice_months as "noticeMonths", c.renew_months as "renewMonths",
    c.status, c.cancelled_to::text as "cancelledTo", c.owner_id as "ownerId", o.display_name as "ownerName", c.assets, c.visits_per_year as "visitsPerYear", c.sla_hours as "slaHours", c.notes,
    c.created_at as "createdAt", c.updated_at as "updatedAt"`;
  const from = sql`ctr_contracts c join crm_accounts a on a.id = c.account_id left join users o on o.id = c.owner_id`;
  const decorate = (c: any) => {
    const perInterval = net(c.positions);
    return { ...c, netPerInterval: perInterval, mrr: Math.round((perInterval / c.intervalMonths) * 100) / 100, notice: noticeDeadline(c) };
  };
  const load = async (id: string) => {
    const [c] = await sql<any[]>`select ${cols} from ${from} where c.id = ${id}`;
    if (!c) throw notFound('Vertrag nicht gefunden');
    return decorate(c);
  };

  app.get('/contracts', async (req) => {
    staffOf(req);
    const q = parse(z.object({ status: z.string().max(20).optional(), accountId: z.string().uuid().optional(), q: z.string().max(100).optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    const rows = await sql`select ${cols} from ${from} where true ${q.status ? sql`and c.status = ${q.status}` : sql``} ${q.accountId ? sql`and c.account_id = ${q.accountId}` : sql``}
      ${like ? sql`and (c.number ilike ${like} or c.title ilike ${like} or a.name ilike ${like})` : sql``} order by (c.status <> 'active'), a.name, c.number`;
    return rows.map(decorate);
  });
  app.get('/contracts/overview', async (req) => {
    staffOf(req);
    const rows = (await sql`select ${cols} from ${from} where c.status = 'active'`).map(decorate);
    const in30 = addMonthsIso(today(), 1);
    return { active: rows.length, mrr: Math.round(rows.reduce((s, c) => s + c.mrr, 0) * 100) / 100, arr: Math.round(rows.reduce((s, c) => s + c.mrr, 0) * 1200) / 100,
      dueInvoices: rows.filter((c) => c.auto !== 'off' && c.nextInvoiceDate && c.nextInvoiceDate <= in30).length, notices: rows.filter((c) => c.notice && c.notice.deadline <= addMonthsIso(today(), 3)).map((c) => ({ id: c.id, number: c.number, title: c.title, accountName: c.accountName, ...c.notice })) };
  });
  app.get('/contracts/:id', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const c = await load(id);
    const invoices = await sql`select x.period_from::text as "periodFrom", x.period_to::text as "periodTo", i.id, i.number, i.status, i.total_gross::float as "totalGross"
      from ctr_invoices x left join crm_invoices i on i.id = x.invoice_id where x.contract_id = ${id} order by x.period_from desc`;
    const jobs = (await ctx.settings.get('apps')).installed.includes('service') ? await sql`select id, number, title, status, start_at as "startAt" from svc_jobs where contract_id = ${id} order by start_at desc nulls last` : [];
    return { ...c, invoices, jobs };
  });
  app.post('/contracts', async (req) => {
    const u = staffOf(req);
    const b = parse(contractBody, req.body);
    const number = await nextNumber(sql, 'contract', (await ctx.settings.get('numbers')).contract ?? 'V-{NNNN}', async (n) => (await sql`select 1 from ctr_contracts where number = ${n}`).length > 0);
    const next = b.nextInvoiceDate ?? (b.billing === 'advance' ? b.startDate : addMonthsIso(b.startDate, b.intervalMonths));
    const [c] = await sql<{ id: string }[]>`insert into ctr_contracts ${sql({ ...toRow(sql, { ...b, nextInvoiceDate: next, ownerId: b.ownerId ?? u.id }, ['positions', 'assets']), number, created_by: u.id })} returning id`;
    await audit(sql, u, { action: 'contracts.create', entityType: 'ctr_contract', entityId: c!.id, summary: `${number} ${b.title}` });
    changed();
    return { id: c!.id, number };
  });
  app.patch('/contracts/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(contractBody), req.body);
    const row = toRow(sql, b, ['positions', 'assets']);
    if (Object.keys(row).length) await sql`update ctr_contracts set ${sql(row)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'contracts.update', entityType: 'ctr_contract', entityId: id, summary: Object.keys(b).join(', ') });
    changed();
    return { ok: true };
  });
  /** Kündigen: zum nächstmöglichen Termin (oder angegebenen Datum) */
  app.post('/contracts/:id/cancel', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ to: z.string().date().optional() }), req.body ?? {});
    const c = await load(id);
    const to = b.to ?? c.notice?.end ?? addMonthsIso(today(), c.noticeMonths);
    await sql`update ctr_contracts set status = 'cancelled', cancelled_to = ${to}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'contracts.cancel', entityType: 'ctr_contract', entityId: id, summary: `${c.number} gekündigt zum ${to}` });
    changed();
    return { ok: true, to };
  });
  /** Nächste Rechnung jetzt erzeugen (Entwurf) */
  app.post('/contracts/:id/invoice', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [c] = await sql<Row[]>`select id, number, account_id, title, billing, interval_months, next_invoice_date::text, positions, auto, end_date::text, cancelled_to::text, owner_id, created_by, renew_months, status
      from ctr_contracts where id = ${id}`;
    if (!c) throw notFound();
    if (!c.next_invoice_date) throw badRequest('Kein Rechnungsdatum hinterlegt.');
    if (!c.positions.length) throw badRequest('Der Vertrag hat keine Positionen.');
    const r = await invoiceContract(ctx, c, u);
    if (!r) throw badRequest('Für diesen Zeitraum gibt es schon eine Rechnung oder der Vertrag ist beendet.');
    changed();
    return r;
  });
  app.delete('/contracts/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from ctr_invoices where contract_id = ${id}`;
    if (n!.n) throw badRequest('Es gibt schon Rechnungen zu diesem Vertrag – bitte kündigen statt löschen.');
    await sql`delete from ctr_contracts where id = ${id}`;
    await audit(sql, u, { action: 'contracts.delete', entityType: 'ctr_contract', entityId: id, summary: 'Vertrag gelöscht' });
    changed();
    return { ok: true };
  });
}
