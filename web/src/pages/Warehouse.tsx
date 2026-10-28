import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LOCATION_KIND, MOVE_KIND } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, patch, post, put, upload } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtDateTime, fmtEuro2 } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { LabelButton, ScanButton, type Label } from '../modules/Scan';

const qty = (n: number | null | undefined, unit = '') => `${(n ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;
type Loc = { id: string; parentId: string | null; name: string; code: string; kind: string; active: boolean; articles: number };

/** Lagerorte mit eingerücktem Pfad für Auswahllisten */
function useLocations() {
  const { data, reload } = useApi<Loc[]>('/warehouse/locations');
  const options = useMemo(() => {
    const out: { id: string; label: string; loc: Loc }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const l of (data ?? []).filter((x) => x.parentId === parent)) { out.push({ id: l.id, label: `${'  '.repeat(depth)}${l.name}`, loc: l }); walk(l.id, depth + 1); }
    };
    walk(null, 0);
    return out;
  }, [data]);
  return { locations: data, options, reload };
}
function LocSelect({ value, onChange, options, placeholder = '– Lagerort –', onlyActive = true }: { value: string; onChange: (v: string) => void; options: { id: string; label: string; loc: Loc }[]; placeholder?: string; onlyActive?: boolean }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">{placeholder}</option>
    {options.filter((o) => !onlyActive || o.loc.active).map((o) => <option key={o.id} value={o.id}>{o.label.replace(/^ +/, (s) => '  '.repeat(s.length / 2))}</option>)}</select>;
}

export default function WarehousePage() {
  useCrumbs([{ label: 'Lager' }]);
  const { kind, id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useTabState<'stock' | 'incoming' | 'moves' | 'reorder' | 'counts' | 'locations'>('warehouse', 'stock');
  const [article, setArticle] = useState<string | null>(kind === 'article' ? id ?? null : null);
  const [locFilter, setLocFilter] = useState(kind === 'location' ? id ?? '' : '');
  const locs = useLocations();
  useEffect(() => { if (kind === 'article' && id) setArticle(id); if (kind === 'location' && id) { setLocFilter(id); setTab('stock'); } }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'warehouse.changed') void locs.reload(); }), [locs.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScan = async (code: string) => {
    try {
      const r = await get<{ type: string; id: string }>(`/warehouse/lookup?code=${encodeURIComponent(code)}`);
      if (r.type === 'article') setArticle(r.id); else { setLocFilter(r.id); setTab('stock'); }
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>Lager</h1><div className="sub">Bestände, Lagerorte und Warenbewegungen</div></div>
        <div className="actions">
          <ScanButton onCode={onScan} title="Artikel oder Lagerort scannen" />
          <a className="btn" href="/api/warehouse/export.xlsx"><Icon name="download" /> Bestandsliste</a>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stock', label: 'Bestand' }, { id: 'incoming', label: 'Wareneingang' }, { id: 'moves', label: 'Bewegungen' },
        { id: 'reorder', label: 'Bestellvorschlag' }, { id: 'counts', label: 'Inventur' }, { id: 'locations', label: 'Lagerorte' }]} />
      {tab === 'stock' && <Stock onOpen={setArticle} locFilter={locFilter} setLocFilter={setLocFilter} locs={locs} />}
      {tab === 'incoming' && <Incoming locs={locs} onOpen={setArticle} />}
      {tab === 'moves' && <Moves onOpen={setArticle} />}
      {tab === 'reorder' && <Reorder onOpen={setArticle} />}
      {tab === 'counts' && <Counts locs={locs} />}
      {tab === 'locations' && <Locations locs={locs} onFilter={(lid) => { setLocFilter(lid); setTab('stock'); }} />}
      {article && <ArticlePanel id={article} locs={locs} onClose={() => { setArticle(null); if (kind) nav('/warehouse', { replace: true }); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Bestand
function Stock({ onOpen, locFilter, setLocFilter, locs }: { onOpen: (id: string) => void; locFilter: string; setLocFilter: (v: string) => void; locs: ReturnType<typeof useLocations> }) {
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const [create, setCreate] = useState(false);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(low ? { low: '1' } : {}), ...(locFilter ? { locationId: locFilter } : {}) });
  const { data, reload } = useApi<any[]>(`/warehouse/articles?${qs}`);
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'warehouse.changed') void reload(); }), [reload]);
  const total = data?.reduce((s, a) => s + (a.value ?? 0), 0) ?? 0;
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Nummer, Bezeichnung, Barcode …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
        <div style={{ width: 200 }}><LocSelect value={locFilter} onChange={setLocFilter} options={locs.options} placeholder="alle Lagerorte" onlyActive={false} /></div>
        <label className="row small"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> unter Mindestbestand</label>
        <span className="small muted">{data?.length ?? 0} Artikel · Lagerwert {fmtEuro2(total)}</span>
        <button className="btn primary right" onClick={() => setCreate(true)}><Icon name="plus" /> Artikel</button>
      </div>
      {data && !data.length && <Empty icon="box" title={q || low || locFilter ? 'Nichts gefunden' : 'Noch keine Artikel'}>{!q && !low && !locFilter ? 'Legen Sie zuerst Lagerorte an (Reiter „Lagerorte“), dann Artikel. Ware aus dem Einkauf lässt sich im Reiter „Wareneingang“ direkt einbuchen – der Artikel wird dabei angelegt.' : null}</Empty>}
      {data && data.length > 0 && (
        <table className="table"><thead><tr><th>Nr.</th><th>Bezeichnung</th><th>Kategorie</th><th style={{ textAlign: 'right' }}>Bestand</th><th style={{ textAlign: 'right' }}>bestellt</th><th style={{ textAlign: 'right' }}>Mindestbestand</th><th style={{ textAlign: 'right' }}>Wert</th></tr></thead>
          <tbody>{data.map((a) => {
            const lowStock = a.minQty > 0 && a.stock < a.minQty;
            return (
              <tr key={a.id} className="click" onClick={() => onOpen(a.id)}>
                <td className="mono">{a.number}</td><td><b>{a.name}</b>{a.manufacturerNo && <span className="small muted"> · {a.manufacturer} {a.manufacturerNo}</span>}</td>
                <td className="small">{a.category}</td>
                <td style={{ textAlign: 'right' }}>{lowStock ? <Pill tone="red">{qty(a.stock, a.unit)}</Pill> : qty(a.stock, a.unit)}</td>
                <td style={{ textAlign: 'right' }} className="small muted">{a.onOrder ? qty(a.onOrder) : ''}</td>
                <td style={{ textAlign: 'right' }} className="small muted">{a.minQty ? qty(a.minQty) : ''}</td>
                <td style={{ textAlign: 'right' }}>{a.purchasePrice !== null ? fmtEuro2(a.value) : '–'}</td>
              </tr>
            );
          })}</tbody></table>
      )}
      {create && <ArticleEditor locs={locs} onClose={() => setCreate(false)} onSaved={(id) => { setCreate(false); reload(); onOpen(id); }} />}
    </div>
  );
}

function ArticleEditor({ article, locs, onClose, onSaved }: { article?: any; locs: ReturnType<typeof useLocations>; onClose: () => void; onSaved: (id: string) => void }) {
  const act = useAction();
  const { data: suppliers } = useApi<any[]>('/crm/accounts?kind=supplier');
  const [f, setF] = useState({ number: article?.number ?? '', name: article?.name ?? '', description: article?.description ?? '', category: article?.category ?? '', unit: article?.unit ?? 'Stk',
    manufacturer: article?.manufacturer ?? '', manufacturerNo: article?.manufacturerNo ?? '', supplierId: article?.supplierId ?? '', supplierNo: article?.supplierNo ?? '',
    purchasePrice: article?.purchasePrice ?? '', barcode: article?.barcode ?? '', minQty: article?.minQty ?? 0, reorderQty: article?.reorderQty ?? 0, tracking: article?.tracking ?? 'none',
    defaultLocationId: article?.defaultLocationId ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal size="lg" title={article ? `Artikel ${article.number} bearbeiten` : 'Neuer Artikel'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.name.trim()} onClick={async () => {
        const body = { ...f, supplierId: f.supplierId || null, defaultLocationId: f.defaultLocationId || null, barcode: f.barcode || null,
          purchasePrice: f.purchasePrice === '' ? null : Number(f.purchasePrice), minQty: Number(f.minQty) || 0, reorderQty: Number(f.reorderQty) || 0 };
        const r = await act(() => (article ? patch(`/warehouse/articles/${article.id}`, body).then(() => ({ id: article.id })) : post<{ id: string }>('/warehouse/articles', body)), 'Gespeichert');
        if (r) onSaved(r.id);
      }}>Speichern</button></>}>
      <div className="grid3">
        <Field label="Artikelnummer" hint={article ? undefined : 'leer = automatisch'}><input className="mono" value={f.number} onChange={set('number')} /></Field>
        <Field label="Bezeichnung" required><input autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Kategorie"><input value={f.category} onChange={set('category')} placeholder="z. B. Normteile" /></Field>
        <Field label="Einheit"><input value={f.unit} onChange={set('unit')} /></Field>
        <Field label="Einkaufspreis (€ je Einheit)"><input type="number" step="0.0001" min={0} value={f.purchasePrice} onChange={set('purchasePrice')} /></Field>
        <Field label="Barcode (EAN)" hint="leer = QR-Etikett nutzen"><input className="mono" value={f.barcode} onChange={set('barcode')} /></Field>
        <Field label="Hersteller"><input value={f.manufacturer} onChange={set('manufacturer')} /></Field>
        <Field label="Hersteller-Teilenummer"><input value={f.manufacturerNo} onChange={set('manufacturerNo')} /></Field>
        <Field label="Lieferant"><select value={f.supplierId} onChange={set('supplierId')}><option value="">–</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Bestellnummer beim Lieferanten"><input value={f.supplierNo} onChange={set('supplierNo')} /></Field>
        <Field label="Mindestbestand" hint="darunter: Bestellvorschlag"><input type="number" min={0} value={f.minQty} onChange={set('minQty')} /></Field>
        <Field label="Bestellmenge"><input type="number" min={0} value={f.reorderQty} onChange={set('reorderQty')} /></Field>
        <Field label="Standard-Lagerort"><LocSelect value={f.defaultLocationId} onChange={(v) => setF({ ...f, defaultLocationId: v })} options={locs.options} placeholder="–" /></Field>
        <Field label="Verfolgung"><select value={f.tracking} onChange={set('tracking')}><option value="none">keine</option><option value="lot">Charge (z. B. Klebstoff, Lack)</option><option value="serial">Seriennummer (jedes Stück einzeln)</option></select></Field>
      </div>
      <Field label="Beschreibung"><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
    </Modal>
  );
}

function ArticlePanel({ id, locs, onClose }: { id: string; locs: ReturnType<typeof useLocations>; onClose: () => void }) {
  const { data: a, reload } = useApi<any>(`/warehouse/articles/${id}`);
  const act = useAction();
  const [move, setMove] = useState<null | 'receipt' | 'issue' | 'transfer'>(null);
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'warehouse.changed') void reload(); }), [reload]);
  if (!a) return null;
  const labels = (): Label[] => [{ title: a.name, subtitle: a.manufacturerNo || a.category, code: a.number, qr: `${location.origin}/warehouse/article/${a.id}` }];
  return (
    <SlideOver wide title={<span><span className="mono muted">{a.number}</span> <b>{a.name}</b></span>} onClose={onClose} actions={<>
      <LabelButton labels={labels} label="Etikett" />
      <button className="btn sm" onClick={() => setEdit(true)}><Icon name="edit" /> Bearbeiten</button>
      <button className="btn sm ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button></>}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
        <button className="btn primary" onClick={() => setMove('receipt')}><Icon name="arrow-down" /> Zugang</button>
        <button className="btn" onClick={() => setMove('issue')} disabled={!a.stock}><Icon name="arrow-up" /> Entnahme</button>
        <button className="btn" onClick={() => setMove('transfer')} disabled={!a.stock}><Icon name="arrow-right" /> Umlagern</button>
      </div>
      <div className="wh-facts">
        <div><span className="muted small">Bestand</span><b className={a.minQty > 0 && a.stock < a.minQty ? 'text-red' : ''}>{qty(a.stock, a.unit)}</b></div>
        <div><span className="muted small">bestellt</span><b>{qty(a.onOrder, a.unit)}</b></div>
        <div><span className="muted small">Mindestbestand</span><b>{qty(a.minQty, a.unit)}</b></div>
        <div><span className="muted small">Wert</span><b>{a.purchasePrice !== null ? fmtEuro2(a.value) : '–'}</b></div>
      </div>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start', marginTop: 12 }}>
        <div className="wh-img" onClick={() => document.getElementById('wh-img-up')?.click()} title="Bild ändern">
          {a.hasImage ? <img src={`/api/warehouse/articles/${id}/image?v=${encodeURIComponent(a.updatedAt)}`} alt="" /> : <Icon name="image" size={28} />}
          <input id="wh-img-up" type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f, f.name); if (await act(() => upload(`/warehouse/articles/${id}/image`, fd))) reload(); }} />
        </div>
        <table className="table small grow"><tbody>
          {a.description && <tr><td className="muted">Beschreibung</td><td>{a.description}</td></tr>}
          <tr><td className="muted" style={{ width: 170 }}>Hersteller</td><td>{[a.manufacturer, a.manufacturerNo].filter(Boolean).join(' · ') || '–'}</td></tr>
          <tr><td className="muted">Lieferant</td><td>{a.supplierName ? `${a.supplierName}${a.supplierNo ? ` · ${a.supplierNo}` : ''}` : '–'}</td></tr>
          <tr><td className="muted">Einkaufspreis</td><td>{a.purchasePrice !== null ? `${fmtEuro2(a.purchasePrice)} je ${a.unit}` : '–'}</td></tr>
          <tr><td className="muted">Barcode</td><td className="mono">{a.barcode || '–'}</td></tr>
          <tr><td className="muted">Verfolgung</td><td>{{ none: 'keine', lot: 'Chargen', serial: 'Seriennummern' }[a.tracking as string]}</td></tr>
        </tbody></table>
      </div>
      <h3 style={{ margin: '18px 0 6px' }}>Bestand je Lagerort</h3>
      {!a.stockByLocation.length ? <p className="muted small">Kein Bestand.</p> : <table className="table small"><tbody>{a.stockByLocation.map((s: any) => (
        <tr key={s.locationId + s.lot}><td>{s.locationName} <span className="muted mono">{s.locationCode}</span></td><td>{s.lot && <span className="mono">{a.tracking === 'serial' ? 'SN ' : 'Ch. '}{s.lot}</span>}</td><td style={{ textAlign: 'right' }}><b>{qty(s.qty, a.unit)}</b></td></tr>
      ))}</tbody></table>}
      {a.purchases.length > 0 && <>
        <h3 style={{ margin: '18px 0 6px' }}>Offene Bestellungen</h3>
        <table className="table small"><tbody>{a.purchases.map((p: any) => <tr key={p.id}><td>Projekt {p.projectNumber}</td><td>{qty(p.open, a.unit)}</td><td className="muted">{p.plannedDelivery ? `erwartet ${fmtDate(p.plannedDelivery)}` : ''}</td></tr>)}</tbody></table>
      </>}
      <h3 style={{ margin: '18px 0 6px' }}>Bewegungen</h3>
      <MoveTable rows={a.moves} unit={a.unit} />
      {move && <MoveModal kind={move} article={a} locs={locs} onClose={() => setMove(null)} onDone={() => { setMove(null); reload(); }} />}
      {edit && <ArticleEditor article={a} locs={locs} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
      {remove && <Confirm danger text={`Artikel ${a.number} „${a.name}“ löschen? Mit Bewegungen wird er nur stillgelegt.`} onClose={() => setRemove(false)}
        onConfirm={async () => { if (await act(() => del(`/warehouse/articles/${id}`), 'Erledigt')) onClose(); }} />}
    </SlideOver>
  );
}

function MoveTable({ rows, unit, showArticle, onOpen }: { rows: any[]; unit?: string; showArticle?: boolean; onOpen?: (id: string) => void }) {
  if (!rows.length) return <p className="muted small">Noch keine Bewegungen.</p>;
  return (
    <table className="table small"><tbody>{rows.map((m) => (
      <tr key={m.id} className={onOpen ? 'click' : ''} onClick={() => onOpen?.(m.articleId)}>
        <td style={{ width: 130 }}>{fmtDateTime(m.createdAt)}</td>
        <td><Pill tone={m.kind === 'receipt' || m.kind === 'return' ? 'green' : m.kind === 'issue' ? 'amber' : 'blue'}>{MOVE_KIND[m.kind]}</Pill></td>
        {showArticle && <td><span className="mono">{m.articleNumber}</span> {m.articleName}</td>}
        <td style={{ textAlign: 'right' }}><b>{m.kind === 'issue' || (m.kind === 'adjust' && m.fromName && !m.toName) ? '−' : m.kind === 'transfer' ? '' : '+'}{qty(m.qty, unit ?? m.unit)}</b></td>
        <td>{m.fromName && m.toName ? `${m.fromName} → ${m.toName}` : m.fromName ?? m.toName}{m.lot && <span className="mono muted"> · {m.lot}</span>}</td>
        <td className="muted">{m.projectNumber ? `Projekt ${m.projectNumber}` : ''}{m.note ? ` ${m.note}` : ''}</td>
        <td className="muted">{m.userName}</td>
      </tr>
    ))}</tbody></table>
  );
}

function MoveModal({ kind, article: a, locs, onClose, onDone }: { kind: 'receipt' | 'issue' | 'transfer'; article: any; locs: ReturnType<typeof useLocations>; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const { data: projects } = useApi<any[]>('/projects');
  const stockRows: any[] = a.stockByLocation;
  const [from, setFrom] = useState<string>(stockRows.length === 1 ? `${stockRows[0].locationId}|${stockRows[0].lot}` : '');
  const [to, setTo] = useState<string>(a.defaultLocationId ?? '');
  const [n, setN] = useState<string>(a.tracking === 'serial' ? '1' : '');
  const [lot, setLot] = useState('');
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  const [fromLoc, fromLot] = from.split('|');
  const avail = stockRows.find((s) => s.locationId === fromLoc && s.lot === (fromLot ?? ''))?.qty ?? 0;
  const ok = Number(n) > 0 && (kind === 'receipt' ? to && (a.tracking === 'none' || lot.trim()) : from && Number(n) <= avail + 1e-9 && (kind !== 'transfer' || to) && (kind !== 'issue' || projectId || note.trim()));
  return (
    <Modal title={`${{ receipt: 'Zugang', issue: 'Entnahme', transfer: 'Umlagern' }[kind]}: ${a.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!ok} onClick={async () => {
        const body = { kind, articleId: a.id, qty: Number(n), lot: kind === 'receipt' ? lot : fromLot ?? '', fromLocationId: kind === 'receipt' ? null : fromLoc, toLocationId: kind === 'issue' ? null : to,
          projectId: kind === 'issue' ? projectId || null : null, note };
        if (await act(() => post('/warehouse/moves', body), 'Gebucht')) onDone();
      }}>Buchen</button></>}>
      {kind !== 'receipt' && <Field label="Aus">
        <select value={from} onChange={(e) => setFrom(e.target.value)}><option value="">– Lagerort –</option>
          {stockRows.map((s) => <option key={s.locationId + s.lot} value={`${s.locationId}|${s.lot}`}>{s.locationName}{s.lot ? ` · ${s.lot}` : ''} ({qty(s.qty, a.unit)})</option>)}</select></Field>}
      {kind !== 'issue' && <Field label={kind === 'receipt' ? 'In Lagerort' : 'Nach'}><LocSelect value={to} onChange={setTo} options={locs.options} /></Field>}
      <div className="grid2">
        <Field label={`Menge (${a.unit})`}><input type="number" min={0} step="any" value={n} onChange={(e) => setN(e.target.value)} readOnly={a.tracking === 'serial'} autoFocus /></Field>
        {kind === 'receipt' && a.tracking !== 'none' && <Field label={a.tracking === 'serial' ? 'Seriennummer' : 'Charge'} required><input className="mono" value={lot} onChange={(e) => setLot(e.target.value)} /></Field>}
      </div>
      {kind !== 'receipt' && from && <p className="small muted" style={{ marginTop: -6 }}>Verfügbar: {qty(avail, a.unit)}</p>}
      {kind === 'issue' && <Field label="Für Projekt" hint="Der Materialwert wird dem Projekt zugeordnet."><select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">– ohne Projekt (Grund angeben) –</option>
        {projects?.filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>}
      <Field label={kind === 'issue' && !projectId ? 'Grund' : 'Bemerkung'}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'issue' && !projectId ? 'z. B. Verschleiß, Ausschuss, Muster' : ''} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- Wareneingang
