import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PCB_EXPORT_LABELS } from '@aperio/shared';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post, put, upload, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { CAD_STATE_META, Confirm, Empty, Field, Modal, Pill, SlideOver, StatusPill, Tabs, useAction, useToast } from '../components/ui';
import { Comments } from '../components/TaskPanel';
import { Icon } from '../components/Icon';
import { MaskFields } from './CadCenter';

const STATE_ACTION: Record<string, string> = { review: 'Zur Prüfung', released: 'Freigeben', in_work: 'Zurück in Arbeit', obsolete: 'Ungültig setzen' };
const TRANSITIONS: Record<string, string[]> = { in_work: ['review'], review: ['in_work', 'released'], released: ['obsolete'], obsolete: [] };

interface Mask { numberPattern: string; fields: any[]; catalogs: any[]; folder: string; exportFormats: string[] }

/** PCB-Bridge: Leiterplatten (KiCad) aller Projekte – optional auf ein Projekt beschränkt */
export function PcbCenter({ projectId, canEdit = true }: { projectId?: string; canEdit?: boolean }) {
  const [params, setParams] = useSearchParams();
  const { me } = useSession();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState<{ detectedId?: string; name?: string } | null>(null);
  const qs = new URLSearchParams();
  if (projectId) qs.set('projectId', projectId);
  if (q) qs.set('q', q);
  if (state) qs.set('state', state);
  if (mine) qs.set('checkedOut', 'me');
  const { data, reload } = useApi<any[]>(`/pcb/boards?${qs}`);
  const { data: detected, reload: reloadDetected } = useApi<any[]>(canEdit ? '/pcb/detected' : null);
  const boardId = params.get('board');
  const register = params.get('register');
  const open = (id: string | null) => { if (id) params.set('board', id); else params.delete('board'); setParams(params); };

  useEffect(() => {
    if (register && detected) {
      const d = detected.find((x) => x.id === register);
      if (d) setCreating({ detectedId: d.id, name: d.name });
      params.delete('register'); setParams(params, { replace: true });
    }
  }, [register, detected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e) => { if (e === 'pcb.detected') void reloadDetected(); }) : undefined), [me, reloadDetected]);
  useEffect(() => {
    if (!projectId) return;
    return realtime.subscribe(`project:${projectId}`, (e) => { if (e === 'pcb.changed') { void reload(); invalidate('/pcb/boards/'); } });
  }, [projectId, reload]);

  const rows = data ?? [];
  return (
    <div>
      {detected && detected.length > 0 && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--accent)' }}>
          <b><Icon name="bolt" /> Neue KiCad-Projekte erkannt</b> – bitte Nummer vergeben:
          {detected.map((d) => (
            <div key={d.id} className="row" style={{ marginTop: 6 }}>
              <span className="mono grow">{d.name} <span className="muted small">({d.host}: {d.path})</span></span>
              <button className="btn sm primary" onClick={() => setCreating({ detectedId: d.id, name: d.name })}>Speichermaske</button>
              <button className="btn sm ghost" title="Nicht verwalten" onClick={async () => { await post(`/pcb/detected/${d.id}/dismiss`); reloadDetected(); }}><Icon name="x" /></button>
            </div>
          ))}
        </div>
      )}
      <div className="toolbar">
        <input placeholder="Nummer, Benennung, Oberfläche …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        <select value={state} onChange={(e) => setState(e.target.value)}><option value="">Alle Status</option>{Object.entries(CAD_STATE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> von mir ausgecheckt</label>
        <span className="muted small">{rows.length} Leiterplatten</span>
        {canEdit && me?.role !== 'guest' && <button className="btn primary right" onClick={() => setCreating({})}>＋ Neue Leiterplatte</button>}
      </div>
      {!rows.length ? <Empty icon="bolt" title="Noch keine Leiterplatten">Neue KiCad-Projekte im Arbeitsbereich erkennt der PCB-Wächter automatisch – oder hier über „Neue Leiterplatte“.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nummer</th><th>Benennung</th>{!projectId && <th>Projekt</th>}<th>Status</th><th>Lagen</th><th>Oberfläche</th><th>Bauteile</th><th>Sperre</th><th>Geändert</th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id} className="click" onClick={() => open(b.id)}>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{b.number}-<b>{String(b.revision).padStart(2, '0')}</b></td>
              <td>{b.designation}</td>
              {!projectId && <td className="mono small">{b.projectNumber}</td>}
              <td><StatusPill status={b.state} meta={CAD_STATE_META} /></td>
              <td className="small">{b.properties.Lagen ?? ''}</td><td className="small">{b.properties.Oberflaeche ?? ''}</td>
              <td className="small">{b.bomCount || ''}</td>
              <td>{b.checkedOutBy ? <Pill tone="amber"><Icon name="lock" /> {b.checkedOutByName}</Pill> : ''}</td>
              <td className="small muted">{fmtDateTime(b.updatedAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {boardId && <BoardPanel id={boardId} onClose={() => open(null)} onChanged={reload} />}
      {creating && <PcbMaskDialog projectId={projectId} detectedId={creating.detectedId} initialName={creating.name}
        onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); reload(); reloadDetected(); open(id); }} />}
    </div>
  );
}

