import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, setup, userClient, type Client, type TestEnv } from './helpers';
import { fakeAccount } from '../src/services/mailFake';
import { _test as mb } from '../src/services/mailbox';
import { cleanHtml, renderSignature } from '../src/services/mailSignature';

let env: TestEnv;
let admin: Client;
const server = { imapHost: 'mail.firma.aperio.test', imapPort: 993, imapSecure: true, smtpHost: 'mail.firma.aperio.test', smtpPort: 465, smtpSecure: true };
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

async function waitTest(c: Client, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await c.get(`/api/mailbox/setup/test/${id}`);
    if (r.done) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('Test endet nicht');
}

describe('Einrichtungsassistent', () => {
  it('erkennt Anbieter aus der Liste und schlägt sonst Server vor', async () => {
    const gmx = await admin.post('/api/mailbox/setup/discover', { email: 'x@gmx.de' });
    expect(gmx.source).toBe('list');
    expect(gmx.settings.imapHost).toBe('imap.gmx.net');
    expect(gmx.provider.hint).toMatch(/erlauben/);
    const own = await admin.post('/api/mailbox/setup/discover', { email: 'max@firma.aperio.test' });
    expect(own.settings.imapHost).toBe('mail.firma.aperio.test');
    const list = await admin.get('/api/mailbox/setup/providers');
    expect(list.providers.find((p: { id: string }) => p.id === 'netcup').needsHost).toBe(true);
    expect(list.oauth).toEqual({ microsoft: false, google: false });
  });

  it('meldet ein falsches Passwort verständlich und überspringt den Rest', async () => {
    const { id } = await admin.post('/api/mailbox/setup/test', { email: 'max@firma.aperio.test', displayName: 'Max Muster', ...server, username: 'max@firma.aperio.test', password: 'falsch' });
    const r = await waitTest(admin, id);
    expect(r.ok).toBe(false);
    expect(r.steps.find((s: { key: string }) => s.key === 'imap').status).toBe('ok');
    const login = r.steps.find((s: { key: string }) => s.key === 'login');
    expect(login.status).toBe('error');
    expect(login.text).toMatch(/Passwort abgelehnt/);
    expect(r.steps.find((s: { key: string }) => s.key === 'send').status).toBe('skipped');
  });

  it('meldet einen unbekannten Server', async () => {
    const { id } = await admin.post('/api/mailbox/setup/test', { email: 'max@firma.aperio.test', displayName: 'Max', ...server, imapHost: 'aus.firma.aperio.test', username: 'max@firma.aperio.test', password: 'geheim' });
    const r = await waitTest(admin, id);
    expect(r.steps[0].status).toBe('error');
    expect(r.steps[0].text).toMatch(/nicht gefunden/);
  });

  it('prüft alles bis zur Test-E-Mail und speichert das Konto', async () => {
    const { id } = await admin.post('/api/mailbox/setup/test', { email: 'max@firma.aperio.test', displayName: 'Max Muster', ...server, username: 'max@firma.aperio.test', password: 'geheim' });
    const r = await waitTest(admin, id);
    expect(r.steps.map((s: { status: string }) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(r.folderMap.sent).toBe('Sent');
    expect(r.steps[5].text).toMatch(/Angekommen/);
    // Test-E-Mail liegt danach im Papierkorb, nicht im Posteingang
    expect(fakeAccount('max@firma.aperio.test').boxes.get('INBOX')!.messages.length).toBe(0);
    expect(fakeAccount('max@firma.aperio.test').boxes.get('Trash')!.messages.length).toBe(1);

    await admin.req('POST', '/api/mailbox/accounts', { email: 'max@firma.aperio.test', displayName: '', ...r.settings, password: 'geheim' }, 400);
    const acc = await admin.post('/api/mailbox/accounts', { email: 'max@firma.aperio.test', displayName: 'Max Muster', ...r.settings, password: 'geheim', folderMap: r.folderMap, testId: id, provider: 'custom' });
    expect(acc.primary).toBe(true);
    expect((await admin.get('/api/mailbox/account')).email).toBe('max@firma.aperio.test');
    await admin.post('/api/mailbox/sync', { accountId: acc.id });
    const folders = await admin.get(`/api/mailbox/folders?accountId=${acc.id}`);
    expect(folders.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['Posteingang', 'Gesendet', 'Papierkorb', 'Spam', 'Entwürfe']));
  });

  it('ordnet Ordner ohne Kennzeichnung nach dem Namen zu', async () => {
    fakeAccount('ohne@firma.aperio.test', { noSpecialUse: true });
    const { id } = await admin.post('/api/mailbox/setup/test', { email: 'ohne@firma.aperio.test', ...server, username: 'ohne@firma.aperio.test', password: 'x', skipMail: true });
    const r = await waitTest(admin, id);
    expect(r.folderMap).toMatchObject({ sent: 'Sent', trash: 'Trash', junk: 'Junk', drafts: 'Drafts' });
    expect(mb.guessSpecial('INBOX.Gesendete Objekte', '.')).toBe('\\Sent');
    expect(mb.guessSpecial('Papierkorb')).toBe('\\Trash');
  });
});

describe('Senden', () => {
  let accountId: string;
  beforeAll(async () => {
    fakeAccount('eva@kunde.aperio.test');
    accountId = (await admin.get('/api/mailbox/accounts'))[0].id;
  });

  it('verschickt mit Anzeigename, nie doppelt, und legt eine Kopie in „Gesendet“', async () => {
    const body = { accountId, clientKey: 'abc12345-test', to: 'Eva <eva@kunde.aperio.test>; ', subject: 'Angebot', html: '<p>Hallo Eva</p>' };
    const r1 = await admin.post('/api/mailbox/send', body);
    expect(r1.ok).toBe(true);
    expect(r1.duplicate).toBe(false);
    const r2 = await admin.post('/api/mailbox/send', body);
    expect(r2.duplicate).toBe(true);
    const inbox = fakeAccount('eva@kunde.aperio.test').boxes.get('INBOX')!.messages;
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.source.toString()).toMatch(/From: Max Muster <max@firma\.aperio.test>|From: "Max Muster" <max@firma\.aperio.test>/);
    await new Promise((r) => setTimeout(r, 200));
    expect(fakeAccount('max@firma.aperio.test').boxes.get('Sent')!.messages.length).toBe(1);
    const events = await admin.get(`/api/mailbox/accounts/${accountId}/events`);
    expect(events.some((e: { text: string }) => /Gesendet an Eva/.test(e.text))).toBe(true);
  });

  it('übernimmt einen geänderten Anzeigenamen sofort', async () => {
    await admin.patch(`/api/mailbox/accounts/${accountId}`, { displayName: 'Maximilian Muster' });
    await admin.post('/api/mailbox/send', { accountId, clientKey: 'name-geaendert', to: 'eva@kunde.aperio.test', subject: 'Neu', html: 'x' });
    const inbox = fakeAccount('eva@kunde.aperio.test').boxes.get('INBOX')!.messages;
    expect(inbox.at(-1)!.source.toString()).toMatch(/Maximilian Muster/);
    await admin.req('PATCH', `/api/mailbox/accounts/${accountId}`, { displayName: ' ' }, 400);
  });

  it('versucht es bei „zu vielen Verbindungen“ selbst erneut', async () => {
    fakeAccount('max@firma.aperio.test').busyLeft = 1;
    const r = await admin.post('/api/mailbox/send', { accountId, clientKey: 'busy-1234', to: 'eva@kunde.aperio.test', subject: 'Trotzdem', html: 'x' });
    expect(r.queued).toBeUndefined();
    expect(fakeAccount('eva@kunde.aperio.test').boxes.get('INBOX')!.messages.at(-1)!.source.toString()).toMatch(/Trotzdem/);
  });

  it('legt die E-Mail bei anhaltender Störung in den Postausgang und schickt sie nach', async () => {
    fakeAccount('max@firma.aperio.test').busyLeft = 10;
    const r = await admin.post('/api/mailbox/send', { accountId, clientKey: 'busy-5678', to: 'eva@kunde.aperio.test', subject: 'Spaeter', html: 'x' });
    expect(r.queued).toBe(true);
    expect(r.message).toMatch(/Postausgang/);
    const out = await admin.get(`/api/mailbox/outbox?accountId=${accountId}`);
    expect(out.length).toBe(1);
    fakeAccount('max@firma.aperio.test').busyLeft = 0;
    const retry = await admin.post(`/api/mailbox/outbox/${out[0].id}/retry`);
    expect(retry.ok).toBe(true);
    expect(await admin.get(`/api/mailbox/outbox?accountId=${accountId}`)).toEqual([]);
    expect(fakeAccount('eva@kunde.aperio.test').boxes.get('INBOX')!.messages.at(-1)!.source.toString()).toMatch(/Spaeter/);
  });

  it('meldet ein falsches Passwort beim Senden sofort', async () => {
    const keep = (await env.ctx.sql<{ password_sealed: string }[]>`select password_sealed from mail_accounts where id = ${accountId}`)[0]!.password_sealed;
    const { sealSecret } = await import('../src/services/secrets');
    await env.ctx.sql`update mail_accounts set password_sealed = ${await sealSecret(env.ctx, 'falsch')} where id = ${accountId}`;
    const r = await admin.req('POST', '/api/mailbox/send', { accountId, clientKey: 'pw-falsch', to: 'eva@kunde.aperio.test', subject: 'x', html: 'x' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Passwort/);
    await env.ctx.sql`update mail_accounts set password_sealed = ${keep} where id = ${accountId}`;
  });
});

describe('Mehrere Postfächer', () => {
  it('richtet ein zweites Postfach ein und wechselt das Hauptpostfach', async () => {
    const second = await admin.post('/api/mailbox/accounts', { email: 'info@firma.aperio.test', displayName: 'Firma Info', label: 'Info', ...server, username: 'info@firma.aperio.test', password: 'x' });
    expect(second.primary).toBe(false);
    let list = await admin.get('/api/mailbox/accounts');
    expect(list.map((a: { email: string }) => a.email)).toEqual(['max@firma.aperio.test', 'info@firma.aperio.test']);
    await admin.patch(`/api/mailbox/accounts/${second.id}`, { primary: true });
    list = await admin.get('/api/mailbox/accounts');
    expect(list[0].email).toBe('info@firma.aperio.test');
    // ältere Versionen sehen genau ein Postfach (user_id)
    const old = await env.ctx.sql`select email from mail_accounts where user_id is not null`;
    expect(old.map((r) => r.email)).toEqual(['info@firma.aperio.test']);
    await admin.del(`/api/mailbox/accounts/${second.id}`);
    list = await admin.get('/api/mailbox/accounts');
    expect(list.length).toBe(1);
    expect(list[0].primary).toBe(true);
  });
});

describe('Signaturen', () => {
  it('entfernt Programmteile und füllt Platzhalter, leere Zeilen entfallen', () => {
    expect(cleanHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:x">a</a>')).toBe('<p>Hi</p><a href="#">a</a>');
    const f = { name: 'Max Muster', firstName: 'Max', lastName: 'Muster', position: 'Konstrukteur', department: 'Konstruktion', phone: '0771 1', mobile: '', email: 'm@x', company: 'Firma' };
    expect(renderSignature('<p>{Name}</p><p>{Position}</p><p>Mobil: {Mobil}</p>', f)).toBe('<p>Max Muster</p><p>Konstrukteur</p>');
    expect(renderSignature('{Name}<br>Tel. {Telefon}<br>Mobil {Mobil}<br>{Firma}', f)).toBe('Max Muster<br>Tel. 0771 1<br>Firma');
  });

  it('verwaltet mehrere Signaturen und eine Firmen-Signatur mit Angaben aus dem Benutzerkonto', async () => {
    const me = await admin.get('/api/auth/me');
    const dept = await admin.post('/api/teams', { name: 'Leitung' });
    await admin.patch(`/api/users/${me.id}`, { jobTitle: 'Geschäftsführer', departmentId: dept.id });
    await admin.patch('/api/me', { phone: '+49 7723 1', mobile: '+49 170 2' });
    const s1 = await admin.post('/api/mailbox/signatures', { name: 'Standard', html: '<p>Gruß {Name}</p><p>{Position}</p><img src="data:image/png;base64,AAAA"><script>x</script>' });
    const s2 = await admin.post('/api/mailbox/signatures', { name: 'Kurz', html: '{Vorname}' });
    expect(s1.html).not.toMatch(/script/);
    const accountId = (await admin.get('/api/mailbox/accounts'))[0].id;
    await admin.patch(`/api/mailbox/accounts/${accountId}`, { sigNew: s1.id, sigReply: s2.id });
    const sigs = await admin.get(`/api/mailbox/signatures?accountId=${accountId}`);
    expect(sigs.items.length).toBe(2);
    expect(sigs.items[0].rendered).toMatch(/Geschäftsführer/);
    expect(sigs.company).toBeNull();
    const [legacy] = await env.ctx.sql`select signature_html from mail_accounts where id = ${accountId}`;
    expect(legacy!.signature_html).toMatch(/Gruß/);

    await admin.put('/api/settings/mailSignature', { enabled: true, mode: 'mandatory', html: '<p>{Name} · {Position}</p><p>Tel. {Telefon} · Mobil {Mobil}</p><p onload="x">{Firma}</p>' });
    const again = await admin.get(`/api/mailbox/signatures?accountId=${accountId}`);
    expect(again.company.mode).toBe('mandatory');
    expect(again.company.rendered).toMatch(/Geschäftsführer/);
    expect(again.company.rendered).toMatch(/\+49 170 2/);
    expect(again.company.html).not.toMatch(/onload/);
    await admin.del(`/api/mailbox/signatures/${s2.id}`);
    expect((await admin.get('/api/mailbox/accounts'))[0].sigReply).toBe('');
  });
});

describe('Adressbuch', () => {
  it('zeigt Mitarbeiter, CRM-Kontakte, zuletzt verwendete und Gruppen', async () => {
    const teams = await admin.get('/api/teams');
    const kons = teams.find((t: { name: string }) => t.name === 'Konstruktion') ?? await admin.post('/api/teams', { name: 'Konstruktion' });
    const sub = await admin.post('/api/teams', { name: 'Konstruktion Mechanik', parentId: kons.id });
    const { id: annaId } = await userClient(env.app, admin, 'anna');
    await admin.patch(`/api/users/${annaId}`, { email: 'anna@firma.aperio.test', departmentId: sub.id, jobTitle: 'Technische Zeichnerin' });
    const crm = await admin.post('/api/crm/accounts', { name: 'Kunde GmbH', email: 'info@kunde.aperio.test' });
    await admin.post(`/api/crm/accounts/${crm.id}/contacts`, { firstName: 'Eva', lastName: 'Kundin', email: 'eva@kunde.aperio.test' });
    const book = await admin.get('/api/mailbox/addressbook');
    const kinds = new Set(book.entries.map((e: { kind: string }) => e.kind));
    expect(kinds).toEqual(new Set(['user', 'contact', 'company']));
    expect(book.entries.find((e: { email: string }) => e.email === 'anna@firma.aperio.test').detail).toMatch(/Technische Zeichnerin/);
    const group = book.groups.find((g: { name: string }) => g.name === 'Konstruktion');
    expect(group.count).toBe(1);
    const members = await admin.get(`/api/mailbox/addressbook/groups/${group.id}`);
    expect(members.members.map((m: { email: string }) => m.email)).toEqual(['anna@firma.aperio.test']);
    const all = await admin.get('/api/mailbox/addressbook/groups/all');
    expect(all.members.length).toBeGreaterThanOrEqual(1);
    const search = await admin.get('/api/mailbox/addressbook?q=kundin');
    expect(search.entries.map((e: { name: string }) => e.name)).toContain('Eva Kundin');
  });
});

describe('Werkzeug-Favoriten und Reiter', () => {
  it('speichert Werkzeug-Favoriten in eigener Reihenfolge', async () => {
    expect(await admin.get('/api/favorites/tools')).toEqual([]);
    expect(await admin.put('/api/favorites/tools', { tools: ['crm', 'warehouse', 'crm'] })).toEqual(['crm', 'warehouse']);
    await admin.put('/api/favorites/tools', { tools: ['warehouse', 'crm'] });
    expect(await admin.get('/api/favorites/tools')).toEqual(['warehouse', 'crm']);
    await admin.put('/api/favorites/tools', { tools: ['crm'] });
    expect(await admin.get('/api/favorites/tools')).toEqual(['crm']);
  });

  it('blendet Reiter nur für die eigene Person aus', async () => {
    const p = await admin.post('/api/projects', { name: 'Reiter-Test' });
    const { client: bob, id: bobId } = await userClient(env.app, admin, 'bob');
    await admin.post(`/api/projects/${p.id}/members`, { userId: bobId, role: 'member' }).catch(() => undefined);
    const r = await admin.put(`/api/projects/${p.id}/hidden-tabs`, { tabs: ['kanban', 'overview'] });
    expect(r.tabs).toEqual(['kanban']);
    expect((await admin.get(`/api/projects/${p.id}`)).hiddenTabs).toEqual(['kanban']);
    const other = await bob.req('GET', `/api/projects/${p.id}`);
    if (other.status === 200) expect(other.body.hiddenTabs).toEqual([]);
  });
});
