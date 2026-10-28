import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, uploadFiles, userClient, type TestEnv } from './helpers';
import { readXlsx, parseCsv, writeXlsx } from '../src/lib/xlsx';
import { Pdf } from '../src/lib/pdf';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('Hilfsfunktionen', () => {
  it('Excel und CSV in beide Richtungen', () => {
    const buf = writeXlsx([{ name: 'A', rows: [['Name', 'Zahl'], ['Müller & Söhne', 12.5]] }]);
    expect(readXlsx(buf)).toEqual([['Name', 'Zahl'], ['Müller & Söhne', '12.5']]);
    expect(parseCsv('Firma;Ort\n"Huber; GmbH";Köln\n')).toEqual([['Firma', 'Ort'], ['Huber; GmbH', 'Köln']]);
  });
  it('PDF mit Umlauten und Seitenumbruch', () => {
    const pdf = new Pdf('Test');
    for (let i = 0; i < 120; i++) pdf.paragraph(`Zeile ${i}: Größe, Maß und Preis 12,00 €`);
    pdf.footer((p, t) => `Seite ${p} von ${t}`);
    const b = pdf.toBuffer();
    expect(b.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.pageCount).toBeGreaterThan(1);
    expect(b.toString('latin1')).toContain('Gr\\366\\337e');
  });
});

