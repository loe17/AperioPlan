/**
 * Telefonie: Rufnummern vereinheitlichen, Anrufer im CRM finden, Anrufereignisse der Telefonanlage
 * verarbeiten und an die richtigen Mitarbeiter melden. Anbindungen:
 *  - FRITZ!Box: Anrufmonitor (TCP 1012) und Wählhilfe (TR-064)
 *  - Asterisk/FreePBX: Manager-Schnittstelle (AMI, TCP 5038)
 *  - sipgate, Placetel, 3CX und allgemeine Schnittstelle: Webhooks (siehe routes/phone.ts)
 */
import { createHash, randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import type { AppContext } from '../context';
import type { PhoneSettings } from './settings';
import { notify } from './notify';

export interface PhoneEvent {
  source: string;
  type: 'ring' | 'call' | 'answer' | 'hangup';
  callId: string;
  from?: string;
  to?: string;
  /** Nebenstelle oder SIP-Benutzer des Mitarbeiters */
  extension?: string;
  cause?: string;
  duration?: number;
}

/** Rufnummer auf internationale Ziffernfolge bringen: „0771 123-45“ → „4977112345“ */
export function normalizeNumber(raw: string, s: Pick<PhoneSettings, 'countryCode' | 'areaCode' | 'outsideLinePrefix'>): string {
  let n = (raw ?? '').trim();
  if (!n || /anonym|unknown|unbekannt/i.test(n)) return '';
  const plus = n.startsWith('+');
  n = n.replace(/\(0\)/g, '');
  n = n.replace(/[^\d]/g, '');
  if (!n) return '';
  if (plus) return n;
  if (s.outsideLinePrefix && n.startsWith(s.outsideLinePrefix) && n.length > 6) n = n.slice(s.outsideLinePrefix.length);
  if (n.startsWith('00')) return n.slice(2);
  if (n.startsWith('0')) return (s.countryCode || '49') + n.slice(1);
  // ohne Vorwahl: Ortsnetz ergänzen, sehr kurze Nummern sind Nebenstellen;
  // lange Nummern ohne führende 0 sind bereits international (z. B. 491701234567 von sipgate)
  if (n.length <= 4) return n;
  if (n.length >= 10) return n;
  return (s.countryCode || '49') + (s.areaCode || '') + n;
}

/** Anzeige: +49 771 12345 */
export const prettyNumber = (n: string) => (n.length > 6 ? `+${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}` : n);

export interface Caller {
  kind: 'contact' | 'account' | 'colleague';
  name: string;
  contactId?: string; accountId?: string; accountName?: string; accountNumber?: string; userId?: string;
  position?: string; city?: string;
  lastNote?: { body: string; at: Date; by: string | null } | null;
  openCases?: number; openQuotes?: number;
}

/** Wer ruft an? Kontakte, Firmen und Kollegen nach den letzten 7 Ziffern vorsortieren, dann genau vergleichen */
export async function lookupCaller(ctx: AppContext, number: string): Promise<Caller | null> {
  const s = await ctx.settings.get('phone');
  const n = normalizeNumber(number, s);
  if (n.length < 5) return null;
  const tail = n.slice(-7);
  const { sql } = ctx;
  const contacts = await sql<{ id: string; name: string; position: string; account_id: string; account: string; number: string; city: string; phone: string; mobile: string }[]>`
    select c.id, trim(c.first_name || ' ' || c.last_name) as name, c.position, a.id as account_id, a.name as account, a.number, a.city, c.phone, c.mobile
    from crm_contacts c join crm_accounts a on a.id = c.account_id
    where right(regexp_replace(c.phone, '\\D', '', 'g'), 7) = ${tail} or right(regexp_replace(c.mobile, '\\D', '', 'g'), 7) = ${tail} limit 20`;
  const contact = contacts.find((c) => normalizeNumber(c.phone, s) === n || normalizeNumber(c.mobile, s) === n);
  let caller: Caller | null = contact ? { kind: 'contact', name: contact.name, contactId: contact.id, accountId: contact.account_id, accountName: contact.account, accountNumber: contact.number, position: contact.position, city: contact.city } : null;
  if (!caller) {
    const accounts = await sql<{ id: string; name: string; number: string; city: string; phone: string }[]>`
      select id, name, number, city, phone from crm_accounts where right(regexp_replace(phone, '\\D', '', 'g'), 7) = ${tail} limit 20`;
    const a = accounts.find((x) => normalizeNumber(x.phone, s) === n);
    if (a) caller = { kind: 'account', name: a.name, accountId: a.id, accountName: a.name, accountNumber: a.number, city: a.city };
  }
  if (!caller) {
    const users = await sql<{ id: string; display_name: string; phone: string }[]>`select id, display_name, phone from users where active and deleted_at is null and right(regexp_replace(phone, '\\D', '', 'g'), 7) = ${tail}`;
    const u = users.find((x) => normalizeNumber(x.phone, s) === n);
    if (u) caller = { kind: 'colleague', name: u.display_name, userId: u.id };
  }
  if (caller?.accountId) {
    const [note] = await sql<{ body: string; at: Date; by: string | null }[]>`select n.body, n.created_at as at, u.display_name as by from crm_notes n left join users u on u.id = n.user_id
      where n.account_id = ${caller.accountId} order by n.created_at desc limit 1`;
    caller.lastNote = note ?? null;
    const [k] = await sql<{ cases: number; quotes: number }[]>`select (select count(*)::int from crm_cases where account_id = ${caller.accountId} and status <> 'closed') as cases,
      (select count(*)::int from crm_quotes where account_id = ${caller.accountId} and status = 'sent') as quotes`;
    caller.openCases = k?.cases ?? 0; caller.openQuotes = k?.quotes ?? 0;
  }
  return caller;
}

/** Mitarbeiter zu einer Nebenstelle oder Durchwahl */
async function userFor(ctx: AppContext, s: PhoneSettings, extension?: string, ourNumber?: string): Promise<string | null> {
  if (extension) {
    const [u] = await ctx.sql<{ user_id: string }[]>`select user_id from phone_users where extension = ${extension} or sip_user = ${extension} limit 1`;
    if (u) return u.user_id;
  }
  if (ourNumber) {
    const n = normalizeNumber(ourNumber, s);
    const rows = await ctx.sql<{ user_id: string; numbers: string[] }[]>`select user_id, numbers from phone_users where array_length(numbers, 1) > 0`;
    const hit = rows.find((r) => r.numbers.some((x) => normalizeNumber(x, s) === n || x === ourNumber));
    if (hit) return hit.user_id;
  }
  return null;
}

async function phoneUserIds(ctx: AppContext): Promise<string[]> {
  return (await ctx.sql<{ user_id: string }[]>`select p.user_id from phone_users p join users u on u.id = p.user_id where u.active and u.deleted_at is null`).map((r) => r.user_id);
}

const callSelect = (ctx: AppContext) => ctx.sql`c.id, c.source, c.direction, c.from_number as "fromNumber", c.to_number as "toNumber", c.remote_number as "remoteNumber",
  c.user_id as "userId", u.display_name as "userName", c.crm_account_id as "accountId", a.name as "accountName", c.crm_contact_id as "contactId",
  trim(ct.first_name || ' ' || ct.last_name) as "contactName", c.colleague_id as "colleagueId", cu.display_name as "colleagueName", c.status,
  c.started_at as "startedAt", c.answered_at as "answeredAt", c.ended_at as "endedAt", c.duration_sec as "durationSec", c.note, c.seen`;
const callFrom = (ctx: AppContext) => ctx.sql`phone_calls c left join users u on u.id = c.user_id left join crm_accounts a on a.id = c.crm_account_id
  left join crm_contacts ct on ct.id = c.crm_contact_id left join users cu on cu.id = c.colleague_id`;
export { callSelect, callFrom };

/** Anrufereignis verarbeiten (aus Anrufmonitor, AMI oder Webhook) */
export async function handlePhoneEvent(ctx: AppContext, ev: PhoneEvent): Promise<string | null> {
  const { sql } = ctx;
  const s = await ctx.settings.get('phone');
  const [existing] = await sql<{ id: string; user_id: string | null; status: string; answered_at: Date | null; direction: string; started_at: Date }[]>`
    select id, user_id, status, answered_at, direction, started_at from phone_calls where source = ${ev.source} and external_id = ${ev.callId}`;
  if (ev.type === 'ring' || ev.type === 'call') {
    if (existing) return existing.id;
    const direction = ev.type === 'ring' ? 'in' : 'out';
    const remote = normalizeNumber(direction === 'in' ? ev.from ?? '' : ev.to ?? '', s);
    const userId = await userFor(ctx, s, ev.extension, direction === 'in' ? ev.to : ev.from);
    const caller = remote ? await lookupCaller(ctx, remote) : null;
    const [row] = await sql<{ id: string }[]>`insert into phone_calls (source, external_id, direction, from_number, to_number, remote_number, user_id, crm_account_id, crm_contact_id, colleague_id)
      values (${ev.source}, ${ev.callId}, ${direction}, ${ev.from ?? ''}, ${ev.to ?? ''}, ${remote}, ${userId}, ${caller?.accountId ?? null}, ${caller?.contactId ?? null}, ${caller?.userId ?? null})
      on conflict (source, external_id) where external_id is not null do nothing returning id`;
    if (!row) return null;
    const recipients = userId ? [userId] : direction === 'in' && s.popupForAll ? await phoneUserIds(ctx) : [];
    const payload = { id: row.id, direction, number: remote ? prettyNumber(remote) : 'unbekannt', rawNumber: remote, caller };
    for (const uid of recipients) ctx.hub.toUser(uid, direction === 'in' ? 'phone.ring' : 'phone.call', payload);
    return row.id;
  }
  if (!existing) return null;
  if (ev.type === 'answer') {
    const userId = existing.user_id ?? (await userFor(ctx, s, ev.extension));
    await sql`update phone_calls set status = 'answered', answered_at = coalesce(answered_at, now()), user_id = ${userId} where id = ${existing.id}`;
    const recipients = await phoneUserIds(ctx);
    for (const uid of recipients) ctx.hub.toUser(uid, 'phone.answered', { id: existing.id, userId });
    return existing.id;
  }
  // Auflegen
  const answered = existing.status === 'answered' || Boolean(existing.answered_at);
  const status = answered ? 'ended' : existing.direction === 'in' ? 'missed' : ev.cause === 'busy' ? 'busy' : 'failed';
  const duration = ev.duration ?? (existing.answered_at ? Math.round((Date.now() - existing.answered_at.getTime()) / 1000) : 0);
  await sql`update phone_calls set status = ${status}, ended_at = now(), duration_sec = ${answered ? duration : 0} where id = ${existing.id}`;
  for (const uid of await phoneUserIds(ctx)) ctx.hub.toUser(uid, 'phone.ended', { id: existing.id, status });
  if (status === 'missed' && existing.user_id) {
    const [c] = await sql`select ${callSelect(ctx)} from ${callFrom(ctx)} where c.id = ${existing.id}`;
    const who = c?.contactName || c?.accountName || (c?.remoteNumber ? prettyNumber(c.remoteNumber) : 'unbekannt');
    await notify(ctx, [existing.user_id], { kind: 'phone.missed', title: `Verpasster Anruf: ${who}`, body: c?.accountName && c.contactName ? c.accountName : '', link: '/phone' });
  }
  return existing.id;
}

// ------------------------------------------------------------ FRITZ!Box-Anrufmonitor
/**
 * Zeilen des Anrufmonitors (vorher am Telefon #96*5* wählen):
 *   28.10.26 13:45:01;RING;0;01701234567;7712345;SIP0;
 *   28.10.26 13:45:05;CALL;1;11;7712345;01701234567;SIP0;
 *   28.10.26 13:45:09;CONNECT;0;11;01701234567;
 *   28.10.26 13:46:30;DISCONNECT;0;81;
 */
export function parseFritzLine(line: string, session: string): PhoneEvent | null {
  const p = line.trim().split(';');
  if (p.length < 4) return null;
  const callId = `${session}:${p[2]}`;
  switch (p[1]) {
    case 'RING': return { source: 'fritzbox', type: 'ring', callId, from: p[3], to: p[4] };
    case 'CALL': return { source: 'fritzbox', type: 'call', callId, extension: p[3], from: p[4], to: p[5] };
    case 'CONNECT': return { source: 'fritzbox', type: 'answer', callId, extension: p[3] };
    case 'DISCONNECT': return { source: 'fritzbox', type: 'hangup', callId, duration: Number(p[3]) || 0 };
    default: return null;
  }
}

interface Connector { stop(): void; status(): { connected: boolean; error: string | null; since: Date | null } }
let current: Connector | null = null;
let currentKey = '';

/** Dauerhafte Verbindung zur Telefonanlage je nach Einstellung (FRITZ!Box oder Asterisk) */
export async function startPhoneConnector(ctx: AppContext) {
  const { installed } = await ctx.settings.get('apps');
  const s = await ctx.settings.get('phone');
  const key = installed.includes('phone') ? JSON.stringify([s.provider, s.fritzHost, s.fritzMonitorPort, s.amiHost, s.amiPort, s.amiUser, s.amiPassword]) : 'off';
  if (key === currentKey) return;
  current?.stop(); current = null; currentKey = key;
  if (key === 'off' || ctx.config.isTest) return;
  if (s.provider === 'fritzbox' && s.fritzHost) current = tcpConnector(s.fritzHost, s.fritzMonitorPort || 1012, fritzHandler(ctx));
  if (s.provider === 'asterisk' && s.amiHost) current = amiConnector(ctx, s);
}
export const phoneConnectorStatus = () => current?.status() ?? null;

function fritzHandler(ctx: AppContext) {
  const session = randomBytes(3).toString('hex');
  return (line: string) => { const ev = parseFritzLine(line, session); if (ev) void handlePhoneEvent(ctx, ev).catch(() => {}); };
}

function tcpConnector(host: string, port: number, onLine: (line: string) => void, onConnect?: (s: Socket) => void): Connector {
  let stopped = false, sock: Socket | null = null, connected = false, error: string | null = null, since: Date | null = null, buf = '', retry = 2000;
  const connect = () => {
    if (stopped) return;
    sock = new Socket();
    sock.setKeepAlive(true, 30000);
    sock.connect(port, host, () => { connected = true; error = null; since = new Date(); retry = 2000; onConnect?.(sock!); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); onLine(line); }
    });
    sock.on('error', (e) => { error = e.message; });
    sock.on('close', () => { connected = false; buf = ''; if (!stopped) { setTimeout(connect, retry); retry = Math.min(retry * 2, 60000); } });
  };
  connect();
  return { stop: () => { stopped = true; sock?.destroy(); }, status: () => ({ connected, error, since }) };
}

