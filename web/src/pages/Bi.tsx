import { useEffect, useState } from 'react';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate } from '../lib/format';
import { Empty, Field, Modal, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { Chart } from '../modules/Chart';

type Def = { source: string; dim: string; dim2: string | null; measure: string; period: string; from: string | null; to: string | null; chart: string; limit: number };
const PERIODS: Record<string, string> = { month: 'dieser Monat', quarter: 'dieses Quartal', year: 'dieses Jahr', lastYear: 'letztes Jahr', '12m': 'letzte 12 Monate', all: 'gesamter Zeitraum', custom: 'eigener Zeitraum' };
const CHARTS: Record<string, [string, string]> = { bar: ['Säulen', 'chart'], hbar: ['Balken', 'list'], line: ['Linie', 'chart-up'], table: ['Tabelle', 'report'], number: ['Kennzahl', 'target'] };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'bi.changed') void reload(); }), [reload]);
}
const fmt = (m: { unit: string; decimals: number }) => (v: number) => {
  const n = v.toLocaleString('de-DE', { minimumFractionDigits: m.unit === '€' ? 2 : 0, maximumFractionDigits: m.decimals });
  return m.unit ? `${n} ${m.unit}` : n;
};

export default function BiPage() {
  useCrumbs([{ label: 'Auswertungen' }]);
  const [tab, setTab] = useTabState<'board' | 'build'>('bi', 'board');
  const { data: reports, reload } = useApi<any[]>('/bi/reports');
  const [edit, setEdit] = useState<any | null>(null);
  useLive(reload);
  const pinned = reports?.filter((r) => r.pinned) ?? [];
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Auswertungen</h1><div className="sub">Berichte und Diagramme aus deinen Daten</div></div>
        <div className="actions"><button className="btn primary" onClick={() => { setEdit(null); setTab('build'); }}><Icon name="plus" /> Bericht</button></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'board', label: 'Übersicht' }, { id: 'build', label: edit ? `Bericht: ${edit.name}` : 'Bericht erstellen' }]} />
      {tab === 'board' && (reports && !pinned.length ? <Empty icon="chart" title="Noch keine Berichte angeheftet">Unter „Bericht erstellen“ Datenquelle, Gruppierung und Kennzahl wählen, dann speichern – angeheftete Berichte erscheinen hier.</Empty>
        : <div className="bi-board">{pinned.map((r) => <ReportCard key={r.id} r={r} onEdit={() => { setEdit(r); setTab('build'); }} onChanged={reload} />)}</div>)}
      {tab === 'build' && <Builder key={edit?.id ?? 'new'} report={edit} onSaved={(r) => { setEdit(r); void reload(); }} onDeleted={() => { setEdit(null); setTab('board'); void reload(); }} />}
      {tab === 'board' && reports && reports.some((r) => !r.pinned) && <><h3>Weitere Berichte</h3>
        <div className="row wrap" style={{ gap: 6 }}>{reports.filter((r) => !r.pinned).map((r) => <button key={r.id} className="btn sm" onClick={() => { setEdit(r); setTab('build'); }}>{r.name}</button>)}</div></>}
    </div>
  );
}

function ReportCard({ r, onEdit, onChanged }: { r: any; onEdit: () => void; onChanged: () => void }) {
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState('');
  const act = useAction();
  useEffect(() => { void post('/bi/run', r.def).then(setRes).catch((e) => setErr((e as Error).message)); }, [JSON.stringify(r.def)]);
  return (
    <div className={`card bi-card ${r.def.chart === 'number' ? 'small' : ''}`}>
      <div className="row" style={{ gap: 6 }}><b className="grow">{r.name}</b>{r.shared && <span className="small muted" title="für alle sichtbar"><Icon name="users" /></span>}
        <button className="btn ghost sm" onClick={onEdit} title="Bearbeiten"><Icon name="edit" /></button>
        {r.mine && <button className="btn ghost sm" title="Abheften" onClick={async () => { if (await act(() => patch(`/bi/reports/${r.id}`, { pinned: false }))) onChanged(); }}><Icon name="x" /></button>}</div>
      {err ? <p className="muted small">{err}</p> : res ? <Result def={r.def} res={res} compact /> : <div style={{ height: 120 }} />}
    </div>
  );
}

