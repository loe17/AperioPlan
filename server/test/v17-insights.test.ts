import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { testOutbox } from '../src/services/mail';
import { runDailyJobs } from '../src/services/daily';

let env: TestEnv;
let admin: Client;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  for (const a of ['approvals', 'esign', 'bi', 'studio', 'sustainability', 'fleet', 'crm', 'time']) await admin.post(`/api/apps/${a}/install`, {});
  testOutbox.enabled = true;
});
afterAll(async () => { testOutbox.enabled = false; await env.close(); });
const anon = (method: string, url: string, payload?: unknown) => env.app.inject({ method: method as 'GET', url, payload: payload as object });
const form = async (c: Client, url: string, fields: Record<string, string>, file?: { name: string; data: string }) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.data]), file.name);
  const res = new Response(fd);
  return env.app.inject({ method: 'POST', url, payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')!, ...(c.cookie ? { cookie: c.cookie } : {}) } });
};
const sig = [[[0.1, 0.5], [0.2, 0.3], [0.3, 0.7], [0.4, 0.4], [0.5, 0.6], [0.6, 0.5]]];

describe('Freigaben', () => {
  it('Anschaffung: Teamleitung, ab 1.000 € zusätzlich Geschäftsführung', async () => {
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.fg');
    const { client: lead, id: leadId } = await userClient(env.app, admin, 'lead.fg');
    const { client: other } = await userClient(env.app, admin, 'other.fg');
    const team = await admin.post('/api/teams', { name: 'Montage FG' });
    await admin.put(`/api/teams/${team.id}/members`, { members: [{ userId: maxId, isLead: false }, { userId: leadId, isLead: true }] });
    const types = await max.get('/api/approvals/types');
    const buy = types.find((t: any) => t.name === 'Anschaffung');
    await max.post('/api/approvals/requests', { typeId: buy.id, data: { item: 'Akkuschrauber' } }, 400); // Pflichtfelder fehlen
    const small = await max.post('/api/approvals/requests', { typeId: buy.id, data: { item: 'Akkuschrauber', reason: 'alter defekt', amount: '189' } });
    expect(small.number).toMatch(/^FG-\d{2}-\d{4}$/);
    let r = await max.get(`/api/approvals/requests/${small.id}`);
    expect(r.steps).toHaveLength(1);
    expect(r.amount).toBe(189);
    expect((await lead.get('/api/approvals/requests?scope=todo')).map((x: any) => x.id)).toContain(small.id);
    await other.post(`/api/approvals/requests/${small.id}/decide`, { approve: true }, 403);
    await lead.post(`/api/approvals/requests/${small.id}/decide`, { approve: true });
    r = await max.get(`/api/approvals/requests/${small.id}`);
    expect(r.status).toBe('approved');

    const big = await max.post('/api/approvals/requests', { typeId: buy.id, data: { item: 'Laserschneider', reason: 'Kapazität', amount: 24000 } });
    r = await max.get(`/api/approvals/requests/${big.id}`);
    expect(r.steps.map((s: any) => s.label)).toEqual(['Teamleitung', 'Geschäftsführung']);
    await lead.post(`/api/approvals/requests/${big.id}/decide`, { approve: false }, 400); // Begründung fehlt
    await lead.post(`/api/approvals/requests/${big.id}/decide`, { approve: true, note: 'sinnvoll' });
    r = await max.get(`/api/approvals/requests/${big.id}`);
    expect(r).toMatchObject({ status: 'pending', step: 1 });
    await lead.post(`/api/approvals/requests/${big.id}/decide`, { approve: true }, 403);
    await admin.post(`/api/approvals/requests/${big.id}/decide`, { approve: false, note: 'erst nächstes Jahr' });
    expect((await max.get(`/api/approvals/requests/${big.id}`)).status).toBe('rejected');

    const w = await max.post('/api/approvals/requests', { typeId: buy.id, data: { item: 'Stuhl', reason: 'Rücken', amount: 300 } });
    await max.post(`/api/approvals/requests/${w.id}/withdraw`);
    expect((await max.get(`/api/approvals/requests/${w.id}`)).status).toBe('withdrawn');
    await other.get(`/api/approvals/requests/${w.id}`, 403);
    await max.post('/api/approvals/types', { name: 'X', steps: [{ kind: 'admin' }] }, 403);
  });
});

describe('E-Signatur', () => {
  it('nacheinander unterschreiben, Protokoll mit Prüfsumme', async () => {
    testOutbox.messages.length = 0;
    await form(admin, '/api/esign/envelopes', { signers: '[]' }, { name: 'x.txt', data: 'hallo' }).then((r) => expect(r.statusCode).toBe(400));
    const res = await form(admin, '/api/esign/envelopes', { title: 'Wartungsvertrag 2027', sequential: 'true',
      signers: JSON.stringify([{ name: 'Karl Kunde', email: 'karl@kunde.de' }, { name: 'Gerda Geschäftsführung', email: 'gerda@firma.de' }]) }, { name: 'vertrag.pdf', data: '%PDF-1.4\n%Test\n' });
    expect(res.statusCode).toBe(200);
    const { id } = JSON.parse(res.body);
    let e = await admin.get(`/api/esign/envelopes/${id}`);
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.status).toBe('draft');
    await admin.post(`/api/esign/envelopes/${id}/send`);
    expect(testOutbox.messages.map((m) => m.to)).toEqual(['karl@kunde.de']);
    const [t1, t2] = e.signers.map((s: any) => s.link.split('/sign/')[1]);
    const info = JSON.parse((await anon('GET', `/api/pub/sign/${t2}`)).body);
    expect(info.turn).toBe(false);
    expect((await anon('POST', `/api/pub/sign/${t2}`, { name: 'Gerda', consent: true, strokes: sig })).statusCode).toBe(400);
    expect((await anon('GET', `/api/pub/sign/${t1}/file`)).body.startsWith('%PDF')).toBe(true);
    expect((await anon('POST', `/api/pub/sign/${t1}`, { name: 'Karl Kunde', consent: true, strokes: [[[0.1, 0.1]]] })).statusCode).toBe(400); // zu kurz
    expect((await anon('POST', `/api/pub/sign/${t1}`, { name: 'Karl Kunde', consent: true, strokes: sig })).statusCode).toBe(200);
    expect((await anon('POST', `/api/pub/sign/${t1}`, { name: 'Karl Kunde', consent: true, strokes: sig })).statusCode).toBe(400); // doppelt
    expect(testOutbox.messages.map((m) => m.to)).toContain('gerda@firma.de');
    const done = JSON.parse((await anon('POST', `/api/pub/sign/${t2}`, { name: 'Gerda G.', consent: true, strokes: sig })).body);
    expect(done.completed).toBe(true);
    e = await admin.get(`/api/esign/envelopes/${id}`);
    expect(e).toMatchObject({ status: 'completed', hasProtocol: true });
    const prot = await admin.req('GET', `/api/esign/envelopes/${id}/protocol`);
    expect(String(prot.body).startsWith('%PDF')).toBe(true);
    const final = testOutbox.messages.filter((m) => m.subject.startsWith('Unterschrieben'));
    expect(final.length).toBeGreaterThanOrEqual(2);
    expect(final[0]!.attachments).toEqual(['vertrag.pdf', expect.stringMatching(/^Signaturprotokoll_ES-/)]);
  });
  it('Ablehnen beendet den Vorgang; fremde Vorgänge sind gesperrt', async () => {
    const { client: max } = await userClient(env.app, admin, 'max.es');
    const res = await form(max, '/api/esign/envelopes', { signers: JSON.stringify([{ name: 'A', email: 'a@b.de' }]) }, { name: 'angebot.pdf', data: '%PDF-1.4\n' });
    const { id } = JSON.parse(res.body);
    await max.post(`/api/esign/envelopes/${id}/send`);
    const e = await max.get(`/api/esign/envelopes/${id}`);
    const t = e.signers[0].link.split('/sign/')[1];
    expect((await anon('POST', `/api/pub/sign/${t}/decline`, { reason: 'Preis zu hoch' })).statusCode).toBe(200);
    expect((await max.get(`/api/esign/envelopes/${id}`)).status).toBe('declined');
    const { client: eva } = await userClient(env.app, admin, 'eva.es');
    await eva.get(`/api/esign/envelopes/${id}`, 403);
    await runDailyJobs(env.ctx);
  });
});

