import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, get, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useCan } from '../session';
import { fmtDate, fmtDateTime, fmtEuro2 } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker } from './CrmShared';
import { ArticleSelect, LocationSelect } from './Pickers';
import { ProjectGroups, useGrouping, useLiveReload } from './ProjectApps';

export const PURCHASE_STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: 'Offen', tone: '' }, requested: { label: 'Angefragt', tone: 'blue' }, ordered: { label: 'Bestellt', tone: 'amber' }, confirmed: { label: 'Bestätigt', tone: 'amber' },
  partial: { label: 'Teilweise geliefert', tone: 'blue' }, delivered: { label: 'Geliefert', tone: 'green' }, cancelled: { label: 'Storniert', tone: 'red' },
};

export interface PurchaseItem {
  id: string; projectId: string | null; projectNumber: string | null; projectName: string | null; source: string; cadItemId: string | null; revisionAtOrder: number | null; cadRevision: number | null;
  revisionWarning: boolean; number: string; designation: string; manufacturer: string; manufacturerNo: string; supplierId: string | null; supplierName: string | null;
  supplierOrderNo: string; qty: number; unit: string; unitPrice: number | null; discount: number; total: number; costCenter: string; note: string; status: string;
  requestedAt: string | null; orderedAt: string | null; plannedDelivery: string | null; confirmedDelivery: string | null; deliveredQty: number; deliveredAt: string | null;
  orderId: string | null; orderNumber: string | null; overdue: boolean;
  whArticleId: string | null; articleNumber: string | null; articleName: string | null; articleTracking: string | null; locationId: string | null; locationName: string | null;
}

const ACTIVE = ['ordered', 'confirmed', 'partial'];

/** Einkaufsliste eines Projekts */
export function ProjectPurchasing({ project, canEdit }: { project: any; canEdit: boolean }) {
  return <PurchaseList project={project} canEdit={canEdit} />;
}

/** Lagerbestellungen: Nachschub für das Lager, ohne Projekt */
export function StockPurchasing() {
  return <PurchaseList project={null} canEdit />;
}

