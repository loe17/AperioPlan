import type { WebSocket } from '@fastify/websocket';

/**
 * Echtzeit-Verteiler: Clients abonnieren Kanäle (user:<id>, project:<id>, chat:<id>, call:<id>)
 * und erhalten dort Ereignisse wie neue Chatnachrichten oder geänderte Aufgaben.
 */
export interface HubClient {
  socket: WebSocket;
  userId: string;
  channels: Set<string>;
}

export class Hub {
  private clients = new Set<HubClient>();

  add(c: HubClient) { this.clients.add(c); }
  remove(c: HubClient) { this.clients.delete(c); }

  publish(channel: string, event: string, data: unknown, exceptUserId?: string) {
    const msg = JSON.stringify({ channel, event, data });
    for (const c of this.clients) {
      if (exceptUserId && c.userId === exceptUserId) continue;
      if (c.channels.has(channel) && c.socket.readyState === 1) c.socket.send(msg);
    }
  }

  toUser(userId: string, event: string, data: unknown) { this.publish(`user:${userId}`, event, data); }

  onlineUserIds(): Set<string> {
    return new Set([...this.clients].map((c) => c.userId));
  }

  clientsIn(channel: string): HubClient[] {
    return [...this.clients].filter((c) => c.channels.has(channel));
  }
}
