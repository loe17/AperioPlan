import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCan } from '../session';
import { fmtDate, fmtDateTime } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { LocationSelect, ProjectSelect } from '../modules/Pickers';
import { qrSvg } from '../modules/Scan';

type Tab = 'orders' | 'floor' | 'load' | 'workcenters';
const STATUS: Record<string, [string, string]> = { planned: ['geplant', ''], released: ['freigegeben', 'blue'], in_progress: ['in Arbeit', 'amber'], done: ['fertig', 'green'], cancelled: ['storniert', ''] };
const OP_STATUS: Record<string, [string, string]> = { open: ['offen', ''], running: ['läuft', 'amber'], done: ['erledigt', 'green'] };
const PROC: Record<string, string> = { make: 'Eigenfertigung', buy: 'Kaufteil', standard: 'Normteil' };
const n3 = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 3 });

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'manufacturing.changed') void reload(); }), [reload]);
}

export default function ManufacturingPage() {
  useCrumbs([{ label: 'Fertigung' }]);
  const [tab, setTab] = useTabState<Tab>('manufacturing', 'orders');
  const [params, setParams] = useSearchParams();
  const open = params.get('order');
  const setOpen = (id: string | null) => { if (id) params.set('order', id); else params.delete('order'); setParams(params, { replace: true }); };
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Fertigung</h1><div className="sub">Fertigungsaufträge, Arbeitspläne und Rückmeldung am Arbeitsplatz</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'orders', label: 'Aufträge' }, { id: 'floor', label: 'Arbeitsplatz' }, { id: 'load', label: 'Plantafel' }, { id: 'workcenters', label: 'Arbeitsplätze' }]} />
      {tab === 'orders' && <Orders onOpen={setOpen} />}
      {tab === 'floor' && <Floor onOpen={setOpen} />}
      {tab === 'load' && <Load onOpen={setOpen} />}
      {tab === 'workcenters' && <Workcenters />}
      {open && <OrderPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Orders({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [create, setCreate] = useState(false);
  const { data, reload } = useApi<any[]>(`/manufacturing/orders?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`);
  useLive(reload);
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="active">offen</option><option value="">alle</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <span className="right"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Fertigungsauftrag</button></span>
      </div>
      {data && !data.length && <Empty icon="factory" title="Keine Fertigungsaufträge">Am schnellsten aus einer Baugruppe der CAD-Bridge: die Stückliste wird übernommen, Kaufteile sind mit dem Lager verknüpft.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Auftrag</th><th>Projekt</th><th style={{ textAlign: 'right' }}>Menge</th><th>Fortschritt</th><th>Termin</th><th>Status</th></tr></thead>
        <tbody>{data.map((o) => {
          const done = o.operations.filter((x: any) => x.status === 'done').length;
          return (
            <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
              <td className="mono small">{o.number}</td><td><b>{o.title}</b></td><td>{o.projectNumber ?? '–'}</td>
              <td style={{ textAlign: 'right' }}>{n3(o.qtyDone)} / {n3(o.qty)}</td>
              <td style={{ width: 140 }}><div className="mfg-progress"><span style={{ width: `${o.operations.length ? (done / o.operations.length) * 100 : 0}%` }} /></div><div className="small muted">{done} von {o.operations.length} Arbeitsgängen</div></td>
              <td className={o.overdue ? 'text-red' : ''}>{fmtDate(o.dueDate)}</td><td><Pill tone={STATUS[o.status]![1]}>{STATUS[o.status]![0]}</Pill></td>
            </tr>
          );
        })}</tbody></table>}
      {create && <NewOrder onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); onOpen(id); }} />}
    </div>
  );
}

