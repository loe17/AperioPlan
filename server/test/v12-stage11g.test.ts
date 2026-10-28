import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); await admin.post('/api/apps/mindmap/install', {}); });
afterAll(async () => { await env.close(); });

describe('Mindmaps', () => {
  it('anlegen, speichern mit Versionsprüfung, teilen, Rechte', async () => {
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.mind');
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.mind');
    const { id } = await lisa.post('/api/mindmaps', { title: 'Messestand 2027' });
    let m = await lisa.get(`/api/mindmaps/${id}`);
    expect(m).toMatchObject({ title: 'Messestand 2027', version: 1, canEdit: true, isOwner: true });
    expect(m.data).toEqual({ id: 'root', text: 'Messestand 2027', children: [] });

    const data = { id: 'root', text: 'Messestand 2027', children: [
      { id: 'a', text: 'Logistik', color: '#e5484d', children: [{ id: 'a1', text: 'Spedition', children: [] }] },
      { id: 'b', text: 'Werbung', collapsed: true, link: 'javascript:alert(1)', evil: 'x', children: [] },
    ] };
    const r = await lisa.put(`/api/mindmaps/${id}`, { data, version: 1 });
    expect(r.version).toBe(2);
    m = await lisa.get(`/api/mindmaps/${id}`);
    expect(m.data.children[1]).toEqual({ id: 'b', text: 'Werbung', collapsed: true, children: [] });
    expect(m.branches).toBe(2);

    // veraltete Version -> 409 mit aktuellem Stand
    const stale = await lisa.req('PUT', `/api/mindmaps/${id}`, { data, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.details.version).toBe(2);
    // doppelte IDs abgelehnt
    await lisa.req('PUT', `/api/mindmaps/${id}`, { data: { id: 'root', text: 'x', children: [{ id: 'root', text: 'y', children: [] }] }, version: 2 }, 400);

    // fremde sehen nichts
    await max.req('GET', `/api/mindmaps/${id}`, undefined, 404);
    await lisa.put(`/api/mindmaps/${id}/shares`, { shares: [{ userId: maxId, canEdit: false }] });
    expect((await max.get('/api/notifications'))[0].title).toContain('Messestand 2027');
    expect((await max.get('/api/mindmaps')).map((x: any) => x.id)).toContain(id);
    expect((await max.get(`/api/mindmaps/${id}`)).canEdit).toBe(false);
    await max.req('PUT', `/api/mindmaps/${id}`, { data, version: 2 }, 403);
    await max.req('DELETE', `/api/mindmaps/${id}`, undefined, 403);
    await lisa.put(`/api/mindmaps/${id}/shares`, { shares: [{ userId: maxId, canEdit: true }] });
    expect((await max.put(`/api/mindmaps/${id}`, { data: { ...data, text: 'Messestand Hannover' }, version: 2 })).version).toBe(3);
    expect((await lisa.get(`/api/mindmaps/${id}`)).title).toBe('Messestand Hannover');

    const copy = await max.post(`/api/mindmaps/${id}/duplicate`, {});
    expect((await max.get(`/api/mindmaps/${copy.id}`)).isOwner).toBe(true);
    void lisaId;
  });

  it('Projekt-Mindmap: alle Projektmitglieder sehen sie', async () => {
    const project = await admin.post('/api/projects', { name: 'Mind-Projekt', visibility: 'members' });
    const { client: tom } = await userClient(env.app, admin, 'tom.mind');
    const { id } = await admin.post('/api/mindmaps', { title: 'Konzept', projectId: project.id });
    expect((await admin.get(`/api/mindmaps?projectId=${project.id}`)).map((x: any) => x.id)).toEqual([id]);
    await tom.req('GET', `/api/mindmaps/${id}`, undefined, 404);
    await tom.req('POST', '/api/mindmaps', { title: 'X', projectId: project.id }, 404);
  });
});
