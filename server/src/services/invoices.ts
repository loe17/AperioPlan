/**
 * Ausgangsrechnungen: Festschreiben (Nummer, PDF und E-Rechnung werden erzeugt und danach nicht mehr geändert),
 * Stornieren per Stornorechnung, Zahlungseingänge. Grundsätze: GoBD (unveränderbar nach Festschreibung),
 * § 14 UStG (Pflichtangaben), EN 16931 / XRechnung / ZUGFeRD (E-Rechnung).
 */
import { Readable } from 'node:stream';
import { dueDate, INVOICE_KIND, invoiceTotals, positionNet, TAX_MODES, type InvoiceKind, type InvoicePosition, type TaxMode } from '@aperio/shared';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';
import { Pdf, eur, num } from '../lib/pdf';
import { audit } from './audit';
import { nextNumber } from './numbers';
import { buildCii, checkEInvoice, type EInvoice } from './einvoice';
import { safeName } from './files';

export interface InvoiceRow {
  id: string; number: string | null; kind: InvoiceKind; status: string; account_id: string; contact_id: string | null; project_id: string | null; quote_id: string | null;
  cancels_id: string | null; title: string; invoice_date: string | null; service_from: string | null; service_to: string | null; due_date: string | null;
  buyer_reference: string; order_reference: string; intro: string; outro: string; positions: InvoicePosition[]; vat_rate: string; tax_mode: TaxMode;
  payment_terms: string; total_net: string; total_tax: string; total_gross: string; prepaid: string; paid_amount: string; format: 'zugferd' | 'xrechnung' | 'pdf';
  pdf_path: string | null; xml_path: string | null; created_by: string | null;
}
interface AccountRow { id: string; number: string; name: string; street: string; zip: string; city: string; country: string; vat_id: string; email: string; invoice_email: string; leitweg_id: string; payment_terms: string }

const COUNTRY: Record<string, string> = { deutschland: 'DE', germany: 'DE', österreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH', frankreich: 'FR', france: 'FR', italien: 'IT', italy: 'IT',
  niederlande: 'NL', netherlands: 'NL', belgien: 'BE', luxemburg: 'LU', polen: 'PL', tschechien: 'CZ', dänemark: 'DK', spanien: 'ES', schweden: 'SE', ungarn: 'HU', 'vereinigtes königreich': 'GB', großbritannien: 'GB', usa: 'US', 'vereinigte staaten': 'US', china: 'CN' };
export const countryCode = (c: string) => (/^[A-Z]{2}$/.test(c.trim()) ? c.trim() : COUNTRY[c.trim().toLowerCase()] ?? 'DE');
const fmtD = (d: string | null | undefined) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('de-DE') : '');
const today = () => new Date().toISOString().slice(0, 10);

export async function loadInvoice(ctx: AppContext, id: string) {
  const [inv] = await ctx.sql<InvoiceRow[]>`select *, invoice_date::text, service_from::text, service_to::text, due_date::text from crm_invoices where id = ${id}`;
  if (!inv) throw notFound('Rechnung nicht gefunden');
  const [account] = await ctx.sql<AccountRow[]>`select id, number, name, street, zip, city, country, vat_id, email, invoice_email, leitweg_id, payment_terms from crm_accounts where id = ${inv.account_id}`;
  const [contact] = inv.contact_id ? await ctx.sql<{ salutation: string; first_name: string; last_name: string; email: string }[]>`select salutation, first_name, last_name, email from crm_contacts where id = ${inv.contact_id}` : [];
  const partials = inv.kind === 'final' ? await ctx.sql<{ number: string; invoice_date: string; total_net: string; total_tax: string; total_gross: string }[]>`
    select p.number, p.invoice_date::text, p.total_net, p.total_tax, p.total_gross from crm_invoice_partials x join crm_invoices p on p.id = x.partial_id where x.final_id = ${id} order by p.invoice_date, p.number` : [];
  const [original] = inv.cancels_id ? await ctx.sql<{ number: string; invoice_date: string }[]>`select number, invoice_date::text from crm_invoices where id = ${inv.cancels_id}` : [];
  return { inv, account: account!, contact: contact ?? null, partials, original: original ?? null };
}
type Loaded = Awaited<ReturnType<typeof loadInvoice>>;

