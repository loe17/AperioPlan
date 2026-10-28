import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lohnsteuer } from '@aperio/shared';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { testOutbox } from '../src/services/mail';
import { workedHours } from '../src/services/payroll';

let env: TestEnv;
let admin: Client;
beforeAll(async () => {
  env = await setup(); admin = await adminClient(env.app);
  await admin.post('/api/apps/payroll/install', {});
  testOutbox.enabled = true;
});
afterAll(async () => { testOutbox.enabled = false; await env.close(); });

const bin = async (url: string, cookie = admin.cookie) => env.app.inject({ method: 'GET', url, headers: { cookie } });

describe('Lohnabrechnung', () => {
  it('Zeiterfassung: Nacht-, Sonntags- und Feiertagsstunden', async () => {
    const { id } = await userClient(env.app, admin, 'zeit.test');
    const { sql } = env.ctx;
    await sql`insert into holidays (day, name) values ('2026-10-03', 'Tag der Deutschen Einheit') on conflict do nothing`;
    // Fr 2.10. 18–23 Uhr (3 Std. Nacht), Sa 3.10. Feiertag 8–12, So 4.10. 10–14 mit 30 Min. Pause
    await sql`insert into time_entries (user_id, started_at, ended_at, source) values
      (${id}, '2026-10-02 18:00 Europe/Berlin', '2026-10-02 23:00 Europe/Berlin', 'manual'),
      (${id}, '2026-10-03 08:00 Europe/Berlin', '2026-10-03 12:00 Europe/Berlin', 'manual'),
      (${id}, '2026-10-04 10:00 Europe/Berlin', '2026-10-04 14:00 Europe/Berlin', 'manual')`;
    await sql`insert into time_breaks (user_id, starts_at, ends_at, kind) values (${id}, '2026-10-04 12:00 Europe/Berlin', '2026-10-04 12:30 Europe/Berlin', 'legal')`;
    const h = await workedHours(env.ctx, id, 2026, 10);
    expect(h).toEqual({ total: 12.5, night: 3, sunday: 3.5, holiday: 4 });
  });

  it('Personalstamm, Monatsabrechnung, Festschreiben, Lohnzettel, Übergabe', async () => {
    const { client: max, id: maxId } = await userClient(env.app, admin, 'max.lohn');
    // Normale Mitarbeiter sehen keine Löhne
    await max.get('/api/payroll/employees', 403);
    expect(await max.get('/api/me/payslips')).toEqual([]);

    await admin.put('/api/settings/invoicing', { legalName: 'Muster GmbH', street: 'Weg 1', zip: '78120', city: 'Furtwangen' });
    const { added } = await admin.post('/api/payroll/employees/from-users', {});
    expect(added).toBeGreaterThanOrEqual(2);
    const list = await admin.get('/api/payroll/employees');
    const emp = list.find((e: any) => e.userId === maxId);
    expect(emp.personnelNo).toMatch(/^10\d\d$/);
    await admin.patch(`/api/payroll/employees/${emp.id}`, { firstName: 'Max', lastName: 'Lohn', salary: 4000, iban: 'DE89370400440532013000', email: 'max@example.de', healthInsurer: 'AOK BW',
      recurring: [{ kind: 'deduction', label: 'Vermögenswirksame Leistung', qty: 1, rate: 40 }], profile: { church: true, pvChildless: true, kvZusatz: 2.9 } });
    // Patch ändert nur die genannten Felder
    const e2 = await admin.get(`/api/payroll/employees/${emp.id}`);
    expect(e2).toMatchObject({ salary: 4000, payType: 'salary', active: true, profile: { church: true, taxClass: 1, state: 'BW' } });
    const mini = await admin.post('/api/payroll/employees', { firstName: 'Mia', lastName: 'Mini', payType: 'hourly', hourlyRate: 13.9, iban: 'DE02120300000000202051', profile: { group: 'minijob' } });
    // andere Benutzer ohne Gehalt herausnehmen
    for (const e of list) if (e.id !== emp.id) await admin.patch(`/api/payroll/employees/${e.id}`, { active: false });

    const run = await admin.post('/api/payroll/runs', { year: 2026, month: 1 });
    await admin.post('/api/payroll/runs', { year: 2026, month: 1 }, 400);
    let r = await admin.get(`/api/payroll/runs/${run.id}`);
    expect(r.slips).toHaveLength(2);
    const sMax = r.slips.find((s: any) => s.employeeId === emp.id);
    const sMini = r.slips.find((s: any) => s.employeeId === mini.id);
    // Max: Gehalt + Abzug; Lohnsteuer nach PAP, Kirchensteuer 8 %
    const lst = lohnsteuer(2026, { LZZ: 2, RE4: 400000, STKL: 1, KVZ: 2.9, PVZ: 1, R: 1 });
    expect(sMax.result.tax.lst).toBe(lst.LSTLZZ / 100);
    expect(sMax.result.tax.church).toBe(Math.floor(lst.BK * 0.08) / 100);
    expect(sMax.result.an).toMatchObject({ kv: 350, pv: 96, rv: 372, av: 52 });
    expect(sMax.payout).toBeCloseTo(sMax.net - 40, 2);
    // Mia: Stunden eintragen
    await admin.patch(`/api/payroll/slips/${sMini.id}`, { lines: [{ kind: 'hours', label: 'Stundenlohn', qty: 40, rate: 13.9 }] });
    r = await admin.get(`/api/payroll/runs/${run.id}`);
    const m = r.slips.find((s: any) => s.employeeId === mini.id);
    expect(m.result).toMatchObject({ minijob: true, gross: 556, payout: 556 });
    expect(m.result.ag.rv).toBe(83.4);

    // Vorschau-PDF im Entwurf, Februar erst nach Festschreiben des Januars
    expect((await bin(`/api/payroll/slips/${sMax.id}/pdf`)).headers['content-type']).toBe('application/pdf');
    await admin.post('/api/payroll/runs', { year: 2026, month: 2 }, 400);
    await admin.post(`/api/payroll/runs/${run.id}/finalize`, {});
    await admin.patch(`/api/payroll/slips/${sMini.id}`, { lines: [] }, 400);

    // Mitarbeiter sieht seinen Lohnzettel
    const mine = await max.get('/api/me/payslips');
    expect(mine).toHaveLength(1);
    const pdf = await bin(`/api/me/payslips/${mine[0].id}/pdf`, max.cookie);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await bin(`/api/me/payslips/${m.id}/pdf`, max.cookie)).statusCode).toBe(404);

    // Versand, Beitragsnachweis, Journal, DATEV, SEPA
    testOutbox.messages.length = 0;
    const sent = await admin.post(`/api/payroll/runs/${run.id}/send`, {});
    expect(sent).toEqual({ sent: 1, missing: [expect.any(String)] });
    expect(testOutbox.messages[0]!.to).toBe('max@example.de');
    const sum = await admin.get(`/api/payroll/runs/${run.id}/summary`);
    expect(sum.sv[0]).toMatchObject({ name: 'AOK BW', kv: 700, rv: 744, count: 1 });
    expect(sum.minijob).toMatchObject({ count: 1, kv: 72.28 });
    expect(sum.tax.lst).toBe(lst.LSTLZZ / 100);
    expect(sum.svDue).toBe('2026-01-28');
    const xl = await bin(`/api/payroll/runs/${run.id}/journal.xlsx`);
    expect(xl.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const dv = (await bin(`/api/payroll/runs/${run.id}/datev.csv`)).rawPayload.toString('latin1');
    expect(dv.startsWith('"EXTF";700;21;"Buchungsstapel"')).toBe(true);
    expect(dv).toContain('"Lohn Januar Lohn');
    const sepa = await env.app.inject({ method: 'POST', url: `/api/payroll/runs/${run.id}/sepa`, headers: { cookie: admin.cookie }, payload: { debtorIban: 'DE02120300000000202051', execDate: '2026-01-29' } });
    expect(sepa.statusCode).toBe(200);
    expect(sepa.body).toContain('<NbOfTxs>2</NbOfTxs>');

    // Februar: Weihnachtsgeld-Test mit bisherigen Jahreswerten
    const feb = await admin.post('/api/payroll/runs', { year: 2026, month: 2 });
    const fr = await admin.get(`/api/payroll/runs/${feb.id}`);
    const fm = fr.slips.find((s: any) => s.employeeId === emp.id);
    await admin.patch(`/api/payroll/slips/${fm.id}`, { lines: [...fm.lines, { kind: 'bonus', label: 'Prämie', qty: 1, rate: 1000 }] });
    const fr2 = await admin.get(`/api/payroll/runs/${feb.id}`);
    const fm2 = fr2.slips.find((s: any) => s.employeeId === emp.id);
    expect(fm2.result.taxOneOff).toBe(1000);
    expect(fm2.result.tax.lst).toBeGreaterThan(sMax.result.tax.lst);
    // Wieder öffnen nur durch Admin und nicht, wenn ein späterer Monat festgeschrieben ist
    await admin.post(`/api/payroll/runs/${feb.id}/finalize`, {});
    await admin.post(`/api/payroll/runs/${run.id}/reopen`, {}, 400);
    await max.post(`/api/payroll/runs/${feb.id}/reopen`, {}, 403);
    await admin.post(`/api/payroll/runs/${feb.id}/reopen`, {});
    expect((await admin.get(`/api/payroll/runs/${feb.id}`)).status).toBe('draft');
  });
});
