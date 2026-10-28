import { useEffect, useRef, useState } from 'react';
import { del, patch, post, put } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../session';
import { useT, LANGUAGES } from '../i18n';
import { Avatar, Field, Modal, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { ChangePasswordPage } from './Auth';

export const ROLE_LABEL: Record<string, string> = { admin: 'Administrator', teamlead: 'Teamleitung', member: 'Mitarbeiter', guest: 'Gast' };
export const STATUS_MODES: { id: string; label: string; tone: string; hint: string }[] = [
  { id: 'auto', label: 'Automatisch', tone: '', hint: 'grün, wenn aktiv; orange nach einiger Zeit ohne Eingabe; rot bei Abwesenheit' },
  { id: 'online', label: 'Online', tone: 'green', hint: 'immer grün, solange AperioPlan offen ist' },
  { id: 'idle', label: 'Inaktiv', tone: 'amber', hint: 'orange' },
  { id: 'away', label: 'Abwesend', tone: 'red', hint: 'rot – z. B. in einer Besprechung' },
  { id: 'offline', label: 'Offline anzeigen', tone: 'grey', hint: 'Kollegen sehen Sie als offline' },
];

/** Bild zuschneiden (rund, 256 × 256) und hochladen */
export function AvatarEditor({ onDone }: { onDone?: () => void }) {
  const { me, refresh, refreshLists } = useSession();
  const act = useAction();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0.5, y: 0.5 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!img || !canvas.current) return;
    const c = canvas.current; const g = c.getContext('2d')!;
    const side = Math.min(img.width, img.height) / zoom;
    const sx = Math.max(0, Math.min(img.width - side, (img.width - side) * pos.x));
    const sy = Math.max(0, Math.min(img.height - side, (img.height - side) * pos.y));
    g.clearRect(0, 0, 256, 256);
    g.drawImage(img, sx, sy, side, side, 0, 0, 256, 256);
  }, [img, zoom, pos]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { const i = new Image(); i.onload = () => { setImg(i); setZoom(1); setPos({ x: 0.5, y: 0.5 }); }; i.src = String(r.result); };
    r.readAsDataURL(f);
  };
  const save = () => canvas.current!.toBlob(async (blob) => {
    if (!blob) return;
    const fd = new FormData(); fd.append('file', blob, 'profilbild.png');
    if (await act(() => post('/me/avatar', fd), 'Profilbild gespeichert')) { setImg(null); await refresh(); await refreshLists(); onDone?.(); }
  }, 'image/png');

  return (
    <div className="row" style={{ alignItems: 'center', gap: 16 }}>
      {img ? <canvas ref={canvas} width={256} height={256} className="avatar-crop" /> : <Avatar id={me!.id} name={me!.displayName} size="xl" />}
      <div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
        {!img ? <div className="row">
          <button className="btn" onClick={() => fileRef.current?.click()}><Icon name="camera" /> Bild wählen</button>
          {me!.hasAvatar && <button className="btn ghost" onClick={async () => { await act(() => del('/me/avatar'), 'Profilbild entfernt'); await refresh(); await refreshLists(); }}>Entfernen</button>}
        </div> : <div style={{ display: 'grid', gap: 6, minWidth: 220 }}>
          <label className="small">Vergrößern <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
          <label className="small">Links/rechts <input type="range" min={0} max={1} step={0.01} value={pos.x} onChange={(e) => setPos({ ...pos, x: Number(e.target.value) })} /></label>
          <label className="small">Oben/unten <input type="range" min={0} max={1} step={0.01} value={pos.y} onChange={(e) => setPos({ ...pos, y: Number(e.target.value) })} /></label>
          <div className="row"><button className="btn primary" onClick={save}>Übernehmen</button><button className="btn" onClick={() => setImg(null)}>Abbrechen</button></div>
        </div>}
      </div>
    </div>
  );
}

