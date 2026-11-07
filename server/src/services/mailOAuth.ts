/**
 * „Mit Microsoft anmelden“ / „Mit Google anmelden“ für E-Mail-Konten. Microsoft lässt die Anmeldung nur mit
 * Passwort für Firmenkonten auslaufen; Google verlangt sonst ein App-Passwort. Der Administrator registriert
 * AperioPlan einmalig beim Anbieter (Einstellungen → E-Mail-Anmeldung), danach melden sich alle per Knopf an.
 * Gespeichert wird nur die verschlüsselte Dauer-Anmeldung (Refresh-Token); Zugangsschlüssel liegen kurz im Speicher.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { openSecret, sealSecret } from './secrets';

export type OAuthProvider = 'microsoft' | 'google';

export const OAUTH_SERVERS: Record<OAuthProvider, { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean }> = {
  microsoft: { imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
  google: { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
};

async function endpoints(ctx: AppContext, p: OAuthProvider) {
  const s = await ctx.settings.get('mailOAuth');
  if (p === 'microsoft') {
    const tenant = s.microsoftTenant || 'common';
    return {
      clientId: s.microsoftClientId, clientSecret: s.microsoftClientSecret,
      auth: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scope: 'offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
      extra: { prompt: 'select_account' } as Record<string, string>,
    };
  }
  return {
    clientId: s.googleClientId, clientSecret: s.googleClientSecret,
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email',
    extra: { access_type: 'offline', prompt: 'consent' } as Record<string, string>,
  };
}

export async function oauthConfigured(ctx: AppContext) {
  const s = await ctx.settings.get('mailOAuth');
  return { microsoft: Boolean(s.microsoftClientId && s.microsoftClientSecret), google: Boolean(s.googleClientId && s.googleClientSecret) };
}

interface Pending { userId: string; provider: OAuthProvider; email: string; verifier: string; redirectUri: string; expires: number }
interface Ticket { userId: string; provider: OAuthProvider; email: string; refreshToken: string; accessToken: string; expiresAt: number; expires: number }
const pending = new Map<string, Pending>();
const tickets = new Map<string, Ticket>();
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const sweep = () => { const now = Date.now(); for (const m of [pending, tickets] as Map<string, { expires: number }>[]) for (const [k, v] of m) if (v.expires < now) m.delete(k); };
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Adresse der Anmeldeseite beim Anbieter */
export async function oauthStart(ctx: AppContext, userId: string, provider: OAuthProvider, email: string, redirectUri: string) {
  sweep();
  const e = await endpoints(ctx, provider);
  if (!e.clientId) throw badRequest(provider === 'microsoft' ? 'Die Anmeldung mit Microsoft ist noch nicht eingerichtet. Bitte den Administrator fragen (Einstellungen → E-Mail-Anmeldung).' : 'Die Anmeldung mit Google ist noch nicht eingerichtet. Bitte den Administrator fragen (Einstellungen → E-Mail-Anmeldung).');
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { userId, provider, email, verifier, redirectUri, expires: Date.now() + 15 * 60_000 });
  const q = new URLSearchParams({
    client_id: e.clientId, response_type: 'code', redirect_uri: redirectUri, scope: e.scope, state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', login_hint: email, ...e.extra,
  });
  return `${e.auth}?${q}`;
}

async function tokenRequest(ctx: AppContext, provider: OAuthProvider, body: Record<string, string>) {
  const e = await endpoints(ctx, provider);
  const res = await fetch(e.token, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, ...body }), signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error_description?: string; error?: string };
  if (!res.ok || !j.access_token) throw badRequest(`Anmeldung beim Anbieter fehlgeschlagen: ${j.error_description ?? j.error ?? res.statusText}`);
  return j;
}

/** Rückkehr von der Anmeldeseite: Code gegen Anmeldung tauschen; ergibt ein kurzlebiges Ticket für den Assistenten */
export async function oauthCallback(ctx: AppContext, state: string, code: string) {
  sweep();
  const p = pending.get(state);
  if (!p) throw badRequest('Die Anmeldung ist abgelaufen. Bitte im Assistenten noch einmal auf „Anmelden“ klicken.');
  pending.delete(state);
  const j = await tokenRequest(ctx, p.provider, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  if (!j.refresh_token) throw badRequest('Der Anbieter hat keine dauerhafte Anmeldung erteilt. Bitte erneut anmelden und alle Berechtigungen bestätigen.');
  let email = p.email;
  try { const payload = JSON.parse(Buffer.from((j.id_token ?? '').split('.')[1] ?? '', 'base64').toString()) as { email?: string; preferred_username?: string }; email = payload.email ?? payload.preferred_username ?? email; } catch { /* E-Mail aus dem Assistenten */ }
  const ticket = b64url(randomBytes(24));
  tickets.set(ticket, { userId: p.userId, provider: p.provider, email, refreshToken: j.refresh_token, accessToken: j.access_token!, expiresAt: Date.now() + (j.expires_in ?? 3000) * 1000, expires: Date.now() + 30 * 60_000 });
  return { ticket, email, provider: p.provider };
}

export function oauthTicket(userId: string, ticket: string) {
  const t = tickets.get(ticket);
  if (!t || t.userId !== userId) throw badRequest('Die Anmeldung beim Anbieter ist abgelaufen. Bitte erneut anmelden.');
  return t;
}

export async function sealOAuth(ctx: AppContext, t: { provider: OAuthProvider; refreshToken: string }) {
  return sealSecret(ctx, JSON.stringify({ provider: t.provider, refreshToken: t.refreshToken }));
}

/** Gültigen Zugangsschlüssel für ein Postfach holen (bei Bedarf erneuern) */
export async function accessTokenFor(ctx: AppContext, a: { id: string; auth_kind: string; oauth_sealed: string | null }) {
  const cached = tokenCache.get(a.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const raw = a.oauth_sealed ? await openSecret(ctx, a.oauth_sealed) : null;
  if (!raw) throw badRequest('Die Anmeldung beim Anbieter fehlt. Bitte im Postfach unter „Konto“ erneut anmelden.');
  const s = JSON.parse(raw) as { provider: OAuthProvider; refreshToken: string };
  const j = await tokenRequest(ctx, s.provider, { grant_type: 'refresh_token', refresh_token: s.refreshToken });
  tokenCache.set(a.id, { token: j.access_token!, expiresAt: Date.now() + (j.expires_in ?? 3000) * 1000 });
  return j.access_token!;
}

export function forgetToken(accountId: string) { tokenCache.delete(accountId); }
/** Für den Test im Assistenten: Ticket als Zugangsschlüssel verwenden */
export function primeToken(accountId: string, token: string, expiresAt: number) { tokenCache.set(accountId, { token, expiresAt }); }