function PcbMaskDialog({ projectId, detectedId, initialName, onClose, onCreated }: { projectId?: string; detectedId?: string; initialName?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const act = useAction();
  const { me } = useSession();
  const { data: mask } = useApi<Mask>('/pcb/mask');
  const { data: projects } = useApi<any[]>('/projects');
  const [d, setD] = useState({ projectId: projectId ?? '', designation: initialName?.replace(/[_-]+/g, ' ') ?? '' });
  const [props, setProps] = useState<Record<string, string> | null>(null);
  useEffect(() => { if (mask && !props) setProps({ ...Object.fromEntries(mask.fields.filter((f) => f.defaultValue).map((f) => [f.key, f.defaultValue])), Gezeichnet: me!.displayName }); }, [mask]); // eslint-disable-line react-hooks/exhaustive-deps
  const project = projects?.find((p) => p.id === d.projectId);
  if (!mask || !props) return null;
  const preview = project ? `${mask.numberPattern.replace(/\{PROJEKT\}/g, project.number).replace(/\{(N+)\}/g, (_: string, n: string) => '?'.repeat(n.length))}-00` : '';
  return (
    <Modal size="lg" title={detectedId ? `Speichermaske – KiCad-Projekt „${initialName}“` : 'Speichermaske – neue Leiterplatte'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.projectId || !d.designation.trim()} onClick={async () => {
        const r = await act(() => post('/pcb/boards', { projectId: d.projectId, designation: d.designation, properties: props, detectedId, host: detectedId ? undefined : 'Web' }));
        if (r) onCreated(r.board.id);
      }}>Nummer vergeben</button>
    </>}>
      <div className="grid2">
        <Field label="Projekt" required>
          <select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })} disabled={Boolean(projectId)}>
            <option value="">–</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
          </select>
        </Field>
        <Field label="Benennung" required><input value={d.designation} onChange={(e) => setD({ ...d, designation: e.target.value })} placeholder="z. B. Steuerplatine" autoFocus /></Field>
      </div>
      {preview && <div className="card flat" style={{ marginBottom: 14 }}><span className="muted small">Nummer (wird beim Speichern vergeben)</span><div className="mono" style={{ fontSize: 16 }}>{preview}</div></div>}
      <MaskFields mask={mask} type="part" values={props} onChange={setProps} />
      {detectedId && <p className="hint">Der PCB-Wächter übernimmt Nummer und Eigenschaften als Textvariablen ins KiCad-Projekt (z. B. <span className="mono">{'${APERIO_NUMMER}'}</span> im Schriftfeld).</p>}
    </Modal>
  );
}

function BoardPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: b, reload } = useApi<any>(`/pcb/boards/${id}`);
  const { data: mask } = useApi<Mask>('/pcb/mask');
  const { me } = useSession();
  const act = useAction();
  const toast = useToast();
  const [tab, setTab] = useTabState<'props' | 'bom' | 'exports' | 'history' | 'comments'>('pcb-board', 'props', 'boardTab');
  const [stateTo, setStateTo] = useState<string | null>(null);
  const [revise, setRevise] = useState(false);
  const [remove, setRemove] = useState(false);
  const [checkin, setCheckin] = useState(false);
  const [editProps, setEditProps] = useState<Record<string, string> | null>(null);
  useEffect(() => { setEditProps(null); }, [id]);
  if (!b) return <SlideOver title="…" onClose={onClose}><div className="muted">Wird geladen …</div></SlideOver>;
  const refresh = () => { void reload(); onChanged(); invalidate('/pcb/boards'); };
  const mine = b.checkedOutBy === me?.id;
  const step = b.exports.find((e: any) => e.format === 'step' && e.status === 'done');
  return (
    <SlideOver wide onClose={onClose}
      title={<div><div className="row"><Icon name="bolt" size={20} /><b className="mono" style={{ fontSize: 16 }}>{b.fullNumber}</b> <span>{b.designation}</span></div>
        <div className="row small muted" style={{ marginTop: 2 }}><StatusPill status={b.state} meta={CAD_STATE_META} /><span>Leiterplatte · Projekt {b.projectNumber}</span>
          {b.checkedOutBy && <Pill tone="amber"><Icon name="lock" /> Gesperrt durch {b.checkedOutByName}{b.checkoutHost ? ` (${b.checkoutHost})` : ''}</Pill>}</div></div>}>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        {b.revisions.some((r: any) => r.hasFile && r.revision === b.revision) && <a className="btn" href={`/api/pcb/boards/${id}/download`}><Icon name="download" /> KiCad-Projekt (ZIP)</a>}
        {!b.checkedOutBy && b.state === 'in_work' && <button className="btn" onClick={async () => { await act(() => post(`/pcb/boards/${id}/checkout`, { host: 'Web' }), 'Ausgecheckt'); refresh(); }}><Icon name="lock" /> Auschecken</button>}
        {mine && <button className="btn primary" onClick={() => setCheckin(true)}><Icon name="upload" /> Einchecken …</button>}
        {b.checkedOutBy && (mine || me?.role === 'admin') && <button className="btn" onClick={async () => { await act(() => post(`/pcb/boards/${id}/undo-checkout`), 'Sperre aufgehoben'); refresh(); }}><Icon name="unlock" /> Sperre aufheben</button>}
        {TRANSITIONS[b.state]!.map((t) => <button key={t} className="btn" onClick={() => setStateTo(t)}>{STATE_ACTION[t]}</button>)}
        {b.state === 'released' && <button className="btn" onClick={() => setRevise(true)}><Icon name="repeat" /> Neuer Versionsstand</button>}
        {step && !b.stepCadItem && <button className="btn" title="3D-Modell als Kaufteil in die CAD-Bridge übernehmen" onClick={async () => { const r = await act(() => post(`/pcb/boards/${id}/to-cad`, {}), 'Als Kaufteil in die CAD-Bridge übernommen'); if (r) refresh(); }}><Icon name="cube" /> In CAD-Bridge übernehmen</button>}
        {b.stepCadItem && <a className="btn ghost" href={`/cad?item=${b.stepCadItem.id}`}><Icon name="cad" /> CAD {b.stepCadItem.number}</a>}
        {b.state === 'in_work' && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'props', label: 'Eigenschaften' },
        { id: 'bom', label: `Stückliste (${b.bom.length})` },
        { id: 'exports', label: `Fertigungsdaten (${b.exports.filter((e: any) => e.revision === b.revision).length})` },
        { id: 'history', label: 'Versionen & Verlauf' },
        { id: 'comments', label: 'Kommentare' },
      ]} />

      {tab === 'props' && (
        <div>
          {editProps && mask ? (
            <>
              <MaskFields mask={mask} type="part" values={editProps} onChange={setEditProps} />
              <div className="row"><button className="btn" onClick={() => setEditProps(null)}>Abbrechen</button>
                <button className="btn primary" onClick={async () => { const r = await act(() => patch(`/pcb/boards/${id}`, { properties: editProps }), 'Gespeichert'); if (r) { setEditProps(null); refresh(); } }}>Speichern</button></div>
            </>
          ) : (
            <>
              <table className="table"><tbody>
                <tr><td className="muted" style={{ width: 200 }}>Benennung</td><td>{b.designation}</td></tr>
                {mask?.fields.map((f) => <tr key={f.key}><td className="muted">{f.label}</td><td>{b.properties[f.key] ?? ''}</td></tr>)}
                <tr><td className="muted">Datei</td><td className="mono small">{b.filePath}</td></tr>
                <tr><td className="muted">Angelegt</td><td>{b.createdByName}, {fmtDateTime(b.createdAt)}</td></tr>
              </tbody></table>
              <details className="small" style={{ marginTop: 10 }}><summary>Textvariablen für das KiCad-Schriftfeld</summary>
                <table className="table"><tbody>{Object.entries(b.textVariables as Record<string, string>).map(([k, v]) => <tr key={k}><td className="mono">{'${' + k + '}'}</td><td>{v}</td></tr>)}</tbody></table>
              </details>
              {b.state === 'in_work' && <button className="btn" style={{ marginTop: 10 }} onClick={() => setEditProps({ ...b.properties })}><Icon name="edit" /> Eigenschaften bearbeiten</button>}
            </>
          )}
        </div>
      )}
      {tab === 'bom' && <BomTab board={b} onChanged={refresh} />}
      {tab === 'exports' && (
        !b.exports.length ? <Empty icon="factory" title="Noch keine Fertigungsdaten">Bei der Freigabe erzeugt der PCB-Wächter automatisch Gerber, Bohrdaten, Bestückungsliste, Schaltplan-PDF und STEP.</Empty> : (
          <table className="table"><tbody>{b.exports.map((e: any) => (
            <tr key={e.id}>
              <td><b>{PCB_EXPORT_LABELS[e.format as keyof typeof PCB_EXPORT_LABELS] ?? e.format}</b></td><td className="mono small">{String(e.revision).padStart(2, '0')}</td>
              <td>{e.status === 'done' ? <Pill tone="green">erzeugt</Pill> : e.status === 'failed' ? <Pill tone="red">Fehler</Pill> : e.status === 'running' ? <Pill tone="blue">läuft</Pill> : <Pill tone="amber">wartet auf PCB-Wächter</Pill>}</td>
              <td className="small muted">{e.error ?? fmtDateTime(e.completedAt ?? e.requestedAt)}</td>
              <td>{e.filePath && <a className="btn sm" href={`/api/pcb/exports/${e.id}/download`}><Icon name="download" /></a>}{e.status === 'failed' && <button className="btn sm" onClick={async () => { await post(`/pcb/exports/${e.id}/retry`); refresh(); }}>Erneut</button>}</td>
            </tr>
          ))}</tbody></table>
        )
      )}
      {tab === 'history' && (
        <div>
          <h3 style={{ marginBottom: 8 }}>Versionsstände</h3>
          <table className="table"><tbody>{b.revisions.map((r: any) => (
            <tr key={r.revision}>
              <td className="mono"><b>{String(r.revision).padStart(2, '0')}</b></td><td>{r.reason || <span className="muted">–</span>}</td>
              <td className="small muted">{r.createdByName}, {fmtDateTime(r.createdAt)}</td><td className="small muted">{r.fileSize ? fmtBytes(r.fileSize) : ''}</td>
              <td>{r.hasFile && <a className="btn sm" href={`/api/pcb/boards/${id}/download?revision=${r.revision}`}><Icon name="download" /></a>}</td>
            </tr>
          ))}</tbody></table>
          <h3 style={{ margin: '18px 0 8px' }}>Statusverlauf</h3>
          {b.history.map((h: any, i: number) => (
            <div key={i} className="small" style={{ marginBottom: 4 }}>
              {fmtDateTime(h.at)} · <b>{h.userName}</b>: {h.from ? `${CAD_STATE_META[h.from]?.label} → ` : ''}{CAD_STATE_META[h.to]?.label} <span className="muted">(V{String(h.revision).padStart(2, '0')})</span>{h.comment && <span className="muted"> – {h.comment}</span>}
            </div>
          ))}
        </div>
      )}
      {tab === 'comments' && <Comments type="pcb_board" id={id} />}

      {checkin && <CheckinDialog board={b} onClose={() => setCheckin(false)} onDone={() => { setCheckin(false); toast('Eingecheckt'); refresh(); }} />}
      {stateTo && <StateDialog board={b} to={stateTo} onClose={() => setStateTo(null)} onDone={refresh} />}
      {revise && <ReviseDialog board={b} onClose={() => setRevise(false)} onDone={refresh} />}
      {remove && <Confirm danger text={`${b.fullNumber} wirklich löschen?`} onClose={() => setRemove(false)} onConfirm={async () => {
        if (await act(() => del(`/pcb/boards/${id}`), 'Gelöscht')) { onChanged(); onClose(); }
      }} />}
    </SlideOver>
  );
}

