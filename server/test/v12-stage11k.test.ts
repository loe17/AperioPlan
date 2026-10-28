import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { adminClient, Client, setup, type TestEnv } from './helpers';
import { testOutbox } from '../src/services/mail';
import { readZip } from '../src/lib/zip';

let env: TestEnv;
let admin: Client;
const OUT = process.env.INVOICE_OUT;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  testOutbox.enabled = true;
  await admin.put('/api/settings/invoicing', { legalName: 'Muster Maschinenbau GmbH', street: 'Industriestr. 5', zip: '78120', city: 'Furtwangen', countryCode: 'DE',
    vatId: 'DE123456789', taxNumber: '12/345/67890', registry: 'HRB 123456, Amtsgericht Freiburg', managingDirector: 'Lisa Muster',
    iban: 'DE02 1203 0000 0000 2020 51', bic: 'BYLADEM1001', bankName: 'DKB', contactName: 'Lisa Muster', contactPhone: '+49 7723 1234', contactEmail: 'rechnung@muster.de',
    dueDays: 14, skonto: { percent: 2, days: 7 }, accountingEmail: 'stb@kanzlei.de' });
});
afterAll(async () => { testOutbox.enabled = false; await env.close(); });

const bin = async (url: string) => (await env.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).rawPayload;