// ------------------------------------------------------------ Asterisk / FreePBX (AMI)
function amiConnector(ctx: AppContext, s: PhoneSettings): Connector {
  let block: Record<string, string> = {};
  /** Uniqueid → Anruf; Linkedid bündelt die Kanäle eines Gesprächs */
  const handle = (ev: Record<string, string>) => {
    const linked = ev.Linkedid || ev.Uniqueid;
    if (!linked) return;
    const callId = `ami:${linked}`;
    const isExt = (n?: string) => Boolean(n && /^\d{2,5}$/.test(n));
    switch (ev.Event) {
      case 'DialBegin': {
        // Eingehend: externer Anrufer → interne Nebenstelle; ausgehend: Nebenstelle → externe Nummer
        const dest = ev.DestCallerIDNum || ev.DialString?.split('/').pop() || '';
        if (isExt(dest) && !isExt(ev.CallerIDNum)) void handlePhoneEvent(ctx, { source: 'asterisk', type: 'ring', callId, from: ev.CallerIDNum, to: ev.Exten || dest, extension: dest });
        else if (isExt(ev.CallerIDNum) && !isExt(dest)) void handlePhoneEvent(ctx, { source: 'asterisk', type: 'call', callId, extension: ev.CallerIDNum, from: ev.CallerIDNum, to: dest });
        break;
      }
      case 'BridgeEnter':
        void handlePhoneEvent(ctx, { source: 'asterisk', type: 'answer', callId, extension: isExt(ev.CallerIDNum) ? ev.CallerIDNum : ev.ConnectedLineNum });
        break;
      case 'Hangup':
        if (ev.Uniqueid === linked) void handlePhoneEvent(ctx, { source: 'asterisk', type: 'hangup', callId, cause: ev['Cause-txt']?.toLowerCase().includes('busy') ? 'busy' : undefined });
        break;
    }
  };
  return tcpConnector(s.amiHost, s.amiPort || 5038, (line) => {
    if (line === '') { if (block.Event) handle(block); block = {}; return; }
    const i = line.indexOf(':');
    if (i > 0) block[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }, (sock) => {
    sock.write(`Action: Login\r\nUsername: ${s.amiUser}\r\nSecret: ${s.amiPassword}\r\nEvents: call\r\n\r\n`);
  });
}

// ------------------------------------------------------------ Wählhilfen
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** HTTP-Digest-Anmeldung (FRITZ!Box TR-064) */
async function digestFetch(url: string, init: RequestInit, user: string, pass: string) {
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (first.status !== 401) return first;
  const h = first.headers.get('www-authenticate') ?? '';
  const get = (k: string) => new RegExp(`${k}="?([^",]+)"?`).exec(h)?.[1] ?? '';
  const realm = get('realm'), nonce = get('nonce'), qop = get('qop') ? 'auth' : '';
  const path = new URL(url).pathname;
  const ha1 = md5(`${user}:${realm}:${pass}`), ha2 = md5(`${init.method ?? 'GET'}:${path}`);
  const cnonce = randomBytes(8).toString('hex'), nc = '00000001';
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const auth = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${response}"${qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : ''}`;
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: auth }, signal: AbortSignal.timeout(10000) });
}

