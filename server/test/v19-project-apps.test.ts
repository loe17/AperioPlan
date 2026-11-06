import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { adminClient, Client, setup, uploadFiles, type TestEnv } from './helpers';
import { extractPreview, _test } from '../src/services/cadPreview';

let env: TestEnv;
let admin: Client;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  for (const a of ['crm', 'purchasing', 'warehouse', 'service', 'quality', 'manufacturing', 'plm', 'sustainability', 'resources', 'finance', 'meetings', 'expenses', 'approvals', 'mindmap'])
    await admin.post(`/api/apps/${a}/install`, {});
});
afterAll(async () => { await env.close(); });

/** kleines PNG (rot) für die Vorschau */
function png(w: number, h: number) {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w * 3 + 1) + 1 + x * 3] = 200 + (x % 50);
  return _test.encodePng(w, h, rows);
}

describe('Projekt-Reiter für Apps', () => {
  it('neue Reiter bleiben für ältere Versionen unsichtbar, deren Änderungen bleiben erhalten', async () => {
    const p = await admin.post('/api/projects', { name: 'Reiter' });
    const got = await admin.get(`/api/projects/${p.id}`);
    expect(got.modules).toEqual(expect.arrayContaining(['kanban', 'sales', 'purchasing']));
    await admin.patch(`/api/projects/${p.id}`, { modules: ['kanban', 'sales', 'service', 'purchasing'] });
    const [row] = await env.ctx.sql`select modules, tabs from projects where id = ${p.id}`;
    expect(row!.modules).toEqual(['kanban', 'purchasing']); // nur, was ältere Versionen kennen
    // eine ältere Version schaltet „Dateien“ ein und „Einkauf“ aus
    await env.ctx.sql`update projects set modules = '["kanban", "files"]'::jsonb where id = ${p.id}`;
    expect((await admin.get(`/api/projects/${p.id}`)).modules).toEqual(['kanban', 'sales', 'service', 'files']);
    await admin.req('PATCH', `/api/projects/${p.id}`, { modules: ['gibtsnicht'] }, 400);
  });

  it('Standard-Reiter: unbekannte werden verworfen, Grundwerkzeuge auch in der alten Einstellung', async () => {
    await admin.put('/api/settings/defaultProjectTabs', ['kanban', 'quality', 'bogus', 'files']);
    const s = await admin.get('/api/settings');
    expect(s.defaultProjectTabs).toEqual(['kanban', 'quality', 'files']);
    expect(s.defaultModules).toEqual(['kanban', 'files']);
    const p = await admin.post('/api/projects', { name: 'Mit Standard' });
    expect((await admin.get(`/api/projects/${p.id}`)).modules).toEqual(['kanban', 'quality', 'files']);
  });

  it('Listen der Apps lassen sich nach Projekt filtern', async () => {
    const acc = await admin.post('/api/crm/accounts', { name: 'Kunde Filter', kind: 'customer' });
    const p = await admin.post('/api/projects', { name: 'Filter', customerId: acc.id });
    const other = await admin.post('/api/projects', { name: 'Anderes' });
    await admin.post('/api/service/jobs', { accountId: acc.id, title: 'Montage', projectId: p.id });
    await admin.post('/api/service/jobs', { accountId: acc.id, title: 'Fremd', projectId: other.id });
    expect((await admin.get(`/api/service/jobs?projectId=${p.id}`)).map((j: any) => j.title)).toEqual(['Montage']);
    await admin.post('/api/quality/inspections', { title: 'Endabnahme', kind: 'final', projectId: p.id });
    expect((await admin.get(`/api/quality/inspections?projectId=${p.id}`)).map((j: any) => j.title)).toEqual(['Endabnahme']);
    await admin.post('/api/quality/8d', { title: 'Riss', projectId: p.id });
    expect(await admin.get(`/api/quality/8d?projectId=${other.id}`)).toEqual([]);
    await admin.post('/api/manufacturing/orders', { title: 'Rahmen', qty: 1, projectId: p.id, operations: [{ name: 'Schweißen' }] });
    expect((await admin.get(`/api/manufacturing/orders?projectId=${p.id}`)).map((o: any) => o.title)).toEqual(['Rahmen']);
    await admin.post('/api/plm/changes', { title: 'Bohrung versetzen', projectId: p.id });
    expect((await admin.get(`/api/plm/changes?projectId=${p.id}`)).map((c: any) => c.title)).toEqual(['Bohrung versetzen']);
    const q = await admin.post('/api/crm/quotes', { accountId: acc.id, projectId: p.id, title: 'Angebot Anlage', positions: [{ text: 'Anlage', qty: 1, unit: 'Stk', price: 1000 }] });
    expect((await admin.get(`/api/crm/quotes?projectId=${p.id}`))[0]).toMatchObject({ id: q.id, projectNumber: p.number, projectName: 'Filter' });
    const meeting = await admin.post('/api/meetings', { title: 'Abnahme', startsAt: new Date(Date.now() + 86400000).toISOString(), durationMin: 30, projectId: p.id });
    expect((await admin.get(`/api/meetings?projectId=${p.id}`)).map((m: any) => m.id)).toEqual([meeting.id]);
    const exp = await admin.post('/api/expenses/reports', { title: 'Baustelle', projectId: p.id });
    expect((await admin.get(`/api/expenses/reports?scope=project&projectId=${p.id}`)).map((r: any) => r.id)).toEqual([exp.id]);
    const room = await admin.post('/api/resources', { name: 'Raum Projekt', kind: 'room' });
    const start = new Date(Date.now() + 2 * 86400000);
    await admin.post('/api/resources/bookings', { resourceId: room.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600000).toISOString(), projectId: p.id });
    expect(await admin.get(`/api/resources/bookings?projectId=${p.id}`)).toHaveLength(1);
    const factors = await admin.get('/api/sustainability/factors');
    await admin.post('/api/sustainability/entries', { date: '2026-03-01', factorId: factors[0].id, quantity: 100, projectId: p.id });
    const co2 = await admin.get(`/api/sustainability/projects/${p.id}`);
    expect(co2.total).toBeGreaterThan(0);
    expect((await admin.get(`/api/sustainability/entries?projectId=${p.id}`))).toHaveLength(1);
  });
});