describe('Rechnungen', () => {
  it('Angebot → Abschlag → Schlussrechnung, ZUGFeRD, Versand, Zahlung, Storno, DATEV', async () => {
    const acc = await admin.post('/api/crm/accounts', { name: 'Kunde AG', street: 'Hauptstr. 1', zip: '79098', city: 'Freiburg', email: 'info@kunde.de', invoiceEmail: 'rechnung@kunde.de' });
    const q = await admin.post('/api/crm/quotes', { accountId: acc.id, title: 'Vorrichtung', positions: [
      { pos: 1, text: 'Konstruktion', qty: 40, unit: 'Std', price: 95, discount: 0 }, { pos: 2, text: 'Fertigung', qty: 1, unit: 'psch', price: 6200, discount: 0 },
      { pos: 3, text: 'Option Lackierung', qty: 1, unit: 'psch', price: 500, discount: 0, optional: true }] });

    // Abschlag 30 %
    const p1 = await admin.post(`/api/crm/quotes/${q.id}/invoice`, { kind: 'partial', percent: 30 });
    let d = await admin.get(`/api/crm/invoices/${p1.id}`);
    expect(d).toMatchObject({ kind: 'partial', status: 'draft', format: 'zugferd' });
    expect(d.positions[0].price).toBe(3000);
    const fin1 = await admin.post(`/api/crm/invoices/${p1.id}/finalize`, {});
    expect(fin1.number).toMatch(/^RE-\d{4}-0001$/);
    await admin.req('PATCH', `/api/crm/invoices/${p1.id}`, { title: 'x' }, 400);
    await admin.req('DELETE', `/api/crm/invoices/${p1.id}`, undefined, 400);
    const pdf1 = await bin(`/api/crm/invoices/${p1.id}/pdf`);
    expect(pdf1.subarray(0, 8).toString()).toBe('%PDF-1.7');
    expect(pdf1.includes(Buffer.from('/AFRelationship /Alternative'))).toBe(true);
    expect(pdf1.includes(Buffer.from('<pdfaid:part>3</pdfaid:part>'))).toBe(true);
    const xml1 = (await bin(`/api/crm/invoices/${p1.id}/xml`)).toString();
    expect(xml1).toContain('<ram:TypeCode>326</ram:TypeCode>');
    expect(xml1).toContain('<ram:DuePayableAmount>3570.00</ram:DuePayableAmount>');
    expect(xml1).toContain('#SKONTO#TAGE=7#PROZENT=2.00#');

    // Schlussrechnung zieht den Abschlag ab
    const f = await admin.post(`/api/crm/quotes/${q.id}/invoice`, { kind: 'final' });
    d = await admin.get(`/api/crm/invoices/${f.id}`);
    expect(d.partials.map((x: any) => x.number)).toEqual([fin1.number]);
    expect(d.preview.net).toBe(10000);
    await admin.post(`/api/crm/invoices/${f.id}/finalize`, {});
    d = await admin.get(`/api/crm/invoices/${f.id}`);
    expect(d).toMatchObject({ totalNet: 10000, totalTax: 1900, totalGross: 11900, prepaid: 3570, status: 'open' });
    const xmlF = (await bin(`/api/crm/invoices/${f.id}/xml`)).toString();
    expect(xmlF).toContain('<ram:TotalPrepaidAmount>3570.00</ram:TotalPrepaidAmount><ram:DuePayableAmount>8330.00</ram:DuePayableAmount>');
    // Abschlag kann nicht zweimal verrechnet werden
    const f2 = await admin.post('/api/crm/invoices', { accountId: acc.id, kind: 'final', positions: [{ text: 'x', qty: 1, unit: 'Stk', price: 1 }] });
    await admin.req('PATCH', `/api/crm/invoices/${f2.id}`, { partialIds: [p1.id] }, 400);

    // Versand
    const m = await admin.get(`/api/crm/invoices/${f.id}/mail`);
    expect(m.to).toBe('rechnung@kunde.de');
    expect(m.text).toContain('8.330,00 €');
    await admin.post(`/api/crm/invoices/${f.id}/send`, { to: m.to, subject: m.subject, text: m.text });
    expect(testOutbox.messages.at(-1)).toMatchObject({ to: 'rechnung@kunde.de', attachments: [`${d.number}.pdf`] });

    // Zahlungen
    expect((await admin.post(`/api/crm/invoices/${f.id}/payments`, { date: '2026-11-02', amount: 5000 })).status).toBe('partial');
    expect((await admin.post(`/api/crm/invoices/${f.id}/payments`, { date: '2026-11-05', amount: 3330 })).status).toBe('paid');
    await admin.req('POST', `/api/crm/invoices/${f.id}/cancel`, {}, 400); // bezahlt

    // Storno des Abschlags (ohne Zahlung) → Stornorechnung 381
    const st = await admin.post(`/api/crm/invoices/${p1.id}/cancel`, { reason: 'falscher Betrag' });
    expect((await admin.get(`/api/crm/invoices/${p1.id}`)).status).toBe('cancelled');
    const xmlS = (await bin(`/api/crm/invoices/${st.id}/xml`)).toString();
    expect(xmlS).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(xmlS).toContain(`<ram:IssuerAssignedID>${fin1.number}</ram:IssuerAssignedID>`);

    // Export mit DATEV-Buchungsstapel
    const y = new Date().getFullYear();
    const zip = readZip(await bin(`/api/crm/invoices/export.zip?from=${y}-01-01&to=${y}-12-31`));
    const names = zip.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([`EXTF_Buchungsstapel_${y}-01-01_${y}-12-31.csv`, `Rechnungen/${fin1.number}.pdf`, `Rechnungen/${fin1.number}.xml`]));
    const csv = zip.find((e) => e.name.startsWith('EXTF'))!.data.toString('latin1').split('\r\n');
    expect(csv[0]).toMatch(/^"EXTF";700;21;"Buchungsstapel";13;/);
    expect(csv[1]!.split(';')).toHaveLength(125);
    expect(csv[2]).toMatch(/^3570,00;"S";"EUR";;;;10000;8400;;/);
    expect(csv.some((l) => l.startsWith('3570,00;"H"'))).toBe(true); // Storno
    await admin.post('/api/crm/invoices/send-accounting', { from: `${y}-01-01`, to: `${y}-12-31` });
    expect(testOutbox.messages.at(-1)!.to).toBe('stb@kanzlei.de');

    if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/partial.xml`, xml1); writeFileSync(`${OUT}/final.xml`, xmlF); writeFileSync(`${OUT}/storno.xml`, xmlS); writeFileSync(`${OUT}/partial.pdf`, pdf1); }
  });

  it('XRechnung für Behörden: Leitweg-ID Pflicht, XML im Versand', async () => {
    const acc = await admin.post('/api/crm/accounts', { name: 'Stadt Beispielhausen', street: 'Rathausplatz 1', zip: '12345', city: 'Beispielhausen', invoiceEmail: 'e-rechnung@beispielhausen.de' });
    const inv = await admin.post('/api/crm/invoices', { accountId: acc.id, format: 'xrechnung', serviceFrom: '2026-10-01', serviceTo: '2026-10-15', buyerReference: '',
      positions: [{ text: 'Wartung Pumpe', qty: 3.5, unit: 'h', price: 88 }, { text: 'Dichtungssatz', qty: 2, unit: 'Stk', price: 12.4, discount: 5 }] });
    await env.ctx.sql`update crm_invoices set buyer_reference = '' where id = ${inv.id}`;
    await env.ctx.sql`update crm_accounts set leitweg_id = '' where id = ${acc.id}`;
    const bad = await admin.req('POST', `/api/crm/invoices/${inv.id}/finalize`, {});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('Leitweg-ID');
    await admin.patch(`/api/crm/accounts/${acc.id}`, { leitwegId: '04011000-12345-67' });
    await admin.patch(`/api/crm/invoices/${inv.id}`, { buyerReference: '04011000-12345-67' });
    await admin.post(`/api/crm/invoices/${inv.id}/finalize`, {});
    const xml = (await bin(`/api/crm/invoices/${inv.id}/xml`)).toString();
    expect(xml).toContain('urn:xeinkauf.de:kosit:xrechnung_3.0');
    expect(xml).toContain('<ram:BuyerReference>04011000-12345-67</ram:BuyerReference>');
    expect(xml).toContain('<ram:LineTotalAmount>331.56</ram:LineTotalAmount>'); // 3,5×88 + 2×11,78
    const pdf = await bin(`/api/crm/invoices/${inv.id}/pdf`);
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4'); // Sichtbeleg, die E-Rechnung ist das XML
    const m = await admin.get(`/api/crm/invoices/${inv.id}/mail`);
    await admin.post(`/api/crm/invoices/${inv.id}/send`, m);
    expect(testOutbox.messages.at(-1)!.attachments[0]).toMatch(/\.xml$/);
    if (OUT) writeFileSync(`${OUT}/xrechnung.xml`, xml);
  });
});
