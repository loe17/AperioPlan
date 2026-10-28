import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post, upload } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtDateTime, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, UserSelect, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { AssetSelect, Checklist } from '../modules/Pickers';

type Tab = 'orders' | 'plans' | 'assets';
export const MNT_STATUS: Record<string, [string, string]> = { open: ['offen', 'blue'], in_progress: ['in Arbeit', 'amber'], waiting: ['wartet (Teile/Fremdfirma)', ''], done: ['erledigt', 'green'], cancelled: ['storniert', ''] };
export const MNT_PRIO: Record<string, [string, string]> = { low: ['niedrig', ''], normal: ['normal', ''], high: ['hoch', 'amber'], urgent: ['dringend', 'red'] };
const INTERVALS: [number, string][] = [[7, 'wöchentlich'], [30, 'monatlich'], [91, 'vierteljährlich'], [182, 'halbjährlich'], [365, 'jährlich'], [730, 'alle 2 Jahre']];

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'maintenance.changed') void reload(); }), [reload]);
}

export default function MaintenancePage() {
  useCrumbs([{ label: 'Instandhaltung' }]);
  const [tab, setTab] = useTabState<Tab>('maintenance', 'orders');
  const [params, setParams] = useSearchParams();
  const [report, setReport] = useState(false);
  const { data: ov, reload } = useApi<any>('/maintenance/overview');
  useLive(reload);
  const order = params.get('order');
  const setOrder = (id: string | null) => { if (id) params.set('order', id); else params.delete('order'); setParams(params, { replace: true }); };
  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>Instandhaltung</h1><div className="sub">Wartung und Störungen an Maschinen und Anlagen</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setReport(true)}><Icon name="alert" /> Störung melden</button></div>
      </div>
      {ov && <div className="kpi-row">
        <div className="kpi"><div className="v">{ov.open}</div><div className="l">offene Aufträge</div></div>
        <div className="kpi"><div className="v" style={{ color: ov.down ? 'var(--red)' : undefined }}>{ov.down}</div><div className="l">Anlagen stehen</div></div>
        <div className="kpi"><div className="v" style={{ color: ov.overdue ? 'var(--red)' : undefined }}>{ov.overdue}</div><div className="l">überfällig</div></div>
        <div className="kpi"><div className="v">{ov.due14}</div><div className="l">Wartungen in 14 Tagen</div></div>
        <div className="kpi"><div className="v">{ov.doneMonth}</div><div className="l">erledigt diesen Monat</div></div>
      </div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'orders', label: 'Aufträge' }, { id: 'plans', label: 'Wartungspläne' }, { id: 'assets', label: 'Anlagen' }]} />
      {tab === 'orders' && <Orders onOpen={setOrder} />}
      {tab === 'plans' && <Plans onOpenOrder={setOrder} />}
      {tab === 'assets' && <Assets onOpenOrder={setOrder} />}
      {order && <OrderPanel id={order} onClose={() => setOrder(null)} />}
      {report && <ReportModal onClose={() => setReport(false)} onDone={(id) => { setReport(false); setOrder(id); }} />}
    </div>
  );
}

function Orders({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState('active');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}), ...(q ? { q } : {}) });
  const { data, reload } = useApi<any[]>(`/maintenance/orders?${qs}`);
  useLive(reload);
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="active">offen</option><option value="">alle</option>{Object.entries(MNT_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> nur meine</label>
      </div>
      {data && !data.length && <Empty icon="wrench" title="Keine Aufträge" />}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Auftrag</th><th>Anlage</th><th>Priorität</th><th>Zuständig</th><th>Fällig</th><th>Status</th></tr></thead>
        <tbody>{data.map((o) => (
          <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
            <td className="mono small">{o.number}</td>
            <td><b>{o.title}</b> {o.kind === 'corrective' ? <span className="pill small red">Störung</span> : <span className="pill small">Wartung</span>}{o.machineDown && o.status !== 'done' && <span className="pill small red" style={{ marginLeft: 4 }}>Stillstand</span>}</td>
            <td>{o.assetName ? <>{o.assetName}<div className="small muted">{o.assetNumber}{o.assetLocation ? ` · ${o.assetLocation}` : ''}</div></> : '–'}</td>
            <td><Pill tone={MNT_PRIO[o.priority]![1]}>{MNT_PRIO[o.priority]![0]}</Pill></td>
            <td>{o.assigneeName ?? <span className="muted">–</span>}</td>
            <td className={o.overdue ? 'text-red' : ''}>{fmtDate(o.dueDate)}</td>
            <td><Pill tone={MNT_STATUS[o.status]![1]}>{MNT_STATUS[o.status]![0]}</Pill></td>
          </tr>
        ))}</tbody></table>}
    </div>
  );
}

