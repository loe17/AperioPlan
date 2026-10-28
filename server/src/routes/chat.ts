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
import { activeCall, endCallIfEmpty } from '../services/calls';

interface Channel { id: string; kind: 'project' | 'direct' | 'team' | 'group' | 'meeting'; project_id: string | null; team_id: string | null; name: string; direct_key: string | null; created_by: string | null }

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
      // Direktnachrichten und Gruppenchats: nur Mitglieder
      const [m] = await sql`select 1 from chat_members where channel_id = ${id} and user_id = ${u.id}`;
      if (!m) throw forbidden();
    }
    await sql`insert into chat_members (channel_id, user_id, last_read_at) values (${id}, ${u.id}, now() - interval '100 years') on conflict do nothing`;
    return c;
  }

  async function memberIds(c: Channel): Promise<string[]> {
    if (c.kind === 'direct' || c.kind === 'group') return (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${c.id}`).map((r) => r.user_id);
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
             when c.kind = 'project' then p.number || ' ' || p.name when c.kind = 'group' then c.name else t.name end as name,
        c.icon, c.created_by as "createdBy", m.role as "myRole",
        case when c.kind = 'group' then (select count(*)::int from chat_members m3 join users u3 on u3.id = m3.user_id and u3.deleted_at is null where m3.channel_id = c.id) end as "memberCount",
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
         or (c.kind = 'group' and m.user_id is not null)
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

  const msgSelect = sql`m.id, m.channel_id as "channelId", m.user_id as "userId", coalesce(u.display_name, m.guest_name || ' (Gast)') as "userName", m.body, m.attachments,
    m.kind, m.meta, m.call_id as "callId", m.created_at as "createdAt", m.updated_at as "updatedAt", m.deleted_at as "deletedAt",
    coalesce((select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at) from message_reactions r where r.message_id = m.id), '[]') as reactions`;
  const loadMessage = async (id: string) => (await sql`select ${msgSelect} from chat_messages m left join users u on u.id = m.user_id where m.id = ${id}`)[0];

  app.get('/chat/channels/:id/messages', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }), req.query);
    await channelAccess(u, id);
    // Nachrichten aus einem Anruf erscheinen gesammelt unter dessen Verlaufseintrag
    const rows = await sql`select ${msgSelect} from chat_messages m left join users u on u.id = m.user_id
      where m.channel_id = ${id} and (m.call_id is null or m.kind = 'call') ${q.before ? sql`and m.created_at < ${q.before}` : sql``} order by m.created_at desc limit ${q.limit}`;
    return rows.reverse().map((r) => (r.deletedAt ? { ...r, body: '', attachments: [] } : r));
  });

  app.post('/chat/channels/:id/messages', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      body: z.string().max(20000).default(''),
      attachments: z.array(z.object({ fileId: z.string().uuid(), name: z.string(), size: z.number(), mime: z.string().optional() })).default([]),
      callId: z.string().uuid().nullable().default(null),
    }), req.body);
    if (!b.body.trim() && !b.attachments.length) throw badRequest('Leere Nachricht');
    const c = await channelAccess(u, id);
    if (b.callId) {
      const [call] = await sql`select 1 from calls where id = ${b.callId} and channel_id = ${id}`;
      if (!call) throw badRequest('Anruf gehört nicht zu dieser Unterhaltung');
    }
    const [m] = await sql`insert into chat_messages (channel_id, user_id, body, attachments, call_id) values (${id}, ${u.id}, ${b.body}, ${sql.json(b.attachments)}, ${b.callId})
      returning id`;
    await sql`update chat_members set last_read_at = now() where channel_id = ${id} and user_id = ${u.id}`;
    const full = await loadMessage(m!.id);
    // Nachrichten aus dem Anruf laufen nur im Anruf; im Verlauf erscheinen sie gesammelt unter dem Anrufeintrag
    if (b.callId) ctx.hub.publish(`call:${id}`, 'call.message', full);
    else ctx.hub.publish(`chat:${id}`, 'message.created', full);
    const members = await memberIds(c);
    for (const uid of members) if (uid !== u.id) ctx.hub.toUser(uid, 'chat.unread', { channelId: id });
    const mentions = [...b.body.matchAll(/@([\w.-]+)/g)].map((x) => x[1]!.toLowerCase());
    const mentioned = mentions.length ? (await sql<{ id: string }[]>`select id from users where lower(username) = any(${mentions})`).map((x) => x.id) : [];
    const targets = c.kind === 'direct' || c.kind === 'group' ? members : mentioned;
    const online = ctx.hub.onlineUserIds();
    await notify(ctx, targets.filter((t) => (c.kind !== 'direct' && c.kind !== 'group') || mentioned.includes(t) || !online.has(t)), {
      kind: c.kind === 'direct' || c.kind === 'group' ? 'chat.message' : 'mention',
      title: c.kind === 'direct' ? `Nachricht von ${u.displayName}` : c.kind === 'group' ? `${u.displayName} in „${c.name}“` : `${u.displayName} hat dich im Chat erwähnt`,
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
      // Meetings: Gastgeber bleibt der Organisator; kein Klingeln bei allen Teilnehmern
      const [mt] = c.kind === 'meeting' ? await sql<{ host_id: string }[]>`select host_id from meetings where channel_id = ${id}` : [];
      [call] = await sql<{ id: string }[]>`insert into calls (channel_id, started_by) values (${id}, ${mt?.host_id ?? u.id}) returning id`;
      if (c.kind !== 'meeting') for (const uid of await memberIds(c)) if (uid !== u.id) ctx.hub.toUser(uid, 'call.incoming', { callId: call!.id, channelId: id, from: u.displayName, fromId: u.id });
    }
    const [info] = await sql<{ started_by: string | null; started_at: Date }[]>`select started_by, started_at from calls where id = ${call!.id}`;
    // Anruf-Kanal ist an die Unterhaltung gebunden: call:<channelId>
    return { callId: call!.id, channelId: id, iceServers: iceServers(ctx), hostId: info?.started_by, startedAt: info?.started_at };
  });

  app.post('/chat/channels/:id/call/end', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await channelAccess(u, id);
    const b = parse(z.object({ forAll: z.boolean().default(false) }), req.body ?? {});
    const call = await activeCall(ctx, id);
    if (b.forAll && call && call.started_by !== u.id && u.role !== 'admin') throw forbidden('Nur der Gastgeber kann den Anruf für alle beenden');
    if (b.forAll) ctx.hub.publish(`call:${id}`, 'call.event', { from: u.id, fromName: u.displayName, event: 'end-for-all', data: null });
    for (const cl of ctx.hub.clientsIn(`call:${id}`)) if (b.forAll || cl.userId === u.id) cl.channels.delete(`call:${id}`);
    await endCallIfEmpty(ctx, id, b.forAll);
    return { ok: true };
  });

  app.get('/chat/channels/:id/call/participants', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await channelAccess(u, id);
    const ids = [...new Set(ctx.hub.clientsIn(`call:${id}`).map((c) => c.userId))];
    return ids.length ? sql`select id, display_name as "displayName" from users where id = any(${ids})` : [];
  });

  /** Nachrichten und Dateien eines vergangenen oder laufenden Anrufs */
  app.get('/chat/calls/:id/messages', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [call] = await sql<{ channel_id: string }[]>`select channel_id from calls where id = ${id}`;
    if (!call) throw notFound();
    await channelAccess(u, call.channel_id);
    return sql`select ${msgSelect} from chat_messages m left join users u on u.id = m.user_id where m.call_id = ${id} and m.kind = 'message' order by m.created_at`;
  });

  // ------------------------------------------------ Reaktionen
  app.post('/chat/messages/:id/reactions', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ emoji: z.string().min(1).max(16) }), req.body);
    const [m] = await sql<{ channel_id: string }[]>`select channel_id from chat_messages where id = ${id} and deleted_at is null`;
    if (!m) throw notFound();
    await channelAccess(u, m.channel_id);
    const [had] = await sql`delete from message_reactions where message_id = ${id} and user_id = ${u.id} and emoji = ${b.emoji} returning 1`;
    if (!had) await sql`insert into message_reactions (message_id, user_id, emoji) values (${id}, ${u.id}, ${b.emoji})`;
    const full = await loadMessage(id);
    ctx.hub.publish(`chat:${m.channel_id}`, 'message.updated', full);
    return full;
  });

  // ------------------------------------------------ Gruppenchats
  const groupBody = z.object({ name: z.string().trim().min(1).max(80), icon: z.string().max(40).default('chat'), memberIds: z.array(z.string().uuid()).max(500).default([]) });

  async function groupOf(u: AuthUser, id: string, manage = false) {
    const c = await channelAccess(u, id);
    if (c.kind !== 'group') throw badRequest('Kein Gruppenchat');
    if (manage) {
      const [m] = await sql<{ role: string }[]>`select role from chat_members where channel_id = ${id} and user_id = ${u.id}`;
      if (m?.role !== 'owner' && u.role !== 'admin') throw forbidden('Nur der Ersteller verwaltet die Gruppe');
    }
    return c;
  }
  const announce = async (id: string, ids: string[]) => { for (const uid of ids) ctx.hub.toUser(uid, 'chat.unread', { channelId: id }); };

  app.post('/chat/groups', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(groupBody, req.body);
    const [c] = await sql<{ id: string }[]>`insert into chat_channels (kind, name, icon, created_by) values ('group', ${b.name}, ${b.icon}, ${u.id}) returning id`;
    await sql`insert into chat_members (channel_id, user_id, role) values (${c!.id}, ${u.id}, 'owner')`;
    const others = [...new Set(b.memberIds)].filter((x) => x !== u.id);
    for (const uid of others) await sql`insert into chat_members (channel_id, user_id, last_read_at) values (${c!.id}, ${uid}, now() - interval '100 years') on conflict do nothing`;
    await notify(ctx, others, { kind: 'chat.message', title: `${u.displayName} hat dich zur Gruppe „${b.name}“ hinzugefügt`, link: `/chat?channel=${c!.id}` }, u.id);
    await announce(c!.id, [u.id, ...others]);
    return c;
  });

  app.get('/chat/groups/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await groupOf(u, id);
    const members = await sql`select m.user_id as "userId", m.role, us.display_name as "displayName" from chat_members m join users us on us.id = m.user_id
      where m.channel_id = ${id} and us.deleted_at is null order by m.role, us.display_name`;
    return { id: c.id, name: c.name, icon: (c as Channel & { icon: string }).icon, members };
  });

  app.patch('/chat/groups/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await groupOf(u, id, true);
    const b = parse(groupBody.partial(), req.body);
    await sql`update chat_channels set name = coalesce(${b.name ?? null}, name), icon = coalesce(${b.icon ?? null}, icon) where id = ${id}`;
    if (b.memberIds) {
      const before = (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${id}`).map((r) => r.user_id);
      const keep = new Set([...b.memberIds, u.id, ...(await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${id} and role = 'owner'`).map((r) => r.user_id)]);
      await sql`delete from chat_members where channel_id = ${id} and not (user_id = any(${[...keep]}))`;
      const added = [...keep].filter((x) => !before.includes(x));
      for (const uid of added) await sql`insert into chat_members (channel_id, user_id, last_read_at) values (${id}, ${uid}, now() - interval '100 years') on conflict do nothing`;
      const [c] = await sql<{ name: string }[]>`select name from chat_channels where id = ${id}`;
      await notify(ctx, added, { kind: 'chat.message', title: `${u.displayName} hat dich zur Gruppe „${c!.name}“ hinzugefügt`, link: `/chat?channel=${id}` }, u.id);
      await announce(id, [...new Set([...before, ...keep])]);
    } else await announce(id, (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${id}`).map((r) => r.user_id));
    return { ok: true };
  });

  app.post('/chat/groups/:id/leave', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await groupOf(u, id);
    await sql`delete from chat_members where channel_id = ${id} and user_id = ${u.id}`;
    // Ersteller geht: die am längsten dabei sind, übernehmen
    const [owner] = await sql`select 1 from chat_members where channel_id = ${id} and role = 'owner'`;
    if (!owner) await sql`update chat_members set role = 'owner' where channel_id = ${id} and user_id = (select user_id from chat_members where channel_id = ${id} order by last_read_at limit 1)`;
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from chat_members where channel_id = ${id}`;
    if (!left?.n) await sql`delete from chat_channels where id = ${id}`;
    await announce(id, [u.id]);
    return { ok: true };
  });

  app.delete('/chat/groups/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await groupOf(u, id, true);
    const members = (await sql<{ user_id: string }[]>`select user_id from chat_members where channel_id = ${id}`).map((r) => r.user_id);
    await sql`delete from chat_channels where id = ${id}`;
    await announce(id, members);
    return { ok: true };
  });
}

export function iceServers(ctx: AppContext) {
  const list: { urls: string | string[]; username?: string; credential?: string }[] = [];
  if (ctx.config.turnUrls.length) list.push({ urls: ctx.config.turnUrls, username: 'aperio', credential: process.env.TURN_PASSWORD ?? 'aperio' });
  return list;
}
