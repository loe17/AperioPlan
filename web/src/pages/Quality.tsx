import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EIGHT_D, EIGHT_D_STATUS, evaluateCharacteristic, INSPECTION_KIND, stats, type Characteristic } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, UserSelect, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { CustomerPicker } from '../modules/CrmShared';
import { ProjectSelect, uploadForm } from '../modules/Pickers';

type Tab = 'inspections' | 'plans' | 'gauges' | '8d';
const RESULT: Record<string, [string, string]> = { open: ['offen', 'blue'], pass: ['i. O.', 'green'], fail: ['n. i. O.', 'red'], conditional: ['mit Auflage', 'amber'] };
const GAUGE_STATUS: Record<string, [string, string]> = { ok: ['in Ordnung', 'green'], blocked: ['gesperrt', 'red'], retired: ['ausgemustert', ''] };
const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
const fmt = (n: number | null | undefined, d = 4) => (n === null || n === undefined ? '' : n.toLocaleString('de-DE', { maximumFractionDigits: d }));

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'quality.changed') void reload(); }), [reload]);
}

export default function QualityPage() {
  useCrumbs([{ label: 'Qualität' }]);
  const [tab, setTab] = useTabState<Tab>('quality', 'inspections');
  const { data: ov, reload } = useApi<any>('/quality/overview');
  useLive(reload);
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Qualität</h1><div className="sub">Prüfungen, Prüfpläne, Messmittel und 8D-Reports</div></div></div>
      {ov && <div className="kpi-row">
        <div className="kpi click" onClick={() => setTab('inspections')}><div className="v">{ov.openInspections}</div><div className="l">offene Prüfungen</div></div>
        <div className="kpi click" onClick={() => setTab('inspections')}><div className="v">{ov.inspections30 ? `${Math.round(((ov.inspections30 - ov.failed30) / ov.inspections30) * 100)} %` : '–'}</div><div className="l">i. O.-Quote (30 Tage)</div></div>
        <div className="kpi click" onClick={() => setTab('gauges')}><div className="v" style={{ color: ov.gaugesOverdue ? 'var(--red)' : undefined }}>{ov.gaugesOverdue}</div><div className="l">Messmittel überfällig{ov.gaugesDue30 ? ` · ${ov.gaugesDue30} bald` : ''}</div></div>
        <div className="kpi click" onClick={() => setTab('8d')}><div className="v">{ov.open8d}</div><div className="l">offene 8D-Reports</div></div>
      </div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'inspections', label: 'Prüfungen' }, { id: 'plans', label: 'Prüfpläne' }, { id: 'gauges', label: 'Messmittel' }, { id: '8d', label: '8D-Reports' }]} />
      {tab === 'inspections' && <Inspections />}
      {tab === 'plans' && <Plans />}
      {tab === 'gauges' && <Gauges />}
      {tab === '8d' && <EightDs />}
    </div>
  );
}

