import { useEffect, useState } from 'react';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, isoDate } from '../lib/format';
import { Empty, Field, Modal, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { ProjectSelect } from '../modules/Pickers';
import { Chart } from '../modules/Chart';
import { useAdminSettings } from './Settings';

const t = (v: number) => `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 2 : 1 })} t`;
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const ORIGIN: Record<string, string> = { manual: 'erfasst', fleet: 'Fuhrpark', expenses: 'Spesen' };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'sustainability.changed') void reload(); }), [reload]);
}
type Tab = 'overview' | 'entries' | 'factors' | 'settings';

export default function SustainabilityPage() {
  useCrumbs([{ label: 'Nachhaltigkeit' }]);
  const { me } = useSession();
  const [year, setYear] = useState(new Date().getFullYear());
  const [tab, setTab] = useTabState<Tab>('sustainability', 'overview');
  const { data: access } = useApi<{ manager: boolean }>('/sustainability/access');
  const { data: s, reload } = useApi<any>(`/sustainability/summary?year=${year}`, [year]);
  const act = useAction();
  const toast = useToast();
  useLive(reload);
  const mgr = !!access?.manager;
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Nachhaltigkeit</h1><div className="sub">Energie und CO₂-Bilanz nach Scope 1, 2 und 3</div></div>
        <div className="actions">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 'auto' }}>{Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i).map((y) => <option key={y}>{y}</option>)}</select>
          {mgr && <button className="btn" onClick={async () => { const r = await act(() => post<{ fleet: number; expenses: number }>('/sustainability/import', { year })); if (r) toast(`${r.fleet} Tankbelege und ${r.expenses} Dienstfahrten übernommen`); }}><Icon name="refresh" /> Daten übernehmen</button>}
          <a className="btn" href={`/api/sustainability/report.xlsx?year=${year}`}><Icon name="download" /> CO₂-Bilanz</a></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Übersicht' }, { id: 'entries', label: 'Verbräuche' }, { id: 'factors', label: 'Emissionsfaktoren' }, ...(me?.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])]} />
      {tab === 'overview' && s && <Overview s={s} />}
      {tab === 'entries' && <Entries year={year} manager={mgr} />}
      {tab === 'factors' && <Factors manager={mgr} />}
      {tab === 'settings' && <SusSettings />}
    </div>
  );
}

function Overview({ s }: { s: any }) {
  if (!s.total) return <Empty icon="leaf" title={`Noch keine Werte für ${s.year}`}>Unter „Verbräuche“ Strom-, Gas- oder Heizölrechnungen eintragen. Tankbelege aus dem Fuhrpark und Dienstfahrten aus den Spesen werden nachts automatisch übernommen.</Empty>;
  const prev = s.years.find((y: any) => y.y === s.year - 1)?.t;
  const change = prev ? ((s.total - prev) / prev) * 100 : null;
  return (
    <div>
      <div className="kpi-row">
        <div className="card kpi"><div className="small muted">CO₂ {s.year}</div><div className="v">{t(s.total)}</div>{change !== null && <div className={`small ${change > 0 ? 'text-red' : 'text-green'}`}>{change > 0 ? '+' : ''}{change.toFixed(1)} % zum Vorjahr</div>}</div>
        <div className="card kpi"><div className="small muted">je Mitarbeiter</div><div className="v">{s.perEmployee !== null ? t(s.perEmployee) : '–'}</div><div className="small muted">{s.employees} Personen</div></div>
        {s.scopes.map((x: any) => <div key={x.k} className="card kpi"><div className="small muted">{x.k}</div><div className="v">{t(x.t)}</div><div className="small muted">{{ 'Scope 1': 'eigene Verbrennung', 'Scope 2': 'eingekaufte Energie', 'Scope 3': 'Reisen und Vorketten' }[x.k as string]}</div></div>)}
        {s.target.value !== null && <div className="card kpi"><div className="small muted">Ziel {s.target.targetYear}</div><div className="v">{t(s.target.value)}</div><div className="small muted">−{s.target.percent} % gegenüber {s.target.baseYear} ({t(s.target.base)})</div></div>}
      </div>
      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="card"><b>Verlauf {s.year}</b><Chart kind="bar" rows={s.months.map((m: any) => ({ key: MONTHS[m.month - 1]!, values: [m.t] }))} series={[]} format={t} unit="t" height={240} /></div>
        <div className="card"><b>Nach Kategorie</b><Chart kind="hbar" rows={s.categories.map((x: any) => ({ key: x.k, values: [x.t] }))} series={[]} format={t} unit="t" /></div>
      </div>
      <div className="grid2" style={{ alignItems: 'start', marginTop: 12 }}>
        <div className="card"><b>Energieträger</b><table className="table small"><thead><tr><th>Quelle</th><th className="num">Menge</th><th>Scope</th><th className="num">CO₂</th></tr></thead>
          <tbody>{s.sources.map((x: any) => <tr key={x.k}><td>{x.k}</td><td className="num">{x.qty.toLocaleString('de-DE', { maximumFractionDigits: 0 })} {x.unit}</td><td>{x.scope}</td><td className="num">{t(x.t)}</td></tr>)}</tbody></table></div>
        <div className="card"><b>Projekte</b><Chart kind="hbar" rows={s.projects.slice(0, 10).map((x: any) => ({ key: x.k, values: [x.t] }))} series={[]} format={t} unit="t" /></div>
      </div>
      {s.years.length > 1 && <div className="card" style={{ marginTop: 12 }}><b>Jahre</b><Chart kind="line" rows={s.years.map((y: any) => ({ key: String(y.y), values: [y.t] }))} series={[]} format={t} unit="t" height={200} /></div>}
    </div>
  );
}

