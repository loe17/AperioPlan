import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, patch, post, put, upload } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { CustomerPicker } from '../modules/CrmShared';
import { InvoicePanel } from '../modules/Invoices';
import { useAdminSettings } from './Settings';

type Tab = 'overview' | 'bills' | 'bank' | 'dunning' | 'vat' | 'export' | 'settings';
const BILL_STATUS: Record<string, [string, string]> = { draft: ['zu erfassen', 'amber'], approval: ['wartet auf Freigabe', 'blue'], approved: ['freigegeben', ''], partial: ['teilweise bezahlt', 'amber'], paid: ['bezahlt', 'green'], rejected: ['abgelehnt', 'red'] };

export default function FinancePage() {
  useCrumbs([{ label: 'Finanzbuchhaltung' }]);
  const { me } = useSession();
  const [tab, setTab] = useTabState<Tab>('finance', 'overview');
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Finanzbuchhaltung</h1><div className="sub">Offene Posten, Eingangsrechnungen, Kontoauszüge, Mahnungen und Übergabe an den Steuerberater</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Übersicht' }, { id: 'bills', label: 'Eingangsrechnungen' }, { id: 'bank', label: 'Bank' },
        { id: 'dunning', label: 'Mahnungen' }, { id: 'vat', label: 'Umsatzsteuer' }, { id: 'export', label: 'Übergabe' }, ...(me?.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])]} />
      {tab === 'overview' && <Overview onTab={setTab} />}
      {tab === 'bills' && <Bills />}
      {tab === 'bank' && <Bank />}
      {tab === 'dunning' && <Dunning />}
      {tab === 'vat' && <Vat />}
      {tab === 'export' && <Export />}
      {tab === 'settings' && <FinanceSettings />}
    </div>
  );
}

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'finance.changed' || e === 'invoices.changed') void reload(); }), [reload]);
}

