import { useState } from 'react';
import { useApi } from '../lib/hooks';
import { post, put, patch, invalidate } from '../lib/api';
import { Icon } from '../components/Icon';
import { ResourceLabel } from './Resources';
import { fmtBytes, fmtDate, fmtDateTime } from '../lib/format';
import { Confirm, Modal, Pill } from '../components/ui';
import { del, upload } from '../lib/api';
import { APP_VERSION } from '@aperio/shared';
import { Field, useAction } from '../components/ui';
import { useSession } from '../session';
import { useAdminSettings } from './Settings';


export function StorageSettings() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('storage');
  const [folder, setFolder] = useState('');
  if (!s.value) return null;
  const v = s.value;
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>Speicherorte</h1>
      <p className="muted">Der Speicherort der Projektdateien wird beim Server-Start festgelegt (FILES_PATH in der Datei .env). Dort kann ein lokaler Ordner oder ein eingebundenes Netzlaufwerk (NAS / SMB / Windows-Freigabe) stehen – siehe Administrator-Handbuch.</p>
      <Field label="Art der Ablage">
        <select value={v.mode} onChange={(e) => s.setValue({ ...v, mode: e.target.value })}><option value="local">Lokal auf dem Server</option><option value="network">Netzlaufwerk (NAS / SMB)</option></select>
      </Field>
      <Field label="Netzwerkpfad für den Windows-Explorer" hint="Wird bei jedem Projekt angezeigt, z. B. \\nas01\projekte">
        <input className="mono" value={v.networkPath} onChange={(e) => s.setValue({ ...v, networkPath: e.target.value })} />
      </Field>
      <Field label="Automatische Ordnerstruktur für neue Projekte">
        <div className="card flat" style={{ padding: 8 }}>
          {v.projectFolders.map((f: string, i: number) => (
            <div key={i} className="row" style={{ padding: 2 }}>
              <span className="mono grow">📁 {f}</span>
              <button className="btn ghost sm" onClick={() => s.setValue({ ...v, projectFolders: v.projectFolders.filter((_: string, j: number) => j !== i) })}>✕</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 6 }}>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="z. B. 05_Einkauf" />
            <button className="btn" disabled={!folder.trim()} onClick={() => { s.setValue({ ...v, projectFolders: [...v.projectFolders, folder.trim()] }); setFolder(''); }}>Hinzufügen</button>
          </div>
        </div>
      </Field>
      <button className="btn primary" onClick={async () => { await act(() => s.save(v), 'Gespeichert'); refreshLists(); }}>Speichern</button>
      <ScanWizard />
    </div>
  );
}

/** Scan-Assistent: vorhandene Ordner auf dem Netzlaufwerk als Projekte einbinden */
function ScanWizard() {
  const act = useAction();
  const { teams } = useSession();
  const [path, setPath] = useState('');
  const { data, reload } = useApi<any>(`/storage/scan?path=${encodeURIComponent(path)}`);
  const [imp, setImp] = useState<any | null>(null);
  const [result, setResult] = useState<any | null>(null);
  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ marginBottom: 6 }}>🔎 Bestandsordner einlesen (Scan-Assistent)</h2>
      <p className="muted">Zeigt vorhandene Ordner der Ablage. Nicht zugeordnete Ordner können als Projekt übernommen und dabei normgerecht umbenannt werden (z. B. „4711 Alte Presse“ → „4711_Alte_Presse“).</p>
      <div className="breadcrumbs" style={{ margin: '8px 0' }}>
        <a style={{ cursor: 'pointer' }} onClick={() => setPath('')}>Ablage</a>
        {path.split('/').filter(Boolean).map((c, i, arr) => <span key={i} className="row" style={{ gap: 6 }}><span className="sep">›</span><a style={{ cursor: 'pointer' }} onClick={() => setPath(arr.slice(0, i + 1).join('/'))}>{c}</a></span>)}
      </div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Ordner</th><th>Inhalt</th><th>Geändert</th><th>Zuordnung</th><th /></tr></thead>
        <tbody>
          {data?.entries?.map((e: any) => (
            <tr key={e.path}>
              <td><a style={{ cursor: 'pointer' }} onClick={() => setPath(e.path)}>📁 {e.name}</a></td>
              <td className="small muted">{e.folders} Ordner, {e.files} Dateien</td>
              <td className="small muted">{fmtDate(e.modified)}</td>
              <td>{e.linkedProject ? <Pill tone="green">Projekt {e.linkedProject.number}</Pill> : <Pill tone="amber">nicht zugeordnet</Pill>}</td>
              <td>{!e.linkedProject && <button className="btn sm" onClick={() => setImp({ path: e.path, name: e.suggestion.name, number: e.suggestion.number ?? '', teamId: '', rename: true, createFolders: true, moveToProjects: false })}>Als Projekt übernehmen</button>}</td>
            </tr>
          ))}
          {data?.entries?.length === 0 && <tr><td colSpan={5} className="muted">Keine Unterordner</td></tr>}
        </tbody>
      </table></div>
      {result && <div className="card" style={{ marginTop: 12, borderColor: 'var(--green)' }}>✅ Projekt {result.number} angelegt ({result.files} Dateien übernommen) – Ordner: <span className="mono">{result.folderPath}</span></div>}
      {imp && (
        <Modal title="Bestandsordner übernehmen" onClose={() => setImp(null)} footer={<>
          <button className="btn" onClick={() => setImp(null)}>Abbrechen</button>
          <button className="btn primary" onClick={async () => {
            const r = await act(() => post('/storage/import', { ...imp, number: imp.number || null, teamId: imp.teamId || null }));
            if (r) { setResult(r); setImp(null); reload(); invalidate('/projects'); }
          }}>Übernehmen</button>
        </>}>
          <div className="mono small muted" style={{ marginBottom: 10 }}>{imp.path}</div>
          <div className="grid2">
            <Field label="Projektname" required><input value={imp.name} onChange={(e) => setImp({ ...imp, name: e.target.value })} /></Field>
            <Field label="Projektnummer" hint="leer = automatisch vergeben"><input className="mono" value={imp.number} onChange={(e) => setImp({ ...imp, number: e.target.value })} /></Field>
            <Field label="Team"><select value={imp.teamId} onChange={(e) => setImp({ ...imp, teamId: e.target.value })}><option value="">–</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}</select></Field>
          </div>
          <label className="row"><input type="checkbox" checked={imp.rename} onChange={(e) => setImp({ ...imp, rename: e.target.checked })} /> Ordner normgerecht umbenennen (Nummer_Name)</label>
          <label className="row"><input type="checkbox" checked={imp.createFolders} onChange={(e) => setImp({ ...imp, createFolders: e.target.checked })} /> Fehlende Standardordner anlegen</label>
          <label className="row"><input type="checkbox" checked={imp.moveToProjects} onChange={(e) => setImp({ ...imp, moveToProjects: e.target.checked })} /> In den Bereich „Projekte“ verschieben</label>
        </Modal>
      )}
    </div>
  );
}

