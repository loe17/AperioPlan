import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminClient, Client, setup, uploadFiles, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
let project: any;
beforeAll(async () => {
  env = await setup();
  admin = await adminClient(env.app);
  project = await admin.post('/api/projects', { name: 'Dateitest' });
});
afterAll(async () => { await env.close(); });

describe('Dateiverwaltung', () => {
  it('Upload mit Versionierung und Explorer-Abgleich', async () => {
    let r = await uploadFiles(env.app, `/api/projects/${project.id}/files/upload?path=03_Doku`, [{ name: 'Plan.txt', content: 'v1' }], admin.cookie);
    expect(r.status).toBe(200);
    r = await uploadFiles(env.app, `/api/projects/${project.id}/files/upload?path=03_Doku`, [{ name: 'Plan.txt', content: 'version 2' }], admin.cookie);
    expect(r.body[0].version).toBe(2);
    const versions = await admin.get(`/api/files/${r.body[0].id}/versions`);
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    const old = await admin.req('GET', `/api/files/${r.body[0].id}/download?version=1`);
    expect(old.body).toBe('v1');
    // Datei direkt im Explorer abgelegt
    await writeFile(env.ctx.storage.abs(`${project.folderPath}/03_Doku/extern.pdf`), 'pdf');
    const list = await admin.get(`/api/projects/${project.id}/files?path=03_Doku`);
    expect(list.entries.map((e: any) => e.name)).toEqual(['extern.pdf', 'Plan.txt']);
    expect(list.entries[0].id).toBeTruthy();
    await admin.post(`/api/projects/${project.id}/files/move`, { from: '03_Doku/extern.pdf', to: '03_Doku/Datenblatt.pdf' });
    await admin.post(`/api/projects/${project.id}/files/delete`, { path: '03_Doku/Datenblatt.pdf' });
    expect((await admin.get(`/api/projects/${project.id}/files?path=03_Doku`)).entries).toHaveLength(1);
    // Pfade außerhalb des Projektordners werden auf den Projektordner begrenzt
    const clamped = await admin.get(`/api/projects/${project.id}/files?path=../../`);
    expect(clamped.path).toBe('');
  });

  it('Teilen-Link mit Passwort, Anforderungslink ohne Konto', async () => {
    const share = await admin.post(`/api/projects/${project.id}/links`, { kind: 'share', folderPath: '03_Doku', password: 'geheim', label: 'Doku' });
    const anon = new Client(env.app);
    const info = await anon.get(`/api/public/links/${share.token}`);
    expect(info.needsPassword).toBe(true);
    await anon.req('GET', `/api/public/links/${share.token}/files`, undefined, 401);
    const r = await env.app.inject({ url: `/api/public/links/${share.token}/files`, headers: { 'x-link-password': 'geheim' } });
    expect(JSON.parse(r.body).entries[0].name).toBe('Plan.txt');
    const dl = await env.app.inject({ url: `/api/public/links/${share.token}/download?path=Plan.txt&pw=geheim` });
    expect(dl.body).toBe('version 2');
    await env.app.inject({ url: `/api/public/links/${share.token}/download?path=../../../etc/passwd&pw=geheim` }).then((x) => expect(x.statusCode).toBe(404));

    const req = await admin.post(`/api/projects/${project.id}/links`, { kind: 'request', folderPath: '03_Doku/Lieferant', label: 'Datenblätter' });
    const up = await uploadFiles(env.app, `/api/public/links/${req.token}/upload`, [{ name: 'Motor.step', content: 'STEP' }], '', { 'x-uploader-name': 'Firma Y' });
    expect(up.body.files).toEqual(['Motor.step']);
    const list = await admin.get(`/api/projects/${project.id}/files?path=03_Doku/Lieferant`);
    expect(list.entries[0].uploadedVia).toBe('Anforderungslink: Firma Y');
    const links = await admin.get(`/api/projects/${project.id}/links`);
    await admin.del(`/api/links/${links[0].id}`);
    await anon.req('GET', `/api/public/links/${links[0].token}`, undefined, 404);
  });

  it('Scan-Assistent bindet Bestandsordner ein', async () => {
    await mkdir(env.ctx.storage.abs('Altbestand/4711 Alte Presse/CAD'), { recursive: true });
    await writeFile(env.ctx.storage.abs('Altbestand/4711 Alte Presse/CAD/teil.sldprt'), 'x');
    const scan = await admin.get('/api/storage/scan?path=Altbestand');
    expect(scan.entries[0].suggestion).toEqual({ number: '4711', name: 'Alte Presse' });
    const r = await admin.post('/api/storage/import', { path: scan.entries[0].path, name: 'Alte Presse', number: '4711', rename: true });
    expect(r.folderPath).toBe('Altbestand/4711_Alte_Presse');
    expect(r.files).toBe(1);
    const list = await admin.get(`/api/projects/${r.id}/files`);
    expect(list.entries.map((e: any) => e.name)).toContain('01_CAD');
  });
});
