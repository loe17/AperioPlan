/**
 * Postausgang: Jede E-Mail kommt mit einer Kennung aus dem Schreibfenster. Zweimal angekommen → nur einmal verschickt.
 * Ist der Server gerade nicht erreichbar, bleibt die E-Mail hier liegen und wird automatisch nachgeschickt.
 */
import type { AppContext } from '../context';
import { notify } from './notify';
import { explainMailError, fileSentCopy, logEvent, setFlags, smtpSend, type MailAccount, type MailProblem, type OutgoingMail } from './mailbox';

export interface OutboxPayload {
  to: string; cc: string; bcc: string; subject: string; html: string; text: string; inReplyTo: string | null; references: string | null; messageId: string;
  attachments: { filename: string; storagePath: string }[]; replyOf: string | null; cleanup: string[];
}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function toMail(ctx: AppContext, p: OutboxPayload): OutgoingMail {
  return { to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, html: p.html, text: p.text, inReplyTo: p.inReplyTo, references: p.references, messageId: p.messageId,
    attachments: p.attachments.map((a) => ({ filename: a.filename, path: ctx.storage.abs(a.storagePath) })) };
}

/** Nach erfolgreichem Versand: Kopie in „Gesendet“, Antwort markieren, Zwischenablage der Anhänge leeren */
async function afterSend(ctx: AppContext, a: MailAccount, p: OutboxPayload, mail: Record<string, unknown>, messageId: string) {
  await fileSentCopy(ctx, a, mail, messageId);
  if (p.replyOf) {
    const [m] = await ctx.sql<{ id: string; uid: string | null; path: string | null }[]>`select m.id, m.uid::text as uid, f.path from mail_messages m left join mail_folders f on f.id = m.folder_id where m.id = ${p.replyOf} and m.account_id = ${a.id}`;
    if (m) {
      await ctx.sql`update mail_messages set answered = true where id = ${m.id}`;
      if (m.uid && m.path) await setFlags(ctx, a, m.path, [Number(m.uid)], { answered: true }).catch(() => {});
    }
  }
  for (const dir of p.cleanup) await ctx.storage.remove(dir).catch(() => {});
}

export type SendResult = { status: 'sent'; messageId: string } | { status: 'queued'; problem: MailProblem } | { status: 'duplicate'; messageId: string | null } | { status: 'pending' };

/**
 * Sofort senden (mit Wiederholung bei kurzen Störungen). Klappt es wegen einer Störung nicht,
 * landet die E-Mail im Postausgang. Bei dauerhaften Fehlern (Passwort, Empfänger) wird geworfen.
 */
export async function sendNow(ctx: AppContext, a: MailAccount, clientKey: string, p: OutboxPayload): Promise<SendResult> {
  const [row] = await ctx.sql<{ id: string }[]>`insert into mail_outbox (account_id, client_key, payload, status, attempts) values (${a.id}, ${clientKey}, ${ctx.sql.json(p as never)}, 'sending', 1)
    on conflict (account_id, client_key) do nothing returning id`;
  let id = row?.id;
  if (!id) {
    const [cur] = await ctx.sql<{ id: string; status: string; message_id: string | null }[]>`select id, status, message_id from mail_outbox where account_id = ${a.id} and client_key = ${clientKey}`;
    if (!cur) throw new Error('Postausgang nicht lesbar');
    if (cur.status === 'sent') return { status: 'duplicate', messageId: cur.message_id };
    if (cur.status === 'sending') return { status: 'pending' };
    const [claimed] = await ctx.sql<{ id: string }[]>`update mail_outbox set status = 'sending', attempts = attempts + 1, next_try_at = now(), payload = ${ctx.sql.json(p as never)} where id = ${cur.id} and status in ('queued', 'failed') returning id`;
    if (!claimed) return { status: 'pending' };
    id = claimed.id;
  }
  try {
    const r = await smtpSend(ctx, a, toMail(ctx, p));
    await ctx.sql`update mail_outbox set status = 'sent', sent_at = now(), message_id = ${r.messageId}, last_error = null where id = ${id}`;
    await logEvent(ctx, a.id, 'info', `Gesendet an ${short(p.to)}: „${short(p.subject || '(kein Betreff)')}“`);
    void afterSend(ctx, a, p, r.mail as unknown as Record<string, unknown>, r.messageId).catch(() => {});
    return { status: 'sent', messageId: r.messageId };
  } catch (e) {
    const problem = (e as { problem?: MailProblem }).problem ?? explainMailError(e, 'smtp', a);
    if (problem.transient) {
      await ctx.sql`update mail_outbox set status = 'queued', last_error = ${problem.text}, next_try_at = now() + interval '1 minute' where id = ${id}`;
      await logEvent(ctx, a.id, 'warn', `In den Postausgang gelegt („${short(p.subject || '(kein Betreff)')}“): ${problem.text} Wird automatisch nachgeschickt.`);
      return { status: 'queued', problem };
    }
    await ctx.sql`delete from mail_outbox where id = ${id}`;
    await logEvent(ctx, a.id, 'error', `Senden fehlgeschlagen („${short(p.subject || '(kein Betreff)')}“): ${problem.text}`);
    throw e;
  }
}