export async function toEInvoice(ctx: AppContext, l: Loaded, number: string, issueDate: string, due: string | null, terms: string): Promise<EInvoice> {
  const s = await ctx.settings.get('invoicing');
  const company = await ctx.settings.get('company');
  const { inv, account } = l;
  const prepaid = l.partials.reduce((a, p) => a + Number(p.total_gross), 0);
  return {
    profile: inv.format === 'xrechnung' ? 'xrechnung' : 'en16931',
    number, typeCode: inv.kind === 'credit' ? '381' : inv.kind === 'partial' ? '326' : '380', issueDate, dueDate: inv.kind === 'credit' ? null : due,
    serviceFrom: inv.service_from, serviceTo: inv.service_to ?? inv.service_from,
    buyerReference: inv.buyer_reference || account.leitweg_id || (inv.format === 'xrechnung' ? '' : account.number), orderReference: inv.order_reference || undefined,
    precedingInvoice: l.original ? { number: l.original.number, date: l.original.invoice_date } : null,
    seller: { name: s.legalName || company.name, street: s.street, zip: s.zip, city: s.city, countryCode: s.countryCode || 'DE', vatId: s.vatId || undefined, taxNumber: s.taxNumber || undefined,
      registry: s.registry || undefined, email: s.contactEmail || undefined, contactName: s.contactName || undefined, contactPhone: s.contactPhone || undefined, contactEmail: s.contactEmail || undefined },
    buyer: { name: account.name, street: account.street, zip: account.zip, city: account.city, countryCode: countryCode(account.country), vatId: account.vat_id || undefined,
      email: account.invoice_email || account.email || l.contact?.email || undefined, id: account.number },
    iban: s.iban || undefined, bic: s.bic || undefined, accountName: s.legalName || company.name,
    positions: inv.positions, vatRate: Number(inv.vat_rate), taxMode: inv.tax_mode, paymentTerms: terms,
    notes: [TAX_MODES[inv.tax_mode].note, inv.kind === 'credit' && l.original ? `Storno der Rechnung ${l.original.number} vom ${fmtD(l.original.invoice_date)}` : ''].filter(Boolean),
    prepaid,
  };
}

/** Zahlungsbedingungen als Text (mit Skonto im XRechnung-Format) */
export async function paymentTermsText(ctx: AppContext, issueDate: string, due: string) {
  const s = await ctx.settings.get('invoicing');
  const lines = [`Zahlbar bis ${fmtD(due)} ohne Abzug.`];
  if (s.skonto && s.skonto.percent > 0) {
    lines.push(`Bei Zahlung bis ${fmtD(dueDate(issueDate, s.skonto.days))} ${num(s.skonto.percent)} % Skonto.`);
    lines.push(`#SKONTO#TAGE=${s.skonto.days}#PROZENT=${s.skonto.percent.toFixed(2)}#`);
  }
  return `${lines.join('\n')}\n`;
}