function NewOrder({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const can = useCan();
  const act = useAction();
  const [mode, setMode] = useState<'cad' | 'manual'>(can('cad') ? 'cad' : 'manual');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [item, setItem] = useState<any | null>(null);
  const [f, setF] = useState({ title: '', qty: 1, dueDate: '', projectId: null as string | null });
  useEffect(() => {
    if (mode !== 'cad' || q.trim().length < 2) { setItems([]); return; }
    const t = setTimeout(() => { void get<any[]>(`/cad/items?q=${encodeURIComponent(q)}&limit=30`).then((r) => setItems(r.filter((x) => x.type !== 'drawing'))).catch(() => setItems([])); }, 250);
    return () => clearTimeout(t);
  }, [q, mode]);
  return (
    <Modal title="Neuer Fertigungsauftrag" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={mode === 'cad' ? !item : !f.title.trim()} onClick={async () => {
        const r = mode === 'cad' ? await act(() => post<{ id: string }>('/manufacturing/orders/from-cad', { cadItemId: item.id, qty: Number(f.qty), dueDate: f.dueDate || null }))
          : await act(() => post<{ id: string }>('/manufacturing/orders', { title: f.title, qty: Number(f.qty), dueDate: f.dueDate || null, projectId: f.projectId, operations: [{ name: 'Fertigung' }] }));
        if (r) onDone(r.id);
      }}>Anlegen</button></>}>
      {can('cad') && <div className="row" style={{ gap: 14, marginBottom: 10 }}>
        <label className="row"><input type="radio" checked={mode === 'cad'} onChange={() => setMode('cad')} /> aus CAD-Baugruppe</label>
        <label className="row"><input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} /> frei</label>
      </div>}
      {mode === 'cad' ? <>
        <Field label="Teil oder Baugruppe"><input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setItem(null); }} placeholder="Nummer oder Benennung …" /></Field>
        {item ? <div className="card flat row"><Icon name={item.type === 'assembly' ? 'assembly' : 'part'} /><b className="grow">{item.number} {item.designation}</b><button className="btn ghost sm" onClick={() => setItem(null)}><Icon name="x" /></button></div>
          : <div className="mfg-pick">{items.map((x) => <button key={x.id} className="row" onClick={() => setItem(x)}><Icon name={x.type === 'assembly' ? 'assembly' : 'part'} /> <span className="mono">{x.number}</span> {x.designation}</button>)}</div>}
      </> : <>
        <Field label="Bezeichnung"><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Projekt"><ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} /></Field>
      </>}
      <div className="grid2">
        <Field label="Menge"><input type="number" min={1} value={f.qty} onChange={(e) => setF({ ...f, qty: Number(e.target.value) })} /></Field>
        <Field label="Liefertermin"><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function OrderPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: o, reload } = useApi<any>(`/manufacturing/orders/${id}`, [id]);
  const { data: wcs } = useApi<any[]>('/manufacturing/workcenters');
  const can = useCan();
  const act = useAction();
  const [ops, setOps] = useState<any[]>([]);
  const [issue, setIssue] = useState(false);
  const [remove, setRemove] = useState(false);
  const [meta, setMeta] = useState<any>(null);
  useLive(reload);
  useEffect(() => { if (o) { setOps(o.operations); setMeta({ qty: o.qty, dueDate: o.dueDate ?? '', startDate: o.startDate ?? '', priority: o.priority, notes: o.notes }); } }, [o?.id, o?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o || !meta) return null;
  const editable = o.status === 'planned' || o.status === 'released';
  const setOp = (i: number, p: any) => setOps(ops.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const save = (extra: Record<string, unknown> = {}, msg = 'Gespeichert') => act(() => patch(`/manufacturing/orders/${id}`, { operations: ops, qty: Number(meta.qty), dueDate: meta.dueDate || null, startDate: meta.startDate || null, priority: Number(meta.priority), notes: meta.notes, ...extra }), msg);
  const plannedMin = ops.reduce((s, x) => s + Number(x.setupMin) + Number(x.minPerUnit) * o.qty, 0);
  const actualMin = ops.reduce((s, x) => s + Number(x.actualMin ?? 0), 0);
  return (
    <SlideOver wide title={<span>{o.title} <span className="mono muted">{o.number}</span></span>} onClose={onClose}
      actions={<button className="btn sm" onClick={() => printTraveler(o)}><Icon name="printer" /> Laufkarte</button>}>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        <Pill tone={STATUS[o.status]![1]}>{STATUS[o.status]![0]}</Pill>
        {o.projectNumber && <span className="small">{o.projectNumber} {o.projectName}</span>}
        <span className="small muted">{n3(o.qtyDone)} von {n3(o.qty)} fertig{o.qtyScrap ? ` · ${n3(o.qtyScrap)} Ausschuss` : ''} · Vorgabe {Math.round(plannedMin / 6) / 10} Std. · Ist {Math.round(actualMin / 6) / 10} Std.</span>
        <span className="grow" />
        {o.status === 'planned' && <button className="btn primary" onClick={async () => { if (await save({ status: 'released' }, 'Freigegeben')) void reload(); }}>Freigeben</button>}
        {['planned', 'released', 'in_progress'].includes(o.status) && <button className="btn ghost" onClick={async () => { if (await save({ status: 'cancelled' }, 'Storniert')) void reload(); }}>Stornieren</button>}
        {o.status === 'in_progress' && <button className="btn" onClick={async () => { if (await save({ status: 'done' }, 'Abgeschlossen')) void reload(); }}>Abschließen</button>}
        {['planned', 'cancelled'].includes(o.status) && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      </div>
      <div className="grid3">
        <Field label="Menge"><input type="number" disabled={!editable} value={meta.qty} onChange={(e) => setMeta({ ...meta, qty: e.target.value })} /></Field>
        <Field label="Start"><input type="date" value={meta.startDate} onChange={(e) => setMeta({ ...meta, startDate: e.target.value })} /></Field>
        <Field label="Termin"><input type="date" value={meta.dueDate} onChange={(e) => setMeta({ ...meta, dueDate: e.target.value })} /></Field>
      </div>
      <h3 style={{ margin: '10px 0 4px' }}>Arbeitsplan</h3>
      <table className="table small"><thead><tr><th style={{ width: 30 }}>#</th><th>Arbeitsgang</th><th style={{ width: 150 }}>Arbeitsplatz</th><th style={{ width: 75 }}>Rüsten (Min.)</th><th style={{ width: 75 }}>Min./Stück</th><th style={{ width: 110 }}>Stand</th><th /></tr></thead>
        <tbody>{ops.map((x, i) => (
          <tr key={x.id}>
            <td>{(i + 1) * 10}</td>
            <td><input disabled={!editable} value={x.name} onChange={(e) => setOp(i, { name: e.target.value })} /></td>
            <td><select disabled={!editable} value={x.workcenterId ?? ''} onChange={(e) => setOp(i, { workcenterId: e.target.value || null })}><option value="">–</option>{wcs?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></td>
            <td><input disabled={!editable} type="number" min={0} value={x.setupMin} onChange={(e) => setOp(i, { setupMin: Number(e.target.value) })} /></td>
            <td><input disabled={!editable} type="number" min={0} step="0.1" value={x.minPerUnit} onChange={(e) => setOp(i, { minPerUnit: Number(e.target.value) })} /></td>
            <td><Pill tone={OP_STATUS[x.status ?? 'open']![1]}>{OP_STATUS[x.status ?? 'open']![0]}</Pill>{x.qtyDone > 0 && <div className="small muted">{n3(x.qtyDone)} gut{x.qtyScrap ? `, ${n3(x.qtyScrap)} Ausschuss` : ''}</div>}</td>
            <td>{editable && <button className="btn ghost sm" onClick={() => setOps(ops.filter((_, j) => j !== i))}><Icon name="x" /></button>}</td>
          </tr>
        ))}</tbody></table>
      {editable && <button className="btn sm" onClick={() => setOps([...ops, { id: Math.random().toString(36).slice(2, 10), name: '', workcenterId: null, description: '', setupMin: 0, minPerUnit: 0, status: 'open', qtyDone: 0, qtyScrap: 0, actualMin: 0 }])}><Icon name="plus" /> Arbeitsgang</button>}
      <div className="row" style={{ margin: '14px 0 4px' }}><h3 className="grow" style={{ margin: 0 }}>Stückliste ({o.bom.length})</h3>
        {can('warehouse') && o.bom.some((b: any) => b.articleId && b.issued < b.qty) && !['done', 'cancelled'].includes(o.status) && <button className="btn sm" onClick={() => setIssue(true)}><Icon name="box" /> Material entnehmen</button>}</div>
      {!o.bom.length ? <p className="muted small">Keine Stückliste.</p> : <table className="table small"><thead><tr><th>Nummer</th><th>Benennung</th><th>Beschaffung</th><th style={{ textAlign: 'right' }}>Menge</th><th style={{ textAlign: 'right' }}>entnommen</th></tr></thead>
        <tbody>{o.bom.map((b: any, i: number) => (
          <tr key={i}><td className="mono">{b.number}</td><td>{b.designation}{!b.articleId && b.procurement !== 'make' && <span className="small muted"> · kein Lagerartikel</span>}</td><td>{PROC[b.procurement]}</td>
            <td style={{ textAlign: 'right' }}>{n3(b.qty)} {b.unit}</td><td style={{ textAlign: 'right' }} className={b.articleId && b.issued >= b.qty ? 'text-green' : ''}>{b.articleId ? n3(b.issued) : ''}</td></tr>
        ))}</tbody></table>}
      <Field label="Notizen"><textarea rows={2} value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} /></Field>
      <button className="btn primary" onClick={async () => { if (await save()) void reload(); }}>Speichern</button>
      {o.feedback.length > 0 && <><h3 style={{ margin: '16px 0 4px' }}>Rückmeldungen</h3>
        <table className="table small"><tbody>{o.feedback.map((f: any) => (
          <tr key={f.id}><td>{fmtDateTime(f.at)}</td><td>{(f.op + 1) * 10} {o.operations[f.op]?.name}</td><td>{{ start: 'Start', stop: 'Unterbrochen', done: 'Fertig' }[f.kind as string]}</td>
            <td>{f.minutes ? `${f.minutes} Min.` : ''}</td><td>{f.qtyGood ? `${n3(f.qtyGood)} gut` : ''}{f.qtyScrap ? ` ${n3(f.qtyScrap)} Ausschuss` : ''}</td><td>{f.userName}</td><td className="muted">{f.note}</td></tr>
        ))}</tbody></table></>}
      {issue && <IssueModal order={o} onClose={() => setIssue(false)} onDone={() => { setIssue(false); void reload(); }} />}
      {remove && <Confirm danger text="Fertigungsauftrag löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/manufacturing/orders/${id}`))) onClose(); }} />}
    </SlideOver>
  );
}

function IssueModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [loc, setLoc] = useState<string | null>(null);
  const lines = order.bom.map((b: any, index: number) => ({ ...b, index })).filter((b: any) => b.articleId && b.issued < b.qty);
  const [qty, setQty] = useState<Record<number, number>>(() => Object.fromEntries(lines.map((b: any) => [b.index, Math.round((b.qty - b.issued) * 1000) / 1000])));
  return (
    <Modal title="Material entnehmen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!loc} onClick={async () => {
        const l = lines.filter((b: any) => qty[b.index]! > 0).map((b: any) => ({ index: b.index, qty: qty[b.index]!, locationId: loc! }));
        if (await act(() => post(`/manufacturing/orders/${order.id}/issue`, { lines: l }), 'Entnommen')) onDone();
      }}>Buchen</button></>}>
      <Field label="Aus Lagerort"><LocationSelect value={loc} onChange={setLoc} /></Field>
      <table className="table small"><tbody>{lines.map((b: any) => (
        <tr key={b.index}><td className="mono">{b.number}</td><td>{b.designation}</td><td style={{ width: 110 }}><input type="number" min={0} value={qty[b.index]} onChange={(e) => setQty({ ...qty, [b.index]: Number(e.target.value) })} /></td><td>{b.unit}</td></tr>
      ))}</tbody></table>
      <p className="hint">Die Entnahme wird im Lager auf das Projekt des Auftrags gebucht.</p>
    </Modal>
  );
}