describe('Auswertungen', () => {
  it('Zeiten und Aufgaben gruppieren, Berichte speichern', async () => {
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.bi');
    const me = await admin.get('/api/auth/me');
    const y = new Date().getFullYear();
    await env.ctx.sql`insert into time_entries (user_id, started_at, ended_at, source) values
      (${me.id}, ${`${y}-01-10T08:00:00Z`}, ${`${y}-01-10T12:00:00Z`}, 'manual'), (${me.id}, ${`${y}-02-03T08:00:00Z`}, ${`${y}-02-03T10:30:00Z`}, 'manual'),
      (${maxId}, ${`${y}-02-04T08:00:00Z`}, ${`${y}-02-04T09:00:00Z`}, 'manual')`;
    const sources = await admin.get('/api/bi/sources');
    expect(sources.map((s: any) => s.id)).toEqual(expect.arrayContaining(['time', 'tasks', 'projects', 'invoices', 'co2']));
    const r = await admin.post('/api/bi/run', { source: 'time', dim: 'month', measure: 'hours', period: 'year' });
    expect(r.rows.map((x: any) => x.key)).toEqual([`${y}-01`, `${y}-02`]);
    expect(r.rows[1].values[0]).toBeCloseTo(3.5);
    expect(r.total).toBeCloseTo(7.5);
    // Mitarbeiter sehen nur eigene Zeiten
    const own = await max.post('/api/bi/run', { source: 'time', dim: 'user', measure: 'hours', period: 'year' });
    expect(own.total).toBeCloseTo(1);
    const byUser = await admin.post('/api/bi/run', { source: 'time', dim: 'month', dim2: 'user', measure: 'hours', period: 'all', chart: 'bar' });
    expect(byUser.series).toHaveLength(2);
    await admin.post('/api/bi/run', { source: 'nope', dim: 'month', measure: 'hours' }, 403);
    await admin.post('/api/bi/run', { source: 'time', dim: 'month', measure: 'x' }, 400);
    const rep = await max.post('/api/bi/reports', { name: 'Meine Stunden', def: { source: 'time', dim: 'month', measure: 'hours' } });
    await max.post('/api/bi/reports', { name: 'Für alle', shared: true, def: { source: 'time', dim: 'month', measure: 'hours' } }, 403);
    await admin.post('/api/bi/reports', { name: 'Aufgaben je Status', shared: true, def: { source: 'tasks', dim: 'status', measure: 'count', chart: 'hbar' } });
    expect((await max.get('/api/bi/reports')).map((x: any) => x.name).sort()).toEqual(['Aufgaben je Status', 'Meine Stunden']);
    await admin.del(`/api/bi/reports/${rep.id}`);
    const x = await admin.req('POST', '/api/bi/export.xlsx', { name: 'Stunden', def: { source: 'time', dim: 'month', measure: 'hours' } });
    expect(x.status).toBe(200);
  });
});