function PurchaseList({ project, canEdit }: { project: { id: string; budget?: number | null } | null; canEdit: boolean }) {
  const act = useAction();
  const toast = useToast();
  const can = useCan();
  const base = project ? `/purchasing/projects/${project.id}/items` : '/purchasing/stock/items';
  const { data, reload } = useApi<PurchaseItem[]>(base);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<PurchaseItem | 'new' | null>(null);
  const [receive, setReceive] = useState<PurchaseItem | null>(null);
  const [bulk, setBulk] = useState<'order' | null>(null);
  const [filter, setFilter] = useState('active');
  useLiveReload([project ? `project:${project.id}` : 'global'], ['purchasing.changed'], reload);
  const rows = (data ?? []).filter((i) => filter === 'all' || (filter === 'active' ? !['delivered', 'cancelled'].includes(i.status) : i.status === filter));
  const sum = (f: (i: PurchaseItem) => boolean) => (data ?? []).filter(f).reduce((a, i) => a + i.total, 0);
  const spent = sum((i) => !['open', 'requested', 'cancelled'].includes(i.status));
  const planned = sum((i) => ['open', 'requested'].includes(i.status));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const setStatus = async (status: string) => { await act(() => post('/purchasing/bulk', { ids: [...sel], status }), `${sel.size} Positionen: ${PURCHASE_STATUS[status]!.label}`); setSel(new Set()); void reload(); };
  const sync = async () => {
    if (!project) return;
    const r = await act(() => post<{ added: number; updated: number }>(`/purchasing/projects/${project.id}/sync`));
    if (r) toast(r.added || r.updated ? `${r.added} neue Teile übernommen, ${r.updated} aktualisiert` : 'Keine neuen Kauf- oder Normteile in der Stückliste');
    void reload();
  };
  const budget = project?.budget ?? null;
  return (
    <div>
      <div className="kpi-row">
        <div className="kpi"><div className="v">{(data ?? []).filter((i) => i.status === 'open').length}</div><div className="l">offen</div></div>
        <div className="kpi"><div className="v">{(data ?? []).filter((i) => ACTIVE.includes(i.status)).length}</div><div className="l">bestellt, noch nicht da</div></div>
        <div className="kpi"><div className="v" style={{ color: (data ?? []).some((i) => i.overdue) ? 'var(--red)' : undefined }}>{(data ?? []).filter((i) => i.overdue).length}</div><div className="l">überfällig</div></div>
        <div className="kpi"><div className="v">{fmtEuro2(spent)}</div><div className="l">bestellt{budget ? ` von ${fmtEuro2(budget)} Budget` : ''}{planned ? ` · ${fmtEuro2(planned)} geplant` : ''}</div>
          {budget ? <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${Math.min(100, (spent / budget) * 100)}%`, background: spent > budget ? 'var(--red)' : undefined }} /></div> : null}</div>
      </div>
      {(data ?? []).some((i) => i.revisionWarning && !['delivered', 'cancelled'].includes(i.status)) && (
        <div className="locked-banner" style={{ borderColor: 'var(--red)' }}><Icon name="alert" /><span className="grow">Bereits bestellte Teile wurden in der Konstruktion geändert – bitte beim Lieferanten prüfen, ob der neue Stand geliefert wird.</span></div>
      )}
      <div className="toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="active">noch nicht geliefert</option><option value="all">alle</option>{Object.entries(PURCHASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {sel.size > 0 && canEdit && <>
          <span className="small muted">{sel.size} markiert:</span>
          <button className="btn sm primary" onClick={() => setBulk('order')}><Icon name="truck" /> Bestellen …</button>
          <select value="" onChange={(e) => e.target.value && setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Status setzen …</option>{Object.entries(PURCHASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        </>}
        <span className="grow" />
        {project && <a className="btn" href={`/api/purchasing/projects/${project.id}/export.xlsx`}><Icon name="file-excel" /> Excel</a>}
        {project && canEdit && can('cad') && <button className="btn" onClick={sync} title="Kauf- und Normteile aus der CAD-Bridge übernehmen"><Icon name="refresh" /> Aus Stückliste</button>}
        {canEdit && <button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Position</button>}
      </div>
      {!rows.length ? <Empty icon="truck" title="Keine Positionen">{project
        ? 'Kauf- und Normteile kommen aus der Stückliste der CAD-Bridge; weitere Positionen (z. B. Montagematerial) legen Sie von Hand an.'
        : 'Hier bestellen Sie Ware für das Lager – ohne Projekt. Vorschläge kommen aus dem Lager (Mindestbestand unterschritten).'}</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr>{canEdit && <th style={{ width: 28 }}><input type="checkbox" checked={sel.size === rows.length} onChange={() => setSel(sel.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
            <th>Teil</th><th>Hersteller</th><th>Lieferant</th><th style={{ textAlign: 'right' }}>Menge</th><th style={{ textAlign: 'right' }}>Gesamt</th><th>Liefertermin</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((i) => (
            <tr key={i.id} className="click" onClick={() => setEdit(i)}>
              {canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} /></td>}
              <ItemCells i={i} />
              <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                {canEdit && ACTIVE.includes(i.status) && <button className="btn sm" onClick={() => setReceive(i)}>Wareneingang</button>}
                {i.orderId && <a className="btn ghost sm" title="Bestellung als PDF" href={`/api/purchasing/orders/${i.orderId}/pdf`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /></a>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {project && can('warehouse') && <ProjectMaterial projectId={project.id} />}
      {edit && <ItemModal projectId={project?.id ?? null} item={edit === 'new' ? null : edit} canEdit={canEdit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }}
        onReceive={(i) => { setEdit(null); setReceive(i); }} />}
      {receive && <ReceiptModal item={receive} onClose={() => setReceive(null)} onDone={() => { setReceive(null); void reload(); }} />}
      {bulk && <OrderModal ids={[...sel]} items={(data ?? []).filter((i) => sel.has(i.id))} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSel(new Set()); void reload(); }} />}
    </div>
  );
}

/** Zellen einer Einkaufsposition (Teil bis Status) */
function ItemCells({ i }: { i: PurchaseItem }) {
  return <>
    <td>{i.revisionWarning && <span title="Nach der Bestellung in der Konstruktion geändert" style={{ color: 'var(--red)' }}><Icon name="alert" /> </span>}
      <b>{i.designation}</b><div className="small muted mono">{i.number}{i.source === 'cad' && ' · aus CAD'}{i.articleNumber && <> · <Link to={`/warehouse/article/${i.whArticleId}`} onClick={(e) => e.stopPropagation()} title="Lagerartikel"><Icon name="box" size={12} /> {i.articleNumber}</Link></>}</div></td>
    <td className="small">{i.manufacturer}<div className="muted">{i.manufacturerNo}</div></td>
    <td className="small">{i.supplierName ?? <span className="muted">–</span>}{i.orderNumber && <div className="muted">{i.orderNumber}</div>}</td>
    <td style={{ textAlign: 'right' }}>{i.qty.toLocaleString('de-DE')} {i.unit}{i.deliveredQty > 0 && i.status !== 'delivered' && <div className="small muted">{i.deliveredQty.toLocaleString('de-DE')} da</div>}</td>
    <td style={{ textAlign: 'right' }}>{i.unitPrice != null ? fmtEuro2(i.total) : <span className="muted">–</span>}</td>
    <td className={i.overdue ? 'error-text' : 'small'}>{fmtDate(i.confirmedDelivery ?? i.plannedDelivery)}{i.confirmedDelivery && <div className="small muted">bestätigt</div>}</td>
    <td><Pill tone={PURCHASE_STATUS[i.status]?.tone}>{PURCHASE_STATUS[i.status]?.label}</Pill></td>
  </>;
}

/** Material aus dem Lager, das für das Projekt entnommen wurde */
export function ProjectMaterial({ projectId, title = 'Material aus dem Lager' }: { projectId: string; title?: string }) {
  const { data, reload } = useApi<{ rows: { articleId: string; number: string; name: string; unit: string; qty: number; value: number }[]; total: number }>(`/warehouse/projects/${projectId}/material`);
  useLiveReload([`project:${projectId}`], ['warehouse.changed'], reload);
  if (!data?.rows.length) return null;
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 6 }}>{title} <span className="small muted">· {fmtEuro2(data.total)}</span></h3>
      <table className="table small"><tbody>{data.rows.filter((r) => r.qty !== 0).map((r) => (
        <tr key={r.articleId}><td className="mono" style={{ width: 110 }}><Link to={`/warehouse/article/${r.articleId}`}>{r.number}</Link></td><td>{r.name}</td>
          <td style={{ textAlign: 'right' }}>{r.qty.toLocaleString('de-DE')} {r.unit}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(r.value)}</td></tr>
      ))}</tbody></table>
    </div>
  );
}

function ItemModal({ projectId, item, canEdit, onClose, onSaved, onReceive }: { projectId: string | null; item: PurchaseItem | null; canEdit: boolean; onClose: () => void; onSaved: () => void; onReceive: (i: PurchaseItem) => void }) {
  const act = useAction();
  const can = useCan();
  const wh = can('warehouse');
  const [i, setI] = useState<Partial<PurchaseItem>>(item ?? { designation: '', qty: 1, unit: 'Stk', discount: 0, status: 'open', whArticleId: null, locationId: null });
  const [supplier, setSupplier] = useState(item?.supplierId ? { id: item.supplierId, name: item.supplierName ?? '' } : null as { id: string; name: string } | null);
  const [confirm, setConfirm] = useState(false);
  const [view, setView] = useState<'data' | 'history'>('data');
  const set = (k: keyof PurchaseItem) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setI({ ...i, [k]: e.target.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value || (k.endsWith('At') || k.endsWith('Delivery') ? null : '') });
  /** Lagerartikel gewählt: leere Felder aus dem Artikel füllen */
  const pickArticle = async (id: string | null) => {
    if (!id) { setI({ ...i, whArticleId: null }); return; }
    const a = await get<any>(`/warehouse/articles/${id}`).catch(() => null);
    if (!a) { setI({ ...i, whArticleId: id }); return; }
    setI({ ...i, whArticleId: id, designation: i.designation || a.name, number: i.number || a.number, manufacturer: i.manufacturer || a.manufacturer, manufacturerNo: i.manufacturerNo || a.manufacturerNo,
      supplierOrderNo: i.supplierOrderNo || a.supplierNo, unit: !i.unit || i.unit === 'Stk' ? a.unit : i.unit, unitPrice: i.unitPrice ?? a.purchasePrice,
      locationId: i.locationId ?? (projectId ? null : a.defaultLocationId), qty: !item && !projectId && a.reorderQty ? a.reorderQty : i.qty });
    if (!supplier && a.supplierId) setSupplier({ id: a.supplierId, name: a.supplierName ?? '' });
  };
  const save = async () => {
    const body = { number: i.number ?? '', designation: i.designation, manufacturer: i.manufacturer ?? '', manufacturerNo: i.manufacturerNo ?? '', supplierId: supplier?.id ?? null,
      supplierOrderNo: i.supplierOrderNo ?? '', qty: Number(i.qty), unit: i.unit, unitPrice: i.unitPrice ?? null, discount: Number(i.discount ?? 0), costCenter: i.costCenter ?? '', note: i.note ?? '',
      status: i.status, requestedAt: i.requestedAt ?? null, orderedAt: i.orderedAt ?? null, plannedDelivery: i.plannedDelivery ?? null, confirmedDelivery: i.confirmedDelivery ?? null,
      ...(wh ? { whArticleId: i.whArticleId ?? null, locationId: i.locationId ?? null } : {}) };
    const url = projectId ? `/purchasing/projects/${projectId}/items` : '/purchasing/stock/items';
    if (await act(() => (item ? patch(`/purchasing/items/${item.id}`, body) : post(url, body)), 'Gespeichert')) onSaved();
  };
  const total = Number(i.qty ?? 0) * Number(i.unitPrice ?? 0) * (1 - Number(i.discount ?? 0) / 100);
  return (
    <Modal size="lg" title={item ? item.designation : projectId ? 'Neue Position' : 'Neue Lagerbestellung'} onClose={onClose} footer={<>
      {item?.status === 'open' && canEdit && <button className="btn danger" onClick={() => setConfirm(true)}>Löschen</button>}
      {item?.revisionWarning && canEdit && <button className="btn" onClick={async () => { await act(() => patch(`/purchasing/items/${item.id}`, { revisionWarning: false }), 'Hinweis erledigt'); onSaved(); }}><Icon name="check" /> Änderung mit Lieferant geklärt</button>}
      {item && canEdit && ACTIVE.includes(item.status) && <button className="btn" onClick={() => onReceive(item)}><Icon name="download" /> Wareneingang</button>}
      <span className="grow" /><span className="muted">Gesamt {fmtEuro2(total)}</span>
      <button className="btn" onClick={onClose}>Abbrechen</button>{canEdit && view === 'data' && <button className="btn primary" disabled={!i.designation?.trim()} onClick={save}>Speichern</button>}</>}>
      {item && <Tabs value={view} onChange={setView} tabs={[{ id: 'data', label: 'Angaben' }, { id: 'history', label: 'Verlauf und Warenfluss' }]} />}
      {view === 'history' && item ? <ItemHistory item={item} /> : <>
        {item?.revisionWarning && <div className="locked-banner" style={{ borderColor: 'var(--red)' }}><Icon name="alert" /> Bestellt mit Versionsstand {String(item.revisionAtOrder ?? 0).padStart(2, '0')}, aktuell {String(item.cadRevision ?? 0).padStart(2, '0')}.</div>}
        {wh && <div className="grid2">
          <Field label="Lagerartikel" hint={item ? 'verknüpft Bestellung und Lager' : 'füllt leere Felder aus dem Artikel'}><ArticleSelect value={i.whArticleId ?? null} onChange={(v) => void pickArticle(v)} /></Field>
          <Field label="Lagerort für den Eingang" hint={projectId ? 'nur nötig, wenn die Ware erst ins Lager geht' : 'leer = Standard-Lagerort des Artikels'}><LocationSelect value={i.locationId ?? null} onChange={(v) => setI({ ...i, locationId: v })} /></Field>
        </div>}
        <div className="grid2">
          <Field label="Benennung" required><input autoFocus value={i.designation ?? ''} onChange={set('designation')} /></Field>
          <Field label="Teilenummer"><input className="mono" value={i.number ?? ''} onChange={set('number')} /></Field>
          <Field label="Hersteller"><input value={i.manufacturer ?? ''} onChange={set('manufacturer')} /></Field>
          <Field label="Herstellernummer"><input value={i.manufacturerNo ?? ''} onChange={set('manufacturerNo')} /></Field>
          <Field label="Lieferant" hint="aus dem CRM"><CustomerPicker kind="supplier" value={supplier} onChange={setSupplier} placeholder="Lieferant suchen …" /></Field>
          <Field label="Bestellnummer beim Lieferanten"><input value={i.supplierOrderNo ?? ''} onChange={set('supplierOrderNo')} /></Field>
        </div>
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <Field label="Menge"><input type="number" min={0} value={i.qty ?? ''} onChange={set('qty')} /></Field>
          <Field label="Einheit"><input value={i.unit ?? ''} onChange={set('unit')} /></Field>
          <Field label="Einzelpreis €"><input type="number" step="0.01" min={0} value={i.unitPrice ?? ''} onChange={set('unitPrice')} /></Field>
          <Field label="Rabatt %"><input type="number" min={0} max={100} value={i.discount ?? 0} onChange={set('discount')} /></Field>
          <Field label="Status"><select value={i.status} onChange={set('status')}>{Object.entries(PURCHASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          <Field label="Angefragt am"><input type="date" value={i.requestedAt ?? ''} onChange={set('requestedAt')} /></Field>
          <Field label="Bestellt am"><input type="date" value={i.orderedAt ?? ''} onChange={set('orderedAt')} /></Field>
          <Field label="Kostenstelle"><input value={i.costCenter ?? ''} onChange={set('costCenter')} /></Field>
          <Field label="Geplante Lieferung"><input type="date" value={i.plannedDelivery ?? ''} onChange={set('plannedDelivery')} /></Field>
          <Field label="Bestätigte Lieferung"><input type="date" value={i.confirmedDelivery ?? ''} onChange={set('confirmedDelivery')} /></Field>
        </div>
        <Field label="Bemerkung"><textarea rows={2} value={i.note ?? ''} onChange={set('note')} /></Field>
      </>}
      {confirm && item && <Confirm danger text={`„${item.designation}“ löschen?`} onClose={() => setConfirm(false)} onConfirm={async () => { await act(() => del(`/purchasing/items/${item.id}`), 'Gelöscht'); onSaved(); }} />}
    </Modal>
  );
}

const HISTORY_ICON: Record<string, string> = { log: 'edit', order: 'file-text', receipt: 'download', move: 'box' };

/** Verlauf einer Position: Änderungen, Bestellung, Wareneingänge, Lagerbewegungen */
function ItemHistory({ item }: { item: PurchaseItem }) {
  const { data } = useApi<{ at: string; text: string; user: string | null; kind: string }[]>(`/purchasing/items/${item.id}/history`);
  const { data: receipts } = useApi<any[]>(`/purchasing/items/${item.id}/receipts`);
  return (
    <div className="stack">
      <div className="kpi-row">
        <div className="kpi"><div className="v">{item.qty.toLocaleString('de-DE')} {item.unit}</div><div className="l">bestellt{item.orderNumber ? ` · ${item.orderNumber}` : ''}</div></div>
        <div className="kpi"><div className="v">{item.deliveredQty.toLocaleString('de-DE')} {item.unit}</div><div className="l">geliefert{item.deliveredAt ? ` · ${fmtDate(item.deliveredAt)}` : ''}</div></div>
        <div className="kpi"><div className="v">{item.articleNumber ? <Link to={`/warehouse/article/${item.whArticleId}`}>{item.articleNumber}</Link> : '–'}</div><div className="l">Lagerartikel{item.locationName ? ` · ${item.locationName}` : ''}</div></div>
      </div>
      {receipts?.length ? (
        <div className="table-wrap"><table className="table small">
          <thead><tr><th>Eingang</th><th style={{ textAlign: 'right' }}>Menge</th><th>Lieferschein</th><th>Verbleib</th><th>Charge / Seriennummer</th><th>gebucht von</th></tr></thead>
          <tbody>{receipts.map((r) => (
            <tr key={r.id}><td>{fmtDate(r.receivedAt)}</td><td style={{ textAlign: 'right' }}>{r.qty.toLocaleString('de-DE')}</td><td>{r.deliveryNote || '–'}</td>
              <td>{r.target === 'stock' ? `eingelagert${r.locationName ? `: ${r.locationName}` : ''}` : r.target === 'project' ? 'direkt ins Projekt' : 'nur Eingang gebucht'}</td>
              <td className="mono">{r.lot || '–'}</td><td>{r.userName ?? ''}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <div className="muted small">Noch kein Wareneingang.</div>}
      <div className="timeline">{(data ?? []).map((h, k) => (
        <div key={k} className="tl-item"><span className="tl-dot"><Icon name={HISTORY_ICON[h.kind] ?? 'dot'} /></span>
          <div className="small muted">{fmtDateTime(h.at)}{h.user ? ` · ${h.user}` : ''}</div><div>{h.text}</div></div>
      ))}</div>
    </div>
  );
}

/** Wareneingang – auf Wunsch gleich ins Lager oder ins Projekt */
export function ReceiptModal({ item, onClose, onDone }: { item: PurchaseItem; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const can = useCan();
  const wh = can('warehouse');
  const [qty, setQty] = useState(Math.max(0, item.qty - item.deliveredQty));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [deliveryNote, setDeliveryNote] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<'none' | 'stock' | 'project'>(!wh ? 'none' : !item.projectId ? 'stock' : item.whArticleId ? 'project' : 'none');
  const [locationId, setLocationId] = useState<string | null>(item.locationId);
  const [articleId, setArticleId] = useState<string | null>(item.whArticleId);
  const [lot, setLot] = useState('');
  const [serials, setSerials] = useState('');
  const { data: article } = useApi<any>(wh && articleId ? `/warehouse/articles/${articleId}` : null);
  useEffect(() => { if (article && !locationId) setLocationId(article.defaultLocationId ?? null); }, [article]); // eslint-disable-line react-hooks/exhaustive-deps
  const tracking: string = article?.tracking ?? (articleId ? 'none' : 'auto');
  const serialList = serials.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const needSerials = target !== 'none' && tracking === 'serial';
  const ok = qty > 0 && (target === 'none' || Boolean(locationId)) && (!needSerials || serialList.length === qty);
  return (
    <Modal size={wh ? 'lg' : undefined} title={`Wareneingang: ${item.designation}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!ok} onClick={async () => {
        const body = { qty, receivedAt: date, note, deliveryNote, target, locationId: target === 'none' ? null : locationId, lot: target !== 'none' && tracking !== 'serial' ? lot : '',
          serials: target !== 'none' && (tracking === 'serial' || (tracking === 'auto' && serialList.length)) ? serialList : [], articleId: target === 'none' ? null : articleId, createArticle: target !== 'none' && !articleId };
        if (await act(() => post(`/purchasing/items/${item.id}/receipts`, body), target === 'stock' ? 'Eingang gebucht und eingelagert' : target === 'project' ? 'Eingang gebucht und ins Projekt entnommen' : 'Wareneingang gebucht')) onDone();
      }}>Buchen</button></>}>
      <p className="muted">Bestellt {item.qty.toLocaleString('de-DE')} {item.unit}, bisher geliefert {item.deliveredQty.toLocaleString('de-DE')}.{item.projectId ? ' Die Projektleitung wird benachrichtigt.' : ''}</p>
      <div className="grid2">
        <Field label="Gelieferte Menge"><input type="number" min={0} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></Field>
        <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Lieferschein-Nr."><input value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} /></Field>
        <Field label="Bemerkung"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Verpackung beschädigt" /></Field>
      </div>
      {wh && <>
        <Field label="Was passiert mit der Ware?">
          <div className="stack" style={{ gap: 4 }}>
            {item.projectId && <label className="row"><input type="radio" checked={target === 'project'} onChange={() => setTarget('project')} /> Einlagern und gleich für das Projekt entnehmen <span className="small muted">(Bestand bleibt gleich, Material zählt zum Projekt)</span></label>}
            <label className="row"><input type="radio" checked={target === 'stock'} onChange={() => setTarget('stock')} /> Ins Lager einlagern</label>
            <label className="row"><input type="radio" checked={target === 'none'} onChange={() => setTarget('none')} /> Nur Eingang buchen <span className="small muted">(nicht über das Lager, z. B. direkt auf die Baustelle)</span></label>
          </div>
        </Field>
        {target !== 'none' && <>
          <div className="grid2">
            <Field label="Lagerartikel" hint={articleId ? undefined : 'leer = passenden Artikel suchen, sonst neu anlegen'}><ArticleSelect value={articleId} onChange={setArticleId} /></Field>
            <Field label="Lagerort" required><LocationSelect value={locationId} onChange={setLocationId} /></Field>
          </div>
          {tracking === 'lot' && <Field label="Charge" hint="Pflicht bei diesem Artikel"><input value={lot} onChange={(e) => setLot(e.target.value)} /></Field>}
          {tracking === 'auto' && <div className="grid2">
            <Field label="Charge" hint="optional – der neue Artikel wird dann chargengeführt"><input value={lot} onChange={(e) => setLot(e.target.value)} /></Field>
            <Field label="Seriennummern" hint="optional – eine je Stück, je Zeile"><textarea rows={2} value={serials} onChange={(e) => setSerials(e.target.value)} /></Field>
          </div>}
          {tracking === 'serial' && <Field label={`Seriennummern (${serialList.length} von ${qty})`} hint="eine je Stück, je Zeile oder durch Komma getrennt"><textarea rows={3} value={serials} onChange={(e) => setSerials(e.target.value)} /></Field>}
        </>}
      </>}
    </Modal>
  );
}