describe('Einkauf und Lager', () => {
  it('Lagerbestellung ohne Projekt, Wareneingang mit Seriennummern, Verlauf', async () => {
    const lager = await admin.post('/api/warehouse/locations', { name: 'Lager EK', kind: 'warehouse' });
    const motor = await admin.post('/api/warehouse/articles', { name: 'Motor 400 W', tracking: 'serial', defaultLocationId: lager.id, purchasePrice: 300 });
    const item = await admin.post('/api/purchasing/stock/items', { designation: '', qty: 2, whArticleId: motor.id, status: 'ordered' });
    const stock = await admin.get('/api/purchasing/stock/items');
    expect(stock.find((x: any) => x.id === item.id)).toMatchObject({ designation: 'Motor 400 W', projectId: null, locationId: lager.id, articleNumber: motor.number });
    expect((await admin.get('/api/purchasing/items')).some((x: any) => x.id === item.id)).toBe(true);
    // Projektziel geht bei Lagerbestellungen nicht, Seriennummern müssen passen
    await admin.req('POST', `/api/purchasing/items/${item.id}/receipts`, { qty: 2, target: 'project' }, 400);
    await admin.req('POST', `/api/purchasing/items/${item.id}/receipts`, { qty: 2, target: 'stock', serials: ['SN-1'] }, 400);
    await admin.post(`/api/purchasing/items/${item.id}/receipts`, { qty: 2, target: 'stock', serials: ['SN-1', 'SN-2'], deliveryNote: 'LS-4711' });
    const a = await admin.get(`/api/warehouse/articles/${motor.id}`);
    expect(a.stock).toBe(2);
    expect(a.stockByLocation.map((s: any) => s.lot).sort()).toEqual(['SN-1', 'SN-2']);
    const receipts = await admin.get(`/api/purchasing/items/${item.id}/receipts`);
    expect(receipts[0]).toMatchObject({ deliveryNote: 'LS-4711', target: 'stock', locationName: 'Lager EK' });
    const history = await admin.get(`/api/purchasing/items/${item.id}/history`);
    expect(history.map((h: any) => h.text).join(' | ')).toContain('Lieferschein LS-4711');
  });

  it('Wareneingang direkt ins Projekt legt den Artikel an und bucht Material', async () => {
    const lager = await admin.post('/api/warehouse/locations', { name: 'Lager P', kind: 'warehouse' });
    const p = await admin.post('/api/projects', { name: 'Montageprojekt' });
    const item = await admin.post(`/api/purchasing/projects/${p.id}/items`, { designation: 'Kabelkanal', number: 'KK-60', qty: 10, unit: 'm', unitPrice: 4, status: 'ordered' });
    const r = await admin.post(`/api/purchasing/items/${item.id}/receipts`, { qty: 10, target: 'project', locationId: lager.id, createArticle: true, lot: 'CH-1' });
    const art = await admin.get(`/api/warehouse/articles/${r.articleId}`);
    expect(art).toMatchObject({ number: 'KK-60', tracking: 'lot', stock: 0 });
    expect((await admin.get(`/api/warehouse/projects/${p.id}/material`)).rows[0]).toMatchObject({ name: 'Kabelkanal', qty: 10 });
    const items = await admin.get(`/api/purchasing/projects/${p.id}/items`);
    expect(items[0]).toMatchObject({ status: 'delivered', whArticleId: r.articleId });
  });

  it('Nachbestellung aus dem Lager ohne Projekt', async () => {
    const lager = await admin.post('/api/warehouse/locations', { name: 'Lager N', kind: 'warehouse' });
    const art = await admin.post('/api/warehouse/articles', { name: 'Kabelbinder', minQty: 100, reorderQty: 500, defaultLocationId: lager.id });
    await admin.post('/api/warehouse/reorder', { projectId: null, items: [{ articleId: art.id, qty: 500 }] });
    const stock = await admin.get('/api/purchasing/stock/items');
    expect(stock.find((x: any) => x.whArticleId === art.id)).toMatchObject({ qty: 500, locationId: lager.id, note: 'Lagernachschub' });
    const detail = await admin.get(`/api/warehouse/articles/${art.id}`);
    expect(detail.purchases[0]).toMatchObject({ projectId: null, open: 500 });
  });

  it('Eingangsrechnung beim Hochladen dem Projekt zuordnen', async () => {
    const p = await admin.post('/api/projects', { name: 'Rechnungsprojekt' });
    const up = await uploadFiles(env.app, `/api/finance/bills/upload?projectId=${p.id}`, [{ name: 'rechnung.pdf', content: '%PDF-1.4 test' }], admin.cookie);
    expect(up.status).toBe(200);
    expect((await admin.get(`/api/finance/bills?projectId=${p.id}`)).map((b: any) => b.id)).toEqual([up.body[0].id]);
  });
});

