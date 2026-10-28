import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); await admin.post('/api/apps/knowledge/install', {}); });
afterAll(async () => { await env.close(); });

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const anon = async (url: string) => { const r = await env.app.inject({ method: 'GET', url }); return { status: r.statusCode, body: r.body.startsWith('{') ? JSON.parse(r.body) : r.body }; };

describe('Wissensdatenbank', () => {
  it('Bereiche, Unterseiten, Vorlagen, Suche, Sperre, Versionen', async () => {
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.kb');
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.kb');
    const { client: gast } = await userClient(env.app, admin, 'gast.kb', 'guest');

    const handbuch = await admin.post('/api/knowledge/articles', { title: 'Werkstatt-Handbuch', icon: 'factory' });
    const anw = await lisa.post('/api/knowledge/articles', { parentId: handbuch.id, template: 'instruction', title: 'Drehmaschine einrichten' });
    const a = await max.get(`/api/knowledge/articles/${anw.id}`);
    expect(a).toMatchObject({ title: 'Drehmaschine einrichten', icon: 'wrench', scope: 'workspace', canEdit: true });
    expect(a.path.map((x: any) => x.title)).toEqual(['Werkstatt-Handbuch']);
    expect(a.content.content[0]).toMatchObject({ type: 'heading' });
    await gast.req('GET', '/api/knowledge/tree', undefined, 403);

    // Speichern + Suche
    const s1 = await max.patch(`/api/knowledge/articles/${anw.id}`, { content: doc('Spannfutter mit 80 Nm anziehen.'), baseUpdatedAt: a.updatedAt });
    expect((await lisa.get('/api/knowledge/search?q=spannfutter'))[0]).toMatchObject({ id: anw.id, title: 'Drehmaschine einrichten' });
    expect((await lisa.get('/api/search?q=Spannfutter')).knowledge.map((x: any) => x.id)).toEqual([anw.id]);
    // veralteter Stand von jemand anderem -> 409
    const stale = await lisa.req('PATCH', `/api/knowledge/articles/${anw.id}`, { content: doc('alt'), baseUpdatedAt: a.updatedAt });
    expect(stale.status).toBe(409);
    await lisa.patch(`/api/knowledge/articles/${anw.id}`, { content: doc('Spannfutter mit 90 Nm anziehen.'), baseUpdatedAt: s1.updatedAt });
    const versions = await lisa.get(`/api/knowledge/articles/${anw.id}/versions`);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const v = versions.find((x: any) => x.userName === 'MAX.KB');
    const old = await lisa.get(`/api/knowledge/articles/${anw.id}/versions/${v.id}`);
    expect(JSON.stringify(old.content)).toContain('80 Nm');
    await lisa.post(`/api/knowledge/articles/${anw.id}/versions/${v.id}/restore`, {});
    expect(JSON.stringify((await max.get(`/api/knowledge/articles/${anw.id}`)).content)).toContain('80 Nm');

    // Sperren: nur Autor/Teamleiter/Admin
    await max.req('PATCH', `/api/knowledge/articles/${handbuch.id}`, { locked: true }, 403);
    await admin.patch(`/api/knowledge/articles/${handbuch.id}`, { locked: true });
    expect((await max.get(`/api/knowledge/articles/${anw.id}`)).canEdit).toBe(false);
    await max.req('PATCH', `/api/knowledge/articles/${anw.id}`, { content: doc('x') }, 403);
    await lisa.patch(`/api/knowledge/articles/${anw.id}`, { title: 'Drehmaschine einrichten (CNC)' }); // Autorin des Unterartikels
    await admin.patch(`/api/knowledge/articles/${handbuch.id}`, { locked: false });

    // Kommentare
    await max.post(`/api/comments/kb_article/${anw.id}`, { body: 'Danke!' });
    expect((await lisa.get(`/api/comments/kb_article/${anw.id}`))[0].body).toBe('Danke!');

    // Privat -> nur Autorin; teilen -> Max darf lesen
    const priv = await lisa.post('/api/knowledge/articles', { scope: 'private', title: 'Meine Notizen' });
    await max.req('GET', `/api/knowledge/articles/${priv.id}`, undefined, 404);
    expect((await max.get('/api/knowledge/tree')).map((x: any) => x.id)).not.toContain(priv.id);
    await lisa.put(`/api/knowledge/articles/${priv.id}/members`, { members: [{ userId: maxId, permission: 'read' }] });
    const shared = await max.get(`/api/knowledge/articles/${priv.id}`);
    expect(shared).toMatchObject({ scope: 'shared', canEdit: false });
    await max.req('POST', '/api/knowledge/articles', { parentId: priv.id, title: 'X' }, 403);
    const child = await lisa.post('/api/knowledge/articles', { parentId: priv.id, title: 'Unterseite' });
    expect((await max.get(`/api/knowledge/articles/${child.id}`)).scope).toBe('shared');

    // Verschieben: Kreis verhindern, Bereich wechseln
    await lisa.req('POST', `/api/knowledge/articles/${priv.id}/move`, { parentId: child.id }, 400);
    await lisa.post(`/api/knowledge/articles/${priv.id}/move`, { parentId: handbuch.id });
    expect((await lisa.get(`/api/knowledge/articles/${child.id}`)).scope).toBe('workspace');

    // Favoriten, Papierkorb
    await max.put(`/api/knowledge/articles/${anw.id}/favorite`, {});
    expect((await max.get('/api/knowledge/tree')).find((x: any) => x.id === anw.id).favorite).toBe(true);
    await lisa.del(`/api/knowledge/articles/${priv.id}`);
    expect((await max.get('/api/knowledge/tree')).map((x: any) => x.id)).not.toContain(child.id);
    const trash = await lisa.get('/api/knowledge/trash');
    expect(trash.map((x: any) => x.id)).toEqual([priv.id]);
    await lisa.post(`/api/knowledge/articles/${priv.id}/restore`, {});
    expect((await max.get('/api/knowledge/tree')).map((x: any) => x.id)).toContain(child.id);
    void lisaId;
  });

  it('öffentlicher Link mit Bild', async () => {
    const a = await admin.post('/api/knowledge/articles', { title: 'Anfahrt' });
    const fd = new FormData();
    fd.append('file', new Blob(['PNGDATA']), 'karte.png');
    const resp = new Response(fd);
    const up = await env.app.inject({ method: 'POST', url: `/api/knowledge/uploads?articleId=${a.id}`, payload: Buffer.from(await resp.arrayBuffer()), headers: { 'content-type': resp.headers.get('content-type')!, cookie: admin.cookie } });
    const [img] = JSON.parse(up.body);
    await admin.patch(`/api/knowledge/articles/${a.id}`, { content: { type: 'doc', content: [{ type: 'image', attrs: { src: img.url } }] } });
    const { publicUrl } = await admin.post(`/api/knowledge/articles/${a.id}/public`, { enabled: true });
    const token = publicUrl.split('/').pop();
    const pub = await anon(`/api/kb/${token}`);
    expect(pub.body.title).toBe('Anfahrt');
    const src = pub.body.content.content[0].attrs.src as string;
    expect(src.startsWith(`/api/kb/${token}/file?path=`)).toBe(true);
    expect((await anon(src)).body).toBe('PNGDATA');
    // fremde Datei über den Link nicht abrufbar
    const other = await admin.post('/api/knowledge/articles', { title: 'Intern' });
    expect((await anon(`/api/kb/${token}/file?path=${encodeURIComponent(`.aperio/knowledge/${other.id}/x_y.png`)}`)).status).toBe(404);
    await admin.post(`/api/knowledge/articles/${a.id}/public`, { enabled: false });
    expect((await anon(`/api/kb/${token}`)).status).toBe(404);
  });
});