function CheckinDialog({ board, onClose, onDone }: { board: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [zip, setZip] = useState<File | null>(null);
  const [bom, setBom] = useState<File | null>(null);
  const [comment, setComment] = useState('');
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Einchecken: ${board.fullNumber}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={busy || (!zip && !bom)} onClick={async () => {
        setBusy(true);
        const fd = new FormData();
        fd.append('comment', comment);
        if (keep) fd.append('keepCheckedOut', 'true');
        if (bom) fd.append('bom', bom, bom.name);
        if (zip) fd.append('file', zip, zip.name);
        try { await upload(`/pcb/boards/${board.id}/checkin`, fd); onDone(); } catch (e) { toast((e as Error).message, 'error'); }
        setBusy(false);
      }}>Einchecken</button></>}>
      <p className="muted small">Normalerweise erledigt das der PCB-Wächter mit <span className="mono">aperio-pcb checkin</span>. Hier geht es auch von Hand.</p>
      <Field label="KiCad-Projekt als ZIP"><input type="file" accept=".zip" onChange={(e) => setZip(e.target.files?.[0] ?? null)} /></Field>
      <Field label="Stückliste (CSV aus KiCad, optional)"><input type="file" accept=".csv,.txt" onChange={(e) => setBom(e.target.files?.[0] ?? null)} /></Field>
      <Field label="Kommentar"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      <label className="row small"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Ausgecheckt lassen (Zwischenstand sichern)</label>
    </Modal>
  );
}

