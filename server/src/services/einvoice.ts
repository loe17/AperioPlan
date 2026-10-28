/**
 * E-Rechnung im Format UN/CEFACT CII (Cross Industry Invoice, D16B) nach EN 16931.
 * Dasselbe XML dient als XRechnung 3.0 (eigenständige XML-Datei) und als ZUGFeRD 2/Factur-X EN 16931
 * (in das PDF/A-3 eingebettet). Die Reihenfolge der Elemente folgt dem XML-Schema.
 */
import { invoiceTotals, netUnitPrice, positionNet, TAX_MODES, unitCode, type InvoicePosition, type TaxMode } from '@aperio/shared';

export interface EParty {
  name: string; street: string; zip: string; city: string; countryCode: string;
  vatId?: string; taxNumber?: string; registry?: string; email?: string; contactName?: string; contactPhone?: string; contactEmail?: string; id?: string;
}
export interface EInvoice {
  profile: 'xrechnung' | 'en16931';
  number: string; typeCode: '380' | '326' | '381' | '384'; issueDate: string; dueDate?: string | null;
  serviceFrom?: string | null; serviceTo?: string | null;
  buyerReference: string; orderReference?: string; precedingInvoice?: { number: string; date: string } | null;
  seller: EParty; buyer: EParty;
  iban?: string; bic?: string; accountName?: string;
  positions: InvoicePosition[]; vatRate: number; taxMode: TaxMode;
  paymentTerms?: string; notes?: string[]; prepaid?: number; currency?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (n: number) => n.toFixed(2);
const qty = (n: number) => String(Math.round(n * 10000) / 10000);
const price = (n: number) => { const s = n.toFixed(4).replace(/0{1,2}$/, ''); return s; };
const d102 = (d: string) => d.slice(0, 10).replace(/-/g, '');
const el = (tag: string, body: string | null | undefined, attrs = '') => (body === null || body === undefined || body === '' ? '' : `<${tag}${attrs}>${body}</${tag}>`);
const txt = (tag: string, v: string | null | undefined, attrs = '') => (v ? `<${tag}${attrs}>${esc(v)}</${tag}>` : '');

function party(tag: string, p: EParty, withContact: boolean) {
  const contact = withContact && (p.contactName || p.contactPhone || p.contactEmail)
    ? `<ram:DefinedTradeContact>${txt('ram:PersonName', p.contactName)}${p.contactPhone ? `<ram:TelephoneUniversalCommunication>${txt('ram:CompleteNumber', p.contactPhone)}</ram:TelephoneUniversalCommunication>` : ''}${p.contactEmail ? `<ram:EmailURIUniversalCommunication>${txt('ram:URIID', p.contactEmail)}</ram:EmailURIUniversalCommunication>` : ''}</ram:DefinedTradeContact>`
    : '';
  const tax = [p.vatId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(p.vatId.replace(/\s+/g, ''))}</ram:ID></ram:SpecifiedTaxRegistration>` : '',
    p.taxNumber ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(p.taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''].join('');
  return `<${tag}>${txt('ram:ID', p.id)}${txt('ram:Name', p.name)}${p.registry ? `<ram:SpecifiedLegalOrganization><ram:ID>${esc(p.registry)}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}${contact}`
    + `<ram:PostalTradeAddress>${txt('ram:PostcodeCode', p.zip)}${txt('ram:LineOne', p.street)}${txt('ram:CityName', p.city)}<ram:CountryID>${esc(p.countryCode || 'DE')}</ram:CountryID></ram:PostalTradeAddress>`
    + `${p.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(p.email)}</ram:URIID></ram:URIUniversalCommunication>` : ''}${tax}</${tag}>`;
}

export function buildCii(inv: EInvoice): string {
  const cur = inv.currency ?? 'EUR';
  const mode = TAX_MODES[inv.taxMode];
  const totals = invoiceTotals(inv.positions, inv.vatRate, inv.taxMode);
  const prepaid = Math.round((inv.prepaid ?? 0) * 100) / 100;
  const guideline = inv.profile === 'xrechnung' ? 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0' : 'urn:cen.eu:en16931:2017';
  const lines = inv.positions.map((p, i) => {
    const rate = inv.taxMode === 'standard' ? p.vatRate ?? inv.vatRate : 0;
    const gross = p.discount ? `<ram:GrossPriceProductTradePrice><ram:ChargeAmount>${price(p.price)}</ram:ChargeAmount><ram:AppliedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:ActualAmount>${price(p.price - netUnitPrice(p))}</ram:ActualAmount></ram:AppliedTradeAllowanceCharge></ram:GrossPriceProductTradePrice>` : '';
    return `<ram:IncludedSupplyChainTradeLineItem>`
      + `<ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>`
      + `<ram:SpecifiedTradeProduct>${txt('ram:Name', p.text || 'Position')}${txt('ram:Description', p.description)}</ram:SpecifiedTradeProduct>`
      + `<ram:SpecifiedLineTradeAgreement>${gross}<ram:NetPriceProductTradePrice><ram:ChargeAmount>${price(netUnitPrice(p))}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>`
      + `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${unitCode(p.unit)}">${qty(p.qty)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`
      + `<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${mode.category}</ram:CategoryCode><ram:RateApplicablePercent>${qty(rate)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`
      + `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amt(positionNet(p))}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>`
      + `</ram:IncludedSupplyChainTradeLineItem>`;
  }).join('');
  const taxes = totals.groups.map((g) => `<ram:ApplicableTradeTax><ram:CalculatedAmount>${amt(g.tax)}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>`
    + `${mode.note ? txt('ram:ExemptionReason', mode.note) : ''}<ram:BasisAmount>${amt(g.basis)}</ram:BasisAmount><ram:CategoryCode>${g.category}</ram:CategoryCode>`
    + `${mode.reasonCode ? `<ram:ExemptionReasonCode>${mode.reasonCode}</ram:ExemptionReasonCode>` : ''}<ram:RateApplicablePercent>${qty(g.rate)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`).join('');
  const period = inv.serviceFrom && inv.serviceTo && inv.serviceFrom !== inv.serviceTo
    ? `<ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString format="102">${d102(inv.serviceFrom)}</udt:DateTimeString></ram:StartDateTime><ram:EndDateTime><udt:DateTimeString format="102">${d102(inv.serviceTo)}</udt:DateTimeString></ram:EndDateTime></ram:BillingSpecifiedPeriod>`
    : '';
  // Käufer-Kennung (BR-CO-26): ohne USt-ID und Handelsregister dient die Steuernummer als Verkäuferkennung
  const seller = { ...inv.seller, id: inv.seller.id ?? (!inv.seller.vatId && !inv.seller.registry ? inv.seller.taxNumber : undefined) };
  // innergemeinschaftliche Lieferung: Lieferland muss angegeben sein (BR-IC-12)
  const shipTo = inv.taxMode === 'intra_eu'
    ? `<ram:ShipToTradeParty>${txt('ram:Name', inv.buyer.name)}<ram:PostalTradeAddress>${txt('ram:PostcodeCode', inv.buyer.zip)}${txt('ram:LineOne', inv.buyer.street)}${txt('ram:CityName', inv.buyer.city)}<ram:CountryID>${esc(inv.buyer.countryCode)}</ram:CountryID></ram:PostalTradeAddress></ram:ShipToTradeParty>`
    : '';
  const deliveryDate = !period && (inv.serviceTo || inv.serviceFrom) ? `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${d102((inv.serviceTo || inv.serviceFrom)!)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>` : '';
  const due = Math.round((totals.gross - prepaid) * 100) / 100;
  const means = inv.iban
    ? `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(inv.iban.replace(/\s+/g, '').toUpperCase())}</ram:IBANID>${txt('ram:AccountName', inv.accountName)}</ram:PayeePartyCreditorFinancialAccount>${inv.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${esc(inv.bic.replace(/\s+/g, ''))}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>` : ''}</ram:SpecifiedTradeSettlementPaymentMeans>`
    : `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>1</ram:TypeCode></ram:SpecifiedTradeSettlementPaymentMeans>`;
  const terms = inv.paymentTerms || inv.dueDate
    ? `<ram:SpecifiedTradePaymentTerms>${txt('ram:Description', inv.paymentTerms)}${inv.dueDate ? `<ram:DueDateDateTime><udt:DateTimeString format="102">${d102(inv.dueDate)}</udt:DateTimeString></ram:DueDateDateTime>` : ''}</ram:SpecifiedTradePaymentTerms>`
    : '';
  const preceding = inv.precedingInvoice
    ? `<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${esc(inv.precedingInvoice.number)}</ram:IssuerAssignedID><ram:FormattedIssueDateTime><qdt:DateTimeString format="102">${d102(inv.precedingInvoice.date)}</qdt:DateTimeString></ram:FormattedIssueDateTime></ram:InvoiceReferencedDocument>`
    : '';
  const notes = (inv.notes ?? []).filter(Boolean).map((n) => `<ram:IncludedNote><ram:Content>${esc(n)}</ram:Content></ram:IncludedNote>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">`
    + `<rsm:ExchangedDocumentContext><ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>`
    + `<ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${guideline}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>`
    + `<rsm:ExchangedDocument><ram:ID>${esc(inv.number)}</ram:ID><ram:TypeCode>${inv.typeCode}</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">${d102(inv.issueDate)}</udt:DateTimeString></ram:IssueDateTime>${notes}</rsm:ExchangedDocument>`
    + `<rsm:SupplyChainTradeTransaction>${lines}`
    + `<ram:ApplicableHeaderTradeAgreement>${txt('ram:BuyerReference', inv.buyerReference)}${party('ram:SellerTradeParty', seller, true)}${party('ram:BuyerTradeParty', inv.buyer, false)}`
    + `${inv.orderReference ? `<ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>${esc(inv.orderReference)}</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>` : ''}</ram:ApplicableHeaderTradeAgreement>`
    + `<ram:ApplicableHeaderTradeDelivery>${shipTo}${deliveryDate}</ram:ApplicableHeaderTradeDelivery>`
    + `<ram:ApplicableHeaderTradeSettlement><ram:PaymentReference>${esc(inv.number)}</ram:PaymentReference><ram:InvoiceCurrencyCode>${cur}</ram:InvoiceCurrencyCode>${means}${taxes}${period}${terms}`
    + `<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>${amt(totals.net)}</ram:LineTotalAmount><ram:TaxBasisTotalAmount>${amt(totals.net)}</ram:TaxBasisTotalAmount>`
    + `<ram:TaxTotalAmount currencyID="${cur}">${amt(totals.tax)}</ram:TaxTotalAmount><ram:GrandTotalAmount>${amt(totals.gross)}</ram:GrandTotalAmount>`
    + `${prepaid ? `<ram:TotalPrepaidAmount>${amt(prepaid)}</ram:TotalPrepaidAmount>` : ''}<ram:DuePayableAmount>${amt(due)}</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>`
    + `${preceding}</ram:ApplicableHeaderTradeSettlement></rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>\n`;
}

