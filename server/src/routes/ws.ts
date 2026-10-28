import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { HubClient } from '../lib/hub';
import { projectAccess } from '../lib/access';
import { activeCall, joinCall, leaveCall } from '../services/calls';
import { resolveGuest } from './meetings';

/**
 * Echtzeit-Kanal. Nachrichten vom Browser:
 *   {type:'subscribe', channel}   {type:'unsubscribe', channel}
 *   {type:'signal', to, callId, data}            WebRTC-Signalisierung für Videoanrufe
 *   {type:'call-event', callId, to?, event, data} Hand heben, stummschalten, Bildschirm anfordern …
 *   {type:'remote-grant'|'remote-revoke', callId, to}   Fernsteuerung erlauben / beenden (vom Gesteuerten)
 *   {type:'remote-input', callId, to, data}       Maus- und Tastatureingaben (vom Steuernden)
 *   {type:'typing', channel}   {type:'activity', active}
 *
 * Das Fernsteuerungs-Hilfsprogramm verbindet sich mit ?client=remote-helper und API-Schlüssel.
 */

/** Erteilte Fernsteuerungen: `${channelId}:${gesteuerter}` → steuernder Benutzer */
const grants = new Map<string, string>();

/** Ereignisse, die nur der Gastgeber (Anrufstarter) oder ein Administrator senden darf */
const HOST_EVENTS = new Set(['mute', 'kick', 'end-for-all']);

