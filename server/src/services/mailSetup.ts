/**
 * Einrichtungsassistent für E-Mail-Konten: Anbieter erkennen und die Verbindung gründlich prüfen –
 * bis hin zu einer echten Test-E-Mail an sich selbst, die wieder abgeholt wird.
 */
import { randomBytes } from 'node:crypto';
import { Resolver, lookup } from 'node:dns/promises';
import { XMLParser } from 'fast-xml-parser';
import type { AppContext } from '../context';
import { connectImap, explainMailError, fromHeader, guessSpecial, smtpFor, type Imap, type MailAccount, type MailProblem, type OutgoingMail } from './mailbox';
import { isFakeHost } from './mailFake';
import { OAUTH_SERVERS } from './mailOAuth';

export interface ServerSettings { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string }

export interface Provider {
  id: string; name: string; domains: string[]; mx?: RegExp; hostFromMx?: boolean; needsHost?: boolean;
  imap?: [string, number, boolean]; smtp?: [string, number, boolean];
  oauth?: 'microsoft' | 'google'; hint: string; helpUrl?: string; username?: 'email' | 'local';
}

/** Bekannte Anbieter (Server, Anschlüsse, was man selbst tun muss) */
export const PROVIDERS: Provider[] = [
  { id: 'netcup', name: 'netcup', domains: [], mx: /\.netcup\.net\.?$/i, hostFromMx: true, needsHost: true, imap: ['', 993, true], smtp: ['', 465, true],
    hint: 'Benutzername ist die volle E-Mail-Adresse. Der Servername steht im netcup-Kundenbereich (Webhosting Control Panel) bei der E-Mail-Adresse unter „Mailprogramme konfigurieren“ und sieht meist so aus: mx….netcup.net.',
    helpUrl: 'https://www.netcup.com/de/helpcenter/dokumentation/webhosting/externe-mailclients' },
  { id: 'allinkl', name: 'All-Inkl', domains: [], mx: /\.kasserver\.com\.?$/i, hostFromMx: true, needsHost: true, imap: ['', 993, true], smtp: ['', 465, true],
    hint: 'Servername und Benutzername (z. B. m0123456 oder die E-Mail-Adresse) stehen im KAS bei der E-Mail-Adresse.' },
  { id: 'ionos', name: 'IONOS (1&1)', domains: ['ionos.de', 'online.de', 'onlinehome.de'], mx: /(ionos\.(de|com)|kundenserver\.de)\.?$/i, imap: ['imap.ionos.de', 993, true], smtp: ['smtp.ionos.de', 465, true],
    hint: 'Nur das Passwort des E-Mail-Postfachs angeben.' },
  { id: 'strato', name: 'Strato', domains: ['strato.de'], mx: /rzone\.de\.?$/i, imap: ['imap.strato.de', 993, true], smtp: ['smtp.strato.de', 465, true], hint: 'Nur das Passwort des E-Mail-Postfachs angeben.' },
  { id: 'hetzner', name: 'Hetzner', domains: [], mx: /your-server\.de\.?$/i, imap: ['mail.your-server.de', 993, true], smtp: ['mail.your-server.de', 587, false], hint: 'Nur das Passwort des E-Mail-Postfachs angeben.' },
  { id: 'google', name: 'Gmail / Google Workspace', domains: ['gmail.com', 'googlemail.com'], mx: /(google|googlemail)\.com\.?$/i, imap: ['imap.gmail.com', 993, true], smtp: ['smtp.gmail.com', 465, true], oauth: 'google',
    hint: 'Am einfachsten „Mit Google anmelden“. Alternativ ein App-Passwort (geht nur mit Zwei-Schritt-Bestätigung im Google-Konto).', helpUrl: 'https://support.google.com/accounts/answer/185833' },
  { id: 'microsoft', name: 'Microsoft 365 / Outlook.com', domains: ['outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com'], mx: /(protection\.outlook\.com|outlook\.com)\.?$/i,
    imap: ['outlook.office365.com', 993, true], smtp: ['smtp.office365.com', 587, false], oauth: 'microsoft',
    hint: '„Mit Microsoft anmelden“ verwenden – das Passwort allein reicht bei Microsoft nicht mehr.' },
  { id: 'gmx', name: 'GMX', domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'gmx.com'], imap: ['imap.gmx.net', 993, true], smtp: ['mail.gmx.net', 587, false],
    hint: 'Einmalig im GMX-Postfach unter Einstellungen → „POP3 & IMAP Abruf“ den Zugriff per Mailprogramm erlauben.', helpUrl: 'https://hilfe.gmx.net/pop-imap/einschalten.html' },
  { id: 'webde', name: 'WEB.DE', domains: ['web.de'], imap: ['imap.web.de', 993, true], smtp: ['smtp.web.de', 587, false],
    hint: 'Einmalig im WEB.DE-Postfach unter Einstellungen → „POP3/IMAP Abruf“ den Zugriff per Mailprogramm erlauben.', helpUrl: 'https://hilfe.web.de/pop-imap/einschalten.html' },
  { id: 'tonline', name: 'Telekom (T-Online)', domains: ['t-online.de', 'magenta.de'], imap: ['secureimap.t-online.de', 993, true], smtp: ['securesmtp.t-online.de', 465, true],
    hint: 'Das eigene E-Mail-Passwort verwenden, nicht das Passwort für den Telekom-Login. Es wird im E-Mail-Center unter „Passwörter“ angelegt.' },
  { id: 'freenet', name: 'freenet', domains: ['freenet.de'], imap: ['mx.freenet.de', 993, true], smtp: ['mx.freenet.de', 587, false], hint: 'Nur das Passwort angeben.' },
  { id: 'mailboxorg', name: 'mailbox.org', domains: ['mailbox.org'], mx: /mailbox\.org\.?$/i, imap: ['imap.mailbox.org', 993, true], smtp: ['smtp.mailbox.org', 465, true], hint: 'Nur das Passwort angeben.' },
  { id: 'posteo', name: 'Posteo', domains: ['posteo.de', 'posteo.net'], mx: /posteo\.de\.?$/i, imap: ['posteo.de', 993, true], smtp: ['posteo.de', 465, true], hint: 'Nur das Passwort angeben.' },
  { id: 'yahoo', name: 'Yahoo', domains: ['yahoo.com', 'yahoo.de', 'ymail.com'], imap: ['imap.mail.yahoo.com', 993, true], smtp: ['smtp.mail.yahoo.com', 465, true],
    hint: 'Ein App-Passwort in den Kontoeinstellungen von Yahoo erzeugen und hier eintragen.', helpUrl: 'https://help.yahoo.com/kb/SLN15241.html' },
  { id: 'icloud', name: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'], imap: ['imap.mail.me.com', 993, true], smtp: ['smtp.mail.me.com', 587, false],
    hint: 'Ein App-spezifisches Passwort unter account.apple.com erzeugen und hier eintragen.', helpUrl: 'https://support.apple.com/de-de/102654' },
  { id: 'aol', name: 'AOL', domains: ['aol.com', 'aol.de'], imap: ['imap.aol.com', 993, true], smtp: ['smtp.aol.com', 465, true], hint: 'Ein App-Passwort in den Kontoeinstellungen erzeugen.' },
  { id: 'fastmail', name: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'], mx: /messagingengine\.com\.?$/i, imap: ['imap.fastmail.com', 993, true], smtp: ['smtp.fastmail.com', 465, true], hint: 'Ein App-Passwort in den Einstellungen erzeugen.' },
  { id: 'zoho', name: 'Zoho Mail', domains: ['zoho.eu', 'zohomail.eu'], mx: /zoho\.eu\.?$/i, imap: ['imap.zoho.eu', 993, true], smtp: ['smtp.zoho.eu', 465, true], hint: 'IMAP-Zugriff muss in den Zoho-Einstellungen eingeschaltet sein.' },
  { id: 'custom', name: 'Eigener Server / sonstiger Anbieter', domains: [], needsHost: true, hint: 'Server und Anschlüsse stehen im Kundenbereich Ihres Anbieters oder kommen von Ihrem IT-Dienstleister.' },
];

