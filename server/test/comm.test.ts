import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { adminClient, setup, uploadFiles, userClient, type Client, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
let lisa: Client;
let lisaId: string;
let project: any;

beforeAll(async () => {
  env = await setup();
  admin = await adminClient(env.app);
  ({ client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa'));
  project = await admin.post('/api/projects', { name: 'Kommunikation' });
});
afterAll(async () => { await env.close(); });

describe('Chat', () => {
  it('Projekt-Chat, Direktnachricht, ungelesen, Anhang', async () => {
    const { id: channelId } = await admin.get(`/api/projects/${project.id}/chat`);
    await admin.post(`/api/chat/channels/${channelId}/messages`, { body: 'Hallo @lisa, bitte Zeichnung prüfen' });
    const lisaChannels = await lisa.get('/api/chat/channels');
    expect(lisaChannels.find((c: any) => c.id === channelId)).toBeUndefined(); // Lisa ist kein Projektmitglied – sieht aber die Erwähnung
    expect((await lisa.get('/api/notifications'))[0].kind).toBe('chat');
    const msgs = await lisa.get(`/api/chat/channels/${channelId}/messages`);
    expect(msgs[0].body).toContain('Zeichnung');
    const dm = await lisa.post('/api/chat/direct', { userId: (await admin.get('/api/auth/me')).id });
    const dm2 = await admin.post('/api/chat/direct', { userId: lisaId });
    expect(dm2.id).toBe(dm.id);
    await lisa.post(`/api/chat/channels/${dm.id}/messages`, { body: 'Mach ich!' });
    const ch = (await admin.get('/api/chat/channels')).find((c: any) => c.id === dm.id);
    expect(ch.unread).toBe(1);
    expect(ch.name).toBe('LISA');
    await admin.post(`/api/chat/channels/${dm.id}/read`);
    expect((await admin.get('/api/chat/channels')).find((c: any) => c.id === dm.id).unread).toBe(0);
    const up = await uploadFiles(env.app, `/api/chat/channels/${channelId}/upload`, [{ name: 'Foto.png', content: 'PNG' }], admin.cookie);
    expect(up.body[0].fileId).toBeTruthy();
    const call = await admin.post(`/api/chat/channels/${dm.id}/call`);
    expect(call.callId).toBeTruthy();
  });
});

describe('KVP-Ideenbox', () => {
  it('einreichen, Teamleitung entscheidet, Fotos', async () => {
    const team = await admin.post('/api/teams', { name: 'Montage' });
    const me = await admin.get('/api/auth/me');
    await admin.put(`/api/teams/${team.id}/members`, { members: [{ userId: me.id, isLead: true }, { userId: lisaId }] });
    const k = await lisa.post('/api/kvp', { title: 'Werkzeugwand an Station 3', description: 'Spart Laufwege', teamId: team.id, savingsEur: 4200 });
    expect(k.number).toBe(1);
    const idea = await admin.get(`/api/kvp/${k.id}`);
    expect(idea.leadName).toBe('Administrator');
    await lisa.patch(`/api/kvp/${k.id}`, { status: 'accepted' }, 403);
    await admin.patch(`/api/kvp/${k.id}`, { status: 'implemented', decisionNote: 'Super Idee' });
    const stats = await admin.get('/api/kvp/stats');
    expect(stats.savings).toBe(4200);
    expect((await lisa.get('/api/notifications')).some((n: any) => n.title.includes('Umgesetzt'))).toBe(true);
    const ph = await uploadFiles(env.app, `/api/kvp/${k.id}/photos`, [{ name: 'vorher.png', content: 'x' }], lisa.cookie);
    expect(ph.status).toBe(400); // Blob ohne Bild-MIME-Typ wird abgelehnt
  });
});

describe('KI-Anbindung', () => {
  it('fasst ein Projekt über eine OpenAI-kompatible Schnittstelle zusammen', async () => {
    let received: any = null;
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'Projekt läuft planmäßig.' } }] }));
      });
    }).listen(0);
    const port = (srv.address() as AddressInfo).port;
    await admin.put('/api/settings/ai', { enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: '' });
    await admin.post(`/api/projects/${project.id}/tasks`, { title: 'Pneumatik auslegen' });
    const r = await admin.post('/api/ai/chat', { mode: 'summarize', projectId: project.id });
    expect(r.answer).toBe('Projekt läuft planmäßig.');
    expect(received.messages[0].content).toContain('Pneumatik auslegen');
    srv.close();
  });
});

