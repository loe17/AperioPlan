import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calcPlant, calcSurcharge, calcHourly, calcTravel, DEFAULT_CALC_RATES } from '@aperio/shared';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { warnRevisedPart } from '../src/routes/purchasing';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

async function cadItem(projectId: string, type: string, part: number, designation: string, procurement: string) {
  const [r] = await env.ctx.sql<{ id: string }[]>`insert into cad_items (project_id, type, base_number, main, sub, subsub, part, designation, procurement)
    values (${projectId}, ${type}, ${`0100-100-00-${String(part).padStart(4, '0')}`}, '0100', '100', '00', ${part}, ${designation}, ${procurement}) returning id`;
  return r!.id;
}

describe('Einkauf', () => {
  it('übernimmt Kaufteile mit Gesamtmenge aus der Stückliste', async () => {
    const p = await admin.post('/api/projects', { name: 'Einkaufsprojekt' });
    const top = await cadItem(p.id, 'assembly', 1, 'Anlage', 'make');
    const sub = await cadItem(p.id, 'assembly', 2, 'Antrieb', 'make');
    const motor = await cadItem(p.id, 'part', 3, 'Motor', 'buy');
    const screw = await cadItem(p.id, 'part', 4, 'Schraube M8', 'standard');
    await cadItem(p.id, 'part', 5, 'Welle', 'make');
    await env.ctx.sql`insert into cad_references (parent_id, child_id, quantity) values (${top}, ${sub}, 2), (${sub}, ${motor}, 1), (${sub}, ${screw}, 8), (${top}, ${screw}, 4)`;
    const r = await admin.post(`/api/purchasing/projects/${p.id}/sync`);
    expect(r.added).toBe(2);
    const items = await admin.get(`/api/purchasing/projects/${p.id}/items`);
    expect(items.find((i: any) => i.designation === 'Motor').qty).toBe(2);
    expect(items.find((i: any) => i.designation === 'Schraube M8').qty).toBe(20);
    // erneut abgleichen: nichts doppelt
    expect((await admin.post(`/api/purchasing/projects/${p.id}/sync`)).added).toBe(0);

    // Lieferant aus dem CRM, Bestellung mit Nummer, Wareneingang in zwei Teilen
    const sup = await admin.post('/api/crm/accounts', { name: 'Normteile Huber', kind: 'supplier' });
    expect(sup.number).toMatch(/^L/);
    const motorItem = items.find((i: any) => i.designation === 'Motor');
    await admin.patch(`/api/purchasing/items/${motorItem.id}`, { unitPrice: 450, plannedDelivery: '2026-01-10' });
    const o = await admin.post('/api/purchasing/bulk', { ids: [motorItem.id], supplierId: sup.id, createOrder: true });
    expect(o.orderNumber).toMatch(/^B-/);
    const pdf = await admin.req('GET', `/api/purchasing/orders/${o.orderId}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const ordered = (await admin.get(`/api/purchasing/projects/${p.id}/items`)).find((i: any) => i.id === motorItem.id);
    expect(ordered).toMatchObject({ status: 'ordered', supplierName: 'Normteile Huber', overdue: true, total: 900 });
    expect((await admin.post(`/api/purchasing/items/${motorItem.id}/receipts`, { qty: 1 })).status).toBe('partial');
    expect((await admin.post(`/api/purchasing/items/${motorItem.id}/receipts`, { qty: 1 })).status).toBe('delivered');

    // Teil der Schrauben bestellt, dann in der Konstruktion geändert → Warnung
    const screwItem = items.find((i: any) => i.designation === 'Schraube M8');
    await admin.patch(`/api/purchasing/items/${screwItem.id}`, { status: 'ordered' });
    await warnRevisedPart(env.ctx, screw, '0100-100-00-0004-01', 'Länge geändert', '00000000-0000-0000-0000-000000000000');
    const after = (await admin.get(`/api/purchasing/projects/${p.id}/items`)).find((i: any) => i.id === screwItem.id);
    expect(after.revisionWarning).toBe(true);
    expect(JSON.stringify(await admin.get('/api/notifications'))).toContain('bestelltes Teil geändert');

    const dash = await admin.get('/api/purchasing/dashboard');
    expect(dash.warnings).toBeGreaterThanOrEqual(1);
    expect(dash.suppliers[0].name).toBe('Normteile Huber');
    const x = await admin.req('GET', `/api/purchasing/projects/${p.id}/export.xlsx`);
    expect(x.status).toBe(200);
  });
});

describe('Kalkulation – Rechenwege', () => {
  const R = DEFAULT_CALC_RATES;
  it('Zuschlagskalkulation', () => {
    const r = calcSurcharge({ quantity: 10, material: [{ text: 'Stahl', qty: 100, unit: 'kg', price: 2 }], labor: [{ text: 'Fräsen', key: 'fertigung', hours: 10 }], machines: [], special: [],
      surcharges: { materialOverhead: 10, productionOverhead: 100, adminSales: 10, risk: 0, profit: 10 } }, R);
    // MK 220, FL 320 + FGK 320 = 640, HK 860, VwVt 86 → SK 946, Gewinn 94,6 → 1040,6
    expect(r.total).toBe(1040.6);
    expect(r.perUnit).toBe(104.06);
  });
  it('Anlage, Stundensatz, Reise', () => {
    const p = calcPlant({ groups: [{ name: 'Konstruktion', items: [{ text: 'CAD', kind: 'labor', key: 'konstruktion', qty: 10 }] }, { name: 'Zukauf', items: [{ text: 'Roboter', kind: 'purchased', qty: 1, price: 1000 }] }],
      surcharges: { risk: 0, profit: 0, purchasedMarkup: 10 } }, R);
    expect(p.total).toBe(950 + 1100);
    expect((p.extra as any).hoursByKey.konstruktion).toBe(10);
    expect(calcHourly({ label: 'Montage', employees: 2, hoursPerYear: 1000, productivity: 50, costs: [{ text: 'Personal', amount: 50000 }], profit: 0 }).total).toBe(50);
    expect(calcTravel({ persons: 2, fullDays: 1, partialDays: 2, nights: 2, km: 100, travelHours: 2, workHours: 8, workKey: 'montage', extras: [] }, R).total)
      .toBe(Math.round((70 + 2 * (28 + 28) + 2 * 2 * 95 + 2 * 2 * 60 + 2 * 8 * 72) * 100) / 100);
  });
});

describe('Kalkulation – Ablauf', () => {
  it('Sätze werden festgeschrieben, Vier-Augen-Prüfung, Freigabe, Angebot, Nachkalkulation', async () => {
    const { client: ben } = await userClient(env.app, admin, 'calc-ben', 'teamlead');
    const k = await admin.post('/api/crm/accounts', { name: 'Kalkulationskunde' });
    const p = await admin.post('/api/projects', { name: 'Kalkulierte Anlage', customerId: k.id });
    await admin.put(`/api/projects/${p.id}/members`, { members: [{ userId: (await admin.get('/api/auth/me')).id, role: 'owner' }, { userId: (await ben.get('/api/auth/me')).id, role: 'member' }] });
    const c = await admin.post('/api/calculations', { projectId: p.id, title: 'Anlage RZ-1', template: 'plant',
      data: { groups: [{ name: 'Konstruktion', items: [{ text: 'CAD', kind: 'labor', key: 'konstruktion', qty: 20 }] }, { name: 'Zukauf', items: [{ text: 'Roboter', kind: 'purchased', qty: 1, price: 30000 }] }] } });
    expect(c.number).toMatch(/^KA-/);
    // Admin ändert danach die Sätze – die Kalkulation behält die alten
    const rates = await admin.get('/api/calculations/rates');
    await admin.put('/api/settings/calcRates', { ...rates, labor: rates.labor.map((l: any) => ({ ...l, rate: l.rate * 2 })) });
    const before = await admin.get(`/api/calculations/${c.id}`);
    expect(before.rates.labor.find((l: any) => l.key === 'konstruktion').rate).toBe(95);
    await admin.patch(`/api/calculations/${c.id}`, { note: 'Preis wie besprochen' });
    expect((await admin.get(`/api/calculations/${c.id}`)).result.total).toBe(before.result.total);

    await admin.req('POST', `/api/calculations/${c.id}/status`, { status: 'released' }, 400);
    await ben.post(`/api/calculations/${c.id}/status`, { status: 'checked' });
    await admin.post(`/api/calculations/${c.id}/status`, { status: 'released' });
    await admin.req('PATCH', `/api/calculations/${c.id}`, { title: 'geändert' }, 403);
    const pdf = await admin.req('GET', `/api/calculations/${c.id}/pdf`);
    expect(pdf.status).toBe(200);
    const q = await admin.post(`/api/calculations/${c.id}/quote`, {});
    const quote = await admin.get(`/api/crm/quotes/${q.id}`);
    expect(quote.positions).toHaveLength(2);
    expect(Math.round(quote.totalNet)).toBe(Math.round(before.result.total));

    // Nachkalkulation: 5 gebuchte Stunden gegen 20 geplante
    await env.ctx.sql`insert into time_entries (user_id, project_id, started_at, ended_at) select id, ${p.id}, now() - interval '5 hours', now() from users where username = 'admin'`;
    const post = await admin.post('/api/calculations', { projectId: p.id, title: 'Nachkalkulation', template: 'postcalc', baseCalculationId: c.id });
    const pc = await admin.get(`/api/calculations/${post.id}`);
    const total = pc.result.rows.find((r: any) => r.label === 'Kosten gesamt');
    expect(total.plan).toBeGreaterThan(total.actual);
  });
});
