/**
 * Eingehende E-Rechnungen lesen: XRechnung/ZUGFeRD im CII-Format und UBL-Rechnungen (z. B. aus Peppol).
 * Aus PDF-Dateien wird die eingebettete XML-Datei (factur-x.xml, zugferd-invoice.xml, xrechnung.xml) herausgelöst.
 */
import { inflateSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

export interface ParsedParty { name: string; vatId: string; taxNumber: string; street: string; zip: string; city: string; country: string; email: string }
export interface ParsedLine { text: string; qty: number; unit: string; net: number; rate: number; category: string }
export interface ParsedInvoice {
  syntax: 'CII' | 'UBL'; number: string; typeCode: string; issueDate: string | null; dueDate: string | null; serviceDate: string | null; currency: string;
  seller: ParsedParty; buyer: ParsedParty; buyerReference: string; orderReference: string; iban: string; bic: string; paymentTerms: string;
  lines: ParsedLine[]; taxes: { rate: number; basis: number; tax: number; category: string }[]; net: number; tax: number; gross: number; prepaid: number; due: number;
}

const ARRAYS = new Set(['IncludedSupplyChainTradeLineItem', 'ApplicableTradeTax', 'SpecifiedTaxRegistration', 'IncludedNote', 'SpecifiedTradeSettlementPaymentMeans',
  'InvoiceLine', 'CreditNoteLine', 'TaxSubtotal', 'PartyTaxScheme', 'PaymentMeans', 'TaxTotal', 'SpecifiedTradePaymentTerms', 'PaymentTerms', 'Note']);
const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: true, isArray: (name) => ARRAYS.has(name) });

