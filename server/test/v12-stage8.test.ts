import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminClient, Client, setup, uploadFiles, type TestEnv } from './helpers';
import { callAi, listModels } from '../src/routes/ai';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('Mehrere Speicherorte', () => {
  it('Projekt im Speicherort der Abteilung, Verschieben ins Archiv mit allen Verweisen', async () => {
    const nas = await mkdtemp(join(tmpdir(), 'aperio-nas-'));
    const archive = await mkdtemp(join(tmpdir(), 'aperio-archiv-'));
    const team = await admin.post('/api/teams', { name: 'Konstruktion NAS' });
    const st = (await admin.get('/api/settings')).storage;
    await admin.put('/api/settings/storage', { ...st, locations: [
      { id: 'nas', name: 'NAS Konstruktion', path: nas, networkPath: '\\\\nas01\\konstruktion', teamIds: [team.id], archive: false },
      { id: 'archiv', name: 'Archiv', path: archive, networkPath: '', teamIds: [], archive: true },
    ] });
    const p = await admin.post('/api/projects', { name: 'NAS-Projekt', teamId: team.id });
    expect(p.folderPath).toMatch(/^@nas\/Projekte\//);
    const up = await uploadFiles(env.app, `/api/projects/${p.id}/files/upload?path=01_CAD`, [{ name: 'a.txt', content: 'Hallo' }], admin.cookie);
    expect(up.status).toBe(200);
    const detail = await admin.get(`/api/projects/${p.id}`);
    expect(detail.storageLocation).toBe('nas');
    expect(detail.networkPath).toMatch(/^\\\\nas01\\konstruktion\\Projekte\\/);
    const locs = await admin.get('/api/storage/locations');
    expect(locs.find((l: any) => l.id === 'nas').projects).toBe(1);
    expect(locs.find((l: any) => l.id === 'nas').space.total).toBeGreaterThan(0);

    const mv = await admin.post(`/api/projects/${p.id}/move-storage`, { locationId: 'archiv' });
    expect(mv.folderPath).toMatch(/^@archiv\/Projekte\//);
    const files = await admin.get(`/api/projects/${p.id}/files?path=01_CAD`);
    const f = files.entries?.find?.((e: any) => e.name === 'a.txt') ?? files.find?.((e: any) => e.name === 'a.txt');
    expect(f).toBeTruthy();
    const [row] = await env.ctx.sql<{ path: string }[]>`select path from files where name = 'a.txt'`;
    expect(row!.path.startsWith('@archiv/')).toBe(true);
    expect(await readFile(env.ctx.storage.abs(row!.path), 'utf8')).toBe('Hallo');
    expect(existsSync(join(nas, 'Projekte'))).toBe(true);
  });
});

describe('Ordnerstruktur mit Unterordnern', () => {
  it('legt Unterordner an und ignoriert unzulässige Pfade', async () => {
    const st = (await admin.get('/api/settings')).storage;
    await admin.put('/api/settings/storage', { ...st, locations: [], defaultLocation: 'main', projectFolders: ['01_CAD', '01_CAD/Teile', '02_Zeichnungen/Freigegeben', '../ausbruch'] });
    const p = await admin.post('/api/projects', { name: 'Unterordner' });
    expect(existsSync(env.ctx.storage.abs(`${p.folderPath}/01_CAD/Teile`))).toBe(true);
    expect(existsSync(env.ctx.storage.abs(`${p.folderPath}/02_Zeichnungen/Freigegeben`))).toBe(true);
    expect(existsSync(env.ctx.storage.abs(`${p.folderPath}/ausbruch`))).toBe(true);
    expect(existsSync(env.ctx.storage.abs(`${p.folderPath}/../ausbruch`))).toBe(false);
    await admin.put('/api/settings/storage', st);
  });
});

describe('Neues Office-Dokument im Projektordner', () => {
  it('legt ein leeres Word-Dokument an', async () => {
    const p = await admin.post('/api/projects', { name: 'Doku' });
    const r = await admin.post(`/api/projects/${p.id}/files/new-document`, { folder: '03_Doku', name: 'Besprechung', kind: 'docx' });
    expect(r.name).toBe('Besprechung.docx');
    await admin.req('POST', `/api/projects/${p.id}/files/new-document`, { folder: '03_Doku', name: 'Besprechung', kind: 'docx' }, 400);
  });
});

describe('KI mit Online-Anbietern', () => {
  let server: Server; let base = '';
  const seen: { url: string; headers: Record<string, unknown>; body: any }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url!, headers: req.headers, body: body ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (req.url!.includes(':generateContent')) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hallo von Gemini' }] } }] }));
        if (req.url!.startsWith('/models?')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }));
        if (req.url!.includes('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'Hallo von OpenAI' } }] }));
        res.statusCode = 404; res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  it('Gemini, Azure und Modellliste', async () => {
    const g = { id: 'g', name: 'Gemini', kind: 'gemini' as const, baseUrl: base, apiKey: 'k1', model: 'gemini-x', online: true };
    expect(await callAi(g, [{ role: 'system', content: 'Sei kurz' }, { role: 'user', content: 'Hallo' }])).toBe('Hallo von Gemini');
    const last = seen[seen.length - 1]!;
    expect(last.headers['x-goog-api-key']).toBe('k1');
    expect(last.body.systemInstruction.parts[0].text).toBe('Sei kurz');
    expect(await listModels(g)).toEqual(['gemini-x']);
    const az = { id: 'a', name: 'Azure', kind: 'azure' as const, baseUrl: base, apiKey: 'k2', model: '', deployment: 'gpt4', online: true };
    expect(await callAi(az, [{ role: 'user', content: 'x' }])).toBe('Hallo von OpenAI');
    expect(seen[seen.length - 1]!.url).toMatch(/\/openai\/deployments\/gpt4\/chat\/completions\?api-version=/);
    expect(seen[seen.length - 1]!.headers['api-key']).toBe('k2');
  });

  it('Projekt mit eigenem Anbieter, Schlüssel bleiben verborgen', async () => {
    await admin.put('/api/settings/ai', { enabled: true, defaultProviderId: 'online', providers: [
      { id: 'online', name: 'Gemini', kind: 'gemini', baseUrl: base, apiKey: 'geheim', model: 'gemini-x', online: true },
      { id: 'lokal', name: 'Ollama', kind: 'ollama', baseUrl: base, apiKey: '', model: 'llama', online: false },
    ] });
    const s = await admin.get('/api/settings');
    expect(s.ai.providers[0].apiKey).toBe('••••••••');
    await admin.put('/api/settings/ai', { ...s.ai });
    expect((await env.ctx.settings.get('ai')).providers[0]!.apiKey).toBe('geheim');
    const p = await admin.post('/api/projects', { name: 'Vertraulich' });
    await admin.patch(`/api/projects/${p.id}`, { aiProviderId: 'lokal' });
    const r = await admin.post('/api/ai/chat', { projectId: p.id, prompt: 'Zusammenfassen' });
    expect(r).toMatchObject({ answer: 'Hallo von OpenAI', provider: { id: 'lokal', online: false } });
    const r2 = await admin.post('/api/ai/chat', { prompt: 'Hallo' });
    expect(r2.provider.id).toBe('online');
  });
});

describe('Änderungsprotokoll herunterladen', () => {
  it('Excel, CSV und PDF mit gleicher Prüfsumme', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const sum = await admin.get(`/api/audit/export?format=checksum&from=${today}&to=${today}`);
    expect(sum.checksum).toMatch(/^[0-9a-f]{64}$/);
    for (const f of ['xlsx', 'csv', 'pdf']) {
      const r = await admin.req('GET', `/api/audit/export?format=${f}&from=${today}&to=${today}`);
      expect(r.status).toBe(200);
      expect(r.headers['x-checksum']).toBe(sum.checksum);
    }
    const again = await admin.get(`/api/audit/export?format=checksum&from=${today}&to=${today}`);
    expect(again.checksum).toBe(sum.checksum);
  });
});

describe('Persönliches Postfach', () => {
  it('schlägt Server vor und verlangt ein Konto', async () => {
    expect((await admin.get('/api/mailbox/preset?email=max@gmx.de')).imapHost).toBe('imap.gmx.net');
    expect(await admin.get('/api/mailbox/account')).toBeNull();
    await admin.req('GET', '/api/mailbox/folders', undefined, 400);
    const r = await admin.req('PUT', '/api/mailbox/account', { email: 'max@example.invalid', imapHost: '127.0.0.1', imapPort: 1, smtpHost: '127.0.0.1', smtpPort: 1, username: 'max', password: 'x', imapSecure: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/IMAP/);
  });
});
void writeFile;
