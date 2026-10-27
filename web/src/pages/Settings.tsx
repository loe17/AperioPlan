import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { APP_VERSION, PROJECT_MODULES, ROLES } from '@aperio/shared';
import { useApi } from '../lib/hooks';
import { del, get, patch, post, put, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { useT, LANGUAGES } from '../i18n';
import { fmtDateTime } from '../lib/format';
import { Avatar, Confirm, Empty, Field, Modal, Pill, useAction } from '../components/ui';
import { ChangePasswordPage } from './Auth';
import { AuditView } from '../modules/AuditView';
import { MODULE_LABELS } from '../modules/ProjectSettings';
import { CadMaskSettings, BackupSettings, UpdateSettings, MailSettings, AiSettings, HolidaySettings, StorageSettings, ExtensionSettings } from './SettingsExtra';

const ROLE_LABEL: Record<string, string> = { admin: 'Administrator', teamlead: 'Teamleitung', member: 'Mitarbeiter', guest: 'Gast' };

function SettingsNav({ to, children }: { to: string; children: ReactNode }) {
  return <NavLink to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>{children}</NavLink>;
}

export default function SettingsPage() {
  const t = useT();
  const { me } = useSession();
  useCrumbs([{ label: `⚙️ ${t('Einstellungen')}` }]);
  const admin = me?.role === 'admin';
  return (
    <div className="page wide" style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
      <div style={{ width: 220, flex: 'none', position: 'sticky', top: 0 }}>
        <div className="nav-title">Persönlich</div>
        <SettingsNav to="/settings/profile">👤 {t('Profil')}</SettingsNav>
        <SettingsNav to="/settings/tokens">🔑 API-Schlüssel</SettingsNav>
        {admin && <>
          <div className="nav-title" style={{ marginTop: 14 }}>{t('Administration')}</div>
          <SettingsNav to="/settings/users">👥 {t('Benutzer')}</SettingsNav>
          <SettingsNav to="/settings/teams">🏢 {t('Teams')}</SettingsNav>
          <SettingsNav to="/settings/general">🧭 Allgemein & Nummern</SettingsNav>
          <SettingsNav to="/settings/storage">💾 Speicherorte</SettingsNav>
          <SettingsNav to="/settings/cad">📐 {t('Speichermaske')} (CAD)</SettingsNav>
          <SettingsNav to="/settings/holidays">🎌 Feiertage</SettingsNav>
          <SettingsNav to="/settings/ldap">🏛️ {t('Firmen-Login')} (LDAP)</SettingsNav>
          <SettingsNav to="/settings/mail">✉️ E-Mail-Konto</SettingsNav>
          <SettingsNav to="/settings/ai">🤖 KI-Anbindung</SettingsNav>
          <SettingsNav to="/settings/extensions">🧩 Erweiterungen</SettingsNav>
          <SettingsNav to="/settings/backup">🗄️ {t('Sicherung')}</SettingsNav>
          <SettingsNav to="/settings/update">⬆️ {t('Aktualisierung')}</SettingsNav>
          <SettingsNav to="/settings/audit">📜 {t('Änderungsprotokoll')}</SettingsNav>
        </>}
        <div className="small muted" style={{ marginTop: 16, padding: '0 8px' }}>{t('Version')} {APP_VERSION}</div>
      </div>
      <div className="grow" style={{ maxWidth: 1000 }}>
        <Routes>
          <Route index element={<Navigate to="/settings/profile" replace />} />
          <Route path="profile" element={<Profile />} />
          <Route path="tokens" element={<Tokens />} />
          {admin && <>
            <Route path="users" element={<Users />} />
            <Route path="teams" element={<Teams />} />
            <Route path="general" element={<General />} />
            <Route path="storage" element={<StorageSettings />} />
            <Route path="cad" element={<CadMaskSettings />} />
            <Route path="holidays" element={<HolidaySettings />} />
            <Route path="ldap" element={<Ldap />} />
            <Route path="mail" element={<MailSettings />} />
            <Route path="ai" element={<AiSettings />} />
            <Route path="backup" element={<BackupSettings />} />
            <Route path="extensions" element={<ExtensionSettings />} />
            <Route path="update" element={<UpdateSettings />} />
            <Route path="audit" element={<><h1 style={{ marginBottom: 16 }}>{t('Änderungsprotokoll')}</h1><AuditView /></>} />
          </>}
        </Routes>
      </div>
    </div>
  );
}

function Profile() {
  const t = useT();
  const act = useAction();
  const { me, refresh, theme, setTheme } = useSession();
  const [name, setName] = useState(me!.displayName);
  const [email, setEmail] = useState(me!.email ?? '');
  return (
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ marginBottom: 16 }}>{t('Profil')}</h1>
      <div className="row" style={{ marginBottom: 16 }}><Avatar id={me!.id} name={me!.displayName} size="lg" /><div><b>{me!.username}</b><div className="small muted">{ROLE_LABEL[me!.role]} · {me!.authSource === 'ldap' ? 'Firmenkonto' : 'lokales Konto'}</div></div></div>
      <Field label="Anzeigename"><input value={name} onChange={(e) => setName(e.target.value)} disabled={me!.authSource === 'ldap'} /></Field>
      <Field label="E-Mail"><input value={email} onChange={(e) => setEmail(e.target.value)} disabled={me!.authSource === 'ldap'} /></Field>
      <div className="grid2">
        <Field label={t('Sprache')}>
          <select value={me!.locale} onChange={async (e) => { await patch('/me', { locale: e.target.value }); await refresh(); }}>
            {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label={t('Farbschema')}>
          <select value={theme} onChange={(e) => setTheme(e.target.value as 'system')}>
            <option value="system">{t('Wie System')}</option><option value="light">{t('Hellmodus')}</option><option value="dark">{t('Dunkelmodus')}</option>
          </select>
        </Field>
      </div>
      <button className="btn primary" onClick={async () => { await act(() => patch('/me', { displayName: name, email: email || null }), 'Gespeichert'); await refresh(); }}>{t('Speichern')}</button>
      {me!.authSource === 'local' && <>
        <h2 style={{ margin: '28px 0 12px' }}>{t('Passwort ändern')}</h2>
        <ChangePasswordPage onDone={() => alert('Passwort geändert')} />
      </>}
    </div>
  );
}