function Result({ def, res, compact }: { def: Def; res: any; compact?: boolean }) {
  const f = fmt(res.measure);
  if (def.chart === 'number') return <div className="bi-number"><div className="v">{f(res.total)}</div><div className="small muted">{res.measure.label} · {res.from ? `${fmtDate(res.from)} – ${fmtDate(res.to)}` : 'gesamt'}</div></div>;
  if (def.chart === 'table') return (
    <div style={{ maxHeight: compact ? 300 : undefined, overflow: 'auto' }}>
      <table className="table small"><thead><tr><th>{res.dim}</th>{(res.series.length ? res.series : [res.measure.label]).map((s: string) => <th key={s} className="num">{s}</th>)}</tr></thead>
        <tbody>{res.rows.map((r: any) => <tr key={r.key}><td>{r.key}</td>{r.values.map((v: number, i: number) => <td key={i} className="num">{f(v)}</td>)}</tr>)}
          <tr><td><b>Gesamt</b></td><td className="num" colSpan={Math.max(1, res.series.length)}><b>{f(res.total)}</b></td></tr></tbody></table>
    </div>
  );
  return <>
    <Chart kind={def.chart as 'bar'} rows={res.rows} series={res.series} format={f} unit={res.measure.unit} height={compact ? 220 : 300} />
    <div className="small muted">{res.measure.label} je {res.dim}{res.dim2 ? ` und ${res.dim2}` : ''} · gesamt {f(res.total)}{res.truncated ? ` · nur die ${def.limit} größten` : ''}{res.otherSeries ? ` · ${res.otherSeries} weitere Reihen ausgeblendet` : ''}</div>
  </>;
}