export const providerInfo = (p: Provider) => ({ id: p.id, name: p.name, domains: p.domains, needsHost: Boolean(p.needsHost), oauth: p.oauth ?? null, hint: p.hint, helpUrl: p.helpUrl ?? null,
  imap: p.imap ? { host: p.imap[0], port: p.imap[1], secure: p.imap[2] } : null, smtp: p.smtp ? { host: p.smtp[0], port: p.smtp[1], secure: p.smtp[2] } : null });

const fromProvider = (p: Provider, email: string, host = ''): ServerSettings => ({
  imapHost: p.imap?.[0] || host, imapPort: p.imap?.[1] ?? 993, imapSecure: p.imap?.[2] ?? true,
  smtpHost: p.smtp?.[0] || host, smtpPort: p.smtp?.[1] ?? 465, smtpSecure: p.smtp?.[2] ?? true,
  username: p.username === 'local' ? email.split('@')[0]! : email,
});

const resolver = () => { const r = new Resolver({ timeout: 4000, tries: 1 }); return r; };
async function mxHosts(domain: string) {
  try { return (await resolver().resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.replace(/\.$/, '')); } catch { return []; }
}
async function resolvable(host: string) { try { await lookup(host); return true; } catch { return false; } }

/** Einstellungen, die Anbieter im Internet bereitstellen (wie Thunderbird) */
async function autoconfig(email: string, domain: string): Promise<ServerSettings | null> {
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
      if (!res.ok) continue;
      const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(await res.text()) as Record<string, any>;
      const prov = parsed?.clientConfig?.emailProvider;
      if (!prov) continue;
      const arr = <T>(x: T | T[] | undefined) => (Array.isArray(x) ? x : x ? [x] : []);
      const inc = arr<any>(prov.incomingServer).find((s) => s.type === 'imap');
      const out = arr<any>(prov.outgoingServer).find((s) => s.type === 'smtp');
      if (!inc || !out) continue;
      const fill = (s: string) => String(s ?? '').replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, email.split('@')[0]!).replace(/%EMAILDOMAIN%/g, domain);
      return {
        imapHost: fill(inc.hostname), imapPort: Number(inc.port) || 993, imapSecure: inc.socketType === 'SSL',
        smtpHost: fill(out.hostname), smtpPort: Number(out.port) || 587, smtpSecure: out.socketType === 'SSL',
        username: fill(inc.username || '%EMAILADDRESS%'),
      };
    } catch { /* nächste Quelle */ }
  }
  return null;
}

