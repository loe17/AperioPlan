import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDateTime, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { CustomerPicker } from '../modules/CrmShared';
import { InvoicePanel } from '../modules/Invoices';
import { SignaturePad, type Stroke } from '../modules/Signature';

export const SVC_STATUS: Record<string, [string, string]> = { planned: ['geplant', 'blue'], on_way: ['unterwegs', 'amber'], in_progress: ['vor Ort', 'amber'], done: ['erledigt', 'green'], invoiced: ['abgerechnet', ''], cancelled: ['storniert', ''] };
const localInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'service.changed') void reload(); }), [reload]);
}

export default function ServicePage() {
  useCrumbs([{ label: 'Service-Einsätze' }]);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('open');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [create, setCreate] = useState(false);
  const { data, reload } = useApi<any[]>(`/service/jobs?${new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}), ...(q ? { q } : {}) })}`);
  const { users } = useSession();
  useLive(reload);
  const open = params.get('job');
  const setOpen = (id: string | null) => { if (id) params.set('job', id); else params.delete('job'); setParams(params, { replace: true }); };
  const name = (id: string) => users.find((u) => u.id === id)?.displayName ?? '';
  // nach Tagen gruppieren
  const groups = new Map<string, any[]>();
  for (const j of data ?? []) { const k = j.startAt ? isoDate(new Date(j.startAt)) : 'ohne Termin'; groups.set(k, [...(groups.get(k) ?? []), j]); }
  const today = isoDate(new Date()), tomorrow = isoDate(new Date(Date.now() + 86400000));
  const label = (k: string) => (k === today ? 'Heute' : k === tomorrow ? 'Morgen' : k === 'ohne Termin' ? k : new Date(`${k}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' }));
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Service-Einsätze</h1><div className="sub">Einsätze beim Kunden planen, Bericht mit Unterschrift, abrechnen</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Einsatz</button></div></div>
      <div className="toolbar">
        <input placeholder="Kunde, Ort, Nummer …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="open">offen</option><option value="billable">erledigt, nicht abgerechnet</option><option value="">alle</option>
          {Object.entries(SVC_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> nur meine</label>
      </div>
      {data && !data.length && <Empty icon="tools" title="Keine Einsätze">Einsatz anlegen: Kunde, Termin und Techniker. Vor Ort erfasst der Techniker Arbeitszeit und Material und lässt den Kunden unterschreiben.</Empty>}
      {[...groups.entries()].map(([k, list]) => (
        <div key={k} style={{ marginBottom: 14 }}>
          <h3 style={{ margin: '6px 0' }}>{label(k)}</h3>
          <table className="table"><tbody>{list.map((j) => (
            <tr key={j.id} className="click" onClick={() => setOpen(j.id)}>
              <td style={{ width: 70 }}>{j.startAt ? new Date(j.startAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''}</td>
              <td><b>{j.title}</b><div className="small muted">{j.number}</div></td>
              <td>{j.accountName ?? '–'}<div className="small muted">{j.address}</div></td>
              <td className="small">{j.technicianIds.map(name).join(', ') || <span className="muted">kein Techniker</span>}</td>
              <td>{j.signed && <Icon name="signature" />}</td>
              <td><Pill tone={SVC_STATUS[j.status]![1]}>{SVC_STATUS[j.status]![0]}</Pill></td>
            </tr>
          ))}</tbody></table>
        </div>
      ))}
      {create && <NewJob onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); setOpen(id); }} />}
      {open && <JobPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function NewJob({ onClose, onDone, initial }: { onClose: () => void; onDone: (id: string) => void; initial?: any }) {
  const { users, me } = useSession();
  const act = useAction();
  const [f, setF] = useState<any>({ account: null, title: '', description: '', contactName: '', contactPhone: '', address: '', asset: '', technicianIds: me ? [me.id] : [], start: '', ...(initial ?? {}) });
  return (
    <Modal title="Neuer Service-Einsatz" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => {
        const r = await act(() => post<{ id: string }>('/service/jobs', { accountId: f.account?.id ?? null, title: f.title, description: f.description, contactName: f.contactName, contactPhone: f.contactPhone,
          address: f.address, asset: f.asset, technicianIds: f.technicianIds, startAt: fromLocal(f.start), ticketId: f.ticketId ?? null, contractId: f.contractId ?? null }), 'Angelegt');
        if (r) onDone(r.id);
      }}>Anlegen</button></>}>
      <Field label="Kunde"><CustomerPicker value={f.account} onChange={(a) => setF({ ...f, account: a })} /></Field>
      <Field label="Auftrag"><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Pumpe fördert nicht" /></Field>
      <Field label="Beschreibung"><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="Termin"><input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="Anlage / Gerät"><input value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })} /></Field>
        <Field label="Ansprechpartner vor Ort"><input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
        <Field label="Telefon"><input value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} /></Field>
      </div>
      <Field label="Einsatzort" hint="leer = Adresse des Kunden"><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <Field label="Techniker"><UserPicker users={users} value={f.technicianIds} onChange={(ids) => setF({ ...f, technicianIds: ids })} /></Field>
    </Modal>
  );
}

function JobPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: j, reload } = useApi<any>(`/service/jobs/${id}`, [id]);
  const { users, me } = useSession();
  const act = useAction();
  const toast = useToast();
  const [f, setF] = useState<any>(null);
  const [sign, setSign] = useState(false);
  const [mail, setMail] = useState<string | null>(null);
  const [inv, setInv] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  useLive(reload);
  useEffect(() => { if (j) setF({ title: j.title, description: j.description, address: j.address, contactName: j.contactName, contactPhone: j.contactPhone, asset: j.asset, technicianIds: j.technicianIds,
    start: localInput(j.startAt), report: j.report, work: j.work, materials: j.materials, travelKm: j.travelKm }); }, [j?.id, j?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!j || !f) return null;
  const locked = j.signed || j.status === 'invoiced';
  const save = (extra: Record<string, unknown> = {}, msg = 'Gespeichert') => act(() => patch(`/service/jobs/${id}`, {
    ...(locked ? {} : { report: f.report, work: f.work.map((w: any) => ({ ...w, hours: Number(w.hours) })), materials: f.materials.map((m: any) => ({ ...m, qty: Number(m.qty), price: Number(m.price) })), travelKm: Number(f.travelKm) }),
    title: f.title, description: f.description, address: f.address, contactName: f.contactName, contactPhone: f.contactPhone, asset: f.asset, technicianIds: f.technicianIds, startAt: fromLocal(f.start), ...extra }), msg);
  const hours = f.work.reduce((s: number, w: any) => s + Number(w.hours || 0), 0);
  return (
    <SlideOver wide title={<span>{j.title} <span className="mono muted">{j.number}</span></span>} onClose={onClose}
      actions={<><a className="btn sm" href={`/api/service/jobs/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="printer" /> Bericht</a>
        <button className="btn sm" onClick={() => setMail(j.contactEmail ?? '')}><Icon name="send" /> per E-Mail</button></>}>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <Pill tone={SVC_STATUS[j.status]![1]}>{SVC_STATUS[j.status]![0]}</Pill>
        {j.accountName && <span className="small"><b>{j.accountName}</b></span>}
        {j.address && <a className="small" href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(j.address)}`} target="_blank" rel="noreferrer"><Icon name="location" /> {j.address}</a>}
        {j.contactPhone && <a className="small" href={`tel:${j.contactPhone}`}><Icon name="phone" /> {j.contactPhone}</a>}
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {j.status === 'planned' && <button className="btn" onClick={async () => { if (await save({ status: 'on_way' }, 'Unterwegs')) void reload(); }}><Icon name="car" /> Losfahren</button>}
        {['planned', 'on_way'].includes(j.status) && <button className="btn primary" onClick={async () => { if (await save({ status: 'in_progress' }, 'Vor Ort')) void reload(); }}><Icon name="play" /> Vor Ort</button>}
        {!j.signed && !['invoiced', 'cancelled'].includes(j.status) && <button className="btn primary" onClick={async () => { if (await save()) setSign(true); }}><Icon name="signature" /> Unterschrift Kunde</button>}
        {['in_progress', 'on_way'].includes(j.status) && !j.signed && <button className="btn" onClick={async () => { if (await save({ status: 'done' }, 'Erledigt')) void reload(); }}>Ohne Unterschrift abschließen</button>}
        {j.status === 'done' && !j.invoiceId && j.accountId && <button className="btn" onClick={async () => { const r = await act(() => post<{ invoiceId: string }>(`/service/jobs/${id}/invoice`, {}), 'Rechnungsentwurf erstellt'); if (r) { void reload(); setInv(r.invoiceId); } }}><Icon name="euro" /> Abrechnen</button>}
        {j.invoiceId && <button className="btn ghost" onClick={() => setInv(j.invoiceId)}>Rechnung {j.invoiceNumber ?? '(Entwurf)'}</button>}
        {j.signed && !j.invoiceId && <button className="btn ghost" onClick={async () => { if (await act(() => del(`/service/jobs/${id}/sign`), 'Unterschrift entfernt')) void reload(); }}>Unterschrift entfernen</button>}
        <span className="grow" />
        {!['invoiced'].includes(j.status) && <button className="btn ghost" onClick={async () => { if (await save({ status: 'cancelled' }, 'Storniert')) void reload(); }}>Stornieren</button>}
        {!j.invoiceId && me?.role === 'admin' && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      </div>
      {j.signed && <div className="card flat small" style={{ marginBottom: 10 }}><Icon name="check-circle" /> Unterschrieben von <b>{j.signedBy}</b> am {fmtDateTime(j.signedAt)}. Bericht und Leistungen sind gesperrt.</div>}
      <div className="grid2">
        <Field label="Termin"><input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="Anlage / Gerät"><input value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })} /></Field>
      </div>
      <Field label="Techniker"><UserPicker users={users} value={f.technicianIds} onChange={(ids) => setF({ ...f, technicianIds: ids })} /></Field>
      {j.description && <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{j.description}</p>}
      <fieldset className="plain" disabled={locked}>
        <h3 style={{ margin: '10px 0 4px' }}>Bericht</h3>
        <textarea rows={4} value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })} placeholder="Was wurde gemacht? Befund, Ursache, Ergebnis …" />
        <h3 style={{ margin: '12px 0 4px' }}>Arbeitszeit <span className="small muted">{hours.toLocaleString('de-DE')} Std.</span></h3>
        {f.work.map((w: any, i: number) => (
          <div key={i} className="row" style={{ gap: 6, marginBottom: 4 }}>
            <input type="date" style={{ width: 150 }} value={w.date ?? ''} onChange={(e) => setF({ ...f, work: f.work.map((x: any, k: number) => (k === i ? { ...x, date: e.target.value || null } : x)) })} />
            <input className="grow" value={w.text} placeholder="Tätigkeit" onChange={(e) => setF({ ...f, work: f.work.map((x: any, k: number) => (k === i ? { ...x, text: e.target.value } : x)) })} />
            <input type="number" step="0.25" min={0} style={{ width: 90 }} value={w.hours} onChange={(e) => setF({ ...f, work: f.work.map((x: any, k: number) => (k === i ? { ...x, hours: e.target.value } : x)) })} /><span className="small">Std.</span>
            {!locked && <button className="btn ghost sm" onClick={() => setF({ ...f, work: f.work.filter((_: any, k: number) => k !== i) })}><Icon name="x" /></button>}
          </div>
        ))}
        {!locked && <button className="btn sm" onClick={() => setF({ ...f, work: [...f.work, { date: isoDate(new Date()), text: '', hours: 1, userId: me?.id ?? null }] })}><Icon name="plus" /> Arbeitszeit</button>}
        <div className="grid2" style={{ marginTop: 8 }}><Field label="Fahrt (km)"><input type="number" min={0} value={f.travelKm} onChange={(e) => setF({ ...f, travelKm: e.target.value })} /></Field></div>
        <h3 style={{ margin: '8px 0 4px' }}>Material</h3>
        {f.materials.map((m: any, i: number) => (
          <div key={i} className="row" style={{ gap: 6, marginBottom: 4 }}>
            <input className="grow" value={m.text} placeholder="Teil / Material" onChange={(e) => setF({ ...f, materials: f.materials.map((x: any, k: number) => (k === i ? { ...x, text: e.target.value } : x)) })} />
            <input type="number" min={0} style={{ width: 80 }} value={m.qty} onChange={(e) => setF({ ...f, materials: f.materials.map((x: any, k: number) => (k === i ? { ...x, qty: e.target.value } : x)) })} />
            <input style={{ width: 60 }} value={m.unit} onChange={(e) => setF({ ...f, materials: f.materials.map((x: any, k: number) => (k === i ? { ...x, unit: e.target.value } : x)) })} />
            <input type="number" step="0.01" min={0} style={{ width: 100 }} title="Preis je Einheit (€)" value={m.price} onChange={(e) => setF({ ...f, materials: f.materials.map((x: any, k: number) => (k === i ? { ...x, price: e.target.value } : x)) })} /><span className="small">€</span>
            {!locked && <button className="btn ghost sm" onClick={() => setF({ ...f, materials: f.materials.filter((_: any, k: number) => k !== i) })}><Icon name="x" /></button>}
          </div>
        ))}
        {!locked && <button className="btn sm" onClick={() => setF({ ...f, materials: [...f.materials, { text: '', qty: 1, unit: 'Stk', price: 0, articleId: null }] })}><Icon name="plus" /> Material</button>}
      </fieldset>
      <div style={{ marginTop: 14 }}><button className="btn primary" onClick={async () => { if (await save()) void reload(); }}>Speichern</button></div>
      {sign && <SignModal job={j} onClose={() => setSign(false)} onDone={() => { setSign(false); void reload(); toast('Unterschrieben – Einsatz erledigt'); }} />}
      {mail !== null && <MailModal jobId={id} initial={mail} onClose={() => setMail(null)} />}
      {inv && <InvoicePanel id={inv} onClose={() => setInv(null)} />}
      {remove && <Confirm danger text="Einsatz löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/service/jobs/${id}`))) onClose(); }} />}
    </SlideOver>
  );
}

