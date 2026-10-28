/**
 * Stempeluhr mit gesetzlichen Regeln: Warnungen, automatische Pflichtpause, feste Betriebspausen,
 * Ruhezeit beim Einstempeln und automatisches Ausstempeln bei vergessener Stempelung.
 */
import { evaluateDay, requiredBreak, ruleSetFor, DEFAULT_TIME_RULES, type TimeRuleSettings } from '@aperio/shared';
import type { AppContext } from '../context';
import { notify } from './notify';

const TZ = () => process.env.TZ || 'Europe/Berlin';

/** Beginn des heutigen Tages (Ortszeit) */
export function dayStart(d = new Date()): Date {
  const local = new Date(d.toLocaleString('en-US', { timeZone: TZ() }));
  const diff = d.getTime() - local.getTime();
  local.setHours(0, 0, 0, 0);
  return new Date(local.getTime() + diff);
}

/** Uhrzeit "HH:MM" am Tag von `ref` (Ortszeit) als Zeitpunkt */
export function atTime(ref: Date, hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  return new Date(dayStart(ref).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60000);
}

export async function timeRules(ctx: AppContext): Promise<TimeRuleSettings> {
  return { ...DEFAULT_TIME_RULES, ...((await ctx.settings.get('timeRules')) ?? {}) };
}

async function ruleSetOf(ctx: AppContext, userId: string) {
  const s = await timeRules(ctx);
  const [u] = await ctx.sql<{ department_id: string | null }[]>`select department_id from users where id = ${userId}`;
  return { settings: s, set: ruleSetFor(s, u?.department_id), departmentId: u?.department_id ?? null };
}

/** Arbeitsabschnitte eines Tages (laufende Buchung bis jetzt) */
async function workOfDay(ctx: AppContext, userId: string, from: Date, now = new Date()) {
  const to = new Date(from.getTime() + 86400000);
  const rows = await ctx.sql<{ started_at: Date; ended_at: Date | null }[]>`select started_at, ended_at from time_entries
    where user_id = ${userId} and started_at < ${to} and coalesce(ended_at, now()) > ${from} order by started_at`;
  return rows.map((r) => ({ start: Math.max(r.started_at.getTime(), from.getTime()), end: Math.min((r.ended_at ?? now).getTime(), to.getTime(), now.getTime()) })).filter((i) => i.end > i.start);
}

/** Einmal-Hinweis je Tag und Art */
async function once(ctx: AppContext, userId: string, kind: string): Promise<boolean> {
  const r = await ctx.sql`insert into time_warnings (user_id, day, kind) values (${userId}, ${dayStart().toISOString().slice(0, 10)}, ${kind}) on conflict do nothing returning 1`;
  return r.length > 0;
}

/**
 * Pause in die Buchungen einfügen: die Buchung, die den Zeitpunkt enthält, wird geteilt;
 * Buchungen, die in der Pause beginnen, starten erst nach der Pause.
 */
export async function insertBreak(ctx: AppContext, userId: string, at: Date, minutes: number, kind: 'legal' | 'scheduled', rule: string, note: string) {
  const end = new Date(at.getTime() + minutes * 60000);
  await ctx.sql.begin(async (tx) => {
    const covering = await tx<{ id: string; started_at: Date; ended_at: Date | null; project_id: string | null; task_id: string | null; note: string; source: string }[]>`
      select id, started_at, ended_at, project_id, task_id, note, source from time_entries
      where user_id = ${userId} and started_at < ${end} and coalesce(ended_at, 'infinity') > ${at} order by started_at for update`;
    for (const e of covering) {
      const s = e.started_at, en = e.ended_at;
      if (s < at) {
        // vorne kürzen, den Rest nach der Pause fortsetzen
        await tx`update time_entries set ended_at = ${at}, updated_at = now() where id = ${e.id}`;
        if (!en || en > end) await tx`insert into time_entries (user_id, project_id, task_id, started_at, ended_at, note, source) values (${userId}, ${e.project_id}, ${e.task_id}, ${end}, ${en}, ${e.note}, ${e.source})`;
      } else if (!en || en > end) {
        await tx`update time_entries set started_at = ${end}, updated_at = now() where id = ${e.id}`;
      } else {
        await tx`delete from time_entries where id = ${e.id}`;
      }
    }
    await tx`insert into time_breaks (user_id, starts_at, ends_at, kind, rule, note) values (${userId}, ${at}, ${end}, ${kind}, ${rule}, ${note})`;
  });
  ctx.hub.toUser(userId, 'time.changed', null);
}

