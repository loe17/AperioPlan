import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { runDailyJobs } from '../src/services/daily';

let env: TestEnv;
let admin: Client;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  for (const a of ['maintenance', 'quality', 'manufacturing', 'plm', 'warehouse']) await admin.post(`/api/apps/${a}/install`, {});
});
afterAll(async () => { await env.close(); });
const pdf = async (url: string) => { const r = await env.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } }); expect(r.statusCode).toBe(200); expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-'); };

describe('Instandhaltung', () => {
  it('Wartungsplan erzeugt Auftrag, Erledigung schreibt Plan fort, Störung setzt Anlage in Reparatur', async () => {
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.ih');
    const asset = await admin.post('/api/inventory/assets', { name: 'CNC-Fräse DMU 50', location: 'Halle 1' });
    const plan = await admin.post('/api/maintenance/plans', { assetId: asset.id, title: 'Halbjahreswartung', intervalDays: 180, nextDue: new Date().toISOString().slice(0, 10), responsibleId: maxId,
      checklist: [{ text: 'Kühlschmierstoff prüfen' }, { text: 'Spindel schmieren' }] });
    await runDailyJobs(env.ctx);
    await runDailyJobs(env.ctx); // keine doppelten Aufträge
    let orders = await max.get('/api/maintenance/orders?status=active');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ kind: 'preventive', assetName: 'CNC-Fräse DMU 50', assigneeId: maxId, planId: plan.id });
    expect(orders[0].checklist).toHaveLength(2);
    const inbox = await max.get('/api/notifications');
    expect(JSON.stringify(inbox)).toContain('Wartung fällig');
    await max.patch(`/api/maintenance/orders/${orders[0].id}`, { status: 'in_progress' });
    await max.patch(`/api/maintenance/orders/${orders[0].id}`, { status: 'done', workMinutes: 90, checklist: orders[0].checklist.map((c: any) => ({ ...c, done: true })), report: 'Alles in Ordnung' });
    const plans = await max.get(`/api/maintenance/plans?assetId=${asset.id}`);
    const in180 = new Date(); in180.setDate(in180.getDate() + 180);
    expect(plans[0].nextDue).toBe(in180.toISOString().slice(0, 10));
    // Störung melden (jeder Mitarbeiter), Maschine steht
    const st = await max.post('/api/maintenance/orders', { assetId: asset.id, title: 'Spindel macht Geräusche', machineDown: true, priority: 'urgent' });
    expect((await admin.get(`/api/inventory/assets/${asset.id}`)).status).toBe('repair');
    const ov = await admin.get('/api/maintenance/overview');
    expect(ov).toMatchObject({ open: 1, down: 1, urgent: 1 });
    await admin.patch(`/api/maintenance/orders/${st.id}`, { status: 'done', materialCost: 120.5 });
    expect((await admin.get(`/api/inventory/assets/${asset.id}`)).status).toBe('active');
    const akte = await admin.get(`/api/maintenance/assets/${asset.id}`);
    expect(akte.kpi).toMatchObject({ failures: 1, workMinutes: 90, cost: 120.5 });
    expect(akte.orders).toHaveLength(2);
    await pdf(`/api/maintenance/orders/${st.id}/pdf`);
  });
});