describe('CRM', () => {
  it('Kunde mit Ansprechpartner, im Projekt wählen, Nummer im Projekt', async () => {
    const k = await admin.post('/api/crm/accounts', { name: 'Muster Maschinenbau GmbH', city: 'Ulm' });
    expect(k.number).toMatch(/^K\d{4}$/);
    await admin.post(`/api/crm/accounts/${k.id}/contacts`, { firstName: 'Eva', lastName: 'Berg', email: 'eva@muster.de' });
    const detail = await admin.get(`/api/crm/accounts/${k.id}`);
    expect(detail.contacts[0].isPrimary).toBe(true);
    await admin.put('/api/settings/projectNumbers', { format: 'pattern', pattern: '{KUNDE}-{NNN}', start: 1, step: 1 });
    const p = await admin.post('/api/projects', { name: 'Linie 3', customerId: k.id, customerContactId: detail.contacts[0].id });
    expect(p.number).toBe(`${k.number}-001`);
    const pd = await admin.get(`/api/projects/${p.id}`);
    expect(pd.customer).toBe('Muster Maschinenbau GmbH');
    expect(pd.customerNumber).toBe(k.number);
    await admin.put('/api/settings/projectNumbers', { format: 'sequential' });
    // Umbenennen im CRM zieht im Projekt nach
    await admin.patch(`/api/crm/accounts/${k.id}`, { name: 'Muster Maschinenbau AG' });
    expect((await admin.get(`/api/projects/${p.id}`)).customer).toBe('Muster Maschinenbau AG');
    await admin.req('DELETE', `/api/crm/accounts/${k.id}`, undefined, 400);
  });

  it('Protokoll mit vereinbarten Punkten wird zu Aufgaben, Verlauf zeigt alles', async () => {
    const { id: benId } = await userClient(env.app, admin, 'crm-ben');
    const k = await admin.post('/api/crm/accounts', { name: 'Kunde Verlauf' });
    const p = await admin.post('/api/projects', { name: 'Verlaufsprojekt', customerId: k.id });
    await admin.post(`/api/crm/accounts/${k.id}/notes`, { body: 'Erstkontakt auf der Messe' });
    const m = await admin.post(`/api/crm/accounts/${k.id}/minutes`, {
      heldAt: new Date().toISOString(), topic: 'Abstimmung Lastenheft', discussed: 'Taktzeit 12 s',
      agreements: [{ text: 'Angebot schicken', assigneeId: benId, dueDate: '2026-12-01', projectId: p.id }, { text: 'Muster prüfen' }],
    });
    const tasks = await admin.get(`/api/projects/${p.id}/tasks`);
    expect(tasks.map((t: any) => t.title)).toContain('Angebot schicken');
    const min = await admin.get(`/api/crm/minutes/${m.id}`);
    expect(min.agreements[0].taskId).toBeTruthy();
    const pdf = await admin.req('GET', `/api/crm/minutes/${m.id}/pdf`);
    expect(pdf.status).toBe(200);
    await admin.post('/api/calendar/events', { title: 'Besuch beim Kunden', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), crmAccountId: k.id });
    const tl = await admin.get(`/api/crm/accounts/${k.id}/timeline`);
    expect(new Set(tl.map((x: any) => x.type))).toEqual(new Set(['note', 'minutes', 'project', 'event']));
    expect((await admin.get(`/api/crm/accounts/${k.id}`)).lastContactAt).toBeTruthy();
  });

  it('Verkaufschance → Angebot (PDF) → angenommen = gewonnen', async () => {
    const k = await admin.post('/api/crm/accounts', { name: 'Angebotskunde' });
    const o = await admin.post('/api/crm/opportunities', { accountId: k.id, title: 'Roboterzelle', value: 120000 });
    const q = await admin.post('/api/crm/quotes', { accountId: k.id, opportunityId: o.id, title: 'Roboterzelle RZ-1',
      positions: [{ text: 'Konstruktion', qty: 40, unit: 'Std', price: 95 }, { text: 'Roboter', qty: 1, price: 45000, discount: 10 }, { text: 'Schulung', qty: 1, price: 900, optional: true }] });
    expect(q.number).toMatch(/^AN-\d{4}-\d{4}$/);
    const full = await admin.get(`/api/crm/quotes/${q.id}`);
    expect(full.totalNet).toBe(40 * 95 + 45000 * 0.9);
    const pdf = await admin.req('GET', `/api/crm/quotes/${q.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    await admin.patch(`/api/crm/quotes/${q.id}`, { status: 'accepted' });
    const opps = await admin.get(`/api/crm/opportunities?accountId=${k.id}`);
    expect(opps[0].stage).toBe('won');
    const dash = await admin.get('/api/crm/dashboard');
    expect(dash.wonThisYear).toBeGreaterThanOrEqual(120000);
  });

  it('Reklamation mit Nummer und Zuständigem', async () => {
    const { client: ben, id: benId } = await userClient(env.app, admin, 'crm-case-ben');
    const k = await admin.post('/api/crm/accounts', { name: 'Reklamierer' });
    const c = await admin.post('/api/crm/cases', { accountId: k.id, title: 'Lager defekt', assigneeId: benId, priority: 'high' });
    expect(c.number).toMatch(/^RK-/);
    expect(JSON.stringify(await ben.get('/api/notifications'))).toContain('Lager defekt');
    await admin.patch(`/api/crm/cases/${c.id}`, { status: 'closed', resolution: 'getauscht' });
    expect((await admin.get(`/api/crm/cases?accountId=${k.id}`))[0].closedAt).toBeTruthy();
  });

  it('Import aus CSV, Export als Excel, Doppelte zusammenführen', async () => {
    const csv = 'Firma;Ort;Vorname;Nachname;E-Mail-Adresse\nImport GmbH;Bonn;Tim;Klein;tim@import.de\nImport GmbH;Bonn;Lea;Groß;lea@import.de\nImport AG;Bonn;;;\n';
    const prev = await uploadFiles(env.app, '/api/crm/import/preview', [{ name: 'kunden.csv', content: csv }], admin.cookie);
    expect(prev.status).toBe(200);
    expect(Object.values(prev.body.mapping)).toEqual(expect.arrayContaining(['name', 'city', 'contactFirstName', 'contactLastName', 'contactEmail']));
    const r = await admin.post('/api/crm/import', { rows: prev.body.rows, mapping: prev.body.mapping });
    expect(r).toMatchObject({ created: 2, contacts: 2 });
    const x = await admin.req('GET', '/api/crm/export.xlsx');
    expect(x.status).toBe(200);
    const dup = await admin.get('/api/crm/duplicates');
    const g = dup.find((d: any[]) => d.some((a) => a.name === 'Import AG'));
    expect(g).toHaveLength(2);
    const ag = g.find((a: any) => a.name === 'Import AG'), gmbh = g.find((a: any) => a.name === 'Import GmbH');
    await admin.post(`/api/crm/accounts/${ag.id}/merge`, { intoId: gmbh.id });
    expect((await admin.get(`/api/crm/accounts/${gmbh.id}`)).contacts).toHaveLength(2);
  });

  it('nur mit freigeschaltetem Werkzeug', async () => {
    const dept = await admin.post('/api/teams', { name: 'Werkstatt', defaultTools: ['time'] });
    await admin.post('/api/users', { username: 'ohne-crm', displayName: 'Ohne', password: 'Start-12345', departmentId: dept.id });
    const c = new Client(env.app);
    await c.post('/api/auth/login', { username: 'ohne-crm', password: 'Start-12345' });
    await c.post('/api/auth/change-password', { currentPassword: 'Start-12345', newPassword: 'Neu-12345678' });
    await c.req('GET', '/api/crm/accounts', undefined, 403);
  });
});