export async function renderInvoicePdf(ctx: AppContext, l: Loaded, e: EInvoice, xml: string | null): Promise<Buffer> {
  const lh = await ctx.settings.get('letterhead');
  const s = await ctx.settings.get('invoicing');
  const { inv, account, contact } = l;
  const kindLabel = INVOICE_KIND[inv.kind];
  const pdf = new Pdf(`${kindLabel} ${e.number}`, e.seller.name, { archive: Boolean(xml) });
  const L = pdf.margin, R = pdf.width - pdf.margin;
  pdf.text(L, pdf.y, e.seller.name, { size: 14, bold: true });
  pdf.text(L, pdf.y + 18, [e.seller.name, e.seller.street, `${e.seller.zip} ${e.seller.city}`].filter(Boolean).join(' · '), { size: 7, color: '#6b7280' });
  pdf.y += 60;
  const addr = [account.name, contact ? `${contact.salutation} ${contact.first_name} ${contact.last_name}`.trim() : '', account.street, `${account.zip} ${account.city}`.trim(), e.buyer.countryCode !== 'DE' ? account.country : ''].filter(Boolean);
  for (const a of addr) { pdf.text(L, pdf.y, a, { size: 10 }); pdf.y += 13; }
  const metaY = pdf.y - 13 * addr.length - 10;
  const service = inv.service_from && inv.service_to && inv.service_from !== inv.service_to ? `${fmtD(inv.service_from)} – ${fmtD(inv.service_to)}` : fmtD(inv.service_to ?? inv.service_from) || fmtD(e.issueDate);
  const meta: [string, string][] = [['Rechnungs-Nr.', e.number], ['Datum', fmtD(e.issueDate)], [inv.service_from && inv.service_to && inv.service_from !== inv.service_to ? 'Leistungszeitraum' : 'Leistungsdatum', service],
    ['Kunden-Nr.', account.number], ...(inv.order_reference ? [['Ihre Bestellung', inv.order_reference] as [string, string]] : []),
    ...(account.leitweg_id && inv.format === 'xrechnung' ? [['Leitweg-ID', account.leitweg_id] as [string, string]] : [])];
  meta.forEach(([k, v], i) => { pdf.text(360, metaY + i * 13, k, { size: 9, color: '#6b7280' }); pdf.text(455, metaY + i * 13, v, { size: 9 }); });
  pdf.y = Math.max(pdf.y, metaY + meta.length * 13) + 28;
  pdf.paragraph(`${kindLabel} ${e.number}${inv.title ? `: ${inv.title}` : ''}`, { size: 14, bold: true, gap: 10 });
  if (inv.kind === 'credit' && l.original) pdf.paragraph(`Hiermit stornieren wir die Rechnung ${l.original.number} vom ${fmtD(l.original.invoice_date)} vollständig. Der Betrag wird Ihnen gutgeschrieben.`, { gap: 8 });
  else {
    pdf.paragraph(contact ? `Sehr geehrte${contact.salutation === 'Herr' ? 'r Herr' : contact.salutation === 'Frau' ? ' Frau' : ''} ${contact.salutation ? contact.last_name : `${contact.first_name} ${contact.last_name}`.trim()},` : 'Sehr geehrte Damen und Herren,', { gap: 6 });
    if (inv.intro) pdf.paragraph(inv.intro, { gap: 10 });
  }
  const multiRate = new Set(inv.positions.map((p) => p.vatRate ?? Number(inv.vat_rate))).size > 1 && inv.tax_mode === 'standard';
  const rows = inv.positions.map((p, i) => [String(i + 1), p.description ? `${p.text}\n${p.description}` : p.text, `${num(p.qty, 3)} ${p.unit}`, eur(p.price),
    p.discount ? `${num(p.discount)} %` : '', ...(multiRate ? [`${num(p.vatRate ?? Number(inv.vat_rate))} %`] : []), eur(positionNet(p))]);
  pdf.table([{ label: 'Pos.', width: 30 }, { label: 'Bezeichnung', width: multiRate ? 190 : 225 }, { label: 'Menge', width: 60, align: 'right' }, { label: 'Einzelpreis', width: 70, align: 'right' },
    { label: 'Rabatt', width: 40, align: 'right' }, ...(multiRate ? [{ label: 'USt', width: 35, align: 'right' as const }] : []), { label: 'Gesamt', width: 70, align: 'right' }], rows, { zebra: true });
  const t = invoiceTotals(inv.positions, Number(inv.vat_rate), inv.tax_mode);
  pdf.ensure(80);
  const sum = (k: string, v: string, bold = false) => { pdf.text(300, pdf.y, k, { bold }); pdf.text(R - 120, pdf.y, v, { bold, align: 'right', width: 120 }); pdf.y += 15; };
  sum('Summe netto', eur(t.net));
  for (const g of t.groups) sum(inv.tax_mode === 'standard' ? `zzgl. ${num(g.rate)} % USt auf ${eur(g.basis)}` : 'Umsatzsteuer', eur(g.tax));
  sum(inv.kind === 'credit' ? 'Gutschriftsbetrag' : 'Rechnungsbetrag', eur(t.gross), true);
  if (l.partials.length) {
    pdf.y += 6;
    pdf.paragraph('Abzüglich bereits berechneter Abschläge:', { size: 9, bold: true, gap: 2 });
    for (const p of l.partials) sum(`${p.number} vom ${fmtD(p.invoice_date)} (netto ${eur(Number(p.total_net))}, USt ${eur(Number(p.total_tax))})`, `− ${eur(Number(p.total_gross))}`);
    sum('Noch zu zahlen', eur(t.gross - (e.prepaid ?? 0)), true);
  }
  pdf.y += 8;
  if (TAX_MODES[inv.tax_mode].note) pdf.paragraph(TAX_MODES[inv.tax_mode].note, { size: 9, bold: true });
  if (inv.tax_mode === 'reverse_charge' || inv.tax_mode === 'intra_eu') pdf.paragraph(`USt-ID des Leistungsempfängers: ${account.vat_id}`, { size: 9 });
  if (inv.kind !== 'credit' && e.paymentTerms) pdf.paragraph(e.paymentTerms.split('\n').filter((x) => x && !x.startsWith('#')).join(' '), { size: 9 });
  if (inv.kind !== 'credit' && s.iban) pdf.paragraph(`Bitte überweisen Sie unter Angabe der Rechnungsnummer ${e.number} auf: ${s.bankName ? `${s.bankName}, ` : ''}IBAN ${s.iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()}${s.bic ? `, BIC ${s.bic}` : ''}`, { size: 9 });
  if (inv.outro && inv.kind !== 'credit') pdf.paragraph(inv.outro, { gap: 8 });
  if (xml) pdf.paragraph('Diese Rechnung enthält eine maschinenlesbare E-Rechnung (ZUGFeRD/Factur-X, Profil EN 16931).', { size: 7, color: '#6b7280' });
  // Pflichtangaben im Fuß: Firma, Steuernummer/USt-ID, Register, Geschäftsführung, Bank
  const line1 = [e.seller.name, [e.seller.street, `${e.seller.zip} ${e.seller.city}`].filter((x) => x.trim()).join(', '), s.vatId ? `USt-ID ${s.vatId}` : '', s.taxNumber ? `St.-Nr. ${s.taxNumber}` : ''].filter(Boolean).join(' · ');
  const line2 = [s.registry, s.managingDirector ? `Geschäftsführung: ${s.managingDirector}` : '', lh.footer].filter(Boolean).join(' · ');
  pdf.footer((p, n) => `${line1}\n${line2 ? `${line2} · ` : ''}Seite ${p} von ${n}`);
  if (xml) {
    pdf.attach({ name: 'factur-x.xml', data: Buffer.from(xml, 'utf8'), mime: 'text/xml', description: 'Rechnungsdaten im Format Factur-X/ZUGFeRD', relationship: 'Alternative' });
    pdf.markFacturX('EN 16931');
  }
  return pdf.toBuffer();
}