function Incoming({ locs, onOpen }: { locs: ReturnType<typeof useLocations>; onOpen: (id: string) => void }) {
  const { data, reload } = useApi<any[]>('/warehouse/incoming');
  const [recv, setRecv] = useState<any | null>(null);
  return (
    <div>
      <p className="muted small">Bestellte Positionen aus dem Einkauf. Beim Einbuchen wird die Lieferung im Einkauf vermerkt und – je nach Wahl – ins Lager gelegt oder gleich dem Projekt zugeordnet.</p>
      {data && !data.length && <Empty icon="truck" title="Keine offenen Lieferungen">Sobald im Einkauf etwas bestellt ist, erscheint es hier.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Erwartet</th><th>Position</th><th>Projekt</th><th>Lieferant</th><th style={{ textAlign: 'right' }}>offen</th><th /></tr></thead>
        <tbody>{data.map((i) => (
          <tr key={i.id}>
            <td className={i.expected && i.expected < new Date().toISOString().slice(0, 10) ? 'text-red' : ''}>{i.expected ? fmtDate(i.expected) : '–'}</td>
            <td><b>{i.designation}</b>{i.manufacturerNo && <span className="small muted"> · {i.manufacturerNo}</span>}{i.articleId && <button className="link small" onClick={() => onOpen(i.articleId)}> · Lagerartikel</button>}</td>
            <td className="small">{i.projectNumber}</td><td className="small">{i.supplierName}{i.orderNumber && <span className="muted"> · {i.orderNumber}</span>}</td>
            <td style={{ textAlign: 'right' }}>{qty(i.open, i.unit)}</td>
            <td><button className="btn sm primary" onClick={() => setRecv(i)}>Einbuchen</button></td>
          </tr>
        ))}</tbody></table>}
      {recv && <ReceiveModal item={recv} locs={locs} onClose={() => setRecv(null)} onDone={() => { setRecv(null); reload(); }} />}
    </div>
  );
}

