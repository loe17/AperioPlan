/**
 * E-Signatur: PDF hochladen, Unterzeichner (intern oder extern) per Link einladen, im Browser unterschreiben.
 * Nach der letzten Unterschrift entsteht ein Signaturprotokoll mit Prüfsumme des Dokuments, Zeitpunkten,
 * IP-Adressen und den Unterschriften. Rechtlich ist das eine einfache elektronische Signatur (eIDAS Art. 3 Nr. 10).
 */
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { config } from '../config';
import { z, parse, idParam } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { sendMail } from '../services/mail';
import { safeName } from '../services/files';
import { randomToken } from '../lib/crypto';
import { sendStored, staffOf } from '../lib/rows';
import { Pdf } from '../lib/pdf';
import { projectAccess } from '../lib/access';

type Stroke = [number, number][];
type Signer = { id: string; envelope_id: string; sort: number; name: string; email: string; user_id: string | null; token: string; status: string; invited_at: Date | null; viewed_at: Date | null; signed_at: Date | null;
  signature: { strokes: Stroke[]; aspect: number } | null; typed_name: string; ip: string; user_agent: string; decline_reason: string; reminded_at: Date | null };
type Envelope = { id: string; project_id: string | null; number: string; title: string; message: string; file_path: string; file_name: string; sha256: string; sequential: boolean; status: string; expires_at: string | null;
  protocol_path: string | null; created_by: string | null; sent_at: Date | null; completed_at: Date | null; created_at: Date };