// ---------------------------------------------------------------- Prüfungen
function Inspections() {
  const [params, setParams] = useSearchParams();
  const [result, setResult] = useState('');
  const [q, setQ] = useState('');
  const [create, setCreate] = useState(false);
  const { data, reload } = useApi<any[]>(`/quality/inspections?${new URLSearchParams({ ...(result ? { result } : {}), ...(q ? { q } : {}) })}`);
  useLive(reload);
  const open = params.get('inspection');
  const setOpen = (id: string | null) => { if (id) params.set('inspection', id); else params.delete('inspection'); setParams(params, { replace: true }); };
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <select value={result} onChange={(e) => setResult(e.target.value)} style={{ width: 'auto' }}><option value="">alle</option>{Object.entries(RESULT).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <span className="right"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Prüfung</button></span>
      </div>
      {data && !data.length && <Empty icon="check-circle" title="Noch keine Prüfungen">Eine Prüfung entsteht aus einem Prüfplan – die Merkmale werden übernommen und die Messwerte eingetragen.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Prüfung</th><th>Art</th><th>Bezug</th><th>Prüfer</th><th>Datum</th><th>Ergebnis</th></tr></thead>
        <tbody>{data.map((i) => (
          <tr key={i.id} className="click" onClick={() => setOpen(i.id)}>
            <td className="mono small">{i.number}</td><td><b>{i.title}</b>{i.lot && <div className="small muted">Charge {i.lot}</div>}</td><td>{INSPECTION_KIND[i.kind]}</td>
            <td className="small">{[i.reference, i.supplierName, i.projectNumber].filter(Boolean).join(' · ') || '–'}</td><td>{i.inspectorName ?? '–'}</td>
            <td>{fmtDate(i.inspectedAt ?? i.createdAt)}</td><td><Pill tone={RESULT[i.result]![1]}>{RESULT[i.result]![0]}</Pill></td>
          </tr>
        ))}</tbody></table>}
      {create && <NewInspection onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); setOpen(id); }} />}
      {open && <InspectionPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewInspection({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { data: plans } = useApi<any[]>('/quality/plans');
  const act = useAction();
  const [f, setF] = useState({ planId: '', title: '', kind: 'incoming', reference: '', lot: '', qty: '', supplier: null as any, projectId: null as string | null });
  return (
    <Modal title="Neue Prüfung" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => {
        const r = await act(() => post<{ id: string }>('/quality/inspections', { planId: f.planId || null, title: f.title, kind: f.kind, reference: f.reference, lot: f.lot, qty: f.qty ? Number(f.qty) : null, supplierId: f.supplier?.id ?? null, projectId: f.projectId }));
        if (r) onDone(r.id);
      }}>Anlegen</button></>}>
      <Field label="Prüfplan"><select value={f.planId} onChange={(e) => { const p = plans?.find((x) => x.id === e.target.value); setF({ ...f, planId: e.target.value, title: f.title || (p ? p.title : '') }); }}>
        <option value="">– ohne Prüfplan –</option>{plans?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.number} {p.title}</option>)}</select></Field>
      <Field label="Bezeichnung"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <div className="grid3">
        <Field label="Prüfart"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(INSPECTION_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Charge / Los"><input value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} /></Field>
        <Field label="Menge"><input type="number" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
      </div>
      <Field label="Bezug" hint="z. B. Lieferschein, Bestellnummer, Fertigungsauftrag"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="Lieferant"><CustomerPicker kind="supplier" value={f.supplier} onChange={(s) => setF({ ...f, supplier: s })} placeholder="Lieferant suchen …" /></Field>
        <Field label="Projekt"><ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} /></Field>
      </div>
    </Modal>
  );
}

function InspectionPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: i, reload } = useApi<any>(`/quality/inspections/${id}`, [id]);
  const act = useAction();
  const [chars, setChars] = useState<Characteristic[]>([]);
  const [notes, setNotes] = useState('');
  const [remove, setRemove] = useState(false);
  useEffect(() => { if (i) { setChars(i.characteristics); setNotes(i.notes); } }, [i?.id, i?.result]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!i) return null;
  const setVal = (ci: number, vi: number, v: number | boolean | null) => setChars(chars.map((c, j) => {
    if (j !== ci) return c;
    const vals = [...(c.values ?? [])]; vals[vi] = v;
    while (vals.length && (vals[vals.length - 1] === null || vals[vals.length - 1] === undefined)) vals.pop();
    return { ...c, values: vals };
  }));
  const save = (extra: Record<string, unknown> = {}) => act(() => patch(`/quality/inspections/${id}`, { characteristics: chars, notes, ...extra }), 'Gespeichert');
  return (
    <SlideOver wide title={<span>{i.title} <span className="mono muted">{i.number}</span></span>} onClose={onClose}
      actions={<a className="btn sm" href={`/api/quality/inspections/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="printer" /> Protokoll</a>}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
        <Pill tone={RESULT[i.result]![1]}>{RESULT[i.result]![0]}</Pill><span className="small">{INSPECTION_KIND[i.kind]}</span>
        {i.planNumber && <span className="small muted">Prüfplan {i.planNumber}</span>}{i.lot && <span className="small">Charge {i.lot}</span>}{i.qty !== null && <span className="small">Menge {fmt(i.qty)}</span>}
        {i.supplierName && <span className="small">{i.supplierName}</span>}{i.reference && <span className="small muted">{i.reference}</span>}
      </div>
      {!chars.length && <p className="muted">Keine Merkmale. Merkmale kommen aus dem Prüfplan.</p>}
      {chars.map((c, ci) => {
        const r = evaluateCharacteristic(c); const st = stats(c);
        const n = Math.max(3, (c.values?.length ?? 0) + 1);
        return (
          <div key={c.id} className={`card flat qm-char ${r}`} style={{ marginBottom: 8 }}>
            <div className="row" style={{ gap: 8 }}><b className="grow">{c.name}</b>
              <span className="small muted">{c.kind === 'attribute' ? 'i. O. / n. i. O.' : `${fmt(c.nominal)} ${c.unit ?? ''} · ${fmt(c.lower)} … ${fmt(c.upper)}`}{c.method ? ` · ${c.method}` : ''}</span>
              <Pill tone={r === 'pass' ? 'green' : r === 'fail' ? 'red' : 'blue'}>{r === 'pass' ? 'i. O.' : r === 'fail' ? 'n. i. O.' : 'offen'}</Pill></div>
            <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
              {Array.from({ length: n }, (_, vi) => c.kind === 'attribute'
                ? <select key={vi} style={{ width: 90 }} value={c.values?.[vi] === true ? 'ok' : c.values?.[vi] === false ? 'nok' : ''} onChange={(e) => setVal(ci, vi, e.target.value === 'ok' ? true : e.target.value === 'nok' ? false : null)}>
                    <option value="">–</option><option value="ok">i. O.</option><option value="nok">n. i. O.</option></select>
                : <input key={vi} style={{ width: 90 }} inputMode="decimal" className={typeof c.values?.[vi] === 'number' && ((c.lower !== null && c.lower !== undefined && (c.values[vi] as number) < c.lower) || (c.upper !== null && c.upper !== undefined && (c.values[vi] as number) > c.upper)) ? 'qm-out' : ''}
                    defaultValue={typeof c.values?.[vi] === 'number' ? String(c.values[vi]).replace('.', ',') : ''} onBlur={(e) => setVal(ci, vi, num(e.target.value))} placeholder={`Wert ${vi + 1}`} />)}
            </div>
            {st && st.n > 1 && <div className="small muted" style={{ marginTop: 4 }}>n = {st.n} · Mittel {fmt(st.mean)} · Spannweite {fmt(st.range)} · s = {fmt(st.sd)}{st.cpk !== null ? ` · Cpk ${fmt(st.cpk, 2)}` : ''}</div>}
          </div>
        );
      })}
      <Field label="Bemerkungen"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary" onClick={async () => { if (await save()) void reload(); }}>Speichern und bewerten</button>
        {i.result === 'fail' && <button className="btn" onClick={async () => { if (await save({ result: 'conditional' })) void reload(); }}>Mit Auflage freigeben</button>}
        <span className="grow" />
        <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>
      </div>
      {remove && <Confirm danger text="Prüfung löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/quality/inspections/${id}`))) onClose(); }} />}
    </SlideOver>
  );
}

