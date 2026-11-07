/**
 * Einrichtungsassistent für E-Mail-Konten (Schritt für Schritt mit echtem Test)
 * und die Einstellungen eines eingerichteten Postfachs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { del, get, patch, post } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { realtime } from '../../lib/realtime';
import { useSession } from '../../session';
import { fmtDateTime } from '../../lib/format';
import { Confirm, Field, Modal, Pill, Tabs, useAction, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { senderLine, type MailAccount, type ProviderInfo, type ServerSettings, type SignatureData } from './types';

interface Step { key: string; label: string; status: 'pending' | 'running' | 'ok' | 'warn' | 'error' | 'skipped'; text: string; tip: string }
interface Run { id: string; done: boolean; ok: boolean; steps: Step[]; settings: ServerSettings; folderMap: Record<string, string>; folders: { path: string; special: string | null }[]; changes: string[] }

const STEP_ICON: Record<Step['status'], [string, string]> = {
  pending: ['circle-dashed', 'var(--text-3)'], running: ['refresh', 'var(--accent)'], ok: ['check-circle', 'var(--green)'],
  warn: ['alert', 'var(--amber)'], error: ['x-circle', 'var(--red)'], skipped: ['circle-dashed', 'var(--text-3)'],
};
const FOLDER_ROLES: [string, string][] = [['sent', 'Gesendet'], ['drafts', 'Entwürfe'], ['trash', 'Papierkorb'], ['junk', 'Spam'], ['archive', 'Archiv']];
const TITLES = ['Adresse und Name', 'Anbieter', 'Anmelden', 'Verbindungstest', 'Fertig'];

/** Anmeldefenster des Anbieters öffnen und auf die Rückmeldung warten */
function oauthPopup(provider: 'microsoft' | 'google', email: string): Promise<{ ticket: string; email: string; provider: string }> {
  return new Promise((resolve, reject) => {
    const w = window.open('about:blank', 'aperio-oauth', 'width=520,height=680');
    if (!w) { reject(new Error('Das Anmeldefenster wurde blockiert. Bitte Pop-ups für AperioPlan erlauben.')); return; }
    get<{ url: string }>(`/mailbox/oauth/${provider}/start?email=${encodeURIComponent(email)}`).then((r) => { w.location.href = r.url; }).catch((e) => { w.close(); reject(e); });
    const timer = setInterval(() => { if (w.closed) { clearInterval(timer); window.removeEventListener('message', onMsg); reject(new Error('Anmeldung abgebrochen')); } }, 800);
    function onMsg(ev: MessageEvent) {
      if (ev.origin !== location.origin || !ev.data || !('aperioOAuth' in ev.data)) return;
      clearInterval(timer); window.removeEventListener('message', onMsg);
      if (ev.data.aperioOAuth) resolve(ev.data.aperioOAuth); else reject(new Error(ev.data.error ?? 'Anmeldung fehlgeschlagen'));
    }
    window.addEventListener('message', onMsg);
  });
}

