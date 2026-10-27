/**
 * Projekt-Chat, Team-Chat, Direktnachrichten und Videoanrufe (Kapitel 12).
 * Nachrichten laufen in Echtzeit über den WebSocket-Kanal chat:<id>; Anrufe signalisieren über call:<id>.
 */
import type { FastifyInstance } from 'fastify';
import { posix } from 'node:path';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { notify } from '../services/notify';
import { safeName, storeFile } from '../services/files';

interface Channel { id: string; kind: 'project' | 'direct' | 'team'; project_id: string | null; team_id: string | null; name: string; direct_key: string | null }

export default async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  async function channelAccess(u: AuthUser, id: string): Promise<Channel> {
    const [c] = await sql<Channel[]>`select * from chat_channels where id = ${id}`;
    if (!c) throw notFound('Unterhaltung nicht gefunden');
    if (c.kind === 'project') await projectAccess(sql, u, c.project_id!);
    else if (c.kind === 'team') {
      const [m] = await sql`select 1 from team_members where team_id = ${c.team_id} and user_id = ${u.id}`;
      if (!m && u.role !== 'admin') throw forbidden();
    } else {
      const [m] = await sql`select 1 from chat_members where channel_id = ${id} and user_id = ${u.id}`;
      if (!m) throw forbidden();
    }
    await sql`insert into chat_members (channel_id, user_id, last_read_at) values (${id}, ${u.id}, now() - interval '100 years') on conflict do nothing`;
    return c;
  }

  async function memberIds(c: Channel): Promise<string[]> {
    if (c.kind === 'direct') return (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${c.id}`).map((r) => r.user_id);
    if (c.kind === 'team') return (await sql<{ user_id: string }[]>`select user_id from team_members where team_id = ${c.team_id}`).map((r) => r.user_id);
    return (await sql<{ user_id: string }[]>`select user_id from project_members where project_id = ${c.project_id}
      union select user_id from chat_members where channel_id = ${c.id}`).map((r) => r.user_id);
  }

  app.get('/chat/channels', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    // Team-Kanäle anlegen, falls noch nicht vorhanden
    await sql`insert into chat_channels (kind, team_id, name) select 'team', t.id, t.name from teams t
      where exists (select 1 from team_members tm where tm.team_id = t.id and tm.user_id = ${u.id})
      and not exists (select 1 from chat_channels c where c.kind = 'team' and c.team_id = t.id)`;
    return sql`select c.id, c.kind, c.project_id as "projectId", c.team_id as "teamId",
        case when c.kind = 'direct' then (select us.display_name from chat_members m2 join users us on us.id = m2.user_id where m2.channel_id = c.id and m2.user_id <> ${u.id} limit 1)
             when c.kind = 'project' then p.number || ' ' || p.name else t.name end as name,
        case when c.kind = 'direct' then (select m2.user_id from chat_members m2 where m2.channel_id = c.id and m2.user_id <> ${u.id} limit 1) end as "otherUserId",
        p.icon as "projectIcon",
        (select count(*)::int from chat_messages msg where msg.channel_id = c.id and msg.deleted_at is null and msg.user_id <> ${u.id}
           and msg.created_at > coalesce(m.last_read_at, now() - interval '100 years')) as unread,
        (select max(created_at) from chat_messages msg where msg.channel_id = c.id) as "lastMessageAt",
        (select id from calls cl where cl.channel_id = c.id and cl.ended_at is null and cl.started_at > now() - interval '12 hours' limit 1) as "activeCallId"
      from chat_channels c
      left join chat_members m on m.channel_id = c.id and m.user_id = ${u.id}
      left join projects p on p.id = c.project_id
      left join teams t on t.id = c.team_id
      where (c.kind = 'direct' and m.user_id is not null)
         or (c.kind = 'team' and exists (select 1 from team_members tm where tm.team_id = c.team_id and tm.user_id = ${u.id}))
         or (c.kind = 'project' and p.status <> 'archived' and (exists (select 1 from project_members pm where pm.project_id = c.project_id and pm.user_id = ${u.id}) or m.user_id is not null))
      order by "lastMessageAt" desc nulls last, name`;
  });

  app.post('/chat/direct', async (req) => {
    const u = requireUser(req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    if (userId === u.id) throw badRequest('Bitte einen anderen Mitarbeiter wählen');
    const [other] = await sql`select 1 from users where id = ${userId} and active`;
    if (!other) throw notFound('Mitarbeiter nicht gefunden');
    const key = [u.id, userId].sort().join(':');
    const [existing] = await sql<{ id: string }[]>`select id from chat_channels where direct_key = ${key}`;
    if (existing) return existing;
    const [c] = await sql<{ id: string }[]>`insert into chat_channels (kind, direct_key) values ('direct', ${key}) returning id`;
    await sql`insert into chat_members (channel_id, user_id) values (${c!.id}, ${u.id}), (${c!.id}, ${userId})`;
    return c;
  });

  app.get('/projects/:id/chat', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    let [c] = await sql<{ id: string }[]>`select id from chat_channels where project_id = ${id} and kind = 'project'`;
    if (!c) [c] = await sql<{ id: string }[]>`insert into chat_channels (kind, project_id, name) values ('project', ${id}, '') returning id`;
    return c;
  });

  const msgSelect = sql`m.id, m.channel_id as "channelId", m.user_id as "userId", u.display_name as "userName", m.body, m.attachments,
    m.created_at as "createdAt", m.updated_at as "updatedAt", m.deleted_at as "deletedAt"`;

  app.get('/chat/channels/:id/messages', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }), req.query);
    await channelAccess(u, id);
    const rows = await sql`select ${msgSelect} from chat_messages m left join users u on u.id = m.user_id
      where m.channel_id = ${id} ${q.before ? sql`and m.created_at < ${q.before}` : sql``} order by m.created_at desc limit ${q.limit}`;
    return rows.reverse().map((r) => (r.deletedAt ? { ...r, body: '', attachments: [] } : r));
  });

  app.post('/chat/channels/:id/messages', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      body: z.string().max(20000).default(''),
      attachments: z.array(z.object({ fileId: z.string().uuid(), name: z.string(), size: z.number(), mime: z.string().optional() })).default([]),
    }), req.body);
    if (!b.body.trim() && !b.attachments.length) throw badRequest('Leere Nachricht');
    const c = await channelAccess(u, id);
    const [m] = await sql`insert into chat_messages (channel_id, user_id, body, attachments) values (${id}, ${u.id}, ${b.body}, ${sql.json(b.attachments)})
      returning id`;
    await sql`update chat_members set last_read_at = now() where channel_id = ${id} and user_id = ${u.id}`;
    const [full] = await sql`select ${msgSelect} from chat_messages m left join users u on u.id = m.user_id where m.id = ${m!.id}`;
    ctx.hub.publish(`chat:${id}`, 'message.created', full);
    const members = await memberIds(c);
    for (const uid of members) if (uid !== u.id) ctx.hub.toUser(uid, 'chat.unread', { channelId: id });
    const mentions = [...b.body.matchAll(/@([\w.-]+)/g)].map((x) => x[1]!.toLowerCase());
    const mentioned = mentions.length ? (await sql<{ id: string }[]>`select id from users where lower(username) = any(${mentions})`).map((x) => x.id) : [];
    const targets = c.kind === 'direct' ? members : mentioned;
    const online = ctx.hub.onlineUserIds();
    await notify(ctx, targets.filter((t) => c.kind !== 'direct' || !online.has(t)), {
      kind: 'chat', title: c.kind === 'direct' ? `Nachricht von ${u.displayName}` : `${u.displayName} hat dich im Chat erwähnt`,
      body: b.body.slice(0, 200) || 'Anhang', link: `/chat?channel=${id}`,
    }, u.id);
    return full;
  });

  app.patch('/chat/messages/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(20000) }), req.body);
    const [m] = await sql<{ channel_id: string }[]>`update chat_messages set body = ${b.body}, updated_at = now() where id = ${id} and user_id = ${u.id} and deleted_at is null returning channel_id`;
    if (!m) throw notFound();
    const [full] = await sql`select ${msgSelect} from chat_messages m left join users u on u.id = m.user_id where m.id = ${id}`;
    ctx.hub.publish(`chat:${m.channel_id}`, 'message.updated', full);
    return full;
  });

  app.delete('/chat/messages/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [m] = await sql<{ channel_id: string }[]>`update chat_messages set deleted_at = now() where id = ${id} and (user_id = ${u.id} or ${u.role === 'admin'}) returning channel_id`;
    if (!m) throw notFound();
    ctx.hub.publish(`chat:${m.channel_id}`, 'message.deleted', { id });
    return { ok: true };
  });

  app.post('/chat/channels/:id/read', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await channelAccess(u, id);
    await sql`update chat_members set last_read_at = now() where channel_id = ${id} and user_id = ${u.id}`;
    return { ok: true };
  });

  /** Datei im Chat teilen – landet im Projektordner (03_Doku/Chat) bzw. im allgemeinen Chat-Ordner */
  app.post('/chat/channels/:id/upload', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await channelAccess(u, id);
    let folder = `Chat/${id}`;
    if (c.kind === 'project') {
      const [p] = await sql<{ folder_path: string | null }[]>`select folder_path from projects where id = ${c.project_id}`;
      if (p?.folder_path) folder = `${p.folder_path}/03_Doku/Chat`;
    }
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const f = await storeFile(ctx, { projectId: c.project_id, path: `${folder}/${stamp}_${name}`, stream: part.file, userId: u.id, via: 'Chat' });
      out.push({ fileId: f.id, name, size: f.size, mime: posix.extname(name).slice(1) });
    }
    return out;
  });

  // ------------------------------------------------ Videoanrufe (WebRTC, Signalisierung über WebSocket)
  app.post('/chat/channels/:id/call', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await channelAccess(u, id);
    let [call] = await sql<{ id: string }[]>`select id from calls where channel_id = ${id} and ended_at is null and started_at > now() - interval '12 hours'`;
    if (!call) {
      [call] = await sql<{ id: string }[]>`insert into calls (channel_id, started_by) values (${id}, ${u.id}) returning id`;
      for (const uid of await memberIds(c)) if (uid !== u.id) ctx.hub.toUser(uid, 'call.incoming', { callId: call!.id, channelId: id, from: u.displayName, fromId: u.id });
    }
    // Anruf-Kanal ist an die Unterhaltung gebunden: call:<channelId>
    return { callId: call!.id, channelId: id, iceServers: iceServers(ctx) };
  });

  app.post('/chat/channels/:id/call/end', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await channelAccess(u, id);
    if (ctx.hub.clientsIn(`call:${id}`).length <= 1) {
      await sql`update calls set ended_at = now() where channel_id = ${id} and ended_at is null`;
      ctx.hub.publish(`chat:${id}`, 'call.ended', { channelId: id });
    }
    return { ok: true };
  });

  app.get('/chat/channels/:id/call/participants', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await channelAccess(u, id);
    const ids = [...new Set(ctx.hub.clientsIn(`call:${id}`).map((c) => c.userId))];
    return ids.length ? sql`select id, display_name as "displayName" from users where id = any(${ids})` : [];
  });
}

function iceServers(ctx: AppContext) {
  const list: { urls: string | string[]; username?: string; credential?: string }[] = [];
  if (ctx.config.turnUrls.length) list.push({ urls: ctx.config.turnUrls, username: 'aperio', credential: process.env.TURN_PASSWORD ?? 'aperio' });
  return list;
}
