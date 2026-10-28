import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { testOutbox } from '../src/services/mail';
import { runDailyJobs } from '../src/services/daily';
import { localTime } from '../src/routes/booking';
import { noticeDeadline, periodFor } from '../src/routes/contracts';

let env: TestEnv;
let admin: Client;
let acc: { id: string };
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  for (const a of ['service', 'helpdesk', 'contracts', 'booking', 'events', 'meetings']) await admin.post(`/api/apps/${a}/install`, {});
  testOutbox.enabled = true;
  await admin.put('/api/settings/invoicing', { legalName: 'Muster GmbH', street: 'Weg 1', zip: '78120', city: 'Furtwangen', vatId: 'DE123456789', iban: 'DE02120300000000202051', contactName: 'A', contactPhone: '1', contactEmail: 'r@m.de' });
  acc = await admin.post('/api/crm/accounts', { name: 'Kunde Service AG', street: 'Industriestr. 3', zip: '79098', city: 'Freiburg', email: 'info@kunde.de' });
});
afterAll(async () => { testOutbox.enabled = false; await env.close(); });
const anon = (method: string, url: string, payload?: unknown) => env.app.inject({ method: method as 'GET', url, payload: payload as object });

describe('Service-Einsätze', () => {
  it('planen, Bericht, Unterschrift, PDF, Rechnung', async () => {
    const { client: tech, id: techId } = await userClient(env.app, admin, 'tech.svc');
    const j = await admin.post('/api/service/jobs', { accountId: acc.id, title: 'Pumpe tauscht nicht', technicianIds: [techId], startAt: '2026-11-03T08:00:00+01:00' });
    expect(j.number).toMatch(/^SE-\d{4}-\d{4}$/);
    let d = await tech.get(`/api/service/jobs/${j.id}`);
    expect(d.address).toBe('Industriestr. 3, 79098 Freiburg');
    expect((await tech.get('/api/service/jobs?mine=1')).length).toBe(1);
    await tech.patch(`/api/service/jobs/${j.id}`, { status: 'in_progress', report: 'Dichtung getauscht', work: [{ date: '2026-11-03', text: 'Fehlersuche und Reparatur', hours: 2.5 }], travelKm: 42,
      materials: [{ text: 'Dichtungssatz', qty: 1, price: 38.5 }] });
    await tech.post(`/api/service/jobs/${j.id}/sign`, { name: 'H. Kunde', strokes: [[[0.1, 0.5], [0.2, 0.4]]] }, 400); // zu kurz
    await tech.post(`/api/service/jobs/${j.id}/sign`, { name: 'H. Kunde', strokes: [[[0.1, 0.5], [0.2, 0.4], [0.3, 0.6], [0.4, 0.45], [0.5, 0.55], [0.6, 0.5]]] });
    d = await tech.get(`/api/service/jobs/${j.id}`);
    expect(d).toMatchObject({ signed: true, signedBy: 'H. Kunde', status: 'done' });
    await tech.patch(`/api/service/jobs/${j.id}`, { report: 'geändert' }, 400);
    const pdf = await env.app.inject({ method: 'GET', url: `/api/service/jobs/${j.id}/pdf`, headers: { cookie: tech.cookie } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.rawPayload.toString('latin1')).toContain(' l S'); // Unterschrift als Linien gezeichnet
    await tech.post(`/api/service/jobs/${j.id}/mail`, { to: 'info@kunde.de' });
    expect(testOutbox.messages.at(-1)!.attachments[0]).toMatch(/^Servicebericht_SE-/);
    const inv = await admin.post(`/api/service/jobs/${j.id}/invoice`, {});
    const i = await admin.get(`/api/crm/invoices/${inv.invoiceId}`);
    expect(i.positions.map((p: any) => [p.text, p.qty, p.price])).toEqual([['Arbeitszeit Servicetechniker', 2.5, 85], ['Fahrtkosten', 42, 0.6], ['Dichtungssatz', 1, 38.5]]);
    expect((await admin.get(`/api/service/jobs/${j.id}`)).status).toBe('invoiced');
    await admin.post(`/api/service/jobs/${j.id}/invoice`, {}, 400);
  });
});

describe('Kundenanfragen', () => {
  it('Kontaktformular, Antwort per E-Mail, Kundenportal, Bewertung', async () => {
    const f = await anon('GET', '/api/pub/support');
    expect(JSON.parse(f.body)).toMatchObject({ enabled: true, company: 'Muster GmbH' });
    testOutbox.messages.length = 0;
    const r = await anon('POST', '/api/pub/support/tickets', { name: 'Erika Muster', email: 'erika@kunde.de', subject: 'Ersatzteil gesucht', message: 'Wir brauchen einen Filter für die Anlage 4711.' });
    expect(r.statusCode).toBe(200);
    const { number, token } = JSON.parse(r.body);
    expect(testOutbox.messages[0]!.subject).toBe(`[${number}] Ersatzteil gesucht`);
    expect(testOutbox.messages[0]!.text).toContain(`/support/t/${token}`);
    const list = await admin.get('/api/helpdesk/tickets?status=active');
    const t = list.find((x: any) => x.number === number);
    expect(t).toMatchObject({ status: 'new', channel: 'web' });
    await admin.post(`/api/helpdesk/tickets/${t.id}/messages`, { body: 'Intern: Lager prüfen', internal: true });
    await admin.post(`/api/helpdesk/tickets/${t.id}/messages`, { body: 'Der Filter ist lieferbar, Angebot folgt.' });
    expect(testOutbox.messages.at(-1)!.text).toContain('Der Filter ist lieferbar');
    let d = await admin.get(`/api/helpdesk/tickets/${t.id}`);
    expect(d).toMatchObject({ status: 'waiting' });
    expect(d.firstResponseAt).toBeTruthy();
    const p = JSON.parse((await anon('GET', `/api/pub/support/t/${token}`)).body);
    expect(p.messages.map((m: any) => m.body)).toEqual(['Wir brauchen einen Filter für die Anlage 4711.', 'Der Filter ist lieferbar, Angebot folgt.']);
    await anon('POST', `/api/pub/support/t/${token}/reply`, { message: 'Danke, bitte schicken.' });
    expect((await admin.get(`/api/helpdesk/tickets/${t.id}`)).status).toBe('open');
    expect((await anon('POST', `/api/pub/support/t/${token}/rate`, { rating: 5 })).statusCode).toBe(400);
    await admin.patch(`/api/helpdesk/tickets/${t.id}`, { status: 'solved' });
    expect((await anon('POST', `/api/pub/support/t/${token}/rate`, { rating: 5 })).statusCode).toBe(200);
    const ov = await admin.get('/api/helpdesk/overview');
    expect(ov.rating).toBe(5);
    d = await admin.get(`/api/helpdesk/tickets/${t.id}`);
    expect(d.messages).toHaveLength(4);
    // Spam-Schutz: verstecktes Feld
    expect((await anon('POST', '/api/pub/support/tickets', { name: 'Bot', email: 'b@b.de', subject: 'Spam!!', message: 'kaufen kaufen', website: 'x' })).statusCode).toBe(400);
  });
});

describe('Wartungsverträge', () => {
  it('Zeiträume und Kündigungsfristen', () => {
    expect(periodFor({ billing: 'advance', intervalMonths: 3 }, '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(periodFor({ billing: 'arrears', intervalMonths: 1 }, '2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(noticeDeadline({ startDate: '2025-01-01', endDate: '2026-12-31', noticeMonths: 3, renewMonths: 12 }, '2026-10-28')).toEqual({ end: '2027-12-31', deadline: '2027-09-30' });
    expect(noticeDeadline({ startDate: '2025-01-01', endDate: '2026-12-31', noticeMonths: 3, renewMonths: 12 }, '2026-09-01')).toEqual({ end: '2026-12-31', deadline: '2026-09-30' });
  });
  it('erzeugt fällige Rechnungen automatisch und nur einmal', async () => {
    const c = await admin.post('/api/contracts', { accountId: acc.id, title: 'Wartungsvertrag Pumpen', startDate: '2026-01-01', intervalMonths: 3, positions: [{ text: 'Wartungspauschale', qty: 1, price: 450 }] });
    expect(c.number).toMatch(/^V-\d{4}$/);
    let d = await admin.get(`/api/contracts/${c.id}`);
    expect(d).toMatchObject({ nextInvoiceDate: '2026-01-01', netPerInterval: 450, mrr: 150 });
    await runDailyJobs(env.ctx);
    await runDailyJobs(env.ctx);
    d = await admin.get(`/api/contracts/${c.id}`);
    // Januar, April, Juli, Oktober 2026 – bis heute fällig
    const due = ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01'].filter((x) => x <= new Date().toISOString().slice(0, 10));
    expect(d.invoices).toHaveLength(due.length);
    expect(d.invoices.at(-1)).toMatchObject({ periodFrom: '2026-01-01', periodTo: '2026-03-31', status: 'draft' });
    const ov = await admin.get('/api/contracts/overview');
    expect(ov).toMatchObject({ active: 1, mrr: 150, arr: 1800 });
    const r = await admin.post(`/api/contracts/${c.id}/cancel`, { to: '2026-12-31' });
    expect(r.to).toBe('2026-12-31');
    await admin.del(`/api/contracts/${c.id}`, 400);
  });
});

describe('Terminbuchung', () => {
  it('Ortszeit umrechnen', () => {
    expect(localTime('2026-07-01', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(localTime('2026-12-01', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });
  it('freie Zeiten, buchen, Doppelbuchung verhindern, absagen', async () => {
    const { id: hostId } = await userClient(env.app, admin, 'berater.bk');
    const t = await admin.post('/api/booking/types', { name: 'Erstberatung', durationMin: 60, bufferMin: 15, hostIds: [hostId], minNoticeHours: 0, maxDaysAhead: 365,
      availability: { mon: [['09:00', '12:00']], tue: [['09:00', '12:00']], wed: [['09:00', '12:00']], thu: [['09:00', '12:00']], fri: [['09:00', '12:00']] }, questions: [{ id: 'q1', label: 'Worum geht es?', required: true }] });
    expect(t.slug).toBe('erstberatung');
    // ein Montag in der Zukunft
    const d = new Date(); d.setDate(d.getDate() + 14); while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    const day = d.toISOString().slice(0, 10);
    const info = JSON.parse((await anon('GET', '/api/pub/book/erstberatung')).body);
    expect(info).toMatchObject({ name: 'Erstberatung', durationMin: 60 });
    let s = JSON.parse((await anon('GET', `/api/pub/book/erstberatung/slots?from=${day}&days=1`)).body);
    // 09:00 bis 11:00 im 30-Minuten-Raster: 09:00, 09:30, 10:00, 10:30, 11:00
    expect(s[0].times).toHaveLength(5);
    // Kalendertermin des Beraters 10:00–10:30 blockiert mit Puffer 09:00 bis 10:30
    await env.ctx.sql`insert into calendar_events (owner_id, title, starts_at, ends_at) values (${hostId}, 'intern', ${localTime(day, '10:00')}, ${localTime(day, '10:30')})`;
    s = JSON.parse((await anon('GET', `/api/pub/book/erstberatung/slots?from=${day}&days=1`)).body);
    expect(s[0].times.map((x: string) => new Date(x).toISOString())).toEqual([localTime(day, '11:00').toISOString()]);
    expect((await anon('POST', '/api/pub/book/erstberatung', { start: s[0].times[0], name: 'Max Kunde', email: 'max@kunde.de' })).statusCode).toBe(400); // Pflichtfrage
    testOutbox.messages.length = 0;
    const ok = await anon('POST', '/api/pub/book/erstberatung', { start: s[0].times[0], name: 'Max Kunde', email: 'max@kunde.de', answers: { q1: 'Angebot' } });
    expect(ok.statusCode).toBe(200);
    const res = JSON.parse(ok.body);
    expect(testOutbox.messages[0]!.attachments).toContain('termin.ics');
    expect((await anon('POST', '/api/pub/book/erstberatung', { start: s[0].times[0], name: 'Zweiter', email: 'z@kunde.de', answers: { q1: 'x' } })).statusCode).toBe(400);
    const [ev] = await env.ctx.sql`select title from calendar_events where owner_id = ${hostId} and title like 'Erstberatung%'`;
    expect(ev).toBeTruthy();
    expect((await admin.get('/api/booking/bookings')).length).toBe(1);
    expect((await anon('POST', `/api/pub/book/cancel/${res.cancelToken}`, {})).statusCode).toBe(200);
    expect((await admin.get('/api/booking/bookings'))[0].status).toBe('cancelled');
    const [gone] = await env.ctx.sql`select 1 from calendar_events where owner_id = ${hostId} and title like 'Erstberatung%'`;
    expect(gone).toBeUndefined();
  });
});

describe('Messen und Veranstaltungen', () => {
  it('Messe mit Checkliste, Kosten, Kontakten ins CRM, öffentliche Anmeldung', async () => {
    const e = await admin.post('/api/events', { name: 'Hannover Messe 2027', kind: 'fair', startDate: '2027-04-12', endDate: '2027-04-16', budget: 20000 });
    let d = await admin.get(`/api/events/${e.id}`);
    expect(d.checklist.length).toBeGreaterThan(5);
    await admin.post(`/api/events/${e.id}/costs`, { text: 'Standfläche', amount: 8000 });
    const l = await admin.post(`/api/events/${e.id}/leads`, { name: 'Jana Neu', company: 'Neukunde GmbH', email: 'jana@neu.de', rating: 'hot', interest: 'Prüfstand' });
    await admin.post(`/api/events/${e.id}/leads`, { name: 'Tom Alt', company: 'Kunde Service AG' });
    const r = await admin.post(`/api/events/leads/${l.id}/to-crm`, {});
    const a = await admin.get(`/api/crm/accounts/${r.accountId}`);
    expect(a).toMatchObject({ name: 'Neukunde GmbH', status: 'prospect' });
    expect(a.contacts[0]).toMatchObject({ lastName: 'Neu', email: 'jana@neu.de' });
    d = await admin.get(`/api/events/${e.id}`);
    const tom = d.leadList.find((x: any) => x.name === 'Tom Alt');
    expect((await admin.post(`/api/events/leads/${tom.id}/to-crm`, {})).accountId).toBe(acc.id);
    d = await admin.get(`/api/events/${e.id}`);
    expect(d).toMatchObject({ costs: 8000, leads: 2, costPerLead: 4000 });
    // eigene Veranstaltung mit Anmeldung
    const w = await admin.post('/api/events', { name: 'Hausmesse', kind: 'event', startDate: '2027-05-20', endDate: '2027-05-20', maxAttendees: 3 });
    await admin.patch(`/api/events/${w.id}`, { registrationOpen: true });
    const wd = await admin.get(`/api/events/${w.id}`);
    const token = wd.publicUrl.split('/event/')[1];
    expect((await anon('POST', `/api/pub/event/${token}`, { name: 'Gast Eins', email: 'g1@x.de', persons: 2 })).statusCode).toBe(200);
    expect((await anon('POST', `/api/pub/event/${token}`, { name: 'Gast Zwei', email: 'g2@x.de', persons: 2 })).statusCode).toBe(400);
    expect(JSON.parse((await anon('GET', `/api/pub/event/${token}`)).body).seatsLeft).toBe(1);
  });
});