async function srv(domain: string): Promise<Partial<ServerSettings> | null> {
  const r = resolver();
  const one = async (name: string) => { try { const x = (await r.resolveSrv(name)).sort((a, b) => a.priority - b.priority)[0]; return x && x.name !== '.' ? x : null; } catch { return null; } };
  const [imaps, imap, subs, sub] = await Promise.all([one(`_imaps._tcp.${domain}`), one(`_imap._tcp.${domain}`), one(`_submissions._tcp.${domain}`), one(`_submission._tcp.${domain}`)]);
  if (!imaps && !imap && !subs && !sub) return null;
  return {
    ...(imaps ? { imapHost: imaps.name, imapPort: imaps.port, imapSecure: true } : imap ? { imapHost: imap.name, imapPort: imap.port, imapSecure: imap.port === 993 } : {}),
    ...(subs ? { smtpHost: subs.name, smtpPort: subs.port, smtpSecure: true } : sub ? { smtpHost: sub.name, smtpPort: sub.port, smtpSecure: sub.port === 465 } : {}),
  };
}

export interface Discovery { provider: ReturnType<typeof providerInfo> | null; settings: ServerSettings; source: 'list' | 'mx' | 'autoconfig' | 'srv' | 'guess'; note: string }

/** Passende Einstellungen für eine Adresse finden: Liste → Domain-Eintrag → Internet → Ausprobieren */
export async function discover(email: string): Promise<Discovery> {
  const domain = (email.split('@')[1] ?? '').toLowerCase().trim();
  const listed = PROVIDERS.find((p) => p.domains.includes(domain));
  if (listed) return { provider: providerInfo(listed), settings: fromProvider(listed, email), source: 'list', note: `Erkannt: ${listed.name}` };
  if (/\.aperio\.test$/.test(domain)) {
    const host = `mail.${domain}`;
    return { provider: providerInfo(PROVIDERS.find((p) => p.id === 'custom')!), settings: { imapHost: host, imapPort: 993, imapSecure: true, smtpHost: host, smtpPort: 465, smtpSecure: true, username: email }, source: 'guess', note: `Vorschlag: ${host}` };
  }
  const mx = await mxHosts(domain);
  for (const host of mx) {
    const p = PROVIDERS.find((x) => x.mx?.test(host));
    if (p) return { provider: providerInfo(p), settings: fromProvider(p, email, p.hostFromMx ? host : ''), source: 'mx', note: p.hostFromMx ? `Erkannt: ${p.name} – Server ${host}` : `Erkannt: ${p.name}` };
  }
  const auto = await autoconfig(email, domain);
  if (auto) return { provider: null, settings: auto, source: 'autoconfig', note: `Einstellungen des Anbieters gefunden: ${auto.imapHost}` };
  const s = await srv(domain);
  if (s?.imapHost && s.smtpHost) return { provider: null, settings: { imapPort: 993, imapSecure: true, smtpPort: 587, smtpSecure: false, username: email, ...s } as ServerSettings, source: 'srv', note: `Im Domain-Eintrag gefunden: ${s.imapHost}` };
  const cand = async (names: string[]) => { for (const n of names) if (await resolvable(n)) return n; return null; };
  const imapHost = (await cand([`imap.${domain}`, `mail.${domain}`])) ?? mx[0] ?? `imap.${domain}`;
  const smtpHost = (await cand([`smtp.${domain}`, `mail.${domain}`])) ?? mx[0] ?? `smtp.${domain}`;
  return { provider: providerInfo(PROVIDERS.find((p) => p.id === 'custom')!), settings: { imapHost, imapPort: 993, imapSecure: true, smtpHost, smtpPort: 465, smtpSecure: true, username: email },
    source: 'guess', note: `Kein bekannter Anbieter – Vorschlag: ${imapHost}. Bitte prüfen.` };
}