export function Profile() {
  const t = useT();
  const act = useAction();
  const { me, refresh, theme, setTheme, teams } = useSession();
  const [d, setD] = useState({ displayName: me!.displayName, email: me!.email ?? '', phone: me!.phone ?? '' });
  const dept = teams.find((x) => x.id === me!.departmentId);
  const ldap = me!.authSource === 'ldap';
  return (
    <div style={{ maxWidth: 620 }}>
      <h1 style={{ marginBottom: 16 }}>{t('Profil')}</h1>
      <div className="card" style={{ marginBottom: 16 }}>
        <AvatarEditor />
        <div className="small muted" style={{ marginTop: 10 }}>{me!.username} · {ROLE_LABEL[me!.role]} · {dept ? `Abteilung ${dept.name}` : 'keine Abteilung'} · {ldap ? 'Firmenkonto' : 'lokales Konto'}</div>
      </div>
      <div className="grid2">
        <Field label="Anzeigename"><input value={d.displayName} onChange={(e) => setD({ ...d, displayName: e.target.value })} disabled={ldap} /></Field>
        <Field label="E-Mail"><input type="email" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} disabled={ldap} /></Field>
        <Field label="Telefon"><input value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} placeholder="z. B. +49 7723 1234-56" /></Field>
      </div>
      <button className="btn primary" onClick={async () => { if (await act(() => patch('/me', { displayName: d.displayName, email: d.email || null, phone: d.phone }), 'Profil gespeichert')) await refresh(); }}>{t('Speichern')}</button>

      <h2 style={{ margin: '28px 0 12px' }}>Darstellung</h2>
      <div className="grid2">
        <Field label={t('Sprache')}>
          <select value={me!.locale} onChange={async (e) => { await act(() => patch('/me', { locale: e.target.value }), 'Sprache gespeichert'); await refresh(); }}>
            {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label={t('Farbschema')}>
          <select value={theme} onChange={(e) => setTheme(e.target.value as 'system')}>
            <option value="system">{t('Wie System')}</option><option value="light">{t('Hellmodus')}</option><option value="dark">{t('Dunkelmodus')}</option>
          </select>
        </Field>
      </div>

      <h2 style={{ margin: '28px 0 12px' }}>Anwesenheit im Chat</h2>
      <PresenceSettings />
    </div>
  );
}

export function PresenceSettings() {
  const { me, refresh } = useSession();
  const act = useAction();
  return (
    <div>
      <div className="presence-modes">
        {STATUS_MODES.map((m) => (
          <label key={m.id} className={`presence-mode ${me!.statusMode === m.id ? 'active' : ''}`}>
            <input type="radio" name="status-mode" checked={me!.statusMode === m.id} onChange={async () => { await act(() => patch('/me', { statusMode: m.id }), `Status: ${m.label}`); await refresh(); }} />
            <span className={`presence-dot ${m.tone || 'auto'}`} /> <b>{m.label}</b> <span className="small muted">{m.hint}</span>
          </label>
        ))}
      </div>
      <label className="row" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={me!.showLastSeen} onChange={async (e) => { await act(() => patch('/me', { showLastSeen: e.target.checked }), 'Gespeichert'); await refresh(); }} />
        „Zuletzt online“ anzeigen <span className="small muted">(wer es ausschaltet, sieht es auch bei anderen nicht)</span>
      </label>
    </div>
  );
}

export function Security() {
  const { me } = useSession();
  return (
    <div style={{ maxWidth: 620 }}>
      <h1 style={{ marginBottom: 16 }}>Sicherheit</h1>
      <h2 style={{ marginBottom: 8 }}>Zwei-Faktor-Anmeldung</h2>
      <TwoFactor />
      {me!.authSource === 'local' && <>
        <h2 style={{ margin: '28px 0 12px' }}>Passwort ändern</h2>
        <ChangePasswordPage onDone={() => undefined} />
      </>}
    </div>
  );
}

