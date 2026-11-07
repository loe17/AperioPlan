/**
 * E-Mail-Konten (mehrere je Person), Einrichtungsassistent mit Test, Anmeldung mit Microsoft/Google,
 * Signaturen, Adressbuch mit Gruppen, Verlauf und Postausgang.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from 'postgres';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { hasTool, requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { openSecret, sealSecret } from '../services/secrets';
import { connectImap, dropConnection, explainMailError, logEvent, smtpFor, syncAccount, type MailAccount } from '../services/mailbox';
import { discover, fingerprint, getRun, oauthServers, PROVIDERS, providerFor, providerInfo, startTest, type ServerSettings } from '../services/mailSetup';
import { accessTokenFor, forgetToken, oauthCallback, oauthConfigured, oauthStart, oauthTicket, primeToken, sealOAuth, type OAuthProvider } from '../services/mailOAuth';
import { cleanHtml, renderSignature, signatureFields, SIG_PLACEHOLDERS } from '../services/mailSignature';
import { draftFromOutbox, processOutbox } from '../services/mailOutbox';

/** Eigenes Postfach holen: ohne Angabe das Hauptpostfach (sonst das erste) */
export async function ownAccount(sql: Sql, u: AuthUser, accountId?: string | null): Promise<MailAccount> {
  const [a] = accountId
    ? await sql<MailAccount[]>`select * from mail_accounts where id = ${accountId} and owner_id = ${u.id}`
    : await sql<MailAccount[]>`select * from mail_accounts where owner_id = ${u.id} order by (user_id is null), sort, created_at limit 1`;
  if (!a) throw badRequest(accountId ? 'Postfach nicht gefunden' : 'Noch kein E-Mail-Konto eingerichtet');
  return a;
}

export const accountJson = (a: MailAccount & { created_at?: Date }) => ({
  id: a.id, email: a.email, displayName: a.display_name, label: a.label, provider: a.provider, authKind: a.auth_kind,
  imapHost: a.imap_host, imapPort: a.imap_port, imapSecure: a.imap_secure, smtpHost: a.smtp_host, smtpPort: a.smtp_port, smtpSecure: a.smtp_secure,
  username: a.username, folderMap: a.folder_map ?? {}, sigNew: a.sig_new, sigReply: a.sig_reply, primary: a.user_id !== null, sort: a.sort,
  lastSyncAt: a.last_sync_at ?? null, lastError: a.last_error ?? null, signatureHtml: a.signature_html,
});

const serverFields = {
  imapHost: z.string().trim().min(1, 'Server für eingehende Post fehlt').max(255), imapPort: z.number().int().min(1).max(65535), imapSecure: z.boolean(),
  smtpHost: z.string().trim().min(1, 'Server für ausgehende Post fehlt').max(255), smtpPort: z.number().int().min(1).max(65535), smtpSecure: z.boolean(),
  username: z.string().trim().min(1, 'Benutzername fehlt').max(255),
};
const folderMapSchema = z.partialRecord(z.enum(['sent', 'drafts', 'trash', 'junk', 'archive']), z.string().max(500));
const sigChoice = z.string().max(64);

/** Rücksprungadresse für die Anmeldung beim Anbieter (wie der Browser den Server erreicht) */
function callbackUrl(req: FastifyRequest) {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0]!.trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0]!.trim();
  return `${proto}://${host}/api/mailbox/oauth/callback`;
}