function Tokens() {
  const act = useAction();
  const { data, reload } = useApi<any[]>('/me/tokens');
  const [name, setName] = useState('CAD-Wächter');
  const [created, setCreated] = useState<string | null>(null);
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>API-Schlüssel</h1>
      <p className="muted">Für den CAD-Wächter in SolidWorks und für eigene Erweiterungen. Ein Schlüssel handelt mit Ihren Rechten.</p>
      <div className="row" style={{ margin: '14px 0' }}>
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
        <button className="btn primary" onClick={async () => { const r = await act(() => post('/me/tokens', { name })); if (r) { setCreated(r.token); reload(); } }}>Schlüssel erzeugen</button>
      </div>
      {created && <div className="card" style={{ borderColor: 'var(--green)', marginBottom: 14 }}>
        <b>Neuer Schlüssel – nur jetzt sichtbar:</b><div className="mono" style={{ wordBreak: 'break-all', margin: '6px 0' }}>{created}</div>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(created)}>Kopieren</button>
      </div>}
      {!data?.length ? <Empty icon="🔑" title="Keine Schlüssel" /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Erstellt</th><th>Zuletzt benutzt</th><th /></tr></thead><tbody>
          {data.map((k) => <tr key={k.id}><td>{k.name}</td><td>{fmtDateTime(k.createdAt)}</td><td>{fmtDateTime(k.lastUsedAt)}</td>
            <td><button className="btn sm danger" onClick={async () => { await del(`/me/tokens/${k.id}`); reload(); }}>Widerrufen</button></td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}

function Users() {
  const t = useT();
  const act = useAction();
  const { refreshLists, teams } = useSession();
  const { data, reload } = useApi<any[]>('/users');
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <div className="page-head"><h1>{t('Benutzer')}</h1><div className="actions"><button className="btn primary" onClick={() => setEdit({ username: '', displayName: '', email: '', role: 'member', password: '', vacationDaysPerYear: 30, active: true, teamIds: [] })}>＋ Benutzer anlegen</button></div></div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Name</th><th>Benutzername</th><th>Rolle</th><th>Anmeldung</th><th>Urlaub/Jahr</th><th>Zuletzt angemeldet</th><th>Status</th></tr></thead>
        <tbody>{data?.map((u) => (
          <tr key={u.id} className="click" onClick={() => setEdit({ ...u, password: '' })}>
            <td><span className="row" style={{ gap: 6 }}><Avatar id={u.id} name={u.displayName} />{u.displayName}</span></td>
            <td className="mono">{u.username}</td><td>{ROLE_LABEL[u.role]}</td><td>{u.authSource === 'ldap' ? 'Firmenkonto' : 'lokal'}</td>
            <td>{u.vacationDaysPerYear}</td><td className="small">{fmtDateTime(u.lastLoginAt)}</td>
            <td>{u.active ? (u.mustChangePassword ? <Pill tone="amber">Passwort ändern</Pill> : <Pill tone="green">aktiv</Pill>) : <Pill tone="red">deaktiviert</Pill>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {edit && (
        <Modal title={edit.id ? 'Benutzer bearbeiten' : 'Benutzer anlegen'} onClose={() => setEdit(null)} footer={<>
          <button className="btn" onClick={() => setEdit(null)}>{t('Abbrechen')}</button>
          <button className="btn primary" onClick={async () => {
            const body = { displayName: edit.displayName, email: edit.email || null, role: edit.role, vacationDaysPerYear: Number(edit.vacationDaysPerYear), ...(edit.password ? { password: edit.password } : {}) };
            const ok = await act(() => (edit.id ? patch(`/users/${edit.id}`, { ...body, active: edit.active }) : post('/users', { ...body, username: edit.username, password: edit.password, teamIds: edit.teamIds })), 'Gespeichert');
            if (ok) { setEdit(null); reload(); refreshLists(); }
          }}>{t('Speichern')}</button>
        </>}>
          <div className="grid2">
            <Field label="Benutzername" required><input value={edit.username} disabled={Boolean(edit.id)} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></Field>
            <Field label="Anzeigename" required><input value={edit.displayName} onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} /></Field>
            <Field label="E-Mail"><input value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Rolle"><select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
            <Field label={edit.id ? 'Neues Startpasswort' : 'Startpasswort'} required={!edit.id} hint="Muss bei der nächsten Anmeldung geändert werden">
              <input type="text" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} disabled={edit.authSource === 'ldap'} />
            </Field>
            <Field label="Urlaubstage pro Jahr"><input type="number" value={edit.vacationDaysPerYear} onChange={(e) => setEdit({ ...edit, vacationDaysPerYear: e.target.value })} /></Field>
          </div>
          {!edit.id && <Field label="Teams"><div className="row wrap">{teams.map((tm) => (
            <label key={tm.id} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={edit.teamIds.includes(tm.id)} onChange={() => setEdit({ ...edit, teamIds: edit.teamIds.includes(tm.id) ? edit.teamIds.filter((x: string) => x !== tm.id) : [...edit.teamIds, tm.id] })} />{tm.icon} {tm.name}</label>
          ))}</div></Field>}
          {edit.id && <label className="row"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Konto aktiv</label>}
          {edit.id && <VacationAdjust userId={edit.id} />}
        </Modal>
      )}
    </div>
  );
}

function Teams() {
  const t = useT();
  const act = useAction();
  const { teams, users, refreshLists } = useSession();
  const [edit, setEdit] = useState<any | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  return (
    <div>
      <div className="page-head"><h1>{t('Teams')}</h1><div className="actions"><button className="btn primary" onClick={() => setEdit({ name: '', icon: '👥', description: '', parentId: null, members: [] })}>＋ Team anlegen</button></div></div>
      {!teams.length && <Empty icon="🏢" title="Noch keine Teams">Legen Sie Abteilungen wie Konstruktion, Elektrotechnik oder Einkauf an.</Empty>}
      <div className="card-grid">
        {teams.map((tm) => (
          <div key={tm.id} className="card click" onClick={() => setEdit({ ...tm })}>
            <div className="card-title"><span style={{ fontSize: 20 }}>{tm.icon}</span><h3>{tm.name}</h3></div>
            <div className="small muted">{tm.description}</div>
            <div className="row wrap" style={{ marginTop: 8, gap: 4 }}>{tm.members.map((m) => <Avatar key={m.userId} id={m.userId} name={m.displayName} />)}</div>
          </div>
        ))}
      </div>
      {edit && (
        <Modal title={edit.id ? 'Team bearbeiten' : 'Team anlegen'} onClose={() => setEdit(null)} footer={<>
          {edit.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setDelId(edit.id)}>{t('Löschen')}</button>}
          <button className="btn" onClick={() => setEdit(null)}>{t('Abbrechen')}</button>
          <button className="btn primary" onClick={async () => {
            const body = { name: edit.name, icon: edit.icon, description: edit.description, parentId: edit.parentId || null };
            const r = await act(() => (edit.id ? patch(`/teams/${edit.id}`, body).then(() => ({ id: edit.id })) : post('/teams', body)));
            if (!r) return;
            await act(() => put(`/teams/${r.id}/members`, { members: edit.members.map((m: any) => ({ userId: m.userId, isLead: m.isLead })) }));
            setEdit(null); refreshLists();
          }}>{t('Speichern')}</button>
        </>}>
          <div className="grid2">
            <Field label="Name" required><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Symbol"><input value={edit.icon} onChange={(e) => setEdit({ ...edit, icon: e.target.value })} maxLength={4} /></Field>
          </div>
          <Field label="Beschreibung"><input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <Field label="Übergeordnetes Team"><select value={edit.parentId ?? ''} onChange={(e) => setEdit({ ...edit, parentId: e.target.value || null })}><option value="">–</option>{teams.filter((x) => x.id !== edit.id).map((x) => <option key={x.id} value={x.id}>{x.icon} {x.name}</option>)}</select></Field>
          <Field label="Mitglieder">
            <div className="card flat" style={{ padding: 6, maxHeight: 240, overflow: 'auto' }}>
              {users.map((u) => {
                const m = edit.members.find((x: any) => x.userId === u.id);
                return (
                  <div key={u.id} className="row" style={{ padding: '3px 4px' }}>
                    <input type="checkbox" checked={Boolean(m)} onChange={() => setEdit({ ...edit, members: m ? edit.members.filter((x: any) => x.userId !== u.id) : [...edit.members, { userId: u.id, isLead: false, displayName: u.displayName }] })} />
                    <span className="grow">{u.displayName}</span>
                    {m && <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={m.isLead} onChange={() => setEdit({ ...edit, members: edit.members.map((x: any) => (x.userId === u.id ? { ...x, isLead: !x.isLead } : x)) })} />Teamleitung</label>}
                  </div>
                );
              })}
            </div>
          </Field>
        </Modal>
      )}
      {delId && <Confirm danger text="Team löschen? Projekte bleiben erhalten." onClose={() => setDelId(null)} onConfirm={async () => { await del(`/teams/${delId}`); setEdit(null); refreshLists(); }} />}
    </div>
  );
}

export function useAdminSettings<K extends string>(key: K) {
  const [value, setValue] = useState<any>(null);
  const load = () => get('/settings').then((s) => setValue(s[key]));
  useEffect(() => { void load(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { value, setValue, save: (v: any) => put(`/settings/${key}`, v).then(() => { invalidate('/settings'); return load(); }) };
}

function General() {
  const act = useAction();
  const { refreshLists } = useSession();
  const company = useAdminSettings('company');
  const numbers = useAdminSettings('projectNumbers');
  const modules = useAdminSettings('defaultModules');
  const time = useAdminSettings('time');
  if (!company.value || !numbers.value || !modules.value || !time.value) return null;
  const n = numbers.value;
  const preview = n.format === 'year' ? `${n.prefix}-${new Date().getFullYear()}-${'1'.padStart(n.digits, '0')}` : String(n.step).padStart(n.digits, '0');
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 16 }}>Allgemein & Nummern</h1>
      <h2 style={{ marginBottom: 10 }}>Firma</h2>
      <div className="grid2">
        <Field label="Firmenname"><input value={company.value.name} onChange={(e) => company.setValue({ ...company.value, name: e.target.value })} /></Field>
        <Field label="Text neben dem Logo"><input value={company.value.logoText} onChange={(e) => company.setValue({ ...company.value, logoText: e.target.value })} /></Field>
      </div>
      <button className="btn primary" onClick={async () => { await act(() => company.save(company.value), 'Gespeichert'); refreshLists(); }}>Speichern</button>

      <h2 style={{ margin: '28px 0 10px' }}>Projektnummern</h2>
      <div className="grid2">
        <Field label="Format"><select value={n.format} onChange={(e) => numbers.setValue({ ...n, format: e.target.value })}><option value="sequential">Fortlaufend (0100, 0200, …)</option><option value="year">Mit Jahreszahl (PRJ-2026-0042)</option></select></Field>
        <Field label="Stellen"><input type="number" min={3} max={6} value={n.digits} onChange={(e) => numbers.setValue({ ...n, digits: Number(e.target.value) })} /></Field>
        {n.format === 'year' ? <Field label="Präfix"><input value={n.prefix} onChange={(e) => numbers.setValue({ ...n, prefix: e.target.value })} /></Field>
          : <Field label="Schrittweite" hint="100 ergibt 0100, 0200, 0300 …"><input type="number" min={1} value={n.step} onChange={(e) => numbers.setValue({ ...n, step: Number(e.target.value) })} /></Field>}
        <Field label="Vorschau"><div className="mono" style={{ padding: '6px 0' }}>{preview}  ·  Teilprojekt {preview}-A  ·  Dokument {preview}-DOK-001</div></Field>
      </div>
      <button className="btn primary" onClick={async () => { await act(() => numbers.save(n), 'Gespeichert'); refreshLists(); }}>Speichern</button>

      <h2 style={{ margin: '28px 0 10px' }}>Standard-Werkzeuge für neue Projekte</h2>
      <div className="row wrap">
        {PROJECT_MODULES.map((m) => (
          <label key={m} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={modules.value.includes(m)} onChange={() => modules.setValue(modules.value.includes(m) ? modules.value.filter((x: string) => x !== m) : [...modules.value, m])} />
            {MODULE_LABELS[m]?.icon} {MODULE_LABELS[m]?.label}
          </label>
        ))}
      </div>
      <div className="spacer" />
      <button className="btn primary" onClick={async () => { await act(() => modules.save(modules.value), 'Gespeichert'); refreshLists(); }}>Speichern</button>

      <h2 style={{ margin: '28px 0 10px' }}>Zeiterfassung</h2>
      <div className="grid2">
        <Field label="Runden auf Minuten" hint="1 = minutengenau"><input type="number" min={1} max={60} value={time.value.roundMinutes} onChange={(e) => time.setValue({ ...time.value, roundMinutes: Number(e.target.value) })} /></Field>
        <Field label="Warnung ab Stunden pro Tag"><input type="number" min={1} max={24} value={time.value.maxDailyHours} onChange={(e) => time.setValue({ ...time.value, maxDailyHours: Number(e.target.value) })} /></Field>
      </div>
      <button className="btn primary" onClick={async () => { await act(() => time.save(time.value), 'Gespeichert'); refreshLists(); }}>Speichern</button>
    </div>
  );
}

function Ldap() {
  const act = useAction();
  const s = useAdminSettings('ldap');
  const [result, setResult] = useState<string | null>(null);
  if (!s.value) return null;
  const v = s.value;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => s.setValue({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>Firmen-Login (Active Directory / LDAP)</h1>
      <p className="muted">Mitarbeiter melden sich mit ihren gewohnten Windows-Zugangsdaten an. Beim ersten Login wird automatisch ein Konto angelegt.</p>
      <label className="row" style={{ margin: '12px 0' }}><input type="checkbox" checked={v.enabled} onChange={set('enabled')} /> Firmen-Login aktivieren</label>
      <div className="grid2">
        <Field label="Server-Adresse" hint="z. B. ldaps://dc01.firma.local:636"><input value={v.url} onChange={set('url')} /></Field>
        <Field label="Basis-DN" hint="z. B. DC=firma,DC=local"><input value={v.baseDn} onChange={set('baseDn')} /></Field>
        <Field label="Dienstkonto (Bind-DN)"><input value={v.bindDn} onChange={set('bindDn')} /></Field>
        <Field label="Passwort Dienstkonto"><input type="password" value={v.bindPassword} onChange={set('bindPassword')} /></Field>
        <Field label="Suchfilter" hint="{{username}} wird ersetzt"><input value={v.userFilter} onChange={set('userFilter')} className="mono" /></Field>
        <Field label="Attribut Anzeigename"><input value={v.displayNameAttr} onChange={set('displayNameAttr')} /></Field>
        <Field label="Attribut E-Mail"><input value={v.emailAttr} onChange={set('emailAttr')} /></Field>
        <Field label="Gruppe → Administrator (DN)"><input value={v.adminGroupDn} onChange={set('adminGroupDn')} /></Field>
        <Field label="Gruppe → Teamleitung (DN)"><input value={v.teamleadGroupDn} onChange={set('teamleadGroupDn')} /></Field>
      </div>
      <label className="row" style={{ marginBottom: 12 }}><input type="checkbox" checked={v.tlsRejectUnauthorized} onChange={set('tlsRejectUnauthorized')} /> Zertifikat des Servers prüfen</label>
      <div className="row">
        <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
        <button className="btn" onClick={async () => { const r = await act(() => post('/settings/ldap/test', v)); if (r) setResult(r.message); }}>Verbindung testen</button>
      </div>
      {result && <div className="card" style={{ marginTop: 12 }}>{result}</div>}
    </div>
  );
}

/** Resturlaub aus dem Vorjahr, Sonderurlaub oder Korrekturen buchen */
function VacationAdjust({ userId }: { userId: string }) {
  const act = useAction();
  const { data, reload } = useApi<any[]>(`/absences/adjustments?userId=${userId}`);
  const [d, setD] = useState({ year: new Date().getFullYear(), days: '', note: 'Resturlaub Vorjahr' });
  return (
    <div className="card flat" style={{ marginTop: 14 }}>
      <b>Urlaubskonto korrigieren</b>
      {data?.map((a) => <div key={a.id} className="small muted">{a.year}: {a.days > 0 ? '+' : ''}{a.days} Tage – {a.note}</div>)}
      <div className="row" style={{ marginTop: 8 }}>
        <input type="number" style={{ width: 90 }} value={d.year} onChange={(e) => setD({ ...d, year: Number(e.target.value) })} />
        <input type="number" step={0.5} style={{ width: 90 }} placeholder="Tage" value={d.days} onChange={(e) => setD({ ...d, days: e.target.value })} />
        <input value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
        <button className="btn" disabled={!d.days} onClick={async () => { await act(() => post('/absences/adjustments', { userId, year: d.year, days: Number(d.days), note: d.note }), 'Gebucht'); setD({ ...d, days: '' }); reload(); }}>Buchen</button>
      </div>
    </div>
  );
}