const FIELD_TYPES: [string, string][] = [['text', 'Text'], ['textarea', 'Mehrzeilig'], ['select', 'Auswahlliste'], ['number', 'Zahl'], ['checkbox', 'Ja/Nein']];
const TYPES: [string, string][] = [['part', 'Teil'], ['assembly', 'Baugruppe'], ['drawing', 'Zeichnung']];

/** Baukasten für die Speichermaske des CAD-Wächters (Kapitel 7.1) */
export function CadMaskSettings() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('cadMask');
  const [catalog, setCatalog] = useState<string | null>(null);
  if (!s.value) return null;
  const v = s.value;
  const setField = (i: number, f: any) => s.setValue({ ...v, fields: v.fields.map((x: any, j: number) => (j === i ? f : x)) });
  const move = (i: number, d: number) => { const n = [...v.fields]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; s.setValue({ ...v, fields: n }); };
  const cat = v.catalogs.find((c: any) => c.name === catalog);
  return (
    <div>
      <h1 style={{ marginBottom: 6 }}>Speichermaske (CAD)</h1>
      <p className="muted">Legen Sie fest, welche Felder die Konstrukteure beim Speichern in SolidWorks ausfüllen. Jedes Feld wird als Custom Property in die Datei geschrieben und erscheint so im Schriftkopf.</p>
      <h2 style={{ margin: '18px 0 8px' }}>Felder</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th /><th>Eigenschaft (SolidWorks)</th><th>Bezeichnung</th><th>Typ</th><th>Katalog</th><th>Pflicht</th><th>Gilt für</th><th>Vorgabe</th><th /></tr></thead>
        <tbody>{v.fields.map((f: any, i: number) => (
          <tr key={i}>
            <td style={{ whiteSpace: 'nowrap' }}><button className="btn ghost sm" onClick={() => move(i, -1)}>↑</button><button className="btn ghost sm" onClick={() => move(i, 1)}>↓</button></td>
            <td><input className="mono" style={{ minWidth: 130 }} value={f.key} onChange={(e) => setField(i, { ...f, key: e.target.value.replace(/\s/g, '') })} /></td>
            <td><input style={{ minWidth: 150 }} value={f.label} onChange={(e) => setField(i, { ...f, label: e.target.value })} /></td>
            <td><select style={{ minWidth: 130 }} value={f.type} onChange={(e) => setField(i, { ...f, type: e.target.value })}>{FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
            <td>{f.type === 'select' ? <select style={{ minWidth: 140 }} value={f.catalog ?? ''} onChange={(e) => setField(i, { ...f, catalog: e.target.value })}><option value="">–</option>{v.catalogs.map((c: any) => <option key={c.name} value={c.name}>{c.label}</option>)}</select> : ''}</td>
            <td><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { ...f, required: e.target.checked })} /></td>
            <td style={{ whiteSpace: 'nowrap' }}>{TYPES.map(([k, l]) => (
              <label key={k} className="small" style={{ marginRight: 6 }}><input type="checkbox" checked={!f.appliesTo || f.appliesTo.includes(k)} onChange={(e) => {
                const cur: string[] = f.appliesTo ?? TYPES.map((t) => t[0]);
                const next = e.target.checked ? [...cur, k] : cur.filter((x) => x !== k);
                setField(i, { ...f, appliesTo: next.length === 3 ? undefined : next });
              }} /> {l}</label>
            ))}</td>
            <td><input style={{ minWidth: 90 }} value={f.defaultValue ?? ''} onChange={(e) => setField(i, { ...f, defaultValue: e.target.value || undefined })} /></td>
            <td><button className="btn ghost sm" onClick={() => s.setValue({ ...v, fields: v.fields.filter((_: any, j: number) => j !== i) })}>✕</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button className="btn" style={{ marginTop: 8 }} onClick={() => s.setValue({ ...v, fields: [...v.fields, { key: 'NeuesFeld', label: 'Neues Feld', type: 'text', required: false }] })}>＋ Feld hinzufügen</button>

      <h2 style={{ margin: '24px 0 8px' }}>Dropdown-Kataloge</h2>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {v.catalogs.map((c: any) => <button key={c.name} className={`btn sm ${catalog === c.name ? 'primary' : ''}`} onClick={() => setCatalog(c.name)}>{c.label} ({c.values.length})</button>)}
        <button className="btn sm" onClick={() => { const name = prompt('Interner Name (ohne Leerzeichen)'); if (name) { s.setValue({ ...v, catalogs: [...v.catalogs, { name, label: name, values: [] }] }); setCatalog(name); } }}>＋ Katalog</button>
      </div>
      {cat && (
        <div className="card flat">
          <div className="grid2"><Field label="Bezeichnung"><input value={cat.label} onChange={(e) => s.setValue({ ...v, catalogs: v.catalogs.map((c: any) => (c.name === cat.name ? { ...c, label: e.target.value } : c)) })} /></Field></div>
          <Field label="Einträge (einer pro Zeile)">
            <textarea rows={8} value={cat.values.join('\n')} onChange={(e) => s.setValue({ ...v, catalogs: v.catalogs.map((c: any) => (c.name === cat.name ? { ...c, values: e.target.value.split('\n').map((x: string) => x.trim()).filter(Boolean) } : c)) })} />
          </Field>
        </div>
      )}

      <h2 style={{ margin: '24px 0 8px' }}>Unterbaugruppen (Nummernbereiche)</h2>
      <div className="card flat" style={{ padding: 8, maxWidth: 520 }}>
        {v.subassemblies.map((sa: any, i: number) => (
          <div key={i} className="row" style={{ marginBottom: 4 }}>
            <input className="mono" style={{ width: 80 }} value={sa.code} maxLength={3} onChange={(e) => s.setValue({ ...v, subassemblies: v.subassemblies.map((x: any, j: number) => (j === i ? { ...x, code: e.target.value.replace(/\D/g, '') } : x)) })} />
            <input value={sa.label} onChange={(e) => s.setValue({ ...v, subassemblies: v.subassemblies.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <button className="btn ghost sm" onClick={() => s.setValue({ ...v, subassemblies: v.subassemblies.filter((_: any, j: number) => j !== i) })}>✕</button>
          </div>
        ))}
        <button className="btn sm" onClick={() => s.setValue({ ...v, subassemblies: [...v.subassemblies, { code: '', label: '' }] })}>＋ Bereich</button>
      </div>

      <h2 style={{ margin: '24px 0 8px' }}>Zeichnungen</h2>
      <label className="row"><input type="checkbox" checked={v.askCreateDrawing} onChange={(e) => s.setValue({ ...v, askCreateDrawing: e.target.checked })} /> Beim Speichern von Teilen/Baugruppen fragen, ob die passende Zeichnung angelegt werden soll</label>
      <Field label="Zeichnungsvorlage (Dateiname auf dem Konstruktions-PC)"><input className="mono" value={v.drawingTemplate} onChange={(e) => s.setValue({ ...v, drawingTemplate: e.target.value })} style={{ maxWidth: 420 }} /></Field>
      <button className="btn primary" onClick={async () => { await act(() => s.save(v), 'Speichermaske gespeichert'); refreshLists(); }}>Speichern</button>
    </div>
  );
}

const STATES: Record<string, string> = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
};

/** Feiertage pflegen – Grundlage für die Urlaubstage-Berechnung */
export function HolidaySettings() {
  const act = useAction();
  const time = useAdminSettings('time');
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, reload } = useApi<{ day: string; name: string }[]>(`/holidays?year=${year}`);
  const [day, setDay] = useState('');
  const [name, setName] = useState('');
  if (!time.value) return null;
  const save = async (list: { day: string; name: string }[]) => { await act(() => put('/holidays', { year, holidays: list }), 'Gespeichert'); reload(); };
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>Feiertage</h1>
      <p className="muted">Feiertage und Wochenenden zählen nicht als Urlaubstage. Betriebsurlaub oder Brückentage können zusätzlich eingetragen werden.</p>
      <div className="row" style={{ margin: '12px 0' }}>
        <select value={time.value.holidayState} onChange={(e) => time.setValue({ ...time.value, holidayState: e.target.value })} style={{ width: 'auto' }}>
          {Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 'auto' }}>{[year - 1, year, year + 1, year + 2].map((y) => <option key={y}>{y}</option>)}</select>
        <button className="btn" onClick={async () => { await time.save(time.value); await act(() => post('/holidays/generate', { year, state: time.value.holidayState }), 'Gesetzliche Feiertage übernommen'); reload(); }}>Gesetzliche Feiertage übernehmen</button>
      </div>
      <div className="table-wrap"><table className="table"><tbody>
        {data?.map((h) => <tr key={h.day}><td className="mono">{fmtDate(h.day)}</td><td>{h.name}</td><td style={{ width: 50 }}><button className="btn ghost sm" onClick={() => save(data.filter((x) => x.day !== h.day))}>✕</button></td></tr>)}
        {!data?.length && <tr><td className="muted">Keine Feiertage für {year}</td></tr>}
      </tbody></table></div>
      <div className="row" style={{ marginTop: 10 }}>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 180 }} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Betriebsurlaub" />
        <button className="btn" disabled={!day || !name} onClick={() => { void save([...(data ?? []), { day, name }]); setDay(''); setName(''); }}>Hinzufügen</button>
      </div>
    </div>
  );
}

