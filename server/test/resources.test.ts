import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, setup, userClient, type Client, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client, lisa: Client, tom: Client;
let room: string, car: string, room2: string;
const day = (d: number, h: number) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };

beforeAll(async () => {
  env = await setup();
  admin = await adminClient(env.app);
  ({ client: lisa } = await userClient(env.app, admin, 'lisa'));
  ({ client: tom } = await userClient(env.app, admin, 'tom'));
});
afterAll(async () => { await env.close(); });

describe('Ressourcen', () => {
  it('nur Administratoren legen Ressourcen an', async () => {
    await lisa.post('/api/resources', { name: 'Raum X' }, 403);
    room = (await admin.post('/api/resources', { name: 'Besprechungsraum 1', kind: 'room', capacity: 8, location: 'EG' })).id;
    room2 = (await admin.post('/api/resources', { name: 'Besprechungsraum 2', kind: 'room', capacity: 4 })).id;
    car = (await admin.post('/api/resources', { name: 'VW Caddy', kind: 'vehicle', requiresApproval: true })).id;
    expect(await lisa.get('/api/resources')).toHaveLength(3);
  });

  it('verhindert Doppelbuchungen und schlägt Alternativen vor', async () => {
    await lisa.post('/api/resources/bookings', { resourceId: room, startsAt: day(1, 9), endsAt: day(1, 10), title: 'Kundentermin Muster GmbH' });
    const r = await tom.req('POST', '/api/resources/bookings', { resourceId: room, startsAt: day(1, 9), endsAt: day(1, 11) });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('LISA');
    expect(r.body.details.alternatives.map((a: any) => a.name)).toEqual(['Besprechungsraum 2']);
    await tom.post('/api/resources/bookings', { resourceId: room, startsAt: day(1, 10), endsAt: day(1, 11) }); // direkt im Anschluss ist ok
    // Datenschutz: Kollegen sehen Name, aber keinen Anlass
    const list = await tom.get(`/api/resources/bookings?from=${day(0, 0)}&to=${day(3, 0)}`);
    const lisas = list.find((b: any) => b.userName === 'LISA');
    expect(lisas.title).toBeNull();
    expect((await admin.get(`/api/resources/bookings?from=${day(0, 0)}&to=${day(3, 0)}`)).find((b: any) => b.userName === 'LISA').title).toBe('Kundentermin Muster GmbH');
  });

  it('gleichzeitige Buchungen: die Datenbank lässt nur eine zu', async () => {
    const body = { resourceId: room2, startsAt: day(2, 14), endsAt: day(2, 15) };
    const res = await Promise.all([lisa.req('POST', '/api/resources/bookings', body), tom.req('POST', '/api/resources/bookings', body)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('Genehmigung für Fahrzeuge, wöchentliche Serie, Stornieren', async () => {
    const b = await lisa.post('/api/resources/bookings', { resourceId: car, startsAt: day(3, 8), endsAt: day(3, 17), title: 'Baustelle Ulm', repeatWeeklyUntil: day(17, 12).slice(0, 10) });
    expect(b.status).toBe('pending');
    expect(b.count).toBe(3);
    const review = await admin.get('/api/resources/bookings/review');
    expect(review).toHaveLength(3);
    expect((await admin.get('/api/notifications'))[0].kind).toBe('resource.request');
    await tom.post(`/api/resources/bookings/${b.ids[0]}/decide`, { approve: true }, 403);
    await admin.post(`/api/resources/bookings/${b.ids[0]}/decide`, { approve: true });
    expect(await admin.get('/api/resources/bookings/review')).toHaveLength(0);
    const c = await lisa.post(`/api/resources/bookings/${b.ids[1]}/cancel`, { series: true });
    expect(c.cancelled).toBe(2);
  });

  it('gesperrte Ressourcen sind nicht buchbar, mit Zukunftsbuchungen nicht löschbar', async () => {
    await admin.patch(`/api/resources/${room2}`, { active: false });
    await lisa.post('/api/resources/bookings', { resourceId: room2, startsAt: day(5, 9), endsAt: day(5, 10) }, 400);
    expect((await lisa.get('/api/resources')).some((r: any) => r.id === room2)).toBe(false);
    await admin.del(`/api/resources/${room}`, 400);
  });

  it('Team-Beschränkung', async () => {
    const team = await admin.post('/api/teams', { name: 'Montage' });
    const lab = (await admin.post('/api/resources', { name: 'Messgerät', kind: 'equipment', allowedTeamIds: [team.id] })).id;
    await lisa.post('/api/resources/bookings', { resourceId: lab, startsAt: day(4, 9), endsAt: day(4, 10) }, 403);
    expect((await lisa.get('/api/resources')).find((r: any) => r.id === lab).canBook).toBe(false);
  });
});
