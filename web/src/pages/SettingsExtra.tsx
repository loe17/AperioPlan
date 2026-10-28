import { useState } from 'react';
import { useApi } from '../lib/hooks';
import { post, put, patch, invalidate } from '../lib/api';
import { Icon, IconPicker } from '../components/Icon';
import { ResourceLabel, useResourceTypes, type ResourceType } from './Resources';
import { fmtBytes, fmtDate, fmtDateTime } from '../lib/format';
import { Confirm, Modal, Pill } from '../components/ui';
import { del, upload } from '../lib/api';
import { APP_VERSION, PCB_EXPORT_FORMATS, PCB_EXPORT_LABELS, pcbFullNumber, pcbNumber, validatePcbPattern } from '@aperio/shared';
import { Field, useAction } from '../components/ui';
import { useSession } from '../session';
import { useAdminSettings } from './Settings';


export function StorageSettings() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('storage');
  if (!s.value) return null;
  const v = s.value;
  return (
    <div style={{ maxWidth: 860 }}>
      <h1 style={{ marginBottom: 8 }}>Speicherorte</h1>
      <p className="muted">Projektdateien liegen in der Standardablage (FILES_PATH in der Datei .env). Zusätzlich lassen sich weitere Speicherorte einbinden – etwa ein NAS je Abteilung oder ein Archiv-Laufwerk. Neue Netzlaufwerke bindet der Administrator auf dem Server mit <span className="mono">sudo ./install.sh speicherort</span> ein; sie erscheinen dann unten zur Auswahl.</p>
      <Field label="Netzwerkpfad der Standardablage für den Windows-Explorer" hint="Wird bei jedem Projekt angezeigt, z. B. \\nas01\projekte">
        <input className="mono" value={v.networkPath} onChange={(e) => s.setValue({ ...v, networkPath: e.target.value })} />
      </Field>
      <Locations v={v} set={s.setValue} />
      <Field label="Automatische Ordnerstruktur für neue Projekte" hint="Unterordner über das Plus-Zeichen an einem Ordner anlegen">
        <FolderTree list={v.projectFolders} onChange={(projectFolders) => s.setValue({ ...v, projectFolders })} />
      </Field>
      <button className="btn primary" onClick={async () => { await act(() => s.save(v), 'Gespeichert'); refreshLists(); invalidate('/storage/locations'); }}>Speichern</button>
      <ScanWizard />
    </div>
  );
}

interface Loc { id: string; name: string; path: string; networkPath: string; teamIds: string[]; archive: boolean }