const txt = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v));
const num = (v: unknown) => { const s = txt(v); return s ? Number(s) : 0; };
const date102 = (v: unknown) => { const s = txt(v); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const at = (o: any, ...path: string[]) => path.reduce((x, k) => (x === undefined || x === null ? undefined : Array.isArray(x) ? x[0]?.[k] : x[k]), o);
const emptyParty = (): ParsedParty => ({ name: '', vatId: '', taxNumber: '', street: '', zip: '', city: '', country: '', email: '' });

function ciiParty(p: any): ParsedParty {
  if (!p) return emptyParty();
  const regs = (p.SpecifiedTaxRegistration ?? []) as any[];
  const reg = (scheme: string) => txt(regs.map((r) => r.ID).find((id) => id?.['@schemeID'] === scheme));
  const a = p.PostalTradeAddress ?? {};
  return { name: txt(p.Name), vatId: reg('VA'), taxNumber: reg('FC'), street: txt(a.LineOne), zip: txt(a.PostcodeCode), city: txt(a.CityName), country: txt(a.CountryID),
    email: txt(at(p, 'URIUniversalCommunication', 'URIID')) || txt(at(p, 'DefinedTradeContact', 'EmailURIUniversalCommunication', 'URIID')) };
}

function readCii(doc: any): ParsedInvoice {
  const root = doc.CrossIndustryInvoice;
  const ed = root.ExchangedDocument ?? {};
  const tx = root.SupplyChainTradeTransaction ?? {};
  const ag = tx.ApplicableHeaderTradeAgreement ?? {};
  const st = tx.ApplicableHeaderTradeSettlement ?? {};
  const sum = st.SpecifiedTradeSettlementHeaderMonetarySummation ?? {};
  const means = (st.SpecifiedTradeSettlementPaymentMeans ?? [])[0] ?? {};
  const terms = (st.SpecifiedTradePaymentTerms ?? [])[0] ?? {};
  const lines = ((tx.IncludedSupplyChainTradeLineItem ?? []) as any[]).map((l) => {
    const tax = (at(l, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax') ?? {});
    const q = at(l, 'SpecifiedLineTradeDelivery', 'BilledQuantity');
    return { text: txt(at(l, 'SpecifiedTradeProduct', 'Name')), qty: num(q), unit: txt(q?.['@unitCode']), net: num(at(l, 'SpecifiedLineTradeSettlement', 'SpecifiedTradeSettlementLineMonetarySummation', 'LineTotalAmount')),
      rate: num(Array.isArray(tax) ? tax[0]?.RateApplicablePercent : tax.RateApplicablePercent), category: txt(Array.isArray(tax) ? tax[0]?.CategoryCode : tax.CategoryCode) };
  });
  const taxes = ((st.ApplicableTradeTax ?? []) as any[]).map((t) => ({ rate: num(t.RateApplicablePercent), basis: num(t.BasisAmount), tax: num(t.CalculatedAmount), category: txt(t.CategoryCode) }));
  const taxTotal = Array.isArray(sum.TaxTotalAmount) ? sum.TaxTotalAmount[0] : sum.TaxTotalAmount;
  return {
    syntax: 'CII', number: txt(ed.ID), typeCode: txt(ed.TypeCode), issueDate: date102(at(ed, 'IssueDateTime', 'DateTimeString')),
    dueDate: date102(at(terms, 'DueDateDateTime', 'DateTimeString')), serviceDate: date102(at(tx, 'ApplicableHeaderTradeDelivery', 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime', 'DateTimeString'))
      ?? date102(at(st, 'BillingSpecifiedPeriod', 'EndDateTime', 'DateTimeString')),
    currency: txt(st.InvoiceCurrencyCode) || 'EUR', seller: ciiParty(ag.SellerTradeParty), buyer: ciiParty(ag.BuyerTradeParty),
    buyerReference: txt(ag.BuyerReference), orderReference: txt(at(ag, 'BuyerOrderReferencedDocument', 'IssuerAssignedID')),
    iban: txt(at(means, 'PayeePartyCreditorFinancialAccount', 'IBANID')), bic: txt(at(means, 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID')), paymentTerms: txt(terms.Description),
    lines, taxes, net: num(sum.TaxBasisTotalAmount) || num(sum.LineTotalAmount), tax: num(taxTotal), gross: num(sum.GrandTotalAmount), prepaid: num(sum.TotalPrepaidAmount), due: num(sum.DuePayableAmount),
  };
}

function ublParty(p: any): ParsedParty {
  const party = p?.Party;
  if (!party) return emptyParty();
  const schemes = (party.PartyTaxScheme ?? []) as any[];
  const vat = schemes.find((s) => txt(at(s, 'TaxScheme', 'ID')) === 'VAT');
  const other = schemes.find((s) => txt(at(s, 'TaxScheme', 'ID')) !== 'VAT');
  const a = party.PostalAddress ?? {};
  return { name: txt(at(party, 'PartyLegalEntity', 'RegistrationName')) || txt(at(party, 'PartyName', 'Name')), vatId: txt(vat?.CompanyID), taxNumber: txt(other?.CompanyID),
    street: txt(a.StreetName), zip: txt(a.PostalZone), city: txt(a.CityName), country: txt(at(a, 'Country', 'IdentificationCode')), email: txt(party.EndpointID) || txt(at(party, 'Contact', 'ElectronicMail')) };
}

function readUbl(doc: any): ParsedInvoice {
  const credit = Boolean(doc.CreditNote);
  const r = doc.Invoice ?? doc.CreditNote;
  const total = r.LegalMonetaryTotal ?? {};
  const taxTotal = (r.TaxTotal ?? [])[0] ?? {};
  const means = (r.PaymentMeans ?? [])[0] ?? {};
  const lines = ((credit ? r.CreditNoteLine : r.InvoiceLine) ?? []) as any[];
  return {
    syntax: 'UBL', number: txt(r.ID), typeCode: txt(credit ? r.CreditNoteTypeCode : r.InvoiceTypeCode) || (credit ? '381' : '380'), issueDate: date102(r.IssueDate), dueDate: date102(r.DueDate ?? at(means, 'PaymentDueDate')),
    serviceDate: date102(at(r, 'Delivery', 'ActualDeliveryDate')) ?? date102(at(r, 'InvoicePeriod', 'EndDate')), currency: txt(r.DocumentCurrencyCode) || 'EUR',
    seller: ublParty(r.AccountingSupplierParty), buyer: ublParty(r.AccountingCustomerParty), buyerReference: txt(r.BuyerReference), orderReference: txt(at(r, 'OrderReference', 'ID')),
    iban: txt(at(means, 'PayeeFinancialAccount', 'ID')), bic: txt(at(means, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID')), paymentTerms: txt(at((r.PaymentTerms ?? [])[0], 'Note')),
    lines: lines.map((l) => { const q = credit ? l.CreditedQuantity : l.InvoicedQuantity; const ct = at(l, 'Item', 'ClassifiedTaxCategory');
      return { text: txt(at(l, 'Item', 'Name')), qty: num(q), unit: txt(q?.['@unitCode']), net: num(l.LineExtensionAmount), rate: num(ct?.Percent), category: txt(ct?.ID) }; }),
    taxes: ((taxTotal.TaxSubtotal ?? []) as any[]).map((t) => ({ rate: num(at(t, 'TaxCategory', 'Percent')), basis: num(t.TaxableAmount), tax: num(t.TaxAmount), category: txt(at(t, 'TaxCategory', 'ID')) })),
    net: num(total.TaxExclusiveAmount), tax: num(taxTotal.TaxAmount), gross: num(total.TaxInclusiveAmount), prepaid: num(total.PrepaidAmount), due: num(total.PayableAmount),
  };
}

/** XML einer E-Rechnung lesen; null, wenn es keine ist */
export function parseEInvoiceXml(xml: string): ParsedInvoice | null {
  let doc: any;
  try { doc = parser.parse(xml); } catch { return null; }
  if (doc?.CrossIndustryInvoice) return readCii(doc);
  if (doc?.Invoice || doc?.CreditNote) return readUbl(doc);
  return null;
}

/** Eingebettete Dateien aus einem PDF herauslösen (Ströme mit /Type /EmbeddedFile, ggf. entpackt) */
export function pdfAttachments(pdf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const s = pdf.toString('latin1');
  const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const dict = m[1]!;
    if (!/\/Type\s*\/EmbeddedFile\b/.test(dict) && !/\/Subtype\s*\/text#2Fxml/i.test(dict)) continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    let data = pdf.subarray(start, end);
    // Zeilenende vor „endstream“ abschneiden
    while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.subarray(0, data.length - 1);
    if (/\/Filter\s*\/FlateDecode/.test(dict) || /\/Filter\s*\[\s*\/FlateDecode\s*\]/.test(dict)) { try { data = inflateSync(data); } catch { continue; } }
    out.push(Buffer.from(data));
  }
  return out;
}

/** Datei (PDF oder XML) → E-Rechnung, falls enthalten */
export function readEInvoiceFile(name: string, data: Buffer): { invoice: ParsedInvoice; xml: string } | null {
  if (/\.xml$/i.test(name) || data.subarray(0, 100).toString('utf8').includes('<?xml')) {
    const xml = data.toString('utf8');
    const invoice = parseEInvoiceXml(xml);
    return invoice ? { invoice, xml } : null;
  }
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') {
    for (const a of pdfAttachments(data)) {
      const xml = a.toString('utf8');
      const invoice = parseEInvoiceXml(xml);
      if (invoice) return { invoice, xml };
    }
  }
  return null;
}
