import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateDay, TIME_RULE_TEMPLATES } from '@aperio/shared';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { autoClockOut, checkUser, dayStart } from '../src/services/timeRules';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

const H = 3600000;
describe('Regeln', () => {
  const de = TIME_RULE_TEMPLATES.find((t) => t.id === 'de')!;
  const ch = TIME_RULE_TEMPLATES.find((t) => t.id === 'ch')!;
  it('Deutschland: 30 Min. ab mehr als 6 Std., 45 ab mehr als 9; Abschnitte unter 15 Min. zählen nicht', () => {
    const t0 = Date.UTC(2026, 0, 5, 7);
    expect(evaluateDay(de, [{ start: t0, end: t0 + 6 * H }]).missingBreak).toBe(0);
    const r = evaluateDay(de, [{ start: t0, end: t0 + 7 * H }]);
    expect(r).toMatchObject({ requiredBreak: 30, missingBreak: 30, breakAt: t0 + 6 * H });
    const withShort = evaluateDay(de, [{ start: t0, end: t0 + 4 * H }, { start: t0 + 4 * H + 10 * 60000, end: t0 + 8 * H }]);
    expect(withShort.missingBreak).toBe(30);
    expect(evaluateDay(de, [{ start: t0, end: t0 + 5 * H }, { start: t0 + 5.5 * H, end: t0 + 10.5 * H }]).missingBreak).toBe(15);
    expect(evaluateDay(de, [{ start: t0, end: t0 + 11 * H }]).overMax).toBe(true);
  });
  it('Schweiz gestaffelt', () => {
    const t0 = Date.UTC(2026, 0, 5, 7);
    expect(evaluateDay(ch, [{ start: t0, end: t0 + 6 * H }]).requiredBreak).toBe(15);
    expect(evaluateDay(ch, [{ start: t0, end: t0 + 9.5 * H }]).requiredBreak).toBe(60);
  });
});

describe('Stempeluhr mit Regeln', () => {
  it('trägt die Pflichtpause automatisch ein und teilt die Buchung', async () => {
    await admin.post('/api/time/rules/import', { template: 'de' });
    const { client: c, id } = await userClient(env.app, admin, 'zeit-max');
    const now = new Date();
    const start = new Date(Math.max(dayStart(now).getTime(), now.getTime() - 7 * H));
    if (now.getTime() - start.getTime() < 6.5 * H) return; // kurz nach Mitternacht nicht prüfbar
    await env.ctx.sql`insert into time_entries (user_id, started_at, source) values (${id}, ${start}, 'clock')`;
    await checkUser(env.ctx, id, now);
    const entries = await env.ctx.sql<{ started_at: Date; ended_at: Date | null }[]>`select started_at, ended_at from time_entries where user_id = ${id} order by started_at`;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.ended_at!.getTime() - start.getTime()).toBe(6 * H);
    expect(entries[1]!.started_at.getTime() - entries[0]!.ended_at!.getTime()).toBe(30 * 60000);
    const me = await c.get('/api/time/rules/me');
    expect(me.breaks[0].kind).toBe('legal');
    expect(me.today.missingBreak).toBe(0);
    expect(JSON.stringify(await c.get('/api/notifications'))).toContain('Pause automatisch eingetragen');
  });

  it('feste Betriebspause, nur wenn durchgehend gestempelt', async () => {
    const { id } = await userClient(env.app, admin, 'zeit-vesper');
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: process.env.TZ || 'Europe/Berlin' }));
    const mins = local.getHours() * 60 + local.getMinutes();
    if (mins < 90) return;
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const s = await admin.get('/api/settings');
    const wd = ((local.getDay() + 6) % 7) + 1;
    await admin.put('/api/settings/timeRules', { ...s.timeRules, autoBreaks: false, scheduledBreaks: [{ id: 'v', name: 'Vesper', start: hm(mins - 60), end: hm(mins - 45), weekdays: [wd], teamIds: [] }] });
    await env.ctx.sql`insert into time_entries (user_id, started_at, source) values (${id}, ${new Date(now.getTime() - 80 * 60000)}, 'clock')`;
    await checkUser(env.ctx, id, now);
    const [b] = await env.ctx.sql`select kind, note from time_breaks where user_id = ${id}`;
    expect(b).toMatchObject({ kind: 'scheduled', note: 'Vesper' });
    await checkUser(env.ctx, id, now);
    expect((await env.ctx.sql`select 1 from time_breaks where user_id = ${id}`).length).toBe(1);
  });

  it('vergessenes Ausstempeln und Ruhezeit beim Einstempeln', async () => {
    const { client: c, id } = await userClient(env.app, admin, 'zeit-vergessen');
    await env.ctx.sql`insert into time_entries (user_id, started_at, source) values (${id}, now() - interval '14 hours', 'clock')`;
    await autoClockOut(env.ctx);
    const [e] = await env.ctx.sql<{ auto_closed: boolean; ended_at: Date }[]>`select auto_closed, ended_at from time_entries where user_id = ${id}`;
    expect(e!.auto_closed).toBe(true);
    expect(JSON.stringify(await c.get('/api/notifications'))).toContain('Ausstempeln vergessen');
    // vor 2 Stunden ausgestempelt → Ruhezeit-Hinweis
    await env.ctx.sql`update time_entries set ended_at = now() - interval '2 hours' where user_id = ${id}`;
    const r = await c.post('/api/time/clock-in', {});
    expect(r.warning).toMatch(/Ruhezeit/);
  });

  it('Monatsübersicht zeigt Verstöße', async () => {
    const { id } = await userClient(env.app, admin, 'zeit-lang');
    await env.ctx.sql`insert into time_entries (user_id, started_at, ended_at, source) values (${id}, '2026-03-02 06:00+00', '2026-03-02 17:30+00', 'manual')`;
    const v = await admin.get('/api/time/violations?month=2026-03');
    const mine = v.filter((x: any) => x.userId === id).map((x: any) => x.kind).sort();
    expect(mine).toEqual(['break', 'max']);
  });
});
