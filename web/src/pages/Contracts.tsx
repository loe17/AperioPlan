import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCan, useSession } from '../session';
import { fmtDate, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, UserSelect, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker } from '../modules/CrmShared';
import { InvoicePanel } from '../modules/Invoices';
import { NewJob, SVC_STATUS } from './Service';

const STATUS: Record<string, [string, string]> = { draft: ['Entwurf', ''], active: ['aktiv', 'green'], paused: ['pausiert', 'amber'], cancelled: ['gekündigt', 'red'], ended: ['beendet', ''] };
const KIND: Record<string, string> = { maintenance: 'Wartungsvertrag', service: 'Servicevertrag', rental: 'Miete', license: 'Lizenz / Software', other: 'Sonstiges' };
const INTERVAL: Record<number, string> = { 1: 'monatlich', 3: 'vierteljährlich', 6: 'halbjährlich', 12: 'jährlich' };
const AUTO: Record<string, string> = { off: 'nicht automatisch', draft: 'Entwurf zum Prüfen', send: 'festschreiben und per E-Mail senden' };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'contracts.changed' || e === 'invoices.changed') void reload(); }), [reload]);
}

export default function ContractsPage() {
  useCrumbs([{ label: 'Verträge' }]);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const { data, reload } = useApi<any[]>(`/contracts?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`);
  const { data: ov, reload: reloadOv } = useApi<any>('/contracts/overview');
  useLive(() => { void reload(); void reloadOv(); });
  const open = params.get('contract');
  const setOpen = (id: string | null) => { if (id) params.set('contract', id); else params.delete('contract'); setParams(params, { replace: true }); };
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Wartungs- und Serviceverträge</h1><div className="sub">Wiederkehrende Leistungen mit automatischer Rechnung</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setEdit({})}><Icon name="plus" /> Vertrag</button></div></div>
      {ov && <div className="kpi-row">
        <div className="kpi"><div className="v">{ov.active}</div><div className="l">aktive Verträge</div></div>
        <div className="kpi"><div className="v">{fmtEuro2(ov.mrr)}</div><div className="l">wiederkehrend je Monat (netto)</div></div>
        <div className="kpi"><div className="v">{fmtEuro2(ov.arr)}</div><div className="l">je Jahr</div></div>
        <div className="kpi"><div className="v">{ov.dueInvoices}</div><div className="l">Rechnungen in 30 Tagen</div></div>
      </div>}
      {ov?.notices.length > 0 && <div className="card" style={{ marginBottom: 14 }}><b>Kündigungsfristen in den nächsten drei Monaten</b>
        {ov.notices.map((n: any) => <div key={n.id} className="row small click" style={{ gap: 8, padding: '3px 0' }} onClick={() => setOpen(n.id)}>
          <span className="mono">{n.number}</span><span className="grow">{n.title} – {n.accountName}</span><span>kündbar bis <b>{fmtDate(n.deadline)}</b> zum {fmtDate(n.end)}</span></div>)}</div>}
      <div className="toolbar">
        <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">alle</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      {data && !data.length && <Empty icon="contract" title="Keine Verträge">Ein Vertrag hat Positionen und ein Intervall. AperioPlan erstellt die Rechnungen zum Termin und erinnert an Kündigungsfristen.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Vertrag</th><th>Kunde</th><th>Abrechnung</th><th style={{ textAlign: 'right' }}>je Abrechnung</th><th>Nächste Rechnung</th><th>Status</th></tr></thead>
        <tbody>{data.map((c) => (
          <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
            <td className="mono small">{c.number}</td><td><b>{c.title}</b><div className="small muted">{KIND[c.kind]}</div></td><td>{c.accountName}</td>
            <td>{INTERVAL[c.intervalMonths]}{c.billing === 'arrears' ? ' (nachträglich)' : ''}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(c.netPerInterval)}</td>
            <td>{c.status === 'active' && c.auto !== 'off' ? fmtDate(c.nextInvoiceDate) : '–'}</td><td><Pill tone={STATUS[c.status]![1]}>{STATUS[c.status]![0]}</Pill></td>
          </tr>
        ))}</tbody></table>}
      {edit && <ContractModal contract={edit} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); void reload(); void reloadOv(); if (id) setOpen(id); }} />}
      {open && <ContractPanel id={open} onClose={() => setOpen(null)} onEdit={(c) => setEdit(c)} />}
    </div>
  );
}