function BomTab({ board, onChanged }: { board: any; onChanged: () => void }) {
  const act = useAction();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="toolbar">
        <span className="small muted">Stand {String(board.revision).padStart(2, '0')} · {board.bom.filter((r: any) => !r.dnp).reduce((s: number, r: any) => s + r.qty, 0)} Bauteile je Platte</span>
        {board.state === 'in_work' && <button className="btn sm right" onClick={() => ref.current?.click()}><Icon name="upload" /> CSV einlesen</button>}
        <input ref={ref} type="file" accept=".csv,.txt" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (f && (await act(async () => put(`/pcb/boards/${board.id}/bom`, { csv: await f.text() }), 'Stückliste übernommen'))) onChanged();
        }} />
      </div>
      {!board.bom.length ? <Empty icon="list" title="Keine Stückliste">Beim Einchecken überträgt der PCB-Wächter die Stückliste aus KiCad (Wert, Bauform, Hersteller, Herstellernummer, Menge). Bei der Freigabe erscheinen die Bauteile im Einkauf.</Empty> : (
        <table className="table">
          <thead><tr><th>Bezeichner</th><th>Wert</th><th>Bauform</th><th>Hersteller</th><th>Herstellernummer</th><th>Menge</th></tr></thead>
          <tbody>{board.bom.map((r: any, i: number) => (
            <tr key={i} style={r.dnp ? { opacity: 0.5 } : undefined}>
              <td className="mono small" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.refs}>{r.refs}</td><td>{r.value}</td><td className="small">{r.footprint}</td>
              <td className="small">{r.manufacturer}</td><td className="mono small">{r.manufacturerNo}</td><td><b>{r.qty}</b>{r.dnp && <Pill>nicht bestücken</Pill>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function StateDialog({ board, to, onClose, onDone }: { board: any; to: string; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const toast = useToast();
  const [comment, setComment] = useState('');
  return (
    <Modal title={`${STATE_ACTION[to]}: ${board.fullNumber}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => {
        const r = await act(() => post(`/pcb/boards/${board.id}/state`, { to, comment }));
        if (r) { if (r.purchasing?.added) toast(`${r.purchasing.added} Bauteile in den Einkauf übernommen`); onDone(); onClose(); }
      }}>Bestätigen</button>
    </>}>
      {to === 'released' && <p className="muted">Nach der Freigabe erzeugt der PCB-Wächter automatisch die Fertigungsdaten (Gerber, Bohrdaten, Bestückungsliste, Schaltplan-PDF, STEP). Die Bauteile der Stückliste erscheinen im Einkauf.</p>}
      <Field label="Kommentar"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    </Modal>
  );
}

function ReviseDialog({ board, onClose, onDone }: { board: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const next = String(board.revision + 1).padStart(2, '0');
  return (
    <Modal title="Neuer Versionsstand" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={reason.trim().length < 3} onClick={async () => { const r = await act(() => post(`/pcb/boards/${board.id}/revise`, { reason, host: 'Web' }), `Version ${next} angelegt`); if (r) { onDone(); onClose(); } }}>Version {next} anlegen</button>
    </>}>
      <p><span className="mono">{board.fullNumber}</span> → <span className="mono"><b>{board.number}-{next}</b></span></p>
      <Field label="Grund der Änderung" required hint="z. B. Bohrbild an neues Gehäuse angepasst"><textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <p className="hint">Der neue Stand wird für Sie ausgecheckt. Bereits bestellte Bauteile meldet AperioPlan dem Einkauf.</p>
    </Modal>
  );
}