export function ReportModal({ assetId, onClose, onDone }: { assetId?: string; onClose: () => void; onDone: (id: string) => void }) {
  const act = useAction();
  const { users } = useSession();
  const [f, setF] = useState({ assetId: assetId ?? null as string | null, title: '', description: '', priority: 'normal', machineDown: false, assigneeId: null as string | null, kind: 'corrective' });
  return (
    <Modal title="Störung melden" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => { const r = await act(() => post<{ id: string }>('/maintenance/orders', f), 'Gemeldet'); if (r) onDone(r.id); }}>Melden</button></>}>
      <Field label="Anlage / Maschine"><AssetSelect value={f.assetId} onChange={(v) => setF({ ...f, assetId: v })} /></Field>
      <Field label="Was ist passiert?"><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Spindel macht Geräusche" /></Field>
      <Field label="Beschreibung"><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid3">
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="corrective">Störung / Reparatur</option><option value="preventive">Wartung</option></select></Field>
        <Field label="Priorität"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(MNT_PRIO).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Zuständig"><UserSelect users={users} value={f.assigneeId} onChange={(v) => setF({ ...f, assigneeId: v })} placeholder="– automatisch –" /></Field>
      </div>
      <label className="row"><input type="checkbox" checked={f.machineDown} onChange={(e) => setF({ ...f, machineDown: e.target.checked })} /> Maschine steht (Stillstand)</label>
    </Modal>
  );
}

function OrderPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: o, reload } = useApi<any>(`/maintenance/orders/${id}`, [id]);
  const { users, me } = useSession();
  const act = useAction();
  const toast = useToast();
  const [f, setF] = useState<any>(null);
  const [remove, setRemove] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useLive(reload);
  useEffect(() => { if (o) setF({ title: o.title, description: o.description, priority: o.priority, assigneeId: o.assigneeId, dueDate: o.dueDate ?? '', checklist: o.checklist,
    workHours: Math.round((o.workMinutes / 60) * 100) / 100, materialCost: o.materialCost, externalCost: o.externalCost, report: o.report, machineDown: o.machineDown }); }, [o?.id, o?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o || !f) return null;
  const closed = o.status === 'done' || o.status === 'cancelled';
  const body = () => ({ title: f.title, description: f.description, priority: f.priority, assigneeId: f.assigneeId, dueDate: f.dueDate || null, checklist: f.checklist,
    workMinutes: Math.round(Number(f.workHours) * 60), materialCost: Number(f.materialCost), externalCost: Number(f.externalCost), report: f.report, machineDown: f.machineDown });
  const save = (extra: Record<string, unknown> = {}, msg = 'Gespeichert') => act(() => patch(`/maintenance/orders/${id}`, { ...body(), ...extra }), msg);
  return (
    <SlideOver wide title={<span>{o.title} <span className="mono muted">{o.number}</span></span>} onClose={onClose}
      actions={<><a className="btn sm" href={`/api/maintenance/orders/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="printer" /> Auftrag</a></>}>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <Pill tone={MNT_STATUS[o.status]![1]}>{MNT_STATUS[o.status]![0]}</Pill>
        {o.kind === 'corrective' ? <Pill tone="red">Störung</Pill> : <Pill>Wartung</Pill>}
        {o.assetName && <span className="small">{o.assetNumber} {o.assetName}{o.assetLocation ? ` · ${o.assetLocation}` : ''}</span>}
        <span className="small muted">gemeldet {fmtDateTime(o.createdAt)} von {o.reportedByName ?? '–'}</span>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {o.status === 'open' && <button className="btn primary" onClick={async () => { if (await save({ status: 'in_progress', assigneeId: f.assigneeId ?? me?.id }, 'Begonnen')) void reload(); }}><Icon name="play" /> Beginnen</button>}
        {o.status === 'in_progress' && <button className="btn" onClick={async () => { if (await save({ status: 'waiting' }, 'Wartet')) void reload(); }}>Wartet auf Teile/Fremdfirma</button>}
        {o.status === 'waiting' && <button className="btn" onClick={async () => { if (await save({ status: 'in_progress' }, 'Weiter')) void reload(); }}>Weiter</button>}
        {!closed && <button className="btn primary" onClick={async () => { if (await save({ status: 'done' }, 'Erledigt')) void reload(); }}><Icon name="check" /> Erledigt</button>}
        {closed && <button className="btn" onClick={async () => { if (await save({ status: 'open' }, 'Wieder geöffnet')) void reload(); }}>Wieder öffnen</button>}
        {!closed && <button className="btn ghost" onClick={async () => { if (await save({ status: 'cancelled' }, 'Storniert')) void reload(); }}>Stornieren</button>}
        <span className="grow" />
        <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>
      </div>
      <Field label="Titel"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Beschreibung"><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid3">
        <Field label="Priorität"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(MNT_PRIO).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Zuständig"><UserSelect users={users} value={f.assigneeId} onChange={(v) => setF({ ...f, assigneeId: v })} /></Field>
        <Field label="Fällig"><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
      </div>
      <label className="row" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.machineDown} onChange={(e) => setF({ ...f, machineDown: e.target.checked })} /> Maschine steht</label>
      {(f.checklist.length > 0 || !closed) && <><h3 style={{ margin: '8px 0 4px' }}>Checkliste</h3><Checklist items={f.checklist} onChange={(v) => setF({ ...f, checklist: v })} /></>}
      <h3 style={{ margin: '14px 0 4px' }}>Bericht</h3>
      <textarea rows={4} value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })} placeholder="Was wurde gemacht? Ursache, getauschte Teile …" />
      <div className="grid3" style={{ marginTop: 8 }}>
        <Field label="Arbeitszeit (Std.)"><input type="number" step="0.25" min={0} value={f.workHours} onChange={(e) => setF({ ...f, workHours: e.target.value })} /></Field>
        <Field label="Material (€)"><input type="number" step="0.01" min={0} value={f.materialCost} onChange={(e) => setF({ ...f, materialCost: e.target.value })} /></Field>
        <Field label="Fremdleistung (€)"><input type="number" step="0.01" min={0} value={f.externalCost} onChange={(e) => setF({ ...f, externalCost: e.target.value })} /></Field>
      </div>
      <div className="row wrap" style={{ gap: 8, margin: '8px 0' }}>
        {o.photos.map((p: any) => <a key={p.id} href={`/api/maintenance/orders/${id}/photos/${p.id}`} target="_blank" rel="noreferrer" className="mnt-photo">
          {/\.pdf$/i.test(p.name) ? <Icon name="file-pdf" /> : <img src={`/api/maintenance/orders/${id}/photos/${p.id}`} alt={p.name} />}</a>)}
        <button className="btn sm" onClick={() => file.current?.click()}><Icon name="camera" /> Foto</button>
        <input ref={file} type="file" hidden accept="image/*,.pdf" capture="environment" multiple onChange={async (e) => {
          const files = [...(e.target.files ?? [])]; e.target.value = ''; if (!files.length) return;
          const fd = new FormData(); for (const x of files) fd.append('file', x, x.name);
          try { await upload(`/maintenance/orders/${id}/photos`, fd); void reload(); } catch (err) { toast((err as Error).message, 'error'); }
        }} />
      </div>
      <button className="btn primary" onClick={async () => { if (await save()) void reload(); }}>Speichern</button>
      {remove && <Confirm danger text="Auftrag löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/maintenance/orders/${id}`))) onClose(); }} />}
    </SlideOver>
  );
}