export default async function mailAccountRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  /** Zugangsdaten aus der Anfrage: Passwort, Anmeldung beim Anbieter oder gespeicherte des Postfachs */
  async function authFrom(u: AuthUser, b: { authKind: 'password' | 'microsoft' | 'google'; password?: string; oauthTicket?: string; username: string }, existing?: MailAccount | null) {
    if (b.authKind !== 'password') {
      if (b.oauthTicket) { const t = oauthTicket(u.id, b.oauthTicket); return { auth: { user: t.email, accessToken: t.accessToken }, ticket: t }; }
      if (existing && existing.auth_kind === b.authKind) return { auth: { user: existing.username, accessToken: await accessTokenFor(ctx, existing) }, ticket: null };
      throw badRequest('Bitte zuerst beim Anbieter anmelden.');
    }
    if (b.password) return { auth: { user: b.username, pass: b.password }, ticket: null };
    if (existing?.auth_kind === 'password') return { auth: { user: b.username, pass: (await openSecret(ctx, existing.password_sealed)) ?? '' }, ticket: null };
    throw badRequest('Bitte das Passwort angeben');
  }

  /** Kurze Prüfung beim Speichern (Anmeldung an beiden Servern), außer der Assistent hat gerade erfolgreich getestet */
  async function quickCheck(u: AuthUser, email: string, s: ServerSettings, auth: { user: string; pass?: string; accessToken?: string }, testId?: string) {
    const run = testId ? getRun(testId, u.id) : null;
    if (run?.done && run.ok && run.fingerprint === fingerprint(s, email)) return;
    const draft = { id: 'pruefung', imap_host: s.imapHost, imap_port: s.imapPort, imap_secure: s.imapSecure, smtp_host: s.smtpHost, smtp_port: s.smtpPort, smtp_secure: s.smtpSecure,
      username: s.username, email, display_name: '', auth_kind: 'password' } as MailAccount;
    try { const c = await connectImap(ctx, draft, auth); await c.logout().catch(() => {}); } catch (e) { const p = explainMailError(e, 'imap', draft); throw badRequest(`Eingehende Post (IMAP): ${p.text} ${p.tip}`); }
    try { await (await smtpFor(ctx, draft, auth)).verify(); } catch (e) { const p = explainMailError(e, 'smtp', draft); throw badRequest(`Ausgehende Post (SMTP): ${p.text} ${p.tip}`); }
  }

  // ------------------------------------------------ Konten
  app.get('/mailbox/accounts', async (req) => {
    const u = requireUser(req);
    const rows = await sql<(MailAccount & { unseen: number })[]>`select a.*, (select coalesce(sum(f.unseen), 0)::int from mail_folders f where f.account_id = a.id and f.special_use = '\\Inbox') as unseen
      from mail_accounts a where a.owner_id = ${u.id} order by (a.user_id is null), a.sort, a.created_at`;
    return rows.map((a) => ({ ...accountJson(a), unseen: a.unseen }));
  });

  /** Für ältere Oberflächen: das Hauptpostfach */
  app.get('/mailbox/account', async (req) => {
    const u = requireUser(req);
    const [a] = await sql<MailAccount[]>`select * from mail_accounts where owner_id = ${u.id} order by (user_id is null), sort, created_at limit 1`;
    return a ? accountJson(a) : null;
  });

  const accountCreate = z.object({
    email: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben'),
    displayName: z.string().trim().min(1, 'Bitte den Anzeigenamen angeben – so sehen Empfänger Sie').max(120),
    label: z.string().trim().max(60).default(''), provider: z.string().max(40).default(''),
    authKind: z.enum(['password', 'microsoft', 'google']).default('password'), password: z.string().max(500).optional(), oauthTicket: z.string().max(200).optional(),
    folderMap: folderMapSchema.default({}), testId: z.string().max(64).optional(), sigNew: sigChoice.default(''), sigReply: sigChoice.default(''),
    ...serverFields,
  });

  app.post('/mailbox/accounts', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(accountCreate, req.body);
    const [dup] = await sql`select 1 from mail_accounts where owner_id = ${u.id} and lower(email) = lower(${b.email})`;
    if (dup) throw badRequest('Dieses Postfach ist bei Ihnen schon eingerichtet.');
    const { auth, ticket } = await authFrom(u, b);
    await quickCheck(u, b.email, b, auth, b.testId);
    const sealed = b.password ? await sealSecret(ctx, b.password) : await sealSecret(ctx, '');
    const oauth = ticket ? await sealOAuth(ctx, ticket) : null;
    const [hasPrimary] = await sql`select 1 from mail_accounts where user_id = ${u.id}`;
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from mail_accounts where owner_id = ${u.id}`)[0]!.n;
    const [row] = await sql<MailAccount[]>`insert into mail_accounts (user_id, owner_id, email, display_name, label, provider, auth_kind, oauth_sealed, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, username, password_sealed, folder_map, sig_new, sig_reply, sort)
      values (${hasPrimary ? null : u.id}, ${u.id}, ${b.email}, ${b.displayName}, ${b.label}, ${b.provider}, ${b.authKind}, ${oauth}, ${b.imapHost}, ${b.imapPort}, ${b.imapSecure},
        ${b.smtpHost}, ${b.smtpPort}, ${b.smtpSecure}, ${ticket ? ticket.email : b.username}, ${sealed}, ${sql.json(b.folderMap)}, ${b.sigNew}, ${b.sigReply}, ${n}) returning *`;
    if (ticket) primeToken(row!.id, ticket.accessToken, ticket.expiresAt);
    await syncLegacySignature(row!.id);
    await logEvent(ctx, row!.id, 'info', `Postfach eingerichtet (${b.imapHost} / ${b.smtpHost})`);
    void syncAccount(ctx, row!).catch(() => {});
    return accountJson(row!);
  });

  const accountPatch = z.object({
    displayName: z.string().trim().min(1, 'Bitte den Anzeigenamen angeben – so sehen Empfänger Sie').max(120).optional(),
    label: z.string().trim().max(60).optional(), provider: z.string().max(40).optional(),
    authKind: z.enum(['password', 'microsoft', 'google']).optional(), password: z.string().max(500).optional(), oauthTicket: z.string().max(200).optional(),
    folderMap: folderMapSchema.optional(), testId: z.string().max(64).optional(), sigNew: sigChoice.optional(), sigReply: sigChoice.optional(), sort: z.number().int().optional(),
    imapHost: serverFields.imapHost.optional(), imapPort: serverFields.imapPort.optional(), imapSecure: z.boolean().optional(),
    smtpHost: serverFields.smtpHost.optional(), smtpPort: serverFields.smtpPort.optional(), smtpSecure: z.boolean().optional(), username: serverFields.username.optional(),
    primary: z.literal(true).optional(),
  });

  app.patch('/mailbox/accounts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const cur = await ownAccount(sql, u, id);
    const b = parse(accountPatch, req.body);
    const s: ServerSettings = {
      imapHost: b.imapHost ?? cur.imap_host, imapPort: b.imapPort ?? cur.imap_port, imapSecure: b.imapSecure ?? cur.imap_secure,
      smtpHost: b.smtpHost ?? cur.smtp_host, smtpPort: b.smtpPort ?? cur.smtp_port, smtpSecure: b.smtpSecure ?? cur.smtp_secure, username: b.username ?? cur.username,
    };
    const authKind = b.authKind ?? cur.auth_kind;
    const changedServer = fingerprint(s, cur.email) !== fingerprint({ imapHost: cur.imap_host, imapPort: cur.imap_port, imapSecure: cur.imap_secure, smtpHost: cur.smtp_host, smtpPort: cur.smtp_port, smtpSecure: cur.smtp_secure, username: cur.username }, cur.email)
      || Boolean(b.password) || Boolean(b.oauthTicket) || authKind !== cur.auth_kind;
    let sealed = cur.password_sealed, oauth = cur.oauth_sealed, username = s.username;
    if (changedServer) {
      const { auth, ticket } = await authFrom(u, { authKind, password: b.password, oauthTicket: b.oauthTicket, username: s.username }, cur);
      await quickCheck(u, cur.email, s, auth, b.testId);
      if (b.password) sealed = await sealSecret(ctx, b.password);
      if (ticket) { oauth = await sealOAuth(ctx, ticket); username = ticket.email; forgetToken(cur.id); primeToken(cur.id, ticket.accessToken, ticket.expiresAt); }
      dropConnection(cur.id);
    }
    if (b.primary) {
      await sql.begin(async (tx) => {
        await tx`update mail_accounts set user_id = null where owner_id = ${u.id} and id <> ${id}`;
        await tx`update mail_accounts set user_id = ${u.id} where id = ${id}`;
      });
    }
    const folderMapChanged = b.folderMap && JSON.stringify(b.folderMap) !== JSON.stringify(cur.folder_map ?? {});
    const [row] = await sql<MailAccount[]>`update mail_accounts set
      display_name = ${b.displayName ?? cur.display_name}, label = ${b.label ?? cur.label}, provider = ${b.provider ?? cur.provider}, auth_kind = ${authKind}, oauth_sealed = ${oauth},
      imap_host = ${s.imapHost}, imap_port = ${s.imapPort}, imap_secure = ${s.imapSecure}, smtp_host = ${s.smtpHost}, smtp_port = ${s.smtpPort}, smtp_secure = ${s.smtpSecure},
      username = ${username}, password_sealed = ${sealed}, folder_map = ${sql.json(b.folderMap ?? cur.folder_map ?? {})},
      sig_new = ${b.sigNew ?? cur.sig_new}, sig_reply = ${b.sigReply ?? cur.sig_reply}, sort = ${b.sort ?? cur.sort}
      where id = ${id} returning *`;
    if (cur.imap_host !== s.imapHost) await sql`delete from mail_folders where account_id = ${id}`;
    if (b.sigNew !== undefined) await syncLegacySignature(id);
    if (b.displayName && b.displayName !== cur.display_name) await logEvent(ctx, id, 'info', `Anzeigename geändert: Empfänger sehen jetzt „${b.displayName} <${cur.email}>“`);
    if (changedServer) await logEvent(ctx, id, 'info', 'Zugangsdaten geändert und geprüft');
    if (changedServer || folderMapChanged) void syncAccount(ctx, row!).catch(() => {});
    return accountJson(row!);
  });

  async function removeAccount(u: AuthUser, a: MailAccount) {
    dropConnection(a.id);
    await sql`update mail_messages set account_id = null, folder_id = null where account_id = ${a.id} and project_id is not null`;
    await sql`delete from mail_accounts where id = ${a.id}`;
    await storage.remove(`.aperio/mail/${a.id}`).catch(() => {});
    // ein anderes Postfach wird zum Hauptpostfach
    if (a.user_id) await sql`update mail_accounts set user_id = ${u.id} where id = (select id from mail_accounts where owner_id = ${u.id} order by sort, created_at limit 1)`;
    return { ok: true };
  }
  app.delete('/mailbox/accounts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return removeAccount(u, await ownAccount(sql, u, id));
  });
  /** Für ältere Oberflächen: Hauptpostfach entfernen */
  app.delete('/mailbox/account', async (req) => {
    const u = requireUser(req);
    return removeAccount(u, await ownAccount(sql, u));
  });

  app.get('/mailbox/accounts/:id/events', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await ownAccount(sql, u, id);
    return sql`select at, level, text from mail_events where account_id = ${id} order by id desc limit 60`;
  });

  /** Signatur-Feld der älteren Version mit der Standard-Signatur für neue E-Mails füllen */
  async function syncLegacySignature(accountId: string) {
    const [a] = await sql<{ owner_id: string; sig_new: string }[]>`select owner_id, sig_new from mail_accounts where id = ${accountId}`;
    if (!a) return;
    const comp = await ctx.settings.get('mailSignature');
    let html = '';
    if ((comp.enabled && (comp.mode === 'mandatory' || a.sig_new === '' || a.sig_new === 'company'))) html = comp.html;
    else if (a.sig_new && a.sig_new !== 'none') html = (await sql<{ html: string }[]>`select html from mail_signatures where id::text = ${a.sig_new} and owner_id = ${a.owner_id}`)[0]?.html ?? '';
    else if (a.sig_new === '') html = (await sql<{ html: string }[]>`select html from mail_signatures where owner_id = ${a.owner_id} order by sort, created_at limit 1`)[0]?.html ?? '';
    if (html) html = renderSignature(html, await signatureFields(ctx, a.owner_id));
    await sql`update mail_accounts set signature_html = ${html} where id = ${accountId}`;
  }

  // ------------------------------------------------ Einrichtungsassistent
  app.get('/mailbox/setup/providers', async (req) => {
    requireUser(req);
    return { providers: PROVIDERS.map(providerInfo), oauth: await oauthConfigured(ctx) };
  });

  app.post('/mailbox/setup/discover', async (req) => {
    requireUser(req);
    const { email } = parse(z.object({ email: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben') }), req.body);
    return { ...(await discover(email)), oauth: await oauthConfigured(ctx) };
  });

  /** Für ältere Oberflächen: Servervorschlag zur Adresse */
  app.get('/mailbox/preset', async (req) => {
    requireUser(req);
    const { email } = parse(z.object({ email: z.string() }), req.query);
    const d = await discover(email);
    return d.settings;
  });

  app.post('/mailbox/setup/test', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({
      email: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben'), displayName: z.string().trim().max(120).default(''),
      authKind: z.enum(['password', 'microsoft', 'google']).default('password'), password: z.string().max(500).optional(), oauthTicket: z.string().max(200).optional(),
      accountId: z.string().uuid().optional(), extraTo: z.string().trim().max(300).optional(), skipMail: z.boolean().default(false),
      /** gemeinsames Firmenpostfach (Einstellungen → E-Mail-Versand): gespeichertes Passwort verwenden */
      system: z.boolean().default(false), ...serverFields,
    }), req.body);
    if (b.system) {
      if (u.role !== 'admin') throw forbidden();
      if (!b.password || b.password === '••••••••') b.password = (await ctx.settings.get('mail')).password;
    }
    const existing = b.accountId ? await ownAccount(sql, u, b.accountId) : null;
    if (b.extraTo && !z.string().email().safeParse(b.extraTo).success) throw badRequest('Die zusätzliche Adresse ist ungültig');
    const { auth, ticket } = await authFrom(u, b, existing);
    const s: ServerSettings = ticket ? { ...oauthServers(ticket.provider, ticket.email) } : { imapHost: b.imapHost, imapPort: b.imapPort, imapSecure: b.imapSecure, smtpHost: b.smtpHost, smtpPort: b.smtpPort, smtpSecure: b.smtpSecure, username: b.username };
    const run = startTest(ctx, u.id, { email: b.email, displayName: b.displayName || u.displayName, settings: s, auth, authKind: b.authKind, extraTo: b.extraTo, skipMail: b.skipMail });
    return { id: run.id };
  });

  app.get('/mailbox/setup/test/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: z.string().max(64) }), req.params);
    const run = getRun(id, u.id);
    if (!run) throw notFound('Test nicht gefunden – bitte neu starten');
    return { id: run.id, done: run.done, ok: run.ok, steps: run.steps, settings: run.settings, folderMap: run.folderMap, folders: run.folders, changes: run.changes };
  });

  // ------------------------------------------------ Anmeldung mit Microsoft / Google
  app.get('/mailbox/oauth/:provider/start', async (req) => {
    const u = requireUser(req);
    const { provider } = parse(z.object({ provider: z.enum(['microsoft', 'google']) }), req.params);
    const { email } = parse(z.object({ email: z.string().max(255).default('') }), req.query);
    return { url: await oauthStart(ctx, u.id, provider as OAuthProvider, email, callbackUrl(req)) };
  });

  app.get('/mailbox/oauth/callback', async (req, reply) => {
    const q = parse(z.object({ code: z.string().optional(), state: z.string().default(''), error: z.string().optional(), error_description: z.string().optional() }), req.query);
    let payload: Record<string, unknown>;
    try {
      if (q.error || !q.code) throw badRequest(q.error_description ?? q.error ?? 'Anmeldung abgebrochen');
      payload = { aperioOAuth: await oauthCallback(ctx, q.state, q.code) };
    } catch (e) { payload = { aperioOAuth: null, error: (e as Error).message }; }
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    reply.header('content-type', 'text/html; charset=utf-8');
    return `<!doctype html><meta charset="utf-8"><title>Anmeldung</title><body style="font-family:system-ui;padding:24px">
<p>${'error' in payload ? 'Die Anmeldung hat nicht geklappt. Dieses Fenster kann geschlossen werden.' : 'Angemeldet. Dieses Fenster schließt sich …'}</p>
<script>try{window.opener&&window.opener.postMessage(${json},location.origin)}catch(e){}setTimeout(function(){window.close()},${'error' in payload ? 6000 : 400})</script></body>`;
  });

  // ------------------------------------------------ Signaturen
  app.get('/mailbox/signatures', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ accountId: z.string().uuid().optional() }), req.query);
    const acc = q.accountId ? await ownAccount(sql, u, q.accountId) : null;
    const fields = await signatureFields(ctx, u.id);
    const comp = await ctx.settings.get('mailSignature');
    const items = await sql<{ id: string; name: string; html: string; sort: number }[]>`select id, name, html, sort from mail_signatures where owner_id = ${u.id} order by sort, created_at`;
    return {
      items: items.map((s) => ({ ...s, rendered: renderSignature(s.html, fields, acc?.email) })),
      company: comp.enabled && comp.html.trim() ? { mode: comp.mode, html: comp.html, rendered: renderSignature(comp.html, fields, acc?.email) } : null,
      fields, placeholders: SIG_PLACEHOLDERS,
    };
  });

  const sigBody = z.object({ name: z.string().trim().min(1, 'Bitte einen Namen angeben').max(80), html: z.string().max(1_500_000) });
  app.post('/mailbox/signatures', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(sigBody, req.body);
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from mail_signatures where owner_id = ${u.id}`)[0]!.n;
    if (n >= 50) throw badRequest('Höchstens 50 Signaturen');
    const [row] = await sql`insert into mail_signatures (owner_id, name, html, sort) values (${u.id}, ${b.name}, ${cleanHtml(b.html)}, ${n}) returning id, name, html, sort`;
    for (const a of await sql<{ id: string }[]>`select id from mail_accounts where owner_id = ${u.id} and sig_new = ''`) await syncLegacySignature(a.id);
    return row;
  });
  app.patch('/mailbox/signatures/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(sigBody.partial().extend({ sort: z.number().int().optional() }), req.body);
    const [row] = await sql`update mail_signatures set name = coalesce(${b.name ?? null}, name), html = coalesce(${b.html === undefined ? null : cleanHtml(b.html)}, html),
      sort = coalesce(${b.sort ?? null}, sort), updated_at = now() where id = ${id} and owner_id = ${u.id} returning id, name, html, sort`;
    if (!row) throw notFound();
    for (const a of await sql<{ id: string }[]>`select id from mail_accounts where owner_id = ${u.id}`) await syncLegacySignature(a.id);
    return row;
  });
  app.delete('/mailbox/signatures/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from mail_signatures where id = ${id} and owner_id = ${u.id}`;
    await sql`update mail_accounts set sig_new = '' where owner_id = ${u.id} and sig_new = ${id}`;
    await sql`update mail_accounts set sig_reply = '' where owner_id = ${u.id} and sig_reply = ${id}`;
    for (const a of await sql<{ id: string }[]>`select id from mail_accounts where owner_id = ${u.id}`) await syncLegacySignature(a.id);
    return { ok: true };
  });
  /** Vorschau mit den eigenen Angaben (auch für die Firmen-Signatur in den Einstellungen) */
  app.post('/mailbox/signatures/preview', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ html: z.string().max(1_500_000) }), req.body);
    return { html: renderSignature(cleanHtml(b.html), await signatureFields(ctx, u.id)) };
  });

  // ------------------------------------------------ Adressbuch
  app.get('/mailbox/addressbook', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const q = parse(z.object({ q: z.string().max(100).default(''), source: z.enum(['all', 'contacts', 'companies', 'users', 'recent']).default('all'), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    const like = `%${q.q.trim()}%`;
    const crm = hasTool(u, 'crm') && (await ctx.settings.get('apps')).installed.includes('crm');
    const out: { kind: string; name: string; email: string; detail: string }[] = [];
    if (q.source === 'all' || q.source === 'users') {
      out.push(...await sql<{ kind: string; name: string; email: string; detail: string }[]>`select 'user' as kind, u.display_name as name, u.email,
          concat_ws(' · ', nullif(u.job_title, ''), (select name from teams where id = u.department_id)) as detail
        from users u where u.active and u.deleted_at is null and u.role <> 'guest' and coalesce(u.email, '') <> ''
          and (u.display_name ilike ${like} or u.email ilike ${like}) order by u.display_name limit ${q.limit}`);
    }
    if (crm && (q.source === 'all' || q.source === 'contacts')) {
      out.push(...await sql<{ kind: string; name: string; email: string; detail: string }[]>`select 'contact' as kind, trim(concat_ws(' ', c.first_name, c.last_name)) as name, c.email,
          concat_ws(' · ', a.name, nullif(c.position, '')) as detail
        from crm_contacts c join crm_accounts a on a.id = c.account_id where c.email <> ''
          and (c.first_name ilike ${like} or c.last_name ilike ${like} or c.email ilike ${like} or a.name ilike ${like}) order by a.name, c.last_name limit ${q.limit}`);
    }
    if (crm && (q.source === 'all' || q.source === 'companies')) {
      out.push(...await sql<{ kind: string; name: string; email: string; detail: string }[]>`select 'company' as kind, a.name, a.email, 'Firma' as detail
        from crm_accounts a where a.email <> '' and (a.name ilike ${like} or a.email ilike ${like}) order by a.name limit ${q.limit}`);
    }
    if (q.source === 'all' || q.source === 'recent') {
      const rows = await sql<{ to_addrs: string; cc_addrs: string }[]>`select m.to_addrs, m.cc_addrs from mail_messages m join mail_accounts a on a.id = m.account_id
        where a.owner_id = ${u.id} and m.direction = 'out' order by m.date desc limit 300`;
      const seen = new Set(out.map((x) => x.email.toLowerCase()));
      const needle = q.q.trim().toLowerCase();
      for (const r of rows) for (const part of `${r.to_addrs},${r.cc_addrs}`.split(',')) {
        const m = part.trim().match(/^"?([^"<]*?)"?\s*<([^>]+)>$/) ?? [null, '', part.trim()];
        const email = (m[2] ?? '').trim();
        if (!email.includes('@') || seen.has(email.toLowerCase())) continue;
        const name = (m[1] ?? '').trim();
        if (needle && !`${name} ${email}`.toLowerCase().includes(needle)) continue;
        seen.add(email.toLowerCase());
        out.push({ kind: 'recent', name: name || email, email, detail: 'zuletzt verwendet' });
      }
    }
    const groups = await addressGroups(q.q.trim());
    return { entries: out.slice(0, q.limit * 2), groups: q.source === 'all' || q.source === 'users' ? groups : [], crm };
  });

  /** Gruppen: alle Mitarbeiter und je Team/Abteilung (mit untergeordneten Teams) */
  async function teamMembers(teamId: string | null) {
    return sql<{ id: string; name: string; email: string }[]>`
      with recursive t(id) as (select id from teams where id = ${teamId} union select c.id from teams c join t on c.parent_id = t.id)
      select distinct u.id, u.display_name as name, u.email from users u
      where u.active and u.deleted_at is null and u.role <> 'guest' and coalesce(u.email, '') <> ''
        and (${teamId}::uuid is null or u.department_id in (select id from t) or exists (select 1 from team_members m where m.user_id = u.id and m.team_id in (select id from t)))
      order by u.display_name`;
  }
  async function addressGroups(q: string) {
    const teams = await sql<{ id: string; name: string }[]>`select id, name from teams order by sort, name`;
    const out = [{ id: 'all', name: 'Alle Mitarbeiter', count: (await teamMembers(null)).length }];
    for (const t of teams) {
      const n = (await teamMembers(t.id)).length;
      if (n) out.push({ id: t.id, name: t.name, count: n });
    }
    return q ? out.filter((g) => g.name.toLowerCase().includes(q.toLowerCase())) : out;
  }
  app.get('/mailbox/addressbook/groups/:id', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const { id } = parse(z.object({ id: z.union([z.literal('all'), z.string().uuid()]) }), req.params);
    const name = id === 'all' ? 'Alle Mitarbeiter' : (await sql<{ name: string }[]>`select name from teams where id = ${id}`)[0]?.name;
    if (!name) throw notFound();
    return { id, name, members: await teamMembers(id === 'all' ? null : id) };
  });

  // ------------------------------------------------ Postausgang
  app.get('/mailbox/outbox', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ accountId: z.string().uuid().optional() }), req.query);
    return sql`select o.id, o.account_id as "accountId", o.status, o.attempts, o.last_error as "lastError", o.next_try_at as "nextTryAt", o.created_at as "createdAt",
        o.payload->>'subject' as subject, o.payload->>'to' as "to"
      from mail_outbox o join mail_accounts a on a.id = o.account_id
      where a.owner_id = ${u.id} and o.status in ('queued', 'sending', 'failed') ${q.accountId ? sql`and o.account_id = ${q.accountId}` : sql``} order by o.created_at`;
  });
  async function outboxRow(u: AuthUser, id: string) {
    const [o] = await sql<{ id: string; account_id: string; status: string }[]>`select o.id, o.account_id, o.status from mail_outbox o join mail_accounts a on a.id = o.account_id where o.id = ${id} and a.owner_id = ${u.id}`;
    if (!o) throw notFound();
    return o;
  }
  app.post('/mailbox/outbox/:id/retry', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const o = await outboxRow(u, id);
    if (o.status === 'sent') return { ok: true };
    await sql`update mail_outbox set status = 'queued', next_try_at = now() where id = ${id} and status in ('queued', 'failed')`;
    await processOutbox(ctx, id);
    const [r] = await sql<{ status: string; last_error: string | null }[]>`select status, last_error from mail_outbox where id = ${id}`;
    return { ok: r?.status === 'sent', status: r?.status, error: r?.last_error };
  });
  /** Aus dem Postausgang zurück in die Entwürfe */
  app.delete('/mailbox/outbox/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const o = await outboxRow(u, id);
    if (o.status === 'sending') throw badRequest('Die E-Mail wird gerade verschickt.');
    const draftId = await draftFromOutbox(ctx, id);
    return { ok: true, draftId };
  });
}
