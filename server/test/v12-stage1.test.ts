import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, setup, userClient, type Client, type TestEnv } from './helpers';
import { fillOfficeTemplate, readZip, writeZip } from '../src/lib/zip';
import { BUILTIN_TEMPLATES } from '../src/services/officeTemplates';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('ZIP und Office-Vorlagen', () => {
  it('liest und schreibt ZIP-Archive verlustfrei', () => {
    const z = writeZip([{ name: 'mimetype', data: Buffer.from('application/test'), store: true }, { name: 'a/b.xml', data: Buffer.from('<x>{{Titel}}</x>'.repeat(50)) }]);
    const back = readZip(z);
    expect(back.map((e) => e.name)).toEqual(['mimetype', 'a/b.xml']);
    expect(back[1]!.data.toString()).toContain('{{Titel}}');
  });
  it('füllt Platzhalter, auch wenn Word sie in mehrere Abschnitte teilt', () => {
    const split = writeZip([{ name: 'word/document.xml', data: Buffer.from('<w:t>{{Ti</w:t></w:r><w:r><w:t>tel}} &amp; {{Kunde}}</w:t>') }]);
    const out = readZip(fillOfficeTemplate(split, { Titel: 'Abnahme <1>', Kunde: 'Muster GmbH' }))[0]!.data.toString();
    expect(out).toContain('Abnahme &lt;1&gt;');
    expect(out).toContain('Muster GmbH');
    expect(out).not.toContain('{{');
  });
  it('mitgelieferte Vorlagen sind gültige Office-Archive', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const names = readZip(t.build()).map((e) => e.name);
      expect(names).toContain('[Content_Types].xml');
    }
  });
});

describe('Dokumentenregister', () => {
  it('legt ein Dokument aus einer Vorlage an und führt Version und Status', async () => {
    const p = await admin.post('/api/projects', { name: 'Register', customer: 'Beispiel AG' });
    const templates = await admin.get('/api/document-templates');
    const protokoll = templates.find((t: any) => t.builtinKey === 'protokoll');
    expect(protokoll).toBeTruthy();
    const d = await admin.post(`/api/projects/${p.id}/documents`, { title: 'Kickoff', kind: 'Protokoll', templateId: protokoll.id });
    expect(d.number).toBe(`${p.number}-DOK-001`);
    const [doc] = await admin.get(`/api/projects/${p.id}/documents`);
    expect(doc.fileName).toBe(`${p.number}-DOK-001_Kickoff.docx`);
    expect(doc.filePath).toContain('/03_Doku/');
    const file = await admin.req('GET', `/api/files/${doc.fileId}/download`);
    expect(file.status).toBe(200);
    await admin.patch(`/api/documents/${doc.id}`, { status: 'released' });
    const v2 = await admin.patch(`/api/documents/${doc.id}`, { newVersion: true });
    expect(v2).toMatchObject({ version: 2, status: 'draft' });
  });
  it('nur Administratoren verwalten Vorlagen; mitgelieferte sind nicht löschbar', async () => {
    const { client: lisa } = await userClient(env.app, admin, 'vorlagen-lisa');
    const [t] = await admin.get('/api/document-templates');
    await lisa.req('PATCH', `/api/document-templates/${t.id}`, { active: false }, 403);
    await admin.req('DELETE', `/api/document-templates/${t.id}`, undefined, 400);
  });
});

describe('Aufgaben: Benachrichtigen', () => {
  it('Beobachter und gezielt benachrichtigte Personen erhalten Kommentare', async () => {
    const { client: tom, id: tomId } = await userClient(env.app, admin, 'notify-tom');
    const { client: eva, id: evaId } = await userClient(env.app, admin, 'notify-eva');
    const p = await admin.post('/api/projects', { name: 'Benachrichtigung' });
    const t = await admin.post(`/api/projects/${p.id}/tasks`, { title: 'Rahmen' });
    const w = await admin.put(`/api/tasks/${t.id}/watchers`, { userIds: [tomId] });
    expect(w.watchers).toEqual([tomId]);
    await admin.post(`/api/comments/task/${t.id}`, { body: 'Bitte prüfen', notify: [evaId] });
    await admin.post(`/api/comments/task/${t.id}`, { body: 'Hallo @notify-eva' });
    const tomN = await tom.get('/api/notifications');
    const evaN = await eva.get('/api/notifications');
    expect(tomN.some((n: any) => n.title.includes('Kommentar zu'))).toBe(true);
    expect(evaN.filter((n: any) => n.title.includes('erwähnt')).length).toBeGreaterThanOrEqual(2);
    await admin.patch(`/api/tasks/${t.id}`, { status: 'in_progress' });
    expect((await tom.get('/api/notifications')).some((n: any) => n.title.includes('In Arbeit'))).toBe(true);
  });
});
