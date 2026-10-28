import type { Sql } from '../db';
import type { Hub } from '../lib/hub';
import type { SettingsService } from './settings';

export type PresenceStatus = 'online' | 'idle' | 'away' | 'offline';

interface UserRow { id: string; status_mode: string; show_last_seen: boolean; last_seen_at: Date | null }

/**
 * Anwesenheit im Chat:
 *   grün  online   – AperioPlan offen und benutzt
 *   orange idle    – seit X Minuten keine Eingabe (Administrator, Standard 10)
 *   rot   away     – genehmigte Abwesenheit heute oder von Hand gewählt
 *   grau  offline  – AperioPlan geschlossen, darunter „zuletzt online“
 * Jeder kann den Status von Hand festlegen und „zuletzt online“ ausblenden.
 */
export class Presence {
  private lastActive = new Map<string, number>();
  private sent = new Map<string, PresenceStatus>();
  private absentToday = new Set<string>();
  private absentCheckedAt = 0;
  private timer: NodeJS.Timeout;

  constructor(private sql: Sql, private hub: Hub, private settings: SettingsService) {
    this.timer = setInterval(() => { void this.sweep(); }, 30_000);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); }

  /** Eingabe im Browser (Maus, Tastatur) oder Verbindungsaufbau */
  activity(userId: string, active = true) {
    if (active) this.lastActive.set(userId, Date.now());
    void this.check(userId);
  }

  /** Verbindung geschlossen: Zeitpunkt merken */
  async disconnected(userId: string) {
    if (this.hub.onlineUserIds().has(userId)) return;
    await this.sql`update users set last_seen_at = now() where id = ${userId}`;
    await this.check(userId);
  }

  private async refreshAbsences() {
    if (Date.now() - this.absentCheckedAt < 5 * 60_000) return;
    this.absentCheckedAt = Date.now();
    const rows = await this.sql<{ user_id: string }[]>`select distinct user_id from absences
      where status = 'approved' and current_date between start_date and end_date`.catch(() => []);
    this.absentToday = new Set(rows.map((r) => r.user_id));
  }

  async statusOf(row: Pick<UserRow, 'id' | 'status_mode'>): Promise<PresenceStatus> {
    const connected = this.hub.onlineUserIds().has(row.id);
    if (!connected || row.status_mode === 'offline') return 'offline';
    if (row.status_mode === 'online' || row.status_mode === 'idle' || row.status_mode === 'away') return row.status_mode as PresenceStatus;
    await this.refreshAbsences();
    if (this.absentToday.has(row.id)) return 'away';
    const { idleMinutes } = await this.settings.get('presence');
    const last = this.lastActive.get(row.id) ?? 0;
    return Date.now() - last > idleMinutes * 60_000 ? 'idle' : 'online';
  }

  /** Status und „zuletzt online“ aller Benutzer für die Mitarbeiterliste */
  async all(): Promise<Map<string, { status: PresenceStatus; lastSeenAt: string | null }>> {
    const rows = await this.sql<UserRow[]>`select id, status_mode, show_last_seen, last_seen_at from users where deleted_at is null`;
    const out = new Map<string, { status: PresenceStatus; lastSeenAt: string | null }>();
    for (const r of rows) out.set(r.id, { status: await this.statusOf(r), lastSeenAt: r.show_last_seen && r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null });
    return out;
  }

  async check(userId: string) {
    const [r] = await this.sql<UserRow[]>`select id, status_mode, show_last_seen, last_seen_at from users where id = ${userId}`;
    if (!r) return;
    const status = await this.statusOf(r);
    if (this.sent.get(userId) === status) return;
    this.sent.set(userId, status);
    this.hub.publish('global', 'presence', {
      userId, online: status !== 'offline', status,
      lastSeenAt: r.show_last_seen && r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    });
  }

  /** Regelmäßig prüfen, wer inzwischen inaktiv geworden ist */
  private async sweep() {
    for (const id of this.hub.onlineUserIds()) await this.check(id).catch(() => {});
  }
}