const signerInput = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email('Bitte gültige E-Mail-Adressen angeben.').max(200), userId: z.string().uuid().nullable().default(null) });
const dt = (d: Date | null) => (d ? d.toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' }) : '');
const signUrl = (token: string) => `${config.publicUrl}/sign/${token}`;

async function company(ctx: AppContext) { return (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name || 'AperioPlan'; }

/** Einladung (oder Erinnerung) an einen Unterzeichner – per E-Mail, intern zusätzlich als Benachrichtigung */
async function invite(ctx: AppContext, e: Envelope, s: Signer, reminder = false, from?: string): Promise<boolean> {
  const firm = await company(ctx);
  if (s.user_id) await notify(ctx, [s.user_id], { kind: 'esign.invite', title: `${reminder ? 'Erinnerung: ' : ''}Bitte unterschreiben: ${e.title}`, body: e.number, link: `/sign/${s.token}` }, from);
  const ok = await sendMail(ctx, { to: s.email, subject: `${reminder ? 'Erinnerung: ' : ''}Bitte unterschreiben: ${e.title}`,
    text: `Guten Tag ${s.name},\n\n${firm} bittet Sie, das Dokument „${e.title}“ elektronisch zu unterschreiben.${e.message ? `\n\n${e.message}` : ''}\n\nZum Dokument:\n${signUrl(s.token)}\n\n${e.expires_at ? `Der Link ist gültig bis ${new Date(`${e.expires_at}T12:00:00`).toLocaleDateString('de-DE')}.\n\n` : ''}Mit freundlichen Grüßen\n${firm}` })
    .then(() => true, () => false);
  await ctx.sql`update sig_signers set ${reminder ? ctx.sql`reminded_at` : ctx.sql`invited_at`} = now() where id = ${s.id}`;
  return ok;
}

/** Signaturprotokoll als PDF */
function protocolPdf(firm: string, e: Envelope, signers: Signer[], creator: string) {
  const pdf = new Pdf(`Signaturprotokoll ${e.number}`, firm);
  const L = pdf.margin;
  pdf.text(L, pdf.y, firm, { size: 13, bold: true });
  pdf.text(330, pdf.y, `Signaturprotokoll ${e.number}`, { size: 12, bold: true });
  pdf.y += 36;
  pdf.paragraph(e.title, { bold: true, size: 12, gap: 6 });
  pdf.table([{ label: '', width: 140 }, { label: '', width: 355 }], [
    ['Dokument', e.file_name], ['Prüfsumme (SHA-256)', `${e.sha256.slice(0, 32)}\n${e.sha256.slice(32)}`], ['Erstellt von', `${creator}, ${dt(e.created_at)}`],
    ['Versendet', dt(e.sent_at)], ['Abgeschlossen', dt(e.completed_at)], ['Reihenfolge', e.sequential ? 'nacheinander' : 'beliebig'],
  ], { size: 9 });
  pdf.y += 12;
  pdf.paragraph('Unterzeichner', { bold: true, size: 11, gap: 6 });
  for (const s of signers) {
    pdf.ensure(130);
    const y0 = pdf.y;
    pdf.rect(L, y0, pdf.width - 2 * L, 118, '#f9fafb');
    pdf.text(L + 10, y0 + 8, `${s.name} <${s.email}>`, { size: 10, bold: true });
    const lines = [`Status: ${s.status === 'signed' ? 'unterschrieben' : s.status === 'declined' ? `abgelehnt – ${s.decline_reason}` : 'offen'}`,
      `Eingeladen: ${dt(s.invited_at)} · geöffnet: ${dt(s.viewed_at)}`, `Unterschrieben: ${dt(s.signed_at)}${s.typed_name ? ` als „${s.typed_name}“` : ''}`, `IP-Adresse: ${s.ip || '–'}`, `Browser: ${s.user_agent.slice(0, 90) || '–'}`];
    lines.forEach((t, i) => pdf.text(L + 10, y0 + 24 + i * 12, t, { size: 8, color: '#374151' }));
    if (s.signature) { pdf.signature(s.signature.strokes, L + 330, y0 + 22, 150, 50, s.signature.aspect); pdf.line(L + 330, y0 + 76, L + 480, y0 + 76, 0.5, '#9ca3af'); pdf.text(L + 330, y0 + 80, 'Unterschrift', { size: 7, color: '#6b7280' }); }
    pdf.y = y0 + 128;
  }
  pdf.ensure(60);
  pdf.paragraph('Hinweis: Die Unterschriften wurden im Browser gezeichnet und mit Zeitpunkt und IP-Adresse protokolliert (einfache elektronische Signatur im Sinne von eIDAS Art. 3 Nr. 10). '
    + 'Ob das Dokument nachträglich verändert wurde, lässt sich prüfen, indem die SHA-256-Prüfsumme der Datei mit dem Wert oben verglichen wird. Für Verträge mit gesetzlicher Schriftform reicht diese Form nicht aus.', { size: 8, color: '#6b7280' });
  pdf.footer((p, n) => `${firm} · ${e.number} · Seite ${p} von ${n}`);
  return pdf.toBuffer();
}

async function complete(ctx: AppContext, envelopeId: string) {
  const { sql, storage } = ctx;
  await sql`update sig_envelopes set status = 'completed', completed_at = now(), updated_at = now() where id = ${envelopeId}`;
  const [e] = await sql<(Envelope & { creator: string; creator_email: string | null })[]>`select e.*, coalesce(u.display_name, '') as creator, u.email as creator_email from sig_envelopes e left join users u on u.id = e.created_by where e.id = ${envelopeId}`;
  const signers = await sql<Signer[]>`select * from sig_signers where envelope_id = ${envelopeId} order by sort`;
  const firm = await company(ctx);
  const path = `.aperio/esign/${envelopeId}/Signaturprotokoll_${e!.number}.pdf`;
  await storage.write(path, Readable.from(protocolPdf(firm, e!, signers, e!.creator)));
  await sql`update sig_envelopes set protocol_path = ${path} where id = ${envelopeId}`;
  const attachments = [{ path: e!.file_path, name: e!.file_name }, { path, name: `Signaturprotokoll_${e!.number}.pdf` }];
  for (const to of [...new Set([...signers.map((s) => s.email), ...(e!.creator_email ? [e!.creator_email] : [])])])
    await sendMail(ctx, { to, subject: `Unterschrieben: ${e!.title}`, text: `Guten Tag,\n\nalle Unterschriften zu „${e!.title}“ liegen vor. Im Anhang finden Sie das Dokument und das Signaturprotokoll.\n\nMit freundlichen Grüßen\n${firm}`, attachments }).catch(() => undefined);
  if (e!.created_by) await notify(ctx, [e!.created_by], { kind: 'esign.done', title: `Alle haben unterschrieben: ${e!.title}`, body: e!.number, link: `/esign?envelope=${envelopeId}` });
}

/** Täglich: erinnern und abgelaufene Vorgänge schließen */
export async function esignDaily(ctx: AppContext) {
  const { sql } = ctx;
  if (!(await ctx.settings.get('apps')).installed.includes('esign')) return;
  await sql`update sig_envelopes set status = 'expired', updated_at = now() where status = 'sent' and expires_at < current_date`;
  const days = (await ctx.settings.get('esign')).reminderDays;
  if (!days) return;
  const envs = await sql<Envelope[]>`select * from sig_envelopes where status = 'sent'`;
  for (const e of envs) {
    const signers = await sql<Signer[]>`select * from sig_signers where envelope_id = ${e.id} order by sort`;
    const open = signers.filter((s) => s.status === 'pending' && s.invited_at && Date.now() - Math.max(s.invited_at.getTime(), s.reminded_at?.getTime() ?? 0) > days * 86400000);
    for (const s of open) await invite(ctx, e, s, true);
  }
}

export default async function esignRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const changed = () => ctx.hub.publish('global', 'esign.changed', {});
  const cols = sql`e.id, e.number, e.title, e.message, e.file_name as "fileName", e.sha256, e.sequential, e.status, e.expires_at::text as "expiresAt", e.project_id as "projectId",
    (select number from projects pp where pp.id = e.project_id) as "projectNumber", (select name from projects pp where pp.id = e.project_id) as "projectName", e.account_id as "accountId",
    e.protocol_path is not null as "hasProtocol", e.created_by as "createdBy", u.display_name as "createdByName", e.sent_at as "sentAt", e.completed_at as "completedAt", e.created_at as "createdAt"`;
  const signerCols = sql`id, sort, name, email, user_id as "userId", status, invited_at as "invitedAt", viewed_at as "viewedAt", signed_at as "signedAt", typed_name as "typedName", decline_reason as "declineReason", token`;
  const own = async (u: AuthUser, id: string) => {
    const [e] = await sql<Envelope[]>`select * from sig_envelopes where id = ${id}`;
    if (!e) throw notFound('Vorgang nicht gefunden');
    if (e.created_by === u.id || u.role === 'admin') return e;
    // Vorgänge eines Projekts dürfen alle bearbeiten, die das Projekt bearbeiten dürfen
    if (e.project_id) {
      await projectAccess(sql, u, e.project_id, 'edit').catch(() => { throw forbidden(); });
      return e;
    }
    throw forbidden();
  };

  app.get('/esign/envelopes', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ scope: z.string().optional(), projectId: z.string().uuid().optional() }), req.query);
    const all = q.scope === 'all' && u.role === 'admin';
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    const rows = await sql<any[]>`select ${cols},
      (select count(*)::int from sig_signers s where s.envelope_id = e.id) as signers, (select count(*)::int from sig_signers s where s.envelope_id = e.id and s.status = 'signed') as signed
      from sig_envelopes e left join users u on u.id = e.created_by 
      where ${q.projectId ? sql`e.project_id = ${q.projectId}` : all ? sql`true` : sql`e.created_by = ${u.id}`} order by e.created_at desc limit 500`;
    const mine = await sql<any[]>`select e.id, e.number, e.title, s.token, s.status, u.display_name as "createdByName", e.created_at as "createdAt" from sig_signers s join sig_envelopes e on e.id = s.envelope_id
      left join users u on u.id = e.created_by where s.user_id = ${u.id} and e.status = 'sent' and s.status = 'pending' order by e.created_at desc`;
    return { envelopes: rows, toSign: mine };
  });
  app.get('/esign/envelopes/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await own(u, id);
    const [e] = await sql<any[]>`select ${cols} from sig_envelopes e left join users u on u.id = e.created_by where e.id = ${id}`;
    const signers = (await sql<any[]>`select ${signerCols} from sig_signers where envelope_id = ${id} order by sort`).map((s) => ({ ...s, link: signUrl(s.token), token: undefined }));
    return { ...e, signers };
  });
  app.post('/esign/envelopes', async (req) => {
    const u = staffOf(req);
    const fields: Record<string, string> = {};
    let file: { path: string; name: string; sha256: string } | null = null;
    const tmp = `.aperio/esign/tmp-${randomToken(9)}`;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'dokument.pdf');
        const buf = await part.toBuffer();
        if (!/\.pdf$/i.test(name) || buf.subarray(0, 5).toString() !== '%PDF-') throw badRequest('Bitte ein PDF-Dokument hochladen.');
        const r = await storage.write(`${tmp}/${name}`, Readable.from(buf));
        file = { path: `${tmp}/${name}`, name, sha256: r.sha256 };
      } else fields[part.fieldname] = String(part.value);
    }
    if (!file) throw badRequest('Bitte ein PDF-Dokument auswählen.');
    const b = parse(z.object({ title: z.string().trim().max(200).default(''), message: z.string().max(5000).default(''), sequential: z.enum(['true', 'false']).default('false'),
      expiresAt: z.string().date().optional().or(z.literal('')), signers: z.string().max(50000), projectId: z.string().uuid().optional().or(z.literal('')), accountId: z.string().uuid().optional().or(z.literal('')) }), fields);
    let raw: unknown;
    try { raw = JSON.parse(b.signers); } catch { throw badRequest('Unterzeichner fehlen.'); }
    const signers = parse(z.array(signerInput).min(1, 'Mindestens einen Unterzeichner angeben.').max(20), raw);
    const expiry = b.expiresAt || new Date(Date.now() + (await ctx.settings.get('esign')).expiryDays * 86400000).toISOString().slice(0, 10);
    const number = await nextNumber(sql, 'envelope', (await ctx.settings.get('numbers')).envelope ?? 'ES-{JJ}-{NNNN}', async (n) => (await sql`select 1 from sig_envelopes where number = ${n}`).length > 0);
    const [e] = await sql<{ id: string }[]>`insert into sig_envelopes (number, title, message, file_path, file_name, sha256, sequential, expires_at, project_id, account_id, created_by)
      values (${number}, ${b.title || file.name.replace(/\.pdf$/i, '')}, ${b.message}, ${file.path}, ${file.name}, ${file.sha256}, ${b.sequential === 'true'}, ${expiry}, ${b.projectId || null}, ${b.accountId || null}, ${u.id}) returning id`;
    const final = `.aperio/esign/${e!.id}/${file.name}`;
    await storage.move(file.path, final);
    await sql`update sig_envelopes set file_path = ${final} where id = ${e!.id}`;
    for (const [i, s] of signers.entries()) await sql`insert into sig_signers (envelope_id, sort, name, email, user_id, token) values (${e!.id}, ${i}, ${s.name}, ${s.email.toLowerCase()}, ${s.userId}, ${randomToken(18)})`;
    await audit(sql, u, { action: 'esign.create', entityType: 'sig_envelope', entityId: e!.id, summary: `${number} angelegt (SHA-256 ${file.sha256.slice(0, 12)}…)` });
    changed();
    return { id: e!.id, number };
  });
  app.delete('/esign/envelopes/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const e = await own(u, id);
    if (e.status !== 'draft') throw badRequest('Versendete Vorgänge bitte zurückziehen statt löschen.');
    await sql`delete from sig_envelopes where id = ${id}`;
    await storage.remove(`.aperio/esign/${id}`).catch(() => undefined);
    changed();
    return { ok: true };
  });
  app.post('/esign/envelopes/:id/send', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const e = await own(u, id);
    if (e.status !== 'draft') throw badRequest('Bereits versendet.');
    await sql`update sig_envelopes set status = 'sent', sent_at = now(), updated_at = now() where id = ${id}`;
    const signers = await sql<Signer[]>`select * from sig_signers where envelope_id = ${id} order by sort`;
    let failed = 0;
    for (const s of e.sequential ? signers.slice(0, 1) : signers) if (!(await invite(ctx, e, s, false, u.id))) failed++;
    await audit(sql, u, { action: 'esign.send', entityType: 'sig_envelope', entityId: id, summary: `${e.number} an ${signers.length} Unterzeichner versendet` });
    changed();
    return { ok: true, failed };
  });
  app.post('/esign/envelopes/:id/remind', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const e = await own(u, id);
    if (e.status !== 'sent') throw badRequest('Der Vorgang ist nicht offen.');
    const signers = await sql<Signer[]>`select * from sig_signers where envelope_id = ${id} and status = 'pending' and invited_at is not null order by sort`;
    let failed = 0;
    for (const s of signers) if (!(await invite(ctx, e, s, true, u.id))) failed++;
    return { ok: true, reminded: signers.length, failed };
  });
  app.post('/esign/envelopes/:id/cancel', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const e = await own(u, id);
    if (e.status !== 'sent') throw badRequest('Nur offene Vorgänge lassen sich zurückziehen.');
    await sql`update sig_envelopes set status = 'cancelled', updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'esign.cancel', entityType: 'sig_envelope', entityId: id, summary: `${e.number} zurückgezogen` });
    changed();
    return { ok: true };
  });
  app.get('/esign/envelopes/:id/file', async (req, reply) => {
    const e = await own(staffOf(req), parse(idParam, req.params).id);
    return sendStored(reply, storage, e.file_path, e.file_name);
  });
  app.get('/esign/envelopes/:id/protocol', async (req, reply) => {
    const e = await own(staffOf(req), parse(idParam, req.params).id);
    if (!e.protocol_path) throw notFound('Das Protokoll entsteht nach der letzten Unterschrift.');
    return sendStored(reply, storage, e.protocol_path, `Signaturprotokoll_${e.number}.pdf`);
  });

  // ------------------------------------------------ Öffentlich: unterschreiben ohne Anmeldung
  async function bySigner(token: string) {
    if (!(await ctx.settings.get('apps')).installed.includes('esign')) throw notFound();
    const [s] = await sql<Signer[]>`select * from sig_signers where token = ${token}`;
    if (!s) throw notFound('Link ungültig');
    const [e] = await sql<Envelope[]>`select * from sig_envelopes where id = ${s.envelope_id}`;
    const all = await sql<Signer[]>`select * from sig_signers where envelope_id = ${s.envelope_id} order by sort`;
    const turn = !e!.sequential || all.filter((x) => x.sort < s.sort).every((x) => x.status === 'signed');
    return { s, e: e!, all, turn };
  }
  const tokenParam = z.object({ token: z.string().min(10).max(60) });
  app.get('/pub/sign/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { s, e, all, turn } = await bySigner(parse(tokenParam, req.params).token);
    if (e.status === 'sent' && !s.viewed_at) await sql`update sig_signers set viewed_at = now() where id = ${s.id}`;
    return { title: e.title, message: e.message, number: e.number, company: await company(ctx), fileName: e.file_name, sha256: e.sha256, status: e.status, expiresAt: e.expires_at,
      signer: { name: s.name, status: s.status, signedAt: s.signed_at }, turn, others: all.filter((x) => x.id !== s.id).map((x) => ({ name: x.name, status: x.status })) };
  });
  app.get('/pub/sign/:token/file', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { e } = await bySigner(parse(tokenParam, req.params).token);
    if (e.status === 'draft') throw notFound();
    return sendStored(reply, storage, e.file_path, e.file_name);
  });
  app.get('/pub/sign/:token/protocol', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { e } = await bySigner(parse(tokenParam, req.params).token);
    if (!e.protocol_path) throw notFound();
    return sendStored(reply, storage, e.protocol_path, `Signaturprotokoll_${e.number}.pdf`);
  });
  const check = (e: Envelope, s: Signer, turn: boolean) => {
    if (e.status !== 'sent') throw badRequest(e.status === 'completed' ? 'Dieses Dokument ist bereits vollständig unterschrieben.' : 'Dieser Vorgang ist nicht mehr offen.');
    if (s.status !== 'pending') throw badRequest('Sie haben bereits geantwortet.');
    if (!turn) throw badRequest('Bitte warten Sie, bis die vorherigen Unterzeichner unterschrieben haben.');
  };
  app.post('/pub/sign/:token', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { token } = parse(tokenParam, req.params);
    const { s, e, all, turn } = await bySigner(token);
    check(e, s, turn);
    const b = parse(z.object({ name: z.string().trim().min(2, 'Bitte Ihren Namen eingeben.').max(200), consent: z.literal(true, { message: 'Bitte bestätigen Sie, dass Sie elektronisch unterschreiben möchten.' }),
      strokes: z.array(z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).max(2000)).min(1, 'Bitte unterschreiben.').max(200), aspect: z.number().min(1).max(10).default(3) }), req.body);
    if (b.strokes.reduce((n, x) => n + x.length, 0) < 5) throw badRequest('Die Unterschrift ist zu kurz.');
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
    const r = await sql`update sig_signers set status = 'signed', signed_at = now(), signature = ${sql.json({ strokes: b.strokes, aspect: b.aspect } as never)}, typed_name = ${b.name}, ip = ${req.ip}, user_agent = ${ua}
      where id = ${s.id} and status = 'pending'`;
    if (!r.count) throw badRequest('Sie haben bereits geantwortet.');
    await audit(sql, null, { action: 'esign.sign', entityType: 'sig_envelope', entityId: e.id, summary: `${e.number}: unterschrieben von ${s.name} <${s.email}> (${req.ip})` });
    const rest = all.filter((x) => x.id !== s.id && x.status !== 'signed');
    if (!rest.length) await complete(ctx, e.id);
    else if (e.sequential) { const next = rest.sort((a, c) => a.sort - c.sort)[0]!; if (!next.invited_at) await invite(ctx, e, next); }
    if (e.created_by && rest.length) await notify(ctx, [e.created_by], { kind: 'esign.signed', title: `${s.name} hat unterschrieben`, body: `${e.title} · noch ${rest.length} offen`, link: `/esign?envelope=${e.id}` });
    changed();
    return { ok: true, completed: !rest.length };
  });
  app.post('/pub/sign/:token/decline', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { s, e, turn } = await bySigner(parse(tokenParam, req.params).token);
    check(e, s, turn);
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Bitte kurz begründen.').max(1000) }), req.body);
    await sql`update sig_signers set status = 'declined', decline_reason = ${b.reason}, ip = ${req.ip} where id = ${s.id}`;
    await sql`update sig_envelopes set status = 'declined', updated_at = now() where id = ${e.id}`;
    await audit(sql, null, { action: 'esign.decline', entityType: 'sig_envelope', entityId: e.id, summary: `${e.number}: abgelehnt von ${s.name}` });
    if (e.created_by) await notify(ctx, [e.created_by], { kind: 'esign.signed', title: `${s.name} hat die Unterschrift abgelehnt`, body: `${e.title}: ${b.reason}`, link: `/esign?envelope=${e.id}` });
    changed();
    return { ok: true };
  });
}
