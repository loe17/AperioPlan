import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { readXlsx } from '../src/lib/xlsx';
import { inspectionReminders } from '../src/routes/inventory';

let env: TestEnv;
let admin: Client;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  for (const a of ['warehouse', 'inventory']) await admin.post(`/api/apps/${a}/install`, {});
});
afterAll(async () => { await env.close(); });

describe('Lager', () => {
  it('Lagerorte, Artikel, Zugang, Entnahme fürs Projekt, Umlagern, Seriennummern', async () => {
    const halle = await admin.post('/api/warehouse/locations', { name: 'Halle 1', kind: 'warehouse' });
    const regal = await admin.post('/api/warehouse/locations', { name: 'Regal A', parentId: halle.id, code: 'R-A' });
    const fach = await admin.post('/api/warehouse/locations', { name: 'Fach A1', parentId: regal.id });
    await admin.req('PATCH', `/api/warehouse/locations/${halle.id}`, { parentId: fach.id }, 400);

    const schraube = await admin.post('/api/warehouse/articles', { name: 'Zylinderschraube M8x20', unit: 'Stk', purchasePrice: 0.12, minQty: 100, reorderQty: 500, barcode: '4012345678901' });
    expect(schraube.number).toBe('A00001');
    await admin.req('POST', '/api/warehouse/articles', { name: 'X', barcode: '4012345678901' }, 400);
    await admin.post('/api/warehouse/moves', { kind: 'receipt', articleId: schraube.id, qty: 300, toLocationId: fach.id });
    expect((await admin.get('/api/warehouse/lookup?code=4012345678901'))).toEqual({ type: 'article', id: schraube.id });
    expect((await admin.get('/api/warehouse/lookup?code=R-A'))).toEqual({ type: 'location', id: regal.id });

    const project = await admin.post('/api/projects', { name: 'Lagerprojekt' });
    const bad = await admin.req('POST', '/api/warehouse/moves', { kind: 'issue', articleId: schraube.id, qty: 400, fromLocationId: fach.id, projectId: project.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('vorhanden 300');
    await admin.post('/api/warehouse/moves', { kind: 'issue', articleId: schraube.id, qty: 250, fromLocationId: fach.id, projectId: project.id });
    const mat = await admin.get(`/api/warehouse/projects/${project.id}/material`);
    expect(mat.rows[0]).toMatchObject({ number: 'A00001', qty: 250 });
    expect(mat.total).toBeCloseTo(30);
    await admin.post('/api/warehouse/moves', { kind: 'transfer', articleId: schraube.id, qty: 20, fromLocationId: fach.id, toLocationId: halle.id });
    const a = await admin.get(`/api/warehouse/articles/${schraube.id}`);
    expect(a.stock).toBe(50);
    expect(a.stockByLocation.map((s: any) => [s.locationName, s.qty])).toEqual([['Fach A1', 30], ['Halle 1', 20]]);
    // nach Lagerort filtern: Regal A enthält Fach A1
    expect((await admin.get(`/api/warehouse/articles?locationId=${regal.id}`)).map((x: any) => x.id)).toEqual([schraube.id]);
    // Mindestbestand unterschritten -> Vorschlag
    const reorder = await admin.get('/api/warehouse/reorder');
    expect(reorder[0]).toMatchObject({ id: schraube.id, suggest: 500 });

    // Teiländerung lässt übrige Felder unverändert
    await admin.patch(`/api/warehouse/articles/${schraube.id}`, { description: 'DIN 912, verzinkt' });
    await admin.patch(`/api/warehouse/articles/${schraube.id}`, { minQty: 120 });
    expect(await admin.get(`/api/warehouse/articles/${schraube.id}`)).toMatchObject({ description: 'DIN 912, verzinkt', minQty: 120, barcode: '4012345678901', purchasePrice: 0.12 });

    const motor = await admin.post('/api/warehouse/articles', { name: 'Servomotor', tracking: 'serial' });
    await admin.req('POST', '/api/warehouse/moves', { kind: 'receipt', articleId: motor.id, qty: 1, toLocationId: fach.id }, 400);
    await admin.req('POST', '/api/warehouse/moves', { kind: 'receipt', articleId: motor.id, qty: 2, toLocationId: fach.id, lot: 'SN1' }, 400);
    await admin.post('/api/warehouse/moves', { kind: 'receipt', articleId: motor.id, qty: 1, toLocationId: fach.id, lot: 'SN1' });
    await admin.req('POST', '/api/warehouse/moves', { kind: 'receipt', articleId: motor.id, qty: 1, toLocationId: halle.id, lot: 'SN1' }, 400);
    await admin.req('DELETE', `/api/warehouse/locations/${fach.id}`, undefined, 400);
  });

  it('Nachbestellung und Wareneingang aus dem Einkauf, Inventur', async () => {
    const lager = await admin.post('/api/warehouse/locations', { name: 'Kleinteilelager', kind: 'warehouse' });
    const project = await admin.post('/api/projects', { name: 'Lager-Gemeinkosten' });
    const kabel = await admin.post('/api/warehouse/articles', { name: 'Kabelbinder 200 mm', minQty: 50, reorderQty: 200, purchasePrice: 0.05 });
    await admin.post('/api/warehouse/reorder', { projectId: project.id, items: [{ articleId: kabel.id, qty: 200 }] });
    const items = await admin.get(`/api/purchasing/projects/${project.id}/items`);
    const pi = items.find((x: any) => x.designation === 'Kabelbinder 200 mm');
    expect(pi).toMatchObject({ qty: 200, note: 'Lagernachschub' });
    expect((await admin.get('/api/warehouse/reorder')).map((x: any) => x.id)).not.toContain(kabel.id); // bestellt zählt mit
    await admin.patch(`/api/purchasing/items/${pi.id}`, { status: 'ordered' });
    const inc = await admin.get('/api/warehouse/incoming');
    expect(inc.find((x: any) => x.id === pi.id).articleId).toBe(kabel.id);
    await admin.post('/api/warehouse/receive', { purchaseItemId: pi.id, qty: 120, locationId: lager.id });
    expect((await admin.get(`/api/purchasing/projects/${project.id}/items`)).find((x: any) => x.id === pi.id)).toMatchObject({ status: 'partial', deliveredQty: 120 });
    expect((await admin.get(`/api/warehouse/articles/${kabel.id}`)).stock).toBe(120);

    // Position ohne Lagerartikel: wird angelegt
    const own = await admin.post(`/api/purchasing/projects/${project.id}/items`, { designation: 'Lüfter 120 mm', manufacturerNo: 'FAN-120', qty: 4, unitPrice: 10, status: 'ordered' });
    const r = await admin.post('/api/warehouse/receive', { purchaseItemId: own.id, qty: 4, locationId: lager.id, createArticle: true, toProject: true });
    const fan = await admin.get(`/api/warehouse/articles/${r.articleId}`);
    expect(fan).toMatchObject({ name: 'Lüfter 120 mm', manufacturerNo: 'FAN-120', stock: 0, purchasePrice: 10 });
    expect((await admin.get(`/api/warehouse/projects/${project.id}/material`)).rows[0]).toMatchObject({ name: 'Lüfter 120 mm', qty: 4 });

    // Inventur
    const c = await admin.post('/api/warehouse/counts', { name: 'Inventur Kleinteile', locationId: lager.id });
    await admin.req('POST', '/api/warehouse/counts', { name: 'doppelt', locationId: lager.id }, 400);
    const count = await admin.get(`/api/warehouse/counts/${c.id}`);
    expect(count.lines).toHaveLength(1);
    await admin.put(`/api/warehouse/counts/${c.id}/lines/${count.lines[0].id}`, { counted: 115 });
    await admin.post(`/api/warehouse/counts/${c.id}/lines`, { articleId: r.articleId, locationId: lager.id, counted: 1 });
    expect((await admin.post(`/api/warehouse/counts/${c.id}/finish`, {})).changes).toBe(2);
    expect((await admin.get(`/api/warehouse/articles/${kabel.id}`)).stock).toBe(115);
    expect((await admin.get(`/api/warehouse/articles/${r.articleId}`)).stock).toBe(1);

    const x = await env.app.inject({ method: 'GET', url: '/api/warehouse/export.xlsx', headers: { cookie: admin.cookie } });
    const rows = readXlsx(x.rawPayload);
    expect(rows[0]![0]).toBe('Artikel-Nr.');
  });
});

describe('Inventar', () => {
  it('anlegen, Abschreibung, Prüfung mit Erinnerung, Übergabe mit Bestätigung und PDF, Scan', async () => {
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.inv');
    const a = await admin.post('/api/inventory/assets', { name: 'Laptop ThinkPad', category: 'IT', purchaseDate: '2026-10-15', purchasePrice: 1800, depreciationYears: 3, serialNo: 'PF-123' });
    expect(a.number).toBe('INV-0001');
    const d = await admin.get(`/api/inventory/assets/${a.id}`);
    expect(d.depreciation[0]).toMatchObject({ year: 2026, amount: 150 });
    expect((await admin.get('/api/inventory/lookup?code=PF-123')).id).toBe(a.id);

    const due = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const insp = await admin.post(`/api/inventory/assets/${a.id}/inspections`, { kind: 'DGUV V3 (Elektroprüfung)', intervalMonths: 24, nextDate: due, responsibleId: lisaId });
    await inspectionReminders(env.ctx);
    await inspectionReminders(env.ctx); // nur einmal
    const n = (await lisa.get('/api/notifications')).filter((x: any) => x.title.startsWith('Prüfung bald fällig'));
    expect(n).toHaveLength(1);
    expect((await admin.get('/api/inventory/inspections?days=10')).map((x: any) => x.id)).toContain(insp.id);
    const res = await admin.post(`/api/inventory/inspections/${insp.id}/log`, { date: '2026-10-20', result: 'ok' });
    expect(res.nextDate).toBe('2028-10-20');

    const h = await admin.post(`/api/inventory/assets/${a.id}/handover`, { toUserId: lisaId, note: 'mit Netzteil' });
    expect((await admin.get(`/api/inventory/assets/${a.id}`)).holderName).toBe('LISA.INV');
    await admin.req('POST', `/api/inventory/handovers/${h.id}/confirm`, {}, 403);
    await lisa.post(`/api/inventory/handovers/${h.id}/confirm`, {});
    const pdf = await env.app.inject({ method: 'GET', url: `/api/inventory/handovers/${h.id}/pdf`, headers: { cookie: admin.cookie } });
    expect(pdf.body.startsWith('%PDF')).toBe(true);

    expect((await admin.get('/api/inventory/assets?notSeenSince=2026-01-01')).map((x: any) => x.id)).toContain(a.id);
    await lisa.post(`/api/inventory/assets/${a.id}/seen`, { location: 'Büro 2.14' });
    expect((await admin.get('/api/inventory/assets?notSeenSince=2026-01-01')).map((x: any) => x.id)).not.toContain(a.id);
    await admin.patch(`/api/inventory/assets/${a.id}`, { status: 'retired' });
    expect(await admin.get(`/api/inventory/assets/${a.id}`)).toMatchObject({ serialNo: 'PF-123', category: 'IT', purchasePrice: 1800 });
    expect((await admin.get('/api/inventory/assets')).map((x: any) => x.id)).not.toContain(a.id);
    await lisa.req('DELETE', `/api/inventory/assets/${a.id}`, undefined, 403);
    const x = await env.app.inject({ method: 'GET', url: '/api/inventory/export.xlsx', headers: { cookie: admin.cookie } });
    expect(readXlsx(x.rawPayload)[1]![0]).toBe('INV-0001');
  });
});
