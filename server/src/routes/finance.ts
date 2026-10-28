/**
 * Finanzbuchhaltung: Eingangsrechnungen (auch als E-Rechnung) mit Freigabe, Bankkonten mit Kontoauszug-Abgleich,
 * Zahlungsläufe (SEPA), Mahnwesen, Umsatzsteuer-Übersicht und Übergabe an den Steuerberater (DATEV).
 * Ersetzt keine Finanzbuchhaltung beim Steuerberater, bereitet aber alles dafür vor.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { invoiceTotals } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { sendMail } from '../services/mail';
import { safeName } from '../services/files';
import { readEInvoiceFile } from '../services/einvoiceRead';
import { painCreditTransfer, parseBankCsv, parseCamt, rankMatches, type BankTx, type OpenItem } from '../services/bank';
import { addPayment, recalcPaid } from '../services/invoices';
import { bankBookings, incomingBillBookings, outgoingInvoiceBookings } from '../services/accounting';
import { datevExtf } from '../lib/datev';
import { writeZip } from '../lib/zip';
import { writeXlsx } from '../lib/xlsx';
import { Pdf, eur } from '../lib/pdf';

const r2 = (n: number) => Math.round(n * 100) / 100;
const line = z.object({ text: z.string().max(500).default(''), account: z.string().max(10), net: z.number(), rate: z.number().min(0).max(100), costCenter: z.string().max(40).optional(), projectId: z.string().uuid().nullable().optional() });
const billBody = z.object({
  supplierId: z.string().uuid().nullable().default(null), supplierName: z.string().max(200).default(''), number: z.string().max(100).default(''),
  billDate: z.string().date().nullable().default(null), dueDate: z.string().date().nullable().default(null), serviceDate: z.string().date().nullable().default(null),
  lines: z.array(line).max(200).default([]), iban: z.string().max(40).default(''), bic: z.string().max(20).default(''),
  projectId: z.string().uuid().nullable().default(null), notes: z.string().max(5000).default(''),
});
const totals = (lines: { net: number; rate: number }[]) => {
  const groups = new Map<number, number>();
  for (const l of lines) groups.set(l.rate, (groups.get(l.rate) ?? 0) + l.net);
  const net = r2([...groups.values()].reduce((a, b) => a + b, 0));
  const tax = r2([...groups.entries()].reduce((a, [rate, n]) => a + r2((n * rate) / 100), 0));
  return { net, tax, gross: r2(net + tax) };
};
const today = () => new Date().toISOString().slice(0, 10);

export default async function financeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const staff = (req: Parameters<typeof requireUser>[0]) => { const u = requireUser(req); if (u.role === 'guest') throw forbidden(); return u; };
  const changed = () => ctx.hub.publish('global', 'finance.changed', {});

  // ------------------------------------------------ Übersicht
  app.get('/finance/overview', async (req) => {
    staff(req);
    const [rec] = await sql<{ open: string; overdue: string; n: number }[]>`select coalesce(sum(total_gross - prepaid - paid_amount), 0) as open,
      coalesce(sum(total_gross - prepaid - paid_amount) filter (where due_date < current_date), 0) as overdue, count(*)::int as n
      from crm_invoices where status in ('open', 'partial') and kind <> 'credit'`;
    const [pay] = await sql<{ open: string; due7: string; n: number; approval: number }[]>`select coalesce(sum(total_gross - paid_amount) filter (where status in ('approved', 'partial')), 0) as open,
      coalesce(sum(total_gross - paid_amount) filter (where status in ('approved', 'partial') and due_date <= current_date + 7), 0) as due7,
      count(*) filter (where status in ('approved', 'partial'))::int as n, count(*) filter (where status = 'approval')::int as approval from fin_bills`;
    const banks = await sql`select a.id, a.name, a.iban, (a.opening_balance + coalesce((select sum(amount) from fin_bank_tx t where t.account_id = a.id and t.date >= a.opening_date), 0))::float as balance,
      (select max(date)::text from fin_bank_tx t where t.account_id = a.id) as "lastTx", (select count(*)::int from fin_bank_tx t where t.account_id = a.id and t.status = 'open') as "openTx"
      from fin_bank_accounts a where a.active order by a.name`;
    // Vorschau der nächsten 8 Wochen: erwartete Eingänge und fällige Zahlungen je Woche
    const flow = await sql<{ week: string; incoming: number; outgoing: number }[]>`with w as (select generate_series(date_trunc('week', current_date), date_trunc('week', current_date) + interval '7 weeks', interval '1 week')::date as week)
      select w.week::text, coalesce((select sum(total_gross - prepaid - paid_amount) from crm_invoices i where i.status in ('open', 'partial') and i.kind <> 'credit'
          and greatest(i.due_date, current_date) >= w.week and greatest(i.due_date, current_date) < w.week + 7), 0)::float as incoming,
        coalesce((select sum(total_gross - paid_amount) from fin_bills b where b.status in ('approved', 'partial') and greatest(b.due_date, current_date) >= w.week and greatest(b.due_date, current_date) < w.week + 7), 0)::float as outgoing
      from w order by w.week`;
    return { receivables: { open: Number(rec!.open), overdue: Number(rec!.overdue), count: rec!.n }, payables: { open: Number(pay!.open), due7: Number(pay!.due7), count: pay!.n, approval: pay!.approval }, banks, flow };
  });

  /** Für alle Mitarbeitenden lesbarer Teil der Einstellungen (Kontenliste, Freigabeberechtigte) */
  app.get('/finance/settings', async (req) => {
    staff(req);
    const f = await ctx.settings.get('finance');
    return { expenseAccounts: f.expenseAccounts, approverIds: f.approverIds, approvalLimit: f.approvalLimit };
  });

  // ------------------------------------------------ Eingangsrechnungen
  const billCols = sql`b.id, b.supplier_id as "supplierId", coalesce(a.name, b.supplier_name) as "supplierName", b.supplier_vat_id as "supplierVatId", b.number, b.bill_date::text as "billDate",
    b.due_date::text as "dueDate", b.service_date::text as "serviceDate", b.lines, b.total_net::float as "totalNet", b.total_tax::float as "totalTax", b.total_gross::float as "totalGross",
    b.paid_amount::float as "paidAmount", b.iban, b.bic, b.project_id as "projectId", p.number as "projectNumber", b.status, b.approved_at as "approvedAt", ap.display_name as "approvedByName",
    b.file_name as "fileName", b.file_path is not null as "hasFile", b.e_invoice as "eInvoice", b.notes, b.exported_at as "exportedAt", b.created_at as "createdAt",
    (b.status in ('approved', 'partial') and b.due_date < current_date) as overdue`;
  const billFrom = sql`fin_bills b left join crm_accounts a on a.id = b.supplier_id left join projects p on p.id = b.project_id left join users ap on ap.id = b.approved_by`;

  app.get('/finance/bills', async (req) => {
    staff(req);
    const q = parse(z.object({ status: z.string().max(20).optional(), supplierId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), q: z.string().max(100).optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${billCols} from ${billFrom} where true
      ${q.status === 'unpaid' ? sql`and b.status in ('approved', 'partial')` : q.status === 'todo' ? sql`and b.status in ('draft', 'approval')` : q.status ? sql`and b.status = ${q.status}` : sql``}
      ${q.supplierId ? sql`and b.supplier_id = ${q.supplierId}` : sql``} ${q.projectId ? sql`and b.project_id = ${q.projectId}` : sql``}
      ${like ? sql`and (b.number ilike ${like} or coalesce(a.name, b.supplier_name) ilike ${like})` : sql``}
      order by (b.status in ('draft', 'approval')) desc, b.due_date nulls last, b.created_at desc limit 2000`;
  });
  app.get('/finance/bills/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [b] = await sql`select ${billCols} from ${billFrom} where b.id = ${id}`;
    if (!b) throw notFound('Eingangsrechnung nicht gefunden');
    const payments = await sql`select x.id, x.date::text, x.amount::float as amount, x.note from fin_bill_payments x where x.bill_id = ${id} order by x.date`;
    return { ...b, payments };
  });

  async function findSupplier(name: string, vatId: string): Promise<string | null> {
    if (vatId) { const [a] = await sql<{ id: string }[]>`select id from crm_accounts where replace(upper(vat_id), ' ', '') = ${vatId.replace(/\s+/g, '').toUpperCase()} limit 1`; if (a) return a.id; }
    if (name) { const [a] = await sql<{ id: string }[]>`select id from crm_accounts where lower(name) = ${name.toLowerCase()} and kind in ('supplier', 'both') limit 1`; if (a) return a.id; }
    return null;
  }
  async function defaultAccount(supplierId: string | null, rate: number): Promise<string> {
    if (supplierId) {
      const [l] = await sql<{ account: string }[]>`select (lines->0->>'account') as account from fin_bills where supplier_id = ${supplierId} and jsonb_array_length(lines) > 0 order by created_at desc limit 1`;
      if (l?.account) return l.account;
    }
    const f = await ctx.settings.get('finance');
    return f.expenseAccounts.find((a) => a.rate === rate)?.account ?? '4900';
  }

  /** Belege hochladen: jede Datei wird eine Eingangsrechnung; E-Rechnungen werden automatisch ausgelesen */
  app.post('/finance/bills/upload', async (req) => {
    const u = staff(req);
    const created: { id: string; eInvoice: boolean; supplierName: string; gross: number }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const data = await part.toBuffer();
      if (data.length > 30 * 1024 * 1024) throw badRequest('Datei größer als 30 MB');
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'beleg');
      const id = randomUUID();
      const path = `.aperio/finance/bills/${id}/${name}`;
      await storage.write(path, Readable.from(data));
      const e = readEInvoiceFile(name, data);
      if (e) {
        const inv = e.invoice;
        const supplierId = await findSupplier(inv.seller.name, inv.seller.vatId);
        const lines = await Promise.all((inv.taxes.length ? inv.taxes : [{ rate: 19, basis: inv.net, tax: inv.tax, category: 'S' }]).map(async (t) => ({
          text: inv.lines.filter((l) => l.rate === t.rate).map((l) => l.text).slice(0, 3).join(', ').slice(0, 200), account: await defaultAccount(supplierId, t.rate), net: t.basis, rate: t.rate })));
        const credit = inv.typeCode === '381';
        const sign = credit ? -1 : 1;
        const signed = lines.map((l) => ({ ...l, net: l.net * sign }));
        const tt = totals(signed);
        let xmlPath: string | null = null;
        if (!/\.xml$/i.test(name)) { xmlPath = `.aperio/finance/bills/${id}/e-rechnung.xml`; await storage.write(xmlPath, Readable.from(Buffer.from(e.xml, 'utf8'))); }
        await sql`insert into fin_bills (id, supplier_id, supplier_name, supplier_vat_id, number, bill_date, due_date, service_date, lines, total_net, total_tax, total_gross, iban, bic,
            file_path, file_name, e_invoice, xml_path, notes, created_by)
          values (${id}, ${supplierId}, ${inv.seller.name}, ${inv.seller.vatId}, ${inv.number}, ${inv.issueDate}, ${inv.dueDate}, ${inv.serviceDate}, ${sql.json(signed as never)},
            ${tt.net}, ${tt.tax}, ${tt.gross}, ${inv.iban}, ${inv.bic}, ${path}, ${name}, true, ${xmlPath},
            ${[credit ? 'Gutschrift/Storno des Lieferanten' : '', inv.orderReference ? `Bestellnummer: ${inv.orderReference}` : '', Math.abs(tt.gross - (inv.gross * sign)) > 0.02 ? `Achtung: Summe laut E-Rechnung ${eur(inv.gross)}` : ''].filter(Boolean).join('\n')}, ${u.id})`;
        created.push({ id, eInvoice: true, supplierName: inv.seller.name, gross: tt.gross });
      } else {
        await sql`insert into fin_bills (id, file_path, file_name, created_by) values (${id}, ${path}, ${name}, ${u.id})`;
        created.push({ id, eInvoice: false, supplierName: '', gross: 0 });
      }
    }
    if (!created.length) throw badRequest('Keine Datei empfangen');
    await audit(sql, u, { action: 'finance.bill.upload', entityType: 'fin_bill', summary: `${created.length} Beleg(e) hochgeladen` });
    changed();
    return created;
  });

  app.post('/finance/bills', async (req) => {
    const u = staff(req);
    const b = parse(billBody, req.body);
    const t = totals(b.lines);
    const [r] = await sql<{ id: string }[]>`insert into fin_bills (supplier_id, supplier_name, number, bill_date, due_date, service_date, lines, total_net, total_tax, total_gross, iban, bic, project_id, notes, created_by)
      values (${b.supplierId}, ${b.supplierName}, ${b.number}, ${b.billDate}, ${b.dueDate}, ${b.serviceDate}, ${sql.json(b.lines as never)}, ${t.net}, ${t.tax}, ${t.gross}, ${b.iban}, ${b.bic}, ${b.projectId}, ${b.notes}, ${u.id}) returning id`;
    changed();
    return r;
  });

  app.patch('/finance/bills/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ status: string }[]>`select status from fin_bills where id = ${id}`;
    if (!cur) throw notFound();
    if (!['draft', 'approval', 'rejected'].includes(cur.status)) throw badRequest('Freigegebene Belege lassen sich nicht mehr ändern. Bitte die Freigabe zurücknehmen.');
    const b = parse(patchSchema(billBody), req.body);
    const t = b.lines ? totals(b.lines) : null;
    const set = <T>(v: T | undefined) => (v === undefined ? null : v);
    await sql`update fin_bills set supplier_id = ${b.supplierId === undefined ? sql`supplier_id` : b.supplierId}, supplier_name = coalesce(${set(b.supplierName)}, supplier_name),
      number = coalesce(${set(b.number)}, number), bill_date = ${b.billDate === undefined ? sql`bill_date` : b.billDate}, due_date = ${b.dueDate === undefined ? sql`due_date` : b.dueDate},
      service_date = ${b.serviceDate === undefined ? sql`service_date` : b.serviceDate}, lines = ${b.lines ? sql.json(b.lines as never) : sql`lines`},
      total_net = coalesce(${t?.net ?? null}, total_net), total_tax = coalesce(${t?.tax ?? null}, total_tax), total_gross = coalesce(${t?.gross ?? null}, total_gross),
      iban = coalesce(${set(b.iban)}, iban), bic = coalesce(${set(b.bic)}, bic), project_id = ${b.projectId === undefined ? sql`project_id` : b.projectId},
      notes = coalesce(${set(b.notes)}, notes), status = case when status = 'rejected' then 'draft' else status end, updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });

  async function isApprover(u: AuthUser) {
    const f = await ctx.settings.get('finance');
    return u.role === 'admin' || f.approverIds.includes(u.id);
  }
  /** Prüfen und zur Freigabe geben; kleine Beträge sind sofort freigegeben */
  app.post('/finance/bills/:id/submit', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [b] = await sql<{ status: string; total_gross: string; bill_date: string | null; lines: unknown[]; supplier_id: string | null; supplier_name: string; number: string }[]>`
      select status, total_gross, bill_date::text, lines, supplier_id, supplier_name, number from fin_bills where id = ${id}`;
    if (!b) throw notFound();
    if (b.status !== 'draft') throw badRequest('Der Beleg ist schon eingereicht.');
    const missing = [!b.supplier_id && !b.supplier_name ? 'Lieferant' : '', !b.bill_date ? 'Rechnungsdatum' : '', !b.lines.length ? 'Beträge und Konten' : '', !b.number ? 'Rechnungsnummer' : ''].filter(Boolean);
    if (missing.length) throw badRequest(`Bitte noch ausfüllen: ${missing.join(', ')}`);
    const f = await ctx.settings.get('finance');
    const needs = Number(b.total_gross) > f.approvalLimit && !(await isApprover(u));
    await sql`update fin_bills set status = ${needs ? 'approval' : 'approved'}, approved_by = ${needs ? null : u.id}, approved_at = ${needs ? null : sql`now()`} where id = ${id}`;
    if (needs) {
      const to = f.approverIds.length ? f.approverIds : (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id);
      await notify(ctx, to, { kind: 'finance.approval', title: `Freigabe: Rechnung ${b.number} von ${b.supplier_name} über ${eur(Number(b.total_gross))}`, link: `/finance?tab=bills&bill=${id}` }, u.id);
    }
    changed();
    return { status: needs ? 'approval' : 'approved' };
  });
  app.post('/finance/bills/:id/approve', async (req) => {
    const u = staff(req);
    if (!(await isApprover(u))) throw forbidden('Freigeben dürfen nur die eingestellten Freigabeberechtigten.');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().max(1000).default('') }), req.body);
    const [r] = await sql<{ created_by: string | null; number: string }[]>`update fin_bills set status = ${b.approve ? 'approved' : 'rejected'}, approved_by = ${u.id}, approved_at = now(),
      notes = case when ${b.note} = '' then notes else trim(notes || E'\\n' || ${`${b.approve ? 'Freigabe' : 'Abgelehnt'} (${u.displayName}): ${b.note}`}) end
      where id = ${id} and status = 'approval' returning created_by, number`;
    if (!r) throw badRequest('Der Beleg wartet nicht auf Freigabe.');
    await notify(ctx, [r.created_by], { kind: 'finance.approval', title: `Rechnung ${r.number} ${b.approve ? 'freigegeben' : 'abgelehnt'}`, body: b.note, link: `/finance?tab=bills&bill=${id}` }, u.id);
    await audit(sql, u, { action: 'finance.bill.approve', entityType: 'fin_bill', entityId: id, summary: `Rechnung ${r.number} ${b.approve ? 'freigegeben' : 'abgelehnt'}` });
    changed();
    return { ok: true };
  });
  app.post('/finance/bills/:id/reopen', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [r] = await sql`update fin_bills set status = 'draft', approved_by = null, approved_at = null where id = ${id} and status in ('approved', 'approval') and paid_amount = 0 and exported_at is null returning id`;
    if (!r) throw badRequest('Nur freigegebene, noch nicht bezahlte und nicht übergebene Belege lassen sich zurücknehmen.');
    await audit(sql, u, { action: 'finance.bill.reopen', entityType: 'fin_bill', entityId: id, summary: 'Freigabe zurückgenommen' });
    changed();
    return { ok: true };
  });
  app.delete('/finance/bills/:id', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [r] = await sql<{ file_path: string | null }[]>`delete from fin_bills where id = ${id} and status in ('draft', 'rejected') returning file_path`;
    if (!r) throw badRequest('Nur Entwürfe und abgelehnte Belege lassen sich löschen.');
    await storage.remove(`.aperio/finance/bills/${id}`).catch(() => {});
    await audit(sql, u, { action: 'finance.bill.delete', entityType: 'fin_bill', entityId: id, summary: 'Eingangsbeleg gelöscht' });
    changed();
    return { ok: true };
  });
  app.get('/finance/bills/:id/file', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ xml: z.coerce.boolean().optional() }), req.query);
    const [b] = await sql<{ file_path: string | null; file_name: string | null; xml_path: string | null }[]>`select file_path, file_name, xml_path from fin_bills where id = ${id}`;
    const path = q.xml ? b?.xml_path : b?.file_path;
    if (!path) throw notFound();
    const name = q.xml ? 'e-rechnung.xml' : b!.file_name ?? 'beleg';
    const type = /\.pdf$/i.test(name) ? 'application/pdf' : /\.xml$/i.test(name) ? 'application/xml' : /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/octet-stream';
    reply.header('content-type', type).header('content-disposition', `inline; filename="${encodeURIComponent(name)}"`);
    return reply.send(storage.read(path));
  });

  async function billPaid(billId: string) {
    const [r] = await sql<{ paid: string; gross: string }[]>`select coalesce((select sum(amount) from fin_bill_payments where bill_id = b.id), 0) as paid, b.total_gross as gross from fin_bills b where b.id = ${billId}`;
    const paid = Number(r!.paid), gross = Number(r!.gross);
    const status = Math.abs(paid) >= Math.abs(gross) - 0.005 ? 'paid' : paid !== 0 ? 'partial' : 'approved';
    await sql`update fin_bills set paid_amount = ${paid}, status = ${status} where id = ${billId} and status in ('approved', 'partial', 'paid')`;
    return status;
  }
  app.post('/finance/bills/:id/payments', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ date: z.string().date(), amount: z.number(), note: z.string().max(500).default('') }), req.body);
    const [cur] = await sql<{ status: string }[]>`select status from fin_bills where id = ${id}`;
    if (!cur || !['approved', 'partial', 'paid'].includes(cur.status)) throw badRequest('Bezahlen lassen sich nur freigegebene Belege.');
    await sql`insert into fin_bill_payments (bill_id, date, amount, note, user_id) values (${id}, ${b.date}, ${b.amount}, ${b.note}, ${u.id})`;
    changed();
    return { status: await billPaid(id) };
  });
  app.delete('/finance/bill-payments/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [p] = await sql<{ bill_id: string }[]>`delete from fin_bill_payments where id = ${id} returning bill_id`;
    if (!p) throw notFound();
    changed();
    return { status: await billPaid(p.bill_id) };
  });

  /** Zahlungslauf: SEPA-Datei für das Online-Banking */
  app.post('/finance/payment-run', async (req, reply) => {
    const u = staff(req);
    const b = parse(z.object({ billIds: z.array(z.string().uuid()).min(1).max(500), bankAccountId: z.string().uuid(), execDate: z.string().date() }), req.body);
    const [acc] = await sql<{ iban: string; bic: string; name: string }[]>`select iban, bic, name from fin_bank_accounts where id = ${b.bankAccountId}`;
    if (!acc?.iban) throw badRequest('Für das Bankkonto ist keine IBAN hinterlegt.');
    const bills = await sql<{ id: string; number: string; supplier_name: string; iban: string; bic: string; open: string }[]>`
      select b.id, b.number, coalesce(a.name, b.supplier_name) as supplier_name, b.iban, b.bic, (b.total_gross - b.paid_amount) as open
      from fin_bills b left join crm_accounts a on a.id = b.supplier_id where b.id = any(${b.billIds}) and b.status in ('approved', 'partial')`;
    const bad = bills.filter((x) => !x.iban || Number(x.open) <= 0);
    if (bills.length !== b.billIds.length || bad.length) throw badRequest(`Nicht zahlbar (nicht freigegeben, schon bezahlt oder ohne IBAN): ${bad.map((x) => x.number || x.supplier_name).join(', ') || 'mindestens ein Beleg'}`);
    const inv = await ctx.settings.get('invoicing');
    const company = await ctx.settings.get('company');
    const msgId = `AP${Date.now()}`;
    const xml = painCreditTransfer({ debtorName: inv.legalName || company.name, debtorIban: acc.iban, debtorBic: acc.bic || undefined, execDate: b.execDate, msgId,
      payments: bills.map((x) => ({ endToEnd: `${msgId}-${x.id.slice(0, 8)}`, name: x.supplier_name, iban: x.iban, bic: x.bic || undefined, amount: Number(x.open), purpose: `Rechnung ${x.number}` })) });
    await audit(sql, u, { action: 'finance.payment-run', entityType: 'fin_bill', summary: `Zahlungslauf mit ${bills.length} Überweisung(en) über ${eur(bills.reduce((s, x) => s + Number(x.open), 0))}` });
    return reply.header('content-type', 'application/xml').header('content-disposition', `attachment; filename="Zahlungslauf_${b.execDate}.xml"`).send(xml);
  });

  // ------------------------------------------------ Bank
  const bankBody = z.object({ name: z.string().trim().min(1).max(100), iban: z.string().max(40).default(''), bic: z.string().max(20).default(''), datevAccount: z.string().max(10).default('1200'),
    openingBalance: z.number().default(0), openingDate: z.string().date().optional(), active: z.boolean().default(true) });
  app.get('/finance/bank-accounts', async (req) => {
    staff(req);
    return sql`select a.id, a.name, a.iban, a.bic, a.datev_account as "datevAccount", a.opening_balance::float as "openingBalance", a.opening_date::text as "openingDate", a.active,
      (a.opening_balance + coalesce((select sum(amount) from fin_bank_tx t where t.account_id = a.id and t.date >= a.opening_date), 0))::float as balance from fin_bank_accounts a order by a.name`;
  });
  app.post('/finance/bank-accounts', async (req) => {
    staff(req);
    const b = parse(bankBody, req.body);
    const [r] = await sql`insert into fin_bank_accounts (name, iban, bic, datev_account, opening_balance, opening_date, active) values (${b.name}, ${b.iban.replace(/\s+/g, '')}, ${b.bic}, ${b.datevAccount}, ${b.openingBalance}, ${b.openingDate ?? today()}, ${b.active}) returning id`;
    return r;
  });
  app.patch('/finance/bank-accounts/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(bankBody), req.body);
    await sql`update fin_bank_accounts set name = coalesce(${b.name ?? null}, name), iban = coalesce(${b.iban?.replace(/\s+/g, '') ?? null}, iban), bic = coalesce(${b.bic ?? null}, bic),
      datev_account = coalesce(${b.datevAccount ?? null}, datev_account), opening_balance = coalesce(${b.openingBalance ?? null}, opening_balance),
      opening_date = coalesce(${b.openingDate ?? null}, opening_date), active = coalesce(${b.active ?? null}, active) where id = ${id}`;
    return { ok: true };
  });

  async function openInvoices(): Promise<OpenItem[]> {
    const s = await ctx.settings.get('invoicing');
    return (await sql<{ id: string; number: string; open: string; name: string }[]>`select i.id, i.number, (i.total_gross - i.prepaid - i.paid_amount) as open, a.name
      from crm_invoices i join crm_accounts a on a.id = i.account_id where i.status in ('open', 'partial') and i.kind <> 'credit'`)
      .map((r) => ({ id: r.id, number: r.number, open: Number(r.open), name: r.name, skontoPercent: s.skonto?.percent }));
  }
  async function openBills(): Promise<OpenItem[]> {
    return (await sql<{ id: string; number: string; open: string; name: string; iban: string }[]>`select b.id, b.number, (b.total_gross - b.paid_amount) as open, coalesce(a.name, b.supplier_name) as name, b.iban
      from fin_bills b left join crm_accounts a on a.id = b.supplier_id where b.status in ('approved', 'partial')`).map((r) => ({ ...r, open: Number(r.open) }));
  }
  async function matchTx(u: AuthUser | null, txId: string, type: 'invoice' | 'bill', targetId: string) {
    const [t] = await sql<{ amount: string; date: string; status: string }[]>`select amount, date::text, status from fin_bank_tx where id = ${txId}`;
    if (!t) throw notFound();
    if (t.status !== 'open') throw badRequest('Der Umsatz ist schon zugeordnet.');
    const amount = Number(t.amount);
    if (type === 'invoice') {
      if (amount <= 0) throw badRequest('Ausgangsrechnungen passen nur zu Zahlungseingängen.');
      await addPayment(ctx, u, targetId, { date: t.date, amount, method: 'transfer', note: 'aus Kontoauszug', bankTxId: txId });
    } else {
      if (amount >= 0) throw badRequest('Eingangsrechnungen passen nur zu Abbuchungen.');
      await sql`insert into fin_bill_payments (bill_id, date, amount, bank_tx_id, note, user_id) values (${targetId}, ${t.date}, ${-amount}, ${txId}, 'aus Kontoauszug', ${u?.id ?? null})`;
      await billPaid(targetId);
    }
    await sql`update fin_bank_tx set status = 'matched', matched_type = ${type}, matched_id = ${targetId} where id = ${txId}`;
  }

  /** Kontoauszug einlesen (CAMT oder CSV); eindeutige Zahlungen werden sofort zugeordnet */
  app.post('/finance/bank-accounts/:id/import', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [acc] = await sql<{ iban: string }[]>`select iban from fin_bank_accounts where id = ${id}`;
    if (!acc) throw notFound();
    const file = await req.file();
    if (!file) throw badRequest('Keine Datei');
    const data = await file.toBuffer();
    let tx: BankTx[];
    if (/\.xml$/i.test(file.filename) || data.subarray(0, 200).toString('utf8').includes('<?xml')) {
      const c = parseCamt(data.toString('utf8'));
      if (acc.iban && c.iban && c.iban !== acc.iban) throw badRequest(`Der Auszug gehört zum Konto ${c.iban}, nicht zu ${acc.iban}.`);
      tx = c.tx;
    } else tx = parseBankCsv(data);
    let added = 0, matched = 0;
    for (const t of tx) {
      const [r] = await sql<{ id: string }[]>`insert into fin_bank_tx (account_id, date, value_date, amount, counterparty, counter_iban, purpose, reference, import_hash)
        values (${id}, ${t.date}, ${t.valueDate}, ${t.amount}, ${t.counterparty}, ${t.counterIban}, ${t.purpose}, ${t.reference}, ${t.hash})
        on conflict (account_id, import_hash) do nothing returning id`;
      if (!r) continue;
      added++;
      const items = t.amount > 0 ? await openInvoices() : await openBills();
      const m = rankMatches(t, items);
      // nur bei klarer Lage automatisch: hohe Punktzahl und deutlich besser als die zweitbeste Möglichkeit
      if (m[0] && m[0].score >= 90 && (!m[1] || m[1].score < 60)) {
        await matchTx(u, r.id, t.amount > 0 ? 'invoice' : 'bill', m[0].id).then(() => matched++).catch(() => {});
      }
    }
    await audit(sql, u, { action: 'finance.bank.import', entityType: 'fin_bank_account', entityId: id, summary: `${added} Umsätze eingelesen, ${matched} automatisch zugeordnet` });
    changed();
    return { read: tx.length, added, duplicates: tx.length - added, matched };
  });

  app.get('/finance/bank-tx', async (req) => {
    staff(req);
    const q = parse(z.object({ accountId: z.string().uuid().optional(), status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(5000).default(500) }), req.query);
    return sql`select t.id, t.account_id as "accountId", t.date::text, t.amount::float as amount, t.counterparty, t.counter_iban as "counterIban", t.purpose, t.reference, t.status,
      t.matched_type as "matchedType", t.matched_id as "matchedId", t.booking_account as "bookingAccount", t.booking_tax as "bookingTax", t.note,
      coalesce(i.number, b.number) as "matchedNumber"
      from fin_bank_tx t left join crm_invoices i on t.matched_type = 'invoice' and i.id = t.matched_id left join fin_bills b on t.matched_type = 'bill' and b.id = t.matched_id
      where true ${q.accountId ? sql`and t.account_id = ${q.accountId}` : sql``} ${q.status ? sql`and t.status = ${q.status}` : sql``}
      order by t.date desc, t.created_at desc limit ${q.limit}`;
  });
  app.get('/finance/bank-tx/:id/suggestions', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [t] = await sql<{ amount: string; purpose: string; counterparty: string; counter_iban: string; reference: string }[]>`select amount, purpose, counterparty, counter_iban, reference from fin_bank_tx where id = ${id}`;
    if (!t) throw notFound();
    const amount = Number(t.amount);
    const items = amount > 0 ? await openInvoices() : await openBills();
    const ranked = rankMatches({ amount, purpose: t.purpose, counterparty: t.counterparty, counterIban: t.counter_iban, reference: t.reference }, items);
    const byId = new Map(items.map((i) => [i.id, i]));
    return { type: amount > 0 ? 'invoice' : 'bill', suggestions: ranked.slice(0, 5).map((m) => ({ ...m, ...byId.get(m.id)! })), all: items.sort((a, b) => a.number.localeCompare(b.number)) };
  });
  app.post('/finance/bank-tx/:id/match', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ type: z.enum(['invoice', 'bill']), targetId: z.string().uuid() }), req.body);
    await matchTx(u, id, b.type, b.targetId);
    changed();
    return { ok: true };
  });
  app.post('/finance/bank-tx/:id/book', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ account: z.string().trim().min(3).max(10), taxKey: z.string().max(4).nullable().default(null), note: z.string().max(500).default('') }), req.body);
    const [r] = await sql`update fin_bank_tx set status = 'booked', booking_account = ${b.account}, booking_tax = ${b.taxKey}, note = ${b.note} where id = ${id} and status = 'open' returning id`;
    if (!r) throw badRequest('Der Umsatz ist schon zugeordnet.');
    changed();
    return { ok: true };
  });
  app.post('/finance/bank-tx/:id/ignore', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    await sql`update fin_bank_tx set status = 'ignored' where id = ${id} and status = 'open'`;
    changed();
    return { ok: true };
  });
  /** Zuordnung lösen (Zahlung wird wieder ausgebucht) */
  app.post('/finance/bank-tx/:id/unmatch', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [t] = await sql<{ matched_type: string | null; matched_id: string | null }[]>`select matched_type, matched_id from fin_bank_tx where id = ${id}`;
    if (!t) throw notFound();
    if (t.matched_type === 'invoice') { await sql`delete from crm_invoice_payments where bank_tx_id = ${id}`; await recalcPaid(ctx, t.matched_id!); }
    if (t.matched_type === 'bill') { await sql`delete from fin_bill_payments where bank_tx_id = ${id}`; await billPaid(t.matched_id!); }
    await sql`update fin_bank_tx set status = 'open', matched_type = null, matched_id = null, booking_account = null, booking_tax = null where id = ${id}`;
    await audit(sql, u, { action: 'finance.bank.unmatch', entityType: 'fin_bank_tx', entityId: id, summary: 'Zuordnung gelöst' });
    changed();
    return { ok: true };
  });

  // ------------------------------------------------ Mahnwesen
  app.get('/finance/dunning', async (req) => {
    staff(req);
    const f = await ctx.settings.get('finance');
    const rows = await sql<{ id: string; number: string; account_name: string; due_date: string; open: string; level: number; last: string | null; email: string }[]>`
      select i.id, i.number, a.name as account_name, i.due_date::text, (i.total_gross - i.prepaid - i.paid_amount) as open, i.dunning_level as level, i.last_dunning_at::text as last,
        coalesce(nullif(a.invoice_email, ''), a.email) as email
      from crm_invoices i join crm_accounts a on a.id = i.account_id where i.status in ('open', 'partial') and i.kind <> 'credit' and i.due_date < current_date order by i.due_date`;
    const t = today();
    return rows.map((r) => {
      const next = f.dunning[r.level];
      const since = r.level === 0 ? r.due_date : r.last ?? r.due_date;
      const d = new Date(`${since}T12:00:00`); if (next) d.setDate(d.getDate() + next.days);
      const nextDate = next ? d.toISOString().slice(0, 10) : null;
      return { id: r.id, number: r.number, accountName: r.account_name, dueDate: r.due_date, open: Number(r.open), level: r.level, lastDunning: r.last, email: r.email,
        nextLevel: next ? r.level + 1 : null, nextTitle: next?.title ?? null, nextDate, ready: Boolean(next && nextDate! <= t), daysOverdue: Math.round((Date.parse(t) - Date.parse(r.due_date)) / 86400000) };
    });
  });

  async function dunningPdf(invoiceId: string, level: number, fee: number): Promise<Buffer> {
    const f = await ctx.settings.get('finance');
    const s = await ctx.settings.get('invoicing');
    const company = await ctx.settings.get('company');
    const [i] = await sql<{ number: string; invoice_date: string; due_date: string; total_gross: string; prepaid: string; paid_amount: string; name: string; street: string; zip: string; city: string; account_number: string }[]>`
      select i.number, i.invoice_date::text, i.due_date::text, i.total_gross, i.prepaid, i.paid_amount, a.name, a.street, a.zip, a.city, a.number as account_number
      from crm_invoices i join crm_accounts a on a.id = i.account_id where i.id = ${invoiceId}`;
    const step = f.dunning[level - 1]!;
    const prevFees = Number((await sql<{ s: string }[]>`select coalesce(sum(fee), 0) as s from fin_dunnings where invoice_id = ${invoiceId}`)[0]!.s);
    const open = Number(i!.total_gross) - Number(i!.prepaid) - Number(i!.paid_amount);
    const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('de-DE');
    const pdf = new Pdf(`${step.title} ${i!.number}`, s.legalName || company.name);
    const L = pdf.margin;
    pdf.text(L, pdf.y, s.legalName || company.name, { size: 14, bold: true });
    pdf.text(L, pdf.y + 18, [s.street, `${s.zip} ${s.city}`].filter((x) => x.trim()).join(' · '), { size: 7, color: '#6b7280' });
    pdf.y += 60;
    for (const l of [i!.name, i!.street, `${i!.zip} ${i!.city}`]) { if (l.trim()) { pdf.text(L, pdf.y, l, { size: 10 }); pdf.y += 13; } }
    pdf.text(400, pdf.y - 39, `Datum: ${fmt(today())}`, { size: 9 }); pdf.text(400, pdf.y - 26, `Kunden-Nr.: ${i!.account_number}`, { size: 9 });
    pdf.y += 30;
    pdf.paragraph(`${step.title} zur Rechnung ${i!.number}`, { size: 14, bold: true, gap: 10 });
    pdf.paragraph('Sehr geehrte Damen und Herren,', { gap: 6 });
    pdf.paragraph(step.text, { gap: 12 });
    pdf.table([{ label: 'Rechnung', width: 110 }, { label: 'vom', width: 80 }, { label: 'fällig seit', width: 80 }, { label: 'Betrag', width: 225, align: 'right' }], [
      [i!.number, fmt(i!.invoice_date), fmt(i!.due_date), eur(open)],
      ...(prevFees + fee > 0 ? [['Mahngebühren', '', '', eur(prevFees + fee)]] : []),
      [{ text: 'Zu zahlen', bold: true }, '', '', { text: eur(open + prevFees + fee), bold: true }],
    ]);
    if (s.iban) pdf.paragraph(`Bankverbindung: ${s.bankName ? `${s.bankName}, ` : ''}IBAN ${s.iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()}${s.bic ? `, BIC ${s.bic}` : ''} – Verwendungszweck: ${i!.number}`, { size: 9 });
    pdf.paragraph('Mit freundlichen Grüßen', { gap: 2 });
    pdf.paragraph(s.legalName || company.name);
    pdf.footer((p, n) => `${[s.legalName || company.name, s.vatId ? `USt-ID ${s.vatId}` : '', s.registry].filter(Boolean).join(' · ')} · Seite ${p} von ${n}`);
    return pdf.toBuffer();
  }
  app.post('/finance/dunning', async (req) => {
    const u = staff(req);
    const b = parse(z.object({ invoiceIds: z.array(z.string().uuid()).min(1).max(200), send: z.boolean().default(false) }), req.body);
    const f = await ctx.settings.get('finance');
    const out: { invoiceId: string; dunningId: string; level: number; sent: boolean; error?: string }[] = [];
    for (const id of b.invoiceIds) {
      const [i] = await sql<{ dunning_level: number; status: string; number: string; pdf_path: string | null; email: string }[]>`select i.dunning_level, i.status, i.number, i.pdf_path,
        coalesce(nullif(a.invoice_email, ''), a.email) as email from crm_invoices i join crm_accounts a on a.id = i.account_id where i.id = ${id}`;
      if (!i || !['open', 'partial'].includes(i.status)) continue;
      const level = i.dunning_level + 1;
      const step = f.dunning[level - 1];
      if (!step) { out.push({ invoiceId: id, dunningId: '', level: i.dunning_level, sent: false, error: 'Höchste Mahnstufe erreicht' }); continue; }
      const pdf = await dunningPdf(id, level, step.fee);
      const dId = randomUUID();
      const path = `.aperio/finance/dunning/${dId}.pdf`;
      await storage.write(path, Readable.from(pdf));
      await sql`insert into fin_dunnings (id, invoice_id, level, fee, pdf_path, created_by) values (${dId}, ${id}, ${level}, ${step.fee}, ${path}, ${u.id})`;
      await sql`update crm_invoices set dunning_level = ${level}, last_dunning_at = current_date where id = ${id}`;
      let sent = false, error: string | undefined;
      if (b.send) {
        if (!i.email) error = 'Keine E-Mail-Adresse beim Kunden';
        else {
          try {
            const inv = await ctx.settings.get('invoicing');
            await sendMail(ctx, { to: i.email, subject: `${step.title} zur Rechnung ${i.number}`, text: `Guten Tag,\n\nanbei erhalten Sie unsere ${step.title} zur Rechnung ${i.number}.\n\nMit freundlichen Grüßen\n${inv.legalName || (await ctx.settings.get('company')).name}`,
              attachments: [{ path, name: `${step.title.replace(/\s+/g, '_')}_${i.number}.pdf` }, ...(i.pdf_path ? [{ path: i.pdf_path, name: `${i.number}.pdf` }] : [])] });
            await sql`update fin_dunnings set sent_at = now(), sent_to = ${i.email} where id = ${dId}`;
            sent = true;
          } catch (e) { error = (e as Error).message; }
        }
      }
      out.push({ invoiceId: id, dunningId: dId, level, sent, error });
    }
    await audit(sql, u, { action: 'finance.dunning', entityType: 'crm_invoice', summary: `${out.filter((o) => o.dunningId).length} Mahnung(en) erstellt` });
    ctx.hub.publish('global', 'invoices.changed', {});
    return out;
  });
  app.get('/finance/dunnings/:id/pdf', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [d] = await sql<{ pdf_path: string | null }[]>`select pdf_path from fin_dunnings where id = ${id}`;
    if (!d?.pdf_path) throw notFound();
    return reply.header('content-type', 'application/pdf').send(storage.read(d.pdf_path));
  });
  app.get('/finance/invoices/:id/dunnings', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    return sql`select id, level, date::text, fee::float as fee, sent_at as "sentAt", sent_to as "sentTo" from fin_dunnings where invoice_id = ${id} order by level`;
  });

  // ------------------------------------------------ Umsatzsteuer
  app.get('/finance/vat', async (req) => {
    staff(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const f = await ctx.settings.get('finance');
    // Umsätze: Soll-Versteuerung = nach Rechnungsdatum; Ist-Versteuerung = nach Zahlungseingang (anteilig)
    const invoices = await sql<{ id: string; kind: string; tax_mode: string; positions: any[]; vat_rate: string; invoice_date: string; total_gross: string }[]>`
      select id, kind, tax_mode, positions, vat_rate, invoice_date::text, total_gross from crm_invoices where status <> 'draft' and ${f.taxBasis === 'ist'
        ? sql`id in (select invoice_id from crm_invoice_payments where date between ${q.from} and ${q.to})` : sql`invoice_date between ${q.from} and ${q.to}`}`;
    const sums = new Map<string, { mode: string; rate: number; net: number; tax: number }>();
    for (const i of invoices) {
      let share = 1;
      if (f.taxBasis === 'ist') {
        const [p] = await sql<{ s: string }[]>`select coalesce(sum(amount), 0) as s from crm_invoice_payments where invoice_id = ${i.id} and date between ${q.from} and ${q.to}`;
        share = Number(i.total_gross) ? Number(p!.s) / Number(i.total_gross) : 0;
      }
      const sign = i.kind === 'credit' ? -1 : 1;
      for (const g of invoiceTotals(i.positions, Number(i.vat_rate), i.tax_mode as never).groups) {
        const k = `${i.tax_mode}:${g.rate}`;
        const e = sums.get(k) ?? { mode: i.tax_mode, rate: g.rate, net: 0, tax: 0 };
        e.net += g.basis * sign * share; e.tax += g.tax * sign * share;
        sums.set(k, e);
      }
    }
    const bills = await sql<{ lines: { net: number; rate: number }[] }[]>`select lines from fin_bills where status in ('approved', 'partial', 'paid') and bill_date between ${q.from} and ${q.to}`;
    let inputTax = 0, inputNet = 0;
    for (const b of bills) for (const l of b.lines) { inputNet += l.net; inputTax += r2((l.net * l.rate) / 100); }
    const rows = [...sums.values()].map((s) => ({ ...s, net: r2(s.net), tax: r2(s.tax) }));
    const pick = (fn: (r: typeof rows[number]) => boolean, k: 'net' | 'tax') => r2(rows.filter(fn).reduce((a, r) => a + r[k], 0));
    const kz = [
      { kz: '81', label: 'Steuerpflichtige Umsätze 19 % (Bemessungsgrundlage)', value: pick((r) => r.mode === 'standard' && r.rate === 19, 'net') },
      { kz: '86', label: 'Steuerpflichtige Umsätze 7 % (Bemessungsgrundlage)', value: pick((r) => r.mode === 'standard' && r.rate === 7, 'net') },
      { kz: '41', label: 'Innergemeinschaftliche Lieferungen an Unternehmer mit USt-ID', value: pick((r) => r.mode === 'intra_eu', 'net') },
      { kz: '43', label: 'Weitere steuerfreie Umsätze mit Vorsteuerabzug (z. B. Ausfuhr)', value: pick((r) => r.mode === 'export', 'net') },
      { kz: '60', label: 'Umsätze, für die der Leistungsempfänger die Steuer schuldet (§ 13b)', value: pick((r) => r.mode === 'reverse_charge', 'net') },
      { kz: '66', label: 'Vorsteuer aus Rechnungen anderer Unternehmer', value: r2(inputTax) },
    ];
    const outputTax = pick(() => true, 'tax');
    return { basis: f.taxBasis, rows, outputTax, inputTax: r2(inputTax), inputNet: r2(inputNet), payable: r2(outputTax - inputTax), kz };
  });

  // ------------------------------------------------ Offene Posten und Übergabe
  app.get('/finance/open-items.xlsx', async (req, reply) => {
    staff(req);
    const rec = await sql<{ number: string; name: string; invoice_date: string; due_date: string; open: string; dunning_level: number }[]>`select i.number, a.name, i.invoice_date::text, i.due_date::text,
      (i.total_gross - i.prepaid - i.paid_amount) as open, i.dunning_level from crm_invoices i join crm_accounts a on a.id = i.account_id where i.status in ('open', 'partial') and i.kind <> 'credit' order by i.due_date`;
    const pay = await sql<{ number: string; name: string; bill_date: string; due_date: string; open: string; status: string }[]>`select b.number, coalesce(a.name, b.supplier_name) as name, b.bill_date::text, b.due_date::text,
      (b.total_gross - b.paid_amount) as open, b.status from fin_bills b left join crm_accounts a on a.id = b.supplier_id where b.status in ('approval', 'approved', 'partial') order by b.due_date`;
    const t = today();
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Offene_Posten_${t}.xlsx"`);
    return writeXlsx([
      { name: 'Forderungen', widths: [16, 30, 12, 12, 14, 10, 10], rows: [['Rechnung', 'Kunde', 'Datum', 'Fällig', 'Offen', 'Tage überfällig', 'Mahnstufe'],
        ...rec.map((r) => [r.number, r.name, r.invoice_date, r.due_date, Number(r.open), Math.max(0, Math.round((Date.parse(t) - Date.parse(r.due_date)) / 86400000)), r.dunning_level])] },
      { name: 'Verbindlichkeiten', widths: [16, 30, 12, 12, 14, 12], rows: [['Rechnung', 'Lieferant', 'Datum', 'Fällig', 'Offen', 'Status'],
        ...pay.map((r) => [r.number, r.name, r.bill_date, r.due_date, Number(r.open), r.status === 'approval' ? 'wartet auf Freigabe' : 'freigegeben'])] },
    ]);
  });

  async function fullExport(from: string, to: string) {
    const s = await ctx.settings.get('invoicing');
    const out = await outgoingInvoiceBookings(ctx, from, to);
    const inc = await incomingBillBookings(ctx, from, to);
    const bank = await bankBookings(ctx, from, to);
    const extf = (title: string, bookings: typeof out.bookings) => datevExtf({ consultantNo: s.datev.consultantNo, clientNo: s.datev.clientNo, fiscalYearStart: `${from.slice(0, 4)}-01-01`,
      accountLength: s.datev.accountLength, from, to, title, bookings });
    const files: { name: string; data: Buffer }[] = [
      { name: `EXTF_Buchungsstapel_Ausgangsrechnungen_${from}_${to}.csv`, data: extf(`Ausgang ${from.slice(0, 7)}`, out.bookings) },
      { name: `EXTF_Buchungsstapel_Eingangsrechnungen_${from}_${to}.csv`, data: extf(`Eingang ${from.slice(0, 7)}`, inc.bookings) },
      { name: `EXTF_Buchungsstapel_Bank_${from}_${to}.csv`, data: extf(`Bank ${from.slice(0, 7)}`, bank) },
    ];
    for (const r of out.rows) {
      if (r.pdf_path) files.push({ name: `Ausgangsrechnungen/${safeName(r.number)}.pdf`, data: await toBuf(storage.read(r.pdf_path)) });
      if (r.xml_path) files.push({ name: `Ausgangsrechnungen/${safeName(r.number)}.xml`, data: await toBuf(storage.read(r.xml_path)) });
    }
    for (const r of inc.rows) if (r.file_path) files.push({ name: `Eingangsrechnungen/${r.bill_date}_${safeName(r.supplier_name || 'Lieferant')}_${safeName(r.number || r.id.slice(0, 8))}_${safeName(r.file_name ?? 'beleg')}`, data: await toBuf(storage.read(r.file_path)) });
    return { zip: writeZip(files), outIds: out.rows.map((r) => r.id), inIds: inc.rows.map((r) => r.id), counts: { outgoing: out.rows.length, incoming: inc.rows.length, bank: bank.length } };
  }
  app.get('/finance/datev.zip', async (req, reply) => {
    const u = staff(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const p = await fullExport(q.from, q.to);
    await sql`update crm_invoices set exported_at = now() where id = any(${p.outIds}) and exported_at is null`;
    await sql`update fin_bills set exported_at = now() where id = any(${p.inIds}) and exported_at is null`;
    await audit(sql, u, { action: 'finance.export', entityType: 'finance', summary: `DATEV-Übergabe ${q.from} bis ${q.to}: ${p.counts.outgoing} Ausgangs-, ${p.counts.incoming} Eingangsrechnungen, ${p.counts.bank} Bankbuchungen` });
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="DATEV_${q.from}_${q.to}.zip"`).send(p.zip);
  });
}

async function toBuf(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
