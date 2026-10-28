import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { testOutbox } from '../src/services/mail';
import { runDailyJobs } from '../src/services/daily';
import { courseStatus } from '../src/routes/training';

let env: TestEnv;
let admin: Client;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  for (const a of ['expenses', 'planning', 'hr', 'training', 'fleet']) await admin.post(`/api/apps/${a}/install`, {});
  testOutbox.enabled = true;
});
afterAll(async () => { testOutbox.enabled = false; await env.close(); });
const form = async (c: Client, url: string, fields: Record<string, string>, file?: { name: string; data: string }) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.data]), file.name);
  const res = new Response(fd);
  return env.app.inject({ method: 'POST', url, payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')!, ...(c.cookie ? { cookie: c.cookie } : {}) } });
};

describe('Spesen', () => {
  it('Reise mit Pauschalen, Beleg, Kilometern; Freigabe durch Teamleiter, Auszahlung', async () => {
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.sp');
    const { client: chef, id: chefId } = await userClient(env.app, admin, 'chef.sp');
    const team = await admin.post('/api/teams', { name: 'Vertrieb Spesen' });
    await admin.put(`/api/teams/${team.id}/members`, { members: [{ userId: maxId, isLead: false }, { userId: chefId, isLead: true }] });
    const r = await max.post('/api/expenses/reports', { title: 'Kundenbesuch Stuttgart', destination: 'Stuttgart', startAt: '2026-03-02T07:00:00+01:00', endAt: '2026-03-03T19:00:00+01:00',
      meals: { '2026-03-03': { breakfast: true } } });
    await form(max, `/api/expenses/reports/${r.id}/items`, { date: '2026-03-02', kind: 'lodging', amount: '119', description: 'Hotel' }, { name: 'hotel.pdf', data: '%PDF-1.4' });
    await max.post(`/api/expenses/reports/${r.id}/items`, { date: '2026-03-02', kind: 'mileage', km: 210, description: 'Furtwangen – Stuttgart' });
    await max.post(`/api/expenses/reports/${r.id}/items`, { date: '2026-03-03', kind: 'receipt', amount: 12, category: 'Parken' });
    await max.post(`/api/expenses/reports/${r.id}/submit`, {}, 400); // Parkbeleg fehlt
    const d0 = await max.get(`/api/expenses/reports/${r.id}`);
    await max.del(`/api/expenses/items/${d0.items.find((i: any) => i.category === 'Parken').id}`);
    const d = await max.get(`/api/expenses/reports/${r.id}`);
    // 14 + (14 − 5,60) Verpflegung + 119 Hotel + 210 km × 0,30 € = 204,40
    expect(d.perDiem.total).toBe(22.4);
    expect(d.total).toBe(204.4);
    await max.post(`/api/expenses/reports/${r.id}/submit`, {});
    expect((await chef.get('/api/expenses/reports?scope=approve')).map((x: any) => x.id)).toEqual([r.id]);
    await max.post(`/api/expenses/reports/${r.id}/decide`, { approve: true }, 403);
    await chef.post(`/api/expenses/reports/${r.id}/decide`, { approve: true });
    await chef.post(`/api/expenses/reports/${r.id}/paid`, {}, 403);
    await admin.post(`/api/expenses/reports/${r.id}/paid`, {});
    expect((await max.get(`/api/expenses/reports/${r.id}`)).status).toBe('paid');
    const pdf = await env.app.inject({ method: 'GET', url: `/api/expenses/reports/${r.id}/pdf`, headers: { cookie: max.cookie } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('Einsatzplanung', () => {
  it('Schichten planen, kopieren, veröffentlichen, offene Schicht übernehmen', async () => {
    const { client: anna, id: annaId } = await userClient(env.app, admin, 'anna.pl');
    const mon = '2026-11-02';
    await anna.post('/api/planning/shifts', { userId: annaId, date: mon, startTime: '06:00', endTime: '14:00' }, 403);
    await admin.post('/api/planning/shifts', { userId: annaId, date: mon, startTime: '06:00', endTime: '14:00', role: 'Frühschicht' });
    await admin.post('/api/planning/shifts', { userId: null, date: '2026-11-03', startTime: '22:00', endTime: '06:00', role: 'Nacht' });
    let w = await anna.get(`/api/planning/week?from=${mon}`);
    expect(w.shifts).toHaveLength(0); // noch nicht veröffentlicht
    const pub = await admin.post('/api/planning/publish', { from: mon });
    expect(pub).toMatchObject({ published: 2, notified: 1 });
    w = await anna.get(`/api/planning/week?from=${mon}`);
    expect(w.shifts).toHaveLength(2);
    expect(w.users.find((u: any) => u.id === annaId).hours).toBe(8);
    const open = await anna.get('/api/planning/open');
    await anna.post(`/api/planning/shifts/${open[0].id}/claim`, {});
    await admin.post(`/api/planning/shifts/${open[0].id}/claim`, {}, 400);
    expect((await anna.get('/api/planning/mine')).length).toBe(2);
    const c = await admin.post('/api/planning/copy', { from: mon, to: '2026-11-09' });
    expect(c.copied).toBe(2);
  });
});

describe('Personal', () => {
  it('Akte mit freigegebenem Dokument, Gespräch mit Zielen, Qualifikationen, Bewerbung mit Löschfrist', async () => {
    const { client: eva, id: evaId } = await userClient(env.app, admin, 'eva.hr');
    await eva.get('/api/hr/people', 403);
    let r = await form(admin, `/api/hr/people/${evaId}/documents`, { category: 'Arbeitsvertrag', title: 'Arbeitsvertrag 2026', visibleToEmployee: 'true' }, { name: 'vertrag.pdf', data: '%PDF-1.4 vertrag' });
    expect(r.statusCode).toBe(200);
    await form(admin, `/api/hr/people/${evaId}/documents`, { category: 'Abmahnung', title: 'intern' }, { name: 'intern.pdf', data: '%PDF' });
    const mine = await eva.get('/api/me/hr');
    expect(mine.documents.map((d: any) => d.title)).toEqual(['Arbeitsvertrag 2026']);
    const f = await env.app.inject({ method: 'GET', url: `/api/me/hr/documents/${mine.documents[0].id}/file`, headers: { cookie: eva.cookie } });
    expect(f.statusCode).toBe(200);
    const all = await admin.get(`/api/hr/people/${evaId}`);
    const intern = all.documents.find((d: any) => d.title === 'intern');
    expect((await env.app.inject({ method: 'GET', url: `/api/me/hr/documents/${intern.id}/file`, headers: { cookie: eva.cookie } })).statusCode).toBe(403);
    const rv = await admin.post(`/api/hr/people/${evaId}/reviews`, { date: '2026-10-01', notes: 'Gutes Jahr', goals: [{ text: 'Schweißschein erneuern' }], shared: true });
    await eva.patch(`/api/me/hr/reviews/${rv.id}`, { goals: [{ done: true }] });
    expect((await eva.get('/api/me/hr')).reviews[0].goals[0].done).toBe(true);
    await eva.patch(`/api/me/hr/reviews/${rv.id}`, { notes: 'geändert' }, 400);
    const sk = await admin.post('/api/hr/skills', { name: 'Staplerschein', category: 'Logistik', needsCertificate: true });
    await admin.put(`/api/hr/people/${evaId}/skills/${sk.id}`, { level: 3, validUntil: '2027-05-01' });
    const m = await admin.get('/api/hr/matrix');
    expect(m.values.find((v: any) => v.userId === evaId)).toMatchObject({ level: 3 });
    // Bewerbung
    const job = await admin.post('/api/hr/jobs', { title: 'Konstrukteur (m/w/d)', location: 'Furtwangen' });
    const jobs = await admin.get('/api/hr/jobs');
    const token = jobs.find((j: any) => j.id === job.id).publicUrl.split('/jobs/')[1];
    const pub = await env.app.inject({ method: 'GET', url: `/api/pub/jobs/${token}` });
    expect(JSON.parse(pub.body).title).toBe('Konstrukteur (m/w/d)');
    const anon = new Client(env.app);
    expect((await form(anon, `/api/pub/jobs/${token}`, { name: 'Bea Werber', email: 'bea@mail.de' }, { name: 'cv.pdf', data: '%PDF' })).statusCode).toBe(400); // Einwilligung fehlt
    expect((await form(anon, `/api/pub/jobs/${token}`, { name: 'Bea Werber', email: 'bea@mail.de', consent: 'true' }, { name: 'cv.pdf', data: '%PDF' })).statusCode).toBe(200);
    const apps = await admin.get('/api/hr/applicants');
    expect(apps[0]).toMatchObject({ name: 'Bea Werber', stage: 'new' });
    expect(apps[0].files).toHaveLength(1);
    await admin.patch(`/api/hr/applicants/${apps[0].id}`, { stage: 'rejected' });
    expect((await admin.get('/api/hr/applicants'))[0].deleteAfter).toBeTruthy();
    await env.ctx.sql`update hr_applicants set delete_after = current_date - 1`;
    await runDailyJobs(env.ctx);
    expect(await admin.get('/api/hr/applicants')).toHaveLength(0);
  });
});

describe('Unterweisungen', () => {
  it('Status-Logik', () => {
    const c = { interval_months: 12, created_at: new Date('2026-01-01T10:00:00Z') };
    expect(courseStatus(c, undefined, '2026-03-01').status).toBe('overdue');
    expect(courseStatus(c, { completed_at: new Date('2026-02-01T10:00:00Z'), valid_until: '2027-02-01' }, '2026-03-01').status).toBe('ok');
    expect(courseStatus(c, { completed_at: new Date('2025-02-01T10:00:00Z'), valid_until: '2026-03-20' }, '2026-03-01').status).toBe('due');
  });
  it('online mit Quiz, Präsenz, Matrix, Erinnerung', async () => {
    const { client: tom, id: tomId } = await userClient(env.app, admin, 'tom.trn');
    const c = await admin.post('/api/training/courses', { title: 'Arbeitsschutz Werkstatt', content: 'Schutzbrille tragen.', intervalMonths: 12,
      quiz: [{ q: 'Was ist an der Drehbank Pflicht?', options: ['Handschuhe', 'Schutzbrille'], correct: 1 }, { q: 'Notaus?', options: ['rot', 'grün'], correct: 0 }] });
    const mine = await tom.get('/api/training/mine');
    expect(mine.courses.find((x: any) => x.id === c.id).status).toMatch(/open|overdue/);
    const detail = await tom.get(`/api/training/courses/${c.id}`);
    expect(detail.quiz[0].correct).toBeUndefined();
    await tom.post(`/api/training/courses/${c.id}/complete`, { answers: [0, 0], confirm: true }, 400);
    const ok = await tom.post(`/api/training/courses/${c.id}/complete`, { answers: [1, 0], confirm: true });
    expect(ok.score).toBe(100);
    expect((await tom.get('/api/training/mine')).courses.find((x: any) => x.id === c.id).status).toBe('ok');
    const pr = await admin.post('/api/training/courses', { title: 'Staplerunterweisung', kind: 'training', intervalMonths: 12, audience: { all: false, teamIds: [], userIds: [tomId] } });
    await admin.post(`/api/training/courses/${pr.id}/attendance`, { userIds: [tomId], date: '2026-10-01', trainer: 'Fa. Sicher' });
    const m = await admin.get('/api/training/matrix');
    expect(m.cells[`${pr.id}:${tomId}`]).toMatchObject({ status: 'ok', validUntil: '2027-10-01' });
    testOutbox.messages.length = 0;
    await admin.post('/api/training/courses', { title: 'Brandschutz', intervalMonths: 24 });
    await runDailyJobs(env.ctx);
    const n = await tom.get('/api/notifications');
    expect(JSON.stringify(n)).toContain('Brandschutz');
  });
});

describe('Fuhrpark', () => {
  it('Fahrzeug, Tanken, Fahrtenbuch lückenlos, Schaden, HU-Erinnerung, Führerschein', async () => {
    const { client: fahrer, id: fahrerId } = await userClient(env.app, admin, 'fahrer.fl');
    const v = await admin.post('/api/fleet/vehicles', { plate: 'vs-ap 123', make: 'VW', model: 'Caddy', listPrice: 38450, privateUse: true, driverId: fahrerId, mileage: 12000, nextHu: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) });
    await fahrer.post('/api/fleet/vehicles', { plate: 'X' }, 403);
    await fahrer.post(`/api/fleet/vehicles/${v.id}/trips`, { date: '2026-10-01', startKm: 12000, endKm: 12150, kind: 'business' }, 400); // Zweck fehlt
    await fahrer.post(`/api/fleet/vehicles/${v.id}/trips`, { date: '2026-10-01', startKm: 12000, endKm: 12150, kind: 'business', purpose: 'Kundenbesuch', partner: 'Kunde AG', destination: 'Freiburg' });
    await fahrer.post(`/api/fleet/vehicles/${v.id}/trips`, { date: '2026-10-02', startKm: 12100, endKm: 12200, kind: 'private' }, 400); // überlappt
    const t2 = await fahrer.post(`/api/fleet/vehicles/${v.id}/trips`, { date: '2026-10-02', startKm: 12160, endKm: 12200, kind: 'private' });
    expect(t2.gap).toBe(10);
    await fahrer.post(`/api/fleet/vehicles/${v.id}/entries`, { date: '2026-10-02', kind: 'fuel', amount: 85.4, liters: 48.2, mileage: 12200 });
    await fahrer.post(`/api/fleet/vehicles/${v.id}/damages`, { date: '2026-10-03', description: 'Kratzer an der Schiebetür' });
    const d = await fahrer.get(`/api/fleet/vehicles/${v.id}`);
    expect(d).toMatchObject({ plate: 'VS-AP 123', mileage: 12200, km12: 190, cost12: 85.4, openDamages: 1, benefitMonthly: 384 });
    const x = await env.app.inject({ method: 'GET', url: `/api/fleet/vehicles/${v.id}/logbook.xlsx?year=2026`, headers: { cookie: fahrer.cookie } });
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
    await runDailyJobs(env.ctx);
    await runDailyJobs(env.ctx);
    const n = (await fahrer.get('/api/notifications')).filter((y: any) => /Hauptuntersuchung/.test(y.title));
    expect(n).toHaveLength(1);
    let lic = await admin.get('/api/fleet/licenses');
    expect(lic.find((l: any) => l.id === fahrerId)).toMatchObject({ drives: true, overdue: true });
    await admin.post('/api/fleet/licenses', { userId: fahrerId, date: new Date().toISOString().slice(0, 10), classes: 'B' });
    lic = await admin.get('/api/fleet/licenses');
    expect(lic.find((l: any) => l.id === fahrerId).overdue).toBe(false);
  });
});