/** Fällige E-Mails im Postausgang nachschicken (jede Minute; mit id: genau diese sofort) */
export async function processOutbox(ctx: AppContext, onlyId?: string) {
  // nach einem Absturz mitten im Senden: nach 15 Minuten erneut versuchen
  await ctx.sql`update mail_outbox set status = 'queued' where status = 'sending' and next_try_at < now() - interval '15 minutes'`;
  const due = await ctx.sql<{ id: string; account_id: string; payload: OutboxPayload; attempts: number }[]>`
    update mail_outbox set status = 'sending', attempts = attempts + 1, next_try_at = now()
    where id in (select id from mail_outbox where status = 'queued' and next_try_at <= now() ${onlyId ? ctx.sql`and id = ${onlyId}` : ctx.sql``} order by next_try_at limit 20 for update skip locked)
    returning id, account_id, payload, attempts`;
  for (const o of due) {
    const [a] = await ctx.sql<MailAccount[]>`select * from mail_accounts where id = ${o.account_id}`;
    if (!a) continue;
    try {
      const r = await smtpSend(ctx, a, toMail(ctx, o.payload), 1);
      await ctx.sql`update mail_outbox set status = 'sent', sent_at = now(), message_id = ${r.messageId}, last_error = null where id = ${o.id}`;
      await logEvent(ctx, a.id, 'info', `Aus dem Postausgang nachgeschickt an ${short(o.payload.to)}: „${short(o.payload.subject || '(kein Betreff)')}“`);
      await notify(ctx, [a.owner_id], { kind: 'mail.sent', title: `E-Mail nachgeschickt: ${short(o.payload.subject || '(kein Betreff)')}`, body: `An ${short(o.payload.to, 120)}`, link: '/mail' });
      void afterSend(ctx, a, o.payload, r.mail as unknown as Record<string, unknown>, r.messageId).catch(() => {});
    } catch (e) {
      const problem = (e as { problem?: MailProblem }).problem ?? explainMailError(e, 'smtp', a);
      const giveUp = !problem.transient || o.attempts >= 30;
      await ctx.sql`update mail_outbox set status = ${giveUp ? 'failed' : 'queued'}, last_error = ${problem.text},
        next_try_at = now() + make_interval(mins => ${Math.min(30, 1 + o.attempts * 2)}) where id = ${o.id}`;
      if (giveUp) {
        await logEvent(ctx, a.id, 'error', `Postausgang: „${short(o.payload.subject || '(kein Betreff)')}“ konnte nicht verschickt werden: ${problem.text}`);
        await notify(ctx, [a.owner_id], { kind: 'mail.failed', title: `E-Mail konnte nicht gesendet werden: ${short(o.payload.subject || '(kein Betreff)')}`, body: `${problem.text} ${problem.tip}`, link: '/mail' });
      }
    }
  }
  if (!onlyId && Math.random() < 0.05) await ctx.sql`delete from mail_outbox where status = 'sent' and sent_at < now() - interval '7 days'`;
  return due.length;
}

/** E-Mail aus dem Postausgang zurück in die Entwürfe legen */
export async function draftFromOutbox(ctx: AppContext, id: string) {
  const [o] = await ctx.sql<{ account_id: string; payload: OutboxPayload }[]>`select account_id, payload from mail_outbox where id = ${id}`;
  if (!o) return null;
  const p = o.payload;
  const [d] = await ctx.sql<{ id: string }[]>`insert into mail_drafts (account_id, to_addrs, cc_addrs, bcc_addrs, subject, html, reply_of, attachments)
    values (${o.account_id}, ${p.to}, ${p.cc}, ${p.bcc}, ${p.subject}, ${p.html}, ${p.replyOf},
      ${ctx.sql.json(p.attachments.filter((x) => x.storagePath.includes('/ausgang/')).map((x) => ({ name: x.filename, path: x.storagePath, size: 0 })) as never)}) returning id`;
  await ctx.sql`delete from mail_outbox where id = ${id}`;
  return d!.id;
}