function Entries({ year, manager }: { year: number; manager: boolean }) {
  const { data, reload } = useApi<any[]>(`/sustainability/entries?year=${year}`, [year]);
  const { data: factors } = useApi<any[]>('/sustainability/factors');
  const act = useAction();
  const [edit, setEdit] = useState<any | null>(null);
  useLive(reload);
  return (
    <div>
      {manager && <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({ date: `${year}-01-01`, periodEnd: `${year}-12-31`, factorId: factors?.[0]?.id ?? '', quantity: '', projectId: null, site: '', note: '' })}><Icon name="plus" /> Verbrauch</button></span></div>}
      {data && !data.length ? <Empty icon="leaf" title="Keine Verbräuche">{manager ? 'Zählerstände oder Jahresrechnungen eintragen – je Standort oder Projekt.' : undefined}</Empty>
        : <table className="table"><thead><tr><th>Zeitraum</th><th>Energieträger</th><th className="num">Menge</th><th className="num">kg CO₂</th><th>Projekt / Standort</th><th>Herkunft</th><th /></tr></thead>
          <tbody>{data?.map((e) => (
            <tr key={e.id} className={manager && e.origin === 'manual' ? 'click' : ''} onClick={() => manager && e.origin === 'manual' && setEdit({ ...e, quantity: String(e.quantity) })}>
              <td>{fmtDate(e.date)}{e.periodEnd ? ` – ${fmtDate(e.periodEnd)}` : ''}</td><td>{e.factorLabel}<div className="small muted">Scope {e.scope}</div></td>
              <td className="num">{e.quantity.toLocaleString('de-DE')} {e.unit}</td><td className="num">{Math.round(e.kg).toLocaleString('de-DE')}</td>
              <td>{[e.projectNumber, e.site].filter(Boolean).join(' · ')}<div className="small muted">{e.note}</div></td><td className="small">{ORIGIN[e.origin]}</td>
              <td>{manager && e.origin === 'manual' && <button className="btn ghost sm" onClick={async (ev) => { ev.stopPropagation(); if (await act(() => del(`/sustainability/entries/${e.id}`))) void reload(); }}><Icon name="trash" /></button>}</td>
            </tr>
          ))}</tbody></table>}
      {edit && <EntryModal e={edit} factors={factors ?? []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function EntryModal({ e, factors, onClose, onDone }: { e: any; factors: any[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState(e);
  const factor = factors.find((x) => x.id === f.factorId);
  const qty = Number(String(f.quantity).replace(',', '.'));
  const body = { date: f.date, periodEnd: f.periodEnd || null, factorId: f.factorId, quantity: qty, projectId: f.projectId, site: f.site, note: f.note };
  return (
    <Modal title={e.id ? 'Verbrauch bearbeiten' : 'Verbrauch erfassen'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.factorId || !(qty >= 0) || f.quantity === ''} onClick={async () => { if (await act(() => (e.id ? patch(`/sustainability/entries/${e.id}`, body) : post('/sustainability/entries', body)), 'Gespeichert')) onDone(); }}>Speichern</button></>}>
      <Field label="Energieträger"><select value={f.factorId} onChange={(x) => setF({ ...f, factorId: x.target.value })}>{factors.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.label} ({x.unit})</option>)}</select></Field>
      <div className="grid3">
        <Field label="von"><input type="date" value={f.date} onChange={(x) => setF({ ...f, date: x.target.value })} /></Field>
        <Field label="bis"><input type="date" value={f.periodEnd ?? ''} onChange={(x) => setF({ ...f, periodEnd: x.target.value })} /></Field>
        <Field label={`Menge${factor ? ` (${factor.unit})` : ''}`}><input value={f.quantity} onChange={(x) => setF({ ...f, quantity: x.target.value })} /></Field>
      </div>
      {factor && qty > 0 && <p className="small muted">= {(qty * factor.kgPerUnit).toLocaleString('de-DE', { maximumFractionDigits: 0 })} kg CO₂ (Faktor {factor.kgPerUnit.toLocaleString('de-DE')} kg/{factor.unit})</p>}
      <div className="grid2">
        <Field label="Projekt"><ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} /></Field>
        <Field label="Standort"><input value={f.site} onChange={(x) => setF({ ...f, site: x.target.value })} placeholder="z. B. Werk 1" /></Field>
      </div>
      <Field label="Bemerkung"><input value={f.note} onChange={(x) => setF({ ...f, note: x.target.value })} placeholder="z. B. Jahresabrechnung Stadtwerke" /></Field>
    </Modal>
  );
}

function Factors({ manager }: { manager: boolean }) {
  const { data, reload } = useApi<any[]>('/sustainability/factors');
  const act = useAction();
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      {manager && <div className="toolbar"><span className="right"><button className="btn" onClick={() => setEdit({ label: '', unit: 'kWh', kgPerUnit: 0, scope: 2, category: 'Strom', source: '', active: true })}><Icon name="plus" /> Faktor</button></span></div>}
      <table className="table"><thead><tr><th>Energieträger</th><th className="num">kg CO₂ je Einheit</th><th>Scope</th><th>Quelle</th></tr></thead>
        <tbody>{data?.map((f) => (
          <tr key={f.id} className={manager ? 'click' : ''} onClick={() => manager && setEdit(f)} style={!f.active ? { opacity: 0.5 } : undefined}>
            <td><b>{f.label}</b><div className="small muted">{f.category}</div></td><td className="num">{f.kgPerUnit.toLocaleString('de-DE', { maximumFractionDigits: 5 })} / {f.unit}</td><td>{f.scope}</td><td className="small muted">{f.source}</td>
          </tr>
        ))}</tbody></table>
      <p className="hint">Vorbelegt mit Werten des Umweltbundesamts (Strommix, Verkehrsmittel) und dem CO₂-Faktoren-Merkblatt von BAFA/KfW. Bei Ökostrom-Tarif mit Herkunftsnachweis den Faktor „Ökostrom“ verwenden oder den Wert des Versorgers eintragen.</p>
      {edit && <Modal title={edit.id ? 'Faktor bearbeiten' : 'Neuer Faktor'} onClose={() => setEdit(null)} footer={<>
        {edit.id && !edit.used && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/sustainability/factors/${edit.id}`))) { setEdit(null); void reload(); } }}><Icon name="trash" /></button>}<span className="grow" />
        <button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
        <button className="btn primary" onClick={async () => { const b = { label: edit.label, unit: edit.unit, kgPerUnit: Number(edit.kgPerUnit), scope: Number(edit.scope), category: edit.category, source: edit.source, active: edit.active };
          if (await act(() => (edit.id ? patch(`/sustainability/factors/${edit.id}`, b) : post('/sustainability/factors', b)), 'Gespeichert')) { setEdit(null); void reload(); } }}>Speichern</button></>}>
        <Field label="Bezeichnung"><input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
        <div className="grid3">
          <Field label="Einheit"><input value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} /></Field>
          <Field label="kg CO₂ je Einheit"><input type="number" step="0.001" value={edit.kgPerUnit} onChange={(e) => setEdit({ ...edit, kgPerUnit: e.target.value })} /></Field>
          <Field label="Scope"><select value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value })}><option value={1}>1 – eigene Verbrennung</option><option value={2}>2 – eingekaufte Energie</option><option value={3}>3 – Reisen, Vorketten</option></select></Field>
        </div>
        <div className="grid2">
          <Field label="Kategorie"><input value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></Field>
          <Field label="Quelle des Werts"><input value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} /></Field>
        </div>
        <label className="row"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> aktiv</label>
      </Modal>}
    </div>
  );
}

function SusSettings() {
  const s = useAdminSettings('sustainability');
  const { users } = useSession();
  const act = useAction();
  if (!s.value) return null;
  const v = s.value;
  return (
    <div style={{ maxWidth: 760 }}>
      <Field label="Verantwortliche" hint="dürfen Verbräuche und Faktoren pflegen"><UserPicker users={users} value={v.managerIds} onChange={(ids) => s.setValue({ ...v, managerIds: ids })} /></Field>
      <div className="grid3">
        <Field label="Basisjahr"><input type="number" value={v.baseYear} onChange={(e) => s.setValue({ ...v, baseYear: Number(e.target.value) })} /></Field>
        <Field label="Zieljahr"><input type="number" value={v.targetYear} onChange={(e) => s.setValue({ ...v, targetYear: Number(e.target.value) })} /></Field>
        <Field label="Minderung (%)"><input type="number" min={0} max={100} value={v.targetPercent} onChange={(e) => s.setValue({ ...v, targetPercent: Number(e.target.value) })} /></Field>
      </div>
      <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
    </div>
  );
}
