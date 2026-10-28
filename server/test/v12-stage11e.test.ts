import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); await admin.post('/api/apps/board/install', {}); });
afterAll(async () => { await env.close(); });

async function uploadAs(c: Client, name: string, content: string) {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  const res = new Response(fd);
  const r = await env.app.inject({ method: 'POST', url: '/api/board/uploads', payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')!, cookie: c.cookie } });
  return JSON.parse(r.body);
}

describe('Schwarzes Brett', () => {
  it('Mitteilung mit Lesebestätigung, Team-Zielgruppe, Anhang, Kommentar', async () => {
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.board');
    const { client: max } = await userClient(env.app, admin, 'max.board');
    const team = await admin.post('/api/teams', { name: 'Werkstatt' });
    await admin.put(`/api/teams/${team.id}/members`, { members: [{ userId: lisaId, isLead: false }] }).catch(() => admin.post(`/api/teams/${team.id}/members`, { userId: lisaId }));

    const att = await uploadAs(admin, 'Fluchtplan.pdf', '%PDF');
    const p = await admin.post('/api/board/posts', { title: 'Neue Brandschutzordnung', body: 'Bitte lesen und bestätigen.', category: 'Arbeitssicherheit', important: true, pinned: true, attachments: att });
    const w = await admin.post('/api/board/posts', { title: 'Werkstatt: neue Absaugung', teamIds: [team.id] });

    expect((await lisa.get('/api/board/unread')).important).toBe(1);
    expect((await lisa.get('/api/notifications'))[0].title).toBe('Bitte lesen: Neue Brandschutzordnung');
    const listLisa = await lisa.get('/api/board/posts');
    expect(listLisa.map((x: any) => x.title)).toEqual(['Neue Brandschutzordnung', 'Werkstatt: neue Absaugung']);
    const listMax = await max.get('/api/board/posts');
    expect(listMax.map((x: any) => x.id)).not.toContain(w.id);
    await max.req('GET', `/api/board/posts/${w.id}`, undefined, 404);

    const detail = await lisa.get(`/api/board/posts/${p.id}`);
    expect(detail.attachments[0].path).toMatch(/^\.aperio\/board\/posts\//);
    const file = await env.app.inject({ method: 'GET', url: `/api/board/file?path=${encodeURIComponent(detail.attachments[0].path)}`, headers: { cookie: lisa.cookie } });
    expect(file.body).toBe('%PDF');
    expect((await lisa.get('/api/board/unread')).important).toBe(1); // gelesen, aber noch nicht bestätigt
    await lisa.post(`/api/board/posts/${p.id}/confirm`, {});
    expect((await lisa.get('/api/board/unread')).important).toBe(0);
    const reads = await admin.get(`/api/board/posts/${p.id}/reads`);
    expect(reads.find((r: any) => r.id === lisaId).confirmedAt).toBeTruthy();
    await lisa.post(`/api/board/posts/${p.id}/like`, {});
    await lisa.post(`/api/comments/board_post/${p.id}`, { body: 'Erledigt' });
    const again = await admin.get(`/api/board/posts/${p.id}`);
    expect(again).toMatchObject({ likes: 1, comments: 1 });

    // Mitarbeiter dürfen kein „Bitte lesen“ setzen
    await lisa.req('POST', '/api/board/posts', { title: 'X', important: true }, 403);
    const own = await lisa.post('/api/board/posts', { title: 'Fundsache: Schlüsselbund', category: 'Gesucht und gefunden', expiresAt: '2000-01-01' });
    expect((await lisa.get('/api/board/posts')).map((x: any) => x.id)).not.toContain(own.id);
    expect((await lisa.get('/api/board/posts?archive=1')).map((x: any) => x.id)).toContain(own.id);
    await max.req('DELETE', `/api/board/posts/${own.id}`, undefined, 403);
  });

  it('Marktplatz: anbieten, merken, Interesse per Chat, reservieren, verkauft', async () => {
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.market');
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.market');
    const img = await uploadAs(lisa, 'fahrrad.jpg', 'JPEGDATA');
    const it1 = await lisa.post('/api/board/market', { title: 'Kinderfahrrad 20 Zoll', price: 80, priceType: 'negotiable', category: 'Kinder', images: img });
    await lisa.req('POST', '/api/board/market', { title: 'Firmenlaptops', company: true, priceType: 'free' }, 403);
    const comp = await admin.post('/api/board/market', { title: 'Ausgemusterte Monitore', company: true, priceType: 'free', category: 'Firmen-Restposten' });

    expect((await max.get('/api/board/market?free=1')).map((x: any) => x.id)).toEqual([comp.id]);
    await max.post(`/api/board/market/${it1.id}/watch`, {});
    const c = await max.post(`/api/board/market/${it1.id}/contact`, { message: 'Ist das Fahrrad noch da?' });
    expect(c.channelId).toBeTruthy();
    const msgs = await lisa.get(`/api/chat/channels/${c.channelId}/messages`);
    expect(msgs[0].body).toContain('Ist das Fahrrad noch da?');

    await lisa.patch(`/api/board/market/${it1.id}`, { status: 'reserved', reservedFor: maxId });
    const n = await max.get('/api/notifications');
    expect(n.map((x: any) => x.title)).toContain('Für Sie reserviert: „Kinderfahrrad 20 Zoll“');
    await max.req('PATCH', `/api/board/market/${it1.id}`, { status: 'sold' }, 403);
    await lisa.patch(`/api/board/market/${it1.id}`, { status: 'sold' });
    expect((await max.get('/api/board/market')).map((x: any) => x.id)).not.toContain(it1.id);
    expect((await lisa.get('/api/board/market?mine=1'))[0]).toMatchObject({ status: 'sold', watchers: 1 });
    void lisaId;
  });
});
