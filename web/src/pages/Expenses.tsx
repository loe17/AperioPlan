import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EXPENSE_CATEGORIES, EXPENSE_KINDS } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { fmtDate, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { ProjectSelect, uploadForm } from '../modules/Pickers';
import { useAdminSettings } from './Settings';
import { UserPicker } from '../components/UserPicker';
import { useSession } from '../session';

type Tab = 'mine' | 'approve' | 'all' | 'settings';
const STATUS: Record<string, [string, string]> = { draft: ['Entwurf', ''], submitted: ['eingereicht', 'blue'], approved: ['freigegeben', 'green'], rejected: ['abgelehnt', 'red'], paid: ['ausgezahlt', 'green'] };
const localInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'expenses.changed') void reload(); }), [reload]);
}

export default function ExpensesPage() {
  useCrumbs([{ label: 'Spesen und Reisekosten' }]);
  const { me } = useSession();
  const [tab, setTab] = useTabState<Tab>('expenses', 'mine');
  const [params, setParams] = useSearchParams();
  const [create, setCreate] = useState(false);
  const { data: approve } = useApi<any[]>('/expenses/reports?scope=approve');
  const { data: all } = useApi<any[]>(me?.role === 'admin' ? '/expenses/reports?scope=all&status=approved' : null);
  const open = params.get('report');
  const setOpen = (id: string | null) => { if (id) params.set('report', id); else params.delete('report'); setParams(params, { replace: true }); };
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Spesen und Reisekosten</h1><div className="sub">Reisen und Auslagen abrechnen</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Abrechnung</button></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'mine', label: 'Meine Abrechnungen' }, { id: 'approve', label: `Zur Freigabe${approve?.length ? ` (${approve.length})` : ''}` },
        { id: 'all', label: `Buchhaltung${all?.length ? ` (${all.length})` : ''}` }, ...(me?.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])]} />
      {tab === 'settings' ? <ExpSettings /> : <ReportList scope={tab} onOpen={setOpen} />}
      {create && <NewReport onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); setOpen(id); }} />}
      {open && <ReportPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ReportList({ scope, onOpen }: { scope: Tab; onOpen: (id: string) => void }) {
  const { data, reload, error } = useApi<any[]>(`/expenses/reports?scope=${scope}`, [scope]);
  const [range, setRange] = useState({ from: isoDate(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)), to: isoDate(new Date()) });
  useLive(reload);
  if (error) return <Empty icon="lock" title="Kein Zugriff">Diese Ansicht ist für die Buchhaltung (Einstellungen → Spesen).</Empty>;
  return (
    <div>
      {scope === 'all' && <div className="toolbar"><span className="small">Freigegebene Abrechnungen</span>
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 150 }} />–<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 150 }} />
        <a className="btn" href={`/api/expenses/export.xlsx?from=${range.from}&to=${range.to}`}><Icon name="file-excel" /> Excel</a></div>}
      {data && !data.length && <Empty icon="receipt" title={scope === 'approve' ? 'Nichts zur Freigabe' : 'Keine Abrechnungen'}>{scope === 'mine' ? 'Für jede Reise eine Abrechnung anlegen: Zeiten eintragen, Belege fotografieren, einreichen.' : undefined}</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Reise</th>{scope !== 'mine' && <th>Mitarbeiter</th>}<th>Zeitraum</th><th style={{ textAlign: 'right' }}>Erstattung</th><th>Status</th></tr></thead>
        <tbody>{data.map((r) => (
          <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
            <td className="mono small">{r.number}</td><td><b>{r.title}</b>{r.destination && <div className="small muted">{r.destination}</div>}</td>
            {scope !== 'mine' && <td>{r.userName}</td>}<td>{r.startAt ? `${fmtDate(r.startAt)}${r.endAt && fmtDate(r.endAt) !== fmtDate(r.startAt) ? ` – ${fmtDate(r.endAt)}` : ''}` : '–'}</td>
            <td style={{ textAlign: 'right' }}><b>{fmtEuro2(r.total)}</b></td><td><Pill tone={STATUS[r.status]![1]}>{STATUS[r.status]![0]}</Pill></td>
          </tr>
        ))}</tbody></table>}
    </div>
  );
}

