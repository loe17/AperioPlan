import type { AppContext } from '../context';

/**
 * Anrufverlauf: Wer war wann im Anruf? Endet der Anruf (letzter Teilnehmer geht),
 * entsteht im Chat ein Verlaufseintrag mit Dauer, Teilnehmern und den Nachrichten des Anrufs.
 */
export async function activeCall(ctx: AppContext, channelId: string): Promise<{ id: string; started_by: string | null } | null> {
  const [c] = await ctx.sql<{ id: string; started_by: string | null }[]>`select id, started_by from calls
    where channel_id = ${channelId} and ended_at is null and started_at > now() - interval '12 hours' order by started_at desc limit 1`;
  return c ?? null;
}

export async function joinCall(ctx: AppContext, channelId: string, userId: string) {
  const call = await activeCall(ctx, channelId);
  if (!call) return;
  const [open] = await ctx.sql`select 1 from call_participants where call_id = ${call.id} and user_id = ${userId} and left_at is null`;
  if (!open) await ctx.sql`insert into call_participants (call_id, user_id) values (${call.id}, ${userId})`;
}

export async function leaveCall(ctx: AppContext, channelId: string, userId: string) {
  const call = await activeCall(ctx, channelId);
  if (!call) return;
  await ctx.sql`update call_participants set left_at = now() where call_id = ${call.id} and user_id = ${userId} and left_at is null`;
  await endCallIfEmpty(ctx, channelId);
}

export async function endCallIfEmpty(ctx: AppContext, channelId: string, force = false) {
  const remaining = new Set(ctx.hub.clientsIn(`call:${channelId}`).map((c) => c.userId));
  if (remaining.size > 0 && !force) return;
  const call = await activeCall(ctx, channelId);
  if (!call) return;
  await ctx.sql`update call_participants set left_at = now() where call_id = ${call.id} and left_at is null`;
  const [ended] = await ctx.sql<{ started_at: Date; ended_at: Date }[]>`update calls set ended_at = now() where id = ${call.id} returning started_at, ended_at`;
  const people = await ctx.sql<{ id: string; display_name: string }[]>`select distinct u.id, u.display_name from call_participants cp join users u on u.id = cp.user_id where cp.call_id = ${call.id}`;
  const n = (await ctx.sql<{ n: number }[]>`select count(*)::int as n from chat_messages where call_id = ${call.id} and kind = 'message' and deleted_at is null`)[0]?.n ?? 0;
  const meta = {
    callId: call.id, startedAt: ended!.started_at, endedAt: ended!.ended_at,
    durationSec: Math.round((new Date(ended!.ended_at).getTime() - new Date(ended!.started_at).getTime()) / 1000),
    participants: people.map((p) => ({ id: p.id, name: p.display_name })), messageCount: n,
  };
  const [m] = await ctx.sql<{ id: string }[]>`insert into chat_messages (channel_id, user_id, body, kind, meta, call_id)
    values (${channelId}, ${call.started_by}, '', 'call', ${ctx.sql.json(meta)}, ${call.id}) returning id`;
  const [full] = await ctx.sql`select m.id, m.channel_id as "channelId", m.user_id as "userId", u.display_name as "userName", m.body, m.attachments,
    m.kind, m.meta, m.call_id as "callId", m.created_at as "createdAt", m.updated_at as "updatedAt", m.deleted_at as "deletedAt", '[]'::json as reactions
    from chat_messages m left join users u on u.id = m.user_id where m.id = ${m!.id}`;
  ctx.hub.publish(`chat:${channelId}`, 'message.created', full);
  ctx.hub.publish(`chat:${channelId}`, 'call.ended', { channelId });
}
