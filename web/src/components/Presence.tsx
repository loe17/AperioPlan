import type { UserLite } from '../session';

const LABEL: Record<string, string> = { online: 'Online', idle: 'Abwesend seit einer Weile', away: 'Nicht da', offline: 'Offline' };

/** Wie lange ist das her? – „vor 5 Min.“, „gestern 16:20“, „12.03.“ */
export function lastSeenText(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d >= today) return `heute ${time}`;
  if (d.getTime() >= today.getTime() - 86400000) return `gestern ${time}`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function presenceOf(u?: UserLite | null): string {
  if (!u) return 'offline';
  return u.status ?? (u.online ? 'online' : 'offline');
}

/** Farbiger Punkt: grün online, orange untätig, rot nicht da, grauer Ring offline */
export function PresenceDot({ user }: { user?: UserLite | null }) {
  const s = presenceOf(user);
  const seen = s === 'offline' && user?.lastSeenAt ? ` – zuletzt online ${lastSeenText(user.lastSeenAt)}` : '';
  return <span className={`presence-dot ${s}`} title={`${LABEL[s] ?? s}${seen}`} />;
}

export function presenceLine(u?: UserLite | null): string {
  const s = presenceOf(u);
  if (s === 'offline') return u?.lastSeenAt ? `zuletzt online ${lastSeenText(u.lastSeenAt)}` : 'offline';
  return LABEL[s] ?? s;
}