export function providerFor(id: string) { return PROVIDERS.find((p) => p.id === id) ?? null; }
export function oauthServers(kind: 'microsoft' | 'google', email: string): ServerSettings { return { ...OAUTH_SERVERS[kind], username: email }; }

// ------------------------------------------------------------------ Verbindungstest
type StepKey = 'imap' | 'login' | 'folders' | 'smtp' | 'send' | 'receive';
export interface Step { key: StepKey; label: string; status: 'pending' | 'running' | 'ok' | 'warn' | 'error' | 'skipped'; text: string; tip: string }
export interface TestRun {
  id: string; userId: string; started: number; done: boolean; ok: boolean; steps: Step[]; settings: ServerSettings;
  folderMap: Record<string, string>; folders: { path: string; special: string | null }[]; changes: string[]; fingerprint: string;
}
const runs = new Map<string, TestRun>();
const LABELS: Record<StepKey, string> = {
  imap: 'Server für eingehende Post erreichbar', login: 'Anmeldung klappt', folders: 'Ordner gefunden',
  smtp: 'Server für ausgehende Post erreichbar, Anmeldung klappt', send: 'Test-E-Mail verschickt', receive: 'Test-E-Mail angekommen',
};
export const fingerprint = (s: ServerSettings, email: string) => [email, s.imapHost, s.imapPort, s.imapSecure, s.smtpHost, s.smtpPort, s.smtpSecure, s.username].join('|').toLowerCase();

export function getRun(id: string, userId: string) { const r = runs.get(id); return r && r.userId === userId ? r : null; }

