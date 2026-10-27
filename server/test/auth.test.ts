import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup, userClient, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.close(); });

describe('Erstzugang und Passwort-Zwang', () => {
  it('admin/admin muss das Passwort ändern', async () => {
    const c = new Client(env.app);
    await c.post('/api/auth/login', { username: 'admin', password: 'falsch' }, 401);
    await c.post('/api/auth/login', { username: 'admin', password: 'admin' });
    const me = await c.get('/api/auth/me');
    expect(me.mustChangePassword).toBe(true);
    expect(me.role).toBe('admin');
    await c.get('/api/users', 403);
    await c.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: 'admin' }, 400);
    await c.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: 'kurz' }, 400);
    await c.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: 'Sicher-123!' });
    expect((await c.get('/api/auth/me')).mustChangePassword).toBe(false);
    const users = await c.get('/api/users');
    expect(users).toHaveLength(1);

    // neuer Benutzer muss ebenfalls Passwort ändern; Mitglied darf keine Benutzer anlegen
    const { client } = await userClient(env.app, c, 'lisa');
    await client.post('/api/users', { username: 'x', displayName: 'x', password: 'abcdefghij' }, 403);
    const audit = await c.get('/api/audit');
    expect(audit.some((a: any) => a.action === 'auth.password_change')).toBe(true);
  });

  it('Gesundheitsprüfung und Version', async () => {
    const c = new Client(env.app);
    const h = await c.get('/api/health');
    expect(h.status).toBe('ok');
    const log = await c.get('/api/changelog');
    expect(log[0].version).toBe(h.version);
  });

  it('Änderungsprotokoll ist unveränderbar', async () => {
    await expect(env.ctx.sql`update audit_log set summary = 'x'`).rejects.toThrow(/revisionssicher/);
  });
});
