/**
 * Telefonie: Anrufliste, Anrufer-Anzeige, Notizen ins CRM, Wählen per Klick, Softphone-Zugang
 * und die Webhook-Adressen für sipgate, Placetel, 3CX und eigene Anlagen.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { openSecret, sealSecret } from '../services/secrets';
import { audit } from '../services/audit';
import {
  callFrom, callSelect, dialFritz, dialSipgate, handlePhoneEvent, lookupCaller, normalizeNumber, phoneConnectorStatus, prettyNumber, type PhoneEvent,
} from '../services/phone';

export default async function phoneRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, settings, config } = ctx;

  async function secret() {
    const s = await settings.get('phone');
    if (s.webhookSecret) return s.webhookSecret;
    const t = randomBytes(18).toString('base64url');
    await settings.set('phone', { ...s, webhookSecret: t });
    return t;
  }
  const hookUrls = async () => {
    const t = await secret();
    const base = `${config.publicUrl}/api/phone-hook`;
    return { sipgate: `${base}/sipgate/${t}`, placetel: `${base}/placetel/${t}`, generic: `${base}/generic/${t}`, threecxLookup: `${base}/3cx/${t}/lookup`, threecxJournal: `${base}/3cx/${t}/journal` };
  };
  const canSeeAll = (u: AuthUser) => u.role === 'admin' || u.role === 'teamlead';

  // ------------------------------------------------ Für den Benutzer
  app.get('/phone/config', async (req) => {
    const u = requireUser(req);
    const s = await settings.get('phone');
    const [p] = await sql<{ extension: string; numbers: string[]; sip_user: string; sip_password_sealed: string | null; sipgate_device: string }[]>`select * from phone_users where user_id = ${u.id}`;
    return {
      provider: s.provider, dialMethod: s.dialMethod, countryCode: s.countryCode,
      extension: p?.extension ?? '', numbers: p?.numbers ?? [], sipgateDevice: p?.sipgate_device ?? '',
      softphone: s.sipWsUrl && p?.sip_user ? { wsUrl: s.sipWsUrl, domain: s.sipDomain || new URL(s.sipWsUrl).hostname, user: p.sip_user, password: (await openSecret(ctx, p.sip_password_sealed)) ?? '' } : null,
      softphoneAvailable: Boolean(s.sipWsUrl),
    };
  });

  /** eigene Zugangsdaten für das Softphone bzw. sipgate-Gerät */
  app.put('/phone/me', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ sipUser: z.string().max(80).optional(), sipPassword: z.string().max(200).optional(), sipgateDevice: z.string().max(40).optional() }), req.body);
    await sql`insert into phone_users (user_id) values (${u.id}) on conflict do nothing`;
    await sql`update phone_users set sip_user = coalesce(${b.sipUser ?? null}, sip_user), sipgate_device = coalesce(${b.sipgateDevice ?? null}, sipgate_device),
      sip_password_sealed = ${b.sipPassword === undefined ? sql`sip_password_sealed` : b.sipPassword ? await sealSecret(ctx, b.sipPassword) : null}, updated_at = now() where user_id = ${u.id}`;
    return { ok: true };
  });

  app.get('/phone/calls', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ scope: z.enum(['mine', 'all']).default('mine'), missed: z.coerce.boolean().optional(), direction: z.enum(['in', 'out']).optional(),
      q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    if (q.scope === 'all' && !canSeeAll(u)) throw forbidden();
    const like = q.q ? `%${q.q}%` : null;
    const digits = q.q?.replace(/\D/g, '') ?? '';
    return sql`select ${callSelect(ctx)} from ${callFrom(ctx)} where true
      ${q.scope === 'mine' ? sql`and (c.user_id = ${u.id} or (c.user_id is null and c.direction = 'in'))` : sql``}
      ${q.missed ? sql`and c.status = 'missed'` : sql``} ${q.direction ? sql`and c.direction = ${q.direction}` : sql``}
      ${like ? sql`and (${digits.length >= 3 ? sql`c.remote_number like ${`%${digits}%`} or` : sql``} a.name ilike ${like} or ct.last_name ilike ${like} or ct.first_name ilike ${like} or c.note ilike ${like})` : sql``}
      order by c.started_at desc limit ${q.limit}`;
  });

  app.post('/phone/calls/:id/seen', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`update phone_calls set seen = true where id = ${id} and (user_id = ${u.id} or user_id is null)`;
    return { ok: true };
  });

  /** Gesprächsnotiz – auf Wunsch auch in den Verlauf des Kunden im CRM */
  app.post('/phone/calls/:id/note', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(10000), toCrm: z.boolean().default(true), accountId: z.string().uuid().optional() }), req.body);
    const [c] = await sql<{ user_id: string | null; crm_account_id: string | null; crm_contact_id: string | null; direction: string; remote_number: string; started_at: Date; duration_sec: number | null }[]>`
      select user_id, crm_account_id, crm_contact_id, direction, remote_number, started_at, duration_sec from phone_calls where id = ${id}`;
    if (!c) throw notFound();
    if (c.user_id && c.user_id !== u.id && !canSeeAll(u)) throw forbidden();
    const accountId = b.accountId ?? c.crm_account_id;
    let noteId: string | null = null;
    if (b.toCrm && accountId) {
      const when = c.started_at.toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' });
      const head = `${c.direction === 'in' ? 'Anruf von' : 'Anruf bei'} ${prettyNumber(c.remote_number)} am ${when}${c.duration_sec ? ` (${Math.ceil(c.duration_sec / 60)} Min.)` : ''}`;
      const [n] = await sql<{ id: string }[]>`insert into crm_notes (account_id, contact_id, user_id, body) values (${accountId}, ${c.crm_contact_id}, ${u.id}, ${`${head}\n\n${b.body}`}) returning id`;
      noteId = n!.id;
      await sql`update crm_accounts set last_contact_at = greatest(coalesce(last_contact_at, ${c.started_at}), ${c.started_at}) where id = ${accountId}`;
    }
    await sql`update phone_calls set note = ${b.body}, note_id = coalesce(${noteId}, note_id), crm_account_id = coalesce(crm_account_id, ${accountId ?? null}), user_id = coalesce(user_id, ${u.id}) where id = ${id}`;
    return { ok: true, noteId };
  });

  app.get('/phone/lookup', async (req) => {
    requireUser(req);
    const { number } = parse(z.object({ number: z.string().min(3).max(40) }), req.query);
    const s = await settings.get('phone');
    return { number: normalizeNumber(number, s), caller: await lookupCaller(ctx, number) };
  });

  /** Wählen per Klick */
  app.post('/phone/dial', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ number: z.string().trim().min(2).max(40) }), req.body);
    const s = await settings.get('phone');
    const n = normalizeNumber(b.number, s);
    // Für die Anlage: national mit 0, international mit 00; Amtsholung voranstellen
    const local = n.startsWith(s.countryCode) ? `0${n.slice(s.countryCode.length)}` : `00${n}`;
    const dialable = `${s.outsideLinePrefix}${n.length <= 4 ? n : local}`;
    if (s.dialMethod === 'fritzbox') { await dialFritz(s, dialable); return { method: 'fritzbox', number: dialable }; }
    if (s.dialMethod === 'sipgate') {
      const [p] = await sql<{ sipgate_device: string }[]>`select sipgate_device from phone_users where user_id = ${u.id}`;
      if (!p?.sipgate_device) throw badRequest('Bitte unter Telefonie → Einstellungen Ihr sipgate-Gerät (z. B. e0) eintragen');
      await dialSipgate(s, p.sipgate_device, `+${n}`);
      return { method: 'sipgate', number: `+${n}` };
    }
    return { method: s.dialMethod, number: s.dialMethod === 'softphone' ? dialable : `+${n}` };
  });

  /** Anrufe des Softphones im Browser ins Protokoll schreiben */
  app.post('/phone/softphone-event', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ type: z.enum(['ring', 'call', 'answer', 'hangup']), callId: z.string().max(200), number: z.string().max(80).default('') }), req.body);
    const [p] = await sql<{ sip_user: string; extension: string }[]>`select sip_user, extension from phone_users where user_id = ${u.id}`;
    const ext = p?.extension || p?.sip_user || '';
    const ev: PhoneEvent = { source: 'softphone', type: b.type, callId: `${u.id}:${b.callId}`, extension: ext,
      ...(b.type === 'ring' ? { from: b.number, to: ext } : b.type === 'call' ? { from: ext, to: b.number } : {}) };
    const id = await handlePhoneEvent(ctx, ev);
    if (id && (b.type === 'ring' || b.type === 'call')) await sql`update phone_calls set user_id = ${u.id} where id = ${id}`;
    return { id };
  });

  // ------------------------------------------------ Verwaltung
  app.get('/phone/admin', async (req) => {
    requireRole(req, 'admin');
    const users = await sql`select u.id, u.display_name as "displayName", coalesce(p.extension, '') as extension, coalesce(p.numbers, '{}') as numbers,
      coalesce(p.sip_user, '') as "sipUser", p.sip_password_sealed is not null as "hasSipPassword", coalesce(p.sipgate_device, '') as "sipgateDevice", p.user_id is not null as enabled
      from users u left join phone_users p on p.user_id = u.id where u.active and u.deleted_at is null and u.role <> 'guest' order by u.display_name`;
    return { hooks: await hookUrls(), connector: phoneConnectorStatus(), users };
  });

  app.put('/phone/admin/users/:id', async (req) => {
    const admin = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ enabled: z.boolean(), extension: z.string().max(40).default(''), numbers: z.array(z.string().max(40)).max(10).default([]),
      sipUser: z.string().max(80).optional(), sipPassword: z.string().max(200).optional(), sipgateDevice: z.string().max(40).optional() }), req.body);
    if (!b.enabled) { await sql`delete from phone_users where user_id = ${id}`; return { ok: true }; }
    await sql`insert into phone_users (user_id) values (${id}) on conflict do nothing`;
    await sql`update phone_users set extension = ${b.extension.trim()}, numbers = ${b.numbers.map((n) => n.trim()).filter(Boolean)},
      sip_user = coalesce(${b.sipUser ?? null}, sip_user), sipgate_device = coalesce(${b.sipgateDevice ?? null}, sipgate_device),
      sip_password_sealed = ${b.sipPassword === undefined ? sql`sip_password_sealed` : b.sipPassword ? await sealSecret(ctx, b.sipPassword) : null}, updated_at = now() where user_id = ${id}`;
    await audit(sql, admin, { action: 'phone.user', entityType: 'user', entityId: id, summary: `Telefonie für Benutzer eingerichtet (Nebenstelle ${b.extension || '–'})` });
    return { ok: true };
  });

  app.post('/phone/admin/new-secret', async (req) => {
    requireRole(req, 'admin');
    const s = await settings.get('phone');
    await settings.set('phone', { ...s, webhookSecret: randomBytes(18).toString('base64url') });
    return hookUrls();
  });

  /** Testanruf: simuliert ein eingehendes Klingeln, damit die Anzeige geprüft werden kann */
  app.post('/phone/admin/test-call', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ number: z.string().min(3).max(40) }), req.body);
    const [p] = await sql<{ extension: string }[]>`select extension from phone_users where user_id = ${u.id}`;
    const callId = `test-${randomBytes(4).toString('hex')}`;
    await handlePhoneEvent(ctx, { source: 'test', type: 'ring', callId, from: b.number, to: '', extension: p?.extension || undefined });
    setTimeout(() => { void handlePhoneEvent(ctx, { source: 'test', type: 'hangup', callId }).catch(() => {}); }, 20000);
    return { ok: true };
  });

  /** Vorlage für die CRM-Anbindung in 3CX (Admin-Konsole → Einstellungen → CRM-Integration → Server-Side) */
  app.get('/phone/admin/3cx-template.xml', async (req, reply) => {
    requireRole(req, 'admin');
    const h = await hookUrls();
    const company = (await settings.get('company')).name;
    const xml = `<?xml version="1.0"?>
<Crm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" Country="DE" Name="AperioPlan" Version="1" SupportsEmojis="true" ListenerName="aperioplan">
  <Number Prefix="AsIs" MaxLength="[MaxLength]" />
  <Connection MaxConcurrentRequests="16" />
  <Parameters />
  <Authentication Type="No" />
  <Scenarios>
    <Scenario Id="" Type="REST">
      <Request SkipIf="" Url="${h.threecxLookup}?number=[Number]" MessagePasses="0" RequestEncoding="UrlEncoded" RequestType="Get" ResponseType="Json" />
      <Rules><Rule Type="Any">contacts.id</Rule></Rules>
      <Variables>
        <Variable Name="ContactID" Path="contacts.id"><Filter /></Variable>
        <Variable Name="FirstName" Path="contacts.firstName"><Filter /></Variable>
        <Variable Name="LastName" Path="contacts.lastName"><Filter /></Variable>
        <Variable Name="CompanyName" Path="contacts.company"><Filter /></Variable>
        <Variable Name="PhoneBusiness" Path="contacts.phone"><Filter /></Variable>
        <Variable Name="ContactUrl" Path="contacts.url"><Filter /></Variable>
      </Variables>
      <Outputs AllowEmpty="false">
        <Output Type="ContactID" Passes="0" Value="[ContactID]" />
        <Output Type="FirstName" Passes="0" Value="[FirstName]" />
        <Output Type="LastName" Passes="0" Value="[LastName]" />
        <Output Type="CompanyName" Passes="0" Value="[CompanyName]" />
        <Output Type="PhoneBusiness" Passes="0" Value="[PhoneBusiness]" />
        <Output Type="ContactUrl" Passes="0" Value="[ContactUrl]" />
        <Output Type="EntityType" Passes="0" Value="Contacts" />
        <Output Type="EntityId" Passes="0" Value="[ContactID]" />
      </Outputs>
    </Scenario>
    <Scenario Id="ReportCall" Type="REST">
      <Request SkipIf="" Url="${h.threecxJournal}" MessagePasses="0" RequestContentType="application/json" RequestEncoding="Json" RequestType="Post" ResponseType="Json">
        <PostValues>
          <Value Key="callType" Passes="1" Type="String">[CallType]</Value>
          <Value Key="number" Passes="1" Type="String">[Number]</Value>
          <Value Key="agent" Passes="1" Type="String">[Agent]</Value>
          <Value Key="start" Passes="1" Type="String">[DateTime]</Value>
          <Value Key="duration" Passes="1" Type="String">[Duration]</Value>
        </PostValues>
      </Request>
      <Variables /><Outputs AllowEmpty="true" />
    </Scenario>
  </Scenarios>
</Crm>
<!-- ${company} -->`;
    reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', 'attachment; filename="AperioPlan-3CX.xml"');
    return xml;
  });

  // ------------------------------------------------ Webhooks (ohne Anmeldung, mit Geheimnis in der Adresse)
  async function checkHook(t: string) {
    const s = await settings.get('phone');
    const { installed } = await settings.get('apps');
    if (!s.webhookSecret || t !== s.webhookSecret || !installed.includes('phone')) throw notFound();
    return s;
  }
  const hookParams = z.object({ secret: z.string().max(80) });
  const str = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));

  /** sipgate.io: newCall → Antwort mit onAnswer/onHangup, damit auch diese Ereignisse kommen */
  app.post('/phone-hook/sipgate/:secret', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply: FastifyReply) => {
    const { secret: t } = parse(hookParams, req.params);
    await checkHook(t);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const event = str(b.event), callId = str(b.callId) || str(b.origCallId);
    const ext = str(b.userId) || str(b.fullUserId);
    if (event === 'newCall') {
      await handlePhoneEvent(ctx, { source: 'sipgate', type: str(b.direction) === 'out' ? 'call' : 'ring', callId, from: str(b.from), to: str(b.to), extension: ext || undefined });
      const url = `${config.publicUrl}/api/phone-hook/sipgate/${t}`;
      reply.header('content-type', 'application/xml');
      return `<?xml version="1.0" encoding="UTF-8"?><Response onAnswer="${url}" onHangup="${url}" />`;
    }
    if (event === 'answer') await handlePhoneEvent(ctx, { source: 'sipgate', type: 'answer', callId, extension: ext || undefined });
    if (event === 'hangup') await handlePhoneEvent(ctx, { source: 'sipgate', type: 'hangup', callId, cause: str(b.cause) });
    reply.header('content-type', 'application/xml');
    return '<?xml version="1.0" encoding="UTF-8"?><Response />';
  });

  /** Placetel: IncomingCall, OutgoingCall, CallAccepted, HungUp */
  app.post('/phone-hook/placetel/:secret', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { secret: t } = parse(hookParams, req.params);
    await checkHook(t);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const event = str(b.event), callId = str(b.call_id);
    const peer = str(b.peer).split('@')[0];
    if (event === 'IncomingCall') await handlePhoneEvent(ctx, { source: 'placetel', type: 'ring', callId, from: str(b.from), to: str(b.to), extension: peer || undefined });
    else if (event === 'OutgoingCall') await handlePhoneEvent(ctx, { source: 'placetel', type: 'call', callId, from: str(b.from), to: str(b.to), extension: peer || undefined });
    else if (event === 'CallAccepted') await handlePhoneEvent(ctx, { source: 'placetel', type: 'answer', callId, extension: peer || undefined });
    else if (event === 'HungUp') await handlePhoneEvent(ctx, { source: 'placetel', type: 'hangup', callId, cause: str(b.type), duration: Number(str(b.duration)) || undefined });
    return { ok: true };
  });

  /** Allgemeine Schnittstelle für jede Anlage: {event: ring|call|answer|hangup, callId, from, to, extension, duration} */
  app.post('/phone-hook/generic/:secret', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { secret: t } = parse(hookParams, req.params);
    await checkHook(t);
    const b = parse(z.object({ event: z.enum(['ring', 'call', 'answer', 'hangup']), callId: z.string().min(1).max(200), from: z.string().max(80).optional(), to: z.string().max(80).optional(),
      extension: z.string().max(80).optional(), duration: z.number().int().min(0).optional(), cause: z.string().max(40).optional() }), req.body);
    const id = await handlePhoneEvent(ctx, { source: 'generic', type: b.event, callId: b.callId, from: b.from, to: b.to, extension: b.extension, duration: b.duration, cause: b.cause });
    return { ok: true, id };
  });

  /** 3CX: Kontaktsuche für die Anrufer-Anzeige im 3CX-Client */
  app.get('/phone-hook/3cx/:secret/lookup', async (req) => {
    const { secret: t } = parse(hookParams, req.params);
    await checkHook(t);
    const { number } = parse(z.object({ number: z.string().max(40).default('') }), req.query);
    const c = await lookupCaller(ctx, number);
    if (!c || c.kind === 'colleague') return { contacts: [] };
    const [first, ...rest] = c.kind === 'contact' ? c.name.split(' ') : [''];
    return { contacts: [{ id: c.contactId ?? c.accountId, firstName: first ?? '', lastName: c.kind === 'contact' ? rest.join(' ') : c.name, company: c.accountName ?? '', phone: number,
      url: `${config.publicUrl}/crm/${c.accountId}` }] };
  });

  /** 3CX: Anrufprotokoll nach dem Gespräch */
  app.post('/phone-hook/3cx/:secret/journal', async (req) => {
    const { secret: t } = parse(hookParams, req.params);
    await checkHook(t);
    const b = (req.body ?? {}) as Record<string, string>;
    const dir = /outbound/i.test(b.callType ?? '') ? 'out' : 'in';
    const missed = /missed|notanswered/i.test(b.callType ?? '');
    const callId = `3cx-${b.start}-${b.number}-${b.agent}`;
    await handlePhoneEvent(ctx, { source: '3cx', type: dir === 'in' ? 'ring' : 'call', callId, from: dir === 'in' ? b.number : b.agent, to: dir === 'in' ? b.agent : b.number, extension: b.agent });
    if (!missed) await handlePhoneEvent(ctx, { source: '3cx', type: 'answer', callId, extension: b.agent });
    const [h, m, sec] = String(b.duration ?? '0').split(':').map(Number);
    await handlePhoneEvent(ctx, { source: '3cx', type: 'hangup', callId, duration: sec !== undefined ? (h! * 3600 + m! * 60 + sec) : Number(b.duration) || 0 });
    return { ok: true };
  });
}