function SignModal({ job, onClose, onDone }: { job: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [name, setName] = useState(job.contactName ?? '');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const hours = job.work.reduce((s: number, w: any) => s + w.hours, 0);
  return (
    <Modal size="lg" title="Unterschrift des Kunden" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!name.trim() || !strokes.length} onClick={async () => { if (await act(() => post(`/service/jobs/${job.id}/sign`, { name, strokes }))) onDone(); }}>Unterschreiben</button></>}>
      <div className="card flat small" style={{ marginBottom: 10 }}>
        <b>{job.title}</b>{job.report && <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{job.report}</p>}
        <div className="muted">{hours.toLocaleString('de-DE')} Std. Arbeit{job.travelKm ? ` · ${job.travelKm} km` : ''}{job.materials.length ? ` · ${job.materials.map((m: any) => `${m.qty} ${m.unit} ${m.text}`).join(', ')}` : ''}</div>
      </div>
      <Field label="Name des Unterzeichners"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <SignaturePad onChange={setStrokes} />
      <p className="hint">Mit der Unterschrift bestätigt der Kunde die ausgeführten Arbeiten. Danach ist der Bericht gesperrt.</p>
    </Modal>
  );
}

function MailModal({ jobId, initial, onClose }: { jobId: string; initial: string; onClose: () => void }) {
  const act = useAction();
  const [to, setTo] = useState(initial);
  return (
    <Modal title="Servicebericht senden" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!/.+@.+/.test(to)} onClick={async () => { if (await act(() => post(`/service/jobs/${jobId}/mail`, { to }), 'Gesendet')) onClose(); }}>Senden</button></>}>
      <Field label="An"><input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
    </Modal>
  );
}
