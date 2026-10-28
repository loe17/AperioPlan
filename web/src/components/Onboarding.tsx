import { useEffect, useRef, useState } from 'react';
import { GERMAN_STATES } from '@aperio/shared';
import { get, patch, post, put, invalidate } from '../lib/api';
import { useSession } from '../session';
import { LANGUAGES } from '../i18n';
import { Field, useAction } from './ui';
import { Icon } from './Icon';
import { AvatarEditor, PresenceSettings, TwoFactor } from '../pages/SettingsPersonal';

/**
 * Startassistent beim ersten Anmelden: Profil, Darstellung, Kontakt, Benachrichtigungen, Sicherheit.
 * Beim allerersten Start fragt er den Administrator zusätzlich nach Firma, Bundesland und Projektnummern.
 */
export function Onboarding() {
  const { me, refresh, refreshLists, settings, theme, setTheme, teams } = useSession();
  const act = useAction();
  // einmal festlegen, ob es die Erstinstallation ist – sonst verschwände der Firmenschritt nach dem Speichern
  const latched = useRef<boolean | null>(null);
  if (latched.current === null && settings) latched.current = me!.role === 'admin' && settings.company.name === 'AperioPlan';
  const firstAdmin = latched.current ?? false;
  const steps = [...(firstAdmin ? ['firma'] : []), 'profil', 'darstellung', 'kontakt', 'benachrichtigungen', 'sicherheit'] as const;
  const [i, setI] = useState(0);
  const step = steps[i]!;
  const [name, setName] = useState(me!.displayName);
  const [phone, setPhone] = useState(me!.phone ?? '');
  const [email, setEmail] = useState(me!.email ?? '');
  const [mailNotes, setMailNotes] = useState(true);
  const [firm, setFirm] = useState({ name: '', state: 'BW', numbers: 'sequential' });

  useEffect(() => {
    if (!firstAdmin) return;
    get('/settings').then((s) => setFirm((f) => ({ ...f, state: s.time?.holidayState ?? 'BW', numbers: s.projectNumbers?.format ?? 'sequential' }))).catch(() => {});
  }, [firstAdmin]);

  const finish = async () => {
    await act(() => post('/me/onboarding', {}), 'Willkommen bei AperioPlan!');
    await refresh();
  };
  const next = async () => {
    if (step === 'firma') {
      const s = await get('/settings');
      if (firm.name.trim()) await act(() => put('/settings/company', { ...s.company, name: firm.name.trim() }));
      await act(() => put('/settings/time', { ...s.time, holidayState: firm.state }));
      await act(() => put('/settings/projectNumbers', { ...s.projectNumbers, format: firm.numbers }));
      invalidate('/settings'); await refreshLists();
    }
    if (step === 'profil' && name.trim() && name !== me!.displayName) await act(() => patch('/me', { displayName: name.trim() }));
    if (step === 'kontakt') await act(() => patch('/me', { phone, ...(me!.authSource === 'local' ? { email: email || null } : {}) }));
    if (step === 'benachrichtigungen' && !mailNotes) {
      const prefs = await get<{ kind: string; app: boolean }[]>('/me/notify-prefs');
      await act(() => put('/me/notify-prefs', Object.fromEntries(prefs.map((p) => [p.kind, { app: p.app, mail: false }]))));
    }
    if (i === steps.length - 1) return finish();
    await refresh();
    setI(i + 1);
  };
  const dept = teams.find((t) => t.id === me!.departmentId);
  if (!settings) return null;

  return (
    <div className="onboarding-backdrop">
      <div className="onboarding card">
        <div className="row" style={{ marginBottom: 16 }}>
          <img className="logo" src="/logo-mark.svg" alt="" style={{ width: 32, height: 32 }} />
          <div className="grow"><b>Willkommen bei AperioPlan</b><div className="small muted">Schritt {i + 1} von {steps.length} – jeder Schritt lässt sich überspringen</div></div>
          <button className="btn ghost sm" onClick={finish}>Assistent beenden</button>
        </div>
        <div className="onboarding-dots">{steps.map((s, k) => <span key={s} className={k === i ? 'on' : k < i ? 'done' : ''} />)}</div>

        {step === 'firma' && <>
          <h2>Ihre Firma</h2>
          <p className="muted">Diese Angaben gelten für alle. Sie lassen sich später unter Einstellungen ändern.</p>
          <Field label="Firmenname" hint="erscheint auf der Anmeldeseite und in Dokumenten"><input autoFocus value={firm.name} onChange={(e) => setFirm({ ...firm, name: e.target.value })} placeholder="z. B. Muster Maschinenbau GmbH" /></Field>
          <div className="grid2">
            <Field label="Bundesland (für Feiertage)"><select value={firm.state} onChange={(e) => setFirm({ ...firm, state: e.target.value })}>{Object.entries(GERMAN_STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Projektnummern"><select value={firm.numbers} onChange={(e) => setFirm({ ...firm, numbers: e.target.value })}>
              <option value="sequential">fortlaufend: 0100, 0200 …</option><option value="year">mit Jahr: PRJ-2026-0001 …</option>
            </select></Field>
          </div>
        </>}
        {step === 'profil' && <>
          <h2>Ihr Profil</h2>
          <p className="muted">Mit Bild erkennen Kollegen Sie in Aufgaben und im Chat sofort.</p>
          <AvatarEditor />
          <div style={{ marginTop: 14 }}><Field label="Anzeigename"><input value={name} onChange={(e) => setName(e.target.value)} disabled={me!.authSource === 'ldap'} /></Field></div>
        </>}
        {step === 'darstellung' && <>
          <h2>Darstellung</h2>
          <div className="grid2">
            <Field label="Sprache"><select value={me!.locale} onChange={async (e) => { await patch('/me', { locale: e.target.value }); await refresh(); }}>{Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
            <Field label="Farbschema"><select value={theme} onChange={(e) => setTheme(e.target.value as 'system')}><option value="system">Wie System</option><option value="light">Hell</option><option value="dark">Dunkel</option></select></Field>
          </div>
          <h3 style={{ marginTop: 10 }}>Anwesenheit im Chat</h3>
          <PresenceSettings />
        </>}
        {step === 'kontakt' && <>
          <h2>Kontakt</h2>
          <p className="muted">{dept ? <>Sie gehören zur Abteilung <b>{dept.name}</b>.</> : 'Ihre Abteilung legt der Administrator fest.'}</p>
          <div className="grid2">
            <Field label="Telefon"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+49 …" /></Field>
            <Field label="E-Mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={me!.authSource === 'ldap'} /></Field>
          </div>
        </>}
        {step === 'benachrichtigungen' && <>
          <h2>Benachrichtigungen</h2>
          <p className="muted">Neuigkeiten erscheinen immer an der Glocke oben rechts. Zusätzlich per E-Mail?</p>
          <label className="row"><input type="checkbox" checked={mailNotes} onChange={(e) => setMailNotes(e.target.checked)} /> Wichtiges auch per E-Mail (zugewiesene Aufgaben, Erwähnungen, Urlaub, Termine)</label>
          <div className="hint" style={{ marginTop: 8 }}>Jeden Anlass einzeln einstellen: Einstellungen → Benachrichtigungen.</div>
        </>}
        {step === 'sicherheit' && <>
          <h2>Sicherheit (freiwillig)</h2>
          <TwoFactor compact />
        </>}

        <div className="row" style={{ marginTop: 20 }}>
          {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Zurück</button>}
          <span className="grow" />
          <button className="btn ghost" onClick={() => (i === steps.length - 1 ? finish() : setI(i + 1))}>Überspringen</button>
          <button className="btn primary" onClick={next}>{i === steps.length - 1 ? <><Icon name="check" /> Fertig</> : 'Weiter'}</button>
        </div>
      </div>
    </div>
  );
}