// ---------------------------------------------------------------- Übersicht
function Overview({ onTab }: { onTab: (t: Tab) => void }) {
  const { data, reload } = useApi<any>('/finance/overview');
  useLive(reload);
  if (!data) return null;
  const max = Math.max(1, ...data.flow.map((w: any) => Math.max(w.incoming, w.outgoing)));
  return (
    <div>
      <div className="kpi-row">
        <div className="kpi click" onClick={() => onTab('dunning')}><div className="v">{fmtEuro2(data.receivables.open)}</div><div className="l">offene Forderungen ({data.receivables.count})</div></div>
        <div className="kpi click" onClick={() => onTab('dunning')}><div className="v" style={{ color: data.receivables.overdue ? 'var(--red)' : undefined }}>{fmtEuro2(data.receivables.overdue)}</div><div className="l">davon überfällig</div></div>
        <div className="kpi click" onClick={() => onTab('bills')}><div className="v">{fmtEuro2(data.payables.open)}</div><div className="l">zu zahlen ({data.payables.count}){data.payables.approval ? ` · ${data.payables.approval} warten auf Freigabe` : ''}</div></div>
        <div className="kpi click" onClick={() => onTab('bills')}><div className="v">{fmtEuro2(data.payables.due7)}</div><div className="l">fällig in 7 Tagen</div></div>
      </div>
      <div className="grid2" style={{ alignItems: 'flex-start' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Bankkonten</h3>
          {!data.banks.length ? <p className="muted small">Noch kein Bankkonto. Im Reiter „Bank“ anlegen und Kontoauszüge einlesen.</p> : data.banks.map((b: any) => (
            <div key={b.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="grow"><b>{b.name}</b><div className="small muted mono">{b.iban}</div></span>
              <span style={{ textAlign: 'right' }}><b>{fmtEuro2(b.balance)}</b><div className="small muted">{b.lastTx ? `Stand ${fmtDate(b.lastTx)}` : 'noch kein Auszug'}{b.openTx ? ` · ${b.openTx} offen` : ''}</div></span>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Vorschau nächste 8 Wochen</h3>
          <div className="fin-flow">{data.flow.map((w: any) => (
            <div key={w.week} title={`Woche ab ${fmtDate(w.week)}: +${fmtEuro2(w.incoming)} / −${fmtEuro2(w.outgoing)}`}>
              <div className="bars"><span className="in" style={{ height: `${(w.incoming / max) * 100}%` }} /><span className="out" style={{ height: `${(w.outgoing / max) * 100}%` }} /></div>
              <span className="small muted">{fmtDate(w.week).slice(0, 6)}</span>
            </div>
          ))}</div>
          <div className="small muted"><span className="dot in" /> erwartete Zahlungseingänge <span className="dot out" style={{ marginLeft: 10 }} /> fällige Rechnungen</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Eingangsrechnungen
function Bills() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [run, setRun] = useState(false);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) });
  const { data, reload } = useApi<any[]>(`/finance/bills?${qs}`);
  useLive(reload);
  const open = params.get('bill');
  const setOpen = (id: string | null) => { if (id) params.set('bill', id); else params.delete('bill'); setParams(params, { replace: true }); };
  const doUpload = async (files: FileList | File[]) => {
    if (!files.length) return;
    const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
    try {
      const r = await upload('/finance/bills/upload', fd) as any[];
      const e = r.filter((x) => x.eInvoice).length;
      toast(`${r.length} Beleg(e) hochgeladen${e ? `, ${e} E-Rechnung(en) automatisch ausgelesen` : ''}`);
      reload(); if (r.length === 1) setOpen(r[0].id);
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const payable = (data ?? []).filter((b) => sel.has(b.id) && ['approved', 'partial'].includes(b.status));
  return (
    <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void doUpload(e.dataTransfer.files); }}>
      <div className="toolbar">
        <input placeholder="Lieferant oder Nummer …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">alle</option><option value="todo">zu bearbeiten</option><option value="approval">wartet auf Freigabe</option><option value="unpaid">offen (freigegeben)</option><option value="paid">bezahlt</option>
        </select>
        {payable.length > 0 && <button className="btn" onClick={() => setRun(true)}><Icon name="send" /> Zahlungslauf ({payable.length})</button>}
        <span className="right row" style={{ gap: 6 }}>
          <button className="btn primary" onClick={() => input.current?.click()}><Icon name="upload" /> Belege hochladen</button>
        </span>
        <input ref={input} type="file" multiple hidden accept=".pdf,.xml,.png,.jpg,.jpeg" onChange={(e) => { void doUpload([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
      <div className={`fin-drop ${over ? 'over' : ''}`}>Rechnungen hierher ziehen – PDF, Foto oder E-Rechnung (XRechnung/ZUGFeRD). E-Rechnungen werden automatisch ausgelesen.</div>
      {data && !data.length && <Empty icon="file-text" title="Keine Eingangsrechnungen" />}
      {data && data.length > 0 && <table className="table"><thead><tr><th style={{ width: 28 }} /><th>Lieferant</th><th>Nr.</th><th>Datum</th><th>Fällig</th><th style={{ textAlign: 'right' }}>Brutto</th><th>Status</th></tr></thead>
        <tbody>{data.map((b) => (
          <tr key={b.id} className="click" onClick={() => setOpen(b.id)}>
            <td onClick={(e) => e.stopPropagation()}>{['approved', 'partial'].includes(b.status) && <input type="checkbox" checked={sel.has(b.id)} onChange={() => { const n = new Set(sel); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); setSel(n); }} />}</td>
            <td><b>{b.supplierName || <span className="muted">unbekannt</span>}</b>{b.eInvoice && <span className="pill small" style={{ marginLeft: 6 }}>E-Rechnung</span>}</td>
            <td className="mono small">{b.number}</td><td>{fmtDate(b.billDate)}</td>
            <td className={b.overdue ? 'text-red' : ''}>{fmtDate(b.dueDate)}</td>
            <td style={{ textAlign: 'right' }}>{fmtEuro2(b.totalGross)}</td>
            <td><Pill tone={BILL_STATUS[b.status]![1]}>{BILL_STATUS[b.status]![0]}</Pill></td>
          </tr>
        ))}</tbody></table>}
      {open && <BillPanel id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {run && <PaymentRun bills={payable} onClose={() => setRun(false)} />}
    </div>
  );
}

function BillPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: b, reload } = useApi<any>(`/finance/bills/${id}`);
  const { data: settings } = useApi<any>('/finance/settings');
  const { me } = useSession();
  const act = useAction();
  const [f, setF] = useState<any>(null);
  const [pay, setPay] = useState(false);
  const [remove, setRemove] = useState(false);
  useEffect(() => { if (b) setF({ supplier: b.supplierId ? { id: b.supplierId, name: b.supplierName } : null, supplierName: b.supplierName, number: b.number, billDate: b.billDate ?? '', dueDate: b.dueDate ?? '',
    iban: b.iban, lines: b.lines.length ? b.lines : [{ text: '', account: settings?.expenseAccounts?.[0]?.account ?? '3400', net: 0, rate: 19 }], notes: b.notes }); }, [b?.id, b?.status, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b || !f) return null;
  const editable = ['draft', 'approval', 'rejected'].includes(b.status);
  const changed = () => { void reload(); onChanged(); };
  const save = async () => act(() => patch(`/finance/bills/${id}`, { supplierId: f.supplier?.id ?? null, supplierName: f.supplier?.name ?? f.supplierName, number: f.number, billDate: f.billDate || null,
    dueDate: f.dueDate || null, iban: f.iban, notes: f.notes, lines: f.lines.map((l: any) => ({ ...l, net: Number(l.net), rate: Number(l.rate) })) }), 'Gespeichert');
  const totals = f.lines.reduce((a: any, l: any) => { const n = Number(l.net) || 0; const t = Math.round(n * Number(l.rate)) / 100; return { net: a.net + n, tax: a.tax + t }; }, { net: 0, tax: 0 });
  const isPdf = /\.pdf$/i.test(b.fileName ?? ''), isImg = /\.(png|jpe?g)$/i.test(b.fileName ?? '');
  const approver = me?.role === 'admin' || settings?.approverIds?.includes(me?.id);
  return (
    <SlideOver wide title={<span>{b.supplierName || 'Eingangsrechnung'} <span className="mono muted">{b.number}</span></span>} onClose={onClose} actions={<>
      {b.hasFile && <a className="btn sm" href={`/api/finance/bills/${id}/file`} target="_blank" rel="noreferrer"><Icon name="file" /> Beleg</a>}
      {b.eInvoice && <a className="btn sm" href={`/api/finance/bills/${id}/file?xml=1`} target="_blank" rel="noreferrer"><Icon name="file-text" /> XML</a>}</>}>
      <div className="fin-bill">
        {b.hasFile && (isPdf || isImg) && <div className="fin-preview">{isPdf ? <iframe src={`/api/finance/bills/${id}/file`} title="Beleg" /> : <img src={`/api/finance/bills/${id}/file`} alt="Beleg" />}</div>}
        <div className="grow">
          <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}><Pill tone={BILL_STATUS[b.status]![1]}>{BILL_STATUS[b.status]![0]}</Pill>{b.eInvoice && <span className="small muted">aus E-Rechnung gelesen</span>}{b.approvedByName && <span className="small muted">{b.status === 'rejected' ? 'abgelehnt' : 'freigegeben'} von {b.approvedByName}</span>}</div>
          <fieldset disabled={!editable} className="plain">
            <Field label="Lieferant"><CustomerPicker kind="supplier" value={f.supplier} onChange={(s) => setF({ ...f, supplier: s })} placeholder={f.supplierName || 'Lieferant suchen …'} /></Field>
            <div className="grid3">
              <Field label="Rechnungsnummer"><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></Field>
              <Field label="Rechnungsdatum"><input type="date" value={f.billDate} onChange={(e) => setF({ ...f, billDate: e.target.value })} /></Field>
              <Field label="Fällig am"><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
            </div>
            <Field label="IBAN des Lieferanten"><input className="mono" value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} /></Field>
            <table className="table small"><thead><tr><th>Konto</th><th>Text</th><th style={{ width: 100 }}>Netto €</th><th style={{ width: 70 }}>USt %</th><th /></tr></thead>
              <tbody>{f.lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td style={{ width: 220 }}><select value={l.account} onChange={(e) => setF({ ...f, lines: f.lines.map((x: any, j: number) => (j === i ? { ...x, account: e.target.value } : x)) })}>
                    {!settings?.expenseAccounts?.some((a: any) => a.account === l.account) && <option value={l.account}>{l.account}</option>}
                    {settings?.expenseAccounts?.map((a: any) => <option key={a.account} value={a.account}>{a.account} {a.label}</option>)}</select></td>
                  <td><input value={l.text} onChange={(e) => setF({ ...f, lines: f.lines.map((x: any, j: number) => (j === i ? { ...x, text: e.target.value } : x)) })} /></td>
                  <td><input type="number" step="0.01" value={l.net} onChange={(e) => setF({ ...f, lines: f.lines.map((x: any, j: number) => (j === i ? { ...x, net: e.target.value } : x)) })} /></td>
                  <td><select value={l.rate} onChange={(e) => setF({ ...f, lines: f.lines.map((x: any, j: number) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })}><option value={19}>19</option><option value={7}>7</option><option value={0}>0</option></select></td>
                  <td>{editable && f.lines.length > 1 && <button className="btn ghost sm" onClick={() => setF({ ...f, lines: f.lines.filter((_: any, j: number) => j !== i) })}><Icon name="x" /></button>}</td>
                </tr>
              ))}</tbody></table>
            {editable && <button className="btn sm" onClick={() => setF({ ...f, lines: [...f.lines, { text: '', account: f.lines[0]?.account ?? '3400', net: 0, rate: 19 }] })}><Icon name="plus" /> Aufteilen</button>}
          </fieldset>
          <div className="inv-totals"><div><span>Netto</span><b>{fmtEuro2(totals.net)}</b></div><div><span>Vorsteuer</span><span>{fmtEuro2(totals.tax)}</span></div><div className="big"><span>Brutto</span><b>{fmtEuro2(totals.net + totals.tax)}</b></div>
            {b.paidAmount !== 0 && <div><span>bezahlt</span><span>{fmtEuro2(b.paidAmount)}</span></div>}</div>
          <Field label="Notizen"><textarea rows={2} disabled={!editable} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          {b.payments.length > 0 && <table className="table small"><tbody>{b.payments.map((p: any) => <tr key={p.id}><td>{fmtDate(p.date)}</td><td>{fmtEuro2(p.amount)}</td><td className="muted">{p.note}</td>
            <td><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/finance/bill-payments/${p.id}`))) changed(); }}><Icon name="x" /></button></td></tr>)}</tbody></table>}
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            {editable && <button className="btn" onClick={async () => { if (await save()) changed(); }}>Speichern</button>}
            {(b.status === 'draft' || b.status === 'rejected') && <button className="btn primary" onClick={async () => { if (await save() && await act(() => post(`/finance/bills/${id}/submit`, {}), 'Eingereicht')) changed(); }}>Prüfen und einreichen</button>}
            {b.status === 'approval' && approver && <>
              <button className="btn primary" onClick={async () => { if (await act(() => post(`/finance/bills/${id}/approve`, { approve: true }), 'Freigegeben')) changed(); }}><Icon name="check" /> Freigeben</button>
              <button className="btn danger" onClick={async () => { const note = window.prompt('Grund der Ablehnung') ?? ''; if (await act(() => post(`/finance/bills/${id}/approve`, { approve: false, note }), 'Abgelehnt')) changed(); }}>Ablehnen</button>
            </>}
            {['approved', 'partial'].includes(b.status) && <button className="btn" onClick={() => setPay(true)}><Icon name="euro" /> Als bezahlt erfassen</button>}
            {['approved', 'approval'].includes(b.status) && b.paidAmount === 0 && <button className="btn ghost" onClick={async () => { if (await act(() => post(`/finance/bills/${id}/reopen`, {}), 'Zurückgenommen')) changed(); }}>Freigabe zurücknehmen</button>}
            {['draft', 'rejected'].includes(b.status) && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
          </div>
        </div>
      </div>
      {pay && <Modal title="Zahlung erfassen" onClose={() => setPay(false)}><PayForm open={b.totalGross - b.paidAmount} onSubmit={async (p) => { if (await act(() => post(`/finance/bills/${id}/payments`, p), 'Gebucht')) { setPay(false); changed(); } }} /></Modal>}
      {remove && <Confirm danger text="Beleg löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/finance/bills/${id}`))) { onChanged(); onClose(); } }} />}
    </SlideOver>
  );
}

function PayForm({ open, onSubmit }: { open: number; onSubmit: (p: { date: string; amount: number; note: string }) => void }) {
  const [p, setP] = useState({ date: isoDate(new Date()), amount: Math.round(open * 100) / 100, note: '' });
  return <div>
    <div className="grid3">
      <Field label="Datum"><input type="date" value={p.date} onChange={(e) => setP({ ...p, date: e.target.value })} /></Field>
      <Field label="Betrag"><input type="number" step="0.01" value={p.amount} onChange={(e) => setP({ ...p, amount: Number(e.target.value) })} /></Field>
      <Field label="Bemerkung"><input value={p.note} onChange={(e) => setP({ ...p, note: e.target.value })} /></Field>
    </div>
    <button className="btn primary" onClick={() => onSubmit(p)}>Buchen</button>
    <p className="hint">Einfacher: Kontoauszug im Reiter „Bank“ einlesen – Zahlungen werden dann automatisch zugeordnet.</p>
  </div>;
}

function PaymentRun({ bills, onClose }: { bills: any[]; onClose: () => void }) {
  const { data: accounts } = useApi<any[]>('/finance/bank-accounts');
  const [acc, setAcc] = useState('');
  const [date, setDate] = useState(isoDate(new Date()));
  const toast = useToast();
  useEffect(() => { if (accounts?.length && !acc) setAcc(accounts[0].id); }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = bills.reduce((s, b) => s + b.totalGross - b.paidAmount, 0);
  return (
    <Modal title="Zahlungslauf" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!acc} onClick={async () => {
        const res = await fetch('/api/finance/payment-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ billIds: bills.map((b) => b.id), bankAccountId: acc, execDate: date }) });
        if (!res.ok) { toast((await res.json()).error, 'error'); return; }
        const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `Zahlungslauf_${date}.xml`; a.click(); onClose();
      }}><Icon name="download" /> SEPA-Datei erzeugen</button></>}>
      <p>{bills.length} Überweisung(en) über <b>{fmtEuro2(sum)}</b>.</p>
      <div className="grid2">
        <Field label="Vom Konto"><select value={acc} onChange={(e) => setAcc(e.target.value)}>{accounts?.map((a) => <option key={a.id} value={a.id}>{a.name} {a.iban}</option>)}</select></Field>
        <Field label="Ausführen am"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <p className="hint">Die Datei (pain.001) im Online-Banking hochladen und dort freigeben. Als bezahlt gelten die Rechnungen, sobald der Kontoauszug eingelesen ist.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- Bank
function Bank() {
  const { data: accounts, reload: reloadAcc } = useApi<any[]>('/finance/bank-accounts');
  const [acc, setAcc] = useState('');
  const [status, setStatus] = useState('open');
  const [edit, setEdit] = useState<any | null>(null);
  const [tx, setTx] = useState<any | null>(null);
  const act = useAction();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (accounts?.length && !acc) setAcc(accounts[0].id); }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, reload } = useApi<any[]>(acc ? `/finance/bank-tx?accountId=${acc}${status ? `&status=${status}` : ''}` : null, [acc, status]);
  useLive(reload);
  const cur = accounts?.find((a) => a.id === acc);
  return (
    <div>
      <div className="toolbar">
        {accounts && accounts.length > 0 && <select value={acc} onChange={(e) => setAcc(e.target.value)} style={{ width: 'auto' }}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
        {cur && <span className="small"><b>{fmtEuro2(cur.balance)}</b> <span className="muted mono">{cur.iban}</span></span>}
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="open">offen</option><option value="">alle</option><option value="matched">zugeordnet</option><option value="booked">gebucht</option><option value="ignored">ignoriert</option></select>
        <span className="right row" style={{ gap: 6 }}>
          {cur && <button className="btn" onClick={() => setEdit(cur)}><Icon name="edit" /></button>}
          <button className="btn" onClick={() => setEdit({ name: '', iban: '', bic: '', datevAccount: '1200', openingBalance: 0, openingDate: isoDate(new Date()) })}><Icon name="plus" /> Konto</button>
          {cur && <button className="btn primary" onClick={() => input.current?.click()}><Icon name="upload" /> Kontoauszug einlesen</button>}
        </span>
        <input ref={input} type="file" hidden accept=".xml,.csv,.txt" onChange={async (e) => {
          const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
          const fd = new FormData(); fd.append('file', file, file.name);
          try { const r = await upload(`/finance/bank-accounts/${acc}/import`, fd) as any; toast(`${r.added} neue Umsätze${r.duplicates ? `, ${r.duplicates} schon vorhanden` : ''}, ${r.matched} automatisch zugeordnet`); reload(); reloadAcc(); }
          catch (err) { toast((err as Error).message, 'error'); }
        }} />
      </div>
      {accounts && !accounts.length && <Empty icon="euro" title="Noch kein Bankkonto">Konto anlegen, dann Kontoauszüge als CAMT-Datei (XML) oder CSV aus dem Online-Banking einlesen. Zahlungen werden den offenen Rechnungen zugeordnet.</Empty>}
      {data && data.length > 0 && <table className="table"><tbody>{data.map((t) => (
        <tr key={t.id} className={t.status === 'open' ? 'click' : ''} onClick={() => t.status === 'open' && setTx(t)}>
          <td style={{ width: 90 }}>{fmtDate(t.date)}</td>
          <td><b>{t.counterparty || '–'}</b><div className="small muted">{t.purpose}</div></td>
          <td style={{ textAlign: 'right', width: 120 }} className={t.amount < 0 ? 'text-red' : 'text-green'}><b>{fmtEuro2(t.amount)}</b></td>
          <td style={{ width: 220 }}>{t.status === 'open' ? <button className="btn sm">Zuordnen …</button>
            : t.status === 'matched' ? <span className="small"><Pill tone="green">{t.matchedType === 'invoice' ? 'Rechnung' : 'Eingangsrechnung'} {t.matchedNumber}</Pill></span>
            : t.status === 'booked' ? <span className="small"><Pill>Konto {t.bookingAccount}</Pill></span> : <span className="small muted">ignoriert</span>}
            {t.status !== 'open' && <button className="btn ghost sm" title="Zuordnung lösen" onClick={async (e) => { e.stopPropagation(); if (await act(() => post(`/finance/bank-tx/${t.id}/unmatch`, {}))) reload(); }}><Icon name="undo" /></button>}</td>
        </tr>
      ))}</tbody></table>}
      {data && !data.length && acc && <p className="muted">Keine Umsätze in dieser Auswahl.</p>}
      {tx && <MatchModal tx={tx} onClose={() => setTx(null)} onDone={() => { setTx(null); reload(); reloadAcc(); }} />}
      {edit && <Modal title={edit.id ? 'Bankkonto bearbeiten' : 'Neues Bankkonto'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
        <button className="btn primary" disabled={!edit.name.trim()} onClick={async () => { const body = { name: edit.name, iban: edit.iban, bic: edit.bic, datevAccount: edit.datevAccount, openingBalance: Number(edit.openingBalance), openingDate: edit.openingDate };
          const r = await act(() => (edit.id ? patch(`/finance/bank-accounts/${edit.id}`, body) : post<{ id: string }>('/finance/bank-accounts', body)), 'Gespeichert'); if (r) { setEdit(null); reloadAcc(); if (!edit.id && (r as any).id) setAcc((r as any).id); } }}>Speichern</button></>}>
        <div className="grid2">
          <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="z. B. Sparkasse Geschäftskonto" /></Field>
          <Field label="IBAN"><input className="mono" value={edit.iban} onChange={(e) => setEdit({ ...edit, iban: e.target.value })} /></Field>
          <Field label="BIC"><input className="mono" value={edit.bic} onChange={(e) => setEdit({ ...edit, bic: e.target.value })} /></Field>
          <Field label="Sachkonto (DATEV)" hint="SKR03: 1200, SKR04: 1800"><input value={edit.datevAccount} onChange={(e) => setEdit({ ...edit, datevAccount: e.target.value })} /></Field>
          <Field label="Anfangsbestand (€)"><input type="number" step="0.01" value={edit.openingBalance} onChange={(e) => setEdit({ ...edit, openingBalance: e.target.value })} /></Field>
          <Field label="am"><input type="date" value={edit.openingDate} onChange={(e) => setEdit({ ...edit, openingDate: e.target.value })} /></Field>
        </div>
      </Modal>}
    </div>
  );
}

const COMMON_BOOKINGS = [['4970', 'Kontoführung, Bankgebühren', ''], ['1360', 'Geldtransit (Umbuchung zwischen eigenen Konten)', ''], ['1800', 'Privatentnahme', ''], ['1890', 'Privateinlage', ''],
  ['4360', 'Versicherung', ''], ['4520', 'Kfz-Versicherung', ''], ['4130', 'Sozialversicherung', ''], ['1740', 'Löhne und Gehälter (Auszahlung)', ''], ['1780', 'Umsatzsteuer-Vorauszahlung', ''], ['4380', 'Beiträge', '']];

function MatchModal({ tx, onClose, onDone }: { tx: any; onClose: () => void; onDone: () => void }) {
  const { data } = useApi<any>(`/finance/bank-tx/${tx.id}/suggestions`);
  const act = useAction();
  const [mode, setMode] = useState<'match' | 'book'>('match');
  const [target, setTarget] = useState('');
  const [book, setBook] = useState({ account: '4970', taxKey: '', note: '' });
  const [inv, setInv] = useState<string | null>(null);
  useEffect(() => { if (data?.suggestions?.[0]) setTarget(data.suggestions[0].id); else if (data && !data.suggestions.length) setMode('book'); }, [data]);
  return (
    <Modal size="lg" title={`${fmtEuro2(tx.amount)} · ${tx.counterparty || 'ohne Namen'}`} onClose={onClose} footer={<><button className="btn ghost" onClick={async () => { if (await act(() => post(`/finance/bank-tx/${tx.id}/ignore`, {}))) onDone(); }}>Ignorieren</button><span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      {mode === 'match' ? <button className="btn primary" disabled={!target} onClick={async () => { if (await act(() => post(`/finance/bank-tx/${tx.id}/match`, { type: data.type, targetId: target }), 'Zugeordnet')) onDone(); }}>Zuordnen</button>
        : <button className="btn primary" disabled={!book.account} onClick={async () => { if (await act(() => post(`/finance/bank-tx/${tx.id}/book`, { account: book.account, taxKey: book.taxKey || null, note: book.note }), 'Gebucht')) onDone(); }}>Buchen</button>}</>}>
      <p className="small muted" style={{ marginTop: 0 }}>{fmtDate(tx.date)} · {tx.purpose}</p>
      <div className="row" style={{ gap: 14, marginBottom: 10 }}>
        <label className="row"><input type="radio" checked={mode === 'match'} onChange={() => setMode('match')} /> {tx.amount > 0 ? 'Zahlung auf eine Rechnung' : 'Bezahlung einer Eingangsrechnung'}</label>
        <label className="row"><input type="radio" checked={mode === 'book'} onChange={() => setMode('book')} /> auf ein Konto buchen (Gebühren, Steuern, Privat …)</label>
      </div>
      {mode === 'match' && data && <>
        {data.suggestions.length > 0 && <div className="fin-sugg">{data.suggestions.map((s: any) => (
          <label key={s.id} className={`card flat row ${target === s.id ? 'on' : ''}`}><input type="radio" checked={target === s.id} onChange={() => setTarget(s.id)} />
            <span className="grow"><b className="mono">{s.number}</b> {s.name}<div className="small muted">{s.reason}</div></span><span>{fmtEuro2(s.open)} offen</span>
            {data.type === 'invoice' && <button className="btn ghost sm" onClick={(e) => { e.preventDefault(); setInv(s.id); }}><Icon name="eye" /></button>}</label>
        ))}</div>}
        <Field label={data.suggestions.length ? 'oder andere offene Rechnung' : 'Offene Rechnung'}><select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">–</option>
          {data.all.map((i: any) => <option key={i.id} value={i.id}>{i.number} · {i.name} · {fmtEuro2(i.open)}</option>)}</select></Field>
      </>}
      {mode === 'book' && <>
        <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>{COMMON_BOOKINGS.map(([a, l]) => <button key={a} className={`btn sm ${book.account === a ? 'primary' : ''}`} onClick={() => setBook({ ...book, account: a! })}>{l}</button>)}</div>
        <div className="grid3">
          <Field label="Gegenkonto"><input value={book.account} onChange={(e) => setBook({ ...book, account: e.target.value })} /></Field>
          <Field label="Steuerschlüssel" hint="9 = 19 % Vorsteuer, 8 = 7 %"><input value={book.taxKey} onChange={(e) => setBook({ ...book, taxKey: e.target.value })} /></Field>
          <Field label="Notiz"><input value={book.note} onChange={(e) => setBook({ ...book, note: e.target.value })} /></Field>
        </div>
        <p className="hint">Kontonummern nach SKR03. Im Zweifel den Steuerberater fragen – die Buchung lässt sich später wieder lösen.</p>
      </>}
      {inv && <InvoicePanel id={inv} onClose={() => setInv(null)} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Mahnungen
function Dunning() {
  const { data, reload } = useApi<any[]>('/finance/dunning');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [inv, setInv] = useState<string | null>(null);
  const act = useAction();
  const toast = useToast();
  useLive(reload);
  useEffect(() => { if (data) setSel(new Set(data.filter((d) => d.ready).map((d) => d.id))); }, [data]);
  const create = async (send: boolean) => {
    const r = await act(() => post<any[]>('/finance/dunning', { invoiceIds: [...sel], send }));
    if (!r) return;
    const errs = r.filter((x) => x.error);
    toast(`${r.filter((x) => x.dunningId).length} Mahnung(en) erstellt${send ? `, ${r.filter((x) => x.sent).length} per E-Mail versendet` : ''}${errs.length ? ` – Hinweise: ${errs.map((e) => e.error).join('; ')}` : ''}`, errs.length ? 'error' : undefined);
    if (!send) for (const x of r) if (x.dunningId) window.open(`/api/finance/dunnings/${x.dunningId}/pdf`, '_blank');
    reload();
  };
  return (
    <div>
      <div className="toolbar">
        <span className="small muted">Überfällige Rechnungen. Fällige Mahnstufen sind vorausgewählt (Abstände und Gebühren unter „Einstellungen“).</span>
        <span className="right row" style={{ gap: 6 }}>
          <button className="btn" disabled={!sel.size} onClick={() => void create(false)}><Icon name="printer" /> Als PDF</button>
          <button className="btn primary" disabled={!sel.size} onClick={() => void create(true)}><Icon name="send" /> Per E-Mail senden ({sel.size})</button>
        </span>
      </div>
      {data && !data.length && <Empty icon="check-circle" title="Keine überfälligen Rechnungen" />}
      {data && data.length > 0 && <table className="table"><thead><tr><th style={{ width: 28 }} /><th>Rechnung</th><th>Kunde</th><th>fällig seit</th><th style={{ textAlign: 'right' }}>offen</th><th>Stufe</th><th>nächste Stufe</th></tr></thead>
        <tbody>{data.map((d) => (
          <tr key={d.id}>
            <td><input type="checkbox" disabled={!d.nextLevel} checked={sel.has(d.id)} onChange={() => { const n = new Set(sel); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); setSel(n); }} /></td>
            <td><button className="link mono" onClick={() => setInv(d.id)}>{d.number}</button></td><td>{d.accountName}{!d.email && <div className="small text-red">keine E-Mail</div>}</td>
            <td>{fmtDate(d.dueDate)} <span className="small muted">({d.daysOverdue} Tage)</span></td>
            <td style={{ textAlign: 'right' }}>{fmtEuro2(d.open)}</td>
            <td>{d.level ? `${d.level}. Stufe am ${fmtDate(d.lastDunning)}` : '–'}</td>
            <td>{d.nextTitle ? <>{d.nextTitle} {d.ready ? <Pill tone="red">jetzt</Pill> : <span className="small muted">ab {fmtDate(d.nextDate)}</span>}</> : <span className="small muted">alle Stufen durch – Inkasso/Anwalt?</span>}</td>
          </tr>
        ))}</tbody></table>}
      {inv && <InvoicePanel id={inv} onClose={() => setInv(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- Umsatzsteuer
function periods() {
  const now = new Date(); const out: { label: string; from: string; to: string }[] = [];
  for (let k = 0; k < 15; k++) { const d = new Date(now.getFullYear(), now.getMonth() - k, 1); out.push({ label: d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }), from: isoDate(d), to: isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }); }
  for (let k = 0; k < 6; k++) { const q = Math.floor(now.getMonth() / 3) - k; const d = new Date(now.getFullYear(), q * 3, 1); out.push({ label: `${Math.floor(d.getMonth() / 3) + 1}. Quartal ${d.getFullYear()}`, from: isoDate(d), to: isoDate(new Date(d.getFullYear(), d.getMonth() + 3, 0)) }); }
  return out;
}
function Vat() {
  const list = useMemo(periods, []);
  const [p, setP] = useState(1);
  const per = list[p]!;
  const { data } = useApi<any>(`/finance/vat?from=${per.from}&to=${per.to}`, [p]);
  return (
    <div style={{ maxWidth: 820 }}>
      <div className="toolbar"><select value={p} onChange={(e) => setP(Number(e.target.value))} style={{ width: 'auto' }}>{list.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}</select>
        {data && <span className="small muted">{data.basis === 'ist' ? 'Ist-Versteuerung (nach Zahlungseingang)' : 'Soll-Versteuerung (nach Rechnungsdatum)'}</span>}</div>
      {data && <>
        <table className="table"><thead><tr><th style={{ width: 60 }}>Kz.</th><th>Bezeichnung</th><th style={{ textAlign: 'right' }}>Betrag</th></tr></thead>
          <tbody>{data.kz.map((k: any) => <tr key={k.kz}><td className="mono">{k.kz}</td><td>{k.label}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(k.value)}</td></tr>)}</tbody></table>
        <div className="inv-totals" style={{ marginLeft: 0 }}>
          <div><span>Umsatzsteuer</span><span>{fmtEuro2(data.outputTax)}</span></div>
          <div><span>abzüglich Vorsteuer</span><span>−{fmtEuro2(data.inputTax)}</span></div>
          <div className="big"><span>{data.payable >= 0 ? 'Zahllast' : 'Erstattung'}</span><b>{fmtEuro2(Math.abs(data.payable))}</b></div>
        </div>
        <p className="hint">Hilfe für die Umsatzsteuer-Voranmeldung aus den Rechnungen in AperioPlan. Die Meldung ans Finanzamt (ELSTER) macht der Steuerberater bzw. die Buchhaltungssoftware – dort können weitere Buchungen dazukommen.</p>
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- Übergabe
function Export() {
  const list = useMemo(periods, []);
  const [p, setP] = useState(1);
  const per = list[p]!;
  return (
    <div style={{ maxWidth: 760 }}>
      <h3>Übergabe an den Steuerberater</h3>
      <p className="muted">Ein ZIP mit drei DATEV-Buchungsstapeln (Ausgangsrechnungen, Eingangsrechnungen, Bank) und allen Belegen des Zeitraums. Die Stapel lassen sich in DATEV Kanzlei-Rechnungswesen und den meisten Buchhaltungsprogrammen einlesen.</p>
      <div className="row" style={{ gap: 8 }}>
        <select value={p} onChange={(e) => setP(Number(e.target.value))} style={{ width: 'auto' }}>{list.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}</select>
        <a className="btn primary" href={`/api/finance/datev.zip?from=${per.from}&to=${per.to}`}><Icon name="download" /> DATEV-Paket herunterladen</a>
        <a className="btn" href="/api/finance/open-items.xlsx"><Icon name="file-excel" /> Offene Posten (Excel)</a>
      </div>
      <p className="hint">Berater- und Mandantennummer sowie Erlöskonten stehen unter Einstellungen → Rechnungen. Debitoren erhalten Kontonummern ab 10000, Kreditoren ab 70000.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Einstellungen
function FinanceSettings() {
  const s = useAdminSettings('finance');
  const { users } = useSession();
  const act = useAction();
  if (!s.value) return null;
  const v = s.value;
  return (
    <div style={{ maxWidth: 860 }}>
      <h3>Freigabe von Eingangsrechnungen</h3>
      <div className="grid2">
        <Field label="Freigabe nötig ab (€ brutto)"><input type="number" min={0} value={v.approvalLimit} onChange={(e) => s.setValue({ ...v, approvalLimit: Number(e.target.value) })} /></Field>
        <Field label="Versteuerung"><select value={v.taxBasis} onChange={(e) => s.setValue({ ...v, taxBasis: e.target.value })}><option value="soll">Soll (nach Rechnungsdatum)</option><option value="ist">Ist (nach Zahlungseingang)</option></select></Field>
      </div>
      <Field label="Freigabeberechtigte" hint="leer = Administratoren"><UserPicker users={users} value={v.approverIds} onChange={(ids) => s.setValue({ ...v, approverIds: ids })} /></Field>
      <h3 style={{ marginTop: 18 }}>Mahnstufen</h3>
      {v.dunning.map((d: any, i: number) => (
        <div key={i} className="card flat" style={{ marginBottom: 8 }}>
          <div className="grid3">
            <Field label="Bezeichnung"><input value={d.title} onChange={(e) => s.setValue({ ...v, dunning: v.dunning.map((x: any, j: number) => (j === i ? { ...x, title: e.target.value } : x)) })} /></Field>
            <Field label={i === 0 ? 'Tage nach Fälligkeit' : 'Tage nach voriger Stufe'}><input type="number" min={1} value={d.days} onChange={(e) => s.setValue({ ...v, dunning: v.dunning.map((x: any, j: number) => (j === i ? { ...x, days: Number(e.target.value) } : x)) })} /></Field>
            <Field label="Gebühr (€)"><input type="number" min={0} step="0.5" value={d.fee} onChange={(e) => s.setValue({ ...v, dunning: v.dunning.map((x: any, j: number) => (j === i ? { ...x, fee: Number(e.target.value) } : x)) })} /></Field>
          </div>
          <Field label="Text"><textarea rows={2} value={d.text} onChange={(e) => s.setValue({ ...v, dunning: v.dunning.map((x: any, j: number) => (j === i ? { ...x, text: e.target.value } : x)) })} /></Field>
          <button className="btn ghost sm danger" onClick={() => s.setValue({ ...v, dunning: v.dunning.filter((_: any, j: number) => j !== i) })}>Stufe entfernen</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => s.setValue({ ...v, dunning: [...v.dunning, { days: 14, fee: 0, title: `${v.dunning.length}. Mahnung`, text: '' }] })}><Icon name="plus" /> Stufe</button>
      <h3 style={{ marginTop: 18 }}>Aufwandskonten für Eingangsrechnungen</h3>
      <table className="table small"><tbody>{v.expenseAccounts.map((a: any, i: number) => (
        <tr key={i}><td style={{ width: 90 }}><input value={a.account} onChange={(e) => s.setValue({ ...v, expenseAccounts: v.expenseAccounts.map((x: any, j: number) => (j === i ? { ...x, account: e.target.value } : x)) })} /></td>
          <td><input value={a.label} onChange={(e) => s.setValue({ ...v, expenseAccounts: v.expenseAccounts.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} /></td>
          <td style={{ width: 80 }}><select value={a.rate} onChange={(e) => s.setValue({ ...v, expenseAccounts: v.expenseAccounts.map((x: any, j: number) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })}><option value={19}>19 %</option><option value={7}>7 %</option><option value={0}>0 %</option></select></td>
          <td style={{ width: 40 }}><button className="btn ghost sm" onClick={() => s.setValue({ ...v, expenseAccounts: v.expenseAccounts.filter((_: any, j: number) => j !== i) })}><Icon name="x" /></button></td></tr>
      ))}</tbody></table>
      <button className="btn sm" onClick={() => s.setValue({ ...v, expenseAccounts: [...v.expenseAccounts, { account: '', label: '', rate: 19 }] })}><Icon name="plus" /> Konto</button>
      <div style={{ marginTop: 16 }}><button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button></div>
      <p className="hint">Voreinstellung nach SKR03. Bei SKR04 bitte die Kontonummern anpassen (z. B. Wareneingang 5400).</p>
    </div>
  );
}

void put; void get;