function Builder({ report, onSaved, onDeleted }: { report: any | null; onSaved: (r: any) => void; onDeleted: () => void }) {
  const { me } = useSession();
  const { data: sources } = useApi<any[]>('/bi/sources');
  const act = useAction();
  const [def, setDef] = useState<Def>(report?.def ?? { source: 'time', dim: 'month', dim2: null, measure: 'hours', period: '12m', from: null, to: null, chart: 'bar', limit: 20 });
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState('');
  const [save, setSave] = useState(false);
  const src = sources?.find((s) => s.id === def.source);
  useEffect(() => {
    if (!sources?.length) return;
    if (!src) { const s = sources[0]; setDef((d) => ({ ...d, source: s.id, dim: 'month', dim2: null, measure: s.measures[0].key })); return; }
    setErr('');
    void post('/bi/run', def).then(setRes).catch((e) => { setRes(null); setErr((e as Error).message); });
  }, [JSON.stringify(def), sources]);
  if (!sources) return null;
  if (!sources.length) return <Empty icon="chart" title="Keine Datenquellen">Für Auswertungen werden weitere Apps benötigt (z. B. Zeiterfassung, Kunden).</Empty>;
  const pickSource = (id: string) => { const s = sources.find((x) => x.id === id)!; setDef({ ...def, source: id, dim: 'month', dim2: null, measure: s.measures[0].key }); };
  return (
    <div className="bi-build">
      <div className="card bi-controls">
        <Field label="Datenquelle"><select value={def.source} onChange={(e) => pickSource(e.target.value)}>{sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
        {src && <p className="small muted" style={{ marginTop: -6 }}>{src.description}</p>}
        <Field label="Kennzahl"><select value={def.measure} onChange={(e) => setDef({ ...def, measure: e.target.value })}>{src?.measures.map((m: any) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></Field>
        <Field label="Gruppiert nach"><select value={def.dim} onChange={(e) => setDef({ ...def, dim: e.target.value, dim2: def.dim2 === e.target.value ? null : def.dim2 })}>
          <optgroup label="Zeit">{src?.dims.filter((d: any) => d.time).map((d: any) => <option key={d.key} value={d.key}>{d.label}</option>)}</optgroup>
          <optgroup label="Merkmal">{src?.dims.filter((d: any) => !d.time).map((d: any) => <option key={d.key} value={d.key}>{d.label}</option>)}</optgroup></select></Field>
        <Field label="Unterteilt nach" hint="eigene Farbe je Wert, höchstens 8"><select value={def.dim2 ?? ''} onChange={(e) => setDef({ ...def, dim2: e.target.value || null })}><option value="">–</option>
          {src?.dims.filter((d: any) => d.key !== def.dim && (!d.time || !src.dims.find((x: any) => x.key === def.dim)?.time)).map((d: any) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></Field>
        <Field label="Zeitraum"><select value={def.period} onChange={(e) => setDef({ ...def, period: e.target.value })}>{Object.entries(PERIODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {def.period === 'custom' && <div className="grid2"><input type="date" value={def.from ?? ''} onChange={(e) => setDef({ ...def, from: e.target.value || null })} /><input type="date" value={def.to ?? ''} onChange={(e) => setDef({ ...def, to: e.target.value || null })} /></div>}
        <Field label="Darstellung"><div className="row wrap" style={{ gap: 4 }}>{Object.entries(CHARTS).map(([k, [l, ic]]) => <button key={k} className={`btn sm ${def.chart === k ? 'primary' : ''}`} onClick={() => setDef({ ...def, chart: k })}><Icon name={ic} /> {l}</button>)}</div></Field>
        <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
          <button className="btn primary" onClick={() => setSave(true)}><Icon name="check" /> {report?.mine === false ? 'Als eigenen Bericht speichern' : 'Speichern'}</button>
          <button className="btn" onClick={async () => {
            const r = await fetch('/api/bi/export.xlsx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: report?.name ?? 'Auswertung', def }) });
            if (r.ok) { const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `${report?.name ?? 'Auswertung'}.xlsx`; a.click(); }
          }}><Icon name="download" /> Excel</button>
          {report && (report.mine || me?.role === 'admin') && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/bi/reports/${report.id}`), 'Gelöscht')) onDeleted(); }}><Icon name="trash" /></button>}
        </div>
      </div>
      <div className="card bi-result">{err ? <p className="text-red">{err}</p> : res ? <Result def={def} res={res} /> : null}</div>
      {save && <SaveModal report={report?.mine === false ? null : report} def={def} onClose={() => setSave(false)} onDone={(r) => { setSave(false); onSaved(r); }} />}
    </div>
  );
}

function SaveModal({ report, def, onClose, onDone }: { report: any | null; def: Def; onClose: () => void; onDone: (r: any) => void }) {
  const { me } = useSession();
  const act = useAction();
  const [f, setF] = useState({ name: report?.name ?? '', pinned: report?.pinned ?? true, shared: report?.shared ?? false });
  return (
    <Modal title="Bericht speichern" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.name.trim()} onClick={async () => {
        const r = await act(async () => (report ? (await patch(`/bi/reports/${report.id}`, { ...f, def }), { id: report.id }) : post<{ id: string }>('/bi/reports', { ...f, def })), 'Gespeichert');
        if (r) onDone({ ...report, ...f, id: r.id, def, mine: true });
      }}>Speichern</button></>}>
      <Field label="Name"><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Stunden je Projekt" /></Field>
      <label className="row"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> in der Übersicht anzeigen</label>
      {me?.role === 'admin' && <label className="row"><input type="checkbox" checked={f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} /> für alle Mitarbeiter sichtbar (jeder sieht nur seine eigenen Daten)</label>}
    </Modal>
  );
}