describe('Eigene Felder', () => {
  it('Feld anlegen, prüfen, speichern, löschen', async () => {
    const { client: max } = await userClient(env.app, admin, 'max.cf');
    await max.post('/api/custom-fields', { entity: 'crm_account', label: 'Kostenstelle', type: 'text' }, 403);
    const f = await admin.post('/api/custom-fields', { entity: 'crm_account', label: 'Kundenklasse', type: 'select', options: ['A', 'B', 'C'] });
    expect(f.key).toBe('kundenklasse');
    await admin.post('/api/custom-fields', { entity: 'crm_account', label: 'Kundenklasse', type: 'text' }, 400);
    await admin.post('/api/custom-fields', { entity: 'crm_account', label: 'Rahmenvertrag bis', type: 'date' });
    const acc = await admin.post('/api/crm/accounts', { name: 'Feldtest GmbH' });
    await max.put(`/api/custom-values/crm_account/${acc.id}`, { kundenklasse: 'Z' }, 400);
    const v = await max.put(`/api/custom-values/crm_account/${acc.id}`, { kundenklasse: 'A', rahmenvertrag_bis: '2027-12-31', unbekannt: 'x' });
    expect(v).toEqual({ kundenklasse: 'A', rahmenvertrag_bis: '2027-12-31' });
    expect(await max.get(`/api/custom-values/crm_account/${acc.id}`)).toEqual(v);
    await admin.del(`/api/custom-fields/${f.id}`);
    expect(await max.get(`/api/custom-values/crm_account/${acc.id}`)).toEqual({ rahmenvertrag_bis: '2027-12-31' });
    await max.get(`/api/custom-values/crm_account/00000000-0000-0000-0000-000000000000`, 404);
  });
});

describe('Nachhaltigkeit', () => {
  it('Strom erfassen, Tankbelege übernehmen, Bilanz', async () => {
    const { client: max } = await userClient(env.app, admin, 'max.co2');
    const y = new Date().getFullYear();
    const factors = await admin.get('/api/sustainability/factors');
    const power = factors.find((f: any) => f.key === 'electricity');
    expect(power.kgPerUnit).toBeCloseTo(0.353);
    await max.post('/api/sustainability/entries', { date: `${y}-01-01`, factorId: power.id, quantity: 1000 }, 403);
    await admin.post('/api/sustainability/entries', { date: `${y}-01-01`, periodEnd: `${y}-01-31`, factorId: power.id, quantity: 10000, site: 'Werk 1' });
    const v = await admin.post('/api/fleet/vehicles', { plate: 'FR-CO 2', fuel: 'diesel', mileage: 1000 });
    await admin.post(`/api/fleet/vehicles/${v.id}/entries`, { date: `${y}-02-10`, kind: 'fuel', amount: 90, liters: 50, mileage: 1600 });
    const imp = await admin.post('/api/sustainability/import', { year: y });
    expect(imp.fleet).toBe(1);
    await admin.post('/api/sustainability/import', { year: y }); // wiederholbar ohne Doppelte
    const s = await max.get(`/api/sustainability/summary?year=${y}`);
    expect(s.total).toBeCloseTo(3.53 + 0.133, 3);
    expect(s.scopes.find((x: any) => x.k === 'Scope 1').t).toBeCloseTo(0.133, 3);
    expect(s.months[1].t).toBeCloseTo(0.133, 3);
    const entries = await admin.get(`/api/sustainability/entries?year=${y}`);
    const fleetEntry = entries.find((e: any) => e.origin === 'fleet');
    await admin.patch(`/api/sustainability/entries/${fleetEntry.id}`, { quantity: 1 }, 400);
    const bi = await admin.post('/api/bi/run', { source: 'co2', dim: 'scope', measure: 'co2', period: 'year' });
    expect(bi.total).toBeCloseTo(3.663, 3);
    expect((await admin.req('GET', `/api/sustainability/report.xlsx?year=${y}`)).status).toBe(200);
  });
});