function NewReport({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const act = useAction();
  const [f, setF] = useState({ title: '', destination: '', purpose: '', start: '', end: '', country: 'DE', projectId: null as string | null });
  return (
    <Modal title="Neue Abrechnung" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => {
        const r = await act(() => post<{ id: string }>('/expenses/reports', { title: f.title, destination: f.destination, purpose: f.purpose, country: f.country, projectId: f.projectId,
          startAt: f.start ? new Date(f.start).toISOString() : null, endAt: f.end ? new Date(f.end).toISOString() : null }));
        if (r) onDone(r.id);
      }}>Anlegen</button></>}>
      <Field label="Anlass"><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Kundenbesuch Stuttgart, Messe, Material holen" /></Field>
      <div className="grid2">
        <Field label="Reiseziel"><input value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} /></Field>
        <Field label="Land"><select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}><option value="DE">Deutschland</option><option value="XX">Ausland (Pauschalen als Beleg eintragen)</option></select></Field>
        <Field label="Abfahrt"><input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="Rückkehr"><input type="datetime-local" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
      </div>
      <Field label="Projekt"><ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} /></Field>
      <p className="hint">Ohne Reise (nur Auslagen) die Zeiten leer lassen.</p>
    </Modal>
  );
}

function ReportPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: r, reload } = useApi<any>(`/expenses/reports/${id}`, [id]);
  const act = useAction();
  const toast = useToast();
  const [meta, setMeta] = useState<any>(null);
  const [item, setItem] = useState(false);
  const [remove, setRemove] = useState(false);
  const [reject, setReject] = useState(false);
  const [note, setNote] = useState('');
  useLive(reload);
  useEffect(() => { if (r) setMeta({ title: r.title, destination: r.destination, purpose: r.purpose, start: localInput(r.startAt), end: localInput(r.endAt), meals: r.meals }); }, [r?.id, r?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r || !meta) return null;
  const editable = ['draft', 'rejected'].includes(r.status);
  const saveMeta = async (m = meta) => { if (await act(() => patch(`/expenses/reports/${id}`, { title: m.title, destination: m.destination, purpose: m.purpose, startAt: m.start ? new Date(m.start).toISOString() : null, endAt: m.end ? new Date(m.end).toISOString() : null, meals: m.meals }))) void reload(); };
  const toggleMeal = (date: string, k: 'breakfast' | 'lunch' | 'dinner') => { const m = { ...meta, meals: { ...meta.meals, [date]: { ...(meta.meals[date] ?? {}), [k]: !meta.meals[date]?.[k] } } }; setMeta(m); void saveMeta(m); };
  return (
    <SlideOver wide title={<span>{r.title} <span className="mono muted">{r.number}</span></span>} onClose={onClose} actions={<a className="btn sm" href={`/api/expenses/reports/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="printer" /> PDF</a>}>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <Pill tone={STATUS[r.status]![1]}>{STATUS[r.status]![0]}</Pill><span className="small">{r.userName}</span>
        {r.decisionNote && <span className="small text-red">{r.decisionNote}</span>}
        <span className="grow" /><b>{fmtEuro2(r.total)}</b>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {editable && <button className="btn primary" onClick={async () => { if (await act(() => post(`/expenses/reports/${id}/submit`, {}), 'Eingereicht')) void reload(); }}><Icon name="send" /> Einreichen</button>}
        {r.canDecide && <><button className="btn primary" onClick={async () => { if (await act(() => post(`/expenses/reports/${id}/decide`, { approve: true }), 'Freigegeben')) void reload(); }}><Icon name="check" /> Freigeben</button>
          <button className="btn danger" onClick={() => setReject(true)}>Ablehnen</button></>}
        {r.isManager && r.status === 'approved' && <button className="btn" onClick={async () => { if (await act(() => post(`/expenses/reports/${id}/paid`, {}), 'Als ausgezahlt markiert')) void reload(); }}><Icon name="euro" /> Ausgezahlt</button>}
        {editable && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      </div>
      <fieldset className="plain" disabled={!editable}>
        <div className="grid2">
          <Field label="Anlass"><input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} onBlur={() => void saveMeta()} /></Field>
          <Field label="Reiseziel"><input value={meta.destination} onChange={(e) => setMeta({ ...meta, destination: e.target.value })} onBlur={() => void saveMeta()} /></Field>
          <Field label="Abfahrt"><input type="datetime-local" value={meta.start} onChange={(e) => setMeta({ ...meta, start: e.target.value })} onBlur={() => void saveMeta()} /></Field>
          <Field label="Rückkehr"><input type="datetime-local" value={meta.end} onChange={(e) => setMeta({ ...meta, end: e.target.value })} onBlur={() => void saveMeta()} /></Field>
        </div>
      </fieldset>
      {r.perDiem.days.length > 0 && <>
        <h3 style={{ margin: '10px 0 4px' }}>Verpflegungspauschale <span className="small muted">{fmtEuro2(r.perDiem.total)}</span></h3>
        <table className="table small"><thead><tr><th>Tag</th><th>Pauschale</th><th>Frühstück</th><th>Mittag</th><th>Abend</th><th style={{ textAlign: 'right' }}>Betrag</th></tr></thead>
          <tbody>{r.perDiem.days.map((d: any) => (
            <tr key={d.date}><td>{new Date(`${d.date}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</td><td>{d.base ? fmtEuro2(d.base) : 'unter 8 Std.'}</td>
              {(['breakfast', 'lunch', 'dinner'] as const).map((k) => <td key={k}><input type="checkbox" disabled={!editable || !d.base} title="gestellt (z. B. im Hotel oder vom Kunden)" checked={Boolean(meta.meals[d.date]?.[k])} onChange={() => toggleMeal(d.date, k)} /></td>)}
              <td style={{ textAlign: 'right' }}>{fmtEuro2(d.amount)}</td></tr>
          ))}</tbody></table>
        <p className="hint">Häkchen setzen, wenn eine Mahlzeit gestellt wurde (Hotelfrühstück, Bewirtung durch den Kunden) – dann wird die Pauschale gekürzt.</p>
      </>}
      <div className="row" style={{ margin: '10px 0 4px' }}><h3 className="grow" style={{ margin: 0 }}>Auslagen</h3>{editable && <button className="btn sm primary" onClick={() => setItem(true)}><Icon name="camera" /> Beleg / Kilometer</button>}</div>
      {!r.items.length ? <p className="muted small">Noch keine.</p> : <table className="table small"><tbody>{r.items.map((i: any) => (
        <tr key={i.id}><td>{fmtDate(i.date)}</td><td>{EXPENSE_KINDS[i.kind]}{i.category ? ` · ${i.category}` : ''}<div className="muted">{i.description}</div></td>
          <td>{i.kind === 'mileage' ? `${i.km} km × ${fmtEuro2(r.kmRate)}` : fmtEuro2(i.amount)}{i.paidBy === 'company' && <div className="muted">Firma bezahlt</div>}</td>
          <td style={{ textAlign: 'right' }}><b>{fmtEuro2(i.refund)}</b></td>
          <td>{i.hasReceipt && <a href={`/api/expenses/items/${i.id}/receipt`} target="_blank" rel="noreferrer"><Icon name="paperclip" /></a>}</td>
          <td>{editable && <button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/expenses/items/${i.id}`))) void reload(); }}><Icon name="x" /></button>}</td></tr>
      ))}</tbody></table>}
      {item && <ItemModal reportId={id} onClose={() => setItem(false)} onDone={() => { setItem(false); void reload(); toast('Hinzugefügt'); }} />}
      {remove && <Confirm danger text="Abrechnung löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/expenses/reports/${id}`))) onClose(); }} />}
      {reject && <Modal title="Ablehnen" onClose={() => setReject(false)} footer={<><button className="btn" onClick={() => setReject(false)}>Abbrechen</button>
        <button className="btn danger" disabled={!note.trim()} onClick={async () => { if (await act(() => post(`/expenses/reports/${id}/decide`, { approve: false, note }), 'Abgelehnt')) { setReject(false); void reload(); } }}>Ablehnen</button></>}>
        <Field label="Begründung"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field></Modal>}
    </SlideOver>
  );
}