export interface TestInput { email: string; displayName: string; settings: ServerSettings; auth: { user: string; pass?: string; accessToken?: string }; authKind: 'password' | 'microsoft' | 'google'; extraTo?: string; skipMail?: boolean }

/** Test starten; Fortschritt über getRun abfragen */
export function startTest(ctx: AppContext, userId: string, input: TestInput) {
  for (const [k, r] of runs) if (Date.now() - r.started > 30 * 60_000) runs.delete(k);
  const run: TestRun = {
    id: randomBytes(12).toString('hex'), userId, started: Date.now(), done: false, ok: false, settings: { ...input.settings }, folderMap: {}, folders: [], changes: [],
    steps: (Object.keys(LABELS) as StepKey[]).map((key) => ({ key, label: LABELS[key], status: 'pending', text: '', tip: '' })), fingerprint: '',
  };
  runs.set(run.id, run);
  void execute(ctx, run, input).catch((e) => { const s = run.steps.find((x) => x.status === 'running'); if (s) Object.assign(s, { status: 'error', text: String((e as Error).message) }); run.done = true; });
  return run;
}

const draftAccount = (s: ServerSettings, input: TestInput): MailAccount => ({
  id: `test-${randomBytes(4).toString('hex')}`, user_id: null, owner_id: '', email: input.email, display_name: input.displayName, imap_host: s.imapHost, imap_port: s.imapPort, imap_secure: s.imapSecure,
  smtp_host: s.smtpHost, smtp_port: s.smtpPort, smtp_secure: s.smtpSecure, username: s.username, password_sealed: '', signature_html: '', auth_kind: input.authKind,
  oauth_sealed: null, folder_map: {}, provider: '', label: '', sig_new: '', sig_reply: '', sort: 0,
});

