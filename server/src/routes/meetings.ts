/**
 * Meetings: Videokonferenzen planen, mit Einladung im Kalender und Gast-Link.
 * Ein Meeting hat eine eigene Unterhaltung (Art „meeting“); der Videoanruf läuft über dieselbe Technik wie Chat-Anrufe.
 * Gäste brauchen kein Benutzerkonto: Name eingeben, ggf. im Warteraum auf Einlass warten, dann beitreten.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { sha256 } from '../lib/crypto';
import { buildIcs } from '../lib/ical';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { sendMail } from '../services/mail';
import { activeCall } from '../services/calls';
import { iceServers } from './chat';

interface MeetingRow {
  id: string; title: string; description: string; starts_at: Date; ends_at: Date; host_id: string; channel_id: string; event_id: string | null;
  project_id: string | null; crm_account_id: string | null; guest_token: string; guests_allowed: boolean; lobby: boolean; pin: string | null; cancelled_at: Date | null;
}

const token = () => randomBytes(18).toString('base64url');

export default async function meetingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, config } = ctx;
  const guestUrl = (m: { guest_token: string }) => `${config.publicUrl}/meet/${m.guest_token}`;
  const fmt = (d: Date) => d.toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function load(id: string) {
    const [m] = await sql<MeetingRow[]>`select * from meetings where id = ${id}`;
    if (!m) throw notFound('Meeting nicht gefunden');
    return m;
  }
  async function access(u: AuthUser, m: MeetingRow, manage = false) {
    if (m.host_id === u.id || u.role === 'admin') return true;
    if (manage) throw forbidden('Nur der Organisator kann das Meeting ändern');
    const [mem] = await sql`select 1 from chat_members where channel_id = ${m.channel_id} and user_id = ${u.id}`;
    if (!mem) throw forbidden();
    return false;
  }

  const select = sql`m.id, m.title, m.description, m.starts_at as "startsAt", m.ends_at as "endsAt", m.host_id as "hostId", h.display_name as "hostName",
    m.channel_id as "channelId", m.project_id as "projectId", p.number as "projectNumber", m.crm_account_id as "crmAccountId", a.name as "crmAccountName",
    m.guests_allowed as "guestsAllowed", m.lobby, m.pin is not null as "hasPin", m.cancelled_at as "cancelledAt", m.guest_token as "guestToken",
    (select id from calls cl where cl.channel_id = m.channel_id and cl.ended_at is null and cl.started_at > now() - interval '12 hours' limit 1) is not null as live,
    (select count(*)::int from meeting_guests g where g.meeting_id = m.id and g.status = 'waiting') as waiting`;
  const from = sql`meetings m join users h on h.id = m.host_id left join projects p on p.id = m.project_id left join crm_accounts a on a.id = m.crm_account_id`;
  const decorate = (r: any) => ({ ...r, guestUrl: `${config.publicUrl}/meet/${r.guestToken}` });

  app.get('/meetings', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ upcoming: z.coerce.boolean().optional(), past: z.coerce.boolean().optional() }), req.query);
    const rows = await sql`select ${select} from ${from}
      where (m.host_id = ${u.id} or exists (select 1 from chat_members cm where cm.channel_id = m.channel_id and cm.user_id = ${u.id}))
      ${q.upcoming ? sql`and m.ends_at > now() - interval '30 minutes' and m.cancelled_at is null` : sql``}
      ${q.past ? sql`and m.ends_at <= now()` : sql``}
      order by ${q.past ? sql`m.starts_at desc` : sql`m.starts_at`} limit 200`;
    return rows.map(decorate);
  });

  app.get('/meetings/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await load(id);
    const isHost = await access(u, m);
    const [row] = await sql`select ${select} from ${from} where m.id = ${id}`;
    const participants = await sql`select u.id, u.display_name as "displayName", coalesce(a.response, 'pending') as response from chat_members cm join users u on u.id = cm.user_id
      left join calendar_attendees a on a.event_id = ${m.event_id} and a.user_id = u.id where cm.channel_id = ${m.channel_id} order by u.display_name`;
    const invitees = await sql`select email, name, invited_at as "invitedAt" from meeting_invitees where meeting_id = ${id} order by email`;
    const guests = await sql`select id, name, status, joined_at as "joinedAt" from meeting_guests where meeting_id = ${id} and status in ('waiting', 'admitted') order by joined_at`;
    return { ...decorate(row), isHost, participants, invitees, guests, pin: isHost ? m.pin : undefined };
  });

  const body = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(''),
    startsAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(5).max(24 * 60).default(60),
    participantIds: z.array(z.string().uuid()).max(200).default([]),
    invitees: z.array(z.object({ email: z.string().email(), name: z.string().max(120).default('') })).max(100).default([]),
    guestsAllowed: z.boolean().default(true),
    lobby: z.boolean().default(true),
    pin: z.string().regex(/^\d{4,8}$/, 'PIN: 4 bis 8 Ziffern').nullable().default(null),
    projectId: z.string().uuid().nullable().default(null),
    crmAccountId: z.string().uuid().nullable().default(null),
    sendInvites: z.boolean().default(true),
  });

  async function inviteText(m: MeetingRow, hostName: string) {
    const company = (await ctx.settings.get('company')).name;
    return `Guten Tag,\n\n${hostName} lädt Sie zu einer Videokonferenz ein:\n\n${m.title}\n${fmt(m.starts_at)} (${Math.round((m.ends_at.getTime() - m.starts_at.getTime()) / 60000)} Minuten)\n\n`
      + `Zum Beitreten diesen Link im Browser öffnen (Chrome, Edge, Firefox oder Safari – keine Installation nötig):\n${guestUrl(m)}\n`
      + (m.pin ? `PIN: ${m.pin}\n` : '') + (m.description ? `\n${m.description}\n` : '') + `\nMit freundlichen Grüßen\n${hostName}\n${company}\n`;
  }

  /** Einladungen an Externe per E-Mail (mit Kalenderdatei) – ohne eingerichtetes E-Mail-Konto wird nur der Link angezeigt */
  async function sendInvites(m: MeetingRow, hostName: string, emails?: string[]) {
    const rows = await sql<{ email: string; name: string }[]>`select email, name from meeting_invitees where meeting_id = ${m.id} ${emails ? sql`and email = any(${emails})` : sql`and invited_at is null`}`;
    if (!rows.length) return { sent: 0, error: null as string | null };
    const ics = buildIcs(m.title, [{ uid: `meeting-${m.id}@aperioplan`, summary: m.title, description: `Beitreten: ${guestUrl(m)}`, location: guestUrl(m), start: m.starts_at, end: m.ends_at, allDay: false }]);
    const path = `.aperio/tmp/meeting-${m.id}.ics`;
    await ctx.storage.write(path, (await import('node:stream')).Readable.from([Buffer.from(ics)]));
    const text = await inviteText(m, hostName);
    let sent = 0, error: string | null = null;
    for (const r of rows) {
      try {
        await sendMail(ctx, { to: r.name ? `"${r.name.replace(/"/g, '')}" <${r.email}>` : r.email, subject: `Einladung: ${m.title} – ${fmt(m.starts_at)}`, text, attachments: [{ path, name: 'Einladung.ics' }] });
        await sql`update meeting_invitees set invited_at = now() where meeting_id = ${m.id} and email = ${r.email}`;
        sent++;
      } catch (e) { error = (e as Error).message; break; }
    }
    return { sent, error };
  }

  /** Teilnehmer, Kalendertermin und Einladungen abgleichen */
  async function syncPeople(u: AuthUser, m: MeetingRow, participantIds: string[], notifyNew: boolean) {
    const ids = [...new Set([m.host_id, ...participantIds])];
    const before = (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${m.channel_id}`).map((r) => r.user_id);
    await sql`delete from chat_members where channel_id = ${m.channel_id} and not (user_id = any(${ids}))`;
    for (const id of ids) await sql`insert into chat_members (channel_id, user_id, last_read_at) values (${m.channel_id}, ${id}, now()) on conflict do nothing`;
    if (m.event_id) {
      await sql`delete from calendar_attendees where event_id = ${m.event_id} and not (user_id = any(${ids}))`;
      for (const id of ids) if (id !== m.host_id) await sql`insert into calendar_attendees (event_id, user_id) values (${m.event_id}, ${id}) on conflict do nothing`;
    }
    const added = ids.filter((id) => !before.includes(id) && id !== u.id);
    if (notifyNew && added.length) await notify(ctx, added, { kind: 'calendar.invite', title: `Einladung zum Meeting: ${m.title}`, body: fmt(m.starts_at), link: `/meetings/${m.id}` }, u.id);
  }

  app.post('/meetings', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(body, req.body);
    const start = new Date(b.startsAt), end = new Date(start.getTime() + b.durationMinutes * 60000);
    const m = await sql.begin(async (tx) => {
      const [ch] = await tx<{ id: string }[]>`insert into chat_channels (kind, name, icon, created_by) values ('meeting', ${b.title}, 'video', ${u.id}) returning id`;
      const t = token();
      const [ev] = await tx<{ id: string }[]>`insert into calendar_events (owner_id, title, description, location, starts_at, ends_at, project_id, crm_account_id, reminder_minutes)
        values (${u.id}, ${b.title}, ${`${b.description}\n\nVideokonferenz: ${config.publicUrl}/meet/${t}`.trim()}, 'Videokonferenz (AperioPlan)', ${start}, ${end}, ${b.projectId}, ${b.crmAccountId}, 10) returning id`;
      const [row] = await tx<MeetingRow[]>`insert into meetings (title, description, starts_at, ends_at, host_id, channel_id, event_id, project_id, crm_account_id, guest_token, guests_allowed, lobby, pin)
        values (${b.title}, ${b.description}, ${start}, ${end}, ${u.id}, ${ch!.id}, ${ev!.id}, ${b.projectId}, ${b.crmAccountId}, ${t}, ${b.guestsAllowed}, ${b.lobby}, ${b.pin}) returning *`;
      for (const i of b.invitees) await tx`insert into meeting_invitees (meeting_id, email, name) values (${row!.id}, ${i.email.toLowerCase()}, ${i.name}) on conflict do nothing`;
      return row!;
    });
    await syncPeople(u, m, b.participantIds, true);
    const mail = b.sendInvites && b.invitees.length ? await sendInvites(m, u.displayName) : { sent: 0, error: null };
    await audit(sql, u, { action: 'meeting.create', entityType: 'meeting', entityId: m.id, projectId: b.projectId, summary: `Meeting „${b.title}“ am ${fmt(start)} geplant` });
    for (const id of [m.host_id, ...b.participantIds]) ctx.hub.toUser(id, 'meetings.changed', {});
    return { id: m.id, guestUrl: guestUrl(m), invitesSent: mail.sent, warning: mail.error ? `Einladungen nicht versendet: ${mail.error}. Den Gast-Link können Sie kopieren und selbst verschicken.` : undefined };
  });

  app.patch('/meetings/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await load(id);
    await access(u, m, true);
    const b = parse(body.partial(), req.body);
    const start = b.startsAt ? new Date(b.startsAt) : m.starts_at;
    const end = b.durationMinutes ? new Date(start.getTime() + b.durationMinutes * 60000) : new Date(start.getTime() + (m.ends_at.getTime() - m.starts_at.getTime()));
    const [n] = await sql<MeetingRow[]>`update meetings set title = coalesce(${b.title ?? null}, title), description = coalesce(${b.description ?? null}, description),
      starts_at = ${start}, ends_at = ${end}, guests_allowed = coalesce(${b.guestsAllowed ?? null}, guests_allowed), lobby = coalesce(${b.lobby ?? null}, lobby),
      pin = ${b.pin === undefined ? sql`pin` : b.pin}, project_id = ${b.projectId === undefined ? sql`project_id` : b.projectId},
      crm_account_id = ${b.crmAccountId === undefined ? sql`crm_account_id` : b.crmAccountId}, updated_at = now() where id = ${id} returning *`;
    if (n!.event_id) await sql`update calendar_events set title = ${n!.title}, starts_at = ${start}, ends_at = ${end}, reminded_at = null, updated_at = now() where id = ${n!.event_id}`;
    await sql`update chat_channels set name = ${n!.title} where id = ${n!.channel_id}`;
    if (b.participantIds) await syncPeople(u, n!, b.participantIds, true);
    let mail = { sent: 0, error: null as string | null };
    if (b.invitees) {
      const emails = b.invitees.map((i) => i.email.toLowerCase());
      await sql`delete from meeting_invitees where meeting_id = ${id} and not (email = any(${emails}))`;
      for (const i of b.invitees) await sql`insert into meeting_invitees (meeting_id, email, name) values (${id}, ${i.email.toLowerCase()}, ${i.name}) on conflict (meeting_id, email) do update set name = excluded.name`;
      if (b.sendInvites !== false) mail = await sendInvites(n!, u.displayName);
    }
    const timeChanged = start.getTime() !== m.starts_at.getTime();
    if (timeChanged) {
      const others = (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${m.channel_id}`).map((r) => r.user_id);
      await notify(ctx, others, { kind: 'calendar.update', title: `Meeting verschoben: ${n!.title}`, body: fmt(start), link: `/meetings/${id}` }, u.id);
    }
    return { ok: true, invitesSent: mail.sent, warning: mail.error ? `Einladungen nicht versendet: ${mail.error}` : undefined };
  });

  app.delete('/meetings/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await load(id);
    await access(u, m, true);
    const others = (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${m.channel_id}`).map((r) => r.user_id);
    await sql`update meetings set cancelled_at = now() where id = ${id}`;
    if (m.event_id) await sql`delete from calendar_events where id = ${m.event_id}`;
    await notify(ctx, others, { kind: 'calendar.cancel', title: `Meeting abgesagt: ${m.title}`, body: fmt(m.starts_at), link: '/meetings' }, u.id);
    await audit(sql, u, { action: 'meeting.cancel', entityType: 'meeting', entityId: id, projectId: m.project_id, summary: `Meeting „${m.title}“ abgesagt` });
    return { ok: true };
  });

  app.post('/meetings/:id/invite', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await load(id);
    await access(u, m);
    const b = parse(z.object({ emails: z.array(z.string().email()).min(1).max(100) }), req.body);
    for (const e of b.emails) await sql`insert into meeting_invitees (meeting_id, email) values (${id}, ${e.toLowerCase()}) on conflict do nothing`;
    const r = await sendInvites(m, u.displayName, b.emails.map((e) => e.toLowerCase()));
    if (r.error) throw badRequest(`E-Mail-Versand nicht möglich: ${r.error}`);
    return { sent: r.sent };
  });

  /** Neuer Gast-Link (alter Link wird ungültig) */
  app.post('/meetings/:id/new-link', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await load(id);
    await access(u, m, true);
    const t = token();
    await sql`update meetings set guest_token = ${t} where id = ${id}`;
    if (m.event_id) await sql`update calendar_events set description = replace(description, ${m.guest_token}, ${t}) where id = ${m.event_id}`;
    return { guestUrl: `${config.publicUrl}/meet/${t}` };
  });

  // ------------------------------------------------ Warteraum: Gäste einlassen
  for (const action of ['admit', 'deny', 'remove'] as const) {
    app.post(`/meetings/:id/guests/:guestId/${action}`, async (req) => {
      const u = requireUser(req);
      const p = parse(z.object({ id: z.string().uuid(), guestId: z.string().uuid() }), req.params);
      const m = await load(p.id);
      await access(u, m);
      const status = action === 'admit' ? 'admitted' : action === 'deny' ? 'denied' : 'left';
      const [g] = await sql<{ id: string; name: string }[]>`update meeting_guests set status = ${status}, admitted_at = ${action === 'admit' ? new Date() : sql`admitted_at`}
        where id = ${p.guestId} and meeting_id = ${p.id} returning id, name`;
      if (!g) throw notFound();
      if (action === 'remove') {
        for (const c of ctx.hub.clientsIn(`call:${m.channel_id}`)) if (c.userId === g.id) { c.channels.delete(`call:${m.channel_id}`); c.socket.close(4403, 'removed'); }
        ctx.hub.publish(`call:${m.channel_id}`, 'call.left', { userId: g.id });
      }
      ctx.hub.publish(`meeting:${m.id}`, 'meeting.lobby', {});
      return { ok: true };
    });
  }

  // ------------------------------------------------ Öffentlich: Gast-Seite (ohne Anmeldung)
  async function byToken(t: string) {
    const [m] = await sql<MeetingRow[]>`select * from meetings where guest_token = ${t}`;
    const { installed } = await ctx.settings.get('apps');
    if (!m || !installed.includes('meetings')) throw notFound('Dieser Link ist nicht (mehr) gültig');
    return m;
  }
  async function guestAuth(m: MeetingRow, q: { guest: string; key: string }) {
    const [g] = await sql<{ id: string; name: string; status: string }[]>`select id, name, status from meeting_guests where id = ${q.guest} and meeting_id = ${m.id} and key_hash = ${sha256(q.key)}`;
    if (!g) throw forbidden('Zugang ungültig – bitte erneut beitreten');
    return g;
  }
  const guestQuery = z.object({ guest: z.string().uuid(), key: z.string().min(10).max(100) });

  app.get('/meet/:token', async (req) => {
    const { token: t } = parse(z.object({ token: z.string().max(60) }), req.params);
    const m = await byToken(t);
    const [h] = await sql<{ display_name: string }[]>`select display_name from users where id = ${m.host_id}`;
    const company = await ctx.settings.get('company');
    return { title: m.title, startsAt: m.starts_at, endsAt: m.ends_at, hostName: h?.display_name ?? '', company: company.name, needsPin: Boolean(m.pin),
      guestsAllowed: m.guests_allowed, lobby: m.lobby, cancelled: Boolean(m.cancelled_at) };
  });

  app.post('/meet/:token/join', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { token: t } = parse(z.object({ token: z.string().max(60) }), req.params);
    const m = await byToken(t);
    const b = parse(z.object({ name: z.string().trim().min(2, 'Bitte Ihren Namen angeben').max(80), pin: z.string().max(10).optional() }), req.body);
    if (m.cancelled_at) throw badRequest('Dieses Meeting wurde abgesagt');
    if (!m.guests_allowed) throw forbidden('Für dieses Meeting sind keine Gäste zugelassen');
    if (m.pin && b.pin !== m.pin) throw forbidden('Die PIN stimmt nicht');
    if (Date.now() > m.ends_at.getTime() + 6 * 3600_000) throw badRequest('Dieses Meeting ist bereits vorbei');
    const key = randomBytes(24).toString('base64url');
    const [g] = await sql<{ id: string; status: string }[]>`insert into meeting_guests (meeting_id, name, key_hash, status, admitted_at)
      values (${m.id}, ${b.name}, ${sha256(key)}, ${m.lobby ? 'waiting' : 'admitted'}, ${m.lobby ? null : new Date()}) returning id, status`;
    if (m.lobby) {
      const people = (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${m.channel_id}`).map((r) => r.user_id);
      ctx.hub.publish(`meeting:${m.id}`, 'meeting.lobby', { name: b.name });
      for (const id of people) ctx.hub.toUser(id, 'meeting.lobby', { meetingId: m.id, title: m.title, name: b.name });
    }
    return { guest: g!.id, key, status: g!.status };
  });

  app.get('/meet/:token/status', async (req) => {
    const { token: t } = parse(z.object({ token: z.string().max(60) }), req.params);
    const q = parse(guestQuery, req.query);
    const m = await byToken(t);
    const g = await guestAuth(m, q);
    if (g.status !== 'admitted') return { status: g.status };
    // Anruf bereitstellen (Gastgeber ist der Organisator)
    let call = await activeCall(ctx, m.channel_id);
    if (!call) {
      await sql`insert into calls (channel_id, started_by) values (${m.channel_id}, ${m.host_id})`;
      call = await activeCall(ctx, m.channel_id);
    }
    const [c] = await sql<{ started_at: Date }[]>`select started_at from calls where id = ${call!.id}`;
    return { status: 'admitted', name: g.name, channelId: m.channel_id, callId: call!.id, hostId: m.host_id, startedAt: c?.started_at, iceServers: iceServers(ctx), title: m.title };
  });

  app.post('/meet/:token/leave', async (req) => {
    const { token: t } = parse(z.object({ token: z.string().max(60) }), req.params);
    const q = parse(guestQuery, req.body);
    const m = await byToken(t);
    const g = await guestAuth(m, q);
    await sql`update meeting_guests set status = 'left', left_at = now() where id = ${g.id} and status <> 'denied'`;
    ctx.hub.publish(`meeting:${m.id}`, 'meeting.lobby', {});
    return { ok: true };
  });

  app.get('/meet/:token/messages', async (req) => {
    const { token: t } = parse(z.object({ token: z.string().max(60) }), req.params);
    const q = parse(guestQuery.extend({ callId: z.string().uuid() }), req.query);
    const m = await byToken(t);
    const g = await guestAuth(m, q);
    if (g.status !== 'admitted') throw forbidden();
    return sql`select m.id, m.user_id as "userId", coalesce(u.display_name, m.guest_name || ' (Gast)') as "userName", m.body, m.attachments, m.kind, m.meta, m.call_id as "callId",
      m.created_at as "createdAt", '[]'::json as reactions from chat_messages m left join users u on u.id = m.user_id
      where m.call_id = ${q.callId} and m.channel_id = ${m.channel_id} and m.kind = 'message' and m.deleted_at is null order by m.created_at`;
  });

  app.post('/meet/:token/messages', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token: t } = parse(z.object({ token: z.string().max(60) }), req.params);
    const b = parse(guestQuery.extend({ callId: z.string().uuid(), body: z.string().trim().min(1).max(4000) }), req.body);
    const m = await byToken(t);
    const g = await guestAuth(m, b);
    if (g.status !== 'admitted') throw forbidden();
    const [call] = await sql`select 1 from calls where id = ${b.callId} and channel_id = ${m.channel_id}`;
    if (!call) throw badRequest('Anruf nicht gefunden');
    const [msg] = await sql`insert into chat_messages (channel_id, user_id, guest_name, body, call_id) values (${m.channel_id}, null, ${g.name}, ${b.body}, ${b.callId})
      returning id, user_id as "userId", guest_name || ' (Gast)' as "userName", body, attachments, kind, meta, call_id as "callId", created_at as "createdAt", '[]'::json as reactions`;
    ctx.hub.publish(`call:${m.channel_id}`, 'call.message', { ...msg, guestId: g.id });
    return msg;
  });
}

/** Für den Echtzeit-Kanal: Gast anhand von Schlüssel prüfen */
export async function resolveGuest(ctx: AppContext, guest: string, key: string) {
  if (!/^[0-9a-f-]{36}$/.test(guest)) return null;
  const [g] = await ctx.sql<{ id: string; name: string; status: string; channel_id: string; meeting_id: string }[]>`select g.id, g.name, g.status, m.channel_id, m.id as meeting_id
    from meeting_guests g join meetings m on m.id = g.meeting_id where g.id = ${guest} and g.key_hash = ${sha256(key)} and m.cancelled_at is null`;
  return g && g.status === 'admitted' ? g : null;
}