function ItemModal({ reportId, onClose, onDone }: { reportId: string; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ date: isoDate(new Date()), kind: 'receipt', category: '', description: '', amount: '', vatRate: '19', km: '', paidBy: 'self' });
  const [file, setFile] = useState<File | null>(null);
  const cam = useRef<HTMLInputElement>(null);
  const mileage = f.kind === 'mileage';
  return (
    <Modal title="Auslage hinzufügen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={mileage ? !f.km : !f.amount} onClick={async () => {
        const fields: Record<string, string> = { date: f.date, kind: f.kind, category: f.category, description: f.description, amount: mileage ? '0' : f.amount.replace(',', '.'), vatRate: f.vatRate, paidBy: f.paidBy, ...(mileage ? { km: f.km } : {}) };
        if (await act(() => uploadForm(`/expenses/reports/${reportId}/items`, fields, file))) onDone();
      }}>Hinzufügen</button></>}>
      <div className="grid2">
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(EXPENSE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Datum"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        {mileage ? <Field label="Kilometer"><input type="number" min={1} value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} /></Field>
          : <><Field label="Betrag brutto (€)"><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Kategorie"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">–</option>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="USt.-Satz"><select value={f.vatRate} onChange={(e) => setF({ ...f, vatRate: e.target.value })}><option value="19">19 %</option><option value="7">7 %</option><option value="0">0 %</option></select></Field>
            <Field label="Bezahlt"><select value={f.paidBy} onChange={(e) => setF({ ...f, paidBy: e.target.value })}><option value="self">von mir (erstatten)</option><option value="company">mit Firmenkarte</option></select></Field></>}
      </div>
      <Field label={mileage ? 'Strecke' : 'Beschreibung'}><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={mileage ? 'z. B. Furtwangen – Stuttgart und zurück' : ''} /></Field>
      {!mileage && <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => cam.current?.click()}><Icon name="camera" /> {file ? file.name : 'Beleg fotografieren oder auswählen'}</button>
        <input ref={cam} type="file" hidden accept="image/*,.pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>}
    </Modal>
  );
}

function ExpSettings() {
  const s = useAdminSettings('expenses');
  const { users } = useSession();
  const act = useAction();
  if (!s.value) return null;
  const v = s.value;
  return (
    <div style={{ maxWidth: 760 }}>
      <Field label="Buchhaltung" hint="sieht alle freigegebenen Abrechnungen und meldet Auszahlungen"><UserPicker users={users} value={v.managerIds} onChange={(ids) => s.setValue({ ...v, managerIds: ids })} /></Field>
      <Field label="Freigabe durch" hint="leer = Teamleiter des Mitarbeiters, sonst Administratoren"><UserPicker users={users} value={v.approverIds} onChange={(ids) => s.setValue({ ...v, approverIds: ids })} /></Field>
      <Field label="Kilometergeld (€/km)" hint="steuerfrei bis 0,30 € (Pkw)"><input type="number" step="0.01" value={v.kmRate} onChange={(e) => s.setValue({ ...v, kmRate: Number(e.target.value) })} /></Field>
      <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
    </div>
  );
}
