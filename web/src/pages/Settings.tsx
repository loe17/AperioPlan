import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import { APP_VERSION, PROJECT_MODULES, ROLES, TOOLS, TOOL_LABELS, NUMBER_TOKENS, formatNumberPattern, validateNumberPattern, TASK_STATUSES } from '@aperio/shared';
import { useApi, rememberedTab, rememberTab } from '../lib/hooks';
import { api, del, get, patch, post, put, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useSession, useCan } from '../session';
import { CalendarSyncSettings } from './CalendarSync';
import { CalcRatesSettings } from '../modules/Calculations';
import { TimeRulesSettings } from './SettingsTime';
import { useT, LANGUAGES } from '../i18n';
import { fmtDateTime } from '../lib/format';
import { Avatar, Confirm, Empty, Field, Modal, Pill, useAction } from '../components/ui';
import { ChangePasswordPage } from './Auth';
import { AuditView } from '../modules/AuditView';
import { MODULE_LABELS } from '../modules/ProjectSettings';
import { PhoneSettings } from './SettingsPhone';
import { CadMaskSettings, BackupSettings, UpdateSettings, MailSettings, AiSettings, HolidaySettings, StorageSettings, ExtensionSettings, ResourcesSettings } from './SettingsExtra';
import { EntityIcon, Icon, IconPicker } from '../components/Icon';
import { DocumentTemplateSettings } from '../modules/Documents';
import { NotificationPrefs, Profile, ROLE_LABEL, Security } from './SettingsPersonal';


function SettingsNav({ to, children }: { to: string; children: ReactNode }) {
  return <NavLink to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>{children}</NavLink>;
}

