import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VERSION } from '@aperio/shared';
import { adminClient, Client, setup, type TestEnv } from './helpers';
import { checkTarget } from '../src/routes/update';

let env: TestEnv;
let admin: Client;
let trigger: string;
const [maj, min, pat] = APP_VERSION.split('.').map(Number) as [number, number, number];
const newer = `${maj}.${min}.${pat + 1}`;
const releases = [
  { tag_name: 'v1.1.0', name: 'alt', body: '', html_url: 'x', published_at: '2026-10-27T10:00:00Z', draft: false, prerelease: false },
  { tag_name: 'v1.0.0', name: 'alt', body: '', html_url: 'x', published_at: '2026-10-20T10:00:00Z', draft: false, prerelease: false },
  { tag_name: `v${newer}`, name: 'neu', body: 'Neues', html_url: 'x', published_at: '2026-11-04T10:00:00Z', draft: false, prerelease: false },
  { tag_name: `v${APP_VERSION}`, name: 'aktuell', body: '', html_url: 'x', published_at: '2026-11-03T10:00:00Z', draft: false, prerelease: false },
  { tag_name: 'v0.1.3', name: 'zu alt', body: '', html_url: 'x', published_at: '2026-10-25T10:00:00Z', draft: false, prerelease: false },
  { tag_name: `v${maj}.${min + 1}.0`, name: 'Vorschau', body: '', html_url: 'x', published_at: '2026-11-04T11:00:00Z', draft: false, prerelease: true },
];

beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  trigger = join(await mkdtemp(join(tmpdir(), 'aperio-upd-')), 'request');
  (env.ctx.config as { updateTriggerFile: string }).updateTriggerFile = trigger;
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) =>
    String(url).includes('api.github.com') && String(url).includes('/releases') ? new Response(JSON.stringify(releases), { status: 200 }) : real(url, init));
});
afterAll(async () => { vi.unstubAllGlobals(); await env.close(); });

describe('Versionen wechseln', () => {
  it('bietet die neueste reguläre Version an, nie die alten 1.x-Testfassungen', async () => {
    const c = await admin.get('/api/system/update/check');
    expect(c).toMatchObject({ latest: newer, updateAvailable: true });
    const v = await admin.get('/api/system/update/versions');
    expect(v.versions.map((x: any) => x.version)).toEqual([`${maj}.${min + 1}.0`, newer, APP_VERSION]);
    expect(v.versions.find((x: any) => x.version === APP_VERSION).relation).toBe('current');
  });
  it('ältere Version nur mit Bestätigung, nie vor der Mindestversion oder 1.x', () => {
    expect(checkTarget('v0.3.0', '0.4.1', true)).toEqual({ older: true });
    expect(() => checkTarget('v0.3.0', '0.4.1', false)).toThrow(/bestätigen/);
    expect(() => checkTarget('v0.1.3', '0.4.1', true)).toThrow(/vor 0.2.0/);
    expect(() => checkTarget('v1.1.0', '0.4.1', true)).toThrow(/Testfassungen/);
    expect(checkTarget('v0.5.0', '0.4.1', false)).toEqual({ older: false });
    expect(checkTarget('main', '0.4.1', false)).toEqual({ older: false });
  });
  it('Aufruf schreibt den Auftrag für den Updater und sichert vorher', async () => {
    await admin.post('/api/system/update', { ref: 'v1.1.0' }, 400);
    await admin.post('/api/system/update', { ref: 'v0.1.3', confirmOlder: true }, 400);
    const r = await admin.post('/api/system/update', { ref: `v${newer}` });
    expect(r.older).toBe(false);
    expect(await readFile(trigger, 'utf8')).toBe(`v${newer}`);
    const v = await admin.get('/api/system/update/versions');
    expect(v.history[0].summary).toContain(newer);
  });
});