export function TwoFactor({ compact }: { compact?: boolean }) {
  const { me, refresh } = useSession();
  const act = useAction();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [off, setOff] = useState(false);
  if (me!.totpEnabled) return (
    <div className="card">
      <div className="row"><Icon name="shield" style={{ color: 'var(--green)' }} /> <b>Eingeschaltet.</b> Bei jeder Anmeldung wird zusätzlich ein Code aus Ihrer Authenticator-App abgefragt.</div>
      <div className="hint" style={{ marginTop: 6 }}>Neues Handy oder App gelöscht? Ein Administrator kann die Zwei-Faktor-Anmeldung zurücksetzen.</div>
      <button className="btn" style={{ marginTop: 10 }} onClick={() => setOff(true)}>Ausschalten …</button>
      {off && <Modal title="Zwei-Faktor-Anmeldung ausschalten" onClose={() => setOff(false)} footer={<>
        <button className="btn" onClick={() => setOff(false)}>Abbrechen</button>
        <button className="btn danger" disabled={code.length < 6} onClick={async () => { if (await act(() => post('/me/2fa/disable', { code }), 'Zwei-Faktor-Anmeldung ausgeschaltet')) { setOff(false); setCode(''); await refresh(); } }}>Ausschalten</button>
      </>}><Field label="Aktueller Code aus der App"><input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /></Field></Modal>}
    </div>
  );
  return (
    <div className={compact ? '' : 'card'}>
      {!setup ? <>
        <p style={{ marginTop: 0 }}>Freiwillig: Zusätzlich zum Passwort wird ein Code aus einer App auf dem Handy abgefragt (z. B. Microsoft Authenticator, Google Authenticator, Aegis). So kommt niemand nur mit dem Passwort in Ihr Konto.</p>
        <button className="btn primary" onClick={async () => { const r = await act(() => post<{ secret: string; qr: string }>('/me/2fa/setup', {})); if (r) setSetup(r); }}><Icon name="shield" /> Einrichten</button>
      </> : <>
        <ol className="steps">
          <li>Authenticator-App auf dem Handy öffnen und „Konto hinzufügen“ bzw. „QR-Code scannen“ wählen.</li>
          <li>Diesen Code scannen:<div className="qr" dangerouslySetInnerHTML={{ __html: setup.qr }} />
            <div className="small muted">Scannen nicht möglich? Schlüssel von Hand eingeben: <span className="mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span></div></li>
          <li>Den 6-stelligen Code aus der App eingeben:
            <div className="row" style={{ marginTop: 6 }}>
              <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ width: 140, fontSize: 18, letterSpacing: 4, textAlign: 'center' }} />
              <button className="btn primary" disabled={code.length !== 6} onClick={async () => { if (await act(() => post('/me/2fa/enable', { code }), 'Zwei-Faktor-Anmeldung eingeschaltet')) { setSetup(null); setCode(''); await refresh(); } }}>Bestätigen</button>
            </div></li>
        </ol>
      </>}
    </div>
  );
}

export function NotificationPrefs() {
  const { data, setData } = useApi<{ kind: string; label: string; app: boolean; mail: boolean }[]>('/me/notify-prefs');
  const { me, settings } = useSession();
  const act = useAction();
  const save = async (rows: NonNullable<typeof data>) => {
    setData(rows);
    await act(() => put('/me/notify-prefs', Object.fromEntries(rows.map((r) => [r.kind, { app: r.app, mail: r.mail }]))));
  };
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>Benachrichtigungen</h1>
      <p className="muted">Wählen Sie, wofür Sie in AperioPlan (Glocke) und per E-Mail benachrichtigt werden.</p>
      {(!me!.email || !settings?.mailEnabled) && <div className="hint" style={{ marginBottom: 10 }}><Icon name="info" /> E-Mails werden nur verschickt, wenn {me!.email ? 'ein E-Mail-Konto für den Versand eingerichtet ist' : 'in Ihrem Profil eine E-Mail-Adresse steht'}.</div>}
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Anlass</th><th style={{ width: 120 }}>In AperioPlan</th><th style={{ width: 100 }}>E-Mail</th></tr></thead>
        <tbody>{data?.map((r, i) => (
          <tr key={r.kind}>
            <td>{r.label}</td>
            <td><input type="checkbox" checked={r.app} onChange={(e) => save(data.map((x, j) => (j === i ? { ...x, app: e.target.checked } : x)))} /></td>
            <td><input type="checkbox" checked={r.mail} onChange={(e) => save(data.map((x, j) => (j === i ? { ...x, mail: e.target.checked } : x)))} /></td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
