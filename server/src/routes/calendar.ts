/**
 * Eigene Termine mit Einladungen, Wiederholung, Erinnerung und Ressourcenbuchung;
 * Abgleich mit dem Kalender des E-Mail-Kontos (CalDAV / .ics-Abo) und persönlicher Abo-Link für Outlook oder das Handy.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { notify } from '../services/notify';
import { sealSecret } from '../services/secrets';
import { buildIcs, expandOccurrences, type IcsEvent, type Recurrence } from '../lib/ical';
import { deleteRemoteEvent, discoverCalendar, pushEvent, syncAccount, type CalendarAccount } from '../services/caldav';

const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'] as const;

const eventBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).default(''),
  location: z.string().max(300).default(''),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  allDay: z.boolean().default(false),
  projectId: z.string().uuid().nullable().default(null),
  private: z.boolean().default(false),
  recurrence: z.enum(RECURRENCES).default('none'),
  recurrenceUntil: z.string().date().nullable().default(null),
  reminderMinutes: z.number().int().min(0).max(40320).nullable().default(null),
  attendeeIds: z.array(z.string().uuid()).max(200).default([]),
  bookingId: z.string().uuid().nullable().default(null),
  accountId: z.string().uuid().nullable().default(null),
});

interface EventRow {
  id: string; owner_id: string; title: string; description: string; location: string; starts_at: Date; ends_at: Date; all_day: boolean;
  project_id: string | null; private: boolean; recurrence: Recurrence; recurrence_until: string | null; reminder_minutes: number | null;
  booking_id: string | null; account_id: string | null; external_uid: string | null; external_href: string | null; external_etag: string | null;
}

const fmt = (d: Date) => d.toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default async function calendarRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  const eventCols = sql`e.id, e.owner_id as "ownerId", o.display_name as "ownerName", e.title, e.description, e.location, e.starts_at as "startsAt",
    e.ends_at as "endsAt", e.all_day as "allDay", e.project_id as "projectId", p.number as "projectNumber", e.private, e.recurrence,
    e.recurrence_until::text as "recurrenceUntil", e.reminder_minutes as "reminderMinutes", e.booking_id as "bookingId", e.account_id as "accountId",
    ca.name as "accountName", coalesce(ca.color, '') as "accountColor", (ca.kind = 'ics') as "readOnly",
    r.name as "resourceName", b.status as "bookingStatus",
    coalesce((select json_agg(json_build_object('userId', a.user_id, 'displayName', u.display_name, 'response', a.response) order by u.display_name)
      from calendar_attendees a join users u on u.id = a.user_id where a.event_id = e.id), '[]') as attendees`;
  const eventFrom = sql`calendar_events e join users o on o.id = e.owner_id left join projects p on p.id = e.project_id
    left join calendar_accounts ca on ca.id = e.account_id left join resource_bookings b on b.id = e.booking_id left join resources r on r.id = b.resource_id`;

  /** Termine in Einzeltermine je Wiederholung auflösen */
  function expand(rows: Record<string, unknown>[], from: Date, to: Date) {
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const occ = expandOccurrences({ start: new Date(r.startsAt as string), end: new Date(r.endsAt as string), recurrence: r.recurrence as Recurrence, until: r.recurrenceUntil as string | null, allDay: r.allDay as boolean }, from, to);
      for (const o of occ) out.push({ ...r, startsAt: o.start, endsAt: o.end, occurrence: o.start.toISOString() });
    }
    return out.sort((a, b) => new Date(a.startsAt as string).getTime() - new Date(b.startsAt as string).getTime());
  }

  const rangeQuery = z.object({ from: z.string(), to: z.string(), teamId: z.string().uuid().optional() });
  const inRange = (from: Date, to: Date) => sql`(e.starts_at < ${to} and (e.ends_at > ${from} or e.recurrence <> 'none'))
    and (e.recurrence_until is null or e.recurrence_until >= ${from}::date)`;

  async function loadEvent(id: string) {
    const [e] = await sql<EventRow[]>`select * from calendar_events where id = ${id}`;
    if (!e) throw notFound('Termin nicht gefunden');
    return e;
  }
  const canEdit = (u: AuthUser, e: EventRow) => e.owner_id === u.id || u.role === 'admin';

  async function loadAccount(u: AuthUser, id: string) {
    const [a] = await sql<CalendarAccount[]>`select * from calendar_accounts where id = ${id} and user_id = ${u.id}`;
    if (!a) throw notFound('Kalender-Konto nicht gefunden');
    return a;
  }

  /** Änderungen an das verbundene Konto weitergeben – Fehler melden, aber den Termin hier behalten */
  async function pushIfLinked(u: AuthUser, id: string): Promise<string | null> {
    const e = await loadEvent(id);
    if (!e.account_id) return null;
    const [acc] = await sql<CalendarAccount[]>`select * from calendar_accounts where id = ${e.account_id}`;
    if (!acc || acc.kind !== 'caldav' || acc.user_id !== u.id) return null;
    try { await pushEvent(ctx, acc, e); return null; } catch (err) { return (err as Error).message; }
  }

  // ------------------------------------------------ Termine
  app.get('/calendar/events', async (req) => {
    const u = requireUser(req);
    const q = parse(rangeQuery, req.query);
    const from = new Date(q.from), to = new Date(q.to);
    const rows = await sql`select ${eventCols}, (e.owner_id = ${u.id}) as mine,
        (select response from calendar_attendees a where a.event_id = e.id and a.user_id = ${u.id}) as "myResponse"
      from ${eventFrom}
      where ${inRange(from, to)} and (e.owner_id = ${u.id} or exists (select 1 from calendar_attendees a where a.event_id = e.id and a.user_id = ${u.id} and a.response <> 'declined'))`;
    return expand(rows, from, to);
  });

  /** Termine der Kollegen: private Termine nur als „belegt“ */
  app.get('/calendar/team/events', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const q = parse(rangeQuery, req.query);
    const from = new Date(q.from), to = new Date(q.to);
    const rows = await sql`select e.id, e.owner_id as "ownerId", o.display_name as "ownerName", e.starts_at as "startsAt", e.ends_at as "endsAt", e.all_day as "allDay",
        e.recurrence, e.recurrence_until::text as "recurrenceUntil",
        case when e.private and e.owner_id <> ${u.id} then 'Belegt' else e.title end as title,
        case when e.private and e.owner_id <> ${u.id} then '' else e.location end as location, e.private
      from calendar_events e join users o on o.id = e.owner_id
      where ${inRange(from, to)} and o.deleted_at is null
      ${q.teamId ? sql`and exists (select 1 from team_members tm where tm.team_id = ${q.teamId} and tm.user_id = e.owner_id)` : sql``}`;
    return expand(rows, from, to);
  });

  app.get('/calendar/events/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [e] = await sql`select ${eventCols} from ${eventFrom} where e.id = ${id}
      and (e.owner_id = ${u.id} or ${u.role === 'admin'} or exists (select 1 from calendar_attendees a where a.event_id = e.id and a.user_id = ${u.id}))`;
    if (!e) throw notFound('Termin nicht gefunden');
    return e;
  });

  async function setAttendees(u: AuthUser, eventId: string, ids: string[], title: string, start: Date) {
    const before = (await sql<{ user_id: string }[]>`select user_id from calendar_attendees where event_id = ${eventId}`).map((r) => r.user_id);
    const want = [...new Set(ids)].filter((x) => x !== u.id);
    await sql`delete from calendar_attendees where event_id = ${eventId} and not (user_id = any(${want}))`;
    const added = want.filter((x) => !before.includes(x));
    for (const uid of added) await sql`insert into calendar_attendees (event_id, user_id) values (${eventId}, ${uid}) on conflict do nothing`;
    await notify(ctx, added, { kind: 'calendar.invite', title: `Einladung: ${title}`, body: `${u.displayName} lädt ein – ${fmt(start)}`, link: `/calendar?event=${eventId}` }, u.id);
    return added;
  }

  app.post('/calendar/events', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(eventBody, req.body);
    const start = new Date(b.startsAt), end = new Date(b.endsAt);
    if (end < start) throw badRequest('Das Ende muss nach dem Beginn liegen');
    if (b.projectId) await projectAccess(sql, u, b.projectId);
    if (b.bookingId) {
      const [bk] = await sql`select 1 from resource_bookings where id = ${b.bookingId} and user_id = ${u.id}`;
      if (!bk) throw badRequest('Buchung nicht gefunden');
    }
    let accountId = b.accountId;
    if (accountId) { const acc = await loadAccount(u, accountId); if (acc.kind !== 'caldav') throw badRequest('In einen Abo-Kalender kann nicht geschrieben werden'); }
    else accountId = (await sql<{ id: string }[]>`select id from calendar_accounts where user_id = ${u.id} and kind = 'caldav' and push_new order by created_at limit 1`)[0]?.id ?? null;
    const [e] = await sql<{ id: string }[]>`insert into calendar_events (owner_id, title, description, location, starts_at, ends_at, all_day, project_id, private,
        recurrence, recurrence_until, reminder_minutes, booking_id, account_id)
      values (${u.id}, ${b.title}, ${b.description}, ${b.location}, ${start}, ${end}, ${b.allDay}, ${b.projectId}, ${b.private},
        ${b.recurrence}, ${b.recurrenceUntil}, ${b.reminderMinutes}, ${b.bookingId}, ${accountId}) returning id`;
    await setAttendees(u, e!.id, b.attendeeIds, b.title, start);
    const syncError = await pushIfLinked(u, e!.id);
    return { id: e!.id, syncError };
  });

  app.patch('/calendar/events/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const e = await loadEvent(id);
    if (!canEdit(u, e)) throw forbidden('Nur der Organisator ändert den Termin');
    if (e.account_id) {
      const [acc] = await sql<{ kind: string }[]>`select kind from calendar_accounts where id = ${e.account_id}`;
      if (acc?.kind === 'ics') throw forbidden('Termine aus einem Abo-Kalender sind nur lesbar');
    }
    const b = parse(patchSchema(eventBody), req.body);
    const start = b.startsAt ? new Date(b.startsAt) : e.starts_at, end = b.endsAt ? new Date(b.endsAt) : e.ends_at;
    if (end < start) throw badRequest('Das Ende muss nach dem Beginn liegen');
    if (b.projectId) await projectAccess(sql, u, b.projectId);
    await sql`update calendar_events set title = coalesce(${b.title ?? null}, title), description = coalesce(${b.description ?? null}, description),
      location = coalesce(${b.location ?? null}, location), starts_at = ${start}, ends_at = ${end}, all_day = coalesce(${b.allDay ?? null}, all_day),
      project_id = ${b.projectId === undefined ? sql`project_id` : b.projectId}, private = coalesce(${b.private ?? null}, private),
      recurrence = coalesce(${b.recurrence ?? null}, recurrence), recurrence_until = ${b.recurrenceUntil === undefined ? sql`recurrence_until` : b.recurrenceUntil},
      reminder_minutes = ${b.reminderMinutes === undefined ? sql`reminder_minutes` : b.reminderMinutes},
      booking_id = ${b.bookingId === undefined ? sql`booking_id` : b.bookingId},
      reminded_at = case when ${start} <> starts_at then null else reminded_at end, updated_at = now() where id = ${id}`;
    if (b.attendeeIds) await setAttendees(u, id, b.attendeeIds, b.title ?? e.title, start);
    const moved = start.getTime() !== e.starts_at.getTime() || end.getTime() !== e.ends_at.getTime();
    if (moved) {
      const att = (await sql<{ user_id: string }[]>`select user_id from calendar_attendees where event_id = ${id}`).map((r) => r.user_id);
      await sql`update calendar_attendees set response = 'pending' where event_id = ${id}`;
      await notify(ctx, att, { kind: 'calendar.moved', title: `Termin verschoben: ${b.title ?? e.title}`, body: `neu: ${fmt(start)}`, link: `/calendar?event=${id}` }, u.id);
    }
    return { ok: true, syncError: await pushIfLinked(u, id) };
  });

  app.delete('/calendar/events/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const e = await loadEvent(id);
    if (!canEdit(u, e)) throw forbidden('Nur der Organisator löscht den Termin');
    const att = (await sql<{ user_id: string }[]>`select user_id from calendar_attendees where event_id = ${id} and response <> 'declined'`).map((r) => r.user_id);
    let syncError: string | null = null;
    if (e.account_id && e.external_href) {
      const [acc] = await sql<CalendarAccount[]>`select * from calendar_accounts where id = ${e.account_id}`;
      if (acc?.kind === 'ics') throw forbidden('Termine aus einem Abo-Kalender sind nur lesbar');
      if (acc) try { await deleteRemoteEvent(ctx, acc, e.external_href, e.external_etag); } catch (err) { syncError = (err as Error).message; }
    }
    if (e.booking_id) await sql`update resource_bookings set status = 'cancelled', updated_at = now() where id = ${e.booking_id} and status in ('pending', 'approved')`;
    await sql`delete from calendar_events where id = ${id}`;
    await notify(ctx, att, { kind: 'calendar.cancelled', title: `Termin abgesagt: ${e.title}`, body: fmt(e.starts_at) }, u.id);
    if (e.booking_id) ctx.hub.publish('global', 'resources.changed', {});
    return { ok: true, syncError };
  });

  app.post('/calendar/events/:id/respond', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ response: z.enum(['accepted', 'declined', 'pending']) }), req.body);
    const e = await loadEvent(id);
    const [a] = await sql`update calendar_attendees set response = ${b.response} where event_id = ${id} and user_id = ${u.id} returning 1`;
    if (!a) throw notFound('Sie sind zu diesem Termin nicht eingeladen');
    if (b.response !== 'pending')
      await notify(ctx, [e.owner_id], { kind: 'calendar.response', title: `${u.displayName} hat ${b.response === 'accepted' ? 'zugesagt' : 'abgesagt'}: ${e.title}`, body: fmt(e.starts_at), link: `/calendar?event=${id}` }, u.id);
    return { ok: true };
  });

  // ------------------------------------------------ Kalender des E-Mail-Kontos
  const accountBody = z.object({
    kind: z.enum(['caldav', 'ics']),
    name: z.string().trim().min(1).max(80),
    url: z.string().trim().regex(/^(https?|webcal):\/\//i, 'Adresse muss mit https:// (oder webcal://) beginnen'),
    username: z.string().max(200).default(''),
    password: z.string().max(500).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0ea5e9'),
    pushNew: z.boolean().default(false),
  });
  const accountCols = sql`id, kind, name, url, username, color, push_new as "pushNew", last_sync_at as "lastSyncAt", last_error as "lastError",
    (select count(*)::int from calendar_events e where e.account_id = calendar_accounts.id) as "eventCount"`;

  app.get('/calendar/accounts', async (req) => {
    const u = requireUser(req);
    return sql`select ${accountCols} from calendar_accounts where user_id = ${u.id} order by created_at`;
  });

  app.post('/calendar/accounts', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(accountBody, req.body);
    const sealed = b.password ? await sealSecret(ctx, b.password) : '';
    const tmp = { id: 'test', user_id: u.id, kind: b.kind, name: b.name, url: b.url, username: b.username, password_sealed: sealed, color: b.color, push_new: b.pushNew } as CalendarAccount;
    // erst prüfen, dann speichern – so landen keine kaputten Konten in der Liste
    if (b.kind === 'caldav') {
      try { await discoverCalendar(ctx, tmp); } catch (e) { throw badRequest(`Verbindung fehlgeschlagen: ${(e as Error).message}`); }
    }
    const [a] = await sql<CalendarAccount[]>`insert into calendar_accounts (user_id, kind, name, url, username, password_sealed, color, push_new)
      values (${u.id}, ${b.kind}, ${b.name}, ${b.url}, ${b.username}, ${sealed}, ${b.color}, ${b.pushNew}) returning *`;
    let result: { count: number } | { error: string };
    try { result = await syncAccount(ctx, a!); } catch (e) { result = { error: (e as Error).message }; }
    return { id: a!.id, ...result };
  });

  app.patch('/calendar/accounts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadAccount(u, id);
    const b = parse(patchSchema(accountBody).omit({ kind: true }), req.body);
    const sealed = b.password ? await sealSecret(ctx, b.password) : null;
    await sql`update calendar_accounts set name = coalesce(${b.name ?? null}, name), url = coalesce(${b.url ?? null}, url),
      username = coalesce(${b.username ?? null}, username), password_sealed = coalesce(${sealed}, password_sealed),
      color = coalesce(${b.color ?? null}, color), push_new = coalesce(${b.pushNew ?? null}, push_new) where id = ${id}`;
    return { ok: true };
  });

  app.delete('/calendar/accounts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadAccount(u, id);
    // Kopien der Termine aus dem Konto verschwinden; hier angelegte Termine bleiben erhalten
    await sql`update calendar_events set account_id = null, external_uid = null, external_href = null, external_etag = null
      where account_id = ${id} and external_uid like '%@aperioplan'`;
    await sql`delete from calendar_accounts where id = ${id}`;
    return { ok: true };
  });

  app.post('/calendar/accounts/:id/sync', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const acc = await loadAccount(u, id);
    try { return await syncAccount(ctx, acc); } catch (e) { throw badRequest(`Abgleich fehlgeschlagen: ${(e as Error).message}`); }
  });

  // ------------------------------------------------ Persönlicher Abo-Link (Outlook, Handy)
  app.get('/me/ical', async (req) => {
    const u = requireUser(req);
    let [row] = await sql<{ ical_token: string | null }[]>`select ical_token from users where id = ${u.id}`;
    if (!row?.ical_token) [row] = await sql<{ ical_token: string }[]>`update users set ical_token = ${randomBytes(24).toString('base64url')} where id = ${u.id} returning ical_token`;
    return { path: `/api/ical/${row!.ical_token}.ics` };
  });

  app.post('/me/ical/reset', async (req) => {
    const u = requireUser(req);
    const [row] = await sql<{ ical_token: string }[]>`update users set ical_token = ${randomBytes(24).toString('base64url')} where id = ${u.id} returning ical_token`;
    return { path: `/api/ical/${row!.ical_token}.ics` };
  });

  app.get('/ical/:file', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { file } = parse(z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{20,64}\.ics$/) }), req.params);
    const token = file.slice(0, -4);
    const [user] = await sql<{ id: string; display_name: string }[]>`select id, display_name from users where ical_token = ${token} and active and deleted_at is null`;
    if (!user) throw notFound();
    const from = new Date(Date.now() - 90 * 86400000), to = new Date(Date.now() + 400 * 86400000);
    const events: IcsEvent[] = [];
    const own = await sql<EventRow[]>`select e.* from calendar_events e where (e.owner_id = ${user.id} or exists (select 1 from calendar_attendees a where a.event_id = e.id and a.user_id = ${user.id} and a.response <> 'declined'))
      and e.account_id is null and e.starts_at < ${to} and (e.ends_at > ${from} or e.recurrence <> 'none')`;
    for (const e of own) events.push({ uid: `${e.id}@aperioplan`, summary: e.title, description: e.description, location: e.location, start: e.starts_at, end: e.ends_at, allDay: e.all_day, private: e.private, recurrence: e.recurrence, until: e.recurrence_until });
    const tasks = await sql<{ id: string; title: string; due_date: string; number: number; pnum: string }[]>`select t.id, t.title, t.due_date::text, t.number, p.number as pnum
      from tasks t join projects p on p.id = t.project_id where t.assignee_id = ${user.id} and t.status <> 'done' and t.due_date between ${from}::date and ${to}::date`;
    for (const t of tasks) { const d = new Date(`${t.due_date}T00:00:00Z`); events.push({ uid: `task-${t.id}@aperioplan`, summary: `Frist: ${t.pnum} P${t.number} ${t.title}`, start: d, end: new Date(d.getTime() + 86400000), allDay: true }); }
    const abs = await sql<{ id: string; kind: string; start_date: string; end_date: string }[]>`select id, kind, start_date::text, end_date::text from absences
      where user_id = ${user.id} and status = 'approved' and end_date >= ${from}::date and start_date <= ${to}::date`;
    for (const a of abs) events.push({ uid: `abs-${a.id}@aperioplan`, summary: a.kind === 'vacation' ? 'Urlaub' : 'Abwesend', start: new Date(`${a.start_date}T00:00:00Z`), end: new Date(new Date(`${a.end_date}T00:00:00Z`).getTime() + 86400000), allDay: true });
    const bookings = await sql<{ id: string; starts_at: Date; ends_at: Date; name: string; title: string }[]>`select b.id, b.starts_at, b.ends_at, r.name, b.title from resource_bookings b join resources r on r.id = b.resource_id
      where b.user_id = ${user.id} and b.status = 'approved' and b.starts_at < ${to} and b.ends_at > ${from}
      and not exists (select 1 from calendar_events e where e.booking_id = b.id)`;
    for (const b of bookings) events.push({ uid: `bk-${b.id}@aperioplan`, summary: `${b.name}${b.title ? `: ${b.title}` : ''}`, location: b.name, start: b.starts_at, end: b.ends_at, allDay: false });
    reply.header('content-type', 'text/calendar; charset=utf-8').header('cache-control', 'no-cache');
    return buildIcs(`AperioPlan – ${user.display_name}`, events);
  });
}

/** Erinnerungen an Termine (läuft jede Minute) */
export async function sendCalendarReminders(ctx: AppContext) {
  const rows = await ctx.sql<EventRow[]>`select * from calendar_events where reminder_minutes is not null
    and starts_at < now() + interval '400 days' and (ends_at > now() - interval '1 day' or recurrence <> 'none')`;
  const now = Date.now();
  for (const e of rows) {
    const next = expandOccurrences({ start: e.starts_at, end: e.ends_at, recurrence: e.recurrence, until: e.recurrence_until, allDay: e.all_day }, new Date(now), new Date(now + 8 * 86400000), 'Europe/Berlin', 1)[0];
    if (!next || next.start.getTime() < now) continue;
    const due = next.start.getTime() - e.reminder_minutes! * 60000;
    if (due > now) continue;
    const [{ reminded_at: done } = { reminded_at: null }] = await ctx.sql<{ reminded_at: Date | null }[]>`select reminded_at from calendar_events where id = ${e.id}`;
    if (done && done.getTime() >= next.start.getTime()) continue;
    await ctx.sql`update calendar_events set reminded_at = ${next.start} where id = ${e.id}`;
    const att = (await ctx.sql<{ user_id: string }[]>`select user_id from calendar_attendees where event_id = ${e.id} and response <> 'declined'`).map((r) => r.user_id);
    await notify(ctx, [e.owner_id, ...att], { kind: 'calendar.reminder', title: `Erinnerung: ${e.title}`, body: `${fmt(next.start)}${e.location ? ` · ${e.location}` : ''}`, link: `/calendar?event=${e.id}` });
  }
}
