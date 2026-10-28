/** Echtzeit-Verbindung (WebSocket) mit automatischem Wiederverbinden. */
type Handler = (event: string, data: any, channel: string) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private channels = new Map<string, number>();
  private retry = 1000;
  private stopped = true;
  connected = false;
  private statusListeners = new Set<(c: boolean) => void>();

  private lastActivitySent = 0;

  private query = '';

  /** query: z. B. „guest=…&key=…“ für Meeting-Gäste ohne Benutzerkonto */
  start(query = '') {
    this.query = query;
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    // Eingaben melden, damit Kollegen „aktiv“ (grün) oder „inaktiv“ (orange) sehen
    const onInput = () => {
      if (Date.now() - this.lastActivitySent < 30_000) return;
      this.lastActivitySent = Date.now();
      this.send({ type: 'activity', active: true });
    };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus']) window.addEventListener(ev, onInput, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.lastActivitySent = 0; onInput(); } });
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws${this.query ? `?${this.query}` : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 1000;
      this.setConnected(true);
      for (const ch of this.channels.keys()) ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
      this.lastActivitySent = Date.now();
      ws.send(JSON.stringify({ type: 'activity', active: true }));
    };
    ws.onmessage = (m) => {
      let msg: { channel: string; event: string; data: any };
      try { msg = JSON.parse(m.data); } catch { return; }
      for (const key of [msg.channel, '*']) this.handlers.get(key)?.forEach((h) => h(msg.event, msg.data, msg.channel));
    };
    ws.onclose = () => {
      this.setConnected(false);
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 15000);
    };
  }

  private setConnected(c: boolean) {
    this.connected = c;
    this.statusListeners.forEach((l) => l(c));
  }

  onStatus(l: (c: boolean) => void) { this.statusListeners.add(l); return () => { this.statusListeners.delete(l); }; }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Kanal abonnieren; liefert Abmeldefunktion. channel "*" empfängt alles. */
  subscribe(channel: string, handler: Handler): () => void {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(handler);
    if (channel !== '*' && !channel.startsWith('user:') && channel !== 'global') {
      const n = (this.channels.get(channel) ?? 0) + 1;
      this.channels.set(channel, n);
      if (n === 1) this.send({ type: 'subscribe', channel });
    }
    return () => {
      this.handlers.get(channel)?.delete(handler);
      if (channel !== '*' && this.channels.has(channel)) {
        const n = (this.channels.get(channel) ?? 1) - 1;
        if (n <= 0) { this.channels.delete(channel); this.send({ type: 'unsubscribe', channel }); }
        else this.channels.set(channel, n);
      }
    };
  }
}

export const realtime = new Realtime();
