import { NOTIFY_KINDS, notifyKindOf } from '@aperio/shared';
import type { AppContext } from '../context';
import { sendMail } from './mail';

export interface NotificationInput {
  kind: string;
  title: string;
  body?: string;
  link?: string;
}

/**
 * Legt eine Benachrichtigung an (Glocke), schickt sie per Echtzeit an den Empfänger und
 * – wenn der Empfänger es so eingestellt hat – zusätzlich per E-Mail.
 */
export async function notify(ctx: AppContext, userIds: (string | null | undefined)[], n: NotificationInput, exceptUserId?: string) {
  const targets = [...new Set(userIds.filter((x): x is string => Boolean(x) && x !== exceptUserId))];
  if (!targets.length) return;
  const kind = notifyKindOf(n.kind);
  const defaults = NOTIFY_KINDS.find((k) => k.kind === kind);
  const users = await ctx.sql<{ id: string; email: string | null; notify_prefs: Record<string, { app?: boolean; mail?: boolean }> }[]>`
    select id, email, notify_prefs from users where id = any(${targets}) and active and deleted_at is null`;
  for (const u of users) {
    const pref = u.notify_prefs?.[kind];
    const app = pref?.app ?? defaults?.app ?? true;
    const mail = pref?.mail ?? defaults?.mail ?? false;
    if (app) {
      const [row] = await ctx.sql`insert into notifications (user_id, kind, title, body, link)
        values (${u.id}, ${n.kind}, ${n.title}, ${n.body ?? ''}, ${n.link ?? null})
        returning id, kind, title, body, link, created_at as "createdAt"`;
      ctx.hub.toUser(u.id, 'notification', row);
    }
    if (mail && u.email) {
      const base = ctx.config.publicUrl;
      void sendMail(ctx, { to: u.email, subject: `AperioPlan: ${n.title}`, text: `${n.title}\n\n${n.body ?? ''}${n.link ? `\n\nÖffnen: ${base}${n.link}` : ''}\n\n—\nDiese E-Mail lässt sich unter Profil → Benachrichtigungen abschalten.` })
        .catch(() => { /* kein E-Mail-Konto eingerichtet – nur in AperioPlan */ });
    }
  }
}
