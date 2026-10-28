import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { testOutbox } from '../src/services/mail';
import { readZip } from '../src/lib/zip';

let env: TestEnv;
let admin: Client;
const OUT = process.env.INVOICE_OUT;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  await admin.post('/api/apps/finance/install', {});
  testOutbox.enabled = true;
  await admin.put('/api/settings/invoicing', { legalName: 'Muster Maschinenbau GmbH', street: 'Industriestr. 5', zip: '78120', city: 'Furtwangen', vatId: 'DE123456789',
    iban: 'DE02120300000000202051', contactName: 'Lisa', contactPhone: '07723 1', contactEmail: 'rechnung@muster.de', dueDays: 14 });
});
afterAll(async () => { testOutbox.enabled = false; await env.close(); });

async function upload(c: Client, url: string, name: string, data: Buffer | string) {
  const fd = new FormData();
  fd.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), name);
  const res = new Response(fd);
  const r = await env.app.inject({ method: 'POST', url, payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')!, cookie: c.cookie } });
  if (r.statusCode !== 200) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
  return JSON.parse(r.body);
}
const bin = async (url: string) => (await env.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).rawPayload;

const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:ID>L-4711</cbc:ID><cbc:IssueDate>2026-10-05</cbc:IssueDate><cbc:DueDate>2026-10-19</cbc:DueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cac:AccountingSupplierParty><cac:Party><cac:PostalAddress><cbc:StreetName>Lagerweg 1</cbc:StreetName><cbc:CityName>Stuttgart</cbc:CityName><cbc:PostalZone>70173</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
<cac:PartyTaxScheme><cbc:CompanyID>DE999999999</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Schrauben Schmidt KG</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>DE89370400440532013000</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">38.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">200.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">38.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">200.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">200.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">238.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">238.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="H87">1000</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">200.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>Zylinderschrauben M6</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">0.20</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`;

const camt = (rows: { amt: string; dir: 'CRDT' | 'DBIT'; date: string; name: string; iban: string; text: string; ref: string }[]) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>1</MsgId><CreDtTm>2026-11-03T08:00:00</CreDtTm></GrpHdr>
<Stmt><Id>1</Id><Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>${rows.map((r) => `<Ntry><NtryRef>${r.ref}</NtryRef><Amt Ccy="EUR">${r.amt}</Amt><CdtDbtInd>${r.dir}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>${r.date}</Dt></BookgDt><ValDt><Dt>${r.date}</Dt></ValDt><AcctSvcrRef>${r.ref}</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
<RltdPties>${r.dir === 'CRDT' ? `<Dbtr><Pty><Nm>${r.name}</Nm></Pty></Dbtr><DbtrAcct><Id><IBAN>${r.iban}</IBAN></Id></DbtrAcct>` : `<Cdtr><Pty><Nm>${r.name}</Nm></Pty></Cdtr><CdtrAcct><Id><IBAN>${r.iban}</IBAN></Id></CdtrAcct>`}</RltdPties>
<RmtInf><Ustrd>${r.text}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`).join('')}</Stmt></BkToCstmrStmt></Document>`;

describe('Finanzbuchhaltung', () => {
  it('Eingangsrechnungen (E-Rechnung), Freigabe, Kontoauszug-Abgleich, Zahlungslauf, Mahnung, USt, DATEV', async () => {
    const { client: lisa } = await userClient(env.app, admin, 'lisa.fin');
    await admin.put('/api/settings/finance', { approvalLimit: 200, approverIds: [] });
    // Ausgangsrechnung für den Abgleich
    const acc = await admin.post('/api/crm/accounts', { name: 'Kunde AG', street: 'A 1', zip: '79098', city: 'Freiburg', email: 'buha@kunde.de' });
    const inv = await admin.post('/api/crm/invoices', { accountId: acc.id, positions: [{ text: 'Montage', qty: 10, unit: 'Std', price: 100 }] });
    const { number } = await admin.post(`/api/crm/invoices/${inv.id}/finalize`, {});
    const zugferd = await bin(`/api/crm/invoices/${inv.id}/pdf`);

    // E-Rechnungen hochladen: UBL-XML, ZUGFeRD-PDF und ein normales PDF
    const [ubl] = await upload(lisa, '/api/finance/bills/upload', 'L-4711.xml', UBL);
    expect(ubl).toMatchObject({ eInvoice: true, supplierName: 'Schrauben Schmidt KG', gross: 238 });
    const b = await lisa.get(`/api/finance/bills/${ubl.id}`);
    expect(b).toMatchObject({ number: 'L-4711', billDate: '2026-10-05', dueDate: '2026-10-19', iban: 'DE89370400440532013000', totalTax: 38, status: 'draft' });
    expect(b.lines[0]).toMatchObject({ account: '3400', net: 200, rate: 19 });
    const [zf] = await upload(lisa, '/api/finance/bills/upload', 'eingang.pdf', zugferd);
    expect(zf).toMatchObject({ eInvoice: true, supplierName: 'Muster Maschinenbau GmbH', gross: 1190 });
    const [plain] = await upload(lisa, '/api/finance/bills/upload', 'quittung.pdf', '%PDF-1.4 nur ein Bild');
    expect(plain.eInvoice).toBe(false);
    await lisa.req('POST', `/api/finance/bills/${plain.id}/submit`, {}, 400);
    await lisa.del(`/api/finance/bills/${plain.id}`);

    // Freigabe: über 200 € muss ein Freigabeberechtigter (hier Administrator) zustimmen
    expect((await lisa.post(`/api/finance/bills/${ubl.id}/submit`, {})).status).toBe('approval');
    await lisa.req('POST', `/api/finance/bills/${ubl.id}/approve`, { approve: true }, 403);
    expect((await admin.get('/api/notifications'))[0].title).toContain('Freigabe: Rechnung L-4711');
    await admin.post(`/api/finance/bills/${ubl.id}/approve`, { approve: true });
    await lisa.req('PATCH', `/api/finance/bills/${ubl.id}`, { number: 'x' }, 400);

    // Bankkonto, Zahlungslauf (SEPA)
    const bank = await admin.post('/api/finance/bank-accounts', { name: 'Hausbank', iban: 'DE02 1203 0000 0000 2020 51', bic: 'BYLADEM1001', openingBalance: 10000, openingDate: '2026-10-01' });
    const run = await env.app.inject({ method: 'POST', url: '/api/finance/payment-run', payload: { billIds: [ubl.id], bankAccountId: bank.id, execDate: '2026-11-04' }, headers: { cookie: admin.cookie } });
    expect(run.statusCode).toBe(200);
    expect(run.body).toContain('<InstdAmt Ccy="EUR">238.00</InstdAmt>');
    expect(run.body).toContain('<Nm>Schrauben Schmidt KG</Nm>');
    if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/pain001.xml`, run.body); }

    // Kontoauszug: Zahlungseingang mit Rechnungsnummer, Abbuchung an Lieferant, Kontoführungsgebühr
    const st = camt([
      { amt: '1190.00', dir: 'CRDT', date: '2026-11-03', name: 'KUNDE AG', iban: 'DE44500105175407324931', text: `Zahlung ${number} vielen Dank`, ref: 'R1' },
      { amt: '238.00', dir: 'DBIT', date: '2026-11-04', name: 'Schrauben Schmidt KG', iban: 'DE89370400440532013000', text: 'Rechnung L-4711', ref: 'R2' },
      { amt: '12.90', dir: 'DBIT', date: '2026-11-04', name: 'Hausbank', iban: '', text: 'Kontofuehrung Oktober', ref: 'R3' },
    ]);
    const imp = await upload(admin, `/api/finance/bank-accounts/${bank.id}/import`, 'auszug.xml', st);
    expect(imp).toMatchObject({ read: 3, added: 3, matched: 2 });
    expect((await upload(admin, `/api/finance/bank-accounts/${bank.id}/import`, 'auszug.xml', st)).added).toBe(0); // doppelt eingelesen
    expect((await admin.get(`/api/crm/invoices/${inv.id}`)).status).toBe('paid');
    expect((await admin.get(`/api/finance/bills/${ubl.id}`)).status).toBe('paid');
    const open = await admin.get(`/api/finance/bank-tx?accountId=${bank.id}&status=open`);
    expect(open).toHaveLength(1);
    await admin.post(`/api/finance/bank-tx/${open[0].id}/book`, { account: '4970' });
    const accounts = await admin.get('/api/finance/bank-accounts');
    expect(accounts[0].balance).toBeCloseTo(10000 + 1190 - 238 - 12.9);
    // Zuordnung lösen und neu zuordnen
    const tx = (await admin.get(`/api/finance/bank-tx?accountId=${bank.id}`)).find((t: any) => t.amount === 1190);
    await admin.post(`/api/finance/bank-tx/${tx.id}/unmatch`, {});
    expect((await admin.get(`/api/crm/invoices/${inv.id}`)).status).toBe('open');
    const sug = await admin.get(`/api/finance/bank-tx/${tx.id}/suggestions`);
    expect(sug.suggestions[0]).toMatchObject({ id: inv.id, score: 100 });
    await admin.post(`/api/finance/bank-tx/${tx.id}/match`, { type: 'invoice', targetId: inv.id });

    // CSV einer Sparkasse
    const csv = '"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"BIC (SWIFT-Code)";"Betrag";"Waehrung";"Info"\n'
      + '"DE02120300000000202051";"05.11.26";"05.11.26";"GUTSCHRIFT";"Anzahlung Projekt";"Neukunde GmbH";"DE12500105170648489890";"INGDDEFFXXX";"500,00";"EUR";"Umsatz gebucht"\n';
    expect((await upload(admin, `/api/finance/bank-accounts/${bank.id}/import`, 'umsaetze.csv', Buffer.from(csv, 'latin1'))).added).toBe(1);

    // Mahnung: zweite Rechnung, überfällig
    const inv2 = await admin.post('/api/crm/invoices', { accountId: acc.id, positions: [{ text: 'Wartung', qty: 1, unit: 'psch', price: 400 }] });
    await admin.post(`/api/crm/invoices/${inv2.id}/finalize`, {});
    await env.ctx.sql`update crm_invoices set due_date = current_date - 20 where id = ${inv2.id}`;
    const dun = await admin.get('/api/finance/dunning');
    expect(dun.find((d: any) => d.id === inv2.id)).toMatchObject({ ready: true, nextLevel: 1, nextTitle: 'Zahlungserinnerung' });
    const made = await admin.post('/api/finance/dunning', { invoiceIds: [inv2.id], send: true });
    expect(made[0]).toMatchObject({ level: 1, sent: true });
    expect(testOutbox.messages.at(-1)).toMatchObject({ to: 'buha@kunde.de' });
    expect(testOutbox.messages.at(-1)!.attachments).toHaveLength(2);
    expect((await bin(`/api/finance/dunnings/${made[0].dunningId}/pdf`)).subarray(0, 4).toString()).toBe('%PDF');
    expect((await admin.get('/api/finance/dunning')).find((d: any) => d.id === inv2.id)).toMatchObject({ level: 1, ready: false });

    // Umsatzsteuer (Soll) und DATEV-Übergabe
    const y = new Date().getFullYear();
    const vat = await admin.get(`/api/finance/vat?from=${y}-01-01&to=${y}-12-31`);
    expect(vat.kz.find((k: any) => k.kz === '81').value).toBe(1400);
    expect(vat.outputTax).toBe(266);
    const vatOct = await admin.get('/api/finance/vat?from=2026-10-01&to=2026-10-31');
    expect(vatOct.inputTax).toBe(38);
    const zip = readZip(await bin(`/api/finance/datev.zip?from=2026-01-01&to=${y}-12-31`));
    const names = zip.map((e) => e.name);
    expect(names.filter((n) => n.startsWith('EXTF'))).toHaveLength(3);
    const bankCsv = zip.find((e) => e.name.includes('Bank'))!.data.toString('latin1').split('\r\n');
    expect(bankCsv.some((l) => l.startsWith('1190,00;"S";"EUR";;;;1200;10000;'))).toBe(true);
    expect(bankCsv.some((l) => l.startsWith('238,00;"H";"EUR";;;;1200;70000;'))).toBe(true);
    expect(bankCsv.some((l) => l.startsWith('12,90;"H";"EUR";;;;1200;4970;'))).toBe(true);
    const inCsv = zip.find((e) => e.name.includes('Eingang'))!.data.toString('latin1').split('\r\n');
    expect(inCsv.some((l) => l.startsWith('238,00;"S";"EUR";;;;3400;70000;"9";'))).toBe(true);
    expect(names.some((n) => n.startsWith('Eingangsrechnungen/2026-10-05_') && n.includes('Schmidt') && n.includes('L-4711'))).toBe(true);
    const ov = await admin.get('/api/finance/overview');
    expect(ov.receivables.open).toBe(476);
  });
});