function ContractModal({ contract, onClose, onSaved }: { contract: any; onClose: () => void; onSaved: (id?: string) => void }) {
  const { users } = useSession();
  const act = useAction();
  const [f, setF] = useState<any>(() => contract.id ? { ...contract, account: { id: contract.accountId, name: contract.accountName }, endDate: contract.endDate ?? '' }
    : { account: null, title: '', kind: 'maintenance', startDate: isoDate(new Date()), endDate: '', intervalMonths: 12, billing: 'advance', positions: [{ text: 'Wartungspauschale', description: '', qty: 1, unit: 'psch', price: 0 }],
      auto: 'draft', noticeMonths: 3, renewMonths: 12, ownerId: null, visitsPerYear: 1, slaHours: null, notes: '', status: 'active' });
  const total = f.positions.reduce((s: number, p: any) => s + Number(p.qty) * Number(p.price), 0);
  return (
    <Modal size="lg" title={contract.id ? `Vertrag ${contract.number}` : 'Neuer Vertrag'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.account || !f.title.trim()} onClick={async () => {
        const b = { accountId: f.account.id, title: f.title, kind: f.kind, startDate: f.startDate, endDate: f.endDate || null, intervalMonths: Number(f.intervalMonths), billing: f.billing,
          positions: f.positions.map((p: any) => ({ ...p, qty: Number(p.qty), price: Number(p.price) })), auto: f.auto, noticeMonths: Number(f.noticeMonths), renewMonths: Number(f.renewMonths),
          ownerId: f.ownerId, visitsPerYear: Number(f.visitsPerYear), slaHours: f.slaHours === '' || f.slaHours === null ? null : Number(f.slaHours), notes: f.notes, status: f.status,
          ...(contract.id && f.nextInvoiceDate ? { nextInvoiceDate: f.nextInvoiceDate } : {}) };
        const r = await act(() => (contract.id ? patch(`/contracts/${contract.id}`, b) : post<{ id: string }>('/contracts', b)), 'Gespeichert');
        if (r) onSaved(contract.id ? undefined : (r as any).id);
      }}>Speichern</button></>}>
      <Field label="Kunde"><CustomerPicker value={f.account} onChange={(a) => setF({ ...f, account: a })} /></Field>
      <div className="grid2">
        <Field label="Bezeichnung"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Wartungsvertrag Kompressoren" /></Field>
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
      <div className="grid3">
        <Field label="Beginn"><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Erstes Laufzeitende" hint="leer = unbefristet"><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Verlängerung (Monate)" hint="0 = endet automatisch"><input type="number" min={0} value={f.renewMonths} onChange={(e) => setF({ ...f, renewMonths: e.target.value })} /></Field>
        <Field label="Kündigungsfrist (Monate)"><input type="number" min={0} value={f.noticeMonths} onChange={(e) => setF({ ...f, noticeMonths: e.target.value })} /></Field>
        <Field label="Abrechnung"><select value={f.intervalMonths} onChange={(e) => setF({ ...f, intervalMonths: Number(e.target.value) })}>{Object.entries(INTERVAL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Zeitpunkt"><select value={f.billing} onChange={(e) => setF({ ...f, billing: e.target.value })}><option value="advance">im Voraus</option><option value="arrears">nachträglich</option></select></Field>
        <Field label="Rechnungen"><select value={f.auto} onChange={(e) => setF({ ...f, auto: e.target.value })}>{Object.entries(AUTO).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {contract.id && <Field label="Nächste Rechnung"><input type="date" value={f.nextInvoiceDate ?? ''} onChange={(e) => setF({ ...f, nextInvoiceDate: e.target.value })} /></Field>}
        <Field label="Verantwortlich"><UserSelect users={users} value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} placeholder="– ich –" /></Field>
        <Field label="Wartungsbesuche je Jahr"><input type="number" min={0} value={f.visitsPerYear} onChange={(e) => setF({ ...f, visitsPerYear: e.target.value })} /></Field>
        <Field label="Reaktionszeit (Std.)"><input type="number" min={0} value={f.slaHours ?? ''} onChange={(e) => setF({ ...f, slaHours: e.target.value })} /></Field>
      </div>
      <h3 style={{ margin: '8px 0 4px' }}>Positionen je Abrechnung <span className="small muted">{fmtEuro2(total)} netto</span></h3>
      <table className="table small"><tbody>{f.positions.map((p: any, i: number) => (
        <tr key={i}>
          <td><input value={p.text} onChange={(e) => setF({ ...f, positions: f.positions.map((x: any, k: number) => (k === i ? { ...x, text: e.target.value } : x)) })} /></td>
          <td style={{ width: 80 }}><input type="number" value={p.qty} onChange={(e) => setF({ ...f, positions: f.positions.map((x: any, k: number) => (k === i ? { ...x, qty: e.target.value } : x)) })} /></td>
          <td style={{ width: 70 }}><input value={p.unit} onChange={(e) => setF({ ...f, positions: f.positions.map((x: any, k: number) => (k === i ? { ...x, unit: e.target.value } : x)) })} /></td>
          <td style={{ width: 110 }}><input type="number" step="0.01" value={p.price} onChange={(e) => setF({ ...f, positions: f.positions.map((x: any, k: number) => (k === i ? { ...x, price: e.target.value } : x)) })} /></td>
          <td style={{ width: 40 }}><button className="btn ghost sm" onClick={() => setF({ ...f, positions: f.positions.filter((_: any, k: number) => k !== i) })}><Icon name="x" /></button></td>
        </tr>
      ))}</tbody></table>
      <button className="btn sm" onClick={() => setF({ ...f, positions: [...f.positions, { text: '', description: '', qty: 1, unit: 'psch', price: 0 }] })}><Icon name="plus" /> Position</button>
      <Field label="Notizen"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      {contract.id && <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
    </Modal>
  );
}

function ContractPanel({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (c: any) => void }) {
  const { data: c, reload } = useApi<any>(`/contracts/${id}`, [id]);
  const can = useCan();
  const act = useAction();
  const [inv, setInv] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const [remove, setRemove] = useState(false);
  const [job, setJob] = useState(false);
  useLive(reload);
  if (!c) return null;
  return (
    <SlideOver wide title={<span>{c.title} <span className="mono muted">{c.number}</span></span>} onClose={onClose} actions={<button className="btn sm" onClick={() => onEdit(c)}><Icon name="edit" /> Bearbeiten</button>}>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <Pill tone={STATUS[c.status]![1]}>{STATUS[c.status]![0]}</Pill><span className="small"><b>{c.accountName}</b> · {KIND[c.kind]}</span>
        <span className="small muted">seit {fmtDate(c.startDate)}{c.cancelledTo ? ` · gekündigt zum ${fmtDate(c.cancelledTo)}` : c.notice ? ` · läuft bis ${fmtDate(c.notice.end)}, kündbar bis ${fmtDate(c.notice.deadline)}` : ' · unbefristet'}</span>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {c.status === 'active' && <button className="btn" onClick={async () => { const r = await act(() => post<{ invoiceId: string }>(`/contracts/${id}/invoice`, {}), 'Rechnungsentwurf erstellt'); if (r) { void reload(); setInv(r.invoiceId); } }}><Icon name="euro" /> Nächste Rechnung jetzt</button>}
        {can('service') && <button className="btn" onClick={() => setJob(true)}><Icon name="tools" /> Wartungsbesuch planen</button>}
        {c.status === 'active' && <button className="btn ghost" onClick={() => setCancel(true)}>Kündigen</button>}
        {!c.invoices.length && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      </div>
      <div className="kpi-row">
        <div className="kpi"><div className="v">{fmtEuro2(c.netPerInterval)}</div><div className="l">{INTERVAL[c.intervalMonths]} netto</div></div>
        <div className="kpi"><div className="v">{fmtEuro2(c.mrr * 12)}</div><div className="l">je Jahr</div></div>
        <div className="kpi"><div className="v">{c.status === 'active' && c.auto !== 'off' ? fmtDate(c.nextInvoiceDate) : '–'}</div><div className="l">nächste Rechnung ({AUTO[c.auto]})</div></div>
      </div>
      <table className="table small"><tbody>{c.positions.map((p: any, i: number) => <tr key={i}><td>{p.text}</td><td style={{ textAlign: 'right' }}>{p.qty} {p.unit}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(p.price)}</td></tr>)}</tbody></table>
      {c.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</p>}
      <h3 style={{ margin: '12px 0 4px' }}>Rechnungen</h3>
      {!c.invoices.length ? <p className="muted small">Noch keine.</p> : <table className="table small"><tbody>{c.invoices.map((i: any) => (
        <tr key={i.periodFrom} className="click" onClick={() => i.id && setInv(i.id)}><td>{fmtDate(i.periodFrom)} – {fmtDate(i.periodTo)}</td><td className="mono">{i.number ?? 'Entwurf'}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(i.totalGross)}</td><td>{i.status}</td></tr>
      ))}</tbody></table>}
      {c.jobs.length > 0 && <><h3 style={{ margin: '12px 0 4px' }}>Service-Einsätze</h3>
        <table className="table small"><tbody>{c.jobs.map((j: any) => <tr key={j.id} className="click" onClick={() => window.open(`/service?job=${j.id}`, '_self')}><td>{fmtDate(j.startAt)}</td><td>{j.number} {j.title}</td><td>{SVC_STATUS[j.status]?.[0]}</td></tr>)}</tbody></table></>}
      {inv && <InvoicePanel id={inv} onClose={() => setInv(null)} />}
      {cancel && <Confirm danger confirmLabel="Kündigen" text={`Vertrag zum ${c.notice ? fmtDate(c.notice.end) : 'nächstmöglichen Termin'} kündigen? Bis dahin laufen die Rechnungen weiter.`} onClose={() => setCancel(false)}
        onConfirm={async () => { if (await act(() => post(`/contracts/${id}/cancel`, {}), 'Gekündigt')) void reload(); }} />}
      {remove && <Confirm danger text="Vertrag löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/contracts/${id}`))) onClose(); }} />}
      {job && <NewJob onClose={() => setJob(false)} onDone={() => { setJob(false); void reload(); }} initial={{ account: { id: c.accountId, name: c.accountName }, title: `Wartung ${c.title}`, contractId: id }} />}
    </SlideOver>
  );
}
