import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { writeZip } from '../src/lib/zip';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let env: TestEnv;
let admin: Client;
beforeAll(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  process.env.PLUGINS_DIR = await mkdtemp(join(tmpdir(), 'aperio-plugins-'));
  env = await setup(); admin = await adminClient(env.app);
});
afterAll(async () => { await env.close(); });

async function uploadZip(buf: Buffer) {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)]), 'plugin.zip');
  const res = new Response(fd);
  const r = await env.app.inject({ method: 'POST', url: '/api/apps/upload', payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')!, cookie: admin.cookie } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

describe('App-Store', () => {
  it('mitgelieferte Anwendungen ein- und ausschalten, Rechte bleiben je Benutzer', async () => {
    const apps = await admin.get('/api/apps');
    expect(apps.find((a: any) => a.id === 'crm').installed).toBe(true);
    expect(apps.find((a: any) => a.id === 'forms').installed).toBe(false);
    // nicht installiert: auch für Administratoren gesperrt
    const r = await admin.req('GET', '/api/forms');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/App-Store/);

    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.apps');
    await admin.patch(`/api/users/${lisaId}`, { tools: ['chat'] });
    await admin.post('/api/apps/finance/install', {}).catch(() => null);
    await admin.req('POST', '/api/apps/finance/install', {}, 200);
    // Abhängigkeit: Finanzbuchhaltung braucht CRM – CRM lässt sich dann nicht ausschalten
    const un = await admin.req('POST', '/api/apps/crm/uninstall', {});
    expect(un.status).toBe(400);
    expect(un.body.error).toMatch(/Finanzbuchhaltung/);
    await admin.post('/api/apps/finance/uninstall', {});

    await admin.post('/api/apps/mindmap/install', { grantAll: true });
    expect((await lisa.get('/api/auth/me')).tools).toEqual(expect.arrayContaining(['chat', 'mindmap']));
    await admin.post('/api/apps/chat/uninstall', {});
    expect((await lisa.get('/api/auth/me')).tools).not.toContain('chat');
    expect((await lisa.get('/api/apps')).map((a: any) => a.id)).not.toContain('chat');
    await admin.post('/api/apps/chat/install', { grantAll: false });
  });

  it('Plugin als ZIP hochladen, installieren, Datenablage nutzen, entfernen', async () => {
    const manifest = { id: 'umfrage-light', name: 'Umfrage light', version: '0.1.0', description: 'Test', page: { label: 'Umfrage', entry: 'index.html' } };
    const zip = writeZip([{ name: 'umfrage-light/manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: 'umfrage-light/index.html', data: Buffer.from('<script src="/plugin-sdk.js"></script>') }]);
    const up = await uploadZip(zip);
    expect(up.status).toBe(200);
    expect((await uploadZip(writeZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...manifest, id: 'crm' })) }]))).status).toBe(400);
    expect((await uploadZip(writeZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...manifest, id: 'boese' })) }, { name: '../ausbruch.txt', data: Buffer.from('x') }]))).status).toBe(400);

    let store = await admin.get('/api/apps');
    expect(store.find((a: any) => a.id === 'umfrage-light')).toMatchObject({ source: 'plugin', installed: false, route: '/plugin/umfrage-light' });
    await admin.req('GET', '/api/plugin-data/umfrage-light/antworten', undefined, 403);
    await admin.post('/api/apps/umfrage-light/install', {});
    const page = await env.app.inject({ method: 'GET', url: '/plugins/umfrage-light/index.html' });
    expect(page.statusCode).toBe(200);
    const sdk = await env.app.inject({ method: 'GET', url: '/plugin-sdk.js' });
    expect(sdk.body).toContain('window.AperioPlan');

    const doc = await admin.post('/api/plugin-data/umfrage-light/antworten', { data: { frage: 'Kaffee?', ja: 3 } });
    await admin.put(`/api/plugin-data/umfrage-light/antworten/${doc.id}`, { data: { frage: 'Kaffee?', ja: 4 } });
    const mine = await admin.post('/api/plugin-data/umfrage-light/notizen', { scope: 'user', data: { text: 'privat' } });
    const { client: max } = await userClient(env.app, admin, 'max.plugin');
    expect((await max.get('/api/plugin-data/umfrage-light/antworten'))[0].data.ja).toBe(4);
    await max.req('GET', `/api/plugin-data/umfrage-light/notizen/${mine.id}`, undefined, 404);
    await max.req('DELETE', `/api/plugin-data/umfrage-light/antworten/${doc.id}`, undefined, 403);

    await admin.req('DELETE', '/api/apps/umfrage-light', undefined, 200);
    store = await admin.get('/api/apps');
    expect(store.find((a: any) => a.id === 'umfrage-light')).toBeUndefined();
  });
});

describe('Eigene Startseite', () => {
  it('speichert Kacheln je Benutzer', async () => {
    const d = await admin.get('/api/me/dashboard');
    expect(d.isDefault).toBe(true);
    expect(d.widgets.length).toBeGreaterThan(3);
    await admin.put('/api/me/dashboard', { widgets: [{ id: 'a', type: 'clock', size: 1, config: { zone: 'Asia/Tokyo' } }, { id: 'b', type: 'weather', size: 2 }] });
    expect((await admin.get('/api/me/dashboard')).widgets).toHaveLength(2);
    await admin.req('PUT', '/api/me/dashboard', { widgets: [{ id: 'x', type: 'gibtsnicht', size: 1 }] }, 400);
    await admin.put('/api/me/weather-location', { name: 'Stuttgart', latitude: 48.78, longitude: 9.18 });
    expect((await admin.get('/api/me/dashboard')).weatherLocation.name).toBe('Stuttgart');
    await admin.put('/api/me/dashboard', { widgets: null });
    expect((await admin.get('/api/me/dashboard')).isDefault).toBe(true);
  });
});