// ---------------------------------------------------------------- Prüfpläne
function Plans() {
  const { data, reload } = useApi<any[]>('/quality/plans');
  const [edit, setEdit] = useState<any | null>(null);
  useLive(reload);
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({ title: '', object: '', characteristics: [], sample: '', active: true })}><Icon name="plus" /> Prüfplan</button></span></div>
      {data && !data.length && <Empty icon="list" title="Noch keine Prüfpläne">Ein Prüfplan legt fest, welche Merkmale mit welcher Toleranz und welchem Messmittel geprüft werden.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Prüfplan</th><th>Prüfobjekt</th><th>Merkmale</th><th>Stichprobe</th></tr></thead>
        <tbody>{data.map((p) => (
          <tr key={p.id} className="click" onClick={() => setEdit(p)} style={p.active ? undefined : { opacity: 0.5 }}>
            <td className="mono small">{p.number}</td><td><b>{p.title}</b></td><td>{p.object || (p.articleNumber ? `${p.articleNumber} ${p.articleName}` : '–')}</td><td>{p.characteristics.length}</td><td>{p.sample || '–'}</td>
          </tr>
        ))}</tbody></table>}
      {edit && <PlanModal plan={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function PlanModal({ plan, onClose, onSaved }: { plan: any; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [f, setF] = useState(plan);
  const [remove, setRemove] = useState(false);
  const setC = (i: number, p: Partial<Characteristic>) => setF({ ...f, characteristics: f.characteristics.map((c: Characteristic, j: number) => (j === i ? { ...c, ...p } : c)) });
  return (
    <Modal size="lg" title={plan.id ? `Prüfplan ${plan.number}` : 'Neuer Prüfplan'} onClose={onClose} footer={<>
      {plan.id && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => {
        const b = { title: f.title, object: f.object, characteristics: f.characteristics.map(({ values, ...c }: Characteristic) => { void values; return c; }), sample: f.sample, active: f.active };
        if (await act(() => (plan.id ? patch(`/quality/plans/${plan.id}`, b) : post('/quality/plans', b)), 'Gespeichert')) onSaved();
      }}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Bezeichnung"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Welle 20h6 – Wareneingang" /></Field>
        <Field label="Prüfobjekt" hint="Teil, Zeichnungsnummer oder Artikel"><input value={f.object} onChange={(e) => setF({ ...f, object: e.target.value })} /></Field>
      </div>
      <Field label="Stichprobe" hint="z. B. 5 Teile je Los, 100 %, erstes und letztes Teil"><input value={f.sample} onChange={(e) => setF({ ...f, sample: e.target.value })} /></Field>
      <h3 style={{ margin: '8px 0 4px' }}>Merkmale</h3>
      <table className="table small"><thead><tr><th>Merkmal</th><th style={{ width: 110 }}>Art</th><th style={{ width: 80 }}>Soll</th><th style={{ width: 80 }}>unten</th><th style={{ width: 80 }}>oben</th><th style={{ width: 60 }}>Einheit</th><th>Prüfmittel</th><th /></tr></thead>
        <tbody>{f.characteristics.map((c: Characteristic, i: number) => (
          <tr key={c.id}>
            <td><input value={c.name} onChange={(e) => setC(i, { name: e.target.value })} /></td>
            <td><select value={c.kind} onChange={(e) => setC(i, { kind: e.target.value as Characteristic['kind'] })}><option value="measure">Messwert</option><option value="attribute">i. O. / n. i. O.</option></select></td>
            {c.kind === 'measure' ? <>
              <td><input defaultValue={fmt(c.nominal)} onBlur={(e) => setC(i, { nominal: num(e.target.value) })} /></td>
              <td><input defaultValue={fmt(c.lower)} onBlur={(e) => setC(i, { lower: num(e.target.value) })} /></td>
              <td><input defaultValue={fmt(c.upper)} onBlur={(e) => setC(i, { upper: num(e.target.value) })} /></td>
              <td><input value={c.unit ?? ''} onChange={(e) => setC(i, { unit: e.target.value })} /></td>
            </> : <td colSpan={4} className="muted small">Sichtprüfung, Funktion, Vollständigkeit …</td>}
            <td><input value={c.method ?? ''} onChange={(e) => setC(i, { method: e.target.value })} placeholder="z. B. Messschieber" /></td>
            <td><button className="btn ghost sm" onClick={() => setF({ ...f, characteristics: f.characteristics.filter((_: unknown, j: number) => j !== i) })}><Icon name="x" /></button></td>
          </tr>
        ))}</tbody></table>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => setF({ ...f, characteristics: [...f.characteristics, { id: Math.random().toString(36).slice(2, 10), name: '', kind: 'measure', nominal: null, lower: null, upper: null, unit: 'mm', method: '' }] })}><Icon name="plus" /> Messmerkmal</button>
        <button className="btn sm" onClick={() => setF({ ...f, characteristics: [...f.characteristics, { id: Math.random().toString(36).slice(2, 10), name: '', kind: 'attribute', method: 'Sichtprüfung' }] })}><Icon name="plus" /> Attributives Merkmal</button>
      </div>
      <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>
      {remove && <Confirm danger text="Prüfplan löschen? Bestehende Prüfungen bleiben." onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/quality/plans/${plan.id}`))) onSaved(); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Messmittel
function Gauges() {
  const [params, setParams] = useSearchParams();
  const { data, reload } = useApi<any[]>('/quality/gauges');
  const [edit, setEdit] = useState<any | null>(null);
  useLive(reload);
  const open = params.get('gauge');
  const setOpen = (id: string | null) => { if (id) params.set('gauge', id); else params.delete('gauge'); setParams(params, { replace: true }); };
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({ name: '', kind: '', manufacturer: '', serialNo: '', range: '', resolution: '', location: '', holderId: null, intervalMonths: 12, nextDue: '', status: 'ok', notes: '' })}><Icon name="plus" /> Messmittel</button></span></div>
      {data && !data.length && <Empty icon="ruler" title="Noch keine Messmittel">Messschieber, Bügelmessschrauben, Lehren, Drehmomentschlüssel … mit Kalibrierintervall. AperioPlan erinnert rechtzeitig an die nächste Kalibrierung.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Messmittel</th><th>Messbereich</th><th>Standort</th><th>Letzte Kalibrierung</th><th>Fällig</th><th>Status</th></tr></thead>
        <tbody>{data.map((g) => (
          <tr key={g.id} className="click" onClick={() => setOpen(g.id)}>
            <td className="mono small">{g.number}</td><td><b>{g.name}</b>{g.kind && <div className="small muted">{g.kind}</div>}</td><td>{g.range || '–'}</td>
            <td>{g.location || '–'}{g.holderName && <div className="small muted">{g.holderName}</div>}</td><td>{fmtDate(g.lastCalibration)}</td>
            <td className={g.overdue ? 'text-red' : ''}>{fmtDate(g.nextDue)}</td><td><Pill tone={g.overdue ? 'red' : GAUGE_STATUS[g.status]![1]}>{g.overdue ? 'überfällig' : GAUGE_STATUS[g.status]![0]}</Pill></td>
          </tr>
        ))}</tbody></table>}
      {edit && <GaugeModal gauge={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
      {open && <GaugePanel id={open} onClose={() => setOpen(null)} onEdit={(g) => setEdit(g)} />}
    </div>
  );
}

function GaugeModal({ gauge, onClose, onSaved }: { gauge: any; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const { users } = useSession();
  const [f, setF] = useState(gauge);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={gauge.id ? `Messmittel ${gauge.number}` : 'Neues Messmittel'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.name.trim()} onClick={async () => {
        const b = { name: f.name, kind: f.kind, manufacturer: f.manufacturer, serialNo: f.serialNo, range: f.range, resolution: f.resolution, location: f.location, holderId: f.holderId, intervalMonths: Number(f.intervalMonths), nextDue: f.nextDue || null, status: f.status, notes: f.notes };
        if (await act(() => (gauge.id ? patch(`/quality/gauges/${gauge.id}`, b) : post('/quality/gauges', b)), 'Gespeichert')) onSaved();
      }}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Bezeichnung"><input value={f.name} onChange={set('name')} placeholder="z. B. Messschieber 150 mm" /></Field>
        <Field label="Art"><input value={f.kind} onChange={set('kind')} placeholder="Messschieber, Lehrdorn, …" /></Field>
        <Field label="Hersteller"><input value={f.manufacturer} onChange={set('manufacturer')} /></Field>
        <Field label="Seriennummer"><input value={f.serialNo} onChange={set('serialNo')} /></Field>
        <Field label="Messbereich"><input value={f.range} onChange={set('range')} placeholder="0–150 mm" /></Field>
        <Field label="Auflösung"><input value={f.resolution} onChange={set('resolution')} placeholder="0,01 mm" /></Field>
        <Field label="Standort"><input value={f.location} onChange={set('location')} /></Field>
        <Field label="Verantwortlich"><UserSelect users={users} value={f.holderId} onChange={(v) => setF({ ...f, holderId: v })} /></Field>
        <Field label="Kalibrierintervall (Monate)"><input type="number" min={1} value={f.intervalMonths} onChange={set('intervalMonths')} /></Field>
        <Field label="Nächste Kalibrierung"><input type="date" value={f.nextDue ?? ''} onChange={set('nextDue')} /></Field>
        <Field label="Status"><select value={f.status} onChange={set('status')}>{Object.entries(GAUGE_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
      <Field label="Notizen"><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
    </Modal>
  );
}

function GaugePanel({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (g: any) => void }) {
  const { data: g, reload } = useApi<any>(`/quality/gauges/${id}`, [id]);
  const act = useAction();
  const [cal, setCal] = useState(false);
  const [remove, setRemove] = useState(false);
  useLive(reload);
  if (!g) return null;
  return (
    <SlideOver title={<span>{g.name} <span className="mono muted">{g.number}</span></span>} onClose={onClose} actions={<button className="btn sm" onClick={() => onEdit(g)}><Icon name="edit" /> Bearbeiten</button>}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
        <Pill tone={g.overdue ? 'red' : GAUGE_STATUS[g.status]![1]}>{g.overdue ? 'überfällig' : GAUGE_STATUS[g.status]![0]}</Pill>
        <span className="small">nächste Kalibrierung {fmtDate(g.nextDue)} · alle {g.intervalMonths} Monate</span>
      </div>
      <table className="table small"><tbody>
        {[['Art', g.kind], ['Hersteller', g.manufacturer], ['Seriennummer', g.serialNo], ['Messbereich', g.range], ['Auflösung', g.resolution], ['Standort', g.location], ['Verantwortlich', g.holderName]].filter(([, v]) => v).map(([k, v]) => <tr key={k}><td className="muted" style={{ width: 140 }}>{k}</td><td>{v}</td></tr>)}
      </tbody></table>
      <div className="row" style={{ margin: '12px 0 6px' }}><h3 className="grow" style={{ margin: 0 }}>Kalibrierungen</h3><button className="btn sm primary" onClick={() => setCal(true)}><Icon name="plus" /> Kalibrierung eintragen</button></div>
      {!g.calibrations.length && <p className="muted small">Noch keine Kalibrierung erfasst.</p>}
      <table className="table small"><tbody>{g.calibrations.map((c: any) => (
        <tr key={c.id}><td>{fmtDate(c.date)}</td><td><Pill tone={c.result === 'failed' ? 'red' : 'green'}>{{ ok: 'in Ordnung', adjusted: 'justiert', failed: 'nicht bestanden' }[c.result as string]}</Pill></td>
          <td>{c.byWhom}</td><td>{c.hasCertificate && <a href={`/api/quality/calibrations/${c.id}/certificate`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /> Zertifikat</a>}</td><td className="muted">{c.notes}</td></tr>
      ))}</tbody></table>
      <button className="btn ghost danger sm" style={{ marginTop: 16 }} onClick={() => setRemove(true)}>Messmittel löschen</button>
      {cal && <CalibrationModal gaugeId={id} onClose={() => setCal(false)} onDone={() => { setCal(false); void reload(); }} />}
      {remove && <Confirm danger text="Messmittel mit allen Kalibrierungen löschen? Besser: Status „ausgemustert“." onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/quality/gauges/${id}`))) onClose(); }} />}
    </SlideOver>
  );
}

