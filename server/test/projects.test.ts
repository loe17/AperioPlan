import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { adminClient, setup, userClient, type Client, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('Projekte und Nummerierung', () => {
  it('vergibt 0100, 0200 und Teilprojekte 0100-A/B mit Ordnerstruktur', async () => {
    const p1 = await admin.post('/api/projects', { name: 'Verpackungsanlage' });
    const p2 = await admin.post('/api/projects', { name: 'Maschine X' });
    expect(p1.number).toBe('0100');
    expect(p2.number).toBe('0200');
    const a = await admin.post('/api/projects', { name: 'Zuführung', parentId: p1.id });
    const b = await admin.post('/api/projects', { name: 'Steuerungsschrank', parentId: p1.id });
    expect(a.number).toBe('0100-A');
    expect(b.number).toBe('0100-B');
    expect(a.folderPath).toBe('Projekte/0100_Verpackungsanlage/0100-A_Zufuehrung');
    expect(existsSync(env.ctx.storage.abs(`${p1.folderPath}/01_CAD`))).toBe(true);
    const detail = await admin.get(`/api/projects/${p1.id}`);
    expect(detail.children).toHaveLength(2);
    const doc = await admin.post(`/api/projects/${p1.id}/documents`, { title: 'Projektplan' });
    expect(doc.number).toBe('0100-DOK-001');
  });

  it('Jahresformat PRJ-2026-0001', async () => {
    await admin.put('/api/settings/projectNumbers', { format: 'year' });
    const p = await admin.post('/api/projects', { name: 'Jahresprojekt' });
    expect(p.number).toBe(`PRJ-${new Date().getFullYear()}-0001`);
    await admin.put('/api/settings/projectNumbers', { format: 'sequential' });
  });

  it('Aufgaben, Status, Abhängigkeiten, Sichtbarkeit', async () => {
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa');
    const p = await admin.post('/api/projects', { name: 'Geheim', visibility: 'members' });
    await lisa.get(`/api/projects/${p.id}`, 404);
    const t1 = await admin.post(`/api/projects/${p.id}/tasks`, { title: 'Rahmen zeichnen', assigneeId: lisaId });
    const t2 = await admin.post(`/api/projects/${p.id}/tasks`, { title: 'Motorhalterung' });
    expect([t1.number, t2.number]).toEqual([1, 2]);
    await admin.put(`/api/tasks/${t2.id}/dependencies`, { dependsOn: [t1.id] });
    await admin.put(`/api/tasks/${t1.id}/dependencies`, { dependsOn: [t2.id] }, 400);
    const done = await admin.patch(`/api/tasks/${t1.id}`, { status: 'done' });
    expect(done.completedAt).toBeTruthy();
    const notes = await lisa.get('/api/notifications');
    expect(notes[0].kind).toBe('task.assigned');
    await admin.post(`/api/comments/task/${t1.id}`, { body: 'Bitte prüfen @lisa' });
    expect((await lisa.get('/api/notifications')).some((n: any) => n.kind === 'mention')).toBe(true);
    const search = await admin.get('/api/search?q=Rahmen');
    expect(search.tasks[0].title).toBe('Rahmen zeichnen');
  });
});

describe('Teilaktualisierung', () => {
  it('PATCH setzt nicht mitgeschickte Felder nicht zurück', async () => {
    const p = await admin.post('/api/projects', { name: 'Patch', description: 'Beschreibung', customer: 'Kunde A' });
    const t = await admin.post(`/api/projects/${p.id}/tasks`, { title: 'T', description: 'Text', priority: 'high', estimateHours: 3 });
    const r = await admin.patch(`/api/tasks/${t.id}`, { status: 'in_progress' });
    expect([r.description, r.priority, r.estimateHours]).toEqual(['Text', 'high', 3]);
    await admin.patch(`/api/projects/${p.id}`, { status: 'paused' });
    const d = await admin.get(`/api/projects/${p.id}`);
    expect([d.description, d.customer, d.visibility]).toEqual(['Beschreibung', 'Kunde A', 'company']);
  });
});