/** FRITZ!Box-Wählhilfe: Die Box klingelt am eingestellten Telefon und wählt dann die Nummer */
export async function dialFritz(s: PhoneSettings, number: string) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>`
    + `<u:X_AVM-DE_DialNumber xmlns:u="urn:dslforum-org:service:X_VoIP:1"><NewX_AVM-DE_PhoneNumber>${number.replace(/[^\d*#+]/g, '')}</NewX_AVM-DE_PhoneNumber></u:X_AVM-DE_DialNumber></s:Body></s:Envelope>`;
  const res = await digestFetch(`http://${s.fritzHost}:49000/upnp/control/x_voip`, {
    method: 'POST', body, headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: 'urn:dslforum-org:service:X_VoIP:1#X_AVM-DE_DialNumber' },
  }, s.fritzUser, s.fritzPassword).catch((e: Error) => { throw new Error(`FRITZ!Box nicht erreichbar: ${e.message}`); });
  if (!res.ok) throw new Error(res.status === 401 ? 'FRITZ!Box: Anmeldung abgelehnt (Benutzer/Passwort prüfen)' : res.status === 500 ? 'FRITZ!Box: Wählhilfe ist nicht eingeschaltet (Telefonie → Anrufe → Wählhilfe)' : `FRITZ!Box: Fehler ${res.status}`);
}

/** sipgate: Anruf über die REST-Schnittstelle (klingelt zuerst am eigenen Gerät) */
export async function dialSipgate(s: PhoneSettings, deviceId: string, number: string) {
  const res = await fetch('https://api.sipgate.com/v2/sessions/calls', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${s.sipgateTokenId}:${s.sipgateToken}`).toString('base64')}` },
    body: JSON.stringify({ deviceId, callee: number }),
  }).catch((e: Error) => { throw new Error(`sipgate nicht erreichbar: ${e.message}`); });
  if (!res.ok) throw new Error(`sipgate: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
