import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post, upload, invalidate, get } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession, type PublicSettings } from '../session';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { CAD_STATE_META, Confirm, Empty, Field, Modal, Pill, SlideOver, StatusPill, Tabs, useAction, useToast } from '../components/ui';
import { Comments } from '../components/TaskPanel';
import { Icon } from '../components/Icon';

export interface CadItem {
  id: string; projectId: string; projectNumber: string; projectName: string; type: 'part' | 'assembly' | 'drawing';
  baseNumber: string; number: string; revision: number; revisionLabel: string; designation: string; state: string; procurement: string;
  properties: Record<string, string>; drawingOf: string | null; drawingId: string | null; drawingState: string | null;
  filePath: string | null; fileName: string | null; checkedOutBy: string | null; checkedOutByName: string | null; checkedOutAt: string | null;
  checkoutHost: string | null; usedInCount: number; childCount: number; updatedAt: string; createdByName: string;
}

export const TYPE_META: Record<string, { label: string; icon: string }> = {
  part: { label: 'Teil', icon: 'part' }, assembly: { label: 'Baugruppe', icon: 'assembly' }, drawing: { label: 'Zeichnung', icon: 'drawing' },
};
const PROC: Record<string, string> = { make: 'Eigenfertigung', buy: 'Kaufteil', standard: 'Normteil' };
const STATE_ACTION: Record<string, string> = { review: 'Zur Prüfung', released: 'Freigeben', in_work: 'Zurück in Arbeit', obsolete: 'Ungültig setzen' };

