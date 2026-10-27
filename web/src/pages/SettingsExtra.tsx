import { useState } from 'react';
import { useApi } from '../lib/hooks';
import { post, put, invalidate } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Modal, Pill } from '../components/ui';
import { Field, useAction } from '../components/ui';
import { useSession } from '../session';
import { useAdminSettings } from './Settings';

const Later = ({ title }: { title: string }) => <div><h1 style={{ marginBottom: 12 }}>{title}</h1><div className="empty">Folgt in einer der nächsten Etappen.</div></div>;
export const BackupSettings = () => <Later title="Sicherung" />;
export const UpdateSettings = () => <Later title="Aktualisierung" />;
export const MailSettings = () => <Later title="E-Mail-Konto" />;
export const AiSettings = () => <Later title="KI-Anbindung" />;

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