/** Regeln für einen Mitarbeiter prüfen (läuft jede Minute für alle Eingestempelten und beim Ausstempeln) */
export async function checkUser(ctx: AppContext, userId: string, now = new Date()) {
  const { settings, set, departmentId } = await ruleSetOf(ctx, userId);
  const from = dayStart(now);
  // feste Betriebspausen
  const wd = ((new Date(now.toLocaleString('en-US', { timeZone: TZ() })).getDay() + 6) % 7) + 1; // 1 = Montag
  for (const sb of settings.scheduledBreaks) {
    if (!sb.weekdays.includes(wd) || (sb.teamIds.length && (!departmentId || !sb.teamIds.includes(departmentId)))) continue;
    const s = atTime(now, sb.start), e = atTime(now, sb.end);
    if (now < e || e <= s) continue;
    const [done] = await ctx.sql`select 1 from time_breaks where user_id = ${userId} and kind = 'scheduled' and rule = ${sb.id} and starts_at >= ${from}`;
    if (done) continue;
    const work = await workOfDay(ctx, userId, from, now);
    // nur wenn durchgehend gestempelt; wer in der Nähe selbst Pause gemacht hat, bekommt keine doppelte
    if (!work.some((i) => i.start <= s.getTime() && i.end >= e.getTime())) continue;
    const near = work.slice(1).some((i, k) => {
      const gapStart = work[k]!.end, gapEnd = i.start;
      return gapEnd - gapStart >= e.getTime() - s.getTime() && gapEnd > s.getTime() - 3600000 && gapStart < e.getTime() + 3600000;
    });
    if (near) continue;
    await insertBreak(ctx, userId, s, (e.getTime() - s.getTime()) / 60000, 'scheduled', sb.id, sb.name);
  }
  if (!set) return;
  const work = await workOfDay(ctx, userId, from, now);
  if (!work.length) return;
  const ev = evaluateDay(set, work);
  // automatische Pflichtpause, sobald die Schwelle überschritten ist
  if (settings.autoBreaks && ev.missingBreak > 0 && ev.breakAt && ev.breakAt <= now.getTime()) {
    await insertBreak(ctx, userId, new Date(ev.breakAt), ev.missingBreak, 'legal', set.id, `Gesetzliche Pause (${set.source})`);
    await notify(ctx, [userId], { kind: 'time.break', title: `${ev.missingBreak} Minuten Pause automatisch eingetragen`,
      body: `Nach mehr als ${Math.floor(ev.workMinutes / 60)} Stunden ohne ausreichende Pause (${set.source}). Verschieben per Korrekturanfrage.`, link: '/time' });
    return;
  }
  const running = (await ctx.sql`select 1 from time_entries where user_id = ${userId} and ended_at is null`).length > 0;
  if (!running) return;
  // Vorwarnung: Pause bald fällig
  const soon = ev.workMinutes + set.warnBeforeMinutes;
  if (requiredBreak(set, soon) > ev.breakMinutes && requiredBreak(set, ev.workMinutes) <= ev.breakMinutes && (await once(ctx, userId, `pause-${requiredBreak(set, soon)}`)))
    await notify(ctx, [userId], { kind: 'time.warning', title: `In ${set.warnBeforeMinutes} Minuten ist eine Pause fällig`,
      body: `Du bist seit ${Math.floor(ev.workMinutes / 60)} Std. ${ev.workMinutes % 60} Min. eingestempelt.`, link: '/time' });
  // Vorwarnung Höchstarbeitszeit
  if (ev.workMinutes >= set.maxDailyHours * 60 - 30 && (await once(ctx, userId, 'max')))
    await notify(ctx, [userId], { kind: 'time.warning', title: ev.overMax ? 'Höchstarbeitszeit überschritten' : 'Noch 30 Minuten bis zur Höchstarbeitszeit',
      body: `Erlaubt sind ${set.maxDailyHours} Stunden am Tag (${set.source}).`, link: '/time' });
}