/** Nacht-Tresor: geplante verschlüsselte Sicherungen, manuelle Sicherung, Import mit Duplikat-Prüfung */
export function BackupSettings() {
  const act = useAction();
  const s = useAdminSettings('backup');
  const { data: list, reload } = useApi<any[]>('/backups');
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<any | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);
  if (!s.value) return null;
  const v = s.value;
  const [cm, ch] = (v.cron as string).split(' ');
  const time = `${String(ch).padStart(2, '0')}:${String(cm).padStart(2, '0')}`;
  return (
    <div style={{ maxWidth: 860 }}>
      <h1 style={{ marginBottom: 8 }}>Sicherung (Nacht-Tresor)</h1>
      <p className="muted">Jede Nacht wird automatisch eine vollständige, verschlüsselte Sicherung aller Projekte, Zeiten und Dokumente erstellt. Als Ziel kann eine separate Festplatte oder ein NAS dienen (BACKUP_PATH in der .env).</p>
      <div className="card" style={{ margin: '14px 0' }}>
        <label className="row" style={{ marginBottom: 10 }}><input type="checkbox" checked={v.enabled} onChange={(e) => s.setValue({ ...v, enabled: e.target.checked })} /> Automatische Sicherung aktiv</label>
        <div className="grid3">
          <Field label="Uhrzeit"><input type="time" value={time} onChange={(e) => { const [h, m] = e.target.value.split(':'); s.setValue({ ...v, cron: `${Number(m)} ${Number(h)} * * *` }); }} /></Field>
          <Field label="Aufbewahren (Anzahl)"><input type="number" min={1} max={365} value={v.keep} onChange={(e) => s.setValue({ ...v, keep: Number(e.target.value) })} /></Field>
          <Field label="Dateien einschließen"><select value={v.includeFiles ? '1' : '0'} onChange={(e) => s.setValue({ ...v, includeFiles: e.target.value === '1' })}><option value="1">Ja (vollständig)</option><option value="0">Nein (nur Datenbank)</option></select></Field>
        </div>
        <Field label="Zielordner auf dem Server (optional)" hint="leer = Standard-Sicherungsordner"><input className="mono" value={v.targetDir} onChange={(e) => s.setValue({ ...v, targetDir: e.target.value })} /></Field>
        <Field label="Passwort der Sicherungen" hint="Ohne dieses Passwort lassen sich Sicherungen nicht einspielen – bitte sicher aufbewahren! Wird BACKUP_KEY in der .env gesetzt, hat dieser Vorrang.">
          <div className="row"><input className="mono" type={showPass ? 'text' : 'password'} value={v.passphrase} onChange={(e) => s.setValue({ ...v, passphrase: e.target.value })} /><button className="btn" onClick={() => setShowPass(!showPass)}>{showPass ? 'Verbergen' : 'Anzeigen'}</button></div>
        </Field>
        <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 className="grow">Vorhandene Sicherungen</h2>
        <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await act(() => post('/backups', {}), 'Sicherung erstellt'); setBusy(false); reload(); }}>{busy ? 'Sichert …' : '💾 Jetzt sichern'}</button>
        <label className="btn">⬆️ Sicherung hochladen<input type="file" accept=".apb" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          const pass = prompt('Passwort der Sicherung (leer = aktuelles Passwort)') ?? '';
          const fd = new FormData(); fd.append('passphrase', pass); fd.append('file', f, f.name);
          setBusy(true); const r = await act(() => upload('/backups/upload', fd)); setBusy(false);
          if (r) setAnalysis(r);
        }} /></label>
      </div>
      <div className="table-wrap"><table className="table"><tbody>
        {list?.map((b) => (
          <tr key={b.name}>
            <td className="mono small">{b.name}</td><td className="small">{fmtDateTime(b.createdAt)}</td><td className="small">{fmtBytes(b.size)}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <a className="btn sm" href={`/api/backups/${b.name}`}>⬇️</a>{' '}
              <button className="btn sm" onClick={async () => { const pass = prompt('Passwort der Sicherung (leer = aktuelles)') ?? ''; setBusy(true); const r = await act(() => post(`/backups/${b.name}/analyze`, { passphrase: pass || undefined })); setBusy(false); if (r) setAnalysis(r); }}>Einspielen …</button>{' '}
              <button className="btn sm danger" onClick={() => setRemove(b.name)}>🗑️</button>
            </td>
          </tr>
        ))}
        {!list?.length && <tr><td className="muted">Noch keine Sicherungen</td></tr>}
      </tbody></table></div>
      {analysis && <ImportDialog analysis={analysis} onClose={() => setAnalysis(null)} />}
      {remove && <Confirm danger text={`Sicherung ${remove} löschen?`} onClose={() => setRemove(null)} onConfirm={async () => { await del(`/backups/${remove}`); reload(); }} />}
    </div>
  );
}

