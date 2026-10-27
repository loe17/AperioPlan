import { Client } from 'ldapts';
import type { LdapSettings } from '../services/settings';

export interface LdapUser {
  dn: string;
  displayName: string;
  email: string | null;
  groups: string[];
}

const escapeFilter = (s: string) => s.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));

/**
 * Firmen-Login über Active Directory / LDAP: Dienstkonto sucht den Benutzer,
 * danach wird mit dessen eigenem Passwort gebunden.
 */
export async function ldapAuthenticate(s: LdapSettings, username: string, password: string): Promise<LdapUser | null> {
  if (!s.enabled || !s.url || !password) return null;
  const client = new Client({ url: s.url, timeout: 8000, connectTimeout: 8000, tlsOptions: { rejectUnauthorized: s.tlsRejectUnauthorized } });
  try {
    if (s.bindDn) await client.bind(s.bindDn, s.bindPassword);
    const filter = s.userFilter.replace(/\{\{username\}\}/g, escapeFilter(username));
    const { searchEntries } = await client.search(s.baseDn, {
      scope: 'sub', filter, attributes: ['dn', s.displayNameAttr, s.emailAttr, 'memberOf'], sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0]!;
    const userClient = new Client({ url: s.url, timeout: 8000, tlsOptions: { rejectUnauthorized: s.tlsRejectUnauthorized } });
    try {
      await userClient.bind(entry.dn, password);
    } catch {
      return null;
    } finally {
      await userClient.unbind().catch(() => {});
    }
    const groups = ([] as string[]).concat((entry.memberOf as string | string[] | undefined) ?? []);
    return {
      dn: entry.dn,
      displayName: String(entry[s.displayNameAttr] ?? username),
      email: entry[s.emailAttr] ? String(entry[s.emailAttr]) : null,
      groups,
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}

export async function ldapTest(s: LdapSettings): Promise<string> {
  const client = new Client({ url: s.url, timeout: 8000, tlsOptions: { rejectUnauthorized: s.tlsRejectUnauthorized } });
  try {
    await client.bind(s.bindDn, s.bindPassword);
    const { searchEntries } = await client.search(s.baseDn, { scope: 'sub', filter: s.userFilter.replace(/\{\{username\}\}/g, '*'), sizeLimit: 5, attributes: ['dn'] });
    return `Verbindung erfolgreich, ${searchEntries.length} Beispielkonten gefunden`;
  } finally {
    await client.unbind().catch(() => {});
  }
}
