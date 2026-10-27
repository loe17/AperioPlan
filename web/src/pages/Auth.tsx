import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { useSession } from '../session';
import { useT } from '../i18n';
import { Field } from '../components/ui';

export function LoginPage() {
  const t = useT();
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ company: string; version: string; ldapEnabled: boolean } | null>(null);
  useEffect(() => { get('/public-info').then(setInfo).catch(() => {}); }, []);

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError('');
        try { await post('/auth/login', { username, password }); await refresh(); }
        catch (err) { setError((err as Error).message); }
        finally { setBusy(false); }
      }}>
        <div className="row" style={{ marginBottom: 20 }}>
          <span className="logo" style={{ width: 36, height: 36, fontSize: 18 }}>A</span>
          <div><h2>{info?.company ?? 'AperioPlan'}</h2><div className="small muted">Projektverwaltung & CAD-Zentrale</div></div>
        </div>
        <Field label={t('Benutzername')}><input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></Field>
        <Field label={t('Passwort')}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        {info?.ldapEnabled && <div className="hint" style={{ marginBottom: 12 }}>Sie können sich mit Ihren gewohnten Windows-/Firmen-Zugangsdaten anmelden.</div>}
        {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !username || !password}>{t('Anmelden')}</button>
        <div className="small muted" style={{ marginTop: 16, textAlign: 'center' }}>Version {info?.version}</div>
      </form>
    </div>
  );
}

export function ChangePasswordPage({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const t = useT();
  const { refresh } = useSession();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const form = (
    <form className={forced ? 'auth-card' : ''} onSubmit={async (e) => {
      e.preventDefault();
      setError('');
      if (pw !== pw2) { setError(t('Die Passwörter stimmen nicht überein')); return; }
      try {
        await post('/auth/change-password', { currentPassword: cur, newPassword: pw });
        await refresh();
        onDone?.();
        setCur(''); setPw(''); setPw2('');
      } catch (err) { setError((err as Error).message); }
    }}>
      {forced && <><h2 style={{ marginBottom: 8 }}>{t('Passwort ändern')}</h2><p className="muted">{t('Bitte vergeben Sie ein neues, sicheres Passwort, bevor Sie fortfahren.')}</p></>}
      <Field label={t('Aktuelles Passwort')}><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" autoFocus={forced} /></Field>
      <Field label={t('Neues Passwort')} hint="Mindestens 8 Zeichen"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
      <Field label={t('Neues Passwort wiederholen')}><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
      {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={!cur || !pw}>{t('Passwort ändern')}</button>
        {forced && <button type="button" className="btn ghost right" onClick={async () => { await post('/auth/logout'); location.href = '/'; }}>{t('Abmelden')}</button>}
      </div>
    </form>
  );
  return forced ? <div className="auth-wrap">{form}</div> : form;
}