const TABLE_LABEL: Record<string, string> = {
  users: 'Benutzer', teams: 'Teams', projects: 'Projekte', tasks: 'Aufgaben', files: 'Dateien', cad_items: 'CAD-Teile', time_entries: 'Zeitbuchungen',
  absences: 'Abwesenheiten', chat_messages: 'Chatnachrichten', kvp_ideas: 'KVP-Ideen', settings: 'Einstellungen', audit_log: 'Änderungsprotokoll', comments: 'Kommentare',
};

function ImportDialog({ analysis, onClose }: { analysis: any; onClose: () => void }) {
  const act = useAction();
  const [strategy, setStrategy] = useState<'newer' | 'local' | 'backup'>('newer');
  const [overrides, setOverrides] = useState<Record<string, 'local' | 'backup'>>({});
  const [result, setResult] = useState<any | null>(null);
  const tables = analysis.tables.filter((t: any) => t.total > 0);
  return (
    <Modal size="lg" title="Sicherung einspielen – Prüfung" onClose={async () => { if (!result) await del(`/backups/import/${analysis.id}`).catch(() => {}); onClose(); }} footer={result ? <button className="btn primary" onClick={() => location.reload()}>Fertig – neu laden</button> : <>
      <button className="btn" onClick={async () => { await del(`/backups/import/${analysis.id}`); onClose(); }}>Abbrechen</button>
      <button className="btn primary" onClick={async () => { const r = await act(() => post(`/backups/import/${analysis.id}/apply`, { strategy, overrides }), 'Eingespielt'); if (r) setResult(r); }}>Einspielen</button>
    </>}>
      {result ? (
        <div className="card" style={{ borderColor: 'var(--green)' }}>✅ {result.inserted} Einträge neu übernommen, {result.updated} mit dem Stand der Sicherung überschrieben, {result.skipped} unverändert, {result.files} Dateien wiederhergestellt.</div>
      ) : <>
        <p className="muted">Sicherung vom <b>{fmtDateTime(analysis.manifest.createdAt)}</b> (Version {analysis.manifest.version}, {analysis.files.total} Dateien, davon {analysis.files.new} neu).</p>
        <table className="table" style={{ marginBottom: 14 }}>
          <thead><tr><th>Bereich</th><th>in Sicherung</th><th>neu</th><th>identisch</th><th>abweichend</th></tr></thead>
          <tbody>{tables.map((t: any) => <tr key={t.name}><td>{TABLE_LABEL[t.name] ?? t.name}</td><td>{t.total}</td><td>{t.new}</td><td>{t.same}</td><td style={{ color: t.conflicts ? 'var(--amber)' : undefined }}>{t.conflicts}</td></tr>)}</tbody>
        </table>
        {analysis.conflicts.length > 0 && <>
          <h3 style={{ marginBottom: 8 }}>Doppelte Einträge mit unterschiedlichem Stand</h3>
          <div className="row wrap" style={{ marginBottom: 10 }}>
            {([['newer', 'Neuerer Stand gewinnt (empfohlen)'], ['local', 'Immer Bestand behalten'], ['backup', 'Immer Sicherung übernehmen']] as const).map(([k, l]) => (
              <label key={k} className="row small"><input type="radio" checked={strategy === k} onChange={() => setStrategy(k)} /> {l}</label>
            ))}
          </div>
          <div className="table-wrap" style={{ maxHeight: 280 }}><table className="table">
            <thead><tr><th>Bereich</th><th>Eintrag</th><th>Bestand vom</th><th>Sicherung vom</th><th>Übernehmen</th></tr></thead>
            <tbody>{analysis.conflicts.slice(0, 300).map((c: any) => {
              const k = `${c.table}:${c.key}`;
              const def = strategy === 'newer' ? (c.newer === 'backup' ? 'backup' : 'local') : strategy;
              const val = overrides[k] ?? def;
              return (
                <tr key={k}>
                  <td className="small">{TABLE_LABEL[c.table] ?? c.table}</td><td className="small">{c.label}</td>
                  <td className="small" style={{ fontWeight: c.newer === 'local' ? 650 : 400 }}>{fmtDateTime(c.localDate)}</td>
                  <td className="small" style={{ fontWeight: c.newer === 'backup' ? 650 : 400 }}>{fmtDateTime(c.backupDate)}</td>
                  <td><select value={val} onChange={(e) => setOverrides({ ...overrides, [k]: e.target.value as 'local' })}><option value="local">Bestand</option><option value="backup">Sicherung</option></select></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {analysis.conflicts.length > 300 && <div className="hint">… und {analysis.conflicts.length - 300} weitere (folgen der gewählten Regel)</div>}
        </>}
      </>}
    </Modal>
  );
}

/** Ein-Klick-Aktualisierung über GitHub */
export function UpdateSettings() {
  const act = useAction();
  const { data: check, reload } = useApi<any>('/system/update/check');
  const { data: status, reload: reloadStatus } = useApi<any>('/system/update/status');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ marginBottom: 8 }}>Aktualisierung</h1>
      <p className="muted">Aktualisierungen werden direkt von GitHub geladen. Nur die Programmdateien werden ersetzt – Projekte, Dokumente, Datenbank und Einstellungen bleiben unberührt. Vorher wird automatisch eine Sicherung erstellt.</p>
      <div className="card" style={{ margin: '14px 0' }}>
        <div className="row"><div className="grow"><div className="muted small">Installiert</div><div className="stat">{APP_VERSION}</div></div>
          <div className="grow"><div className="muted small">Verfügbar</div><div className="stat">{check?.latest ?? '–'}</div></div>
          <button className="btn" onClick={() => { reload(); reloadStatus(); }}>🔄 Prüfen</button></div>
        {check?.error && <div className="error-text">{check.error}</div>}
        {check?.updateAvailable ? (
          <div style={{ marginTop: 12 }}>
            <Pill tone="green">Neue Version verfügbar</Pill>
            {check.notes && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--bg-soft)', padding: 10, borderRadius: 8 }}>{check.notes}</pre>}
            <div className="spacer" />
            <button className="btn primary" disabled={busy || !status?.available} onClick={async () => { setBusy(true); await act(() => post('/system/update', { ref: check.ref, backupFirst: true }), 'Aktualisierung gestartet'); setBusy(false); setTimeout(reloadStatus, 3000); }}>⬆️ Jetzt auf {check.latest} aktualisieren</button>
            {!status?.available && <div className="hint">Der Updater-Dienst ist nur bei der Docker-Installation verfügbar.</div>}
          </div>
        ) : check && !check.error && <div style={{ marginTop: 10 }}><Pill tone="green">✓ AperioPlan ist aktuell</Pill></div>}
      </div>
      {status?.status && (
        <div className="card">
          <b>Letzte Aktualisierung:</b> {status.status.ref} – {status.status.status === 'running' ? '⏳ läuft' : status.status.status === 'done' ? '✅ erfolgreich' : '❌ fehlgeschlagen'} ({fmtDateTime(status.status.at)})
          {status.log && <pre className="mono small" style={{ maxHeight: 260, overflow: 'auto', background: 'var(--bg-soft)', padding: 10, borderRadius: 8 }}>{status.log}</pre>}
        </div>
      )}
    </div>
  );
}

export function MailSettings() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('mail');
  const [result, setResult] = useState<string | null>(null);
  if (!s.value) return null;
  const v = s.value;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => s.setValue({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>E-Mail-Konto</h1>
      <p className="muted">Gemeinsames Projektpostfach (z. B. projekte@firma.de). E-Mails werden alle 5 Minuten abgerufen und anhand der Projektnummer im Betreff automatisch zugeordnet.</p>
      <label className="row" style={{ margin: '12px 0' }}><input type="checkbox" checked={v.enabled} onChange={set('enabled')} /> E-Mail-Verwaltung aktivieren</label>
      <div className="grid3">
        <Field label="IMAP-Server"><input value={v.imapHost} onChange={set('imapHost')} /></Field>
        <Field label="IMAP-Port"><input type="number" value={v.imapPort} onChange={set('imapPort')} /></Field>
        <Field label="IMAP SSL"><input type="checkbox" checked={v.imapSecure} onChange={set('imapSecure')} /></Field>
        <Field label="SMTP-Server"><input value={v.smtpHost} onChange={set('smtpHost')} /></Field>
        <Field label="SMTP-Port"><input type="number" value={v.smtpPort} onChange={set('smtpPort')} /></Field>
        <Field label="SMTP SSL (465)"><input type="checkbox" checked={v.smtpSecure} onChange={set('smtpSecure')} /></Field>
      </div>
      <div className="grid3">
        <Field label="Benutzer"><input value={v.user} onChange={set('user')} /></Field>
        <Field label="Passwort"><input type="password" value={v.password} onChange={set('password')} /></Field>
        <Field label="Absender"><input value={v.from} onChange={set('from')} placeholder="Projekte <projekte@firma.de>" /></Field>
      </div>
      <div className="row">
        <button className="btn primary" onClick={async () => { await act(() => s.save(v), 'Gespeichert'); refreshLists(); }}>Speichern</button>
        <button className="btn" onClick={async () => { const r = await act(() => post('/settings/mail/test', v)); if (r) setResult(r.message); }}>Verbindung testen</button>
      </div>
      {result && <div className="card" style={{ marginTop: 12 }}>{result}</div>}
    </div>
  );
}

export function AiSettings() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('ai');
  const [result, setResult] = useState<string | null>(null);
  if (!s.value) return null;
  const v = s.value;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => s.setValue({ ...v, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>KI-Anbindung</h1>
      <p className="muted">Schnittstelle für lokale KI-Modelle (z. B. Ollama, LM Studio, vLLM – Daten bleiben im Haus) oder externe Anbieter. Genutzt für Projektzusammenfassungen, Schreibhilfe und Dokumentenanalyse.</p>
      <label className="row" style={{ margin: '12px 0' }}><input type="checkbox" checked={v.enabled} onChange={set('enabled')} /> KI-Funktionen aktivieren</label>
      <div className="grid2">
        <Field label="Schnittstelle"><select value={v.provider} onChange={set('provider')}><option value="openai">OpenAI-kompatibel (Ollama, LM Studio, vLLM, OpenAI, Mistral …)</option><option value="anthropic">Anthropic</option></select></Field>
        <Field label="Modell"><input value={v.model} onChange={set('model')} placeholder="z. B. llama3.1, mistral, claude-…" /></Field>
        <Field label="Adresse" hint="Ollama: http://ki-server:11434/v1"><input className="mono" value={v.baseUrl} onChange={set('baseUrl')} /></Field>
        <Field label="API-Schlüssel" hint="bei lokalen Modellen meist leer"><input type="password" value={v.apiKey} onChange={set('apiKey')} /></Field>
      </div>
      <div className="row">
        <button className="btn primary" onClick={async () => { await act(() => s.save(v), 'Gespeichert'); refreshLists(); }}>Speichern</button>
        <button className="btn" onClick={async () => { const r = await act(() => post('/settings/ai/test', v)); if (r) setResult(`${r.ok ? '✅' : '❌'} ${r.message}`); }}>Verbindung testen</button>
      </div>
      {result && <div className="card" style={{ marginTop: 12 }}>{result}</div>}
    </div>
  );
}

/** Entwickler-Schnittstelle: Plugins und Webhooks */
export function ExtensionSettings() {
  const act = useAction();
  const { data: plugins, reload } = useApi<any[]>('/plugins');
  const hooks = useAdminSettings('webhooks');
  return (
    <div style={{ maxWidth: 860 }}>
      <h1 style={{ marginBottom: 8 }}>Erweiterungen</h1>
      <p className="muted">Drittentwickler können neue Werkzeuge als Plugin ergänzen (Ordner im Plugin-Verzeichnis mit manifest.json) oder über Webhooks und die REST-API (API-Schlüssel) anbinden. Details im Entwickler-Handbuch.</p>
      <h2 style={{ margin: '16px 0 8px' }}>Plugins</h2>
      {!plugins?.length ? <div className="card muted">Keine Plugins installiert. Plugin-Ordner nach <span className="mono">data/plugins/&lt;id&gt;/</span> kopieren.</div> : (
        <div className="table-wrap"><table className="table"><tbody>{plugins.map((p) => (
          <tr key={p.id}><td><b>{p.name}</b> <span className="muted small">{p.version}</span><div className="small muted">{p.description}</div></td>
            <td className="small">{p.projectTab && `Projekt-Reiter „${p.projectTab.label}“`}{p.page && ` Seite „${p.page.label}“`}</td>
            <td><label className="row small"><input type="checkbox" checked={p.enabled} onChange={async (e) => { await act(() => put(`/plugins/${p.id}`, { enabled: e.target.checked })); reload(); }} /> aktiv</label></td></tr>
        ))}</tbody></table></div>
      )}
      <h2 style={{ margin: '24px 0 8px' }}>Webhooks</h2>
      <p className="muted small">Bei jedem Ereignis des Änderungsprotokolls (z. B. <span className="mono">task.update</span>, <span className="mono">cad.state</span>, <span className="mono">project.*</span>) sendet AperioPlan eine signierte POST-Anfrage (Header X-Aperio-Signature = HMAC-SHA256).</p>
      {hooks.value && <>
        {hooks.value.map((h: any, i: number) => (
          <div key={h.id} className="card flat row wrap" style={{ marginBottom: 8 }}>
            <input className="mono" style={{ flex: 2, minWidth: 220 }} value={h.url} placeholder="https://…" onChange={(e) => hooks.setValue(hooks.value.map((x: any, j: number) => (j === i ? { ...x, url: e.target.value } : x)))} />
            <input className="mono" style={{ flex: 1, minWidth: 160 }} value={h.events.join(',')} placeholder="Ereignisse, z. B. task.*,cad.state" onChange={(e) => hooks.setValue(hooks.value.map((x: any, j: number) => (j === i ? { ...x, events: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)))} />
            <input className="mono" style={{ width: 160 }} value={h.secret} placeholder="Geheimnis" onChange={(e) => hooks.setValue(hooks.value.map((x: any, j: number) => (j === i ? { ...x, secret: e.target.value } : x)))} />
            <label className="row small"><input type="checkbox" checked={h.active} onChange={(e) => hooks.setValue(hooks.value.map((x: any, j: number) => (j === i ? { ...x, active: e.target.checked } : x)))} /> aktiv</label>
            <button className="btn ghost sm" onClick={() => hooks.setValue(hooks.value.filter((_: any, j: number) => j !== i))}>✕</button>
          </div>
        ))}
        <div className="row">
          <button className="btn" onClick={() => hooks.setValue([...hooks.value, { id: Math.random().toString(36).slice(2), url: '', events: ['*'], secret: Math.random().toString(36).slice(2), active: true }])}>＋ Webhook</button>
          <button className="btn primary" onClick={() => act(() => hooks.save(hooks.value), 'Gespeichert')}>Speichern</button>
        </div>
      </>}
    </div>
  );
}

const RES_KINDS: [string, string][] = [['room', 'Raum'], ['vehicle', 'Fahrzeug'], ['equipment', 'Gerät'], ['other', 'Sonstiges']];
const RES_COLORS = ['#4f46e5', '#0e9f6e', '#d97706', '#db2777', '#0891b2', '#7c3aed', '#dc2626', '#65a30d'];

/** Ressourcen (Räume, Fahrzeuge, Geräte) anlegen und verwalten */
export function ResourcesSettings() {
  const act = useAction();
  const { users, teams } = useSession();
  const { data, reload } = useApi<any[]>('/resources');
  const [edit, setEdit] = useState<any | null>(null);
  const [remove, setRemove] = useState<any | null>(null);
  const blank = { name: '', kind: 'room', location: '', capacity: '', description: '', color: RES_COLORS[0], requiresApproval: false, approverId: '', allowedTeamIds: [] as string[], active: true };
  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head"><div><h1>Ressourcen</h1><div className="sub">Räume, Firmenwagen und Geräte, die Mitarbeiter im Kalender buchen können.</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setEdit({ ...blank })}><Icon name="plus" /> Ressource anlegen</button></div></div>
      {!data?.length ? <div className="card muted">Noch keine Ressourcen angelegt.</div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Ressource</th><th>Art</th><th>Genehmigung</th><th>Buchbar für</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id} className="click" onClick={() => setEdit({ ...r, capacity: r.capacity ?? '', approverId: r.approverId ?? '' })}>
              <td><ResourceLabel r={r} /></td>
              <td>{RES_KINDS.find(([k]) => k === r.kind)?.[1]}</td>
              <td>{r.requiresApproval ? (r.approverName ?? 'Administratoren') : <span className="muted">nein</span>}</td>
              <td className="small">{r.allowedTeamIds.length ? teams.filter((t) => r.allowedTeamIds.includes(t.id)).map((t) => t.name).join(', ') : 'alle'}</td>
              <td>{r.active ? <Pill tone="green">buchbar</Pill> : <Pill tone="red">gesperrt</Pill>}</td>
              <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                <button className="btn sm" onClick={async () => { await act(() => patch(`/resources/${r.id}`, { active: !r.active }), r.active ? 'Gesperrt' : 'Freigegeben'); reload(); }}>{r.active ? 'Sperren' : 'Freigeben'}</button>{' '}
                <button className="btn sm danger" title="Löschen" onClick={() => setRemove(r)}><Icon name="trash" /></button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && (
        <Modal title={edit.id ? 'Ressource bearbeiten' : 'Ressource anlegen'} onClose={() => setEdit(null)} footer={<>
          <button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
          <button className="btn primary" disabled={!edit.name.trim()} onClick={async () => {
            const body = { name: edit.name, kind: edit.kind, location: edit.location, capacity: edit.capacity === '' ? null : Number(edit.capacity), description: edit.description,
              color: edit.color, requiresApproval: edit.requiresApproval, approverId: edit.approverId || null, allowedTeamIds: edit.allowedTeamIds, active: edit.active };
            const ok = await act(() => (edit.id ? patch(`/resources/${edit.id}`, body) : post('/resources', body)), 'Gespeichert');
            if (ok) { setEdit(null); reload(); }
          }}>Speichern</button>
        </>}>
          <div className="grid2">
            <Field label="Name" required><input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="z. B. Besprechungsraum 1, VW Caddy KN-AP 123" /></Field>
            <Field label="Art"><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{RES_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Ort"><input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} placeholder="z. B. Erdgeschoss, Parkplatz 3" /></Field>
            <Field label={edit.kind === 'vehicle' ? 'Sitze' : 'Plätze'}><input type="number" min={0} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></Field>
          </div>
          <Field label="Beschreibung"><input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="z. B. Beamer und Videokonferenz vorhanden" /></Field>
          <Field label="Farbe">
            <div className="row">{RES_COLORS.map((c) => <button key={c} className="btn sm" onClick={() => setEdit({ ...edit, color: c })} style={{ width: 28, height: 28, padding: 0, background: c, outline: edit.color === c ? '2px solid var(--text)' : undefined, outlineOffset: 2 }} aria-label={c} />)}</div>
          </Field>
          <label className="row" style={{ marginBottom: 10 }}><input type="checkbox" checked={edit.requiresApproval} onChange={(e) => setEdit({ ...edit, requiresApproval: e.target.checked })} /> Buchungen müssen genehmigt werden</label>
          {edit.requiresApproval && <Field label="Genehmigt durch" hint="leer = alle Administratoren">
            <select value={edit.approverId} onChange={(e) => setEdit({ ...edit, approverId: e.target.value })}><option value="">Administratoren</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
          </Field>}
          <Field label="Buchbar für" hint="nichts ausgewählt = alle Mitarbeiter">
            <div className="row wrap">{teams.map((t) => (
              <label key={t.id} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={edit.allowedTeamIds.includes(t.id)} onChange={() => setEdit({ ...edit, allowedTeamIds: edit.allowedTeamIds.includes(t.id) ? edit.allowedTeamIds.filter((x: string) => x !== t.id) : [...edit.allowedTeamIds, t.id] })} />{t.name}</label>
            ))}</div>
          </Field>
          <label className="row"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Buchbar (abwählen, um z. B. ein Fahrzeug in der Werkstatt zu sperren)</label>
        </Modal>
      )}
      {remove && <Confirm danger text={`„${remove.name}“ löschen? Das geht nur, wenn keine künftigen Buchungen bestehen – sonst bitte sperren.`} onClose={() => setRemove(null)} onConfirm={async () => { await act(() => del(`/resources/${remove.id}`), 'Gelöscht'); reload(); }} />}
    </div>
  );
}
