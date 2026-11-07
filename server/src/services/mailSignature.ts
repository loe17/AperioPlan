/**
 * E-Mail-Signaturen: eigenes HTML ohne Programmteile, Platzhalter aus dem Benutzerprofil
 * ({Name}, {Position}, {Abteilung}, {Telefon}, {Mobil}, {E-Mail}, {Firma}) und die optionale Firmen-Signatur.
 */
import type { AppContext } from '../context';

/** Gefährliche Teile aus eingefügtem HTML entfernen; Aussehen (Tabellen, Farben, Bilder) bleibt */
export function cleanHtml(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|iframe|object|embed|form|textarea|select|button|noscript|template|svg|math|link|meta|base|frame|frameset|applet)\b[\s\S]*?(<\/\1\s*>|$)/gi, (m, tag: string) => (tag.toLowerCase() === 'style' ? m.replace(/expression\s*\(|@import|javascript:/gi, '') : ''));
  s = s.replace(/<\/?(script|iframe|object|embed|form|input|textarea|select|button|link|meta|base|frame|frameset|applet)\b[^>]*>/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(href|src|action|background|xlink:href)\s*=\s*("|')?\s*(javascript|vbscript|data:text\/html)[^"'>\s]*("|')?/gi, ' $1="#"');
  s = s.replace(/expression\s*\(/gi, '(');
  return s;
}

export interface SigFields { name: string; firstName: string; lastName: string; position: string; department: string; phone: string; mobile: string; email: string; company: string }

export async function signatureFields(ctx: AppContext, userId: string): Promise<SigFields> {
  const [u] = await ctx.sql<{ display_name: string; job_title: string; phone: string; mobile: string; email: string | null; dept: string | null }[]>`
    select display_name, job_title, phone, mobile, email, (select name from teams where id = users.department_id) as dept from users where id = ${userId}`;
  const company = await ctx.settings.get('company') as unknown as { name?: string; logoText?: string };
  const parts = (u?.display_name ?? '').trim().split(/\s+/);
  return {
    name: u?.display_name ?? '', firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] ?? '', lastName: parts.length > 1 ? parts[parts.length - 1]! : '',
    position: u?.job_title ?? '', department: u?.dept ?? '', phone: u?.phone ?? '', mobile: u?.mobile ?? '', email: u?.email ?? '', company: company?.name ?? company?.logoText ?? '',
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Platzhalter füllen. Zeilen, deren Platzhalter alle leer bleiben (z. B. kein Mobiltelefon), entfallen. */
export function renderSignature(html: string, f: SigFields, accountEmail?: string) {
  const map: Record<string, string> = {
    name: f.name, vorname: f.firstName, nachname: f.lastName, position: f.position, berufsbezeichnung: f.position, abteilung: f.department,
    telefon: f.phone, mobil: f.mobile, 'e-mail': accountEmail ?? f.email, email: accountEmail ?? f.email, firma: f.company,
  };
  // Zeilen (<p>, <div>, <tr>, <li> oder Zeilen mit <br>) entfernen, die nur leere Platzhalter enthalten
  const empty = (chunk: string) => {
    const keys = [...chunk.matchAll(/\{([\w-äöüÄÖÜ]+)\}/g)].map((m) => m[1]!.toLowerCase()).filter((k) => k in map);
    return keys.length > 0 && keys.every((k) => !map[k]);
  };
  let s = html.replace(/<(p|div|tr|li)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => (empty(m) ? '' : m));
  s = s.split(/<br\s*\/?>/i).filter((line) => !(empty(line) && !/<\/?(p|div|tr|td|li|table)\b/i.test(line))).join('<br>');
  return s.replace(/\{([\w-äöüÄÖÜ]+)\}/g, (m, k: string) => { const v = map[k.toLowerCase()]; return v === undefined ? m : esc(v); });
}

export const SIG_PLACEHOLDERS = ['Name', 'Vorname', 'Nachname', 'Position', 'Abteilung', 'Telefon', 'Mobil', 'E-Mail', 'Firma'];
