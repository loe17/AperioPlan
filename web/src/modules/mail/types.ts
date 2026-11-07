/** Gemeinsame Typen und kleine Helfer des E-Mail-Bereichs */
export interface MailAccount {
  id: string; email: string; displayName: string; label: string; provider: string; authKind: 'password' | 'microsoft' | 'google';
  imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string;
  folderMap: Partial<Record<'sent' | 'drafts' | 'trash' | 'junk' | 'archive', string>>; sigNew: string; sigReply: string; primary: boolean; sort: number;
  lastSyncAt: string | null; lastError: string | null; unseen?: number;
}
export interface ServerSettings { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string }
export interface ProviderInfo {
  id: string; name: string; domains: string[]; needsHost: boolean; oauth: 'microsoft' | 'google' | null; hint: string; helpUrl: string | null;
  imap: { host: string; port: number; secure: boolean } | null; smtp: { host: string; port: number; secure: boolean } | null;
}
export interface Signature { id: string; name: string; html: string; sort: number; rendered: string }
export interface SignatureData {
  items: Signature[];
  company: { mode: 'default' | 'mandatory'; html: string; rendered: string } | null;
  fields: Record<string, string>; placeholders: string[];
}

/** So sehen Empfänger den Absender */
export const senderLine = (name: string, email: string) => (name.trim() ? `${name.trim()} <${email || 'adresse@firma.de'}>` : email || 'adresse@firma.de');

/**
 * Welche Signatur gilt? Wahl am Postfach: '' = automatisch (Firmen-Signatur, sonst die erste eigene), 'none' = keine,
 * 'company' = Firmen-Signatur, sonst die Kennung einer eigenen. Ist die Firmen-Signatur Pflicht, gilt immer sie.
 */
export function resolveSignature(choice: string, data: SignatureData | undefined): { id: string; html: string } | null {
  if (!data) return null;
  if (data.company?.mode === 'mandatory') return { id: 'company', html: data.company.rendered };
  if (choice === 'none') return null;
  if (choice === 'company') return data.company ? { id: 'company', html: data.company.rendered } : null;
  const own = data.items.find((s) => s.id === choice);
  if (own) return { id: own.id, html: own.rendered };
  if (choice === '') {
    if (data.company) return { id: 'company', html: data.company.rendered };
    const first = data.items[0];
    return first ? { id: first.id, html: first.rendered } : null;
  }
  return null;
}

export const PLACEHOLDER_HELP: Record<string, string> = {
  Name: 'Vor- und Nachname', Vorname: 'Vorname', Nachname: 'Nachname', Position: 'Berufsbezeichnung aus dem Benutzerkonto', Abteilung: 'Abteilung',
  Telefon: 'Telefon aus dem Profil', Mobil: 'Mobilnummer aus dem Profil', 'E-Mail': 'Adresse des jeweiligen Postfachs', Firma: 'Firmenname aus den Einstellungen',
};