export function MailSetupWizard({ account, hasAccounts, onClose, onDone }: { account?: MailAccount | null; hasAccounts?: boolean; onClose: () => void; onDone: (a: MailAccount) => void }) {
  const { me } = useSession();
  const act = useAction();
  const toast = useToast();
  const { data: catalog } = useApi<{ providers: ProviderInfo[]; oauth: { microsoft: boolean; google: boolean } }>('/mailbox/setup/providers');
  const initialName = account?.displayName ?? (me && me.username !== 'admin' && me.displayName !== 'Administrator' ? me.displayName : '');
  const [step, setStep] = useState(account ? 2 : 1);
  const [email, setEmail] = useState(account?.email ?? (hasAccounts ? '' : me?.email ?? ''));
  const [name, setName] = useState(initialName);
  const [label, setLabel] = useState(account?.label ?? '');
  const [providerId, setProviderId] = useState(account?.provider || '');
  const [note, setNote] = useState('');
  const [manual, setManual] = useState(false);
  const [s, setS] = useState<ServerSettings>(account
    ? { imapHost: account.imapHost, imapPort: account.imapPort, imapSecure: account.imapSecure, smtpHost: account.smtpHost, smtpPort: account.smtpPort, smtpSecure: account.smtpSecure, username: account.username }
    : { imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true, username: '' });
  const [authKind, setAuthKind] = useState<MailAccount['authKind']>(account?.authKind ?? 'password');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<{ ticket: string; email: string } | null>(null);
  const [extraTo, setExtraTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [folderMap, setFolderMap] = useState<Record<string, string>>(account?.folderMap ?? {});
  const [saved, setSaved] = useState<MailAccount | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; fetched: number } | null>(null);
  const poll = useRef<number | null>(null);
  useEffect(() => () => { if (poll.current) clearTimeout(poll.current); }, []);

  const provider = catalog?.providers.find((p) => p.id === providerId) ?? null;
  const oauthReady = provider?.oauth ? catalog?.oauth[provider.oauth] : false;
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  const detect = async () => {
    setBusy(true);
    const d = await act(() => post<{ provider: ProviderInfo | null; settings: ServerSettings; note: string }>('/mailbox/setup/discover', { email: email.trim() }));
    setBusy(false);
    if (!d) return;
    setProviderId(d.provider?.id ?? 'custom');
    setS(d.settings);
    setNote(d.note);
    setAuthKind(d.provider?.oauth === 'microsoft' && catalog?.oauth.microsoft ? 'microsoft' : 'password');
    setManual(false);
    setStep(2);
  };
  const chooseProvider = (id: string) => {
    setProviderId(id);
    const p = catalog?.providers.find((x) => x.id === id);
    if (!p) return;
    const host = p.needsHost ? (s.imapHost && !p.imap?.host ? s.imapHost : '') : '';
    setS({ imapHost: p.imap?.host || host, imapPort: p.imap?.port ?? 993, imapSecure: p.imap?.secure ?? true, smtpHost: p.smtp?.host || host, smtpPort: p.smtp?.port ?? 465, smtpSecure: p.smtp?.secure ?? true, username: s.username || email.trim() });
    setAuthKind(p.oauth === 'microsoft' && catalog?.oauth.microsoft ? 'microsoft' : 'password');
    setTicket(null);
    setNote('');
  };
  const startTest = async () => {
    setRun(null);
    const r = await act(() => post<{ id: string }>('/mailbox/setup/test', {
      email: email.trim(), displayName: name.trim(), ...s, authKind, ...(authKind === 'password' ? (password ? { password } : {}) : ticket ? { oauthTicket: ticket.ticket } : {}),
      accountId: account?.id, extraTo: extraTo.trim() || undefined,
    }));
    if (!r) return;
    setStep(4);
    const tick = async () => {
      try {
        const x = await get<Run>(`/mailbox/setup/test/${r.id}`);
        setRun(x);
        if (x.folderMap && Object.keys(x.folderMap).length) setFolderMap((m) => ({ ...x.folderMap, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v)) }));
        if (!x.done) poll.current = window.setTimeout(tick, 700);
      } catch (e) { toast((e as Error).message, 'error'); }
    };
    void tick();
  };
  const save = async () => {
    if (!run) return;
    setBusy(true);
    const body = { displayName: name.trim(), label: label.trim(), provider: providerId, ...run.settings, authKind, folderMap, testId: run.id,
      ...(authKind === 'password' ? (password ? { password } : {}) : ticket ? { oauthTicket: ticket.ticket } : {}) };
    const r = await act(() => (account ? patch<MailAccount>(`/mailbox/accounts/${account.id}`, body) : post<MailAccount>('/mailbox/accounts', { email: email.trim(), ...body })));
    setBusy(false);
    if (!r) return;
    setSaved(r);
    setStep(5);
  };
  useEffect(() => (saved && me ? realtime.subscribe(`user:${me.id}`, (e, d) => { if (e === 'mailbox.progress' && d.accountId === saved.id) setProgress(d); }) : undefined), [saved, me]);

  const failed = run?.steps.find((x) => x.status === 'error');
  const backTo = failed ? (['login'].includes(failed.key) || (failed.key === 'smtp' && /Passwort/.test(failed.text)) ? 3 : 2) : null;
  const canNext = step === 1 ? emailOk && name.trim().length > 0 : step === 2 ? Boolean(s.imapHost && s.smtpHost && s.username) : step === 3 ? (authKind === 'password' ? Boolean(password || account?.authKind === 'password') : Boolean(ticket || account?.authKind === authKind)) : false;

  const footer = (
    <>
      {step > 1 && step < 5 && <button className="btn" disabled={busy} onClick={() => { if (poll.current) clearTimeout(poll.current); setStep(step === 4 ? 3 : step - 1); }}>Zurück</button>}
      <span className="grow" />
      {step < 5 && <button className="btn ghost" onClick={onClose}>Abbrechen</button>}
      {step === 1 && <button className="btn primary" disabled={!canNext || busy} onClick={detect}>{busy ? 'Suche Einstellungen …' : 'Weiter'}</button>}
      {step === 2 && <button className="btn primary" disabled={!canNext} onClick={() => setStep(3)}>Weiter</button>}
      {step === 3 && <button className="btn primary" disabled={!canNext} onClick={startTest}>Verbindung testen</button>}
      {step === 4 && run?.done && <>
        <button className="btn" onClick={startTest}><Icon name="refresh" /> Erneut testen</button>
        {failed ? <button className="btn primary" onClick={() => setStep(backTo!)}>Zu Schritt {backTo} – korrigieren</button>
          : <button className="btn primary" disabled={busy} onClick={save}>{account ? 'Übernehmen' : 'Konto speichern'}</button>}
      </>}
      {step === 5 && <button className="btn primary" onClick={() => onDone(saved!)}>Fertig</button>}
    </>
  );

  return (
    <Modal size="lg" title={account ? `Zugangsdaten prüfen – ${account.email}` : 'E-Mail-Konto einrichten'} onClose={onClose} footer={footer}>
      <div className="wiz-steps">{TITLES.map((t, i) => <span key={t} className={`wiz-step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}><b>{i + 1}</b> {t}</span>)}</div>

      {step === 1 && <>
        <p className="muted">Geben Sie die Adresse ein. Der Assistent sucht die passenden Einstellungen und prüft alles mit einer Test-E-Mail, bevor gespeichert wird.</p>
        <Field label="E-Mail-Adresse" required><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="name@firma.de" onKeyDown={(e) => { if (e.key === 'Enter' && canNext) void detect(); }} /></Field>
        <Field label="Anzeigename" required hint="Ihr Name, wie er bei Empfängern erscheint"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Vorname Nachname" /></Field>
        {hasAccounts && <Field label="Bezeichnung (wahlweise)" hint="z. B. „Info-Postfach“ – hilft beim Umschalten"><input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>}
        <div className="card flat sender-preview"><span className="small muted">So sehen Empfänger Sie:</span> <b>{senderLine(name, email.trim())}</b></div>
      </>}

      {step === 2 && <>
        {note && <div className="card flat" style={{ marginBottom: 10 }}><Icon name="check-circle" /> {note}</div>}
        <Field label="Anbieter">
          <select value={providerId} onChange={(e) => chooseProvider(e.target.value)}>
            <option value="" disabled>bitte wählen</option>
            {catalog?.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {provider?.hint && <div className="hint" style={{ marginBottom: 8 }}>{provider.hint} {provider.helpUrl && <a href={provider.helpUrl} target="_blank" rel="noreferrer">Anleitung des Anbieters</a>}</div>}
        {provider?.needsHost && provider.id !== 'custom' && !manual && (
          <Field label="Servername" required hint={provider.id === 'netcup' ? 'aus dem netcup-Kundenbereich, z. B. mx2f12.netcup.net' : 'aus dem Kundenbereich Ihres Anbieters'}>
            <input value={s.imapHost} onChange={(e) => setS({ ...s, imapHost: e.target.value.trim(), smtpHost: e.target.value.trim() })} placeholder="mx….netcup.net" />
          </Field>
        )}
        {!manual && <div className="small muted">Eingehende Post: {s.imapHost || '–'} : {s.imapPort} · Ausgehende Post: {s.smtpHost || '–'} : {s.smtpPort} · Benutzername: {s.username || '–'}</div>}
        <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setManual(!manual)}><Icon name="sliders" /> {manual ? 'Einfache Ansicht' : 'Selbst eintragen'}</button>
        {manual && <ServerFields s={s} onChange={setS} />}
      </>}

      {step === 3 && <>
        {provider?.oauth && (
          <div className="card flat" style={{ marginBottom: 12 }}>
            {oauthReady ? <>
              <button className="btn primary" onClick={async () => { try { const t = await oauthPopup(provider.oauth!, email.trim()); setTicket(t); setAuthKind(provider.oauth!); toast(`Angemeldet als ${t.email}`); } catch (e) { toast((e as Error).message, 'error'); } }}>
                <Icon name="key" /> Mit {provider.oauth === 'microsoft' ? 'Microsoft' : 'Google'} anmelden
              </button>
              {ticket && <span style={{ marginLeft: 10 }}><Icon name="check-circle" /> Angemeldet als {ticket.email}</span>}
              {account?.authKind === provider.oauth && !ticket && <span className="small muted" style={{ marginLeft: 10 }}>Bisherige Anmeldung wird verwendet.</span>}
            </> : <div className="small"><Icon name="info" /> Die Anmeldung mit {provider.oauth === 'microsoft' ? 'Microsoft' : 'Google'} hat der Administrator noch nicht eingerichtet (Einstellungen → E-Mail-Anmeldung). {provider.oauth === 'google' ? 'Bis dahin geht es mit einem App-Passwort.' : 'Bis dahin klappt es nur, wenn Ihr Unternehmen die Passwort-Anmeldung bei Microsoft noch erlaubt.'}</div>}
            {oauthReady && <div className="small muted" style={{ marginTop: 8 }}>oder mit Passwort: <button className="btn ghost sm" onClick={() => { setAuthKind('password'); setTicket(null); }}>Passwort verwenden</button></div>}
          </div>
        )}
        {authKind === 'password' && <>
          <Field label="Benutzername" hint="meist die vollständige E-Mail-Adresse"><input value={s.username} onChange={(e) => setS({ ...s, username: e.target.value })} autoComplete="off" /></Field>
          <Field label={account?.authKind === 'password' ? 'Passwort (leer = unverändert)' : 'Passwort'} required={!account}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && canNext) void startTest(); }} />
          </Field>
          {provider?.hint && <div className="hint">{provider.hint}</div>}
        </>}
        <Field label="Zusätzliche Test-E-Mail an (wahlweise)" hint="z. B. eine private Adresse – prüft auch den Weg nach außen"><input type="email" value={extraTo} onChange={(e) => setExtraTo(e.target.value)} /></Field>
        <div className="hint">Das Passwort wird verschlüsselt gespeichert.</div>
      </>}

      {step === 4 && <>
        <TestSteps steps={run?.steps ?? TEST_PLACEHOLDER} />
        {run?.changes.map((c) => <div key={c} className="small"><Icon name="info" /> {c}</div>)}
        {run?.done && run.folders.length > 0 && (
          <details open={run.steps.some((x) => x.key === 'folders' && x.status === 'warn')} style={{ marginTop: 10 }}>
            <summary>Ordner zuordnen</summary>
            <FolderMap folders={run.folders.map((f) => f.path)} value={folderMap} onChange={setFolderMap} />
          </details>
        )}
        {run?.done && !failed && <div className="card flat sender-preview" style={{ marginTop: 10 }}><span className="small muted">So sehen Empfänger Sie:</span> <b>{senderLine(name, email.trim())}</b></div>}
      </>}

      {step === 5 && <>
        <h3 style={{ marginTop: 0 }}><Icon name="check-circle" /> {account ? 'Übernommen' : 'Postfach ist eingerichtet'}</h3>
        <p>Die E-Mails werden jetzt abgerufen{progress ? `: Ordner ${progress.done} von ${progress.total}, ${progress.fetched === 1 ? '1 E-Mail' : `${progress.fetched} E-Mails`} geladen` : ' …'}.</p>
        {progress && <div className="progress"><div style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>}
        {!account && <p className="muted">Tipp: Legen Sie gleich eine Signatur an – im Postfach links unter <b>Signaturen</b>.</p>}
      </>}
    </Modal>
  );
}

/** Liste der Prüfschritte mit Ergebnis und Tipp */
export function TestSteps({ steps }: { steps: Step[] }) {
  return (
    <div className="wiz-checks">
      {steps.map((x) => {
        const [ico, color] = STEP_ICON[x.status];
        return (
          <div key={x.key} className={`wiz-check ${x.status}`}>
            <span style={{ color }} className={x.status === 'running' ? 'spin' : ''}><Icon name={ico} /></span>
            <div className="grow">
              <div style={{ fontWeight: 550 }}>{x.label}</div>
              {x.text && <div className="small">{x.text}</div>}
              {x.tip && <div className="small muted"><b>Was Sie tun können:</b> {x.tip}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Test starten und bis zum Ende abfragen */
export function useMailTest() {
  const [run, setRun] = useState<Run | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const start = async (body: Record<string, unknown>) => {
    if (timer.current) clearTimeout(timer.current);
    setRun({ id: '', done: false, ok: false, steps: TEST_PLACEHOLDER, settings: body as unknown as ServerSettings, folderMap: {}, folders: [], changes: [] });
    const r = await post<{ id: string }>('/mailbox/setup/test', body);
    const tick = async () => {
      const x = await get<Run>(`/mailbox/setup/test/${r.id}`);
      setRun(x);
      if (!x.done) timer.current = window.setTimeout(() => void tick(), 700);
    };
    await tick();
  };
  return { run, start };
}

export const TEST_PLACEHOLDER: Step[] = ['Server für eingehende Post erreichbar', 'Anmeldung klappt', 'Ordner gefunden', 'Server für ausgehende Post erreichbar, Anmeldung klappt', 'Test-E-Mail verschickt', 'Test-E-Mail angekommen']
  .map((label, i) => ({ key: String(i), label, status: 'pending', text: '', tip: '' }));

function ServerFields({ s, onChange }: { s: ServerSettings; onChange: (s: ServerSettings) => void }) {
  const n = (k: keyof ServerSettings) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...s, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div style={{ marginTop: 8 }}>
      <h3>Eingehende Post (IMAP)</h3>
      <div className="grid2" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
        <Field label="Server"><input value={s.imapHost} onChange={n('imapHost')} placeholder="imap.firma.de" /></Field>
        <Field label="Anschluss" hint="993 = SSL, 143 = STARTTLS"><input type="number" value={s.imapPort} onChange={n('imapPort')} /></Field>
        <Field label="Verschlüsselung"><label className="row"><input type="checkbox" checked={s.imapSecure} onChange={n('imapSecure')} /> SSL/TLS</label></Field>
      </div>
      <h3>Ausgehende Post (SMTP)</h3>
      <div className="grid2" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
        <Field label="Server"><input value={s.smtpHost} onChange={n('smtpHost')} placeholder="smtp.firma.de" /></Field>
        <Field label="Anschluss" hint="465 = SSL, 587 = STARTTLS"><input type="number" value={s.smtpPort} onChange={n('smtpPort')} /></Field>
        <Field label="Verschlüsselung"><label className="row"><input type="checkbox" checked={s.smtpSecure} onChange={n('smtpSecure')} /> SSL/TLS</label></Field>
      </div>
      <Field label="Benutzername"><input value={s.username} onChange={n('username')} autoComplete="off" /></Field>
    </div>
  );
}

function FolderMap({ folders, value, onChange }: { folders: string[]; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <div className="grid2" style={{ marginTop: 8 }}>
      {FOLDER_ROLES.map(([k, label]) => (
        <Field key={k} label={label}>
          <select value={value[k] ?? ''} onChange={(e) => onChange({ ...value, [k]: e.target.value })}>
            <option value="">– keiner –</option>
            {folders.filter((f) => f.toUpperCase() !== 'INBOX').map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
      ))}
    </div>
  );
}

/** Einstellungen eines Postfachs: Name, Signaturen, Ordner, Verlauf */
export function AccountSettings({ account, onClose, onChanged, onSignatures }: { account: MailAccount; onClose: () => void; onChanged: () => void; onSignatures: () => void }) {
  const act = useAction();
  const [tab, setTab] = useState<'general' | 'folders' | 'events'>('general');
  const [d, setD] = useState({ displayName: account.displayName, label: account.label, sigNew: account.sigNew, sigReply: account.sigReply });
  const [map, setMap] = useState<Record<string, string>>(account.folderMap ?? {});
  const [wizard, setWizard] = useState(false);
  const [remove, setRemove] = useState(false);
  const { data: sigs } = useApi<SignatureData>(`/mailbox/signatures?accountId=${account.id}`);
  const { data: folders } = useApi<{ path: string }[]>(tab === 'folders' ? `/mailbox/folders?accountId=${account.id}` : null);
  const { data: events } = useApi<{ at: string; level: string; text: string }[]>(tab === 'events' ? `/mailbox/accounts/${account.id}/events` : null);
  const mandatory = sigs?.company?.mode === 'mandatory';
  const sigOptions = useMemo(() => [
    ['', sigs?.company ? 'Automatisch (Firmen-Signatur)' : 'Automatisch (erste eigene)'], ['none', 'keine'],
    ...(sigs?.company ? [['company', 'Firmen-Signatur']] : []), ...(sigs?.items.map((x) => [x.id, x.name]) ?? []),
  ] as [string, string][], [sigs]);
  const save = async () => {
    const r = await act(() => patch(`/mailbox/accounts/${account.id}`, { ...d, folderMap: map }), 'Postfach gespeichert');
    if (r) { onChanged(); onClose(); }
  };
  return (
    <Modal size="lg" title={`Postfach – ${account.label || account.email}`} onClose={onClose} footer={<>
      <button className="btn danger" onClick={() => setRemove(true)}>Postfach entfernen</button>
      <button className="btn" onClick={() => setWizard(true)}><Icon name="refresh" /> Verbindung testen / Zugangsdaten ändern</button>
      <span className="grow" />
      <button className="btn ghost" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.displayName.trim()} onClick={save}>Speichern</button>
    </>}>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'general', label: 'Allgemein' }, { id: 'folders', label: 'Ordner' }, { id: 'events', label: 'Verlauf' }]} />
      {tab === 'general' && <>
        {account.lastError && <div className="card flat warn-box"><Icon name="alert" /> {account.lastError}</div>}
        <div className="grid2">
          <Field label="Anzeigename" required hint="so sehen Empfänger Sie"><input value={d.displayName} onChange={(e) => setD({ ...d, displayName: e.target.value })} /></Field>
          <Field label="Bezeichnung (wahlweise)"><input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} placeholder="z. B. Info-Postfach" /></Field>
        </div>
        <div className="card flat sender-preview"><span className="small muted">So sehen Empfänger Sie:</span> <b>{senderLine(d.displayName, account.email)}</b></div>
        <h3>Signaturen</h3>
        {mandatory ? <div className="hint">Ihr Unternehmen gibt eine einheitliche Firmen-Signatur vor. Sie wird immer verwendet.</div> : (
          <div className="grid2">
            <Field label="Für neue E-Mails"><select value={d.sigNew} onChange={(e) => setD({ ...d, sigNew: e.target.value })}>{sigOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Für Antworten und Weiterleitungen"><select value={d.sigReply} onChange={(e) => setD({ ...d, sigReply: e.target.value })}>{sigOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          </div>
        )}
        <button className="btn ghost sm" onClick={onSignatures}><Icon name="signature" /> Signaturen bearbeiten</button>
        <h3>Verbindung</h3>
        <div className="small muted">
          {account.authKind === 'password' ? `Anmeldung mit Passwort als ${account.username}` : `Anmeldung über ${account.authKind === 'microsoft' ? 'Microsoft' : 'Google'} als ${account.username}`}<br />
          Eingehende Post: {account.imapHost}:{account.imapPort} · Ausgehende Post: {account.smtpHost}:{account.smtpPort}<br />
          {account.lastSyncAt ? `Zuletzt abgerufen: ${fmtDateTime(account.lastSyncAt)}` : 'Noch nicht abgerufen'}
          {account.primary && <> · <Pill tone="accent">Hauptpostfach</Pill></>}
        </div>
        {!account.primary && <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={async () => { if (await act(() => patch(`/mailbox/accounts/${account.id}`, { primary: true }), 'Ist jetzt das Hauptpostfach')) onChanged(); }}>Als Hauptpostfach festlegen</button>}
      </>}
      {tab === 'folders' && <>
        <p className="muted">Welcher Ordner auf dem Server ist welcher? Normalerweise erkennt AperioPlan das selbst. Falls nicht – zum Beispiel, wenn keine Kopie in „Gesendet“ landet – hier zuordnen.</p>
        {folders ? <FolderMap folders={folders.map((f) => f.path)} value={map} onChange={setMap} /> : null}
      </>}
      {tab === 'events' && (
        <div className="mail-events">
          {!events?.length && <div className="muted">Noch keine Einträge.</div>}
          {events?.map((e, i) => <div key={i} className={`mail-event ${e.level}`}><span className="small muted">{fmtDateTime(e.at)}</span> <span>{e.text}</span></div>)}
        </div>
      )}
      {wizard && <MailSetupWizard account={account} onClose={() => setWizard(false)} onDone={() => { setWizard(false); onChanged(); onClose(); }} />}
      {remove && <Confirm danger text="Postfach entfernen? Die zwischengespeicherten Nachrichten werden in AperioPlan gelöscht; im Postfach beim Anbieter bleibt alles erhalten. Projekten zugeordnete E-Mails bleiben im Projekt." onClose={() => setRemove(false)}
        onConfirm={async () => { if (await act(() => del(`/mailbox/accounts/${account.id}`), 'Postfach entfernt')) { onChanged(); onClose(); } }} />}
    </Modal>
  );
}