function ReceiveModal({ item, locs, onClose, onDone }: { item: any; locs: ReturnType<typeof useLocations>; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const { data: art } = useApi<any>(item.articleId ? `/warehouse/articles/${item.articleId}` : null);
  const [n, setN] = useState(String(item.open));
  const [loc, setLoc] = useState('');
  const [lot, setLot] = useState('');
  const [toProject, setToProject] = useState(false);
  useEffect(() => { if (art?.defaultLocationId && !loc) setLoc(art.defaultLocationId); }, [art]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsLot = art && art.tracking !== 'none';
  return (
    <Modal title={`Wareneingang: ${item.designation}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!loc || !(Number(n) > 0) || (needsLot && !lot.trim())} onClick={async () => {
        if (await act(() => post('/warehouse/receive', { purchaseItemId: item.id, qty: Number(n), locationId: loc, lot, articleId: item.articleId, createArticle: !item.articleId, toProject }), 'Eingebucht')) onDone();
      }}>Einbuchen</button></>}>
      <p className="small muted" style={{ marginTop: 0 }}>Projekt {item.projectNumber} · {item.supplierName ?? 'ohne Lieferant'} · offen {qty(item.open, item.unit)}</p>
      {item.articleId ? <p className="small">Lagerartikel: <b>{art?.number} {art?.name}</b></p> : <p className="small">Für diese Position gibt es noch keinen Lagerartikel – er wird beim Einbuchen angelegt.</p>}
      <div className="grid2">
        <Field label={`Menge (${item.unit})`}><input type="number" min={0} step="any" value={n} onChange={(e) => setN(e.target.value)} /></Field>
        <Field label="Lagerort"><LocSelect value={loc} onChange={setLoc} options={locs.options} /></Field>
        {needsLot && <Field label={art.tracking === 'serial' ? 'Seriennummer' : 'Charge'} required><input className="mono" value={lot} onChange={(e) => setLot(e.target.value)} /></Field>}
      </div>
      <label className="row"><input type="checkbox" checked={toProject} onChange={(e) => setToProject(e.target.checked)} /> Direkt ins Projekt geben (nicht auf Lager legen)</label>
    </Modal>
  );
}

// ---------------------------------------------------------------- Bewegungen
function Moves({ onOpen }: { onOpen: (id: string) => void }) {
  const [kind, setKind] = useState('');
  const { data } = useApi<any[]>(`/warehouse/moves${kind ? `?kind=${kind}` : ''}`);
  return (
    <div>
      <div className="toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}><option value="">alle Bewegungen</option>{Object.entries(MOVE_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      {data && <MoveTable rows={data} showArticle onOpen={onOpen} />}
    </div>
  );
}

// ---------------------------------------------------------------- Bestellvorschlag
function Reorder({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useApi<any[]>('/warehouse/reorder');
  const { data: projects } = useApi<any[]>('/projects');
  const [sel, setSel] = useState<Record<string, number>>({});
  const [projectId, setProjectId] = useState('');
  const act = useAction();
  useEffect(() => { if (data) setSel(Object.fromEntries(data.map((a) => [a.id, a.suggest]))); }, [data]);
  const chosen = Object.entries(sel).filter(([, q]) => q > 0);
  return (
    <div>
      <p className="muted small">Artikel, deren Bestand plus bereits bestellte Menge unter dem Mindestbestand liegt. Ausgewählte Mengen werden als Einkaufspositionen in einem Projekt angelegt (z. B. einem Projekt „Lager“ für Gemeinkosten) und dort wie gewohnt bestellt.</p>
      {data && !data.length && <Empty icon="check-circle" title="Alles ausreichend vorrätig" />}
      {data && data.length > 0 && <>
        <table className="table"><thead><tr><th /><th>Artikel</th><th>Lieferant</th><th style={{ textAlign: 'right' }}>Bestand</th><th style={{ textAlign: 'right' }}>bestellt</th><th style={{ textAlign: 'right' }}>Mindestbestand</th><th style={{ width: 120 }}>Bestellen</th></tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id}>
              <td><input type="checkbox" checked={(sel[a.id] ?? 0) > 0} onChange={(e) => setSel({ ...sel, [a.id]: e.target.checked ? a.suggest : 0 })} /></td>
              <td className="click" onClick={() => onOpen(a.id)}><span className="mono">{a.number}</span> <b>{a.name}</b></td>
              <td className="small">{a.supplierName ?? '–'}</td>
              <td style={{ textAlign: 'right' }}>{qty(a.stock, a.unit)}</td><td style={{ textAlign: 'right' }}>{qty(a.onOrder)}</td><td style={{ textAlign: 'right' }}>{qty(a.minQty)}</td>
              <td><input type="number" min={0} value={sel[a.id] ?? 0} onChange={(e) => setSel({ ...sel, [a.id]: Number(e.target.value) })} /></td>
            </tr>
          ))}</tbody></table>
        <div className="row" style={{ marginTop: 10 }}>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 320 }}><option value="">– Projekt für die Bestellung –</option>
            {projects?.filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select>
          <button className="btn primary" disabled={!projectId || !chosen.length} onClick={async () => {
            const r = await act(() => post<{ created: number }>('/warehouse/reorder', { projectId, items: chosen.map(([articleId, q]) => ({ articleId, qty: q })) }));
            if (r) { reload(); window.dispatchEvent(new CustomEvent('aperio:warning', { detail: `${r.created} Position(en) im Einkauf angelegt – dort bestellen.` })); }
          }}>{chosen.length} Position(en) in den Einkauf</button>
        </div>
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- Inventur
function Counts({ locs }: { locs: ReturnType<typeof useLocations> }) {
  const { data, reload } = useApi<any[]>('/warehouse/counts');
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState<{ name: string; locationId: string } | null>(null);
  const act = useAction();
  if (open) return <CountView id={open} locs={locs} onBack={() => { setOpen(null); reload(); }} />;
  return (
    <div>
      <div className="toolbar"><span className="muted small">Bei der Inventur wird der Bestand gezählt. Nach dem Abschließen werden Abweichungen als Korrektur gebucht.</span>
        <button className="btn primary right" onClick={() => setCreate({ name: `Inventur ${new Date().toLocaleDateString('de-DE')}`, locationId: '' })}><Icon name="plus" /> Inventur starten</button></div>
      {data && !data.length && <Empty icon="list" title="Noch keine Inventur" />}
      <table className="table"><tbody>{data?.map((c) => (
        <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
          <td><b>{c.name}</b></td><td className="small">{c.locationName ?? 'ganzes Lager'}</td>
          <td>{c.status === 'open' ? <Pill tone="amber">läuft – {c.counted} von {c.lines} gezählt</Pill> : c.status === 'done' ? <Pill tone="green">abgeschlossen</Pill> : <Pill>abgebrochen</Pill>}</td>
          <td className="small muted">{c.createdByName} · {fmtDateTime(c.createdAt)}</td>
        </tr>
      ))}</tbody></table>
      {create && <Modal title="Inventur starten" onClose={() => setCreate(null)} footer={<><button className="btn" onClick={() => setCreate(null)}>Abbrechen</button>
        <button className="btn primary" onClick={async () => { const r = await act(() => post<{ id: string }>('/warehouse/counts', { name: create.name, locationId: create.locationId || null })); if (r) { setCreate(null); setOpen(r.id); } }}>Starten</button></>}>
        <Field label="Bezeichnung"><input value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></Field>
        <Field label="Bereich" hint="leer = ganzes Lager"><LocSelect value={create.locationId} onChange={(v) => setCreate({ ...create, locationId: v })} options={locs.options} placeholder="ganzes Lager" /></Field>
      </Modal>}
    </div>
  );
}

function CountView({ id, locs, onBack }: { id: string; locs: ReturnType<typeof useLocations>; onBack: () => void }) {
  const { data: c, reload } = useApi<any>(`/warehouse/counts/${id}`);
  const act = useAction();
  const toast = useToast();
  const [loc, setLoc] = useState('');
  const [q, setQ] = useState('');
  const [finish, setFinish] = useState(false);
  const [extra, setExtra] = useState<{ articleId: string; name: string } | null>(null);
  useEffect(() => realtime.subscribe('global', (e, d: any) => { if (e === 'warehouse.count' && d?.id === id) void reload(); }), [id, reload]);
  if (!c) return null;
  const done = c.status !== 'open';
  const lines = (c.lines as any[]).filter((l) => (!loc || l.locationId === loc) && (!q || `${l.number} ${l.name} ${l.lot}`.toLowerCase().includes(q.toLowerCase())));
  const save = async (lineId: string, v: string) => { await act(() => put(`/warehouse/counts/${id}/lines/${lineId}`, { counted: v === '' ? null : Number(v) })); reload(); };
  const onScan = async (code: string) => {
    try {
      const r = await get<{ type: string; id: string }>(`/warehouse/lookup?code=${encodeURIComponent(code)}`);
      if (r.type === 'location') { setLoc(r.id); toast('Lagerort gewählt'); return; }
      const hit = (c.lines as any[]).filter((l) => l.articleId === r.id && (!loc || l.locationId === loc));
      if (hit.length === 1) { setQ(hit[0].number); setTimeout(() => (document.querySelector(`[data-line="${hit[0].id}"]`) as HTMLInputElement | null)?.focus(), 50); }
      else if (!hit.length) { const a = await get<any>(`/warehouse/articles/${r.id}`); setExtra({ articleId: r.id, name: `${a.number} ${a.name}` }); }
      else setQ(hit[0].number);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const counted = (c.lines as any[]).filter((l) => l.counted !== null).length;
  return (
    <div>
      <div className="toolbar">
        <button className="btn ghost" onClick={onBack}><Icon name="chevron-left" /> Zurück</button>
        <b>{c.name}</b><span className="small muted">{counted} von {c.lines.length} gezählt</span>
        {!done && <ScanButton label="Scannen" onCode={onScan} keepOpen title="Lagerort oder Artikel scannen" hint="Erst den Lagerort, dann die Artikel scannen." />}
        <div style={{ width: 180 }}><LocSelect value={loc} onChange={setLoc} options={locs.options} placeholder="alle Orte" onlyActive={false} /></div>
        <input placeholder="Filtern …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 160 }} />
        <a className="btn" href="#" onClick={(e) => { e.preventDefault(); window.print(); }}><Icon name="printer" /> Zählliste</a>
        {!done && <button className="btn primary right" onClick={() => setFinish(true)}>Abschließen</button>}
      </div>
      <table className="table"><thead><tr><th>Lagerort</th><th>Artikel</th><th>Charge/SN</th><th style={{ textAlign: 'right' }}>Soll</th><th style={{ width: 130 }}>Gezählt</th><th style={{ textAlign: 'right' }}>Differenz</th></tr></thead>
        <tbody>{lines.map((l) => {
          const diff = l.counted === null ? null : l.counted - l.expected;
          return (
            <tr key={l.id}>
              <td className="small">{l.locationName}</td><td><span className="mono">{l.number}</span> {l.name}</td><td className="mono small">{l.lot}</td>
              <td style={{ textAlign: 'right' }}>{qty(l.expected, l.unit)}</td>
              <td>{done ? qty(l.counted) : <input data-line={l.id} type="number" min={0} step="any" defaultValue={l.counted ?? ''} key={`${l.id}-${l.counted}`} onBlur={(e) => e.target.value !== String(l.counted ?? '') && void save(l.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />}</td>
              <td style={{ textAlign: 'right' }} className={diff ? (diff < 0 ? 'text-red' : 'text-green') : 'muted'}>{diff === null ? '' : diff === 0 ? '✓' : `${diff > 0 ? '+' : ''}${qty(diff)}`}</td>
            </tr>
          );
        })}</tbody></table>
      {extra && <ExtraLine count={id} article={extra} locs={locs} defaultLoc={loc} onClose={() => setExtra(null)} onDone={() => { setExtra(null); reload(); }} />}
      {finish && <Confirm text={`Inventur abschließen? ${c.lines.length - counted} ungezählte Position(en) bleiben unverändert, Abweichungen werden gebucht.`} onClose={() => setFinish(false)}
        onConfirm={async () => { const r = await act(() => post<{ changes: number }>(`/warehouse/counts/${id}/finish`, {})); if (r) { toast(`Abgeschlossen, ${r.changes} Korrektur(en) gebucht`); reload(); } }} />}
    </div>
  );
}

function ExtraLine({ count, article, locs, defaultLoc, onClose, onDone }: { count: string; article: { articleId: string; name: string }; locs: ReturnType<typeof useLocations>; defaultLoc: string; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [loc, setLoc] = useState(defaultLoc);
  const [n, setN] = useState('1');
  const [lot, setLot] = useState('');
  return (
    <Modal title="Artikel gefunden, der hier nicht erwartet wurde" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!loc} onClick={async () => { if (await act(() => post(`/warehouse/counts/${count}/lines`, { articleId: article.articleId, locationId: loc, lot, counted: Number(n) }))) onDone(); }}>Übernehmen</button></>}>
      <p><b>{article.name}</b></p>
      <div className="grid3">
        <Field label="Lagerort"><LocSelect value={loc} onChange={setLoc} options={locs.options} /></Field>
        <Field label="Menge"><input type="number" min={0} value={n} onChange={(e) => setN(e.target.value)} /></Field>
        <Field label="Charge/SN"><input value={lot} onChange={(e) => setLot(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Lagerorte
function Locations({ locs, onFilter }: { locs: ReturnType<typeof useLocations>; onFilter: (id: string) => void }) {
  const act = useAction();
  const [edit, setEdit] = useState<any | null>(null);
  const [remove, setRemove] = useState<Loc | null>(null);
  const labels = (list: Loc[]): Label[] => list.map((l) => ({ title: l.name, subtitle: LOCATION_KIND[l.kind], code: l.code, qr: l.code }));
  return (
    <div>
      <div className="toolbar">
        <span className="muted small">Lager, Bereiche, Regale und Fächer – beliebig verschachtelt. Die Etiketten tragen den Code des Ortes zum Scannen.</span>
        <span className="right row" style={{ gap: 6 }}>
          {locs.locations && locs.locations.length > 0 && <LabelButton labels={() => labels((locs.locations ?? []).filter((l) => l.active))} label="Alle Etiketten" />}
          <button className="btn primary" onClick={() => setEdit({ name: '', kind: 'warehouse', parentId: '', code: '' })}><Icon name="plus" /> Lagerort</button>
        </span>
      </div>
      {locs.locations && !locs.locations.length && <Empty icon="building" title="Noch keine Lagerorte">Zum Beispiel „Hauptlager“ → „Regal A“ → „Fach A1“.</Empty>}
      <table className="table"><tbody>{locs.options.map(({ id, loc: l, label }) => (
        <tr key={id} className={l.active ? '' : 'muted'}>
          <td style={{ paddingLeft: 10 + (label.length - label.trimStart().length) * 10 }}><b>{l.name}</b> <span className="small muted">{LOCATION_KIND[l.kind]}{l.active ? '' : ' · stillgelegt'}</span></td>
          <td className="mono small">{l.code}</td>
          <td className="small"><button className="link" onClick={() => onFilter(id)}>{l.articles} Artikel</button></td>
          <td style={{ textAlign: 'right' }}>
            <button className="btn sm ghost" title="Unterort" onClick={() => setEdit({ name: '', kind: l.kind === 'warehouse' ? 'shelf' : 'bin', parentId: id, code: '' })}><Icon name="plus" /></button>
            <button className="btn sm ghost" title="Etikett" onClick={() => import('../modules/Scan').then((m) => m.printLabels(labels([l])))}><Icon name="printer" /></button>
            <button className="btn sm ghost" title="Bearbeiten" onClick={() => setEdit({ ...l, parentId: l.parentId ?? '' })}><Icon name="edit" /></button>
            <button className="btn sm ghost danger" title="Löschen" onClick={() => setRemove(l)}><Icon name="trash" /></button>
          </td>
        </tr>
      ))}</tbody></table>
      {edit && <Modal title={edit.id ? 'Lagerort bearbeiten' : 'Neuer Lagerort'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
        <button className="btn primary" disabled={!edit.name.trim()} onClick={async () => {
          const body = { name: edit.name, kind: edit.kind, parentId: edit.parentId || null, code: edit.code || null, ...(edit.id ? { active: edit.active } : {}) };
          if (await act(() => (edit.id ? patch(`/warehouse/locations/${edit.id}`, body) : post('/warehouse/locations', body)), 'Gespeichert')) { setEdit(null); locs.reload(); }
        }}>Speichern</button></>}>
        <div className="grid2">
          <Field label="Name" required><input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Art"><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{Object.entries(LOCATION_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Liegt in"><LocSelect value={edit.parentId} onChange={(v) => setEdit({ ...edit, parentId: v })} options={locs.options.filter((o) => o.id !== edit.id)} placeholder="– oberste Ebene –" /></Field>
          <Field label="Code" hint="leer = automatisch"><input className="mono" value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
        </div>
        {edit.id && <label className="row"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> aktiv</label>}
      </Modal>}
      {remove && <Confirm danger text={`Lagerort „${remove.name}“ löschen?`} onClose={() => setRemove(null)} onConfirm={async () => { if (await act(() => del(`/warehouse/locations/${remove.id}`), 'Erledigt')) locs.reload(); }} />}
    </div>
  );
}