/** CAD-Bridge: alle Baugruppen, Teile und Zeichnungen – optional auf ein Projekt beschränkt */
export function CadCenter({ projectId, canEdit = true }: { projectId?: string; canEdit?: boolean }) {
  const [params, setParams] = useSearchParams();
  const { me } = useSession();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [type, setType] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams();
  if (projectId) qs.set('projectId', projectId);
  if (q) qs.set('q', q);
  if (state) qs.set('state', state);
  if (type) qs.set('type', type);
  if (mine) qs.set('checkedOut', 'me');
  const { data, reload } = useApi<CadItem[]>(`/cad/items?${qs}`);
  const itemId = params.get('item');
  const open = (id: string | null) => { if (id) params.set('item', id); else params.delete('item'); setParams(params); };

  useEffect(() => {
    if (!projectId) return;
    return realtime.subscribe(`project:${projectId}`, (e) => { if (e === 'cad.changed') { void reload(); invalidate('/cad/items/'); } });
  }, [projectId, reload]);

  const items = data ?? [];
  const drawingsOf = useMemo(() => new Map(items.filter((i) => i.type === 'drawing' && i.drawingOf).map((d) => [d.drawingOf!, d])), [items]);
  const rows = items.filter((i) => type === 'drawing' || state || q || i.type !== 'drawing' || !i.drawingOf || !items.some((x) => x.id === i.drawingOf));

  return (
    <div>
      <div className="toolbar">
        <input placeholder="Nummer, Benennung, Werkstoff …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        <select value={type} onChange={(e) => setType(e.target.value)}><option value="">Alle Typen</option>{Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select value={state} onChange={(e) => setState(e.target.value)}><option value="">Alle Status</option>{Object.entries(CAD_STATE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> von mir ausgecheckt</label>
        <span className="muted small">{items.length} Einträge</span>
        {canEdit && me?.role !== 'guest' && <button className="btn primary right" onClick={() => setCreating(true)}>＋ Neue Nummer</button>}
      </div>
      {!rows.length ? <Empty icon="cad" title="Noch keine CAD-Daten">Teile und Baugruppen werden beim Speichern in SolidWorks über den CAD-Wächter angelegt – oder hier über „Neue Nummer“.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nummer</th><th>Benennung</th><th>Typ</th>{!projectId && <th>Projekt</th>}<th>Status</th><th>Zeichnung</th><th>Werkstoff</th><th>Beschaffung</th><th>Sperre</th><th>Geändert</th></tr></thead>
          <tbody>{rows.map((i) => {
            const dwg = drawingsOf.get(i.id);
            return (
              <tr key={i.id} className="click" onClick={() => open(i.id)}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{i.baseNumber}-<b>{i.revisionLabel}</b></td>
                <td>{i.designation}</td>
                <td><span className="row" style={{ gap: 6 }}><Icon name={TYPE_META[i.type]!.icon} /> {TYPE_META[i.type]!.label}</span></td>
                {!projectId && <td className="mono small">{i.projectNumber}</td>}
                <td><StatusPill status={i.state} meta={CAD_STATE_META} /></td>
                <td onClick={(e) => { if (dwg) { e.stopPropagation(); open(dwg.id); } }}>{dwg ? <StatusPill status={dwg.state} meta={CAD_STATE_META} /> : i.type === 'drawing' ? '' : <span className="muted small">–</span>}</td>
                <td className="small">{i.properties.Werkstoff ?? ''}</td>
                <td className="small">{PROC[i.procurement]}</td>
                <td>{i.checkedOutBy ? <Pill tone="amber"><Icon name="lock" /> {i.checkedOutByName}</Pill> : ''}</td>
                <td className="small muted">{fmtDateTime(i.updatedAt)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {itemId && <CadItemPanel id={itemId} onClose={() => open(null)} onOpen={open} onChanged={reload} />}
      {creating && <SaveMaskDialog projectId={projectId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); reload(); open(id); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Speichermaske (Web-Variante)
export function MaskFields({ mask, type, values, onChange }: { mask: Pick<PublicSettings['cadMask'], 'fields' | 'catalogs'>; type: string; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const fields = mask.fields.filter((f) => !f.appliesTo || f.appliesTo.includes(type));
  return (
    <div className="grid2">
      {fields.map((f) => {
        const v = values[f.key] ?? '';
        const set = (x: string) => onChange({ ...values, [f.key]: x });
        const catalog = mask.catalogs.find((c) => c.name === f.catalog);
        return (
          <Field key={f.key} label={f.label} required={f.required}>
            {f.type === 'select' ? (
              <select value={v} onChange={(e) => set(e.target.value)}><option value="">–</option>{catalog?.values.map((c) => <option key={c}>{c}</option>)}</select>
            ) : f.type === 'textarea' ? <textarea value={v} onChange={(e) => set(e.target.value)} />
              : f.type === 'checkbox' ? <input type="checkbox" checked={v === 'Ja'} onChange={(e) => set(e.target.checked ? 'Ja' : 'Nein')} />
              : <input type={f.type === 'number' ? 'number' : 'text'} value={v} onChange={(e) => set(e.target.value)} />}
          </Field>
        );
      })}
    </div>
  );
}

function SaveMaskDialog({ projectId, onClose, onCreated }: { projectId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { settings, me } = useSession();
  const act = useAction();
  const mask = settings!.cadMask;
  const { data: projects } = useApi<any[]>('/projects');
  const [d, setD] = useState({ projectId: projectId ?? '', type: 'part', sub: mask.subassemblies[0]?.code ?? '100', subsub: '00', designation: '', procurement: 'make', createDrawing: mask.askCreateDrawing });
  const defaults = Object.fromEntries(mask.fields.filter((f) => f.defaultValue).map((f) => [f.key, f.defaultValue!]));
  const [props, setProps] = useState<Record<string, string>>({ ...defaults, Gezeichnet: me!.displayName });
  const [preview, setPreview] = useState<string>('');
  useEffect(() => {
    if (!d.projectId) return;
    const id = setTimeout(() => {
      post('/cad/numbers/preview', { projectId: d.projectId, sub: Number(d.sub), subsub: Number(d.subsub), designation: d.designation || 'Benennung' })
        .then((r) => setPreview(r.fileStem)).catch(() => setPreview(''));
    }, 200);
    return () => clearTimeout(id);
  }, [d.projectId, d.sub, d.subsub, d.designation]);
  const ext = { part: '.sldprt', assembly: '.sldasm', drawing: '.slddrw' }[d.type];
  return (
    <Modal size="lg" title="Speichermaske – neue CAD-Nummer" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.projectId || !d.designation.trim()} onClick={async () => {
        const r = await act(() => post('/cad/items', {
          projectId: d.projectId, type: d.type, sub: Number(d.sub), subsub: Number(d.subsub), designation: d.designation,
          procurement: d.procurement, properties: props, createDrawing: d.type !== 'drawing' && d.createDrawing, checkout: true,
        }));
        if (r) onCreated(r.item.id);
      }}>Nummer vergeben</button>
    </>}>
      <div className="grid3">
        <Field label="Projekt" required>
          <select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })} disabled={Boolean(projectId)}>
            <option value="">–</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
          </select>
        </Field>
        <Field label="Dateityp"><select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })}><option value="part"><Icon name="settings" /> Teil (.sldprt)</option><option value="assembly"><Icon name="assembly" /> Baugruppe (.sldasm)</option></select></Field>
        <Field label="Beschaffungsart"><select value={d.procurement} onChange={(e) => setD({ ...d, procurement: e.target.value })}>{Object.entries(PROC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Unterbaugruppe">
          <select value={d.sub} onChange={(e) => setD({ ...d, sub: e.target.value })}>
            {mask.subassemblies.map((s) => <option key={s.code} value={s.code}>{s.code} – {s.label}</option>)}
            {!mask.subassemblies.some((s) => s.code === d.sub) && <option value={d.sub}>{d.sub}</option>}
          </select>
        </Field>
        <Field label="Unter-Unterbaugruppe"><input value={d.subsub} maxLength={2} onChange={(e) => setD({ ...d, subsub: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Sprechende Benennung" required><input value={d.designation} onChange={(e) => setD({ ...d, designation: e.target.value })} placeholder="z. B. Rahmen" /></Field>
      </div>
      {preview && <div className="card flat" style={{ marginBottom: 14 }}><span className="muted small">Vorschau Dateiname</span><div className="mono" style={{ fontSize: 16 }}>{preview}{ext}</div></div>}
      <MaskFields mask={mask} type={d.type} values={props} onChange={setProps} />
      {d.type !== 'drawing' && <label className="row"><input type="checkbox" checked={d.createDrawing} onChange={(e) => setD({ ...d, createDrawing: e.target.checked })} /> Passende 2D-Zeichnung (.slddrw) mit gleicher Nummer anlegen</label>}
    </Modal>
  );
}

// ---------------------------------------------------------------- Detail-Fenster
function CadItemPanel({ id, onClose, onOpen, onChanged }: { id: string; onClose: () => void; onOpen: (id: string) => void; onChanged: () => void }) {
  const { data: item, reload } = useApi<any>(`/cad/items/${id}`);
  const { me, settings } = useSession();
  const act = useAction();
  const toast = useToast();
  const [tab, setTab] = useTabState<'props' | 'bom' | 'used' | 'history' | 'comments'>('cad-item', 'props', 'itemTab');
  const [stateTo, setStateTo] = useState<string | null>(null);
  const [revise, setRevise] = useState(false);
  const [remove, setRemove] = useState(false);
  const [editProps, setEditProps] = useState<Record<string, string> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [comment, setComment] = useState('');
  useEffect(() => { setEditProps(null); }, [id]);
  if (!item) return <SlideOver title="…" onClose={onClose}><div className="muted">Wird geladen …</div></SlideOver>;

  const refresh = () => { void reload(); onChanged(); invalidate('/cad/items'); };
  const mineLocked = item.checkedOutBy === me?.id;
  const ext = item.fileName?.split('.').pop();

  return (
    <SlideOver wide onClose={onClose}
      title={<div><div className="row"><Icon name={TYPE_META[item.type]!.icon} size={20} /><b className="mono" style={{ fontSize: 16 }}>{item.number}</b></div>
        <div className="row small muted" style={{ marginTop: 2 }}><StatusPill status={item.state} meta={CAD_STATE_META} /><span>{TYPE_META[item.type]!.label}</span><span>· Projekt {item.projectNumber}</span>
          {item.checkedOutBy && <Pill tone="amber"><Icon name="lock" /> Gesperrt durch {item.checkedOutByName}{item.checkoutHost ? ` (${item.checkoutHost})` : ''}</Pill>}</div></div>}>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        {item.fileName && <a className="btn" href={`/api/cad/items/${id}/download`}><Icon name="download" /> Datei laden</a>}
        {!item.checkedOutBy && item.state === 'in_work' && <button className="btn" onClick={async () => { await act(() => post(`/cad/items/${id}/checkout`, { host: 'Web' }), 'Ausgecheckt'); refresh(); }}><Icon name="lock" /> Auschecken</button>}
        {mineLocked && <button className="btn primary" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Einchecken …</button>}
        {item.checkedOutBy && (mineLocked || me?.role === 'admin') && <button className="btn" onClick={async () => { await act(() => post(`/cad/items/${id}/undo-checkout`), 'Sperre aufgehoben'); refresh(); }}><Icon name="unlock" /> Sperre aufheben</button>}
        {item.transitions.map((t: string) => (t === 'in_work' && item.state === 'released') ? null : <button key={t} className="btn" onClick={() => setStateTo(t)}>{STATE_ACTION[t]}</button>)}
        {item.state !== 'obsolete' && <button className="btn" onClick={() => setRevise(true)}><Icon name="repeat" /> Neuer Versionsstand</button>}
        {item.drawingId && <button className="btn" onClick={() => onOpen(item.drawingId)}><Icon name="cad" /> Zeichnung öffnen</button>}
        {item.drawingOf && <button className="btn" onClick={() => onOpen(item.drawingOf)}><Icon name="settings" /> Modell öffnen</button>}
        {item.state === 'in_work' && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
        <input ref={fileRef} type="file" hidden accept={ext ? `.${ext}` : undefined} onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const c = prompt('Kommentar zum Einchecken', comment) ?? '';
          setComment('');
          const fd = new FormData();
          fd.append('comment', c);
          fd.append('file', f, f.name);
          try { await upload(`/cad/items/${id}/checkin`, fd); toast('Eingecheckt'); } catch (err) { toast((err as Error).message, 'error'); }
          refresh();
        }} />
      </div>
      {item.state === 'in_work' && item.type !== 'drawing' && item.procurement === 'make' && !item.drawingId && <div className="card" style={{ marginBottom: 12, borderColor: 'var(--amber)' }}>Für die Freigabe wird eine 2D-Zeichnung benötigt. <button className="btn sm" onClick={async () => {
        const r = await act(() => post('/cad/items', { projectId: item.projectId, type: 'drawing', drawingOf: item.id, sub: Number(item.sub), subsub: Number(item.subsub), designation: item.designation, properties: item.properties, procurement: item.procurement }));
        if (r) { refresh(); onOpen(r.item.id); }
      }}>Zeichnung anlegen</button></div>}

      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'props', label: 'Eigenschaften' },
        ...(item.type === 'assembly' ? [{ id: 'bom' as const, label: `Stückliste (${item.childCount})` }] : []),
        { id: 'used', label: `Wo verbaut? (${item.usedInCount})` },
        { id: 'history', label: 'Versionen & Verlauf' },
        { id: 'comments', label: 'Kommentare' },
      ]} />

      {tab === 'props' && (
        <div>
          {editProps ? (
            <>
              <MaskFields mask={settings!.cadMask} type={item.type} values={editProps} onChange={setEditProps} />
              <div className="row"><button className="btn" onClick={() => setEditProps(null)}>Abbrechen</button>
                <button className="btn primary" onClick={async () => { const r = await act(() => patch(`/cad/items/${id}`, { properties: editProps }), 'Gespeichert'); if (r) { setEditProps(null); refresh(); } }}>Speichern</button></div>
            </>
          ) : (
            <>
              <table className="table"><tbody>
                {Object.entries(item.customProperties as Record<string, string>).map(([k, v]) => <tr key={k}><td className="muted" style={{ width: 200 }}>{k}</td><td>{v}</td></tr>)}
                <tr><td className="muted">Datei</td><td className="mono small">{item.filePath}</td></tr>
                <tr><td className="muted">Angelegt</td><td>{item.createdByName}, {fmtDateTime(item.createdAt)}</td></tr>
              </tbody></table>
              <p className="hint">Diese Eigenschaften schreibt der CAD-Wächter als Custom Properties in die Datei – sie erscheinen ohne Abtippen im Schriftkopf der Zeichnung.</p>
              {item.state === 'in_work' && <button className="btn" onClick={() => setEditProps({ ...item.properties })}><Icon name="edit" /> Eigenschaften bearbeiten</button>}
            </>
          )}
          {item.exports.length > 0 && <>
            <h3 style={{ margin: '18px 0 8px' }}><Icon name="factory" /> Fertigungsableitungen</h3>
            <table className="table"><tbody>{item.exports.map((e: any) => (
              <tr key={e.id}>
                <td><b>{e.format.toUpperCase()}</b></td><td>Version {String(e.revision).padStart(2, '0')}</td>
                <td>{e.status === 'done' ? <Pill tone="green">erzeugt</Pill> : e.status === 'failed' ? <Pill tone="red">Fehler</Pill> : e.status === 'running' ? <Pill tone="blue">läuft</Pill> : <Pill tone="amber">wartet auf CAD-Wächter</Pill>}</td>
                <td className="small muted">{e.error ?? fmtDateTime(e.completedAt ?? e.requestedAt)}</td>
                <td>{e.fileId && <a className="btn sm" href={`/api/files/${e.fileId}/download`}><Icon name="download" /></a>}{e.status === 'failed' && <button className="btn sm" onClick={async () => { await post(`/cad/exports/${e.id}/retry`); refresh(); }}>Erneut</button>}</td>
              </tr>
            ))}</tbody></table>
          </>}
        </div>
      )}
      {tab === 'bom' && <Bom id={id} onOpen={onOpen} />}
      {tab === 'used' && <WhereUsed id={id} onOpen={onOpen} />}
      {tab === 'history' && (
        <div>
          <h3 style={{ marginBottom: 8 }}>Versionsstände</h3>
          <table className="table"><tbody>{item.revisions.map((r: any) => (
            <tr key={r.id}>
              <td className="mono"><b>{String(r.revision).padStart(2, '0')}</b></td><td>{r.reason || <span className="muted">–</span>}</td>
              <td className="small muted">{r.createdByName}, {fmtDateTime(r.createdAt)}</td><td className="small muted">{r.fileSize ? fmtBytes(r.fileSize) : ''}</td>
              <td>{r.filePath && <a className="btn sm" href={`/api/cad/items/${id}/download?revision=${r.revision}`}><Icon name="download" /></a>}</td>
            </tr>
          ))}</tbody></table>
          <h3 style={{ margin: '18px 0 8px' }}>Statusverlauf</h3>
          {item.history.map((h: any, i: number) => (
            <div key={i} className="small" style={{ marginBottom: 4 }}>
              {fmtDateTime(h.at)} · <b>{h.userName}</b>: {h.fromState ? `${CAD_STATE_META[h.fromState]?.label} → ` : ''}{CAD_STATE_META[h.toState]?.label} <span className="muted">(V{String(h.revision).padStart(2, '0')})</span>{h.comment && <span className="muted"> – {h.comment}</span>}
            </div>
          ))}
        </div>
      )}
      {tab === 'comments' && <Comments type="cad_item" id={id} />}

      {stateTo && <StateDialog item={item} to={stateTo} onClose={() => setStateTo(null)} onDone={refresh} />}
      {revise && <ReviseDialog item={item} onClose={() => setRevise(false)} onDone={refresh} />}
      {remove && <Confirm danger text={`${item.number} wirklich löschen? Nur möglich, wenn das Teil nirgends verbaut ist.`} onClose={() => setRemove(false)} onConfirm={async () => {
        const ok = await act(() => del(`/cad/items/${id}`), 'Gelöscht');
        if (ok) { onChanged(); onClose(); }
      }} />}
    </SlideOver>
  );
}

function StateDialog({ item, to, onClose, onDone }: { item: any; to: string; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [comment, setComment] = useState('');
  return (
    <Modal title={`${STATE_ACTION[to]}: ${item.number}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => { const r = await act(() => post(`/cad/items/${item.id}/state`, { to, comment })); if (r) { onDone(); onClose(); } }}>Bestätigen</button>
    </>}>
      {to === 'released' && <p className="muted">Nach der Freigabe erzeugt der CAD-Wächter automatisch {item.type === 'drawing' ? 'PDF (Werkstatt, Einkauf) und DXF (Laser/Brennschneiden)' : 'STEP (CNC-Fräsen/Drehen)'}.</p>}
      <Field label="Kommentar"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    </Modal>
  );
}

function ReviseDialog({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const { data: used } = useApi<any[]>(`/cad/items/${item.id}/where-used`);
  const next = String(item.revision + 1).padStart(2, '0');
  return (
    <Modal title="Neuer Versionsstand" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={reason.trim().length < 3} onClick={async () => { const r = await act(() => post(`/cad/items/${item.id}/revise`, { reason, host: 'Web' }), `Version ${next} angelegt`); if (r) { onDone(); onClose(); } }}>Version {next} anlegen</button>
    </>}>
      <p><span className="mono">{item.number}</span> → <span className="mono"><b>{item.baseNumber}-{next}</b>_{item.designation}</span></p>
      <Field label="Grund der Änderung" required hint="z. B. Bohrungsdurchmesser auf 12 mm vergrößert wegen stärkerer Welle"><textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {used && used.length > 0 && <div className="card" style={{ borderColor: 'var(--amber)' }}>
        <b><Icon name="alert" /> Verwendet in {used.length} Baugruppe(n):</b>
        {used.slice(0, 10).map((u) => <div key={u.id + u.depth} className="small mono">{'  '.repeat(u.depth - 1)}{u.number} ({u.projectNumber})</div>)}
      </div>}
    </Modal>
  );
}

function Bom({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const [flat, setFlat] = useState(false);
  const { data } = useApi<any[]>(`/cad/items/${id}/bom${flat ? '?flat=1' : ''}`);
  return (
    <div>
      <div className="toolbar">
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={flat} onChange={(e) => setFlat(e.target.checked)} /> Mengenübersicht (alle Ebenen zusammengefasst)</label>
        <a className="btn sm right" href={`/api/cad/items/${id}/bom?format=csv${flat ? '&flat=1' : ''}`}><Icon name="chart" /> Als CSV/Excel</a>
      </div>
      {!data?.length ? <Empty icon="assembly" title="Keine Positionen" >Die Struktur wird beim Einchecken der Baugruppe vom CAD-Wächter übertragen.</Empty> : (
        <table className="table">
          <thead><tr>{!flat && <th>Pos</th>}<th>Nummer</th><th>Benennung</th><th>Menge</th><th>Beschaffung</th><th>Werkstoff</th><th>Status</th></tr></thead>
          <tbody>{data.map((r, i) => (
            <tr key={i} className="click" onClick={() => onOpen(r.id)}>
              {!flat && <td className="mono small" style={{ paddingLeft: 10 + (r.depth - 1) * 16 }}>{r.position}</td>}
              <td className="mono small"><Icon name={TYPE_META[r.type]?.icon ?? 'part'} /> {r.number}</td><td>{r.designation}</td>
              <td><b>{flat ? r.total : r.quantity}</b>{!flat && r.total !== r.quantity && <span className="muted small"> (ges. {r.total})</span>}</td>
              <td className="small">{PROC[r.procurement]}</td><td className="small">{r.properties?.Werkstoff ?? ''}</td>
              <td><StatusPill status={r.state} meta={CAD_STATE_META} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function WhereUsed({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { data } = useApi<any[]>(`/cad/items/${id}/where-used`);
  if (!data?.length) return <Empty icon="check-circle" title="Nirgends verbaut">Das Teil kann gefahrlos geändert oder gelöscht werden.</Empty>;
  return (
    <table className="table">
      <thead><tr><th>Ebene</th><th>Baugruppe</th><th>Benennung</th><th>Menge</th><th>Projekt</th><th>Status</th></tr></thead>
      <tbody>{data.map((r, i) => (
        <tr key={i} className="click" onClick={() => onOpen(r.id)}>
          <td>{r.depth}</td><td className="mono small" style={{ paddingLeft: 10 + (r.depth - 1) * 16 }}><Icon name="assembly" /> {r.number}</td><td>{r.designation}</td><td>{r.quantity}</td>
          <td className="small">{r.projectNumber} {r.projectName}</td><td><StatusPill status={r.state} meta={CAD_STATE_META} /></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export const loadCadItem = (id: string) => get(`/cad/items/${id}`);
