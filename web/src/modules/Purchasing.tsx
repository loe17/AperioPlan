import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { fmtDate, fmtEuro2 } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker } from './CrmShared';

export const PURCHASE_STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: 'Offen', tone: '' }, requested: { label: 'Angefragt', tone: 'blue' }, ordered: { label: 'Bestellt', tone: 'amber' }, confirmed: { label: 'Bestätigt', tone: 'amber' },
  partial: { label: 'Teilweise geliefert', tone: 'blue' }, delivered: { label: 'Geliefert', tone: 'green' }, cancelled: { label: 'Storniert', tone: 'red' },
};

export interface PurchaseItem {
  id: string; projectId: string; projectNumber: string; projectName: string; source: string; cadItemId: string | null; revisionAtOrder: number | null; cadRevision: number | null;
  revisionWarning: boolean; number: string; designation: string; manufacturer: string; manufacturerNo: string; supplierId: string | null; supplierName: string | null;
  supplierOrderNo: string; qty: number; unit: string; unitPrice: number | null; discount: number; total: number; costCenter: string; note: string; status: string;
  requestedAt: string | null; orderedAt: string | null; plannedDelivery: string | null; confirmedDelivery: string | null; deliveredQty: number; deliveredAt: string | null;
  orderId: string | null; orderNumber: string | null; overdue: boolean;
}

