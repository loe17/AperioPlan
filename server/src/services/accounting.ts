/**
 * Buchungssätze für die Übergabe an den Steuerberater (DATEV): Ausgangsrechnungen, Eingangsrechnungen,
 * Zahlungen aus dem Bankabgleich und eigene Buchungen. Konten nach SKR03/SKR04 laut Einstellungen.
 */
import { invoiceTotals, type InvoicePosition } from '@aperio/shared';
import type { AppContext } from '../context';
import type { DatevBooking } from '../lib/datev';

export interface OutgoingRow { id: string; number: string; kind: string; status: string; account_id: string; account_number: string; account_name: string; vat_id: string; invoice_date: string;
  service_to: string | null; total_net: string; total_tax: string; total_gross: string; tax_mode: string; positions: InvoicePosition[]; vat_rate: string; pdf_path: string | null; xml_path: string | null; project_number: string | null }

/** Debitoren- bzw. Kreditorenkonto vergeben (fortlaufend ab der eingestellten ersten Nummer) */
export async function personalAccount(ctx: AppContext, accountId: string, kind: 'debtor' | 'creditor'): Promise<string> {
  const { sql } = ctx;
  if (kind === 'debtor') {
    const first = (await ctx.settings.get('invoicing')).datev.firstDebtor;
    await sql`update crm_accounts set datev_account = (select greatest(${first - 1}, coalesce(max(datev_account), 0)) + 1 from crm_accounts) where id = ${accountId} and datev_account is null`;
    return String((await sql<{ n: number }[]>`select datev_account as n from crm_accounts where id = ${accountId}`)[0]!.n);
  }
  const first = (await ctx.settings.get('finance')).firstCreditor;
  await sql`update crm_accounts set datev_creditor = (select greatest(${first - 1}, coalesce(max(datev_creditor), 0)) + 1 from crm_accounts) where id = ${accountId} and datev_creditor is null`;
  return String((await sql<{ n: number }[]>`select datev_creditor as n from crm_accounts where id = ${accountId}`)[0]!.n);
}

export async function outgoingInvoiceBookings(ctx: AppContext, from: string, to: string) {
  const { sql } = ctx;
  const s = await ctx.settings.get('invoicing');
  const rows = await sql<OutgoingRow[]>`
    select i.id, i.number, i.kind, i.status, i.account_id, a.number as account_number, a.name as account_name, a.vat_id, i.invoice_date::text, i.service_to::text,
      i.total_net, i.total_tax, i.total_gross, i.tax_mode, i.positions, i.vat_rate, i.pdf_path, i.xml_path, p.number as project_number
    from crm_invoices i join crm_accounts a on a.id = i.account_id left join projects p on p.id = i.project_id
    where i.status <> 'draft' and i.invoice_date between ${from} and ${to} order by i.invoice_date, i.number`;
  const revenue = (mode: string, rate: number) => mode === 'intra_eu' ? s.datev.revenueEu : mode === 'export' ? s.datev.revenueExport : mode === 'reverse_charge' ? s.datev.revenueReverse
    : mode === 'small_business' ? s.datev.revenueSmall : rate === 7 ? s.datev.revenue7 : s.datev.revenue19;
  const bookings: DatevBooking[] = [];
  for (const r of rows) {
    const debtor = await personalAccount(ctx, r.account_id, 'debtor');
    const t = invoiceTotals(r.positions, Number(r.vat_rate), r.tax_mode as never);
    for (const g of t.groups) {
      bookings.push({ amount: g.basis + g.tax, side: r.kind === 'credit' ? 'H' : 'S', account: debtor, contra: revenue(r.tax_mode, g.rate),
        date: r.invoice_date, docNo: r.number, text: `${r.kind === 'credit' ? 'Storno ' : ''}${r.account_name}`.slice(0, 60), cost1: r.project_number ?? undefined,
        euVatId: r.tax_mode === 'intra_eu' ? r.vat_id : undefined, serviceDate: r.service_to ?? undefined });
    }
  }
  return { rows, bookings };
}

/** BU-Schlüssel für Vorsteuer (DATEV): 9 = 19 %, 8 = 7 % */
const vstKey = (rate: number) => (rate === 19 ? '9' : rate === 7 ? '8' : undefined);

export async function incomingBillBookings(ctx: AppContext, from: string, to: string) {
  const { sql } = ctx;
  const rows = await sql<{ id: string; number: string; supplier_id: string | null; supplier_name: string; bill_date: string; lines: { account: string; net: number; rate: number; costCenter?: string }[]; file_path: string | null; file_name: string | null; project_number: string | null }[]>`
    select b.id, b.number, b.supplier_id, b.supplier_name, b.bill_date::text, b.lines, b.file_path, b.file_name, p.number as project_number
    from fin_bills b left join projects p on p.id = b.project_id where b.status in ('approved', 'partial', 'paid') and b.bill_date between ${from} and ${to} order by b.bill_date`;
  const bookings: DatevBooking[] = [];
  for (const r of rows) {
    const creditor = r.supplier_id ? await personalAccount(ctx, r.supplier_id, 'creditor') : '70000';
    for (const l of r.lines) {
      const gross = Math.round(l.net * (1 + l.rate / 100) * 100) / 100;
      bookings.push({ amount: gross, side: 'S', account: l.account, contra: creditor, buKey: vstKey(l.rate), date: r.bill_date, docNo: r.number || r.id.slice(0, 8),
        text: r.supplier_name.slice(0, 60), cost1: l.costCenter || r.project_number || undefined });
    }
  }
  return { rows, bookings };
}

/** Zahlungen aus dem Bankabgleich und eigene Bankbuchungen */
export async function bankBookings(ctx: AppContext, from: string, to: string) {
  const { sql } = ctx;
  const tx = await sql<{ id: string; date: string; amount: string; purpose: string; counterparty: string; status: string; matched_type: string | null; matched_id: string | null;
    booking_account: string | null; booking_tax: string | null; bank_account: string }[]>`
    select t.id, t.date::text, t.amount, t.purpose, t.counterparty, t.status, t.matched_type, t.matched_id, t.booking_account, t.booking_tax, a.datev_account as bank_account
    from fin_bank_tx t join fin_bank_accounts a on a.id = t.account_id where t.status in ('matched', 'booked') and t.date between ${from} and ${to} order by t.date`;
  const bookings: DatevBooking[] = [];
  for (const t of tx) {
    const amount = Number(t.amount);
    let contra = t.booking_account ?? '';
    let docNo = '';
    if (t.matched_type === 'invoice') {
      const [i] = await sql<{ account_id: string; number: string }[]>`select account_id, number from crm_invoices where id = ${t.matched_id}`;
      if (i) { contra = await personalAccount(ctx, i.account_id, 'debtor'); docNo = i.number; }
    } else if (t.matched_type === 'bill') {
      const [b] = await sql<{ supplier_id: string | null; number: string }[]>`select supplier_id, number from fin_bills where id = ${t.matched_id}`;
      if (b) { contra = b.supplier_id ? await personalAccount(ctx, b.supplier_id, 'creditor') : '70000'; docNo = b.number; }
    }
    if (!contra) continue;
    bookings.push({ amount: Math.abs(amount), side: amount >= 0 ? 'S' : 'H', account: t.bank_account, contra, buKey: t.booking_tax ?? undefined, date: t.date,
      docNo: docNo || t.id.slice(0, 8), text: (t.counterparty || t.purpose).slice(0, 60) });
  }
  return bookings;
}