/** Festschreiben: Nummer, Datum, Fälligkeit, Summen, PDF und XML – danach unveränderbar */
export async function finalizeInvoice(ctx: AppContext, u: AuthUser, id: string) {
  const { sql, storage } = ctx;
  const l = await loadInvoice(ctx, id);
  if (l.inv.status !== 'draft') throw badRequest('Die Rechnung ist bereits festgeschrieben.');
  const s = await ctx.settings.get('invoicing');
  const issue = l.inv.invoice_date ?? today();
  const due = l.inv.kind === 'credit' ? null : l.inv.due_date ?? dueDate(issue, s.dueDays);
  const terms = l.inv.kind === 'credit' ? 'Der Betrag wird mit offenen Forderungen verrechnet oder erstattet.' : l.inv.payment_terms || await paymentTermsText(ctx, issue, due!);
  // Prüfen mit Platzhalter-Nummer, damit bei Fehlern keine Nummer verbraucht wird
  const probe = await toEInvoice(ctx, l, 'PRUEFUNG', issue, due, terms);
  const problems = checkEInvoice(probe);
  if (problems.length) throw Object.assign(badRequest(`Die Rechnung kann noch nicht festgeschrieben werden: ${problems.join('; ')}`), { details: { problems } });
  const nums = await ctx.settings.get('numbers');
  const number = await nextNumber(sql, 'invoice', nums.invoice, async (x) => (await sql`select 1 from crm_invoices where number = ${x}`).length > 0, { customer: l.account.number });
  const e = { ...probe, number };
  const xml = l.inv.format === 'pdf' ? null : buildCii(e);
  const pdf = await renderInvoicePdf(ctx, l, e, l.inv.format === 'zugferd' ? xml : null);
  const base = `.aperio/invoices/${issue.slice(0, 4)}/${safeName(number)}`;
  await storage.write(`${base}.pdf`, Readable.from(pdf));
  if (xml) await storage.write(`${base}.xml`, Readable.from(Buffer.from(xml, 'utf8')));
  const t = invoiceTotals(l.inv.positions, Number(l.inv.vat_rate), l.inv.tax_mode);
  await sql`update crm_invoices set number = ${number}, status = 'open', invoice_date = ${issue}, due_date = ${due}, payment_terms = ${terms},
    total_net = ${t.net}, total_tax = ${t.tax}, total_gross = ${t.gross}, prepaid = ${e.prepaid ?? 0},
    pdf_path = ${`${base}.pdf`}, xml_path = ${xml ? `${base}.xml` : null}, finalized_at = now(), finalized_by = ${u.id}, updated_at = now() where id = ${id}`;
  await audit(sql, u, { action: 'crm.invoice.finalize', entityType: 'crm_invoice', entityId: id, projectId: l.inv.project_id ?? undefined, summary: `${INVOICE_KIND[l.inv.kind]} ${number} über ${eur(t.gross)} festgeschrieben` });
  ctx.hub.publish('global', 'invoices.changed', { id });
  return { number };
}