function CalibrationModal({ gaugeId, onClose, onDone }: { gaugeId: string; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ date: isoDate(new Date()), result: 'ok', byWhom: '', notes: '' });
  const [file, setFile] = useState<File | null>(null);
  return (
    <Modal title="Kalibrierung eintragen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => { if (await act(() => uploadForm(`/quality/gauges/${gaugeId}/calibrations`, f, file), 'Eingetragen')) onDone(); }}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Datum"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Ergebnis"><select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option value="ok">in Ordnung</option><option value="adjusted">justiert</option><option value="failed">nicht bestanden (sperren)</option></select></Field>
      </div>
      <Field label="Durchgeführt von"><input value={f.byWhom} onChange={(e) => setF({ ...f, byWhom: e.target.value })} placeholder="intern oder Kalibrierlabor" /></Field>
      <Field label="Zertifikat"><input type="file" accept=".pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <Field label="Bemerkung"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- 8D
function EightDs() {
  const [params, setParams] = useSearchParams();
  const { data, reload } = useApi<any[]>('/quality/8d');
  const [create, setCreate] = useState(false);
  useLive(reload);
  const open = params.get('report');
  const setOpen = (id: string | null) => { if (id) params.set('report', id); else params.delete('report'); setParams(params, { replace: true }); };
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> 8D-Report</button></span></div>
      {data && !data.length && <Empty icon="report" title="Keine 8D-Reports">Für Reklamationen von Kunden oder an Lieferanten: in acht Schritten von der Sofortmaßnahme bis zur Abstellung der Ursache.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Thema</th><th>Kunde / Lieferant</th><th>Verantwortlich</th><th>Termin</th><th>Status</th></tr></thead>
        <tbody>{data.map((e) => (
          <tr key={e.id} className="click" onClick={() => setOpen(e.id)}>
            <td className="mono small">{e.number}</td><td><b>{e.title}</b>{e.reference && <div className="small muted">{e.reference}</div>}</td><td>{e.accountName ?? '–'}</td>
            <td>{e.ownerName ?? '–'}</td><td className={e.overdue ? 'text-red' : ''}>{fmtDate(e.dueDate)}</td><td><Pill tone={e.status === 'closed' ? 'green' : 'amber'}>{EIGHT_D_STATUS[e.status]}</Pill></td>
          </tr>
        ))}</tbody></table>}
      {create && <NewEightD onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); setOpen(id); }} />}
      {open && <EightDPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewEightD({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const act = useAction();
  const [f, setF] = useState({ title: '', source: 'customer', account: null as any, reference: '', dueDate: '' });
  return (
    <Modal title="Neuer 8D-Report" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => { const r = await act(() => post<{ id: string }>('/quality/8d', { title: f.title, source: f.source, accountId: f.account?.id ?? null, reference: f.reference, dueDate: f.dueDate || null })); if (r) onDone(r.id); }}>Anlegen</button></>}>
      <Field label="Thema"><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Riss im Gehäuse" /></Field>
      <div className="grid2">
        <Field label="Herkunft"><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="customer">Kundenreklamation</option><option value="supplier">Lieferantenreklamation</option><option value="internal">intern</option></select></Field>
        <Field label="Termin"><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
      </div>
      <Field label={f.source === 'supplier' ? 'Lieferant' : 'Kunde'}><CustomerPicker kind={f.source === 'supplier' ? 'supplier' : 'customer'} value={f.account} onChange={(a) => setF({ ...f, account: a })} /></Field>
      <Field label="Bezug" hint="Reklamationsnummer des Kunden, Lieferschein, Charge"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
    </Modal>
  );
}

function EightDPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: e, reload } = useApi<any>(`/quality/8d/${id}`, [id]);
  const { users } = useSession();
  const act = useAction();
  const [d, setD] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<any>(null);
  useEffect(() => { if (e) { setD(e.d); setMeta({ status: e.status, ownerId: e.ownerId, team: e.team, dueDate: e.dueDate ?? '' }); } }, [e?.id, e?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!e || !meta) return null;
  const save = () => act(() => patch(`/quality/8d/${id}`, { d, status: meta.status, ownerId: meta.ownerId, team: meta.team, dueDate: meta.dueDate || null }), 'Gespeichert');
  return (
    <SlideOver wide title={<span>{e.title} <span className="mono muted">{e.number}</span></span>} onClose={onClose}
      actions={<a className="btn sm" href={`/api/quality/8d/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="printer" /> PDF</a>}>
      <div className="grid3">
        <Field label="Status"><select value={meta.status} onChange={(x) => setMeta({ ...meta, status: x.target.value })}>{Object.entries(EIGHT_D_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Verantwortlich"><UserSelect users={users} value={meta.ownerId} onChange={(v) => setMeta({ ...meta, ownerId: v })} /></Field>
        <Field label="Termin"><input type="date" value={meta.dueDate} onChange={(x) => setMeta({ ...meta, dueDate: x.target.value })} /></Field>
      </div>
      <Field label="Team"><UserPicker users={users} value={meta.team} onChange={(ids) => setMeta({ ...meta, team: ids })} /></Field>
      <p className="small muted">{e.accountName ? `${e.accountName} · ` : ''}{e.reference}</p>
      {EIGHT_D.slice(1).map((s) => (
        <Field key={s.key} label={s.title} hint={s.hint}><textarea rows={3} value={d[s.key] ?? ''} onChange={(x) => setD({ ...d, [s.key]: x.target.value })} /></Field>
      ))}
      <button className="btn primary" onClick={async () => { if (await save()) void reload(); }}>Speichern</button>
    </SlideOver>
  );
}