function Plans({ onOpenOrder, assetId }: { onOpenOrder: (id: string) => void; assetId?: string }) {
  const { data, reload } = useApi<any[]>(`/maintenance/plans${assetId ? `?assetId=${assetId}` : ''}`);
  const [edit, setEdit] = useState<any | null>(null);
  const act = useAction();
  useLive(reload);
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({ assetId: assetId ?? null, title: '', intervalDays: 365, nextDue: isoDate(new Date()), leadDays: 7, checklist: [], responsibleId: null, estimateMinutes: 0, active: true })}><Icon name="plus" /> Wartungsplan</button></span></div>
      {data && !data.length && <Empty icon="calendar" title="Keine Wartungspläne">Ein Wartungsplan legt fest, was in welchem Abstand an einer Anlage zu tun ist. Ist die Wartung fällig, entsteht automatisch ein Auftrag.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Wartung</th><th>Anlage</th><th>Intervall</th><th>Nächste</th><th>Zuständig</th><th /></tr></thead>
        <tbody>{data.map((p) => (
          <tr key={p.id} className="click" onClick={() => setEdit(p)} style={p.active ? undefined : { opacity: 0.5 }}>
            <td><b>{p.title}</b>{p.checklist.length > 0 && <span className="small muted"> · {p.checklist.length} Punkte</span>}</td>
            <td>{p.assetNumber} {p.assetName}</td>
            <td>{INTERVALS.find(([d]) => d === p.intervalDays)?.[1] ?? `alle ${p.intervalDays} Tage`}</td>
            <td className={p.nextDue < isoDate(new Date()) ? 'text-red' : ''}>{fmtDate(p.nextDue)}</td>
            <td>{p.responsibleName ?? '–'}</td>
            <td onClick={(e) => e.stopPropagation()}><button className="btn sm" onClick={async () => { const r = await act(() => post<{ id: string }>(`/maintenance/plans/${p.id}/order`, {})); if (r) onOpenOrder(r.id); }}>Jetzt durchführen</button></td>
          </tr>
        ))}</tbody></table>}
      {edit && <PlanModal plan={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function PlanModal({ plan, onClose, onSaved }: { plan: any; onClose: () => void; onSaved: () => void }) {
  const { users } = useSession();
  const act = useAction();
  const [f, setF] = useState(plan);
  const [remove, setRemove] = useState(false);
  const preset = INTERVALS.some(([d]) => d === f.intervalDays);
  return (
    <Modal title={plan.id ? 'Wartungsplan' : 'Neuer Wartungsplan'} onClose={onClose} footer={<>
      {plan.id && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.assetId || !f.title.trim()} onClick={async () => {
        const b = { assetId: f.assetId, title: f.title, intervalDays: Number(f.intervalDays), nextDue: f.nextDue, leadDays: Number(f.leadDays), checklist: f.checklist, responsibleId: f.responsibleId, estimateMinutes: Number(f.estimateMinutes), active: f.active };
        if (await act(() => (plan.id ? patch(`/maintenance/plans/${plan.id}`, b) : post('/maintenance/plans', b)), 'Gespeichert')) onSaved();
      }}>Speichern</button></>}>
      <Field label="Anlage"><AssetSelect value={f.assetId} onChange={(v) => setF({ ...f, assetId: v })} placeholder="– Anlage wählen –" /></Field>
      <Field label="Bezeichnung"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Jahreswartung, Ölwechsel, Sichtprüfung" /></Field>
      <div className="grid3">
        <Field label="Intervall"><select value={preset ? f.intervalDays : 0} onChange={(e) => setF({ ...f, intervalDays: Number(e.target.value) || f.intervalDays })}>{INTERVALS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}<option value={0}>eigene Tage …</option></select></Field>
        {!preset && <Field label="alle … Tage"><input type="number" min={1} value={f.intervalDays} onChange={(e) => setF({ ...f, intervalDays: Number(e.target.value) })} /></Field>}
        <Field label="Nächste Wartung"><input type="date" value={f.nextDue} onChange={(e) => setF({ ...f, nextDue: e.target.value })} /></Field>
        <Field label="Auftrag … Tage vorher"><input type="number" min={0} value={f.leadDays} onChange={(e) => setF({ ...f, leadDays: e.target.value })} /></Field>
        <Field label="Zuständig"><UserSelect users={users} value={f.responsibleId} onChange={(v) => setF({ ...f, responsibleId: v })} /></Field>
        <Field label="Dauer (Min.)"><input type="number" min={0} value={f.estimateMinutes} onChange={(e) => setF({ ...f, estimateMinutes: e.target.value })} /></Field>
      </div>
      <h3 style={{ margin: '8px 0 4px' }}>Checkliste</h3>
      <Checklist items={f.checklist} onChange={(v) => setF({ ...f, checklist: v })} doneEditable={false} />
      <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>
      {remove && <Confirm danger text="Wartungsplan löschen? Bestehende Aufträge bleiben." onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/maintenance/plans/${plan.id}`))) onSaved(); }} />}
    </Modal>
  );
}

function Assets({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const [asset, setAsset] = useState<string | null>(null);
  const { data } = useApi<any>(asset ? `/maintenance/assets/${asset}` : null, [asset]);
  const [report, setReport] = useState(false);
  return (
    <div>
      <div className="toolbar"><div style={{ width: 360 }}><AssetSelect value={asset} onChange={setAsset} placeholder="– Anlage wählen –" /></div>
        {asset && <span className="right"><button className="btn" onClick={() => setReport(true)}><Icon name="alert" /> Störung melden</button></span>}</div>
      {!asset && <Empty icon="factory" title="Anlage wählen">Zeigt Wartungspläne, Verlauf, Ausfälle, Stillstandszeit und Kosten der letzten 12 Monate.</Empty>}
      {data && <>
        <div className="kpi-row">
          <div className="kpi"><div className="v">{data.kpi.failures}</div><div className="l">Störungen (12 Monate)</div></div>
          <div className="kpi"><div className="v">{data.kpi.mtbfDays ?? '–'}</div><div className="l">Tage zwischen Störungen (Mittel)</div></div>
          <div className="kpi"><div className="v">{Math.round(data.kpi.downMinutes / 60)}</div><div className="l">Stillstand (Std.)</div></div>
          <div className="kpi"><div className="v">{Math.round(data.kpi.workMinutes / 60)}</div><div className="l">Arbeitszeit (Std.)</div></div>
          <div className="kpi"><div className="v">{fmtEuro2(data.kpi.cost)}</div><div className="l">Kosten</div></div>
        </div>
        <h3>Wartungspläne</h3>
        <Plans assetId={asset!} onOpenOrder={onOpenOrder} />
        <h3>Verlauf</h3>
        <table className="table"><tbody>{data.orders.map((o: any) => (
          <tr key={o.id} className="click" onClick={() => onOpenOrder(o.id)}>
            <td style={{ width: 100 }}>{fmtDate(o.createdAt)}</td><td><b>{o.title}</b> <span className="small muted">{o.number}</span></td>
            <td>{o.kind === 'corrective' ? <Pill tone="red">Störung</Pill> : <Pill>Wartung</Pill>}</td><td><Pill tone={MNT_STATUS[o.status]![1]}>{MNT_STATUS[o.status]![0]}</Pill></td>
            <td className="small muted">{o.report?.slice(0, 80)}</td>
          </tr>
        ))}</tbody></table>
      </>}
      {report && asset && <ReportModal assetId={asset} onClose={() => setReport(false)} onDone={(id) => { setReport(false); onOpenOrder(id); }} />}
    </div>
  );
}