async function execute(ctx: AppContext, run: TestRun, input: TestInput) {
  const step = (k: StepKey) => run.steps.find((s) => s.key === k)!;
  const set = (k: StepKey, status: Step['status'], text = '', tip = '') => Object.assign(step(k), { status, text, tip });
  const fail = (k: StepKey, p: MailProblem) => set(k, 'error', p.text, p.tip);
  const skipRest = (from: StepKey[]) => from.forEach((k) => { if (step(k).status === 'pending') set(k, 'skipped', 'Nicht geprüft, weil ein Schritt davor nicht geklappt hat.'); });
  const finish = () => { run.done = true; run.ok = !run.steps.some((s) => s.status === 'error'); run.fingerprint = fingerprint(run.settings, input.email); };

  // 1 + 2: eingehende Post, bei Bedarf den anderen üblichen Anschluss probieren
  set('imap', 'running');
  let imap: Imap | null = null;
  const tryImap = async (port: number, secure: boolean) => connectImap(ctx, draftAccount({ ...run.settings, imapPort: port, imapSecure: secure }, input), input.auth);
  try {
    imap = await tryImap(run.settings.imapPort, run.settings.imapSecure);
  } catch (e) {
    const p = explainMailError(e, 'imap', { imap_host: run.settings.imapHost, imap_port: run.settings.imapPort });
    if (p.auth) { set('imap', 'ok', `Erreichbar: ${run.settings.imapHost}`); fail('login', p); skipRest(['folders', 'smtp', 'send', 'receive']); return finish(); }
    if (!/nicht gefunden/.test(p.text)) {
      const alt: [number, boolean] = run.settings.imapPort === 993 ? [143, false] : [993, true];
      try {
        imap = await tryImap(...alt);
        run.changes.push(`Eingehende Post: Anschluss ${alt[0]} statt ${run.settings.imapPort} verwendet`);
        run.settings.imapPort = alt[0]; run.settings.imapSecure = alt[1];
      } catch (e2) {
        const p2 = explainMailError(e2, 'imap', { imap_host: run.settings.imapHost, imap_port: alt[0] });
        if (p2.auth) { run.settings.imapPort = alt[0]; run.settings.imapSecure = alt[1]; set('imap', 'ok', `Erreichbar über Anschluss ${alt[0]}`); fail('login', p2); skipRest(['folders', 'smtp', 'send', 'receive']); return finish(); }
      }
    }
    if (!imap) { fail('imap', p); skipRest(['login', 'folders', 'smtp', 'send', 'receive']); return finish(); }
  }
  set('imap', 'ok', `Erreichbar: ${run.settings.imapHost}, Anschluss ${run.settings.imapPort} (${run.settings.imapSecure ? 'SSL/TLS' : 'STARTTLS'})`);
  set('login', 'ok', `Angemeldet als ${run.settings.username}`);

  try {
    // 3: Ordner
    set('folders', 'running');
    const list = (await imap.list()).filter((f) => !f.flags.has('\\Noselect'));
    const taken = new Set<string>();
    run.folders = list.map((f) => {
      let special = f.specialUse ?? (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null);
      if (!special) { const g = guessSpecial(f.path, f.delimiter ?? '/'); if (g && !list.some((x) => x.specialUse === g) && !taken.has(g)) special = g; }
      if (special) taken.add(special);
      return { path: f.path, special };
    });
    const keyOf: Record<string, string> = { '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'junk', '\\Archive': 'archive' };
    for (const f of run.folders) if (f.special && keyOf[f.special]) run.folderMap[keyOf[f.special]!] = f.path;
    const names: [string, string][] = [['sent', 'Gesendet'], ['drafts', 'Entwürfe'], ['trash', 'Papierkorb'], ['junk', 'Spam']];
    const missing = names.filter(([k]) => !run.folderMap[k]).map(([, n]) => n);
    const found = names.filter(([k]) => run.folderMap[k]).map(([k, n]) => `${n} (${run.folderMap[k]})`);
    if (missing.length) set('folders', 'warn', `Posteingang${found.length ? `, ${found.join(', ')}` : ''} gefunden. Nicht gefunden: ${missing.join(', ')}.`, 'Bitte unten die Ordner von Hand zuordnen – sonst landet zum Beispiel keine Kopie in „Gesendet“.');
    else set('folders', 'ok', `Posteingang, ${found.join(', ')}`);

    // 4: ausgehende Post
    set('smtp', 'running');
    const verify = async (port: number, secure: boolean) => (await smtpFor(ctx, draftAccount({ ...run.settings, smtpPort: port, smtpSecure: secure }, input), input.auth)).verify();
    try {
      await verify(run.settings.smtpPort, run.settings.smtpSecure);
    } catch (e) {
      const p = explainMailError(e, 'smtp', { smtp_host: run.settings.smtpHost, smtp_port: run.settings.smtpPort });
      let fixed = false;
      if (!p.auth && !/nicht gefunden/.test(p.text)) {
        for (const alt of ([[465, true], [587, false]] as [number, boolean][]).filter(([port]) => port !== run.settings.smtpPort)) {
          try { await verify(...alt); run.changes.push(`Ausgehende Post: Anschluss ${alt[0]} statt ${run.settings.smtpPort} verwendet`); run.settings.smtpPort = alt[0]; run.settings.smtpSecure = alt[1]; fixed = true; break; } catch { /* nächster */ }
        }
      }
      if (!fixed) { fail('smtp', p); skipRest(['send', 'receive']); return finish(); }
    }
    set('smtp', 'ok', `Erreichbar: ${run.settings.smtpHost}, Anschluss ${run.settings.smtpPort} (${run.settings.smtpSecure ? 'SSL/TLS' : 'STARTTLS'})`);

    if (input.skipMail) { set('send', 'skipped', 'Test-E-Mail nicht gewünscht.'); set('receive', 'skipped', ''); return finish(); }

    // 5: Test-E-Mail an sich selbst
    set('send', 'running');
    const token = randomBytes(5).toString('hex').toUpperCase();
    const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
    const subject = `AperioPlan-Test ${time} – kann gelöscht werden [${token}]`;
    const html = `<p>Diese E-Mail hat der Einrichtungsassistent von AperioPlan verschickt, um Ihr Postfach zu prüfen.</p><p>Sie kann gelöscht werden.</p>`;
    const sentAt = Date.now();
    try {
      const acc = draftAccount(run.settings, input);
      await sendWithAuth(ctx, acc, input.auth, { to: input.email, subject, html, text: 'Test von AperioPlan – kann gelöscht werden.', attachments: [] });
      if (input.extraTo?.trim()) await sendWithAuth(ctx, acc, input.auth, { to: input.extraTo.trim(), subject, html, text: 'Test von AperioPlan – kann gelöscht werden.', attachments: [] });
    } catch (e) {
      const p = (e as { problem?: MailProblem }).problem ?? explainMailError(e, 'smtp', { smtp_host: run.settings.smtpHost });
      fail('send', p); skipRest(['receive']); return finish();
    }
    set('send', 'ok', `An ${input.email}${input.extraTo?.trim() ? ` und ${input.extraTo.trim()}` : ''} verschickt`);

    // 6: Test-E-Mail im Posteingang (oder Spam) suchen
    set('receive', 'running', 'Warte auf die Test-E-Mail …');
    const boxes = ['INBOX', ...(run.folderMap.junk ? [run.folderMap.junk] : [])];
    const limit = process.env.NODE_ENV === 'test' ? 1500 : 120_000;
    const pause = process.env.NODE_ENV === 'test' ? 100 : 4000;
    let foundIn: string | null = null;
    while (!foundIn && Date.now() - sentAt < limit) {
      for (const box of boxes) {
        const lock = await imap.getMailboxLock(box);
        try {
          const mb = imap.mailbox;
          if (!mb || typeof mb === 'boolean' || !mb.exists) continue;
          for await (const m of imap.fetch(`${Math.max(1, mb.exists - 15)}:*`, { uid: true, source: true })) {
            if (m.source && m.source.includes(token)) {
              foundIn = box;
              await imap.messageFlagsAdd(String(m.uid), ['\\Seen'], { uid: true }).catch(() => {});
              if (run.folderMap.trash) await imap.messageMove(String(m.uid), run.folderMap.trash, { uid: true }).catch(() => {});
              break;
            }
          }
        } finally { lock.release(); }
        if (foundIn) break;
      }
      if (!foundIn) await new Promise((r) => setTimeout(r, pause));
    }
    const secs = Math.max(1, Math.round((Date.now() - sentAt) / 1000));
    if (!foundIn) set('receive', 'warn', 'Verschickt, aber nach 2 Minuten noch nicht angekommen.', 'Manche Anbieter stellen verzögert zu. Später im Posteingang und im Spam-Ordner nachsehen. Das Konto kann trotzdem gespeichert werden.');
    else if (foundIn !== 'INBOX') set('receive', 'warn', `Angekommen nach ${secs} Sekunden – aber im Spam-Ordner.`, 'Die eigene Adresse beim Anbieter als vertrauenswürdig markieren.');
    else set('receive', 'ok', `Angekommen nach ${secs} Sekunde${secs === 1 ? '' : 'n'}${run.folderMap.trash ? ', in den Papierkorb gelegt' : ''}`);
  } finally {
    await imap.logout().catch(() => {});
  }
  return finish();
}

async function sendWithAuth(ctx: AppContext, a: MailAccount, auth: TestInput['auth'], m: OutgoingMail) {
  // smtpSend holt die Zugangsdaten sonst aus der Datenbank – für den Test die eingegebenen verwenden
  const transport = await smtpFor(ctx, a, auth);
  for (let i = 1; i <= 2; i++) {
    try {
      return await transport.sendMail({ from: fromHeader(a), to: m.to, subject: m.subject, html: m.html, text: m.text } as never);
    } catch (e) {
      const p = explainMailError(e, 'smtp', a);
      if (!p.transient || i === 2) throw Object.assign(e as Error, { problem: p });
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 20 : 3000));
    }
  }
  return null;
}

export const _test = { PROVIDERS, fingerprint, isFakeHost };