function OrderModal({ ids, items, onClose, onDone }: { ids: string[]; items: PurchaseItem[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const first = items.find((i) => i.supplierId);
  const [supplier, setSupplier] = useState(first ? { id: first.supplierId!, name: first.supplierName ?? '' } : null as { id: string; name: string } | null);
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const total = useMemo(() => items.reduce((a, i) => a + i.total, 0), [items]);
  return (
    <Modal title={`${ids.length} Positionen bestellen`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!supplier} onClick={async () => {
        const r = await act(() => post<{ orderId: string; orderNumber: string }>('/purchasing/bulk', { ids, supplierId: supplier!.id, createOrder: true, plannedDelivery: date || undefined, note }), 'Bestellung angelegt');
        if (r) { window.open(`/api/purchasing/orders/${r.orderId}/pdf`, '_blank'); onDone(); }
      }}>Bestellung anlegen</button></>}>
      <p className="muted">Die Positionen werden auf „Bestellt“ gesetzt, bekommen eine Bestellnummer und Sie erhalten die Bestellung als PDF ({fmtEuro2(total)} netto).</p>
      <Field label="Lieferant" required><CustomerPicker kind="supplier" value={supplier} onChange={setSupplier} placeholder="Lieferant suchen …" /></Field>
      <Field label="Gewünschter Liefertermin"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Hinweis auf der Bestellung"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

/** Einkauf: Übersicht, alle Positionen nach Projekt, Lagerbestellungen */
export function PurchasingDashboard() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const stockOk = can('warehouse') || can('purchasing');
  const tab = params.get('tab') ?? 'overview';
  const setTab = (t: string) => { params.set('tab', t); setParams(params, { replace: true }); };
  return (
    <div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Übersicht' }, { id: 'items', label: 'Alle Positionen' }, ...(stockOk ? [{ id: 'stock', label: 'Lagerbestellungen' }] : [])]} />
      {tab === 'overview' && <Overview onTab={setTab} />}
      {tab === 'items' && <AllItems />}
      {tab === 'stock' && stockOk && <StockPurchasing />}
    </div>
  );
}

function Overview({ onTab }: { onTab: (t: string) => void }) {
  const { data: d, reload } = useApi<any>('/purchasing/dashboard');
  useLiveReload(['global'], ['purchasing.changed'], reload);
  if (!d) return null;
  return (
    <div>
      <div className="kpi-row">
        <div className="kpi click" onClick={() => onTab('items')}><div className="v">{d.open}</div><div className="l">offene Positionen</div></div>
        <div className="kpi click" onClick={() => onTab('items')}><div className="v">{d.requested}</div><div className="l">angefragt</div></div>
        <div className="kpi click" onClick={() => onTab('items')}><div className="v">{d.ordered}</div><div className="l">bestellt, noch unterwegs</div></div>
        <div className="kpi click" onClick={() => onTab('items')}><div className="v" style={{ color: d.overdue ? 'var(--red)' : undefined }}>{d.overdue}</div><div className="l">überfällig</div></div>
        <div className="kpi"><div className="v" style={{ color: d.warnings ? 'var(--red)' : undefined }}>{d.warnings}</div><div className="l">nach Bestellung geändert</div></div>
        <div className="kpi"><div className="v">{fmtEuro2(d.orderedValue)}</div><div className="l">Bestellwert gesamt</div></div>
      </div>
      <div className="grid2">
        <div className="card">
          <h3>Ausgaben je Projekt</h3>
          {d.projects.map((p: any) => (
            <div key={p.id} style={{ margin: '6px 0' }}>
              <div className="row small"><Link className="grow" to={`/projects/${p.id}?tab=purchasing`}>{p.number} {p.name}</Link><b>{fmtEuro2(p.spent)}</b>{p.budget ? <span className="muted">von {fmtEuro2(p.budget)}</span> : null}</div>
              {p.budget ? <div className="progress"><div style={{ width: `${Math.min(100, (p.spent / p.budget) * 100)}%`, background: p.spent > p.budget ? 'var(--red)' : undefined }} /></div> : null}
            </div>
          ))}
          {!d.projects.length && <div className="muted small">Noch keine Einkaufspositionen</div>}
        </div>
        <div className="card">
          <h3>Liefertreue je Lieferant</h3>
          {d.suppliers.map((s: any) => (
            <div key={s.id} style={{ margin: '6px 0' }}>
              <div className="row small"><Link className="grow" to={`/crm/${s.id}`}>{s.name}</Link><b>{Math.round((s.onTime / s.deliveries) * 100)} %</b><span className="muted">{s.deliveries} Lieferungen</span></div>
              <div className="progress"><div style={{ width: `${(s.onTime / s.deliveries) * 100}%` }} /></div>
            </div>
          ))}
          {!d.suppliers.length && <div className="muted small">Noch keine abgeschlossenen Lieferungen</div>}
        </div>
      </div>
      <h3 style={{ margin: '18px 0 8px' }}>Lieferungen: letzte 30 und nächste 14 Tage</h3>
      <div className="timeline">{d.upcoming.map((i: PurchaseItem) => (
        <div key={i.id} className="tl-item"><span className="tl-dot"><Icon name="truck" /></span>
          <div className={`small ${i.overdue ? 'error-text' : 'muted'}`}>{fmtDate(i.confirmedDelivery ?? i.plannedDelivery)}{i.overdue ? ' – überfällig' : ''}</div>
          <div><b>{i.designation}</b> · {i.qty} {i.unit} · {i.supplierName ?? 'ohne Lieferant'} · {i.projectId ? <Link to={`/projects/${i.projectId}?tab=purchasing`}>{i.projectNumber}</Link> : <Link to="/purchasing?tab=stock">Lager</Link>}</div></div>
      ))}{!d.upcoming.length && <div className="muted small">Keine</div>}</div>
    </div>
  );
}

/** Alle Positionen über alle Projekte – nach Projekt gruppiert, Lagerbestellungen als eigene Gruppe */
function AllItems() {
  const [filter, setFilter] = useState('active');
  const [q, setQ] = useState('');
  const [grouped, groupToggle] = useGrouping('purchasing');
  const { data: items, reload } = useApi<PurchaseItem[]>(`/purchasing/items?${filter === 'overdue' ? 'overdue=1' : filter === 'all' ? '' : `status=${filter}`}`);
  useLiveReload(['global'], ['purchasing.changed'], reload);
  const [edit, setEdit] = useState<PurchaseItem | null>(null);
  const [receive, setReceive] = useState<PurchaseItem | null>(null);
  const needle = q.trim().toLowerCase();
  const rows = (items ?? []).filter((i) => !needle || `${i.designation} ${i.number} ${i.manufacturerNo} ${i.supplierName ?? ''} ${i.orderNumber ?? ''} ${i.projectNumber ?? ''} ${i.projectName ?? ''}`.toLowerCase().includes(needle));
  const table = (list: PurchaseItem[], showProject: boolean) => (
    <div className="table-wrap"><table className="table">
      <thead><tr>{showProject && <th>Projekt</th>}<th>Teil</th><th>Hersteller</th><th>Lieferant</th><th style={{ textAlign: 'right' }}>Menge</th><th style={{ textAlign: 'right' }}>Gesamt</th><th>Liefertermin</th><th>Status</th><th /></tr></thead>
      <tbody>{list.map((i) => (
        <tr key={i.id} className="click" onClick={() => setEdit(i)}>
          {showProject && <td onClick={(e) => e.stopPropagation()}>{i.projectId ? <Link to={`/projects/${i.projectId}?tab=purchasing`}>{i.projectNumber}</Link> : <Link to="/purchasing?tab=stock">Lager</Link>}</td>}
          <ItemCells i={i} />
          <td onClick={(e) => e.stopPropagation()}>{ACTIVE.includes(i.status) && <button className="btn sm" onClick={() => setReceive(i)}>Wareneingang</button>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Teil, Lieferant, Bestellung, Projekt …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="active">noch nicht geliefert</option><option value="overdue">überfällig</option><option value="all">alle</option>{Object.entries(PURCHASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        {groupToggle}
        <span className="grow" /><span className="small muted">{rows.length} Positionen</span>
      </div>
      {!rows.length ? <Empty icon="truck" title="Keine Positionen" /> : grouped
        ? <ProjectGroups rows={rows} tab="purchasing" noneLabel="Lagerbestellungen (ohne Projekt)" noneFirst>{(list) => table(list, false)}</ProjectGroups>
        : table(rows, true)}
      {edit && <ItemModal projectId={edit.projectId} item={edit} canEdit onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} onReceive={(i) => { setEdit(null); setReceive(i); }} />}
      {receive && <ReceiptModal item={receive} onClose={() => setReceive(null)} onDone={() => { setReceive(null); void reload(); }} />}
    </div>
  );
}
