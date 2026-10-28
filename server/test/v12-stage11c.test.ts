import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { normalizeNumber, parseFritzLine } from '../src/services/phone';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); await admin.post('/api/apps/phone/install', {}); });
afterAll(async () => { await env.close(); });

const S = { countryCode: '49', areaCode: '771', outsideLinePrefix: '0' };

describe('Rufnummern', () => {
  it('vereinheitlicht deutsche und internationale Schreibweisen', () => {
    expect(normalizeNumber('+49 (0)771 123-45', { ...S, outsideLinePrefix: '' })).toBe('4977112345');
    expect(normalizeNumber('+49 771 12345', S)).toBe('4977112345');
    expect(normalizeNumber('0771/12345', { ...S, outsideLinePrefix: '' })).toBe('4977112345');
    expect(normalizeNumber('00433161234', { ...S, outsideLinePrefix: '' })).toBe('433161234');
    expect(normalizeNumber('12345', S)).toBe('4977112345');
    expect(normalizeNumber('21', S)).toBe('21');
    expect(normalizeNumber('anonymous', S)).toBe('');
    expect(parseFritzLine('28.10.26 13:45:01;RING;0;01701234567;7712345;SIP0;', 'x')).toMatchObject({ type: 'ring', callId: 'x:0', from: '01701234567', to: '7712345' });
    expect(parseFritzLine('28.10.26 13:45:09;CONNECT;0;11;01701234567;', 'x')).toMatchObject({ type: 'answer', extension: '11' });
    expect(parseFritzLine('28.10.26 13:46:30;DISCONNECT;0;81;', 'x')).toMatchObject({ type: 'hangup', duration: 81 });
  });
});

describe('Telefonie', () => {
  it('Anrufer aus dem CRM, sipgate-Ablauf, Notiz in den Kundenverlauf, verpasste Anrufe', async () => {
    await admin.put('/api/settings/phone', { provider: 'sipgate', countryCode: '49', areaCode: '771', outsideLinePrefix: '', dialMethod: 'tel', popupForAll: true });
    const acc = await admin.post('/api/crm/accounts', { name: 'Muster Maschinenbau GmbH', phone: '0771 99999-0' });
    await admin.post(`/api/crm/accounts/${acc.id}/contacts`, { firstName: 'Erika', lastName: 'Muster', phone: '+49 771 99999-12', mobile: '0170 1234567' });
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.tel');
    await admin.put(`/api/phone/admin/users/${lisaId}`, { enabled: true, extension: 'w1', numbers: ['+49 771 4444-21'] });
    const adm = await admin.get('/api/phone/admin');
    const hook = new URL(adm.hooks.sipgate).pathname;

    const lk = await lisa.get(`/api/phone/lookup?number=${encodeURIComponent('0170/1234567')}`);
    expect(lk.caller).toMatchObject({ kind: 'contact', name: 'Erika Muster', accountName: 'Muster Maschinenbau GmbH' });
    expect((await lisa.get('/api/phone/lookup?number=077199999-0')).caller).toMatchObject({ kind: 'account', accountName: 'Muster Maschinenbau GmbH' });

    const form = (o: Record<string, string>) => env.app.inject({ method: 'POST', url: hook, payload: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const r1 = await form({ event: 'newCall', direction: 'in', from: '4917012345 67'.replace(' ', ''), to: '49771444421', callId: 'abc1', 'user[]': 'Lisa', 'userId[]': 'w1' });
    expect(r1.statusCode).toBe(200);
    expect(r1.body).toContain('onAnswer=');
    await form({ event: 'answer', callId: 'abc1', userId: 'w1' });
    await form({ event: 'hangup', callId: 'abc1', cause: 'normalClearing' });
    const calls = await lisa.get('/api/phone/calls');
    expect(calls[0]).toMatchObject({ direction: 'in', status: 'ended', contactName: 'Erika Muster', userId: lisaId });

    await lisa.post(`/api/phone/calls/${calls[0].id}/note`, { body: 'Fragt nach Liefertermin Ersatzteile' });
    const notes = await admin.get(`/api/crm/accounts/${acc.id}/timeline`);
    expect(JSON.stringify(notes)).toContain('Liefertermin Ersatzteile');

    // verpasst → Benachrichtigung an die zugeordnete Person
    await form({ event: 'newCall', direction: 'in', from: '4977199999 0'.replace(' ', ''), to: '49771444421', callId: 'abc2' });
    await form({ event: 'hangup', callId: 'abc2', cause: 'cancel' });
    expect((await lisa.get('/api/phone/calls?missed=1'))[0]).toMatchObject({ status: 'missed', accountName: 'Muster Maschinenbau GmbH' });
    expect((await lisa.get('/api/notifications'))[0].title).toMatch(/Verpasster Anruf: Muster Maschinenbau/);

    // falsches Geheimnis
    expect((await env.app.inject({ method: 'POST', url: hook.replace(/[^/]+$/, 'falsch'), payload: 'event=newCall' , headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(404);
  });

  it('Placetel, allgemeine Schnittstelle, 3CX-Kontaktsuche, Softphone-Protokoll, Wählen', async () => {
    const adm = await admin.get('/api/phone/admin');
    const pt = new URL(adm.hooks.placetel).pathname;
    await env.app.inject({ method: 'POST', url: pt, payload: { event: 'OutgoingCall', from: '77144421', to: '0170 1234567', call_id: 'p1', peer: 'w1@sip' } });
    await env.app.inject({ method: 'POST', url: pt, payload: { event: 'HungUp', call_id: 'p1', type: 'busy' } });
    const all = await admin.get('/api/phone/calls?scope=all');
    expect(all.find((c: any) => c.source === 'placetel')).toMatchObject({ direction: 'out', status: 'busy', contactName: 'Erika Muster' });

    const gen = new URL(adm.hooks.generic).pathname;
    const g = await env.app.inject({ method: 'POST', url: gen, payload: { event: 'ring', callId: 'g1', from: '+43 316 1234', to: '0' } });
    expect(JSON.parse(g.body).id).toBeTruthy();
    const look = await env.app.inject({ method: 'GET', url: `${new URL(adm.hooks.threecxLookup).pathname}?number=01701234567` });
    expect(JSON.parse(look.body).contacts[0]).toMatchObject({ firstName: 'Erika', lastName: 'Muster', company: 'Muster Maschinenbau GmbH' });
    const tpl = await admin.req('GET', '/api/phone/admin/3cx-template.xml');
    expect(tpl.status).toBe(200);

    const sp = await admin.post('/api/phone/softphone-event', { type: 'call', callId: 'x1', number: '0170 1234567' });
    await admin.post('/api/phone/softphone-event', { type: 'answer', callId: 'x1' });
    await admin.post('/api/phone/softphone-event', { type: 'hangup', callId: 'x1' });
    expect((await admin.get('/api/phone/calls')).find((c: any) => c.id === sp.id)).toMatchObject({ source: 'softphone', status: 'ended', direction: 'out' });

    expect(await admin.post('/api/phone/dial', { number: '0170 1234567' })).toMatchObject({ method: 'tel', number: '+491701234567' });
    await admin.put('/api/settings/phone', { ...(await admin.get('/api/settings')).phone, dialMethod: 'softphone', outsideLinePrefix: '0' });
    expect(await admin.post('/api/phone/dial', { number: '+49 170 1234567' })).toMatchObject({ method: 'softphone', number: '001701234567' });
  });
});
