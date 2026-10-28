/**
 * iCalendar (RFC 5545) lesen und schreiben – so viel, wie Kalender-Abos und CalDAV im Alltag brauchen:
 * Termine (VEVENT) mit Beginn/Ende, ganztägig, Ort, Beschreibung und einfacher Wiederholung.
 */

export type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurrence?: Recurrence;
  until?: string | null; // YYYY-MM-DD
  status?: string;
  private?: boolean;
}

const unescape = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Zeilen entfalten (Folgezeilen beginnen mit Leerzeichen oder Tab) */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean);
}

/** Lange Zeilen auf 75 Bytes falten */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** Ortszeit in einer Zeitzone → UTC-Zeitpunkt */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const offset = (t: number) => {
      const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
    };
    let t = guess - offset(guess);
    t = guess - offset(t);
    return new Date(t);
  } catch {
    return new Date(guess);
  }
}

function parseDate(value: string, params: Record<string, string>, defaultTz: string): { date: Date; allDay: boolean } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return { date: new Date(value), allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h || params.VALUE === 'DATE') return { date: new Date(Date.UTC(+y!, +mo! - 1, +d!)), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi!, +s!)), allDay: false };
  return { date: zonedToUtc(+y!, +mo!, +d!, +h, +mi!, +s!, params.TZID ?? defaultTz), allDay: false };
}

function parseLine(line: string): { name: string; params: Record<string, string>; value: string } {
  // Doppelpunkte in Parameterwerten mit Anführungszeichen überspringen
  let i = 0, quoted = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const [name, ...ps] = head.split(';');
  const params: Record<string, string> = {};
  for (const p of ps) { const [k, v] = p.split('='); if (k) params[k.toUpperCase()] = (v ?? '').replace(/^"|"$/g, ''); }
  return { name: name!.toUpperCase(), params, value };
}

function mapRrule(rule: string): { recurrence: Recurrence; until: string | null } | null {
  const p = Object.fromEntries(rule.split(';').map((x) => x.split('=') as [string, string]));
  if ((p.INTERVAL && p.INTERVAL !== '1') || p.COUNT) return null;
  const until = p.UNTIL ? `${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}` : null;
  if (p.FREQ === 'DAILY') return { recurrence: 'daily', until };
  if (p.FREQ === 'WEEKLY' && p.BYDAY === 'MO,TU,WE,TH,FR') return { recurrence: 'weekdays', until };
  if (p.FREQ === 'WEEKLY' && (!p.BYDAY || p.BYDAY.split(',').length === 1)) return { recurrence: 'weekly', until };
  if (p.FREQ === 'MONTHLY' && !p.BYDAY) return { recurrence: 'monthly', until };
  if (p.FREQ === 'YEARLY') return { recurrence: 'yearly', until };
  return null;
}

/** Liest alle Termine aus einer .ics-Datei */
export function parseIcs(text: string, defaultTz = 'Europe/Berlin'): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Partial<IcsEvent> & { _dur?: string } | null = null;
  let depth = 0; // verschachtelte Blöcke (VALARM) überspringen
  for (const line of unfold(text)) {
    const { name, params, value } = parseLine(line);
    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') { cur = { recurrence: 'none' }; depth = 0; continue; }
    if (!cur) continue;
    if (name === 'BEGIN') { depth++; continue; }
    if (name === 'END' && depth > 0) { depth--; continue; }
    if (depth > 0) continue;
    if (name === 'END' && value.toUpperCase() === 'VEVENT') {
      if (cur.uid && cur.start) {
        if (!cur.end) {
          const dur = cur._dur ? parseDuration(cur._dur) : cur.allDay ? 86400000 : 0;
          cur.end = new Date(cur.start.getTime() + dur);
        }
        delete cur._dur;
        events.push(cur as IcsEvent);
      }
      cur = null;
      continue;
    }
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = unescape(value); break;
      case 'DESCRIPTION': cur.description = unescape(value); break;
      case 'LOCATION': cur.location = unescape(value); break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'CLASS': cur.private = value.toUpperCase() !== 'PUBLIC'; break;
      case 'DTSTART': { const d = parseDate(value, params, defaultTz); cur.start = d.date; cur.allDay = d.allDay; break; }
      case 'DTEND': cur.end = parseDate(value, params, defaultTz).date; break;
      case 'DURATION': cur._dur = value; break;
      case 'RRULE': { const r = mapRrule(value); if (r) { cur.recurrence = r.recurrence; cur.until = r.until; } break; }
    }
  }
  return events.map((e) => ({ ...e, summary: e.summary ?? '(ohne Titel)' }));
}