describe('Sicherung und Import mit Duplikaterkennung', () => {
  it('sichert verschlüsselt und erkennt beim Import abweichende Stände', async () => {
    const b = await admin.post('/api/backups', {});
    expect(b.file).toMatch(/\.apb$/);
    const list = await admin.get('/api/backups');
    const name = list[0].name;
    // Änderung nach der Sicherung
    await admin.patch(`/api/projects/${project.id}`, { name: 'Kommunikation NEU' });
    await admin.post(`/api/backups/${name}/analyze`, { passphrase: 'falsch' }, 400);
    const a = await admin.post(`/api/backups/${name}/analyze`, {});
    const projConflict = a.conflicts.find((c: any) => c.table === 'projects');
    expect(projConflict.newer).toBe('local');
    // Bestand behalten (neuerer Stand gewinnt)
    let r = await admin.post(`/api/backups/import/${a.id}/apply`, { strategy: 'newer' });
    expect(r.updated).toBeGreaterThanOrEqual(0);
    expect((await admin.get(`/api/projects/${project.id}`)).name).toBe('Kommunikation NEU');
    // Sicherung erzwingen
    const a2 = await admin.post(`/api/backups/${name}/analyze`, {});
    r = await admin.post(`/api/backups/import/${a2.id}/apply`, { strategy: 'newer', overrides: { [`projects:${project.id}`]: 'backup' } });
    expect((await admin.get(`/api/projects/${project.id}`)).name).toBe('Kommunikation');
  });
});

describe('Office im Browser (WOPI)', () => {
  it('liefert Datei nur mit gültigem Token', async () => {
    const up = await uploadFiles(env.app, `/api/projects/${project.id}/files/upload?path=03_Doku`, [{ name: 'Bericht.docx', content: 'DOCX' }], admin.cookie);
    const { signToken } = await import('../src/routes/office');
    const token = await signToken(env.ctx, { f: up.body[0].id, u: lisaId, n: 'Lisa', w: true, e: Date.now() + 60000 });
    const info = await env.app.inject({ url: `/api/wopi/files/${up.body[0].id}?access_token=${token}` });
    expect(JSON.parse(info.body).BaseFileName).toBe('Bericht.docx');
    const bad = await env.app.inject({ url: `/api/wopi/files/${up.body[0].id}?access_token=${token}x` });
    expect(bad.statusCode).toBe(401);
    const put = await env.app.inject({ method: 'POST', url: `/api/wopi/files/${up.body[0].id}/contents?access_token=${token}`, payload: Buffer.from('NEU'), headers: { 'content-type': 'application/octet-stream' } });
    expect(put.statusCode).toBe(200);
    const dl = await admin.req('GET', `/api/files/${up.body[0].id}/download`);
    expect(dl.body).toBe('NEU');
  });
});

describe('E-Mail senden', () => {
  it('versendet über SMTP und legt die Nachricht beim Projekt ab', async () => {
    const { SMTPServer } = await import('smtp-server');
    let received = '';
    const srv = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, _s, cb) { stream.on('data', (c) => (received += c)); stream.on('end', cb); } });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.server.address() as AddressInfo).port;
    await admin.put('/api/settings/mail', { enabled: true, smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false, user: '', password: '', from: 'projekte@firma.test', imapHost: '' });
    await admin.post('/api/mail/send', { to: 'kunde@example.com', subject: '[0100] Statusbericht', text: 'Alles im Plan.', projectId: project.id });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toContain('Statusbericht');
    expect(received).toContain('Alles im Plan.');
    const list = await admin.get(`/api/mail?projectId=${project.id}`);
    expect(list[0].direction).toBe('out');
    srv.close(() => {});
  });
});