/** Ruhezeit beim Einstempeln prüfen – Rückgabe: Hinweistext oder null */
export async function restWarning(ctx: AppContext, userId: string): Promise<string | null> {
  const { set } = await ruleSetOf(ctx, userId);
  if (!set?.restHours) return null;
  const [last] = await ctx.sql<{ ended_at: Date }[]>`select ended_at from time_entries where user_id = ${userId} and ended_at is not null order by ended_at desc limit 1`;
  if (!last) return null;
  const rest = (Date.now() - last.ended_at.getTime()) / 3600000;
  if (rest >= set.restHours || rest < 1) return null; // unter 1 Std. = Unterbrechung am selben Tag
  return `Ruhezeit von ${set.restHours} Std. noch nicht erreicht (erst ${Math.floor(rest)} Std. ${Math.round((rest % 1) * 60)} Min. seit dem letzten Ausstempeln)`;
}

/** Vergessenes Ausstempeln: nach X Stunden automatisch beenden und Korrektur vorschlagen */
export async function autoClockOut(ctx: AppContext) {
  const { autoClockOutHours } = await timeRules(ctx);
  if (!autoClockOutHours) return;
  const rows = await ctx.sql<{ id: string; user_id: string; started_at: Date }[]>`update time_entries set ended_at = started_at + make_interval(hours => ${autoClockOutHours}), auto_closed = true, updated_at = now()
    where ended_at is null and started_at < now() - make_interval(hours => ${autoClockOutHours}) returning id, user_id, started_at`;
  for (const r of rows) {
    ctx.hub.toUser(r.user_id, 'time.changed', null);
    await notify(ctx, [r.user_id], { kind: 'time.autoclose', title: 'Ausstempeln vergessen?',
      body: `Die Stempeluhr lief seit ${r.started_at.toLocaleString('de-DE', { timeZone: TZ(), dateStyle: 'short', timeStyle: 'short' })} und wurde nach ${autoClockOutHours} Stunden beendet. Bitte die richtige Zeit per Korrektur nachtragen.`,
      link: `/time?correct=${r.id}` });
  }
}

/** Jede Minute: alle Eingestempelten prüfen */
export async function checkAllRunning(ctx: AppContext) {
  await autoClockOut(ctx);
  const users = await ctx.sql<{ user_id: string }[]>`select user_id from time_entries where ended_at is null or ended_at > now() - interval '2 minutes'`;
  for (const u of users) { try { await checkUser(ctx, u.user_id); } catch { /* nächster */ } }
}

/** Monatsübersicht für die Teamleitung: Tage mit Verstößen */
export async function violations(ctx: AppContext, userIds: string[], monthStart: Date, monthEnd: Date) {
  const s = await timeRules(ctx);
  const users = await ctx.sql<{ id: string; display_name: string; department_id: string | null }[]>`select id, display_name, department_id from users where id = any(${userIds})`;
  const out: { userId: string; userName: string; day: string; kind: string; detail: string }[] = [];
  for (const u of users) {
    const set = ruleSetFor(s, u.department_id);
    if (!set) continue;
    const rows = await ctx.sql<{ started_at: Date; ended_at: Date }[]>`select started_at, ended_at from time_entries where user_id = ${u.id} and ended_at is not null
      and started_at < ${monthEnd} and ended_at > ${monthStart} order by started_at`;
    const byDay = new Map<string, { start: number; end: number }[]>();
    for (const r of rows) {
      const k = r.started_at.toLocaleDateString('sv-SE', { timeZone: TZ() });
      byDay.set(k, [...(byDay.get(k) ?? []), { start: r.started_at.getTime(), end: r.ended_at.getTime() }]);
    }
    let prevEnd: number | null = null;
    for (const [day, work] of [...byDay.entries()].sort()) {
      const ev = evaluateDay(set, work);
      if (ev.overMax) out.push({ userId: u.id, userName: u.display_name, day, kind: 'max', detail: `${(ev.workMinutes / 60).toFixed(1)} Std. gearbeitet (erlaubt ${set.maxDailyHours})` });
      if (ev.missingBreak > 0) out.push({ userId: u.id, userName: u.display_name, day, kind: 'break', detail: `${ev.breakMinutes} von ${ev.requiredBreak} Min. Pause` });
      const first = Math.min(...work.map((w) => w.start));
      if (prevEnd && (first - prevEnd) / 3600000 < set.restHours) out.push({ userId: u.id, userName: u.display_name, day, kind: 'rest', detail: `nur ${((first - prevEnd) / 3600000).toFixed(1)} Std. Ruhezeit (vorgeschrieben ${set.restHours})` });
      prevEnd = Math.max(...work.map((w) => w.end));
    }
  }
  return out;
}
