import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { E_INVOICE_FORMAT, INVOICE_KIND, INVOICE_STATUS, invoiceTotals, positionNet, TAX_MODES, type InvoicePosition, type TaxMode } from '@aperio/shared';
import { ApiError, api, del, get, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { fmtDate, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker, useContacts } from './CrmShared';

const STATUS_TONE: Record<string, string> = { draft: '', open: 'blue', partial: 'amber', paid: 'green', cancelled: '' };
export const invoiceStatus = (i: { status: string; overdue?: boolean; dunningLevel?: number }) =>
  i.overdue ? <Pill tone="red">überfällig{i.dunningLevel ? ` · ${i.dunningLevel}. Mahnung` : ''}</Pill> : <Pill tone={STATUS_TONE[i.status]}>{INVOICE_STATUS[i.status]}</Pill>;

export function InvoiceTable({ rows, onOpen, hideAccount }: { rows: any[]; onOpen: (id: string) => void; hideAccount?: boolean }) {
  return (
    <table className="table"><thead><tr><th>Nr.</th><th>Datum</th>{!hideAccount && <th>Kunde</th>}<th>Betreff</th><th style={{ textAlign: 'right' }}>Brutto</th><th style={{ textAlign: 'right' }}>offen</th><th>Fällig</th><th>Status</th></tr></thead>
      <tbody>{rows.map((i) => (
        <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
          <td className="mono">{i.number ?? <span className="muted">Entwurf</span>}</td><td>{fmtDate(i.invoiceDate)}</td>
          {!hideAccount && <td>{i.accountName}</td>}
          <td>{i.kind !== 'invoice' && <span className="small muted">{INVOICE_KIND[i.kind as 'partial']} · </span>}{i.title}</td>
          <td style={{ textAlign: 'right' }}>{i.status === 'draft' ? '' : fmtEuro2(i.totalGross)}</td>
          <td style={{ textAlign: 'right' }}>{['open', 'partial'].includes(i.status) ? fmtEuro2(i.totalGross - i.prepaid - i.paidAmount) : ''}</td>
          <td>{i.kind !== 'credit' ? fmtDate(i.dueDate) : ''}</td>
          <td>{invoiceStatus(i)}{i.sentAt && <Icon name="send" size={12} style={{ marginLeft: 4, opacity: .6 }} title="versendet" />}</td>
        </tr>
      ))}</tbody></table>
  );
}

/** Rechnungsliste – für CRM, Kunde oder Projekt */
export function InvoiceList({ accountId, projectId }: { accountId?: string; projectId?: string }) {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [exp, setExp] = useState(false);
  const qs = new URLSearchParams({ ...(accountId ? { accountId } : {}), ...(projectId ? { projectId } : {}), ...(status === 'overdue' ? { overdue: '1' } : status ? { status } : {}) });
  const { data, reload } = useApi<any[]>(`/crm/invoices?${qs}`);
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'invoices.changed') void reload(); }), [reload]);
  const unpaid = (data ?? []).filter((i) => ['open', 'partial'].includes(i.status)).reduce((s, i) => s + i.totalGross - i.prepaid - i.paidAmount, 0);
  return (
    <div>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">alle Rechnungen</option><option value="draft">Entwürfe</option><option value="unpaid">offen</option><option value="overdue">überfällig</option><option value="paid">bezahlt</option><option value="cancelled">storniert</option>
        </select>
        <span className="small muted">{data?.length ?? 0} Rechnungen · offen {fmtEuro2(unpaid)}</span>
        <span className="right row" style={{ gap: 6 }}>
          {!accountId && !projectId && <button className="btn" onClick={() => setExp(true)}><Icon name="download" /> An Buchhaltung</button>}
          <button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Rechnung</button>
        </span>
      </div>
      {data && !data.length && <Empty icon="file-text" title="Keine Rechnungen">Rechnungen entstehen aus einem Angebot (Knopf „Rechnung“ im Angebot), aus den Stunden eines Projekts oder frei.</Empty>}
      {data && data.length > 0 && <InvoiceTable rows={data} onOpen={setOpen} hideAccount={Boolean(accountId)} />}
      {open && <InvoicePanel id={open} onClose={() => setOpen(null)} onChanged={reload} onOpen={setOpen} />}
      {create && <NewInvoice accountId={accountId} projectId={projectId} onClose={() => setCreate(false)} onCreated={(id) => { setCreate(false); reload(); setOpen(id); }} />}
      {exp && <ExportModal onClose={() => setExp(false)} />}
    </div>
  );
}