function parseDuration(v: string): number {
  const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return 0;
  const [, w, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return ((((w! * 7 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateStamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

const RRULE: Record<Recurrence, string> = {
  none: '', daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY',
};

export function eventToVevent(e: IcsEvent): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utcStamp(new Date())}`];
  if (e.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start)}`, `DTEND;VALUE=DATE:${dateStamp(e.end.getTime() > e.start.getTime() ? e.end : new Date(e.start.getTime() + 86400000))}`);
  } else lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end)}`);
  lines.push(`SUMMARY:${escape(e.summary)}`);
  if (e.location) lines.push(`LOCATION:${escape(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${escape(e.description)}`);
  if (e.private) lines.push('CLASS:PRIVATE');
  if (e.status) lines.push(`STATUS:${e.status}`);
  if (e.recurrence && e.recurrence !== 'none') lines.push(`RRULE:${RRULE[e.recurrence]}${e.until ? `;UNTIL=${e.until.replace(/-/g, '')}T235959Z` : ''}`);
  lines.push('END:VEVENT');
  return lines;
}

/** Erzeugt eine vollständige .ics-Datei */
export function buildIcs(name: string, events: IcsEvent[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AperioPlan//Kalender//DE', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escape(name)}`];
  for (const e of events) lines.push(...eventToVevent(e));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}

/**
 * Wiederholungen eines Termins im Zeitraum [from, to) aufzählen.
 * Gerechnet wird in Ortszeit, damit „jeden Montag 9:00“ auch nach der Zeitumstellung 9:00 bleibt.
 */
export function expandOccurrences(e: { start: Date; end: Date; recurrence: Recurrence; until?: string | null; allDay?: boolean }, from: Date, to: Date, tz = 'Europe/Berlin', max = 500): { start: Date; end: Date }[] {
  const dur = e.end.getTime() - e.start.getTime();
  if (e.recurrence === 'none') return e.start < to && e.end > from ? [{ start: e.start, end: e.end }] : [];
  const zone = e.allDay ? 'UTC' : tz;
  const until = e.until ? new Date(`${e.until}T23:59:59Z`) : null;
  const b = localParts(e.start, zone);
  const out: { start: Date; end: Date }[] = [];
  for (let i = 0; out.length < max && i < 20000; i++) {
    let y = b.y, mo = b.mo, d = b.d;
    if (e.recurrence === 'daily' || e.recurrence === 'weekdays') d += i;
    else if (e.recurrence === 'weekly') d += 7 * i;
    else if (e.recurrence === 'monthly') mo += i;
    else if (e.recurrence === 'yearly') y += i;
    const cal = new Date(Date.UTC(y, mo - 1, d));
    // 31. eines Monats ohne 31. bzw. 29.2. außerhalb von Schaltjahren: auslassen
    if ((e.recurrence === 'monthly' || e.recurrence === 'yearly') && cal.getUTCDate() !== b.d) continue;
    const s = zonedToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), b.h, b.mi, b.s, zone);
    if (s >= to || (until && s > until)) break;
    if (e.recurrence === 'weekdays') { const wd = cal.getUTCDay(); if (wd === 0 || wd === 6) continue; }
    const en = new Date(s.getTime() + dur);
    if (en > from) out.push({ start: s, end: en });
  }
  return out;
}