/** Einkaufsliste eines Projekts */
export function ProjectPurchasing({ project, canEdit }: { project: any; canEdit: boolean }) {
  const act = useAction();
  const toast = useToast();
  const { data, reload } = useApi<PurchaseItem[]>(`/purchasing/projects/${project.id}/items`);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<PurchaseItem | 'new' | null>(null);
  const [receive, setReceive] = useState<PurchaseItem | null>(null);
  const [bulk, setBulk] = useState<'order' | null>(null);
  const [filter, setFilter] = useState('active');
  useEffect(() => realtime.subscribe(`project:${project.id}`, (e) => { if (e === 'purchasing.changed') void reload(); }), [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (data ?? []).filter((i) => filter === 'all' || (filter === 'active' ? !['delivered', 'cancelled'].includes(i.status) : i.status === filter));
  const sum = (f: (i: PurchaseItem) => boolean) => (data ?? []).filter(f).reduce((a, i) => a + i.total, 0);
  const spent = sum((i) => !['open', 'requested', 'cancelled'].includes(i.status));
  const planned = sum((i) => ['open', 'requested'].includes(i.status));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const setStatus = async (status: string) => { await act(() => post('/purchasing/bulk', { ids: [...sel], status }), `${sel.size} Positionen: ${PURCHASE_STATUS[status]!.label}`); setSel(new Set()); void reload(); };
  const sync = async () => {
    const r = await act(() => post<{ added: number; updated: number }>(`/purchasing/projects/${project.id}/sync`));
    if (r) toast(r.added || r.updated ? `${r.added} neue Teile übernommen, ${r.updated} aktualisiert` : 'Keine neuen Kauf- oder Normteile in der Stückliste');
    void reload();
  };
  return (
    <div>
      <div className="kpi-row">
        <div className="kpi"><div className="v">{(data ?? []).filter((i) => i.status === 'open').length}</div><div className="l">offen</div></div>
        <div className="kpi"><div className="v">{(data ?? []).filter((i) => ['ordered', 'confirmed', 'partial'].includes(i.status)).length}</div><div className="l">bestellt, noch nicht da</div></div>
        <div className="kpi"><div className="v" style={{ color: (data ?? []).some((i) => i.overdue) ? 'var(--red)' : undefined }}>{(data ?? []).filter((i) => i.overdue).length}</div><div className="l">überfällig</div></div>
        <div className="kpi"><div className="v">{fmtEuro2(spent)}</div><div className="l">bestellt{project.budget ? ` von ${fmtEuro2(project.budget)} Budget` : ''}{planned ? ` · ${fmtEuro2(planned)} geplant` : ''}</div>
          {project.budget ? <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${Math.min(100, (spent / project.budget) * 100)}%`, background: spent > project.budget ? 'var(--red)' : undefined }} /></div> : null}</div>
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
        <a className="btn" href={`/api/purchasing/projects/${project.id}/export.xlsx`}><Icon name="file-excel" /> Excel</a>
        {canEdit && <button className="btn" onClick={sync} title="Kauf- und Normteile aus der CAD-Bridge übernehmen"><Icon name="refresh" /> Aus Stückliste</button>}
        {canEdit && <button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Position</button>}
      </div>
      {!rows.length ? <Empty icon="truck" title="Keine Positionen">Kauf- und Normteile kommen aus der Stückliste der CAD-Bridge; weitere Positionen (z. B. Montagematerial) legen Sie von Hand an.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr>{canEdit && <th style={{ width: 28 }}><input type="checkbox" checked={sel.size === rows.length} onChange={() => setSel(sel.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
            <th>Teil</th><th>Hersteller</th><th>Lieferant</th><th style={{ textAlign: 'right' }}>Menge</th><th style={{ textAlign: 'right' }}>Gesamt</th><th>Liefertermin</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((i) => (
            <tr key={i.id} className="click" onClick={() => setEdit(i)}>
              {canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} /></td>}
              <td>{i.revisionWarning && <span title="Nach der Bestellung in der Konstruktion geändert" style={{ color: 'var(--red)' }}><Icon name="alert" /> </span>}
                <b>{i.designation}</b><div className="small muted mono">{i.number}{i.source === 'cad' && ' · aus CAD'}</div></td>
              <td className="small">{i.manufacturer}<div className="muted">{i.manufacturerNo}</div></td>
              <td className="small">{i.supplierName ?? <span className="muted">–</span>}{i.orderNumber && <div className="muted">{i.orderNumber}</div>}</td>
              <td style={{ textAlign: 'right' }}>{i.qty.toLocaleString('de-DE')} {i.unit}{i.deliveredQty > 0 && i.status !== 'delivered' && <div className="small muted">{i.deliveredQty} da</div>}</td>
              <td style={{ textAlign: 'right' }}>{i.unitPrice != null ? fmtEuro2(i.total) : <span className="muted">–</span>}</td>
              <td className={i.overdue ? 'error-text' : 'small'}>{fmtDate(i.confirmedDelivery ?? i.plannedDelivery)}{i.confirmedDelivery && <div className="small muted">bestätigt</div>}</td>
              <td><Pill tone={PURCHASE_STATUS[i.status]?.tone}>{PURCHASE_STATUS[i.status]?.label}</Pill></td>
              <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                {canEdit && ['ordered', 'confirmed', 'partial'].includes(i.status) && <button className="btn sm" onClick={() => setReceive(i)}>Wareneingang</button>}
                {i.orderId && <a className="btn ghost sm" title="Bestellung als PDF" href={`/api/purchasing/orders/${i.orderId}/pdf`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /></a>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && <ItemModal projectId={project.id} item={edit === 'new' ? null : edit} canEdit={canEdit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
      {receive && <ReceiptModal item={receive} onClose={() => setReceive(null)} onDone={() => { setReceive(null); void reload(); }} />}
      {bulk && <OrderModal ids={[...sel]} items={(data ?? []).filter((i) => sel.has(i.id))} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSel(new Set()); void reload(); }} />}
    </div>
  );
}

function ItemModal({ projectId, item, canEdit, onClose, onSaved }: { projectId: string; item: PurchaseItem | null; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [i, setI] = useState<Partial<PurchaseItem>>(item ?? { designation: '', qty: 1, unit: 'Stk', discount: 0, status: 'open' });
  const [supplier, setSupplier] = useState(item?.supplierId ? { id: item.supplierId, name: item.supplierName ?? '' } : null as { id: string; name: string } | null);
  const [confirm, setConfirm] = useState(false);
  const set = (k: keyof PurchaseItem) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setI({ ...i, [k]: e.target.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value || (k.endsWith('At') || k.endsWith('Delivery') ? null : '') });
  const { data: receipts } = useApi<any[]>(item ? `/purchasing/items/${item.id}/receipts` : null);
  const save = async () => {
    const body = { number: i.number ?? '', designation: i.designation, manufacturer: i.manufacturer ?? '', manufacturerNo: i.manufacturerNo ?? '', supplierId: supplier?.id ?? null,
      supplierOrderNo: i.supplierOrderNo ?? '', qty: Number(i.qty), unit: i.unit, unitPrice: i.unitPrice ?? null, discount: Number(i.discount ?? 0), costCenter: i.costCenter ?? '', note: i.note ?? '',
      status: i.status, requestedAt: i.requestedAt ?? null, orderedAt: i.orderedAt ?? null, plannedDelivery: i.plannedDelivery ?? null, confirmedDelivery: i.confirmedDelivery ?? null };
    if (await act(() => (item ? patch(`/purchasing/items/${item.id}`, body) : post(`/purchasing/projects/${projectId}/items`, body)), 'Gespeichert')) onSaved();
  };
  const total = Number(i.qty ?? 0) * Number(i.unitPrice ?? 0) * (1 - Number(i.discount ?? 0) / 100);
  return (
    <Modal size="lg" title={item ? item.designation : 'Neue Position'} onClose={onClose} footer={<>
      {item?.status === 'open' && canEdit && <button className="btn danger" onClick={() => setConfirm(true)}>Löschen</button>}
      {item?.revisionWarning && canEdit && <button className="btn" onClick={async () => { await act(() => patch(`/purchasing/items/${item.id}`, { revisionWarning: false }), 'Hinweis erledigt'); onSaved(); }}><Icon name="check" /> Änderung mit Lieferant geklärt</button>}
      <span className="grow" /><span className="muted">Gesamt {fmtEuro2(total)}</span>
      <button className="btn" onClick={onClose}>Abbrechen</button>{canEdit && <button className="btn primary" disabled={!i.designation?.trim()} onClick={save}>Speichern</button>}</>}>
      {item?.revisionWarning && <div className="locked-banner" style={{ borderColor: 'var(--red)' }}><Icon name="alert" /> Bestellt mit Versionsstand {String(item.revisionAtOrder ?? 0).padStart(2, '0')}, aktuell {String(item.cadRevision ?? 0).padStart(2, '0')}.</div>}
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
      {receipts?.length ? <div className="small"><b>Wareneingang:</b> {receipts.map((r) => `${fmtDate(r.receivedAt)}: ${r.qty} (${r.userName ?? ''})`).join(' · ')}</div> : null}
      {confirm && item && <Confirm danger text={`„${item.designation}“ löschen?`} onClose={() => setConfirm(false)} onConfirm={async () => { await act(() => del(`/purchasing/items/${item.id}`), 'Gelöscht'); onSaved(); }} />}
    </Modal>
  );
}

function ReceiptModal({ item, onClose, onDone }: { item: PurchaseItem; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [qty, setQty] = useState(item.qty - item.deliveredQty);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  return (
    <Modal title={`Wareneingang: ${item.designation}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={qty <= 0} onClick={async () => { if (await act(() => post(`/purchasing/items/${item.id}/receipts`, { qty, receivedAt: date, note }), 'Wareneingang gebucht')) onDone(); }}>Buchen</button></>}>
      <p className="muted">Bestellt {item.qty} {item.unit}, bisher geliefert {item.deliveredQty}. Die Projektleitung wird benachrichtigt.</p>
      <div className="grid2">
        <Field label="Gelieferte Menge"><input type="number" min={0} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></Field>
        <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Bemerkung" hint="z. B. Lieferschein-Nr."><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
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

/** Einkaufsübersicht über alle Projekte */
export function PurchasingDashboard() {
  const { data: d } = useApi<any>('/purchasing/dashboard');
  const [filter, setFilter] = useState('active');
  const { data: items } = useApi<PurchaseItem[]>(`/purchasing/items?${filter === 'overdue' ? 'overdue=1' : `status=${filter}`}`);
  if (!d) return null;
  return (
    <div>
      <div className="kpi-row">
        <div className="kpi click" onClick={() => setFilter('open')}><div className="v">{d.open}</div><div className="l">offene Positionen</div></div>
        <div className="kpi click" onClick={() => setFilter('requested')}><div className="v">{d.requested}</div><div className="l">angefragt</div></div>
        <div className="kpi click" onClick={() => setFilter('active')}><div className="v">{d.ordered}</div><div className="l">bestellt, noch unterwegs</div></div>
        <div className="kpi click" onClick={() => setFilter('overdue')}><div className="v" style={{ color: d.overdue ? 'var(--red)' : undefined }}>{d.overdue}</div><div className="l">überfällig</div></div>
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
          <div><b>{i.designation}</b> · {i.qty} {i.unit} · {i.supplierName ?? 'ohne Lieferant'} · <Link to={`/projects/${i.projectId}?tab=purchasing`}>{i.projectNumber}</Link></div></div>
      ))}{!d.upcoming.length && <div className="muted small">Keine</div>}</div>
      <h3 style={{ margin: '18px 0 8px' }}>Positionen</h3>
      <div className="toolbar"><select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
        <option value="active">noch nicht geliefert</option><option value="overdue">überfällig</option>{Object.entries(PURCHASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Projekt</th><th>Teil</th><th>Lieferant</th><th style={{ textAlign: 'right' }}>Menge</th><th style={{ textAlign: 'right' }}>Gesamt</th><th>Liefertermin</th><th>Status</th></tr></thead>
        <tbody>{(items ?? []).map((i) => (
          <tr key={i.id}><td><Link to={`/projects/${i.projectId}?tab=purchasing`}>{i.projectNumber}</Link></td><td>{i.revisionWarning && <Icon name="alert" />} {i.designation}</td><td className="small">{i.supplierName ?? '–'}</td>
            <td style={{ textAlign: 'right' }}>{i.qty} {i.unit}</td><td style={{ textAlign: 'right' }}>{i.unitPrice != null ? fmtEuro2(i.total) : '–'}</td>
            <td className={i.overdue ? 'error-text' : ''}>{fmtDate(i.confirmedDelivery ?? i.plannedDelivery)}</td><td><Pill tone={PURCHASE_STATUS[i.status]?.tone}>{PURCHASE_STATUS[i.status]?.label}</Pill></td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