/** Weitere Speicherorte: Abteilungen zuordnen, Standard festlegen, Platz anzeigen */
function Locations({ v, set }: { v: any; set: (v: any) => void }) {
  const { teams } = useSession();
  const { data: live } = useApi<any[]>('/storage/locations');
  const { data: detected } = useApi<{ dir: string; folders: { name: string; path: string; space: any }[] }>('/storage/locations/detected');
  const [edit, setEdit] = useState<(Loc & { isNew?: boolean }) | null>(null);
  const locs: Loc[] = v.locations ?? [];
  const info = (id: string) => live?.find((l) => l.id === id);
  const unused = detected?.folders.filter((f) => !locs.some((l) => l.path === f.path)) ?? [];
  const Space = ({ id }: { id: string }) => { const sp = info(id)?.space; return sp?.total ? <span className="small muted">{fmtBytes(sp.free)} frei von {fmtBytes(sp.total)}</span> : <span className="small muted">–</span>; };
  return (
    <Field label="Speicherorte">
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Name</th><th>Abteilungen</th><th>Platz</th><th>Projekte</th><th>Standard</th><th /></tr></thead>
        <tbody>
          <tr><td><Icon name="hdd" /> Standardablage</td><td className="small muted">alle übrigen</td><td><Space id="main" /></td><td>{info('main')?.projects ?? ''}</td>
            <td><input type="radio" name="defloc" checked={(v.defaultLocation || 'main') === 'main'} onChange={() => set({ ...v, defaultLocation: 'main' })} /></td><td /></tr>
          {locs.map((l) => (
            <tr key={l.id}>
              <td><Icon name={l.archive ? 'archive' : 'server'} /> {l.name} {l.archive && <Pill>Archiv</Pill>} {info(l.id) && !info(l.id).reachable && <Pill tone="red">nicht erreichbar</Pill>}<div className="small muted mono">{l.networkPath || l.path}</div></td>
              <td className="small">{l.teamIds.map((t) => teams.find((x) => x.id === t)?.name).filter(Boolean).join(', ') || '–'}</td>
              <td><Space id={l.id} /></td><td>{info(l.id)?.projects ?? ''}</td>
              <td>{!l.archive && <input type="radio" name="defloc" checked={v.defaultLocation === l.id} onChange={() => set({ ...v, defaultLocation: l.id })} />}</td>
              <td><button className="btn ghost sm" onClick={() => setEdit(l)}><Icon name="edit" /></button></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
        {unused.map((f) => <button key={f.path} className="btn sm" onClick={() => setEdit({ id: f.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40), name: f.name, path: f.path, networkPath: '', teamIds: [], archive: /archiv/i.test(f.name), isNew: true })}><Icon name="plus" /> {f.name} einbinden</button>)}
        {detected && !unused.length && <span className="small muted">Keine weiteren eingebundenen Laufwerke unter {detected.dir} gefunden.</span>}
      </div>
      {edit && (
        <Modal title={edit.isNew ? 'Speicherort einbinden' : 'Speicherort'} onClose={() => setEdit(null)} footer={<>
          {!edit.isNew && <button className="btn danger" disabled={(info(edit.id)?.projects ?? 0) > 0} title={(info(edit.id)?.projects ?? 0) > 0 ? 'Es liegen noch Projekte dort' : ''}
            onClick={() => { set({ ...v, locations: locs.filter((l) => l.id !== edit.id), defaultLocation: v.defaultLocation === edit.id ? 'main' : v.defaultLocation }); setEdit(null); }}>Entfernen</button>}
          <span className="grow" /><button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
          <button className="btn primary" disabled={!edit.name.trim() || !/^[a-z0-9_-]+$/.test(edit.id)} onClick={() => {
            const { isNew, ...l } = edit;
            set({ ...v, locations: isNew ? [...locs, l] : locs.map((x) => (x.id === l.id ? l : x)) }); setEdit(null);
          }}>Übernehmen</button></>}>
          <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Ordner auf dem Server"><input className="mono" value={edit.path} disabled /></Field>
          <Field label="Netzwerkpfad für den Windows-Explorer" hint="z. B. \\nas01\konstruktion"><input className="mono" value={edit.networkPath} onChange={(e) => setEdit({ ...edit, networkPath: e.target.value })} /></Field>
          <Field label="Archiv" hint="abgeschlossene Projekte lassen sich hierher verschieben; neue Projekte landen nie im Archiv">
            <label className="row"><input type="checkbox" checked={edit.archive} onChange={(e) => setEdit({ ...edit, archive: e.target.checked })} /> Dies ist ein Archiv-Speicherort</label>
          </Field>
          {!edit.archive && <Field label="Neue Projekte dieser Abteilungen hier ablegen">
            {teams.map((t) => <label key={t.id} className="row small"><input type="checkbox" checked={edit.teamIds.includes(t.id)} onChange={() => setEdit({ ...edit, teamIds: edit.teamIds.includes(t.id) ? edit.teamIds.filter((x) => x !== t.id) : [...edit.teamIds, t.id] })} /> {t.name}</label>)}
          </Field>}
        </Modal>
      )}
    </Field>
  );
}

/** Ordnerbaum aus einer Pfadliste („01_CAD“, „01_CAD/Teile“) */
function FolderTree({ list, onChange }: { list: string[]; onChange: (l: string[]) => void }) {
  const [adding, setAdding] = useState<string | null>(null);
  const [name, setName] = useState('');
  // Elternordner fehlen ggf. in der Liste – für die Anzeige ergänzen
  const all = [...new Set(list.flatMap((p) => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort((a, b) => a.localeCompare(b, 'de'));
  const add = (parent: string) => {
    const n = name.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!n) return;
    const path = parent ? `${parent}/${n}` : n;
    if (!all.includes(path)) onChange([...list, path]);
    setName(''); setAdding(null);
  };
  const remove = (p: string) => {
    const rest = list.filter((x) => x !== p && !x.startsWith(`${p}/`));
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    // Elternordner behalten, auch wenn er nur über den entfernten Unterordner in der Liste stand
    onChange(parent && !rest.some((x) => x === parent || x.startsWith(`${parent}/`)) ? [...rest, parent] : rest);
  };
  const input = (parent: string) => (
    <div className="row" style={{ padding: 2, paddingLeft: parent ? (parent.split('/').length) * 20 + 4 : 4 }}>
      <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(parent)} placeholder={parent ? 'Unterordner, z. B. Teile' : 'z. B. 05_Einkauf'} autoFocus={adding !== null} />
      <button className="btn" disabled={!name.trim()} onClick={() => add(parent)}>Hinzufügen</button>
      {adding !== null && adding !== '' && <button className="btn ghost" onClick={() => setAdding(null)}>Abbrechen</button>}
    </div>
  );
  return (
    <div className="card flat" style={{ padding: 8 }}>
      {all.map((p) => (
        <div key={p}>
          <div className="row" style={{ padding: 2, paddingLeft: (p.split('/').length - 1) * 20 }}>
            <span className="mono grow"><Icon name="folder" /> {p.split('/').pop()}</span>
            <button className="btn ghost sm" title="Unterordner anlegen" onClick={() => { setAdding(p); setName(''); }}><Icon name="plus" /></button>
            <button className="btn ghost sm" title="Entfernen (mit Unterordnern)" onClick={() => remove(p)}><Icon name="x" /></button>
          </div>
          {adding === p && input(p)}
        </div>
      ))}
      {adding === null || adding === '' ? input('') : null}
      <div className="hint">Gilt für neu angelegte Projekte. Bestehende Projektordner bleiben unverändert.</div>
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
      <h2 style={{ marginBottom: 6 }}><Icon name="search" /> Bestandsordner einlesen (Scan-Assistent)</h2>
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
              <td><a style={{ cursor: 'pointer' }} onClick={() => setPath(e.path)}><Icon name="folder" /> {e.name}</a></td>
              <td className="small muted">{e.folders} Ordner, {e.files} Dateien</td>
              <td className="small muted">{fmtDate(e.modified)}</td>
              <td>{e.linkedProject ? <Pill tone="green">Projekt {e.linkedProject.number}</Pill> : <Pill tone="amber">nicht zugeordnet</Pill>}</td>
              <td>{!e.linkedProject && <button className="btn sm" onClick={() => setImp({ path: e.path, name: e.suggestion.name, number: e.suggestion.number ?? '', teamId: '', rename: true, createFolders: true, moveToProjects: false })}>Als Projekt übernehmen</button>}</td>
            </tr>
          ))}
          {data?.entries?.length === 0 && <tr><td colSpan={5} className="muted">Keine Unterordner</td></tr>}
        </tbody>
      </table></div>
      {result && <div className="card" style={{ marginTop: 12, borderColor: 'var(--green)' }}><Icon name="check-circle" /> Projekt {result.number} angelegt ({result.files} Dateien übernommen) – Ordner: <span className="mono">{result.folderPath}</span></div>}
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
            <Field label="Team"><select value={imp.teamId} onChange={(e) => setImp({ ...imp, teamId: e.target.value })}><option value="">–</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
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
/** Speichermaske für CAD- und PCB-Bridge: gleiche Seite, je ein Reiter */
export function CadMaskSettings() {
  const [tab, setTab] = useState<'cad' | 'pcb'>(() => (new URLSearchParams(location.search).get('tab') === 'pcb' ? 'pcb' : 'cad'));
  return (
    <div>
      <h1 style={{ marginBottom: 6 }}>Speichermaske</h1>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab ${tab === 'cad' ? 'active' : ''}`} onClick={() => setTab('cad')}><Icon name="cad" /> CAD (SolidWorks)</button>
        <button className={`tab ${tab === 'pcb' ? 'active' : ''}`} onClick={() => setTab('pcb')}><Icon name="bolt" /> PCB (KiCad)</button>
      </div>
      {tab === 'cad' ? <CadMaskTab /> : <PcbMaskTab />}
    </div>
  );
}

/** Felder und Dropdown-Kataloge – für CAD und PCB gemeinsam */
function MaskEditor({ v, set, propLabel, appliesTo }: { v: any; set: (v: any) => void; propLabel: string; appliesTo: boolean }) {
  const [catalog, setCatalog] = useState<string | null>(null);
  const setField = (i: number, f: any) => set({ ...v, fields: v.fields.map((x: any, j: number) => (j === i ? f : x)) });
  const move = (i: number, d: number) => { const n = [...v.fields]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; set({ ...v, fields: n }); };
  const cat = v.catalogs.find((c: any) => c.name === catalog);
  return (
    <>
      <h2 style={{ margin: '18px 0 8px' }}>Felder</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th /><th>{propLabel}</th><th>Bezeichnung</th><th>Typ</th><th>Katalog</th><th>Pflicht</th>{appliesTo && <th>Gilt für</th>}<th>Vorgabe</th><th /></tr></thead>
        <tbody>{v.fields.map((f: any, i: number) => (
          <tr key={i}>
            <td style={{ whiteSpace: 'nowrap' }}><button className="btn ghost sm" onClick={() => move(i, -1)}>↑</button><button className="btn ghost sm" onClick={() => move(i, 1)}>↓</button></td>
            <td><input className="mono" style={{ minWidth: 130 }} value={f.key} onChange={(e) => setField(i, { ...f, key: e.target.value.replace(/\s/g, '') })} /></td>
            <td><input style={{ minWidth: 150 }} value={f.label} onChange={(e) => setField(i, { ...f, label: e.target.value })} /></td>
            <td><select style={{ minWidth: 130 }} value={f.type} onChange={(e) => setField(i, { ...f, type: e.target.value })}>{FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
            <td>{f.type === 'select' ? <select style={{ minWidth: 140 }} value={f.catalog ?? ''} onChange={(e) => setField(i, { ...f, catalog: e.target.value })}><option value="">–</option>{v.catalogs.map((c: any) => <option key={c.name} value={c.name}>{c.label}</option>)}</select> : ''}</td>
            <td><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { ...f, required: e.target.checked })} /></td>
            {appliesTo && <td style={{ whiteSpace: 'nowrap' }}>{TYPES.map(([k, l]) => (
              <label key={k} className="small" style={{ marginRight: 6 }}><input type="checkbox" checked={!f.appliesTo || f.appliesTo.includes(k)} onChange={(e) => {
                const cur: string[] = f.appliesTo ?? TYPES.map((t) => t[0]);
                const next = e.target.checked ? [...cur, k] : cur.filter((x) => x !== k);
                setField(i, { ...f, appliesTo: next.length === 3 ? undefined : next });
              }} /> {l}</label>
            ))}</td>}
            <td><input style={{ minWidth: 90 }} value={f.defaultValue ?? ''} onChange={(e) => setField(i, { ...f, defaultValue: e.target.value || undefined })} /></td>
            <td><button className="btn ghost sm" onClick={() => set({ ...v, fields: v.fields.filter((_: any, j: number) => j !== i) })}><Icon name="x" /></button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button className="btn" style={{ marginTop: 8 }} onClick={() => set({ ...v, fields: [...v.fields, { key: 'NeuesFeld', label: 'Neues Feld', type: 'text', required: false }] })}>＋ Feld hinzufügen</button>

      <h2 style={{ margin: '24px 0 8px' }}>Dropdown-Kataloge</h2>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {v.catalogs.map((c: any) => <button key={c.name} className={`btn sm ${catalog === c.name ? 'primary' : ''}`} onClick={() => setCatalog(c.name)}>{c.label} ({c.values.length})</button>)}
        <button className="btn sm" onClick={() => { const name = prompt('Interner Name (ohne Leerzeichen)'); if (name) { set({ ...v, catalogs: [...v.catalogs, { name, label: name, values: [] }] }); setCatalog(name); } }}>＋ Katalog</button>
      </div>
      {cat && (
        <div className="card flat">
          <div className="grid2"><Field label="Bezeichnung"><input value={cat.label} onChange={(e) => set({ ...v, catalogs: v.catalogs.map((c: any) => (c.name === cat.name ? { ...c, label: e.target.value } : c)) })} /></Field></div>
          <Field label="Einträge (einer pro Zeile)">
            <textarea rows={8} value={cat.values.join('\n')} onChange={(e) => set({ ...v, catalogs: v.catalogs.map((c: any) => (c.name === cat.name ? { ...c, values: e.target.value.split('\n').map((x: string) => x.trim()).filter(Boolean) } : c)) })} />
          </Field>
        </div>
      )}
    </>
  );
}

function CadMaskTab() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('cadMask');
  if (!s.value) return null;
  const v = s.value;
  return (
    <div>
      <p className="muted">Legen Sie fest, welche Felder die Konstrukteure beim Speichern in SolidWorks ausfüllen. Jedes Feld wird als Custom Property in die Datei geschrieben und erscheint so im Schriftkopf.</p>
      <MaskEditor v={v} set={s.setValue} propLabel="Eigenschaft (SolidWorks)" appliesTo />

      <h2 style={{ margin: '24px 0 8px' }}>Unterbaugruppen (Nummernbereiche)</h2>
      <div className="card flat" style={{ padding: 8, maxWidth: 520 }}>
        {v.subassemblies.map((sa: any, i: number) => (
          <div key={i} className="row" style={{ marginBottom: 4 }}>
            <input className="mono" style={{ width: 80 }} value={sa.code} maxLength={3} onChange={(e) => s.setValue({ ...v, subassemblies: v.subassemblies.map((x: any, j: number) => (j === i ? { ...x, code: e.target.value.replace(/\D/g, '') } : x)) })} />
            <input value={sa.label} onChange={(e) => s.setValue({ ...v, subassemblies: v.subassemblies.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <button className="btn ghost sm" onClick={() => s.setValue({ ...v, subassemblies: v.subassemblies.filter((_: any, j: number) => j !== i) })}><Icon name="x" /></button>
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

function PcbMaskTab() {
  const act = useAction();
  const s = useAdminSettings('pcbMask');
  if (!s.value) return null;
  const v = s.value;
  const err = validatePcbPattern(v.numberPattern);
  return (
    <div>
      <p className="muted">Felder, die beim Anlegen einer Leiterplatte (neues KiCad-Projekt) ausgefüllt werden. Sie landen als Textvariablen im KiCad-Projekt (z. B. <span className="mono">{'${APERIO_LAGEN}'}</span>) und können so im Schriftfeld erscheinen.</p>
      <div className="grid2">
        <Field label="Aufbau der Nummer" hint={err ?? `Beispiel: ${pcbFullNumber(pcbNumber(v.numberPattern, '0100', 1), 0)} – {PROJEKT} = Projektnummer, {NN} = laufende Nummer, der Versionsstand wird angehängt`}>
          <input className="mono" value={v.numberPattern} onChange={(e) => s.setValue({ ...v, numberPattern: e.target.value })} />
        </Field>
        <Field label="Ordner im Projekt"><input className="mono" value={v.folder} onChange={(e) => s.setValue({ ...v, folder: e.target.value })} /></Field>
      </div>
      <Field label="Fertigungsdaten bei der Freigabe">
        <div className="row wrap">{PCB_EXPORT_FORMATS.map((f) => (
          <label key={f} className="row small"><input type="checkbox" checked={v.exportFormats.includes(f)} onChange={(e) => s.setValue({ ...v, exportFormats: e.target.checked ? [...v.exportFormats, f] : v.exportFormats.filter((x: string) => x !== f) })} /> {PCB_EXPORT_LABELS[f]}</label>
        ))}</div>
      </Field>
      <MaskEditor v={v} set={s.setValue} propLabel="Variable (KiCad)" appliesTo={false} />
      <div className="spacer" />
      <button className="btn primary" disabled={Boolean(err)} onClick={() => act(() => s.save(v), 'Speichermaske gespeichert')}>Speichern</button>
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
        {data?.map((h) => <tr key={h.day}><td className="mono">{fmtDate(h.day)}</td><td>{h.name}</td><td style={{ width: 50 }}><button className="btn ghost sm" onClick={() => save(data.filter((x) => x.day !== h.day))}><Icon name="x" /></button></td></tr>)}
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
        <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await act(() => post('/backups', {}), 'Sicherung erstellt'); setBusy(false); reload(); }}>{busy ? 'Sichert …' : 'Jetzt sichern'}</button>
        <label className="btn"><Icon name="upload" /> Sicherung hochladen<input type="file" accept=".apb" hidden onChange={async (e) => {
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
              <a className="btn sm" href={`/api/backups/${b.name}`}><Icon name="download" /></a>{' '}
              <button className="btn sm" onClick={async () => { const pass = prompt('Passwort der Sicherung (leer = aktuelles)') ?? ''; setBusy(true); const r = await act(() => post(`/backups/${b.name}/analyze`, { passphrase: pass || undefined })); setBusy(false); if (r) setAnalysis(r); }}>Einspielen …</button>{' '}
              <button className="btn sm danger" onClick={() => setRemove(b.name)}><Icon name="trash" /></button>
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
        <div className="card" style={{ borderColor: 'var(--green)' }}><Icon name="check-circle" /> {result.inserted} Einträge neu übernommen, {result.updated} mit dem Stand der Sicherung überschrieben, {result.skipped} unverändert, {result.files} Dateien wiederhergestellt.</div>
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
          <button className="btn" onClick={() => { reload(); reloadStatus(); }}><Icon name="refresh" /> Prüfen</button></div>
        {check?.error && <div className="error-text">{check.error}</div>}
        {check?.updateAvailable ? (
          <div style={{ marginTop: 12 }}>
            <Pill tone="green">Neue Version verfügbar</Pill>
            {check.notes && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--bg-soft)', padding: 10, borderRadius: 8 }}>{check.notes}</pre>}
            <div className="spacer" />
            <button className="btn primary" disabled={busy || !status?.available} onClick={async () => { setBusy(true); await act(() => post('/system/update', { ref: check.ref, backupFirst: true }), 'Aktualisierung gestartet'); setBusy(false); setTimeout(reloadStatus, 3000); }}><Icon name="upload" /> Jetzt auf {check.latest} aktualisieren</button>
            {!status?.available && <div className="hint">Der Updater-Dienst ist nur bei der Docker-Installation verfügbar.</div>}
          </div>
        ) : check && !check.error && <div style={{ marginTop: 10 }}><Pill tone="green"><Icon name="check" /> AperioPlan ist aktuell</Pill></div>}
      </div>
      {status?.status && (
        <div className="card">
          <b>Letzte Aktualisierung:</b> {status.status.ref} – {status.status.status === 'running' ? 'läuft' : status.status.status === 'done' ? 'erfolgreich' : 'fehlgeschlagen'} ({fmtDateTime(status.status.at)})
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

interface AiKindInfo { kind: string; name: string; baseUrl: string; online: boolean; models: string[] }

export function AiSettings() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('ai');
  const { data: kinds } = useApi<AiKindInfo[]>('/settings/ai/kinds');
  const [edit, setEdit] = useState<{ p: any; index: number } | null>(null);
  if (!s.value || !kinds) return null;
  const v = s.value;
  // frühere Einzel-Einstellung als ersten Anbieter anzeigen
  const providers: any[] = v.providers?.length ? v.providers : v.baseUrl || v.model ? [{ id: 'standard', name: 'KI', kind: v.provider === 'anthropic' ? 'anthropic' : 'ollama', baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, online: v.provider === 'anthropic' }] : [];
  const setProviders = (list: any[]) => s.setValue({ ...v, providers: list, defaultProviderId: list.some((x) => x.id === v.defaultProviderId) ? v.defaultProviderId : list[0]?.id ?? null });
  const kindName = (k: string) => kinds.find((x) => x.kind === k)?.name ?? k;
  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={{ marginBottom: 8 }}>KI-Anbindung</h1>
      <p className="muted">Mehrere Anbieter lassen sich parallel hinterlegen: ein eigenes Modell im Firmennetz (Ollama, LM Studio, vLLM – Daten bleiben im Haus) und Online-Dienste wie Google Gemini, ChatGPT, Claude, Mistral oder Azure. Je Projekt kann ein anderer Anbieter gewählt werden, etwa das eigene Modell für vertrauliche Kundenprojekte.</p>
      <label className="row" style={{ margin: '12px 0' }}><input type="checkbox" checked={v.enabled} onChange={(e) => s.setValue({ ...v, enabled: e.target.checked })} /> KI-Funktionen aktivieren</label>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Name</th><th>Art</th><th>Modell</th><th>Daten</th><th>Standard</th><th /></tr></thead>
        <tbody>
          {providers.map((p, i) => (
            <tr key={p.id}>
              <td><b>{p.name}</b></td><td className="small">{kindName(p.kind)}</td><td className="mono small">{p.kind === 'azure' ? p.deployment : p.model}</td>
              <td>{p.online ? <Pill tone="amber">online</Pill> : <Pill tone="green">eigenes Netz</Pill>}</td>
              <td><input type="radio" name="defai" checked={(v.defaultProviderId ?? providers[0]?.id) === p.id} onChange={() => s.setValue({ ...v, providers, defaultProviderId: p.id })} /></td>
              <td className="row"><button className="btn ghost sm" onClick={() => setEdit({ p: { ...p }, index: i })}><Icon name="edit" /></button>
                <button className="btn ghost sm" onClick={() => setProviders(providers.filter((_, j) => j !== i))}><Icon name="trash" /></button></td>
            </tr>
          ))}
          {!providers.length && <tr><td colSpan={6} className="muted">Noch kein Anbieter hinterlegt.</td></tr>}
        </tbody>
      </table></div>
      <div className="row" style={{ marginTop: 10 }}>
        <select value="" style={{ width: 'auto' }} onChange={(e) => { const k = kinds.find((x) => x.kind === e.target.value); if (k) setEdit({ index: -1, p: { id: Math.random().toString(36).slice(2, 10), name: k.name, kind: k.kind, baseUrl: k.baseUrl, apiKey: '', model: k.models[0] ?? '', online: k.online, deployment: '', apiVersion: '' } }); }}>
          <option value="">＋ Anbieter hinzufügen …</option>{kinds.map((k) => <option key={k.kind} value={k.kind}>{k.name}</option>)}
        </select>
        <button className="btn primary" onClick={async () => { await act(() => s.save({ ...v, providers }), 'Gespeichert'); refreshLists(); invalidate('/ai/providers'); }}>Speichern</button>
      </div>
      <p className="hint">Hinweis: Bei Online-Anbietern werden die abgefragten Projektdaten an den Dienst übertragen. Für personenbezogene Daten ist ein Auftragsverarbeitungsvertrag mit dem Anbieter nötig.</p>
      {edit && <AiProviderModal init={edit.p} kind={kinds.find((k) => k.kind === edit.p.kind)!} onClose={() => setEdit(null)}
        onSave={(p) => { setProviders(edit.index < 0 ? [...providers, p] : providers.map((x, j) => (j === edit.index ? p : x))); setEdit(null); }} />}
    </div>
  );
}

function AiProviderModal({ init, kind, onClose, onSave }: { init: any; kind: AiKindInfo; onClose: () => void; onSave: (p: any) => void }) {
  const act = useAction();
  const [p, setP] = useState(init);
  const [models, setModels] = useState<string[]>(kind.models);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setP({ ...p, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  const azure = p.kind === 'azure';
  return (
    <Modal title={kind.name} onClose={onClose} footer={<>
      <button className="btn" onClick={async () => { setResult(null); const r = await act(() => post<{ ok: boolean; message: string }>('/settings/ai/test', p)); if (r) setResult(r); }}>Verbindung testen</button>
      <span className="grow" /><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!p.name.trim() || (!azure && !p.model)} onClick={() => onSave(p)}>Übernehmen</button></>}>
      <Field label="Bezeichnung" hint="so erscheint der Anbieter bei der Auswahl"><input value={p.name} onChange={set('name')} /></Field>
      <Field label="Adresse" hint={azure ? 'z. B. https://firmenname.openai.azure.com' : p.kind === 'ollama' ? 'z. B. http://ki-server:11434/v1' : 'normalerweise nicht ändern'}><input className="mono" value={p.baseUrl} onChange={set('baseUrl')} /></Field>
      <Field label="API-Schlüssel" hint={p.online ? 'beim Anbieter im Kundenkonto erzeugen' : 'bei eigenen Modellen meist leer'}><input type="password" value={p.apiKey} onChange={set('apiKey')} autoComplete="new-password" /></Field>
      {azure ? (
        <div className="grid2">
          <Field label="Name der Bereitstellung (Deployment)"><input value={p.deployment ?? ''} onChange={set('deployment')} /></Field>
          <Field label="API-Version"><input value={p.apiVersion ?? ''} onChange={set('apiVersion')} placeholder="2024-10-21" /></Field>
        </div>
      ) : (
        <Field label="Modell">
          <div className="row">
            <input list="ai-models" value={p.model} onChange={set('model')} />
            <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            <button className="btn" title="Verfügbare Modelle beim Anbieter abfragen" onClick={async () => { const r = await act(() => post<{ ok: boolean; models: string[]; message?: string }>('/settings/ai/models', p)); if (r?.ok) setModels(r.models); else if (r) setResult({ ok: false, message: r.message ?? 'Keine Modelle gefunden' }); }}><Icon name="refresh" /> Modelle laden</button>
          </div>
        </Field>
      )}
      <label className="row"><input type="checkbox" checked={p.online} onChange={set('online')} /> Online-Anbieter (Daten verlassen das Firmennetz)</label>
      {result && <div className="card" style={{ marginTop: 12, borderColor: result.ok ? 'var(--green)' : 'var(--red)' }}>{result.ok ? 'Verbindung in Ordnung: ' : 'Fehler: '}{result.message}</div>}
    </Modal>
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
            <button className="btn ghost sm" onClick={() => hooks.setValue(hooks.value.filter((_: any, j: number) => j !== i))}><Icon name="x" /></button>
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

const RES_COLORS = ['#4f46e5', '#0e9f6e', '#d97706', '#db2777', '#0891b2', '#7c3aed', '#dc2626', '#65a30d'];

/** Ressourcen (Räume, Fahrzeuge, Geräte) anlegen und verwalten */
export function ResourcesSettings() {
  const act = useAction();
  const { users, teams } = useSession();
  const { data, reload } = useApi<any[]>('/resources');
  const { data: types, reload: reloadTypes } = useResourceTypes();
  const [edit, setEdit] = useState<any | null>(null);
  const [remove, setRemove] = useState<any | null>(null);
  const [typeEdit, setTypeEdit] = useState<Partial<ResourceType> | null>(null);
  const typeOf = (k: string) => types?.find((t) => t.key === k);
  const blank = { extra: {}, name: '', kind: 'room', location: '', capacity: '', description: '', color: RES_COLORS[0], requiresApproval: false, approverId: '', allowedTeamIds: [] as string[], active: true };
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
              <td>{typeOf(r.kind)?.name ?? r.kind}</td>
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
            const body = { extra: edit.extra ?? {}, name: edit.name, kind: edit.kind, location: edit.location, capacity: edit.capacity === '' ? null : Number(edit.capacity), description: edit.description,
              color: edit.color, requiresApproval: edit.requiresApproval, approverId: edit.approverId || null, allowedTeamIds: edit.allowedTeamIds, active: edit.active };
            const ok = await act(() => (edit.id ? patch(`/resources/${edit.id}`, body) : post('/resources', body)), 'Gespeichert');
            if (ok) { setEdit(null); reload(); }
          }}>Speichern</button>
        </>}>
          <div className="grid2">
            <Field label="Name" required><input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="z. B. Besprechungsraum 1, VW Caddy KN-AP 123" /></Field>
            <Field label="Art"><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{types?.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
            <Field label="Ort"><input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} placeholder="z. B. Erdgeschoss, Parkplatz 3" /></Field>
            <Field label={edit.kind === 'vehicle' ? 'Sitze' : 'Plätze'}><input type="number" min={0} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></Field>
          </div>
          {(typeOf(edit.kind)?.fields ?? []).filter((f) => f.when === 'resource').length > 0 && (
            <div className="grid2">{typeOf(edit.kind)!.fields.filter((f) => f.when === 'resource').map((f) => (
              <Field key={f.key} label={f.label}><input type={f.type} value={edit.extra?.[f.key] ?? ''} onChange={(e) => setEdit({ ...edit, extra: { ...edit.extra, [f.key]: f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value } })} /></Field>
            ))}</div>
          )}
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

      <div className="page-head" style={{ marginTop: 32 }}><div><h2>Ressourcenarten</h2><div className="sub">Eigene Arten mit Symbol und Zusatzfeldern, z. B. Kennzeichen oder Kilometerstand bei Rückgabe.</div></div>
        <div className="actions"><button className="btn" onClick={() => setTypeEdit({ name: '', icon: 'box', color: RES_COLORS[0], fields: [] })}><Icon name="plus" /> Art anlegen</button></div></div>
      <div className="card-grid">
        {types?.map((t) => (
          <div key={t.key} className="card click" onClick={() => setTypeEdit({ ...t })}>
            <div className="card-title"><span className="resource-icon" style={{ color: t.color, background: `${t.color}1f` }}><Icon name={t.icon} /></span><h3>{t.name}</h3></div>
            <div className="small muted">{t.resourceCount ?? 0} Ressourcen{t.fields.length ? ` · Felder: ${t.fields.map((f) => f.label).join(', ')}` : ''}</div>
          </div>
        ))}
      </div>
      {typeEdit && <ResourceTypeModal type={typeEdit} onClose={() => setTypeEdit(null)} onSaved={() => { setTypeEdit(null); void reloadTypes(); }} />}
    </div>
  );
}

function ResourceTypeModal({ type, onClose, onSaved }: { type: Partial<ResourceType>; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [t, setT] = useState(type);
  const [confirm, setConfirm] = useState(false);
  const fields = t.fields ?? [];
  const setField = (i: number, patchF: Partial<ResourceType['fields'][number]>) => setT({ ...t, fields: fields.map((f, j) => (j === i ? { ...f, ...patchF } : f)) });
  const slug = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'feld';
  return (
    <Modal title={t.key ? `Art „${t.name}“` : 'Neue Ressourcenart'} onClose={onClose} footer={<>
      {t.key && <button className="btn danger" onClick={() => setConfirm(true)}>Löschen</button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!t.name?.trim()} onClick={async () => {
        const body = { name: t.name, icon: t.icon, color: t.color, fields: fields.filter((f) => f.label.trim()).map((f) => ({ ...f, key: f.key || slug(f.label) })) };
        if (await act(() => (t.key ? patch(`/resource-types/${t.key}`, body) : post('/resource-types', body)), 'Gespeichert')) onSaved();
      }}>Speichern</button>
    </>}>
      <div className="grid2">
        <Field label="Name" required><input autoFocus value={t.name ?? ''} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="z. B. Stapler, Messtechnik, Laptop" /></Field>
        <Field label="Symbol"><IconPicker value={t.icon} onChange={(icon) => setT({ ...t, icon })} /></Field>
      </div>
      <Field label="Farbe"><div className="row">{RES_COLORS.map((c) => <button key={c} className="btn sm" onClick={() => setT({ ...t, color: c })} style={{ width: 28, height: 28, padding: 0, background: c, outline: t.color === c ? '2px solid var(--text)' : undefined, outlineOffset: 2 }} aria-label={c} />)}</div></Field>
      <Field label="Zusatzfelder" hint="„an der Ressource“ trägt der Administrator ein, „bei Rückgabe“ der Buchende">
        {fields.map((f, i) => (
          <div key={i} className="row" style={{ marginBottom: 6 }}>
            <input value={f.label} placeholder="Bezeichnung" onChange={(e) => setField(i, { label: e.target.value })} />
            <select value={f.type} style={{ width: 'auto' }} onChange={(e) => setField(i, { type: e.target.value as 'text' })}><option value="text">Text</option><option value="number">Zahl</option><option value="date">Datum</option></select>
            <select value={f.when} style={{ width: 'auto' }} onChange={(e) => setField(i, { when: e.target.value as 'resource' })}><option value="resource">an der Ressource</option><option value="return">bei Rückgabe</option></select>
            <button className="btn ghost sm" onClick={() => setT({ ...t, fields: fields.filter((_, j) => j !== i) })}><Icon name="x" /></button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setT({ ...t, fields: [...fields, { key: '', label: '', type: 'text', when: 'resource' }] })}><Icon name="plus" /> Feld</button>
      </Field>
      {confirm && <Confirm danger text={`Art „${t.name}“ löschen? Das geht nur, wenn keine Ressource sie verwendet.`} confirmLabel="Löschen" onClose={() => setConfirm(false)}
        onConfirm={async () => { if (await act(() => del(`/resource-types/${t.key}`), 'Gelöscht')) onSaved(); }} />}
    </Modal>
  );
}
