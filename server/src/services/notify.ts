import type { AppContext } from '../context';

export interface NotificationInput {
  kind: string;
  title: string;
  body?: string;
  link?: string;
}

/** Legt eine Benachrichtigung an (Glocke) und schickt sie sofort per Echtzeit an den Empfänger. */
export async function notify(ctx: AppContext, userIds: (string | null | undefined)[], n: NotificationInput, exceptUserId?: string) {
  const targets = [...new Set(userIds.filter((x): x is string => Boolean(x) && x !== exceptUserId))];
  for (const uid of targets) {
    const [row] = await ctx.sql`insert into notifications (user_id, kind, title, body, link)
      values (${uid}, ${n.kind}, ${n.title}, ${n.body ?? ''}, ${n.link ?? null})
      returning id, kind, title, body, link, created_at as "createdAt"`;
    ctx.hub.toUser(uid, 'notification', row);
  }
}
