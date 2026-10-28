import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { process.env.FRESH_APPS = '1'; env = await setup(); delete process.env.FRESH_APPS; admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('Neue Installation', () => {
  it('nur Chat und E-Mail sind eingeschaltet, alles Weitere kommt aus dem App-Store', async () => {
    const me = await admin.get('/api/auth/me');
    expect(me.tools.sort()).toEqual(['chat', 'mail']);
    await admin.req('GET', '/api/time/current', undefined, 403);
    await admin.req('GET', '/api/crm/accounts', undefined, 403);
    // Abhängigkeiten werden mitinstalliert
    const r = await admin.post('/api/apps/finance/install', {});
    expect(r.alsoInstalled).toContain('crm');
    expect((await admin.get('/api/auth/me')).tools).toEqual(expect.arrayContaining(['crm', 'finance']));
  });
});
