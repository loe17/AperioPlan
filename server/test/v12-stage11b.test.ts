import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { resolveGuest } from '../src/routes/meetings';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); await admin.post('/api/apps/meetings/install', {}); });
afterAll(async () => { await env.close(); });

const anon = async (method: string, url: string, body?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, payload: body as object });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

describe('Meetings', () => {
  it('planen, Kalender, Gast im Warteraum einlassen, Chat als Gast, absagen', async () => {
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.meet');
    const start = new Date(Date.now() + 3600_000).toISOString();
    const r = await admin.post('/api/meetings', { title: 'Abnahme Roboterzelle', startsAt: start, durationMinutes: 45, participantIds: [lisaId], invitees: [{ email: 'kunde@example.com', name: 'Herr Kunde' }], pin: '4711' });
    expect(r.guestUrl).toMatch(/\/meet\/[\w-]+$/);
    expect(r.warning).toMatch(/Einladungen nicht versendet/); // kein E-Mail-Konto im Test
    const token = r.guestUrl.split('/').pop();

    // Lisa sieht das Meeting und den Termin im Kalender
    const list = await lisa.get('/api/meetings?upcoming=1');
    expect(list[0]).toMatchObject({ title: 'Abnahme Roboterzelle', hostName: expect.any(String) });
    const ev = await lisa.get(`/api/calendar/events?from=${new Date().toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`);
    expect(ev.some((e: any) => e.title === 'Abnahme Roboterzelle')).toBe(true);
    await lisa.req('PATCH', `/api/meetings/${r.id}`, { title: 'X' }, 403);

    // Gast-Seite ohne Anmeldung
    const pub = await anon('GET', `/api/meet/${token}`);
    expect(pub.body).toMatchObject({ title: 'Abnahme Roboterzelle', needsPin: true, lobby: true });
    expect((await anon('POST', `/api/meet/${token}/join`, { name: 'Herr Kunde', pin: '0000' })).status).toBe(403);
    const j = await anon('POST', `/api/meet/${token}/join`, { name: 'Herr Kunde', pin: '4711' });
    expect(j.body.status).toBe('waiting');
    expect((await anon('GET', `/api/meet/${token}/status?guest=${j.body.guest}&key=${j.body.key}`)).body.status).toBe('waiting');
    expect(await resolveGuest(env.ctx, j.body.guest, j.body.key)).toBeNull();

    const detail = await admin.get(`/api/meetings/${r.id}`);
    expect(detail.guests[0]).toMatchObject({ name: 'Herr Kunde', status: 'waiting' });
    expect(detail.pin).toBe('4711');
    await admin.post(`/api/meetings/${r.id}/guests/${j.body.guest}/admit`, {});
    const st = (await anon('GET', `/api/meet/${token}/status?guest=${j.body.guest}&key=${j.body.key}`)).body;
    expect(st).toMatchObject({ status: 'admitted', name: 'Herr Kunde', hostId: expect.any(String), callId: expect.any(String) });
    expect((await resolveGuest(env.ctx, j.body.guest, j.body.key))?.name).toBe('Herr Kunde');
    expect((await anon('GET', `/api/meet/${token}/status?guest=${j.body.guest}&key=falschfalschfalsch`)).status).toBe(403);

    // Chat im Anruf: Gast schreibt, Mitarbeiter sieht es mit Namen
    const msg = await anon('POST', `/api/meet/${token}/messages`, { guest: j.body.guest, key: j.body.key, callId: st.callId, body: 'Guten Tag!' });
    expect(msg.body.userName).toBe('Herr Kunde (Gast)');
    const seen = await lisa.get(`/api/chat/calls/${st.callId}/messages`);
    expect(seen[0]).toMatchObject({ body: 'Guten Tag!', userName: 'Herr Kunde (Gast)' });

    // neuer Link macht den alten ungültig; Absage löscht den Kalendertermin
    const nl = await admin.post(`/api/meetings/${r.id}/new-link`, {});
    expect((await anon('GET', `/api/meet/${token}`)).status).toBe(404);
    expect((await anon('GET', `/api/meet/${nl.guestUrl.split('/').pop()}`)).status).toBe(200);
    await admin.req('DELETE', `/api/meetings/${r.id}`);
    expect((await lisa.get('/api/meetings?upcoming=1'))).toHaveLength(0);
    expect((await anon('POST', `/api/meet/${nl.guestUrl.split('/').pop()}/join`, { name: 'Spät' })).status).toBe(400);
  });

  it('ohne Warteraum direkt dabei; App ausgeschaltet = Link ungültig', async () => {
    const r = await admin.post('/api/meetings', { title: 'Kurz', startsAt: new Date().toISOString(), lobby: false });
    const token = r.guestUrl.split('/').pop();
    const j = await anon('POST', `/api/meet/${token}/join`, { name: 'Gast' });
    expect(j.body.status).toBe('admitted');
    await admin.post('/api/apps/meetings/uninstall', {});
    expect((await anon('GET', `/api/meet/${token}`)).status).toBe(404);
    await admin.post('/api/apps/meetings/install', {});
  });
});