function NewInvoice({ accountId, projectId, onClose, onCreated }: { accountId?: string; projectId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const act = useAction();
  const [mode, setMode] = useState<'free' | 'project'>(projectId ? 'project' : 'free');
  const [account, setAccount] = useState<{ id: string; name: string } | null>(accountId ? { id: accountId, name: '' } : null);
  const { data: projects } = useApi<any[]>(mode === 'project' && !projectId ? '/projects' : null);
  const today = new Date();
  const [p, setP] = useState({ projectId: projectId ?? '', from: isoDate(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: isoDate(new Date(today.getFullYear(), today.getMonth(), 0)), rate: 85, material: true });
  return (
    <Modal title="Neue Rechnung" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={mode === 'free' ? !account : !p.projectId} onClick={async () => {
        const r = mode === 'free'
          ? await act(() => post<{ id: string }>('/crm/invoices', { accountId: account!.id, projectId: projectId ?? null, positions: [{ text: '', qty: 1, unit: 'Stk', price: 0 }] }))
          : await act(() => post<{ id: string }>(`/crm/invoices/from-project/${p.projectId}`, { from: p.from, to: p.to, hourlyRate: Number(p.rate), material: p.material, ...(account ? { accountId: account.id } : {}) }));
        if (r) onCreated(r.id);
      }}>Entwurf anlegen</button></>}>
      <div className="row" style={{ gap: 14, marginBottom: 10 }}>
        <label className="row"><input type="radio" checked={mode === 'free'} onChange={() => setMode('free')} /> frei</label>
        <label className="row"><input type="radio" checked={mode === 'project'} onChange={() => setMode('project')} /> nach Aufwand aus einem Projekt</label>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>Aus einem Angebot entsteht die Rechnung am einfachsten im Angebot selbst (Knopf „Rechnung“, „Abschlag“ oder „Schlussrechnung“).</p>
      {(mode === 'free' || !accountId) && !accountId && <Field label={mode === 'project' ? 'Kunde (leer = Kunde des Projekts)' : 'Kunde'} required={mode === 'free'}><CustomerPicker value={account} onChange={setAccount} /></Field>}
      {mode === 'project' && <>
        {!projectId && <Field label="Projekt"><select value={p.projectId} onChange={(e) => setP({ ...p, projectId: e.target.value })}><option value="">–</option>{projects?.map((x) => <option key={x.id} value={x.id}>{x.number} {x.name}</option>)}</select></Field>}
        <div className="grid3">
          <Field label="Von"><input type="date" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></Field>
          <Field label="Bis"><input type="date" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></Field>
          <Field label="Stundensatz (€)"><input type="number" min={0} value={p.rate} onChange={(e) => setP({ ...p, rate: Number(e.target.value) })} /></Field>
        </div>
        <label className="row"><input type="checkbox" checked={p.material} onChange={(e) => setP({ ...p, material: e.target.checked })} /> Material aus dem Lager übernehmen</label>
        <p className="hint">Die Stunden kommen aus der Zeiterfassung, gruppiert nach Aufgabe. Alles lässt sich im Entwurf noch ändern.</p>
      </>}
    </Modal>
  );
}

function ExportModal({ onClose }: { onClose: () => void }) {
  const act = useAction();
  const toast = useToast();
  const now = new Date();
  const [from, setFrom] = useState(isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
  const [to, setTo] = useState(isoDate(new Date(now.getFullYear(), now.getMonth(), 0)));
  return (
    <Modal title="Übergabe an die Buchhaltung" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Schließen</button>
      <a className="btn" href={`/api/crm/invoices/export.zip?from=${from}&to=${to}`}><Icon name="download" /> ZIP herunterladen</a>
      <button className="btn primary" onClick={async () => { const r = await act(() => post<{ count: number }>('/crm/invoices/send-accounting', { from, to })); if (r) { toast(`${r.count} Rechnungen an die Buchhaltung gesendet`); onClose(); } }}><Icon name="send" /> Per E-Mail senden</button></>}>
      <div className="grid2">
        <Field label="Von"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Bis"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <p className="small muted">Das Paket enthält alle festgeschriebenen Rechnungen des Zeitraums als PDF und E-Rechnung, den DATEV-Buchungsstapel (Import beim Steuerberater) und das Rechnungsausgangsbuch als Excel. Empfänger und Konten stehen unter Einstellungen → Rechnungen.</p>
    </Modal>
  );
}

/** Rechnung ansehen; Entwürfe bearbeiten */
export function InvoicePanel({ id, onClose, onChanged, onOpen }: { id: string; onClose: () => void; onChanged?: () => void; onOpen?: (id: string) => void }) {
  const { data: inv, reload } = useApi<any>(`/crm/invoices/${id}`);
  const act = useAction();
  const [send, setSend] = useState(false);
  const [pay, setPay] = useState(false);
  const [confirm, setConfirm] = useState<'' | 'finalize' | 'cancel' | 'delete'>('');
  const [problems, setProblems] = useState<string[]>([]);
  const changed = () => { void reload(); onChanged?.(); };
  if (!inv) return null;
  const draft = inv.status === 'draft';
  const due = inv.totalGross - inv.prepaid - inv.paidAmount;
  return (
    <SlideOver wide title={<span>{INVOICE_KIND[inv.kind as 'invoice']} <b className="mono">{inv.number ?? 'Entwurf'}</b> · {inv.accountName}</span>} onClose={onClose} actions={<>
      <a className="btn sm" href={`/api/crm/invoices/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /> {draft ? 'Vorschau' : 'PDF'}</a>
      {inv.hasXml && <a className="btn sm" href={`/api/crm/invoices/${id}/xml`}><Icon name="file-text" /> XML</a>}
    </>}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        {invoiceStatus(inv)}
        <span className="small muted">{E_INVOICE_FORMAT[inv.format as 'zugferd']}</span>
        {inv.projectId && <Link className="small" to={`/projects/${inv.projectId}`}>Projekt {inv.projectNumber}</Link>}
        {inv.quoteNumber && <span className="small muted">aus Angebot {inv.quoteNumber}</span>}
        {inv.cancelledBy && <button className="link small" onClick={() => onOpen?.(inv.cancelledBy.id)}>storniert durch {inv.cancelledBy.number}</button>}
        {inv.exportedAt && <span className="small muted">an Buchhaltung übergeben {fmtDate(inv.exportedAt)}</span>}
      </div>
      {problems.length > 0 && <div className="locked-banner" style={{ borderColor: 'var(--red)', alignItems: 'flex-start' }}><Icon name="alert" /><div className="grow"><b>Noch nicht vollständig:</b><ul style={{ margin: '4px 0 0 18px' }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div></div>}
      {draft ? <DraftEditor inv={inv} onSaved={changed} /> : <FinalView inv={inv} />}
      {!draft && inv.kind !== 'credit' && <>
        <h3 style={{ margin: '18px 0 6px' }}>Zahlungen</h3>
        {!inv.payments.length ? <p className="small muted">Noch keine Zahlung.</p> : <table className="table small"><tbody>{inv.payments.map((p: any) => (
          <tr key={p.id}><td>{fmtDate(p.date)}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(p.amount)}</td><td>{{ transfer: 'Überweisung', cash: 'bar', card: 'Karte', debit: 'Lastschrift', offset: 'Verrechnung' }[p.method as string]}</td><td className="muted">{p.note}</td><td className="muted">{p.userName}</td>
            <td><button className="btn sm ghost" onClick={async () => { if (await act(() => del(`/crm/invoices/payments/${p.id}`), 'Zahlung ausgebucht')) changed(); }}><Icon name="x" /></button></td></tr>
        ))}</tbody></table>}
      </>}
      <div className="row wrap" style={{ gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        {draft && <>
          <button className="btn primary" onClick={() => setConfirm('finalize')}><Icon name="lock" /> Festschreiben</button>
          <button className="btn ghost danger" onClick={() => setConfirm('delete')}><Icon name="trash" /> Entwurf löschen</button>
        </>}
        {!draft && inv.status !== 'cancelled' && <>
          <button className="btn primary" onClick={() => setSend(true)}><Icon name="send" /> Per E-Mail senden</button>
          {inv.kind !== 'credit' && ['open', 'partial'].includes(inv.status) && <button className="btn" onClick={() => setPay(true)}><Icon name="euro" /> Zahlung erfassen ({fmtEuro2(due)} offen)</button>}
          {inv.kind !== 'credit' && inv.paidAmount === 0 && <button className="btn ghost danger" onClick={() => setConfirm('cancel')}>Stornieren</button>}
        </>}
      </div>
      {send && <SendModal id={id} onClose={() => setSend(false)} onSent={() => { setSend(false); changed(); }} />}
      {pay && <PaymentModal id={id} open={due} onClose={() => setPay(false)} onDone={() => { setPay(false); changed(); }} />}
      {confirm === 'finalize' && <Confirm text="Rechnung festschreiben? Sie erhält ihre Nummer, PDF und E-Rechnung werden erzeugt und danach nicht mehr verändert. Korrekturen gehen dann nur noch per Storno." onClose={() => setConfirm('')}
        onConfirm={async () => {
          try { await api(`/crm/invoices/${id}/finalize`, { method: 'POST', body: {}, quiet: true }); setProblems([]); changed(); }
          catch (e) { const d = (e as ApiError & { details?: { problems?: string[] } }).details; setProblems(d?.problems ?? [(e as Error).message]); }
        }} />}
      {confirm === 'cancel' && <CancelModal id={id} onClose={() => setConfirm('')} onDone={(cid) => { setConfirm(''); changed(); onOpen?.(cid); }} />}
      {confirm === 'delete' && <Confirm danger text="Entwurf löschen?" onClose={() => setConfirm('')} onConfirm={async () => { if (await act(() => del(`/crm/invoices/${id}`), 'Gelöscht')) { onChanged?.(); onClose(); } }} />}
    </SlideOver>
  );
}

function FinalView({ inv }: { inv: any }) {
  const t = inv.preview;
  return (
    <div>
      <table className="table small"><tbody>
        <tr><td className="muted" style={{ width: 170 }}>Rechnungsdatum</td><td>{fmtDate(inv.invoiceDate)}</td></tr>
        <tr><td className="muted">Leistung</td><td>{inv.serviceFrom && inv.serviceTo && inv.serviceFrom !== inv.serviceTo ? `${fmtDate(inv.serviceFrom)} – ${fmtDate(inv.serviceTo)}` : fmtDate(inv.serviceTo ?? inv.serviceFrom ?? inv.invoiceDate)}</td></tr>
        {inv.kind !== 'credit' && <tr><td className="muted">Fällig</td><td>{fmtDate(inv.dueDate)}</td></tr>}
        {inv.sentAt && <tr><td className="muted">Versendet</td><td>{fmtDate(inv.sentAt)} an {inv.sentTo}</td></tr>}
        <tr><td className="muted">Steuer</td><td>{TAX_MODES[inv.taxMode as TaxMode].label}</td></tr>
      </tbody></table>
      <PositionsTable positions={inv.positions} vatRate={inv.vatRate} />
      <Totals t={t} partials={inv.partials} />
    </div>
  );
}

function PositionsTable({ positions, vatRate }: { positions: InvoicePosition[]; vatRate: number }) {
  return (
    <table className="table small" style={{ marginTop: 10 }}><thead><tr><th>Pos.</th><th>Bezeichnung</th><th style={{ textAlign: 'right' }}>Menge</th><th style={{ textAlign: 'right' }}>Preis</th><th style={{ textAlign: 'right' }}>USt</th><th style={{ textAlign: 'right' }}>Netto</th></tr></thead>
      <tbody>{positions.map((p, i) => (
        <tr key={i}><td>{i + 1}</td><td>{p.text}{p.description && <div className="muted">{p.description}</div>}</td><td style={{ textAlign: 'right' }}>{p.qty.toLocaleString('de-DE')} {p.unit}</td>
          <td style={{ textAlign: 'right' }}>{fmtEuro2(p.price)}{p.discount ? ` −${p.discount} %` : ''}</td><td style={{ textAlign: 'right' }}>{p.vatRate ?? vatRate} %</td><td style={{ textAlign: 'right' }}>{fmtEuro2(positionNet(p))}</td></tr>
      ))}</tbody></table>
  );
}

function Totals({ t, partials }: { t: { net: number; tax: number; gross: number; groups: { rate: number; basis: number; tax: number }[] }; partials: any[] }) {
  const prepaid = partials.reduce((s, p) => s + p.totalGross, 0);
  return (
    <div className="inv-totals">
      <div><span>Summe netto</span><b>{fmtEuro2(t.net)}</b></div>
      {t.groups.map((g) => <div key={g.rate}><span>{g.rate} % USt auf {fmtEuro2(g.basis)}</span><span>{fmtEuro2(g.tax)}</span></div>)}
      <div className="big"><span>Gesamt</span><b>{fmtEuro2(t.gross)}</b></div>
      {partials.map((p) => <div key={p.id}><span>abzgl. Abschlag {p.number}</span><span>−{fmtEuro2(p.totalGross)}</span></div>)}
      {prepaid > 0 && <div className="big"><span>Noch zu zahlen</span><b>{fmtEuro2(t.gross - prepaid)}</b></div>}
    </div>
  );
}

function DraftEditor({ inv, onSaved }: { inv: any; onSaved: () => void }) {
  const act = useAction();
  const contacts = useContacts(inv.accountId);
  const [d, setD] = useState({ title: inv.title, invoiceDate: inv.invoiceDate ?? '', serviceFrom: inv.serviceFrom ?? '', serviceTo: inv.serviceTo ?? '', dueDate: inv.dueDate ?? '',
    buyerReference: inv.buyerReference, orderReference: inv.orderReference, contactId: inv.contactId ?? '', intro: inv.intro, outro: inv.outro,
    vatRate: inv.vatRate, taxMode: inv.taxMode as TaxMode, format: inv.format, positions: inv.positions as InvoicePosition[] });
  const [dirty, setDirty] = useState(false);
  const up = (x: Partial<typeof d>) => { setD({ ...d, ...x }); setDirty(true); };
  const setPos = (i: number, p: Partial<InvoicePosition>) => up({ positions: d.positions.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const t = invoiceTotals(d.positions, Number(d.vatRate), d.taxMode);
  const save = async () => {
    const body = { ...d, invoiceDate: d.invoiceDate || null, serviceFrom: d.serviceFrom || null, serviceTo: d.serviceTo || null, dueDate: d.dueDate || null, contactId: d.contactId || null,
      vatRate: Number(d.vatRate), positions: d.positions.filter((p) => p.text.trim() || p.price) };
    if (await act(() => patch(`/crm/invoices/${inv.id}`, body), 'Gespeichert')) { setDirty(false); onSaved(); }
  };
  // ungespeicherte Änderungen vor dem Festschreiben sichern
  useEffect(() => { if (!dirty) return; const h = setTimeout(() => void save(), 1500); return () => clearTimeout(h); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="grid3">
        <Field label="Betreff"><input value={d.title} onChange={(e) => up({ title: e.target.value })} /></Field>
        <Field label="Rechnungsdatum" hint="leer = Tag des Festschreibens"><input type="date" value={d.invoiceDate} onChange={(e) => up({ invoiceDate: e.target.value })} /></Field>
        <Field label="Fällig am" hint="leer = laut Zahlungsziel"><input type="date" value={d.dueDate} onChange={(e) => up({ dueDate: e.target.value })} /></Field>
        <Field label="Leistung von"><input type="date" value={d.serviceFrom} onChange={(e) => up({ serviceFrom: e.target.value })} /></Field>
        <Field label="Leistung bis" hint="leer = Rechnungsdatum"><input type="date" value={d.serviceTo} onChange={(e) => up({ serviceTo: e.target.value })} /></Field>
        <Field label="Ansprechpartner"><select value={d.contactId} onChange={(e) => up({ contactId: e.target.value })}><option value="">–</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>)}</select></Field>
        <Field label="Format"><select value={d.format} onChange={(e) => up({ format: e.target.value })}>{Object.entries(E_INVOICE_FORMAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Steuer"><select value={d.taxMode} onChange={(e) => up({ taxMode: e.target.value as TaxMode })}>{Object.entries(TAX_MODES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        {d.taxMode === 'standard' && <Field label="USt-Satz (%)"><select value={d.vatRate} onChange={(e) => up({ vatRate: Number(e.target.value) })}><option value={19}>19</option><option value={7}>7</option></select></Field>}
        <Field label={d.format === 'xrechnung' ? 'Leitweg-ID / Käuferreferenz' : 'Käuferreferenz'} hint={d.format === 'xrechnung' ? 'Pflicht bei XRechnung' : 'optional'}><input value={d.buyerReference} onChange={(e) => up({ buyerReference: e.target.value })} /></Field>
        <Field label="Bestellnummer des Kunden"><input value={d.orderReference} onChange={(e) => up({ orderReference: e.target.value })} /></Field>
      </div>
      <Field label="Einleitung"><textarea rows={2} value={d.intro} onChange={(e) => up({ intro: e.target.value })} /></Field>
      <div className="table-wrap"><table className="table pos-table">
        <thead><tr><th style={{ width: 28 }}>Pos.</th><th>Bezeichnung</th><th style={{ width: 80 }}>Menge</th><th style={{ width: 66 }}>Einheit</th><th style={{ width: 96 }}>Einzelpreis €</th><th style={{ width: 62 }}>Rabatt %</th>
          {d.taxMode === 'standard' && <th style={{ width: 64 }}>USt %</th>}<th style={{ width: 96, textAlign: 'right' }}>Netto</th><th style={{ width: 60 }} /></tr></thead>
        <tbody>{d.positions.map((p, i) => (
          <tr key={i}>
            <td className="muted">{i + 1}</td>
            <td><input value={p.text} onChange={(e) => setPos(i, { text: e.target.value })} placeholder="Leistung oder Artikel" />
              <textarea rows={1} value={p.description ?? ''} onChange={(e) => setPos(i, { description: e.target.value || undefined })} placeholder="Beschreibung (optional)" style={{ marginTop: 4, fontSize: 12 }} /></td>
            <td><input type="number" step="any" value={p.qty} onChange={(e) => setPos(i, { qty: Number(e.target.value) })} /></td>
            <td><input value={p.unit} onChange={(e) => setPos(i, { unit: e.target.value })} /></td>
            <td><input type="number" step="0.01" value={p.price} onChange={(e) => setPos(i, { price: Number(e.target.value) })} /></td>
            <td><input type="number" min={0} max={100} value={p.discount ?? 0} onChange={(e) => setPos(i, { discount: Number(e.target.value) || undefined })} /></td>
            {d.taxMode === 'standard' && <td><select value={p.vatRate ?? d.vatRate} onChange={(e) => setPos(i, { vatRate: Number(e.target.value) === Number(d.vatRate) ? undefined : Number(e.target.value) })}><option value={19}>19</option><option value={7}>7</option></select></td>}
            <td style={{ textAlign: 'right' }}>{fmtEuro2(positionNet(p))}</td>
            <td><button className="btn ghost sm" onClick={() => up({ positions: d.positions.filter((_, j) => j !== i) })} title="Entfernen"><Icon name="x" /></button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button className="btn sm" style={{ margin: '8px 0' }} onClick={() => up({ positions: [...d.positions, { text: '', qty: 1, unit: 'Stk', price: 0 }] })}><Icon name="plus" /> Position</button>
      <Totals t={t} partials={inv.partials} />
      <Field label="Schlusstext"><textarea rows={2} value={d.outro} onChange={(e) => up({ outro: e.target.value })} /></Field>
      <div className="row"><span className="small muted grow">{dirty ? 'Änderungen werden gespeichert …' : 'Entwurf gespeichert'}</span><button className="btn sm" disabled={!dirty} onClick={() => void save()}>Jetzt speichern</button></div>
    </div>
  );
}

function SendModal({ id, onClose, onSent }: { id: string; onClose: () => void; onSent: () => void }) {
  const act = useAction();
  const [m, setM] = useState<{ to: string; cc: string; subject: string; text: string; attachments: string[] } | null>(null);
  useEffect(() => { get<any>(`/crm/invoices/${id}/mail`).then((r) => setM({ ...r, cc: '' })).catch(() => setM({ to: '', cc: '', subject: '', text: '', attachments: [] })); }, [id]);
  if (!m) return null;
  return (
    <Modal size="lg" title="Rechnung per E-Mail senden" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!m.to.includes('@')} onClick={async () => { if (await act(() => post(`/crm/invoices/${id}/send`, { to: m.to, cc: m.cc || undefined, subject: m.subject, text: m.text }), 'Gesendet')) onSent(); }}><Icon name="send" /> Senden</button></>}>
      <div className="grid2">
        <Field label="An" hint="Rechnungs-E-Mail aus dem CRM"><input value={m.to} onChange={(e) => setM({ ...m, to: e.target.value })} /></Field>
        <Field label="Kopie an"><input value={m.cc} onChange={(e) => setM({ ...m, cc: e.target.value })} /></Field>
      </div>
      <Field label="Betreff"><input value={m.subject} onChange={(e) => setM({ ...m, subject: e.target.value })} /></Field>
      <Field label="Text"><textarea rows={8} value={m.text} onChange={(e) => setM({ ...m, text: e.target.value })} /></Field>
      <div className="small muted"><Icon name="paperclip" /> {m.attachments.join(', ')}</div>
    </Modal>
  );
}

function PaymentModal({ id, open, onClose, onDone }: { id: string; open: number; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [p, setP] = useState({ date: isoDate(new Date()), amount: Math.round(open * 100) / 100, method: 'transfer', note: '' });
  return (
    <Modal title="Zahlung erfassen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!p.amount} onClick={async () => { if (await act(() => post(`/crm/invoices/${id}/payments`, { ...p, amount: Number(p.amount) }), 'Zahlung gebucht')) onDone(); }}>Buchen</button></>}>
      <div className="grid2">
        <Field label="Datum"><input type="date" value={p.date} onChange={(e) => setP({ ...p, date: e.target.value })} /></Field>
        <Field label="Betrag (€)"><input type="number" step="0.01" value={p.amount} onChange={(e) => setP({ ...p, amount: Number(e.target.value) })} /></Field>
        <Field label="Art"><select value={p.method} onChange={(e) => setP({ ...p, method: e.target.value })}><option value="transfer">Überweisung</option><option value="debit">Lastschrift</option><option value="cash">bar</option><option value="card">Karte</option><option value="offset">Verrechnung</option></select></Field>
        <Field label="Bemerkung" hint="z. B. Skonto abgezogen"><input value={p.note} onChange={(e) => setP({ ...p, note: e.target.value })} /></Field>
      </div>
      <p className="hint">Mit Kontoauszügen geht es schneller: In der Finanzbuchhaltung werden Zahlungseingänge automatisch den Rechnungen zugeordnet.</p>
    </Modal>
  );
}

function CancelModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (creditId: string) => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  return (
    <Modal title="Rechnung stornieren" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn danger" onClick={async () => { const r = await act(() => post<{ id: string; number: string }>(`/crm/invoices/${id}/cancel`, { reason }), 'Storniert'); if (r) onDone(r.id); }}>Stornorechnung erstellen</button></>}>
      <p>Es entsteht eine Stornorechnung mit eigener Nummer über denselben Betrag. Sie hebt die Rechnung auf und sollte dem Kunden ebenfalls geschickt werden.</p>
      <Field label="Grund (optional)"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z. B. falsche Anschrift" /></Field>
    </Modal>
  );
}

/** Knöpfe im Angebot: Rechnung, Abschlag, Schlussrechnung */
export function QuoteInvoiceButtons({ quoteId, onCreated }: { quoteId: string; onCreated: (id: string) => void }) {
  const act = useAction();
  const [partial, setPartial] = useState<number | null>(null);
  const make = async (kind: string, percent?: number) => { const r = await act(() => post<{ id: string }>(`/crm/quotes/${quoteId}/invoice`, { kind, ...(percent ? { percent } : {}) }), 'Rechnungsentwurf angelegt'); if (r) onCreated(r.id); };
  return <>
    <button className="btn" onClick={() => void make('invoice')}><Icon name="file-text" /> Rechnung</button>
    <button className="btn" onClick={() => setPartial(30)}>Abschlag …</button>
    <button className="btn" onClick={() => void make('final')} title="Gesamtleistung abzüglich aller Abschläge">Schlussrechnung</button>
    {partial !== null && <Modal title="Abschlagsrechnung" onClose={() => setPartial(null)} footer={<><button className="btn" onClick={() => setPartial(null)}>Abbrechen</button><button className="btn primary" onClick={() => { void make('partial', partial); setPartial(null); }}>Anlegen</button></>}>
      <Field label="Anteil vom Angebotswert (%)"><input type="number" min={1} max={100} value={partial} onChange={(e) => setPartial(Number(e.target.value))} /></Field>
    </Modal>}
  </>;
}