describe('3D-Ansicht nativer CAD-Dateien', () => {
  it('Vorschaubild aus der Datei, Umwandlung über einen CAD-Arbeitsplatz', async () => {
    const p = await admin.post('/api/projects', { name: '3D' });
    const fake = Buffer.concat([Buffer.from('SolidWorks-Kopf'), Buffer.alloc(300, 7), png(64, 48), Buffer.alloc(200, 1)]);
    const up = await uploadFiles(env.app, `/api/projects/${p.id}/files/upload?path=`, [{ name: 'Halter.SLDPRT', content: fake }], admin.cookie);
    const fileId = up.body[0].id;
    const info = await admin.get(`/api/files/${fileId}/view3d`);
    expect(info).toMatchObject({ kind: 'native', format: 'sldprt', program: 'SolidWorks', conversion: null, workers: [] });
    const prev = await admin.req('GET', `/api/files/${fileId}/view3d/preview`);
    expect(prev.status).toBe(200);
    expect(prev.headers['content-type']).toBe('image/png');
    await admin.post(`/api/files/${fileId}/view3d/convert`);
    expect((await admin.get(`/api/files/${fileId}/view3d`)).conversion.status).toBe('queued');
    // Arbeitsplatz ohne SolidWorks bekommt nichts, mit SolidWorks den Auftrag
    expect((await admin.post('/api/view3d/conversions/claim', { worker: 'PC1', formats: ['ipt'] })).job).toBeNull();
    const { job } = await admin.post('/api/view3d/conversions/claim', { worker: 'PC2', formats: ['sldprt', 'sldasm'], programs: ['SolidWorks'] });
    expect(job).toMatchObject({ fileName: 'Halter.SLDPRT', format: 'sldprt' });
    expect((await admin.req('GET', job.downloadUrl)).status).toBe(200);
    expect((await admin.get(`/api/files/${fileId}/view3d`)).workers).toEqual(['PC2']);
    const done = await uploadFiles(env.app, `/api/view3d/conversions/${job.id}/complete`, [{ name: 'Halter.step', content: 'ISO-10303-21;' }], admin.cookie);
    expect(done.status).toBe(200);
    const model = await admin.req('GET', `/api/files/${fileId}/view3d/model`);
    expect(model.body).toBe('ISO-10303-21;');
    // STEP selbst braucht keine Umwandlung
    const step = await uploadFiles(env.app, `/api/projects/${p.id}/files/upload?path=`, [{ name: 'Teil.stp', content: 'ISO' }], admin.cookie);
    expect((await admin.get(`/api/files/${step.body[0].id}/view3d`)).kind).toBe('direct');
  });

  it('Bilder werden auch aus Compound-Dateien und Windows-Bitmaps gelesen', () => {
    // Windows-Bitmap 20×20, 24 Bit, mit Verlauf
    const w = 20, h = 20, stride = Math.ceil((w * 24) / 32) * 4;
    const dib = Buffer.alloc(40 + stride * h);
    dib.writeUInt32LE(40, 0); dib.writeInt32LE(w, 4); dib.writeInt32LE(h, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(24, 14);
    for (let i = 40; i < dib.length; i++) dib[i] = i % 251;
    const r = extractPreview(Buffer.concat([Buffer.alloc(100, 3), dib, Buffer.alloc(50)]));
    expect(r?.type).toBe('png');
    expect(r!.data.readUInt32BE(16)).toBe(20);
    // kaputtes PNG (Prüfsumme falsch) wird ignoriert
    const bad = png(32, 32); bad[bad.length - 20] = bad[bad.length - 20]! ^ 0xff;
    expect(extractPreview(Buffer.concat([Buffer.alloc(10), bad]))).toBeNull();
    expect(_test.crc32(Buffer.from('IEND'))).toBe(0xae426082);
    expect(deflateSync(Buffer.alloc(1)).length).toBeGreaterThan(0);
  });
});

describe('Mindmaps mit FreeMind-Funktionen', () => {
  it('Formatierung bleibt neben den Grunddaten erhalten, auch wenn eine ältere Version speichert', async () => {
    const m = await admin.post('/api/mindmaps', { title: 'Ideen' });
    const data = { id: 'root', text: 'Ideen', children: [
      { id: 'a', text: 'Kosten', bold: true, size: 18, bg: '#ffeeaa', icons: ['idea', 'p1'], cloud: '#aaccff', arrows: [{ to: 'b', label: 'beeinflusst' }, { to: 'gibtsnicht' }],
        attrs: [{ k: 'Budget', v: '5000' }], created: 1700000000000, reminder: '2026-01-01T08:00:00Z', children: [] },
      { id: 'b', text: 'Nutzen', shape: 'fork', edgeStyle: 'linear', ref: 'a', evil: '<script>', children: [] }] };
    const r = await admin.put(`/api/mindmaps/${m.id}`, { data, version: 1 });
    const got = await admin.get(`/api/mindmaps/${m.id}`);
    expect(got.data.children[0]).toMatchObject({ bold: true, size: 18, icons: ['idea', 'p1'], cloud: '#aaccff', arrows: [{ to: 'b', label: 'beeinflusst' }], attrs: [{ k: 'Budget', v: '5000' }] });
    expect(got.data.children[1]).toMatchObject({ shape: 'fork', edgeStyle: 'linear', ref: 'a' });
    expect(got.data.children[1].evil).toBeUndefined();
    const [row] = await env.ctx.sql`select data from mindmaps where id = ${m.id}`;
    expect(row!.data.children[0].bold).toBeUndefined(); // ältere Versionen sehen nur die Grunddaten
    // ältere Version speichert (kennt die Zusatzangaben nicht) – sie bleiben trotzdem
    await env.ctx.sql`update mindmaps set data = ${env.ctx.sql.json({ id: 'root', text: 'Ideen', children: [{ id: 'a', text: 'Kosten (neu)', children: [] }] } as never)}, version = version + 1 where id = ${m.id}`;
    const after = await admin.get(`/api/mindmaps/${m.id}`);
    expect(after.data.children[0]).toMatchObject({ text: 'Kosten (neu)', bold: true });
    expect(r.version).toBe(2);
  });

  it('fällige Erinnerung wird einmal gemeldet', async () => {
    const { mindmapReminders } = await import('../src/routes/mindmaps');
    const m = await admin.post('/api/mindmaps', { title: 'Termine', data: { id: 'root', text: 'Termine', children: [{ id: 'x', text: 'Angebot nachfassen', reminder: new Date(Date.now() - 60_000).toISOString(), children: [] }] } });
    await mindmapReminders(env.ctx);
    await mindmapReminders(env.ctx);
    const notes = await admin.get('/api/notifications');
    expect(notes.filter((n: any) => n.title.includes('Angebot nachfassen'))).toHaveLength(1);
    expect(notes.find((n: any) => n.title.includes('Angebot nachfassen')).link).toBe(`/mindmaps/${m.id}?node=x`);
  });
});