/** Pflichtangaben prüfen, bevor eine Rechnung festgeschrieben wird – Meldungen in Alltagssprache */
export function checkEInvoice(inv: EInvoice): string[] {
  const p: string[] = [];
  const s = inv.seller, b = inv.buyer;
  if (!s.name) p.push('Firmenname fehlt (Einstellungen → Rechnungen)');
  if (!s.street || !s.zip || !s.city) p.push('Anschrift der Firma ist unvollständig (Einstellungen → Rechnungen)');
  if (!s.vatId && !s.taxNumber) p.push('Umsatzsteuer-ID oder Steuernummer der Firma fehlt (Einstellungen → Rechnungen)');
  if ((inv.taxMode === 'export' || inv.taxMode === 'intra_eu' || inv.taxMode === 'reverse_charge') && !s.vatId) p.push('Für steuerfreie Rechnungen ins Ausland braucht die Firma eine Umsatzsteuer-ID');
  if (!b.name || !b.city || !b.zip) p.push('Anschrift des Kunden ist unvollständig (Name, PLZ, Ort im CRM)');
  if (!inv.positions.length) p.push('Die Rechnung hat keine Positionen');
  if (inv.taxMode === 'reverse_charge' || inv.taxMode === 'intra_eu') {
    if (!b.vatId) p.push('Für diese Steuerart braucht der Kunde eine Umsatzsteuer-ID (im CRM)');
    if (!s.vatId) p.push('Für diese Steuerart braucht die Firma eine Umsatzsteuer-ID');
  }
  if ((inv.taxMode === 'intra_eu' || inv.taxMode === 'export') && !inv.serviceFrom && !inv.serviceTo) p.push('Für diese Steuerart bitte das Liefer- bzw. Leistungsdatum angeben');
  if (inv.profile === 'xrechnung') {
    if (!inv.buyerReference) p.push('XRechnung: Leitweg-ID bzw. Käuferreferenz fehlt (im CRM beim Kunden)');
    if (!s.contactName || !s.contactPhone || !s.contactEmail) p.push('XRechnung: Ansprechpartner der Firma mit Telefon und E-Mail fehlt (Einstellungen → Rechnungen)');
    if (!s.email) p.push('XRechnung: E-Mail-Adresse der Firma fehlt');
    if (!b.email) p.push('XRechnung: E-Mail-Adresse des Kunden für Rechnungen fehlt (im CRM)');
    if (!inv.iban) p.push('XRechnung: Bankverbindung (IBAN) fehlt (Einstellungen → Rechnungen)');
  }
  if (inv.positions.some((x) => !x.text?.trim())) p.push('Jede Position braucht eine Bezeichnung');
  if (inv.positions.some((x) => !(x.qty > 0) && inv.typeCode !== '381')) p.push('Mengen müssen größer als 0 sein');
  return p;
}
