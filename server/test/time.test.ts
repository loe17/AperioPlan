import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, setup, userClient, type Client, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
let lead: Client, lisa: Client, tom: Client;
let lisaId: string, leadId: string, tomId: string;
let project: any;

beforeAll(async () => {
  env = await setup();
  admin = await adminClient(env.app);
  ({ client: lead, id: leadId } = await userClient(env.app, admin, 'chef', 'teamlead'));
  ({ client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa'));
  ({ client: tom, id: tomId } = await userClient(env.app, admin, 'tom'));
  const team = await admin.post('/api/teams', { name: 'Konstruktion' });
  await admin.put(`/api/teams/${team.id}/members`, { members: [{ userId: leadId, isLead: true }, { userId: lisaId }, { userId: tomId }] });
  project = await admin.post('/api/projects', { name: 'Zeitprojekt' });
});
afterAll(async () => { await env.close(); });

describe('Zeiterfassung', () => {
  it('Stempeluhr mit Projektwechsel', async () => {
    const t = await admin.post(`/api/projects/${project.id}/tasks`, { title: 'Rahmen' });
    const a = await lisa.post('/api/time/clock-in', { projectId: project.id });
    expect(a.projectNumber).toBe('0100');
    const b = await lisa.post('/api/time/clock-in', { taskId: t.id });
    expect(b.taskTitle).toBe('Rahmen');
    const cur = await lisa.get('/api/time/current');
    expect(cur.running.id).toBe(b.id);
    await lisa.post('/api/time/clock-out', {});
    await lisa.post('/api/time/clock-out', {}, 400);
    const today = new Date().toISOString().slice(0, 10);
    const entries = await lisa.get(`/api/time/entries?from=${today}&to=${today}`);
    expect(entries).toHaveLength(2);
    await lisa.get(`/api/time/entries?from=${today}&to=${today}&userId=${tomId}`, 403);
    expect((await lead.get(`/api/time/entries?from=${today}&to=${today}&userId=${lisaId}`))).toHaveLength(2);
  });

  it('Korrekturanfrage wird von der Teamleitung genehmigt', async () => {
    const c = await lisa.post('/api/time/corrections', { kind: 'add', projectId: project.id, newStartedAt: '2026-10-26T07:00:00Z', newEndedAt: '2026-10-26T11:30:00Z', what: 'Montag vergessen zu stempeln', reason: 'Baustellentermin' });
    await tom.post(`/api/time/corrections/${c.id}/decide`, { approve: true }, 403);
    await lisa.post(`/api/time/corrections/${c.id}/decide`, { approve: true }, 403);
    const review = await lead.get('/api/time/corrections?scope=review');
    expect(review[0].what).toBe('Montag vergessen zu stempeln');
    expect((await lead.get('/api/notifications'))[0].kind).toBe('time.correction');
    await lead.post(`/api/time/corrections/${c.id}/decide`, { approve: true });
    const entries = await lisa.get('/api/time/entries?from=2026-10-26&to=2026-10-26');
    expect(entries[0].hours).toBe(4.5);
    expect(entries[0].source).toBe('correction');
    const pt = await admin.get(`/api/projects/${project.id}/time`);
    expect(pt.total).toBeGreaterThan(4.4);
    const csv = await lead.req('GET', '/api/time/export?from=2026-10-01&to=2026-10-31');
    expect(csv.body).toContain('LISA');
  });
});

describe('Urlaub und DSGVO-Teamkalender', () => {
  it('berechnet Tage ohne Feiertage, prüft Resturlaub und zeigt Kollegen nur „Abwesend“', async () => {
    const y = 2027;
    await admin.post('/api/holidays/generate', { year: y, state: 'BW' });
    const pv = await lisa.post('/api/absences/preview', { startDate: `${y}-12-21`, endDate: `${y}-12-31` });
    expect(pv.days).toBe(9); // 2027: 25./26.12. fallen aufs Wochenende
    const a = await lisa.post('/api/absences', { startDate: `${y}-12-21`, endDate: `${y}-12-31`, kind: 'other', note: 'Arzttermin – privat' });
    await lisa.post('/api/absences', { startDate: `${y}-12-22`, endDate: `${y}-12-23` }, 400);
    await lisa.post('/api/absences', { startDate: `${y}-01-05`, endDate: `${y}-03-31` }, 400); // zu viel Urlaub
    const bal = await lisa.get(`/api/absences/balance?year=${y}`);
    expect(bal.remaining).toBe(30);
    // Kollege sieht offenen Antrag nicht, Teamleitung schon
    const cal = (who: Client) => who.get(`/api/calendar/team?from=${y}-12-01&to=${y}-12-31`);
    expect(await cal(tom)).toHaveLength(0);
    expect((await cal(lead))[0].status).toBe('pending');
    await lead.post(`/api/absences/${a.id}/decide`, { approve: true });
    const forTom = await cal(tom);
    expect(forTom).toHaveLength(1);
    expect(forTom[0].label).toBe('Abwesend');
    expect(forTom[0]).not.toHaveProperty('note');
    expect(forTom[0]).not.toHaveProperty('kind');
    expect(JSON.stringify(forTom)).not.toContain('Arzt');
    const v = await lisa.post('/api/absences', { startDate: `${y}-08-03`, endDate: `${y}-08-14` });
    expect(v.days).toBe(9);
    expect((await lisa.get(`/api/absences/balance?year=${y}`)).pending).toBe(9);
    const easter = await lisa.post('/api/absences/preview', { startDate: `${y}-03-22`, endDate: `${y}-04-02` });
    expect(easter.days).toBe(8); // Karfreitag 26.3. und Ostermontag 29.3.2027
  });
});
