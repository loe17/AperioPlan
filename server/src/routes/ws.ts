import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { HubClient } from '../lib/hub';
import { projectAccess } from '../lib/access';

/**
 * Echtzeit-Kanal. Nachrichten vom Browser:
 *   {type:'subscribe', channel}   {type:'unsubscribe', channel}
 *   {type:'signal', to, callId, data}   (WebRTC-Signalisierung für Videoanrufe)
 *   {type:'typing', channel}
 */
export default async function wsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const user = req.user;
    if (!user || user.mustChangePassword) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const client: HubClient = { socket, userId: user.id, channels: new Set([`user:${user.id}`, 'global']) };
    ctx.hub.add(client);
    ctx.hub.publish('global', 'presence', { userId: user.id, online: true });

    const canJoin = async (channel: string): Promise<boolean> => {
      const [kind, id] = channel.split(':');
      if (!id) return false;
      try {
        if (kind === 'user') return id === user.id;
        if (kind === 'project') { await projectAccess(ctx.sql, user, id); return true; }
        if (kind === 'chat' || kind === 'call') {
          const [m] = await ctx.sql`select 1 from chat_members where channel_id = ${id} and user_id = ${user.id}`;
          if (m) return true;
          const [c] = await ctx.sql<{ project_id: string | null }[]>`select project_id from chat_channels where id = ${id}`;
          if (c?.project_id) { await projectAccess(ctx.sql, user, c.project_id); return true; }
          return false;
        }
      } catch { return false; }
      return false;
    };

    socket.on('message', async (raw: Buffer) => {
      let msg: { type?: string; channel?: string; to?: string; callId?: string; data?: unknown };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'subscribe' && msg.channel && (await canJoin(msg.channel))) {
        client.channels.add(msg.channel);
        socket.send(JSON.stringify({ channel: msg.channel, event: 'subscribed', data: null }));
        if (msg.channel.startsWith('call:')) ctx.hub.publish(msg.channel, 'call.joined', { userId: user.id, displayName: user.displayName }, user.id);
      } else if (msg.type === 'unsubscribe' && msg.channel) {
        client.channels.delete(msg.channel);
        if (msg.channel.startsWith('call:')) ctx.hub.publish(msg.channel, 'call.left', { userId: user.id });
      } else if (msg.type === 'signal' && msg.to && msg.callId && client.channels.has(`call:${msg.callId}`)) {
        for (const c of ctx.hub.clientsIn(`call:${msg.callId}`)) {
          if (c.userId === msg.to && c.socket.readyState === 1)
            c.socket.send(JSON.stringify({ channel: `call:${msg.callId}`, event: 'signal', data: { from: user.id, data: msg.data } }));
        }
      } else if (msg.type === 'typing' && msg.channel && client.channels.has(msg.channel)) {
        ctx.hub.publish(msg.channel, 'typing', { userId: user.id, displayName: user.displayName }, user.id);
      } else if (msg.type === 'ping') {
        socket.send(JSON.stringify({ channel: 'global', event: 'pong', data: null }));
      }
    });

    socket.on('close', () => {
      for (const ch of client.channels) if (ch.startsWith('call:')) ctx.hub.publish(ch, 'call.left', { userId: user.id });
      ctx.hub.remove(client);
      if (!ctx.hub.onlineUserIds().has(user.id)) ctx.hub.publish('global', 'presence', { userId: user.id, online: false });
    });
  });
}