describe('Qualität', () => {
  it('Prüfplan, Prüfung mit Messwerten, Messmittel mit Kalibrierung, 8D', async () => {
    const plan = await admin.post('/api/quality/plans', { title: 'Welle 20h6', characteristics: [
      { id: 'd', name: 'Durchmesser', kind: 'measure', nominal: 20, lower: 19.987, upper: 20, unit: 'mm', method: 'Bügelmessschraube' },
      { id: 'o', name: 'Oberfläche', kind: 'attribute' }] });
    expect(plan.number).toMatch(/^PP-\d{4}$/);
    const insp = await admin.post('/api/quality/inspections', { planId: plan.id, title: 'Wareneingang Wellen', kind: 'incoming', lot: 'L-77', qty: 50 });
    let i = await admin.get(`/api/quality/inspections/${insp.id}`);
    expect(i.result).toBe('open');
    expect(i.characteristics).toHaveLength(2);
    const chars = i.characteristics.map((c: any) => (c.id === 'd' ? { ...c, values: [19.99, 19.995, 20.0] } : { ...c, values: [true, true, true] }));
    await admin.patch(`/api/quality/inspections/${insp.id}`, { characteristics: chars });
    expect((await admin.get(`/api/quality/inspections/${insp.id}`)).result).toBe('pass');
    chars[0].values.push(20.01);
    const r = await admin.patch(`/api/quality/inspections/${insp.id}`, { characteristics: chars });
    expect(r.result).toBe('fail');
    await admin.patch(`/api/quality/inspections/${insp.id}`, { result: 'conditional', notes: 'Sonderfreigabe' });
    i = await admin.get(`/api/quality/inspections/${insp.id}`);
    expect(i.result).toBe('conditional');
    await pdf(`/api/quality/inspections/${insp.id}/pdf`);

    const g = await admin.post('/api/quality/gauges', { name: 'Bügelmessschraube 0–25', intervalMonths: 12, nextDue: '2026-01-15' });
    expect((await admin.get('/api/quality/overview')).gaugesOverdue).toBe(1);
    await runDailyJobs(env.ctx);
    const fd = new FormData(); fd.append('date', '2026-02-01'); fd.append('result', 'ok'); fd.append('byWhom', 'Kalibrierlabor'); fd.append('file', new Blob(['%PDF-1.4 test']), 'zert.pdf');
    const res = new Response(fd);
    const up = await env.app.inject({ method: 'POST', url: `/api/quality/gauges/${g.id}/calibrations`, payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')!, cookie: admin.cookie } });
    expect(up.statusCode).toBe(200);
    const gd = await admin.get(`/api/quality/gauges/${g.id}`);
    expect(gd).toMatchObject({ nextDue: '2027-02-01', status: 'ok', lastCalibration: '2026-02-01' });
    expect(gd.calibrations[0]).toMatchObject({ result: 'ok', hasCertificate: true });

    const acc = await admin.post('/api/crm/accounts', { name: 'Kunde Q GmbH' });
    const e = await admin.post('/api/quality/8d', { title: 'Riss in Gehäuse', accountId: acc.id, reference: 'RK-2026-0001' });
    await admin.patch(`/api/quality/8d/${e.id}`, { d: { d2: '3 Gehäuse mit Riss' }, status: 'containment' });
    await admin.patch(`/api/quality/8d/${e.id}`, { d: { d3: '100-%-Prüfung' } });
    const ed = await admin.get(`/api/quality/8d/${e.id}`);
    expect(ed.d).toEqual({ d2: '3 Gehäuse mit Riss', d3: '100-%-Prüfung' });
    await pdf(`/api/quality/8d/${e.id}/pdf`);
  });
});

describe('Fertigung', () => {
  it('Auftrag aus CAD-Baugruppe, Material entnehmen, Rückmeldung bis fertig', async () => {
    const { sql } = env.ctx;
    const proj = await admin.post('/api/projects', { name: 'Vorrichtung', teamId: null }).catch(async () => (await admin.get('/api/projects'))[0]);
    const pid = proj.id;
    const mk = async (type: string, part: number, designation: string, procurement = 'make') => (await sql<{ id: string }[]>`insert into cad_items (project_id, type, base_number, main, sub, subsub, part, designation, procurement)
      values (${pid}, ${type}, ${`0100-100-00-${String(part).padStart(4, '0')}`}, '100', '00', '00', ${part}, ${designation}, ${procurement}) returning id`)[0]!.id;
    const asm = await mk('assembly', 1, 'Spannvorrichtung');
    const sub = await mk('assembly', 2, 'Grundplatte komplett');
    const plate = await mk('part', 3, 'Grundplatte');
    const screw = await mk('part', 4, 'Zylinderschraube M8x20', 'standard');
    await sql`insert into cad_references (parent_id, child_id, quantity) values (${asm}, ${sub}, 1), (${sub}, ${plate}, 1), (${sub}, ${screw}, 4), (${asm}, ${screw}, 2)`;
    const loc = await admin.post('/api/warehouse/locations', { name: 'Regal A' });
    const art = await admin.post('/api/warehouse/articles', { name: 'Zylinderschraube M8x20', unit: 'Stk' });
    await sql`update wh_articles set cad_item_id = ${screw} where id = ${art.id}`;
    await admin.post('/api/warehouse/moves', { kind: 'receipt', articleId: art.id, qty: 100, toLocationId: loc.id });

    const wc = await admin.post('/api/manufacturing/workcenters', { name: 'Montage 1', hourlyRate: 65 });
    const o = await admin.post('/api/manufacturing/orders/from-cad', { cadItemId: asm, qty: 2 });
    let d = await admin.get(`/api/manufacturing/orders/${o.id}`);
    const sc = d.bom.find((b: any) => b.cadItemId === screw);
    expect(sc).toMatchObject({ qty: 12, articleId: art.id, procurement: 'standard' });
    expect(d.bom.find((b: any) => b.cadItemId === plate)).toMatchObject({ qty: 2, procurement: 'make' });
    expect(d.bom.some((b: any) => b.cadItemId === sub)).toBe(false);
    await admin.patch(`/api/manufacturing/orders/${o.id}`, { status: 'released', operations: [{ id: 'a', name: 'Montieren', workcenterId: wc.id, setupMin: 15, minPerUnit: 30 }, { id: 'b', name: 'Prüfen', minPerUnit: 5 }] });
    const load = await admin.get('/api/manufacturing/load');
    expect(load.find((w: any) => w.id === wc.id).hours).toBe(1.3);
    await admin.post(`/api/manufacturing/orders/${o.id}/issue`, { lines: [{ index: d.bom.indexOf(d.bom.find((b: any) => b.cadItemId === screw)), qty: 12, locationId: loc.id }] });
    const stock = await admin.get(`/api/warehouse/articles/${art.id}`);
    expect(stock.stockByLocation.reduce((s: number, x: any) => s + x.qty, 0)).toBe(88);

    let q = await admin.get(`/api/manufacturing/queue?workcenterId=${wc.id}`);
    expect(q).toHaveLength(1);
    await admin.post(`/api/manufacturing/orders/${o.id}/feedback`, { op: 0, kind: 'start' });
    await admin.post(`/api/manufacturing/orders/${o.id}/feedback`, { op: 0, kind: 'done', qtyGood: 2 });
    q = await admin.get('/api/manufacturing/queue');
    expect(q.map((x: any) => x.op)).toEqual([1]);
    await admin.post(`/api/manufacturing/orders/${o.id}/feedback`, { op: 1, kind: 'start' });
    const f = await admin.post(`/api/manufacturing/orders/${o.id}/feedback`, { op: 1, kind: 'done', qtyGood: 2 });
    expect(f.status).toBe('done');
    d = await admin.get(`/api/manufacturing/orders/${o.id}`);
    expect(d).toMatchObject({ status: 'done', qtyDone: 2 });
    expect(d.bom.find((b: any) => b.cadItemId === screw).issued).toBe(12);
    expect(d.feedback).toHaveLength(4);
  });
});

describe('Änderungsmanagement', () => {
  it('Antrag mit Teilen, zwei Prüfer, Ablehnung mit Begründung, erneute Prüfung, Umsetzung', async () => {
    const { client: anna, id: annaId } = await userClient(env.app, admin, 'anna.plm');
    const { client: ben, id: benId } = await userClient(env.app, admin, 'ben.plm');
    const items = await admin.get('/api/plm/items?q=Grundplatte');
    expect(items.length).toBeGreaterThan(0);
    const c = await anna.post('/api/plm/changes', { title: 'Bohrung Grundplatte versetzen', reason: 'Kollision mit Zylinder', items: [{ ...items[0], action: 'change' }], approverIds: [annaId, benId] });
    expect(c.number).toMatch(/^AE-\d{4}-\d{3}$/);
    await ben.post(`/api/plm/changes/${c.id}/decide`, { decision: 'approve' }, 400); // noch nicht in Prüfung
    await anna.post(`/api/plm/changes/${c.id}/submit`, {});
    await ben.post(`/api/plm/changes/${c.id}/decide`, { decision: 'reject' }, 400); // ohne Begründung
    expect((await ben.post(`/api/plm/changes/${c.id}/decide`, { decision: 'reject', comment: 'Maß fehlt' })).status).toBe('rejected');
    await anna.patch(`/api/plm/changes/${c.id}`, { description: 'Bohrung um 5 mm nach links' });
    await anna.post(`/api/plm/changes/${c.id}/submit`, {});
    expect((await anna.post(`/api/plm/changes/${c.id}/decide`, { decision: 'approve' })).status).toBe('review');
    expect((await ben.post(`/api/plm/changes/${c.id}/decide`, { decision: 'approve', comment: 'ok' })).status).toBe('approved');
    await anna.post(`/api/plm/changes/${c.id}/status`, { status: 'implemented' });
    const d = await admin.get(`/api/plm/changes/${c.id}`);
    expect(d.status).toBe('implemented');
    expect(d.comments).toHaveLength(3);
    expect(await admin.get(`/api/plm/changes?itemId=${items[0].id}`)).toHaveLength(1);
    await pdf(`/api/plm/changes/${c.id}/pdf`);
  });
});
