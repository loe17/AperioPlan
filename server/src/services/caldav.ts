/**
 * Kalender-Abgleich mit dem E-Mail-Konto: CalDAV (Nextcloud, Google, mailbox.org, Synology …) in beide Richtungen,
 * Kalender-Abo-Links (.ics) nur lesend.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { buildIcs, parseIcs, type IcsEvent } from '../lib/ical';
import { openSecret } from './secrets';

export interface CalendarAccount {
  id: string; user_id: string; kind: 'caldav' | 'ics'; name: string; url: string; username: string; password_sealed: string;
  color: string; push_new: boolean;
}

interface DavItem { href: string; etag: string; data: string }

const tag = (name: string) => new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${name}>`, 'g');
const first = (xml: string, name: string) => { const m = tag(name).exec(xml); return m ? m[1]! : null; };
const xmlUnescape = (v: string) => v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&amp;/g, '&');

async function davFetch(ctx: AppContext, acc: CalendarAccount, url: string, method: string, body?: string, headers: Record<string, string> = {}) {
  const auth: Record<string, string> = acc.username ? { Authorization: `Basic ${Buffer.from(`${acc.username}:${(await openSecret(ctx, acc.password_sealed)) ?? ""}`).toString('base64')}` } : {};
  const res = await fetch(url, { method, body, headers: { ...auth, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  return res;
}

function abs(base: string, href: string) {
  return new URL(href, base).toString();
}

/** Findet zu einer Server-Adresse den ersten Kalender (falls nicht direkt die Kalender-Adresse eingetragen wurde) */
export async function discoverCalendar(ctx: AppContext, acc: CalendarAccount): Promise<string> {
  const propfind = (props: string) => `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;
  const res = await davFetch(ctx, acc, acc.url, 'PROPFIND', propfind('<d:resourcetype/><d:current-user-principal/><c:calendar-home-set/>'), { Depth: '0', 'Content-Type': 'application/xml' });
  if (res.status === 401) throw new Error('Anmeldung abgelehnt – Benutzer oder (App-)Passwort prüfen');
  if (res.status >= 400) throw new Error(`Server antwortet mit ${res.status}`);
  const xml = await res.text();
  if (/<(?:[a-zA-Z0-9]+:)?calendar\s*\/>/.test(first(xml, 'resourcetype') ?? '')) return acc.url;
  let home = first(first(xml, 'calendar-home-set') ?? '', 'href');
  if (!home) {
    const principal = first(first(xml, 'current-user-principal') ?? '', 'href');
    if (!principal) throw new Error('Unter dieser Adresse wurde kein Kalender gefunden');
    const r2 = await davFetch(ctx, acc, abs(acc.url, principal), 'PROPFIND', propfind('<c:calendar-home-set/>'), { Depth: '0', 'Content-Type': 'application/xml' });
    home = first(first(await r2.text(), 'calendar-home-set') ?? '', 'href');
    if (!home) throw new Error('Kalender-Verzeichnis nicht gefunden');
  }
  const homeUrl = abs(acc.url, home);
  const r3 = await davFetch(ctx, acc, homeUrl, 'PROPFIND', propfind('<d:resourcetype/><d:displayname/>'), { Depth: '1', 'Content-Type': 'application/xml' });
  const list = await r3.text();
  for (const m of list.matchAll(tag('response'))) {
    const block = m[1]!;
    if (/<(?:[a-zA-Z0-9]+:)?calendar\s*\/>/.test(first(block, 'resourcetype') ?? '')) return abs(homeUrl, first(block, 'href')!.trim());
  }
  throw new Error('Kein Kalender im Konto gefunden');
}

async function report(ctx: AppContext, acc: CalendarAccount, url: string, from: Date, to: Date): Promise<DavItem[]> {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const res = await davFetch(ctx, acc, url, 'REPORT', body, { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' });
  if (res.status === 401) throw new Error('Anmeldung abgelehnt – Benutzer oder (App-)Passwort prüfen');
  if (res.status >= 400) throw new Error(`Server antwortet mit ${res.status}`);
  const xml = await res.text();
  const items: DavItem[] = [];
  for (const m of xml.matchAll(tag('response'))) {
    const block = m[1]!;
    const data = first(block, 'calendar-data');
    const href = first(block, 'href');
    if (!data || !href) continue;
    items.push({ href: abs(url, href.trim()), etag: xmlUnescape(first(block, 'getetag') ?? '').trim(), data: xmlUnescape(data) });
  }
  return items;
}

/** Kalender-Adresse merken wir nicht extra – wird bei Bedarf ermittelt und zwischengespeichert */
const calendarUrlCache = new Map<string, string>();
async function calendarUrl(ctx: AppContext, acc: CalendarAccount) {
  const key = `${acc.id}:${acc.url}`;
  let url = calendarUrlCache.get(key);
  if (!url) { url = await discoverCalendar(ctx, acc); calendarUrlCache.set(key, url); }
  return url.endsWith('/') ? url : `${url}/`;
}

/** Holt Termine des Kontos und gleicht sie mit den lokalen Kopien ab */
export async function syncAccount(ctx: AppContext, acc: CalendarAccount): Promise<{ count: number }> {
  const from = new Date(Date.now() - 60 * 86400000), to = new Date(Date.now() + 400 * 86400000);
  const seen = new Set<string>();
  let count = 0;
  try {
    let items: { uid: string; ev: IcsEvent; href: string | null; etag: string | null }[] = [];
    if (acc.kind === 'ics') {
      const res = await davFetch(ctx, acc, acc.url.replace(/^webcal:/i, 'https:'), 'GET');
      if (res.status >= 400) throw new Error(`Abo-Link antwortet mit ${res.status}`);
      items = parseIcs(await res.text()).map((ev) => ({ uid: ev.uid, ev, href: null, etag: null }));
    } else {
      const url = await calendarUrl(ctx, acc);
      for (const it of await report(ctx, acc, url, from, to))
        for (const ev of parseIcs(it.data)) items.push({ uid: ev.uid, ev, href: it.href, etag: it.etag });
    }
    for (const { uid, ev, href, etag } of items) {
      if (seen.has(uid) || ev.status === 'CANCELLED') continue;
      seen.add(uid);
      count++;
      await ctx.sql`insert into calendar_events (owner_id, title, description, location, starts_at, ends_at, all_day, private, recurrence, recurrence_until,
          account_id, external_uid, external_href, external_etag)
        values (${acc.user_id}, ${ev.summary.slice(0, 500)}, ${ev.description ?? ''}, ${ev.location ?? ''}, ${ev.start}, ${ev.end < ev.start ? ev.start : ev.end}, ${ev.allDay},
          ${ev.private ?? false}, ${ev.recurrence ?? 'none'}, ${ev.until ?? null}, ${acc.id}, ${uid}, ${href}, ${etag})
        on conflict (account_id, external_uid) where account_id is not null do update set
          title = excluded.title, description = excluded.description, location = excluded.location, starts_at = excluded.starts_at,
          ends_at = excluded.ends_at, all_day = excluded.all_day, private = excluded.private, recurrence = excluded.recurrence,
          recurrence_until = excluded.recurrence_until, external_href = excluded.external_href, external_etag = excluded.external_etag, updated_at = now()
          where calendar_events.external_etag is distinct from excluded.external_etag or excluded.external_etag is null`;
    }
    // dort gelöschte Termine auch hier entfernen (nur im abgefragten Zeitraum bzw. beim Abo komplett)
    const uids = [...seen];
    if (acc.kind === 'ics') await ctx.sql`delete from calendar_events where account_id = ${acc.id} and not (external_uid = any(${uids}))`;
    else await ctx.sql`delete from calendar_events where account_id = ${acc.id} and external_href is not null and starts_at < ${to} and ends_at > ${from}
      and recurrence = 'none' and not (external_uid = any(${uids}))`;
    await ctx.sql`update calendar_accounts set last_sync_at = now(), last_error = null where id = ${acc.id}`;
    return { count };
  } catch (e) {
    await ctx.sql`update calendar_accounts set last_error = ${(e as Error).message}, last_sync_at = now() where id = ${acc.id}`;
    throw e;
  }
}

interface LocalEvent {
  id: string; title: string; description: string; location: string; starts_at: Date; ends_at: Date; all_day: boolean; private: boolean;
  recurrence: IcsEvent['recurrence']; recurrence_until: string | null; external_uid: string | null; external_href: string | null; external_etag: string | null;
}

/** Eigenen Termin ins verbundene Konto schreiben (neu oder geändert) */
export async function pushEvent(ctx: AppContext, acc: CalendarAccount, e: LocalEvent) {
  if (acc.kind !== 'caldav') return;
  const uid = e.external_uid ?? `${randomUUID()}@aperioplan`;
  const href = e.external_href ?? `${await calendarUrl(ctx, acc)}${encodeURIComponent(uid)}.ics`;
  const ics = buildIcs(acc.name, [{ uid, summary: e.title, description: e.description, location: e.location, start: e.starts_at, end: e.ends_at,
    allDay: e.all_day, private: e.private, recurrence: e.recurrence, until: e.recurrence_until }]);
  const res = await davFetch(ctx, acc, href, 'PUT', ics, { 'Content-Type': 'text/calendar; charset=utf-8', ...(e.external_etag ? { 'If-Match': e.external_etag } : { 'If-None-Match': '*' }) });
  if (res.status === 412) throw new Error('Der Termin wurde im Kalender des Kontos inzwischen geändert – bitte erst abgleichen');
  if (res.status >= 400) throw new Error(`Kalender-Server antwortet mit ${res.status}`);
  const etag = res.headers.get('etag');
  await ctx.sql`update calendar_events set account_id = ${acc.id}, external_uid = ${uid}, external_href = ${href}, external_etag = ${etag} where id = ${e.id}`;
}

export async function deleteRemoteEvent(ctx: AppContext, acc: CalendarAccount, href: string, etag: string | null) {
  if (acc.kind !== 'caldav') return;
  const res = await davFetch(ctx, acc, href, 'DELETE', undefined, etag ? { 'If-Match': etag } : {});
  if (res.status >= 400 && res.status !== 404) throw new Error(`Kalender-Server antwortet mit ${res.status}`);
}

/** Alle Konten abgleichen (geplant alle 15 Minuten) */
export async function syncAllCalendars(ctx: AppContext) {
  const accounts = await ctx.sql<CalendarAccount[]>`select * from calendar_accounts`;
  for (const a of accounts) { try { await syncAccount(ctx, a); } catch { /* Fehler steht am Konto */ } }
}
