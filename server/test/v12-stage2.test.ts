import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, uploadFiles, type TestEnv } from './helpers';
import { totpCode, verifyTotp, base32Decode, base32Encode } from '../src/lib/totp';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('Zwei-Faktor-Anmeldung', () => {
  it('TOTP entspricht RFC 6238 (Testvektor)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });

  it('Anmeldung verlangt nach dem Einschalten zusätzlich den Code', async () => {
    const { client: lisa } = await userClient(env.app, admin, 'twofa-lisa');
    const setupR = await lisa.post('/api/me/2fa/setup', {});
    expect(setupR.qr).toContain('<svg');
    await lisa.req('POST', '/api/me/2fa/enable', { code: '000000' }, 400);
    await lisa.post('/api/me/2fa/enable', { code: totpCode(setupR.secret) });

    const c = new Client(env.app);
    const r = await c.post('/api/auth/login', { username: 'twofa-lisa', password: 'Neu-12345678' });
    expect(r.twoFactor).toBe(true);
    await c.req('GET', '/api/auth/me', undefined, 401);
    await c.req('POST', '/api/auth/login/2fa', { ticket: r.ticket, code: '123456' }, 401);
    await c.post('/api/auth/login/2fa', { ticket: r.ticket, code: totpCode(setupR.secret) });
    expect((await c.get('/api/auth/me')).username).toBe('twofa-lisa');

    // Administrator setzt zurück (z. B. neues Handy)
    const users = await admin.get('/api/users');
    const id = users.find((u: any) => u.username === 'twofa-lisa').id;
    await admin.req('DELETE', `/api/users/${id}/2fa`);
    const c2 = new Client(env.app);
    expect((await c2.post('/api/auth/login', { username: 'twofa-lisa', password: 'Neu-12345678' })).ok).toBe(true);
  });
});

describe('Werkzeugrechte und Abteilungen', () => {
  it('Benutzer brauchen eine Abteilung und werden Mitglied', async () => {
    await admin.req('POST', '/api/users', { username: 'ohne-abt', displayName: 'Ohne', password: 'Start-12345' }, 400);
    const dept = await admin.post('/api/teams', { name: 'Einkauf' });
    const u = await admin.post('/api/users', { username: 'mit-abt', displayName: 'Mit', password: 'Start-12345', departmentId: dept.id });
    const teams = await admin.get('/api/teams');
    expect(teams.find((t: any) => t.id === dept.id).members.some((m: any) => m.userId === u.id)).toBe(true);
  });

  it('nicht freigeschaltete Werkzeuge sind gesperrt (Abteilung und je Person)', async () => {
    const dept = await admin.post('/api/teams', { name: 'Montage', defaultTools: ['time', 'absences'] });
    const { id } = await admin.post('/api/users', { username: 'monteur', displayName: 'Monteur', password: 'Start-12345', departmentId: dept.id });
    const c = new Client(env.app);
    await c.post('/api/auth/login', { username: 'monteur', password: 'Start-12345' });
    await c.post('/api/auth/change-password', { currentPassword: 'Start-12345', newPassword: 'Neu-12345678' });
    expect((await c.get('/api/auth/me')).tools.sort()).toEqual(['absences', 'time']);
    await c.req('GET', '/api/time/current', undefined, 200);
    await c.req('GET', '/api/chat/channels', undefined, 403);
    await c.req('GET', '/api/kvp', undefined, 403);
    await admin.patch(`/api/users/${id}`, { tools: ['time', 'chat'] });
    await c.req('GET', '/api/chat/channels', undefined, 200);
    await c.req('GET', '/api/absences/balance', undefined, 403);
  });
});

describe('Benutzer löschen', () => {
  it('Konto weg, Namen und Inhalte bleiben, Aufgaben werden übertragen', async () => {
    const { client: tom, id: tomId } = await userClient(env.app, admin, 'loesch-tom');
    const { id: evaId } = await userClient(env.app, admin, 'loesch-eva');
    const p = await admin.post('/api/projects', { name: 'Löschprojekt' });
    const task = await admin.post(`/api/projects/${p.id}/tasks`, { title: 'Offen', assigneeId: tomId });
    await tom.post(`/api/comments/task/${task.id}`, { body: 'Mein Kommentar' });
    await admin.req('DELETE', `/api/users/${tomId}`, { transferTo: evaId });
    const t = await admin.get(`/api/tasks/${task.id}`);
    expect(t.assigneeId).toBe(evaId);
    const comments = await admin.get(`/api/comments/task/${task.id}`);
    expect(comments[0].userName).toBe('LOESCH-TOM (gelöscht)');
    await tom.req('GET', '/api/auth/me', undefined, 401);
    expect((await admin.get('/api/users')).some((u: any) => u.id === tomId)).toBe(false);
    const c = new Client(env.app);
    await c.req('POST', '/api/auth/login', { username: 'loesch-tom', password: 'Neu-12345678' }, 401);
  });
  it('das eigene Konto und der letzte Administrator lassen sich nicht löschen', async () => {
    const me = await admin.get('/api/auth/me');
    await admin.req('DELETE', `/api/users/${me.id}`, {}, 400);
  });
});

describe('Profil und Benachrichtigungen', () => {
  it('Profilbild hoch- und herunterladen', async () => {
    const { client: c, id } = await userClient(env.app, admin, 'bild-ben');
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const r = await uploadFiles(env.app, '/api/me/avatar', [{ name: 'a.png', content: png }], c.cookie, {}, 'image/png');
    expect(r.status).toBe(200);
    const img = await admin.req('GET', `/api/users/${id}/avatar`);
    expect(img.status).toBe(200);
  });
  it('Benachrichtigungen lassen sich je Anlass abschalten', async () => {
    const { client: c, id } = await userClient(env.app, admin, 'ruhig-rita');
    await c.put('/api/me/notify-prefs', { 'task.assigned': { app: false, mail: false } });
    const p = await admin.post('/api/projects', { name: 'Ruhe' });
    await admin.post(`/api/projects/${p.id}/tasks`, { title: 'Still', assigneeId: id });
    expect((await c.get('/api/notifications')).length).toBe(0);
    const prefs = await c.get('/api/me/notify-prefs');
    expect(prefs.find((x: any) => x.kind === 'task.assigned').app).toBe(false);
  });
});