/** Storno: Stornorechnung mit gleichen Positionen, Original wird „storniert“ */
export async function cancelInvoice(ctx: AppContext, u: AuthUser, id: string, reason: string) {
  const { sql } = ctx;
  const l = await loadInvoice(ctx, id);
  if (l.inv.status === 'draft') throw badRequest('Entwürfe werden gelöscht, nicht storniert.');
  if (l.inv.status === 'cancelled') throw badRequest('Die Rechnung ist bereits storniert.');
  if (l.inv.kind === 'credit') throw badRequest('Eine Stornorechnung kann nicht storniert werden.');
  if (Number(l.inv.paid_amount) > 0) throw badRequest('Auf die Rechnung wurde schon gezahlt. Bitte zuerst die Zahlungen ausbuchen oder eine Gutschrift für den Teilbetrag erstellen.');
  const [c] = await sql<{ id: string }[]>`insert into crm_invoices (kind, account_id, contact_id, project_id, cancels_id, title, invoice_date, service_from, service_to, buyer_reference, order_reference,
      positions, vat_rate, tax_mode, format, created_by)
    values ('credit', ${l.inv.account_id}, ${l.inv.contact_id}, ${l.inv.project_id}, ${id}, ${reason ? `Storno: ${reason}` : `Storno zu ${l.inv.number}`}, ${today()},
      ${l.inv.service_from}, ${l.inv.service_to}, ${l.inv.buyer_reference}, ${l.inv.order_reference}, ${sql.json(l.inv.positions as never)}, ${l.inv.vat_rate}, ${l.inv.tax_mode}, ${l.inv.format}, ${u.id}) returning id`;
  const r = await finalizeInvoice(ctx, u, c!.id);
  await sql`update crm_invoices set status = 'paid', paid_amount = total_gross where id = ${c!.id}`;
  await sql`update crm_invoices set status = 'cancelled', updated_at = now() where id = ${id}`;
  // in einer Schlussrechnung verrechnete Abschläge freigeben
  await sql`delete from crm_invoice_partials where final_id = ${id}`;
  await audit(sql, u, { action: 'crm.invoice.cancel', entityType: 'crm_invoice', entityId: id, summary: `Rechnung ${l.inv.number} storniert durch ${r.number}` });
  return { id: c!.id, number: r.number };
}

/** Zahlung buchen und Status anpassen */
export async function addPayment(ctx: AppContext, u: AuthUser | null, invoiceId: string, p: { date: string; amount: number; method?: string; note?: string; bankTxId?: string | null }) {
  const { sql } = ctx;
  const [inv] = await sql<{ status: string; total_gross: string; prepaid: string; paid_amount: string; number: string }[]>`select status, total_gross, prepaid, paid_amount, number from crm_invoices where id = ${invoiceId}`;
  if (!inv) throw notFound('Rechnung nicht gefunden');
  if (inv.status === 'draft' || inv.status === 'cancelled') throw badRequest('Für diese Rechnung können keine Zahlungen gebucht werden.');
  await sql`insert into crm_invoice_payments (invoice_id, date, amount, method, note, bank_tx_id, user_id) values (${invoiceId}, ${p.date}, ${p.amount}, ${p.method ?? 'transfer'}, ${p.note ?? ''}, ${p.bankTxId ?? null}, ${u?.id ?? null})`;
  return recalcPaid(ctx, invoiceId);
}

export async function recalcPaid(ctx: AppContext, invoiceId: string) {
  const { sql } = ctx;
  const [r] = await sql<{ paid: string; due: string; status: string }[]>`select coalesce((select sum(amount) from crm_invoice_payments where invoice_id = i.id), 0) as paid,
    i.total_gross - i.prepaid as due, i.status from crm_invoices i where i.id = ${invoiceId}`;
  const paid = Number(r!.paid), due = Number(r!.due);
  const status = r!.status === 'cancelled' ? 'cancelled' : paid >= due - 0.005 ? 'paid' : paid > 0 ? 'partial' : 'open';
  await sql`update crm_invoices set paid_amount = ${paid}, status = ${status}, updated_at = now() where id = ${invoiceId}`;
  ctx.hub.publish('global', 'invoices.changed', { id: invoiceId });
  return { paid, status };
}