function printTraveler(o: any) {
  const w = window.open('', '_blank', 'width=900,height=900');
  if (!w) return;
  const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const url = `${location.origin}/manufacturing?tab=floor&order=${o.id}`;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Laufkarte ${esc(o.number)}</title><style>
    body { font-family: system-ui, sans-serif; margin: 15mm; font-size: 10pt; } h1 { margin: 0 0 4px; font-size: 18pt; } .q { float: right; width: 32mm; height: 32mm; } .q svg { width: 100%; height: 100%; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; } th, td { border: 0.3mm solid #999; padding: 2mm; text-align: left; vertical-align: top; } th { background: #eee; } td.sig { height: 10mm; }
    @media print { .bar { display: none; } }</style></head><body><div class="bar"><button onclick="print()">Drucken</button></div>
    <div class="q">${qrSvg(url)}</div><h1>Laufkarte ${esc(o.number)}</h1><div><b>${esc(o.title)}</b></div>
    <div>Menge: <b>${o.qty}</b> · Projekt: ${esc(o.projectNumber ?? '–')} · Termin: ${o.dueDate ? new Date(`${o.dueDate}T12:00:00`).toLocaleDateString('de-DE') : '–'}</div>
    <table><tr><th style="width:8mm">AG</th><th>Arbeitsgang</th><th style="width:22mm">Vorgabe</th><th style="width:18mm">Gut</th><th style="width:18mm">Ausschuss</th><th style="width:35mm">Datum / Zeichen</th></tr>
    ${o.operations.map((x: any, i: number) => `<tr><td>${(i + 1) * 10}</td><td>${esc(x.name)}${x.description ? `<br><small>${esc(x.description)}</small>` : ''}</td><td>${Math.round((x.setupMin + x.minPerUnit * o.qty))} Min.</td><td class="sig"></td><td></td><td></td></tr>`).join('')}</table>
    ${o.bom.length ? `<h3>Material</h3><table><tr><th>Nummer</th><th>Benennung</th><th style="width:25mm">Menge</th><th style="width:20mm">entnommen</th></tr>${o.bom.map((b: any) => `<tr><td>${esc(b.number)}</td><td>${esc(b.designation)}</td><td>${b.qty} ${esc(b.unit)}</td><td></td></tr>`).join('')}</table>` : ''}
    </body></html>`);
  w.document.close();
}

function Floor({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: wcs } = useApi<any[]>('/manufacturing/workcenters');
  const [wc, setWc] = useState<string>(() => { try { return localStorage.getItem('aperio-mfg-wc') ?? ''; } catch { return ''; } });
  const { data, reload } = useApi<any[]>(`/manufacturing/queue${wc ? `?workcenterId=${wc}` : ''}`, [wc]);
  const act = useAction();
  const toast = useToast();
  const [done, setDone] = useState<any | null>(null);
  useLive(reload);
  const send = async (x: any, kind: string, extra: Record<string, unknown> = {}) => {
    const r = await act(() => post<any>(`/manufacturing/orders/${x.orderId}/feedback`, { op: x.op, kind, ...extra }));
    if (r) { if (r.minutes) toast(`${r.minutes} Minuten erfasst`); void reload(); }
  };
  return (
    <div>
      <div className="toolbar">
        <select value={wc} onChange={(e) => { setWc(e.target.value); try { localStorage.setItem('aperio-mfg-wc', e.target.value); } catch { /* egal */ } }} style={{ width: 'auto' }}>
          <option value="">alle Arbeitsplätze</option>{wcs?.filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        <span className="small muted">Nur freigegebene Aufträge, deren vorheriger Arbeitsgang erledigt ist.</span>
      </div>
      {data && !data.length && <Empty icon="check-circle" title="Nichts zu tun">Hier erscheinen die nächsten Arbeitsgänge, sobald Aufträge freigegeben sind.</Empty>}
      <div className="mfg-floor">{data?.map((x) => (
        <div key={`${x.orderId}-${x.op}`} className={`card mfg-card ${x.operation.status}`}>
          <div className="row"><b className="grow">{x.operation.name}</b><span className="mono small">{x.number} · AG {(x.op + 1) * 10}</span></div>
          <div className="click" onClick={() => onOpen(x.orderId)}>{x.title}</div>
          <div className="small muted">{x.projectNumber ? `${x.projectNumber} · ` : ''}Menge {x.qty}{x.operation.qtyDone ? ` · ${x.operation.qtyDone} fertig` : ''}{x.dueDate ? ` · Termin ${fmtDate(x.dueDate)}` : ''}</div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {x.operation.status !== 'running' ? <button className="btn primary big" onClick={() => void send(x, 'start')}><Icon name="play" /> Start</button>
              : <><button className="btn big" onClick={() => void send(x, 'stop')}>Pause</button><button className="btn primary big" onClick={() => setDone(x)}><Icon name="check" /> Fertig</button></>}
          </div>
        </div>
      ))}</div>
      {done && <DoneModal x={done} onClose={() => setDone(null)} onSubmit={async (v) => { setDone(null); await send(done, 'done', v); }} />}
    </div>
  );
}

function DoneModal({ x, onClose, onSubmit }: { x: any; onClose: () => void; onSubmit: (v: { qtyGood: number; qtyScrap: number; note: string }) => void }) {
  const [v, setV] = useState({ qtyGood: Math.max(0, x.qty - (x.operation.qtyDone ?? 0)), qtyScrap: 0, note: '' });
  return (
    <Modal title={`${x.operation.name} fertig melden`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" onClick={() => onSubmit(v)}>Melden</button></>}>
      <div className="grid2">
        <Field label="Gutmenge"><input type="number" min={0} value={v.qtyGood} onChange={(e) => setV({ ...v, qtyGood: Number(e.target.value) })} /></Field>
        <Field label="Ausschuss"><input type="number" min={0} value={v.qtyScrap} onChange={(e) => setV({ ...v, qtyScrap: Number(e.target.value) })} /></Field>
      </div>
      <Field label="Bemerkung"><input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
    </Modal>
  );
}

function Load({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useApi<any[]>('/manufacturing/load');
  useLive(reload);
  if (!data) return null;
  if (!data.length) return <Empty icon="gantt" title="Keine Arbeitsplätze">Arbeitsplätze unter „Arbeitsplätze“ anlegen und den Arbeitsgängen zuordnen.</Empty>;
  const max = Math.max(1, ...data.map((w) => w.days ?? 0));
  return (
    <div className="mfg-load">{data.map((w) => (
      <div key={w.id} className="card">
        <div className="row"><b className="grow">{w.name}</b><span>{w.hours} Std.{w.days !== null ? ` · ${w.days} Tage` : ''}</span></div>
        <div className="mfg-progress" style={{ margin: '6px 0' }}><span style={{ width: `${((w.days ?? 0) / max) * 100}%`, background: (w.days ?? 0) > 10 ? 'var(--red)' : undefined }} /></div>
        {w.ops.map((x: any) => <div key={`${x.orderId}-${x.op}`} className="row small click" onClick={() => onOpen(x.orderId)}><span className="mono">{x.number}</span><span className="grow">{x.name} – {x.title}</span><span>{x.hours} Std.</span><span className="muted">{fmtDate(x.dueDate)}</span></div>)}
      </div>
    ))}</div>
  );
}

function Workcenters() {
  const { data, reload } = useApi<any[]>('/manufacturing/workcenters');
  const act = useAction();
  const [f, setF] = useState({ name: '', hourlyRate: 0, hoursPerDay: 8 });
  return (
    <div style={{ maxWidth: 760 }}>
      <table className="table"><thead><tr><th>Arbeitsplatz</th><th style={{ width: 140 }}>Stundensatz (€)</th><th style={{ width: 140 }}>Std. pro Tag</th><th style={{ width: 80 }}>aktiv</th></tr></thead>
        <tbody>{data?.map((w) => (
          <tr key={w.id}>
            <td><input defaultValue={w.name} onBlur={async (e) => { if (e.target.value !== w.name && await act(() => patch(`/manufacturing/workcenters/${w.id}`, { name: e.target.value }))) void reload(); }} /></td>
            <td><input type="number" defaultValue={w.hourlyRate} onBlur={async (e) => { if (await act(() => patch(`/manufacturing/workcenters/${w.id}`, { hourlyRate: Number(e.target.value) }))) void reload(); }} /></td>
            <td><input type="number" defaultValue={w.hoursPerDay} onBlur={async (e) => { if (await act(() => patch(`/manufacturing/workcenters/${w.id}`, { hoursPerDay: Number(e.target.value) }))) void reload(); }} /></td>
            <td><input type="checkbox" checked={w.active} onChange={async (e) => { if (await act(() => patch(`/manufacturing/workcenters/${w.id}`, { active: e.target.checked }))) void reload(); }} /></td>
          </tr>
        ))}
          <tr><td><input placeholder="Neuer Arbeitsplatz, z. B. Fräsen DMU 50" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></td>
            <td><input type="number" value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: Number(e.target.value) })} /></td>
            <td><input type="number" value={f.hoursPerDay} onChange={(e) => setF({ ...f, hoursPerDay: Number(e.target.value) })} /></td>
            <td><button className="btn sm primary" disabled={!f.name.trim()} onClick={async () => { if (await act(() => post('/manufacturing/workcenters', f), 'Angelegt')) { setF({ name: '', hourlyRate: 0, hoursPerDay: 8 }); void reload(); } }}><Icon name="plus" /></button></td></tr>
        </tbody></table>
      <p className="hint">Stundensätze dienen der Nachkalkulation; die Plantafel rechnet mit den Stunden pro Tag.</p>
    </div>
  );
}