export default async function wsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    // Meeting-Gäste ohne Benutzerkonto: ?guest=<id>&key=<schlüssel> – dürfen nur in den Anruf ihres Meetings
    const gq = req.query as { guest?: string; key?: string };
    // Nachrichten, die während der Gast-Prüfung eintreffen, zwischenspeichern
    const early: Buffer[] = [];
    const keep = (m: Buffer) => early.push(m);
    socket.on('message', keep);
    const guest = !req.user && gq.guest && gq.key ? await resolveGuest(ctx, gq.guest, gq.key).catch(() => null) : null;
    const user = req.user ?? (guest ? { id: guest.id, displayName: `${guest.name} (Gast)`, role: 'meeting-guest' as const } as unknown as NonNullable<typeof req.user> : null);
    if (!user || user.mustChangePassword) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const helper = !guest && (req.query as { client?: string }).client === 'remote-helper';
    const client: HubClient = { socket, userId: user.id, channels: new Set(helper ? [`helper:${user.id}`] : guest ? [`meetguest:${user.id}`] : [`user:${user.id}`, 'global']), kind: helper ? 'helper' : 'browser' };
    ctx.hub.add(client);
    if (helper) {
      ctx.hub.toUser(user.id, 'remote.helper', { connected: true });
    } else if (!guest) {
      ctx.presence.activity(user.id);
    }

    const canJoin = async (channel: string): Promise<boolean> => {
      const [kind, id] = channel.split(':');
      if (!id) return false;
      if (guest) return channel === `call:${guest.channel_id}`;
      try {
        if (kind === 'meeting') {
          const [m] = await ctx.sql`select 1 from meetings m where m.id = ${id} and (m.host_id = ${user.id} or exists (select 1 from chat_members cm where cm.channel_id = m.channel_id and cm.user_id = ${user.id}))`;
          return Boolean(m) || user.role === 'admin';
        }
        if (kind === 'user') return id === user.id;
        if (kind === 'project') { await projectAccess(ctx.sql, user, id); return true; }
        if (kind === 'chat' || kind === 'call') {
          const [m] = await ctx.sql`select 1 from chat_members where channel_id = ${id} and user_id = ${user.id}`;
          if (m) return true;
          const [c] = await ctx.sql<{ project_id: string | null; kind: string; team_id: string | null }[]>`select project_id, kind, team_id from chat_channels where id = ${id}`;
          if (c?.project_id) { await projectAccess(ctx.sql, user, c.project_id); return true; }
          if (c?.kind === 'team') { const [t] = await ctx.sql`select 1 from team_members where team_id = ${c.team_id} and user_id = ${user.id}`; return Boolean(t) || user.role === 'admin'; }
          return false;
        }
      } catch { return false; }
      return false;
    };

    const sendTo = (userId: string, channel: string, event: string, data: unknown, onlyKind?: 'browser' | 'helper') => {
      for (const c of ctx.hub.allClients()) {
        if (c.userId !== userId || c.socket.readyState !== 1) continue;
        if (onlyKind && (c.kind ?? 'browser') !== onlyKind) continue;
        if (onlyKind !== 'helper' && !c.channels.has(channel)) continue;
        c.socket.send(JSON.stringify({ channel, event, data }));
      }
    };

    const leaveCallChannel = async (channel: string) => {
      const id = channel.slice('call:'.length);
      ctx.hub.publish(channel, 'call.left', { userId: user.id });
      for (const [k, v] of grants) if (k.startsWith(`${id}:`) && (v === user.id || k.endsWith(`:${user.id}`))) {
        grants.delete(k);
        ctx.hub.publish(channel, 'remote.revoked', { target: k.split(':')[1], controller: v });
      }
      // die Verbindung ist vielleicht schon weg – Verlauf erst danach schreiben
      setTimeout(() => { void leaveCall(ctx, id, user.id).catch(() => {}); }, 50);
    };

    socket.on('message', async (raw: Buffer) => {
      let msg: { type?: string; channel?: string; to?: string; callId?: string; event?: string; data?: unknown; active?: boolean };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const callChannel = msg.callId ? `call:${msg.callId}` : '';
      if (msg.type === 'subscribe' && msg.channel && (await canJoin(msg.channel))) {
        client.channels.add(msg.channel);
        socket.send(JSON.stringify({ channel: msg.channel, event: 'subscribed', data: null }));
        if (msg.channel.startsWith('call:')) {
          ctx.hub.publish(msg.channel, 'call.joined', { userId: user.id, displayName: user.displayName }, user.id);
          await joinCall(ctx, msg.channel.slice(5), user.id).catch(() => {});
        }
      } else if (msg.type === 'unsubscribe' && msg.channel) {
        const had = client.channels.delete(msg.channel);
        if (had && msg.channel.startsWith('call:')) await leaveCallChannel(msg.channel);
      } else if (msg.type === 'signal' && msg.to && msg.callId && client.channels.has(callChannel)) {
        for (const c of ctx.hub.clientsIn(callChannel)) {
          if (c.userId === msg.to && c.socket.readyState === 1)
            c.socket.send(JSON.stringify({ channel: callChannel, event: 'signal', data: { from: user.id, data: msg.data } }));
        }
      } else if (msg.type === 'call-event' && msg.callId && msg.event && client.channels.has(callChannel)) {
        if (HOST_EVENTS.has(msg.event)) {
          const call = await activeCall(ctx, msg.callId);
          if (call?.started_by !== user.id && user.role !== 'admin') return;
        }
        const payload = { from: user.id, fromName: user.displayName, event: msg.event, data: msg.data ?? null };
        if (msg.event === 'kick' && msg.to) {
          sendTo(msg.to, callChannel, 'call.event', payload);
          for (const c of ctx.hub.clientsIn(callChannel)) if (c.userId === msg.to) c.channels.delete(callChannel);
          ctx.hub.publish(callChannel, 'call.left', { userId: msg.to });
          void leaveCall(ctx, msg.callId, msg.to).catch(() => {});
          return;
        }
        if (msg.to) sendTo(msg.to, callChannel, 'call.event', payload);
        else ctx.hub.publish(callChannel, 'call.event', payload, user.id);
      } else if (guest && msg.type?.startsWith('remote')) {
        return;
      } else if (msg.type === 'remote-grant' && msg.to && msg.callId && client.channels.has(callChannel)) {
        // der Gesteuerte erlaubt msg.to, seinen Rechner zu steuern
        grants.set(`${msg.callId}:${user.id}`, msg.to);
        const helperOnline = ctx.hub.allClients().some((c) => c.userId === user.id && c.kind === 'helper');
        ctx.hub.publish(callChannel, 'remote.granted', { target: user.id, controller: msg.to, helperOnline });
        sendTo(user.id, '', 'remote.start', { controller: msg.to }, 'helper');
      } else if (msg.type === 'remote-revoke' && msg.callId && client.channels.has(callChannel)) {
        const target = msg.to && grants.get(`${msg.callId}:${msg.to}`) === user.id ? msg.to : user.id;
        grants.delete(`${msg.callId}:${target}`);
        ctx.hub.publish(callChannel, 'remote.revoked', { target, controller: user.id });
        sendTo(target, '', 'remote.stop', {}, 'helper');
      } else if (msg.type === 'remote-stop-helper' && helper) {
        // Notbremse im Hilfsprogramm: alle Freigaben dieses Benutzers enden
        for (const [key, controller] of grants) {
          if (!key.endsWith(`:${user.id}`)) continue;
          grants.delete(key);
          const callId = key.slice(0, -(user.id.length + 1));
          ctx.hub.publish(`call:${callId}`, 'remote.revoked', { target: user.id, controller });
        }
      } else if (msg.type === 'remote-input' && msg.to && msg.callId && grants.get(`${msg.callId}:${msg.to}`) === user.id) {
        sendTo(msg.to, '', 'remote.input', msg.data, 'helper');
      } else if (msg.type === 'typing' && msg.channel && client.channels.has(msg.channel)) {
        ctx.hub.publish(msg.channel, 'typing', { userId: user.id, displayName: user.displayName }, user.id);
      } else if (msg.type === 'activity' && !guest) {
        ctx.presence.activity(user.id, msg.active !== false);
      } else if (msg.type === 'ping') {
        socket.send(JSON.stringify({ channel: 'global', event: 'pong', data: null }));
      }
    });

    socket.off('message', keep);
    for (const m of early) socket.emit('message', m);

    socket.on('close', () => {
      const calls = [...client.channels].filter((ch) => ch.startsWith('call:'));
      ctx.hub.remove(client);
      for (const ch of calls) void leaveCallChannel(ch);
      if (helper) {
        if (!ctx.hub.allClients().some((c) => c.userId === user.id && c.kind === 'helper')) ctx.hub.toUser(user.id, 'remote.helper', { connected: false });
        return;
      }
      if (!guest) void ctx.presence.disconnected(user.id);
    });
  });

  /** Ist das Fernsteuerungs-Hilfsprogramm eines Teilnehmers gestartet? */
  app.get('/remote/helper/:userId', async (req) => {
    if (!req.user) return { connected: false };
    const { userId } = req.params as { userId: string };
    return { connected: ctx.hub.allClients().some((c) => c.userId === userId && c.kind === 'helper') };
  });
}