export default function SettingsPage() {
  const t = useT();
  const { me } = useSession();
  const can = useCan();
  useCrumbs([{ label: `${t('Einstellungen')}` }]);
  const admin = me?.role === 'admin';
  const loc = useLocation();
  useEffect(() => { if (loc.pathname.startsWith('/settings/')) rememberTab('settings', loc.pathname); }, [loc.pathname]);
  const last = rememberedTab('settings');
  return (
    <div className="page wide" style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
      <div style={{ width: 220, flex: 'none', position: 'sticky', top: 0 }}>
        <div className="nav-title">Persönlich</div>
        <SettingsNav to="/settings/profile"><Icon name="user" /> {t('Profil')}</SettingsNav>
        <SettingsNav to="/settings/security"><Icon name="shield" /> Sicherheit</SettingsNav>
        <SettingsNav to="/settings/notifications"><Icon name="bell" /> Benachrichtigungen</SettingsNav>
        {can('calendar') && <SettingsNav to="/settings/calendar"><Icon name="calendar" /> Kalender verbinden</SettingsNav>}
        <SettingsNav to="/settings/tokens"><Icon name="key" /> API-Schlüssel</SettingsNav>
        {admin && <>
          <div className="nav-title" style={{ marginTop: 14 }}>{t('Administration')}</div>
          <SettingsNav to="/settings/users"><Icon name="users" /> {t('Benutzer')}</SettingsNav>
          <SettingsNav to="/settings/teams"><Icon name="building" /> Abteilungen &amp; Teams</SettingsNav>
          <SettingsNav to="/settings/general"><Icon name="settings" /> Allgemein & Nummern</SettingsNav>
          <SettingsNav to="/settings/storage"><Icon name="hdd" /> Speicherorte</SettingsNav>
          <SettingsNav to="/settings/templates"><Icon name="file-text" /> Dokumentvorlagen</SettingsNav>
          <SettingsNav to="/settings/cad"><Icon name="cad" /> {t('Speichermaske')} (CAD)</SettingsNav>
          <SettingsNav to="/settings/resources"><Icon name="car" /> Ressourcen</SettingsNav>
          <SettingsNav to="/settings/calc"><Icon name="euro" /> Kalkulationssätze</SettingsNav>
          <SettingsNav to="/settings/time"><Icon name="timer" /> Zeiterfassung &amp; Regeln</SettingsNav>
          <SettingsNav to="/settings/holidays"><Icon name="holiday" /> Feiertage</SettingsNav>
          <SettingsNav to="/settings/ldap"><Icon name="building" /> {t('Firmen-Login')} (LDAP)</SettingsNav>
          <SettingsNav to="/settings/mail"><Icon name="mail" /> E-Mail-Versand (System)</SettingsNav>
          {can('phone') && <SettingsNav to="/settings/phone"><Icon name="phone" /> Telefonie</SettingsNav>}
          <SettingsNav to="/settings/ai"><Icon name="sparkles" /> KI-Anbindung</SettingsNav>
          <SettingsNav to="/settings/extensions"><Icon name="assembly" /> Erweiterungen</SettingsNav>
          <SettingsNav to="/settings/backup"><Icon name="archive" /> {t('Sicherung')}</SettingsNav>
          <SettingsNav to="/settings/update"><Icon name="upload" /> {t('Aktualisierung')}</SettingsNav>
          <SettingsNav to="/settings/audit"><Icon name="history" /> {t('Änderungsprotokoll')}</SettingsNav>
        </>}
        <div className="small muted" style={{ marginTop: 16, padding: '0 8px' }}>{t('Version')} {APP_VERSION}</div>
      </div>
      <div className="grow" style={{ maxWidth: 1000 }}>
        <Routes>
          <Route index element={<Navigate to={last && last !== '/settings' ? last : '/settings/profile'} replace />} />
          <Route path="profile" element={<Profile />} />
          <Route path="tokens" element={<Tokens />} />
          <Route path="security" element={<Security />} />
          <Route path="notifications" element={<NotificationPrefs />} />
          <Route path="calendar" element={<CalendarSyncSettings />} />
          {admin && <>
            <Route path="users" element={<Users />} />
            <Route path="templates" element={<DocumentTemplateSettings />} />
            <Route path="teams" element={<Teams />} />
            <Route path="general" element={<General />} />
            <Route path="storage" element={<StorageSettings />} />
            <Route path="cad" element={<CadMaskSettings />} />
            <Route path="holidays" element={<HolidaySettings />} />
            <Route path="time" element={<TimeRulesSettings />} />
            <Route path="resources" element={<ResourcesSettings />} />
            <Route path="calc" element={<CalcRatesSettings />} />
            <Route path="ldap" element={<Ldap />} />
            <Route path="mail" element={<MailSettings />} />
            <Route path="ai" element={<AiSettings />} />
            <Route path="phone" element={<PhoneSettings />} />
            <Route path="backup" element={<BackupSettings />} />
            <Route path="extensions" element={<ExtensionSettings />} />
            <Route path="update" element={<UpdateSettings />} />
            <Route path="audit" element={<><h1 style={{ marginBottom: 16 }}>{t('Änderungsprotokoll')}</h1><AuditView /></>} />
          </>}
          <Route path="*" element={<Navigate to="/settings/profile" replace />} />
        </Routes>
      </div>
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
      <p className="muted">Für den CAD-Wächter, das Hilfsprogramm zur Fernsteuerung im Videoanruf und für eigene Erweiterungen. Ein Schlüssel handelt mit Ihren Rechten.</p>
      <div className="row" style={{ margin: '14px 0' }}>
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
        <button className="btn primary" onClick={async () => { const r = await act(() => post('/me/tokens', { name })); if (r) { setCreated(r.token); reload(); } }}>Schlüssel erzeugen</button>
      </div>
      {created && <div className="card" style={{ borderColor: 'var(--green)', marginBottom: 14 }}>
        <b>Neuer Schlüssel – nur jetzt sichtbar:</b><div className="mono" style={{ wordBreak: 'break-all', margin: '6px 0' }}>{created}</div>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(created)}>Kopieren</button>
      </div>}
      {!data?.length ? <Empty icon="key" title="Keine Schlüssel" /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Erstellt</th><th>Zuletzt benutzt</th><th /></tr></thead><tbody>
          {data.map((k) => <tr key={k.id}><td>{k.name}</td><td>{fmtDateTime(k.createdAt)}</td><td>{fmtDateTime(k.lastUsedAt)}</td>
            <td><button className="btn sm danger" onClick={async () => { await del(`/me/tokens/${k.id}`); reload(); }}>Widerrufen</button></td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}

function ToolChecks({ value, onChange, inheritLabel, inherited }: { value: string[] | null; onChange: (v: string[] | null) => void; inheritLabel?: string; inherited?: string[] | null }) {
  const custom = value !== null;
  const effective = value ?? inherited ?? [...TOOLS];
  const { me } = useSession();
  // nur Anwendungen zeigen, die im App-Store installiert sind
  const shown = TOOLS.filter((t) => me?.tools?.includes(t));
  return (
    <div>
      {inheritLabel && <label className="row small" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={!custom} onChange={(e) => onChange(e.target.checked ? null : [...effective])} /> {inheritLabel}
      </label>}
      <div className="tool-grid">
        {shown.map((tool) => (
          <label key={tool} className={`row small ${!custom && inheritLabel ? 'muted' : ''}`} style={{ gap: 6 }}>
            <input type="checkbox" disabled={!custom && Boolean(inheritLabel)} checked={effective.includes(tool)}
              onChange={(e) => onChange(e.target.checked ? [...effective, tool] : effective.filter((x) => x !== tool))} />
            {TOOL_LABELS[tool]}
          </label>
        ))}
      </div>
      <div className="hint">Weitere Anwendungen schalten Sie im <a href="/apps">App-Store</a> ein.</div>
    </div>
  );
}

function Users() {
  const t = useT();
  const act = useAction();
  const { refreshLists, teams, me } = useSession();
  const { data, reload } = useApi<any[]>('/users');
  const [edit, setEdit] = useState<any | null>(null);
  const [remove, setRemove] = useState<any | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const [q, setQ] = useState('');
  const dept = teams.find((x) => x.id === edit?.departmentId);
  const rows = (data ?? []).filter((u) => !q || `${u.displayName} ${u.username} ${u.departmentName ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="page-head"><h1>{t('Benutzer')}</h1><div className="actions">
        <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <button className="btn primary" onClick={() => setEdit({ username: '', displayName: '', email: '', phone: '', role: 'member', password: '', vacationDaysPerYear: 30, active: true, teamIds: [], departmentId: '', tools: null })}><Icon name="plus" /> Benutzer anlegen</button>
      </div></div>
      {!teams.length && <div className="hint" style={{ marginBottom: 12 }}><Icon name="info" /> Bitte zuerst unter <b>Abteilungen &amp; Teams</b> mindestens eine Abteilung anlegen – jeder Benutzer gehört zu einer Abteilung.</div>}
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Name</th><th>Benutzername</th><th>Abteilung</th><th>Rolle</th><th>Anmeldung</th><th>Zuletzt angemeldet</th><th>Status</th></tr></thead>
        <tbody>{rows.map((u) => (
          <tr key={u.id} className="click" onClick={() => setEdit({ ...u, password: '', departmentId: u.departmentId ?? '' })}>
            <td><span className="row" style={{ gap: 6 }}><Avatar id={u.id} name={u.displayName} />{u.displayName}</span></td>
            <td className="mono">{u.username}</td>
            <td>{u.departmentName ?? (u.role === 'guest' ? <span className="muted">–</span> : <Pill tone="amber">fehlt</Pill>)}</td>
            <td>{ROLE_LABEL[u.role]}</td><td>{u.authSource === 'ldap' ? 'Firmenkonto' : 'lokal'}{u.totpEnabled && <span title="Zwei-Faktor-Anmeldung aktiv"> <Icon name="shield" size={14} /></span>}</td>
            <td className="small">{fmtDateTime(u.lastLoginAt)}</td>
            <td>{u.active ? (u.mustChangePassword ? <Pill tone="amber">Passwort ändern</Pill> : <Pill tone="green">aktiv</Pill>) : <Pill tone="red">deaktiviert</Pill>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {edit && (
        <Modal size="lg" title={edit.id ? 'Benutzer bearbeiten' : 'Benutzer anlegen'} onClose={() => setEdit(null)} footer={<>
          {edit.id && edit.id !== me!.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => { setRemove(edit); setTransferTo(''); }}><Icon name="trash" /> Löschen …</button>}
          <button className="btn" onClick={() => setEdit(null)}>{t('Abbrechen')}</button>
          <button className="btn primary" onClick={async () => {
            const body = { displayName: edit.displayName, email: edit.email || null, phone: edit.phone ?? '', role: edit.role, vacationDaysPerYear: Number(edit.vacationDaysPerYear),
              departmentId: edit.departmentId || null, tools: edit.tools, ...(edit.password ? { password: edit.password } : {}) };
            const ok = await act(() => (edit.id ? patch(`/users/${edit.id}`, { ...body, active: edit.active }) : post('/users', { ...body, username: edit.username, password: edit.password, teamIds: edit.teamIds })), edit.id ? 'Benutzer gespeichert' : 'Benutzer angelegt');
            if (ok) { setEdit(null); reload(); refreshLists(); }
          }}>{t('Speichern')}</button>
        </>}>
          <div className="grid2">
            <Field label="Benutzername" required><input value={edit.username} disabled={Boolean(edit.id)} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></Field>
            <Field label="Anzeigename" required><input value={edit.displayName} onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} /></Field>
            <Field label="E-Mail"><input value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Telefon"><input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Abteilung" required={edit.role !== 'guest'} hint="Der Benutzer wird automatisch Mitglied dieses Teams">
              <select value={edit.departmentId} onChange={(e) => setEdit({ ...edit, departmentId: e.target.value })}>
                <option value="">– bitte wählen –</option>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
              </select>
            </Field>
            <Field label="Rolle"><select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
            <Field label={edit.id ? 'Neues Startpasswort' : 'Startpasswort'} required={!edit.id} hint="Muss bei der nächsten Anmeldung geändert werden">
              <input type="text" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} disabled={edit.authSource === 'ldap'} />
            </Field>
            <Field label="Urlaubstage pro Jahr"><input type="number" value={edit.vacationDaysPerYear} onChange={(e) => setEdit({ ...edit, vacationDaysPerYear: e.target.value })} /></Field>
          </div>
          {edit.role !== 'admin' && edit.role !== 'guest' && <Field label="Werkzeuge">
            <ToolChecks value={edit.tools ?? null} onChange={(tools) => setEdit({ ...edit, tools })} inherited={dept?.defaultTools ?? null}
              inheritLabel={`Wie die Abteilung${dept ? ` „${dept.name}“` : ''} (Voreinstellung)`} />
          </Field>}
          {edit.role === 'admin' && <div className="hint" style={{ marginBottom: 10 }}>Administratoren haben immer Zugriff auf alle Werkzeuge.</div>}
          {edit.id && <div className="row" style={{ gap: 16 }}>
            <label className="row"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Konto aktiv</label>
            {edit.totpEnabled && <button className="btn sm" onClick={async () => { if (await act(() => del(`/users/${edit.id}/2fa`), 'Zwei-Faktor-Anmeldung zurückgesetzt')) { setEdit({ ...edit, totpEnabled: false }); reload(); } }}><Icon name="shield" /> Zwei-Faktor zurücksetzen</button>}
          </div>}
          {edit.id && <VacationAdjust userId={edit.id} />}
        </Modal>
      )}
      {remove && (
        <Modal title={`${remove.displayName} löschen`} onClose={() => setRemove(null)} footer={<>
          <button className="btn" onClick={() => setRemove(null)}>Abbrechen</button>
          <button className="btn danger solid" onClick={async () => {
            const r = await act(() => api(`/users/${remove.id}`, { method: 'DELETE', body: { transferTo: transferTo || null } }), 'Benutzer gelöscht');
            if (r) { setRemove(null); setEdit(null); reload(); refreshLists(); }
          }}>Endgültig löschen</button>
        </>}>
          <p style={{ marginTop: 0 }}>Gelöscht werden Anmeldung, Passwort, Profilbild, private Notizen und persönliche Einstellungen. <b>Erhalten bleiben</b> Nachrichten, Kommentare, Zeiten, Projekteinträge und das Änderungsprotokoll – dort steht weiter der Name mit dem Zusatz „(gelöscht)“.</p>
          <Field label="Offene Aufgaben und Projektleitungen übertragen an" hint="Ohne Auswahl sind offene Aufgaben danach niemandem zugewiesen">
            <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
              <option value="">– niemandem –</option>{(data ?? []).filter((u) => u.id !== remove.id && u.active).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
          </Field>
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
      <div className="page-head"><h1>{t('Teams')}</h1><div className="actions"><button className="btn primary" onClick={() => setEdit({ name: '', icon: 'team', description: '', parentId: null, members: [] })}>＋ Team anlegen</button></div></div>
      {!teams.length && <Empty icon="building" title="Noch keine Teams">Legen Sie Abteilungen wie Konstruktion, Elektrotechnik oder Einkauf an.</Empty>}
      <div className="card-grid">
        {teams.map((tm) => (
          <div key={tm.id} className="card click" onClick={() => setEdit({ ...tm })}>
            <div className="card-title"><EntityIcon value={tm.icon} size={20} fallback="team" /><h3>{tm.name}</h3></div>
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
            const body = { name: edit.name, icon: edit.icon, description: edit.description, parentId: edit.parentId || null, defaultTools: edit.defaultTools ?? null, shortCode: edit.shortCode ?? '' };
            const r = await act(() => (edit.id ? patch(`/teams/${edit.id}`, body).then(() => ({ id: edit.id })) : post('/teams', body)));
            if (!r) return;
            await act(() => put(`/teams/${r.id}/members`, { members: edit.members.map((m: any) => ({ userId: m.userId, isLead: m.isLead })) }));
            setEdit(null); refreshLists();
          }}>{t('Speichern')}</button>
        </>}>
          <div className="grid2">
            <Field label="Name" required><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Symbol"><IconPicker value={edit.icon} onChange={(icon) => setEdit({ ...edit, icon })} /></Field>
          </div>
          <div className="grid2">
            <Field label="Beschreibung"><input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <Field label="Kürzel" hint="für Projektnummern mit {TEAM}, z. B. KON"><input value={edit.shortCode ?? ''} maxLength={10} onChange={(e) => setEdit({ ...edit, shortCode: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() })} /></Field>
          </div>
          <Field label="Werkzeuge für Mitglieder dieser Abteilung (Voreinstellung)" hint="Gilt für alle, deren Werkzeuge nicht einzeln festgelegt sind">
            <ToolChecks value={edit.defaultTools ?? null} onChange={(defaultTools) => setEdit({ ...edit, defaultTools })} inheritLabel="Alle Werkzeuge" />
          </Field>
          <Field label="Übergeordnetes Team"><select value={edit.parentId ?? ''} onChange={(e) => setEdit({ ...edit, parentId: e.target.value || null })}><option value="">–</option>{teams.filter((x) => x.id !== edit.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
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
  return { value, setValue, reload: load, save: (v: any) => put(`/settings/${key}`, v).then(() => { invalidate('/settings'); return load(); }) };
}

function General() {
  const act = useAction();
  const { refreshLists } = useSession();
  const company = useAdminSettings('company');
  const numbers = useAdminSettings('projectNumbers');
  const modules = useAdminSettings('defaultModules');
  const time = useAdminSettings('time');
  const presence = useAdminSettings('presence');
  const kanban = useAdminSettings('kanbanTemplate');
  const nums = useAdminSettings('numbers');
  const letter = useAdminSettings('letterhead');
  if (!nums.value || !letter.value) return null;
  if (!company.value || !numbers.value || !modules.value || !time.value || !presence.value || !kanban.value) return null;
  const n = numbers.value;
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
      <ProjectNumberEditor value={n} onChange={numbers.setValue} />
      <button className="btn primary" onClick={async () => { await act(() => numbers.save(n), 'Gespeichert'); refreshLists(); }}>Speichern</button>
      <div className="hint" style={{ marginTop: 6 }}>Bereits vergebene Nummern bleiben unverändert.</div>

      <h2 style={{ margin: '28px 0 10px' }}>Weitere Nummernkreise</h2>
      <p className="muted">Gleiche Bausteine wie bei Projekten. Mit Jahr ({'{JJJJ}'} oder {'{JJ}'}) beginnt die Zählung jedes Jahr neu.</p>
      <div className="grid2">
        {([['customer', 'Kunden'], ['supplier', 'Lieferanten'], ['quote', 'Angebote'], ['case', 'Reklamationen'], ['order', 'Bestellungen'], ['calculation', 'Kalkulationen']] as const).map(([k, l]) => (
          <Field key={k} label={l} hint={validateNumberPattern(nums.value[k] ?? '') ?? `z. B. ${formatNumberPattern(nums.value[k] ?? '', 42, { customer: 'K0042' })}`}>
            <input className="mono" value={nums.value[k] ?? ''} onChange={(e) => nums.setValue({ ...nums.value, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <button className="btn primary" onClick={() => act(() => nums.save(nums.value), 'Gespeichert')}>Speichern</button>

      <h2 style={{ margin: '28px 0 10px' }}>Briefkopf für Angebote und Bestellungen</h2>
      <div className="grid2">
        <Field label="Anschrift der Firma" hint="erscheint klein über der Empfängeradresse"><textarea rows={3} value={letter.value.address} onChange={(e) => letter.setValue({ ...letter.value, address: e.target.value })} placeholder={'Muster GmbH\nIndustriestr. 1\n78120 Furtwangen'} /></Field>
        <Field label="Fußzeile" hint="z. B. Bank, Handelsregister, Geschäftsführer"><textarea rows={3} value={letter.value.footer} onChange={(e) => letter.setValue({ ...letter.value, footer: e.target.value })} /></Field>
        <Field label="Mehrwertsteuer (%)"><input type="number" value={letter.value.vatRate} onChange={(e) => letter.setValue({ ...letter.value, vatRate: Number(e.target.value) })} /></Field>
        <Field label="Angebote gültig (Tage)"><input type="number" value={letter.value.quoteValidityDays} onChange={(e) => letter.setValue({ ...letter.value, quoteValidityDays: Number(e.target.value) })} /></Field>
        <Field label="Zahlungsbedingungen (Standard)"><input value={letter.value.paymentTerms} onChange={(e) => letter.setValue({ ...letter.value, paymentTerms: e.target.value })} /></Field>
      </div>
      <Field label="Einleitung im Angebot"><textarea rows={2} value={letter.value.quoteIntro} onChange={(e) => letter.setValue({ ...letter.value, quoteIntro: e.target.value })} /></Field>
      <Field label="Schlusstext im Angebot"><textarea rows={2} value={letter.value.quoteOutro} onChange={(e) => letter.setValue({ ...letter.value, quoteOutro: e.target.value })} /></Field>
      <button className="btn primary" onClick={() => act(() => letter.save(letter.value), 'Gespeichert')}>Speichern</button>

      <h2 style={{ margin: '28px 0 10px' }}>Standard-Werkzeuge für neue Projekte</h2>
      <div className="row wrap">
        {PROJECT_MODULES.map((m) => (
          <label key={m} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={modules.value.includes(m)} onChange={() => modules.setValue(modules.value.includes(m) ? modules.value.filter((x: string) => x !== m) : [...modules.value, m])} />
            <Icon name={MODULE_LABELS[m]?.icon ?? 'square'} /> {MODULE_LABELS[m]?.label}
          </label>
        ))}
      </div>
      <div className="spacer" />
      <button className="btn primary" onClick={async () => { await act(() => modules.save(modules.value), 'Gespeichert'); refreshLists(); }}>Speichern</button>

      <h2 style={{ margin: '28px 0 10px' }}>Eigene Kanban-Spalten für neue Projekte</h2>
      <p className="muted">Diese Spalten bekommt jedes neue Projekt zusätzlich zu den vier Grundspalten. Jede gehört zu einer Stufe.</p>
      {kanban.value.map((c: any, i: number) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          <input type="color" value={c.color} onChange={(e) => kanban.setValue(kanban.value.map((x: any, j: number) => (j === i ? { ...x, color: e.target.value } : x)))} style={{ width: 40, padding: 2 }} />
          <input value={c.name} placeholder="Name der Spalte" onChange={(e) => kanban.setValue(kanban.value.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <select value={c.baseStatus} style={{ width: 'auto' }} onChange={(e) => kanban.setValue(kanban.value.map((x: any, j: number) => (j === i ? { ...x, baseStatus: e.target.value } : x)))}>
            {TASK_STATUSES.map((st) => <option key={st} value={st}>gehört zu: {({ todo: 'Zu erledigen', in_progress: 'In Arbeit', review: 'Prüfung', done: 'Fertig' } as Record<string, string>)[st]}</option>)}
          </select>
          <button className="btn ghost sm" title="Entfernen" onClick={() => kanban.setValue(kanban.value.filter((_: any, j: number) => j !== i))}><Icon name="x" /></button>
        </div>
      ))}
      <div className="row">
        <button className="btn" onClick={() => kanban.setValue([...kanban.value, { name: '', color: '#f59e0b', baseStatus: 'in_progress' }])}><Icon name="plus" /> Spalte</button>
        <button className="btn primary" onClick={() => act(() => kanban.save(kanban.value.filter((c: any) => c.name.trim())), 'Gespeichert')}>Speichern</button>
      </div>

      <h2 style={{ margin: '28px 0 10px' }}>Anwesenheit im Chat</h2>
      <p className="muted">Grün = aktiv, Orange = eine Weile keine Eingabe, Rot = abwesend (Urlaub oder von Hand gewählt).</p>
      <div className="grid2">
        <Field label="Orange nach Minuten ohne Eingabe" hint="Standard: 10"><input type="number" min={1} max={240} value={presence.value.idleMinutes} onChange={(e) => presence.setValue({ ...presence.value, idleMinutes: Number(e.target.value) })} /></Field>
      </div>
      <button className="btn primary" onClick={async () => { await act(() => presence.save(presence.value), 'Gespeichert'); refreshLists(); }}>Speichern</button>
    </div>
  );
}

/** Nummernformat: fest (fortlaufend, mit Jahr) oder frei aus Bausteinen */
function ProjectNumberEditor({ value: n, onChange }: { value: any; onChange: (v: any) => void }) {
  const year = new Date().getFullYear();
  const example = (seq: number) => n.format === 'pattern' ? formatNumberPattern(n.pattern || '', seq, { year, team: 'KON', customer: 'K0042' })
    : n.format === 'year' ? `${n.prefix}-${year}-${String(seq).padStart(n.digits, '0')}` : String(seq).padStart(n.digits, '0');
  const first = n.format === 'pattern' ? n.start ?? 1 : n.format === 'year' ? 1 : n.step;
  const err = n.format === 'pattern' ? validateNumberPattern(n.pattern || '') : null;
  const sub = (i: number) => n.subStyle === 'digits' ? String(i + 1).padStart(2, '0') : String.fromCharCode(65 + i);
  return (
    <div>
      <div className="grid2">
        <Field label="Format"><select value={n.format} onChange={(e) => onChange({ ...n, format: e.target.value })}>
          <option value="sequential">Fortlaufend (0100, 0200, …)</option><option value="year">Mit Jahreszahl (PRJ-2026-0042)</option><option value="pattern">Eigenes Muster aus Bausteinen</option>
        </select></Field>
        <Field label="Teilprojekte"><select value={n.subStyle ?? 'letters'} onChange={(e) => onChange({ ...n, subStyle: e.target.value })}>
          <option value="letters">mit Buchstaben (…-A, …-B)</option><option value="digits">mit Ziffern (…-01, …-02)</option>
        </select></Field>
        {n.format === 'pattern' ? <>
          <Field label="Muster" hint="Bausteine anklicken oder eintippen"><input className="mono" value={n.pattern ?? ''} onChange={(e) => onChange({ ...n, pattern: e.target.value })} placeholder="PRJ-{JJ}{NNN}" /></Field>
          <Field label="Startwert"><input type="number" min={0} value={n.start ?? 1} onChange={(e) => onChange({ ...n, start: Number(e.target.value) })} /></Field>
          <Field label="Schrittweite"><input type="number" min={1} value={n.step} onChange={(e) => onChange({ ...n, step: Number(e.target.value) })} /></Field>
          <Field label="Zählung"><label className="row"><input type="checkbox" checked={Boolean(n.yearlyReset)} onChange={(e) => onChange({ ...n, yearlyReset: e.target.checked })} /> jedes Jahr wieder beim Startwert beginnen</label></Field>
        </> : <>
          <Field label="Stellen"><input type="number" min={3} max={6} value={n.digits} onChange={(e) => onChange({ ...n, digits: Number(e.target.value) })} /></Field>
          {n.format === 'year' ? <Field label="Präfix"><input value={n.prefix} onChange={(e) => onChange({ ...n, prefix: e.target.value })} /></Field>
            : <Field label="Schrittweite" hint="100 ergibt 0100, 0200, 0300 …"><input type="number" min={1} value={n.step} onChange={(e) => onChange({ ...n, step: Number(e.target.value) })} /></Field>}
        </>}
      </div>
      {n.format === 'pattern' && (
        <div className="token-list">
          {NUMBER_TOKENS.map((tk) => <button key={tk.token} type="button" className="btn sm" title={tk.label} onClick={() => onChange({ ...n, pattern: `${n.pattern ?? ''}${tk.token}` })}><span className="mono">{tk.token}</span> <span className="muted small">{tk.label}</span></button>)}
        </div>
      )}
      {err ? <div className="error-text">{err}</div> : (
        <div className="card" style={{ margin: '8px 0 12px' }}>
          <div className="small muted">Beispiel</div>
          <div className="mono">{example(first)}  ·  {example(first + (n.format === 'sequential' ? n.step : n.step || 1))}  ·  Teilprojekt {example(first)}-{sub(0)}</div>
          {n.format === 'pattern' && /\{(TEAM|KUNDE)\}/.test(n.pattern ?? '') && <div className="small muted" style={{ marginTop: 4 }}>{'{TEAM}'} = Kürzel der Abteilung des Projekts (unter Abteilungen &amp; Teams), {'{KUNDE}'} = Kundennummer</div>}
        </div>
      )}
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
