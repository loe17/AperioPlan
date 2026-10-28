import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { buildIcs, expandOccurrences, parseIcs } from '../src/lib/ical';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

describe('Projektnummern aus Bausteinen', () => {
  it('Muster mit Jahr und Abteilungskürzel, ungültiges Muster abgelehnt', async () => {
    await admin.req('PUT', '/api/settings/projectNumbers', { format: 'pattern', pattern: 'PRJ-{JJ}' }, 400);
    await admin.put('/api/settings/projectNumbers', { format: 'pattern', pattern: '{TEAM}-{JJ}{NNN}', start: 40, step: 1 });
    const team = await admin.post('/api/teams', { name: 'Konstruktion', shortCode: 'kon' });
    const p1 = await admin.post('/api/projects', { name: 'Anlage', teamId: team.id });
    const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
    expect(p1.number).toBe(`KON-${yy}040`);
    const p2 = await admin.post('/api/projects', { name: 'Anlage 2', teamId: team.id });
    expect(p2.number).toBe(`KON-${yy}041`);
    await admin.put('/api/settings/projectNumbers', { format: 'sequential' });
  });
});

describe('Abgeschlossene Projekte sind gesperrt', () => {
  it('nur lesbar, nur der Administrator setzt den Status zurück', async () => {
    const { client: lead, id: leadId } = await userClient(env.app, admin, 'lock-lead');
    const p = await lead.post('/api/projects', { name: 'Fertig' });
    const t = await lead.post(`/api/projects/${p.id}/tasks`, { title: 'Aufgabe' });
    await lead.patch(`/api/projects/${p.id}`, { status: 'done' });
    const r = await lead.req('PATCH', `/api/tasks/${t.id}`, { title: 'neu' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/nur noch lesbar/);
    await lead.req('POST', `/api/projects/${p.id}/tasks`, { title: 'x' }, 403);
    await lead.req('POST', `/api/comments/task/${t.id}`, { body: 'Hallo' }, 403);
    await lead.req('POST', '/api/time/clock-in', { projectId: p.id }, 403);
    await lead.req('PATCH', `/api/projects/${p.id}`, { status: 'active' }, 403);
    const detail = await lead.get(`/api/projects/${p.id}`);
    expect(detail.locked).toBe(true);
    expect(detail.canEdit).toBe(false);
    await admin.req('PATCH', `/api/projects/${p.id}`, { status: 'active', name: 'Anders' }, 403);
    await admin.patch(`/api/projects/${p.id}`, { status: 'active' });
    await lead.patch(`/api/tasks/${t.id}`, { title: 'neu' });
    const log = await admin.get(`/api/audit?projectId=${p.id}`);
    expect(JSON.stringify(log)).toMatch(/zurückgesetzt/);
    expect(leadId).toBeTruthy();
  });
});

describe('Eigene Kanban-Spalten', () => {
  it('Spalte gehört zu einer Grundstufe und setzt den Status', async () => {
    const p = await admin.post('/api/projects', { name: 'Kanban' });
    const col = await admin.post(`/api/projects/${p.id}/columns`, { name: 'Wartet auf Kunde', baseStatus: 'in_progress', color: '#f59e0b' });
    const t = await admin.post(`/api/projects/${p.id}/tasks`, { title: 'A' });
    const moved = await admin.patch(`/api/tasks/${t.id}`, { columnId: col.id });
    expect(moved.status).toBe('in_progress');
    expect(moved.columnId).toBe(col.id);
    // Titel ändern lässt die Spalte stehen, Statuswechsel führt in die Grundspalte
    expect((await admin.patch(`/api/tasks/${t.id}`, { title: 'B', status: 'in_progress' })).columnId).toBe(col.id);
    await admin.patch(`/api/columns/${col.id}`, { baseStatus: 'review' });
    const list = await admin.get(`/api/projects/${p.id}/tasks`);
    expect(list.find((x: any) => x.id === t.id).status).toBe('review');
    expect((await admin.patch(`/api/tasks/${t.id}`, { status: 'done' })).columnId).toBeNull();
  });
});

describe('iCalendar', () => {
  it('liest und schreibt Termine, Wiederholung bleibt in Ortszeit', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nDTSTART;TZID=Europe/Berlin:20261026T090000\r\nDTEND;TZID=Europe/Berlin:20261026T093000\r\nSUMMARY:Team\\, Runde\r\nRRULE:FREQ=WEEKLY\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a2\r\nDTSTART;VALUE=DATE:20261224\r\nSUMMARY:Heiligabend\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const ev = parseIcs(ics);
    expect(ev).toHaveLength(2);
    expect(ev[0]!.summary).toBe('Team, Runde');
    expect(ev[0]!.start.toISOString()).toBe('2026-10-26T08:00:00.000Z'); // Winterzeit
    expect(ev[1]!.allDay).toBe(true);
    const occ = expandOccurrences({ start: new Date('2026-10-19T07:00:00Z'), end: new Date('2026-10-19T07:30:00Z'), recurrence: 'weekly' }, new Date('2026-10-18T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
    expect(occ.map((o) => o.start.toISOString())).toEqual(['2026-10-19T07:00:00.000Z', '2026-10-26T08:00:00.000Z']);
    const back = parseIcs(buildIcs('Test', [{ uid: 'x', summary: 'Zeile; mit, Zeichen', start: new Date('2026-01-01T10:00:00Z'), end: new Date('2026-01-01T11:00:00Z'), allDay: false, recurrence: 'weekdays', until: '2026-02-01' }]));
    expect(back[0]).toMatchObject({ summary: 'Zeile; mit, Zeichen', recurrence: 'weekdays', until: '2026-02-01' });
  });
});

describe('Termine', () => {
  it('Einladung, Zusage, Wiederholung und Abo-Link', async () => {
    const { client: ben, id: benId } = await userClient(env.app, admin, 'cal-ben');
    const e = await admin.post('/api/calendar/events', {
      title: 'Wochenrunde', startsAt: '2026-11-02T08:00:00Z', endsAt: '2026-11-02T09:00:00Z', recurrence: 'weekly', recurrenceUntil: '2026-11-30',
      attendeeIds: [benId], private: false,
    });
    const inbox = await ben.get('/api/notifications');
    expect(JSON.stringify(inbox)).toMatch(/Einladung: Wochenrunde/);
    await ben.post(`/api/calendar/events/${e.id}/respond`, { response: 'accepted' });
    const mine = await ben.get('/api/calendar/events?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z');
    expect(mine).toHaveLength(5);
    expect(mine[0].attendees[0].response).toBe('accepted');
    // privater Termin erscheint Kollegen nur als belegt
    await admin.post('/api/calendar/events', { title: 'Arzt', startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T09:00:00Z', private: true });
    const team = await ben.get('/api/calendar/team/events?from=2026-11-03T00:00:00Z&to=2026-11-04T00:00:00Z');
    expect(team.find((x: any) => x.private).title).toBe('Belegt');
    // Abo-Link ohne Anmeldung
    const { path } = await ben.get('/api/me/ical');
    const feed = await new Client(env.app).req('GET', path);
    expect(feed.status).toBe(200);
    expect(String(feed.body)).toContain('SUMMARY:Wochenrunde');
    expect(String(feed.body)).toContain('RRULE:FREQ=WEEKLY');
    await ben.req('PATCH', `/api/calendar/events/${e.id}`, { title: 'gekapert' }, 403);
  });
});

describe('CalDAV-Abgleich', () => {
  let server: Server;
  const store = new Map<string, { etag: string; data: string }>();
  let base = '';
  beforeAll(async () => {
    store.set('/cal/remote1.ics', { etag: '"1"', data: buildIcs('x', [{ uid: 'remote1', summary: 'Kundentermin', start: new Date(Date.now() + 86400000), end: new Date(Date.now() + 90000000), allDay: false }]) });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.headers.authorization !== `Basic ${Buffer.from('max:geheim').toString('base64')}`) { res.statusCode = 401; return res.end(); }
        if (req.method === 'PROPFIND') {
          res.statusCode = 207;
          return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>');
        }
        if (req.method === 'REPORT') {
          res.statusCode = 207;
          const items = [...store].map(([href, v]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${v.etag.replace(/"/g, '&quot;')}</d:getetag><c:calendar-data>${v.data.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data></d:prop></d:propstat></d:response>`).join('');
          return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${items}</d:multistatus>`);
        }
        if (req.method === 'PUT') { const etag = `"${Date.now()}"`; store.set(decodeURIComponent(req.url!), { etag, data: body }); res.statusCode = 201; res.setHeader('etag', etag); return res.end(); }
        if (req.method === 'DELETE') { store.delete(decodeURIComponent(req.url!)); res.statusCode = 204; return res.end(); }
        res.statusCode = 405; res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  it('holt Termine, schreibt eigene Termine zurück und löscht sie dort', async () => {
    const { client: c } = await userClient(env.app, admin, 'dav-max');
    await c.req('POST', '/api/calendar/accounts', { kind: 'caldav', name: 'Nextcloud', url: `${base}/cal/`, username: 'max', password: 'falsch' }, 400);
    const acc = await c.post('/api/calendar/accounts', { kind: 'caldav', name: 'Nextcloud', url: `${base}/cal/`, username: 'max', password: 'geheim', pushNew: true });
    expect(acc.count).toBe(1);
    const from = new Date().toISOString(), to = new Date(Date.now() + 5 * 86400000).toISOString();
    const list = await c.get(`/api/calendar/events?from=${from}&to=${to}`);
    expect(list.map((x: any) => x.title)).toContain('Kundentermin');
    const own = await c.post('/api/calendar/events', { title: 'Von AperioPlan', startsAt: new Date(Date.now() + 2 * 86400000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString() });
    expect(own.syncError).toBeNull();
    expect([...store.values()].some((v) => v.data.includes('SUMMARY:Von AperioPlan'))).toBe(true);
    await c.del(`/api/calendar/events/${own.id}`);
    expect([...store.values()].some((v) => v.data.includes('Von AperioPlan'))).toBe(false);
    // dort gelöscht → hier nach dem Abgleich weg
    store.delete('/cal/remote1.ics');
    await c.post(`/api/calendar/accounts/${acc.id}/sync`);
    expect((await c.get(`/api/calendar/events?from=${from}&to=${to}`)).length).toBe(0);
  });
});

describe('Ressourcenarten', () => {
  it('eigene Art mit Feld bei Rückgabe', async () => {
    const t = await admin.post('/api/resource-types', { name: 'Stapler', icon: 'truck', fields: [{ key: 'hours', label: 'Betriebsstunden', type: 'number', when: 'return' }] });
    const r = await admin.post('/api/resources', { name: 'Stapler 1', kind: t.key });
    await admin.req('POST', '/api/resources', { name: 'X', kind: 'gibtsnicht' }, 400);
    const start = new Date(Date.now() + 3600000), end = new Date(Date.now() + 7200000);
    const bk = await admin.post('/api/resources/bookings', { resourceId: r.id, startsAt: start.toISOString(), endsAt: end.toISOString() });
    await admin.req('POST', `/api/resources/bookings/${bk.ids[0]}/return`, { extra: {} }, 400);
    await admin.post(`/api/resources/bookings/${bk.ids[0]}/return`, { extra: { hours: 1234 } });
    await admin.req('DELETE', `/api/resource-types/${t.key}`, undefined, 400);
    const types = await admin.get('/api/resource-types');
    expect(types.map((x: any) => x.key)).toEqual(expect.arrayContaining(['room', 'vehicle', t.key]));
  });
});
