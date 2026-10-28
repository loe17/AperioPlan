import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { endCallIfEmpty } from '../src/services/calls';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('Gruppenchats und Reaktionen', () => {
  it('Gruppe anlegen, nur Mitglieder lesen, Reaktion umschalten', async () => {
    const { client: anna, id: annaId } = await userClient(env.app, admin, 'grp-anna');
    const { client: ben } = await userClient(env.app, admin, 'grp-ben');
    const g = await anna.post('/api/chat/groups', { name: 'Messe', memberIds: [] });
    await ben.req('GET', `/api/chat/channels/${g.id}/messages`, undefined, 403);
    const users = await admin.get('/api/users');
    const benId = users.find((u: any) => u.username === 'grp-ben').id;
    await anna.req('PATCH', `/api/chat/groups/${g.id}`, { memberIds: [benId] });
    const m = await ben.post(`/api/chat/channels/${g.id}/messages`, { body: 'Hallo Gruppe' });
    const r1 = await anna.post(`/api/chat/messages/${m.id}/reactions`, { emoji: '👍' });
    expect(r1.reactions).toEqual([{ emoji: '👍', userId: annaId }]);
    const r2 = await anna.post(`/api/chat/messages/${m.id}/reactions`, { emoji: '👍' });
    expect(r2.reactions).toEqual([]);
    // nur der Ersteller verwaltet
    await ben.req('PATCH', `/api/chat/groups/${g.id}`, { name: 'Gekapert' }, 403);
    await ben.post(`/api/chat/groups/${g.id}/leave`, {});
    await ben.req('GET', `/api/chat/channels/${g.id}/messages`, undefined, 403);
  });
});

describe('Anrufverlauf', () => {
  it('Nachrichten im Anruf landen gesammelt unter dem Verlaufseintrag', async () => {
    const { client: anna } = await userClient(env.app, admin, 'call-anna');
    const users = await admin.get('/api/users');
    const benId = users.find((u: any) => u.username === 'grp-ben').id;
    const dm = await anna.post('/api/chat/direct', { userId: benId });
    const call = await anna.post(`/api/chat/channels/${dm.id}/call`, {});
    await anna.post(`/api/chat/channels/${dm.id}/messages`, { body: 'im Anruf', callId: call.callId });
    await anna.post(`/api/chat/channels/${dm.id}/messages`, { body: 'normal' });
    await endCallIfEmpty(env.ctx, dm.id, true);
    const list = await anna.get(`/api/chat/channels/${dm.id}/messages`);
    expect(list.map((m: any) => m.body)).not.toContain('im Anruf');
    const entry = list.find((m: any) => m.kind === 'call');
    expect(entry.meta.messageCount).toBe(1);
    const inCall = await anna.get(`/api/chat/calls/${call.callId}/messages`);
    expect(inCall.map((m: any) => m.body)).toEqual(['im Anruf']);
  });
});
