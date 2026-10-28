import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, get, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCan, useSession } from '../session';
import { fmtDate, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, UserSelect, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { ProjectSelect } from '../modules/Pickers';

const STATUS: Record<string, [string, string]> = { idea: ['Idee', ''], planned: ['geplant', 'blue'], confirmed: ['gebucht', 'green'], done: ['vorbei', ''], cancelled: ['abgesagt', ''] };
const KIND: Record<string, string> = { fair: 'Messe', event: 'Eigene Veranstaltung', workshop: 'Seminar / Workshop', other: 'Sonstiges' };
const RATING: Record<string, [string, string]> = { hot: ['heiß', 'red'], warm: ['warm', 'amber'], cold: ['kalt', 'blue'] };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'events.changed') void reload(); }), [reload]);
}
const range = (a: string, b: string) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);

export default function EventsPage() {
  useCrumbs([{ label: 'Messen und Veranstaltungen' }]);
  const [params, setParams] = useSearchParams();
  const [past, setPast] = useState(false);
  const [create, setCreate] = useState(false);
  const { data, reload } = useApi<any[]>(`/events${past ? '?past=1' : ''}`);
  useLive(reload);
  const open = params.get('event');
  const setOpen = (id: string | null) => { if (id) params.set('event', id); else params.delete('event'); setParams(params, { replace: true }); };
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Messen und Veranstaltungen</h1><div className="sub">Planen, Standdienst, Kontakte erfassen, Anmeldungen</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Veranstaltung</button></div></div>
      <div className="toolbar"><select value={past ? '1' : ''} onChange={(e) => setPast(Boolean(e.target.value))} style={{ width: 'auto' }}><option value="">kommende</option><option value="1">vergangene</option></select></div>
      {data && !data.length && <Empty icon="tent" title="Keine Veranstaltungen">Messe oder eigene Veranstaltung anlegen – mit Checkliste, Budget und Standdienst.</Empty>}
      <div className="ev-grid">{data?.map((e) => (
        <div key={e.id} className="card click" onClick={() => setOpen(e.id)}>
          <div className="row"><b className="grow">{e.name}</b><Pill tone={STATUS[e.status]![1]}>{STATUS[e.status]![0]}</Pill></div>
          <div className="small muted">{KIND[e.kind]} · {range(e.startDate, e.endDate)}{e.location ? ` · ${e.location}` : ''}</div>
          <div className="row small" style={{ gap: 12, marginTop: 8 }}>
            <span>{e.checklist.filter((c: any) => c.done).length}/{e.checklist.length} erledigt</span>
            <span>{fmtEuro2(e.costs)}{e.budget ? ` von ${fmtEuro2(e.budget)}` : ''}</span>
            {e.kind === 'fair' ? <span>{e.leads} Kontakte</span> : <span>{e.registrations} Anmeldungen</span>}
          </div>
        </div>
      ))}</div>
      {create && <NewEvent onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); setOpen(id); }} />}
      {open && <EventPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewEvent({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const act = useAction();
  const [f, setF] = useState({ name: '', kind: 'fair', location: '', startDate: isoDate(new Date()), endDate: isoDate(new Date()), budget: '' });
  return (
    <Modal title="Neue Veranstaltung" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.name.trim()} onClick={async () => { const r = await act(() => post<{ id: string }>('/events', { ...f, budget: f.budget ? Number(f.budget) : null, endDate: f.endDate < f.startDate ? f.startDate : f.endDate })); if (r) onDone(r.id); }}>Anlegen</button></>}>
      <Field label="Name"><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Hannover Messe 2027" /></Field>
      <div className="grid2">
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Ort"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Beginn"><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Ende"><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Budget (€)"><input type="number" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></Field>
      </div>
      {f.kind === 'fair' && <p className="hint">Für Messen wird eine Checkliste mit den üblichen Aufgaben vorbereitet.</p>}
    </Modal>
  );
}

function EventPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: e, reload } = useApi<any>(`/events/${id}`, [id]);
  const [tab, setTab] = useState<'plan' | 'staff' | 'costs' | 'leads' | 'regs'>('plan');
  const act = useAction();
  const [remove, setRemove] = useState(false);
  useLive(reload);
  if (!e) return null;
  const upd = async (p: Record<string, unknown>, msg?: string) => { if (await act(() => patch(`/events/${id}`, p), msg)) void reload(); };
  return (
    <SlideOver wide title={e.name} onClose={onClose}>
      <div className="row wrap small" style={{ gap: 10, marginBottom: 10 }}>
        <select style={{ width: 'auto' }} value={e.status} onChange={(x) => void upd({ status: x.target.value })}>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <span>{KIND[e.kind]} · {range(e.startDate, e.endDate)}{e.location ? ` · ${e.location}` : ''}</span>
        <span className="grow" />
        <button className="btn ghost danger sm" onClick={() => setRemove(true)}><Icon name="trash" /></button>
      </div>
      <div className="kpi-row">
        <div className="kpi"><div className="v">{fmtEuro2(e.costs)}</div><div className="l">Kosten{e.budget ? ` von ${fmtEuro2(e.budget)}` : ''}</div></div>
        <div className="kpi"><div className="v">{e.leads}</div><div className="l">Kontakte{e.costPerLead ? ` · ${fmtEuro2(e.costPerLead)} je Kontakt` : ''}</div></div>
        <div className="kpi"><div className="v">{e.registrations}{e.maxAttendees ? ` / ${e.maxAttendees}` : ''}</div><div className="l">Anmeldungen</div></div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'plan', label: 'Planung' }, { id: 'staff', label: 'Standdienst' }, { id: 'costs', label: 'Kosten' }, { id: 'leads', label: `Kontakte (${e.leads})` }, { id: 'regs', label: 'Anmeldung' }]} />
      {tab === 'plan' && <Plan e={e} upd={upd} />}
      {tab === 'staff' && <Staff e={e} upd={upd} />}
      {tab === 'costs' && <Costs e={e} reload={reload} />}
      {tab === 'leads' && <Leads e={e} reload={reload} />}
      {tab === 'regs' && <Registrations e={e} upd={upd} reload={reload} />}
      {remove && <Confirm danger text="Veranstaltung mit allen Kosten und Kontakten löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/events/${id}`))) onClose(); }} />}
    </SlideOver>
  );
}

function Plan({ e, upd }: { e: any; upd: (p: Record<string, unknown>, msg?: string) => Promise<void> }) {
  const { users } = useSession();
  const [list, setList] = useState<any[]>(e.checklist);
  const [text, setText] = useState('');
  const [desc, setDesc] = useState(e.description);
  useEffect(() => setList(e.checklist), [e.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (l: any[]) => { setList(l); void upd({ checklist: l }); };
  return (
    <div>
      <div className="grid3">
        <Field label="Verantwortlich"><UserSelect users={users} value={e.ownerId} onChange={(v) => void upd({ ownerId: v })} /></Field>
        <Field label="Budget (€)"><input type="number" defaultValue={e.budget ?? ''} onBlur={(x) => void upd({ budget: x.target.value ? Number(x.target.value) : null })} /></Field>
        <Field label="Projekt"><ProjectSelect value={e.projectId} onChange={(v) => void upd({ projectId: v })} /></Field>
      </div>
      <h3 style={{ margin: '8px 0 4px' }}>Checkliste</h3>
      {list.map((c, i) => (
        <div key={i} className="row" style={{ gap: 6, padding: '3px 0' }}>
          <input type="checkbox" checked={c.done} onChange={(x) => save(list.map((y, k) => (k === i ? { ...y, done: x.target.checked } : y)))} />
          <span className="grow" style={c.done ? { textDecoration: 'line-through', color: 'var(--text-3)' } : undefined}>{c.text}</span>
          <input type="date" style={{ width: 140 }} value={c.due ?? ''} onChange={(x) => save(list.map((y, k) => (k === i ? { ...y, due: x.target.value || null } : y)))} />
          <div style={{ width: 170 }}><UserSelect users={users} value={c.userId} onChange={(v) => save(list.map((y, k) => (k === i ? { ...y, userId: v } : y)))} /></div>
          <button className="btn ghost sm" onClick={() => save(list.filter((_, k) => k !== i))}><Icon name="x" /></button>
        </div>
      ))}
      <form className="row" style={{ gap: 6, marginTop: 6 }} onSubmit={(x) => { x.preventDefault(); if (text.trim()) { save([...list, { text: text.trim(), done: false, due: null, userId: null, note: '' }]); setText(''); } }}>
        <input className="grow" value={text} onChange={(x) => setText(x.target.value)} placeholder="Aufgabe hinzufügen …" /><button className="btn" type="submit">Hinzufügen</button>
      </form>
      <Field label="Notizen"><textarea rows={4} value={desc} onChange={(x) => setDesc(x.target.value)} onBlur={() => desc !== e.description && void upd({ description: desc })} /></Field>
    </div>
  );
}

function Staff({ e, upd }: { e: any; upd: (p: Record<string, unknown>, msg?: string) => Promise<void> }) {
  const { users } = useSession();
  const days: string[] = [];
  for (let d = new Date(`${e.startDate}T12:00:00`); isoDate(d) <= e.endDate; d.setDate(d.getDate() + 1)) days.push(isoDate(d));
  const [f, setF] = useState({ userId: null as string | null, date: days[0] ?? e.startDate, from: '09:00', to: '13:00', role: '' });
  const name = (uid: string) => users.find((u) => u.id === uid)?.displayName ?? '–';
  return (
    <div>
      {days.map((d) => {
        const slots = e.staff.filter((s: any) => s.date === d).sort((a: any, b: any) => a.from.localeCompare(b.from));
        return (
          <div key={d} style={{ marginBottom: 10 }}>
            <b>{new Date(`${d}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}</b>
            {!slots.length && <div className="small muted">noch niemand eingeteilt</div>}
            {slots.map((s: any, i: number) => (
              <div key={i} className="row small" style={{ gap: 8, padding: '2px 0' }}><span style={{ width: 100 }}>{s.from}–{s.to}</span><span className="grow">{name(s.userId)}{s.role ? ` · ${s.role}` : ''}</span>
                <button className="btn ghost sm" onClick={() => void upd({ staff: e.staff.filter((x: any) => x !== s) })}><Icon name="x" /></button></div>
            ))}
          </div>
        );
      })}
      <div className="card flat row wrap" style={{ gap: 6 }}>
        <div style={{ width: 180 }}><UserSelect users={users} value={f.userId} onChange={(v) => setF({ ...f, userId: v })} placeholder="– Person –" /></div>
        <select style={{ width: 'auto' }} value={f.date} onChange={(x) => setF({ ...f, date: x.target.value })}>{days.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}</select>
        <input type="time" style={{ width: 110 }} value={f.from} onChange={(x) => setF({ ...f, from: x.target.value })} />–<input type="time" style={{ width: 110 }} value={f.to} onChange={(x) => setF({ ...f, to: x.target.value })} />
        <input style={{ width: 140 }} placeholder="Aufgabe" value={f.role} onChange={(x) => setF({ ...f, role: x.target.value })} />
        <button className="btn primary sm" disabled={!f.userId} onClick={() => void upd({ staff: [...e.staff, f] }, 'Eingeteilt')}>Einteilen</button>
      </div>
    </div>
  );
}

function Costs({ e, reload }: { e: any; reload: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ text: '', category: '', amount: '', date: '' });
  return (
    <div>
      <table className="table small"><tbody>{e.costList.map((c: any) => (
        <tr key={c.id}><td>{fmtDate(c.date)}</td><td>{c.text}</td><td className="muted">{c.category}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(c.amount)}</td>
          <td><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/events/costs/${c.id}`))) reload(); }}><Icon name="x" /></button></td></tr>
      ))}<tr><td /><td><b>Summe</b></td><td /><td style={{ textAlign: 'right' }}><b>{fmtEuro2(e.costs)}</b></td><td /></tr></tbody></table>
      <form className="row wrap" style={{ gap: 6 }} onSubmit={async (x) => { x.preventDefault(); if (await act(() => post(`/events/${e.id}/costs`, { text: f.text, category: f.category, amount: Number(f.amount), date: f.date || null }))) { setF({ text: '', category: '', amount: '', date: '' }); reload(); } }}>
        <input type="date" style={{ width: 150 }} value={f.date} onChange={(x) => setF({ ...f, date: x.target.value })} />
        <input className="grow" required placeholder="z. B. Standfläche, Hotel, Prospekte" value={f.text} onChange={(x) => setF({ ...f, text: x.target.value })} />
        <input style={{ width: 130 }} placeholder="Kategorie" value={f.category} onChange={(x) => setF({ ...f, category: x.target.value })} />
        <input type="number" step="0.01" required style={{ width: 110 }} placeholder="€" value={f.amount} onChange={(x) => setF({ ...f, amount: x.target.value })} />
        <button className="btn" type="submit">Hinzufügen</button>
      </form>
    </div>
  );
}

function Leads({ e, reload }: { e: any; reload: () => void }) {
  const can = useCan();
  const act = useAction();
  const toast = useToast();
  const empty = { name: '', company: '', email: '', phone: '', interest: '', notes: '', rating: 'warm', followUp: '' };
  const [f, setF] = useState(empty);
  return (
    <div>
      <form className="card" onSubmit={async (x) => { x.preventDefault(); if (await act(() => post(`/events/${e.id}/leads`, { ...f, followUp: f.followUp || null }), 'Kontakt erfasst')) { setF(empty); reload(); } }}>
        <b>Kontakt erfassen</b>
        <div className="grid2" style={{ marginTop: 6 }}>
          <input required placeholder="Name" value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} />
          <input placeholder="Firma" value={f.company} onChange={(x) => setF({ ...f, company: x.target.value })} />
          <input type="email" placeholder="E-Mail" value={f.email} onChange={(x) => setF({ ...f, email: x.target.value })} />
          <input placeholder="Telefon" value={f.phone} onChange={(x) => setF({ ...f, phone: x.target.value })} />
          <input placeholder="Interesse an …" value={f.interest} onChange={(x) => setF({ ...f, interest: x.target.value })} />
          <div className="row" style={{ gap: 6 }}><select value={f.rating} onChange={(x) => setF({ ...f, rating: x.target.value })}>{Object.entries(RATING).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
            <input type="date" title="Nachfassen am" value={f.followUp} onChange={(x) => setF({ ...f, followUp: x.target.value })} /></div>
        </div>
        <textarea rows={2} placeholder="Notizen zum Gespräch" style={{ marginTop: 6 }} value={f.notes} onChange={(x) => setF({ ...f, notes: x.target.value })} />
        <button className="btn primary" type="submit" style={{ marginTop: 6 }}>Speichern</button>
      </form>
      <div className="row" style={{ margin: '10px 0 4px' }}><h3 className="grow" style={{ margin: 0 }}>Kontakte</h3>{e.leadList.length > 0 && <a className="btn sm" href={`/api/events/${e.id}/leads.xlsx`}><Icon name="file-excel" /> Excel</a>}</div>
      <table className="table small"><tbody>{e.leadList.map((l: any) => (
        <tr key={l.id}><td><b>{l.name}</b>{l.company && <div className="muted">{l.company}</div>}</td><td>{l.email}<div>{l.phone}</div></td><td>{l.interest}<div className="muted">{l.notes}</div></td>
          <td><Pill tone={RATING[l.rating]![1]}>{RATING[l.rating]![0]}</Pill>{l.followUp && <div className="muted">nachfassen {fmtDate(l.followUp)}</div>}</td>
          <td>{l.accountId ? <a href={`/crm/${l.accountId}`}>{l.accountName}</a> : can('crm') && <button className="btn sm" onClick={async () => { const r = await act(() => post<{ accountId: string }>(`/events/leads/${l.id}/to-crm`, {}), 'Ins CRM übernommen'); if (r) { reload(); toast('Im CRM als Interessent angelegt bzw. zugeordnet'); } }}>ins CRM</button>}</td>
          <td><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/events/leads/${l.id}`))) reload(); }}><Icon name="x" /></button></td></tr>
      ))}</tbody></table>
    </div>
  );
}

function Registrations({ e, upd, reload }: { e: any; upd: (p: Record<string, unknown>, msg?: string) => Promise<void>; reload: () => void }) {
  const act = useAction();
  const toast = useToast();
  return (
    <div>
      <div className="row wrap" style={{ gap: 10, marginBottom: 10 }}>
        <label className="row"><input type="checkbox" checked={e.registrationOpen} onChange={(x) => void upd({ registrationOpen: x.target.checked }, x.target.checked ? 'Anmeldung geöffnet' : 'Anmeldung geschlossen')} /> Öffentliche Anmeldung</label>
        <label className="row small">max. Teilnehmer <input type="number" min={1} style={{ width: 90 }} defaultValue={e.maxAttendees ?? ''} onBlur={(x) => void upd({ maxAttendees: x.target.value ? Number(x.target.value) : null })} /></label>
      </div>
      {e.publicUrl && <div className="row" style={{ gap: 6, marginBottom: 10 }}><input readOnly className="mono small grow" value={e.publicUrl} />
        <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(e.publicUrl); toast('Link kopiert'); }}><Icon name="copy" /></button><a className="btn sm" href={e.publicUrl} target="_blank" rel="noreferrer"><Icon name="eye" /></a></div>}
      {!e.registrationList.length ? <p className="muted small">Noch keine Anmeldungen.</p> : <table className="table small"><tbody>{e.registrationList.map((r: any) => (
        <tr key={r.id} style={r.status === 'cancelled' ? { opacity: 0.5 } : undefined}><td><b>{r.name}</b>{r.company && <div className="muted">{r.company}</div>}</td><td>{r.email}</td><td>{r.persons} Pers.</td><td className="muted">{r.note}</td>
          <td><select style={{ width: 'auto' }} value={r.status} onChange={async (x) => { if (await act(() => patch(`/events/registrations/${r.id}`, { status: x.target.value }))) reload(); }}>
            <option value="registered">angemeldet</option><option value="attended">teilgenommen</option><option value="cancelled">abgemeldet</option></select></td></tr>
      ))}</tbody></table>}
    </div>
  );
}

// ---------------------------------------------------------------- Öffentliche Anmeldung
export function PublicEventPage() {
  const token = location.pathname.match(/^\/event\/([\w-]+)/)?.[1] ?? '';
  const [e, setE] = useState<any>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [f, setF] = useState({ name: '', company: '', email: '', persons: 1, note: '', website: '' });
  useEffect(() => { void get(`/pub/event/${token}`).then(setE).catch((x) => setErr((x as Error).message)); }, [token]);
  if (err && !e) return <div className="pub-page"><div className="pub-card"><p>{err}</p></div></div>;
  if (!e) return null;
  return (
    <div className="pub-page"><div className="pub-card">
      <div className="pub-company">{e.company}</div>
      <h1>{e.name}</h1>
      <p className="muted">{range(e.startDate, e.endDate)}{e.location ? ` · ${e.location}` : ''}</p>
      {e.description && <p style={{ whiteSpace: 'pre-wrap' }}>{e.description}</p>}
      {done ? <p><b>Vielen Dank – Sie sind angemeldet.</b> Eine Bestätigung kommt per E-Mail.</p>
        : !e.open ? <p><b>Die Anmeldung ist geschlossen.</b></p>
        : e.seatsLeft === 0 ? <p><b>Leider ausgebucht.</b></p>
        : <form onSubmit={async (x) => { x.preventDefault(); setErr(''); try { await post(`/pub/event/${token}`, f); setDone(true); } catch (y) { setErr((y as Error).message); } }}>
          <div className="grid2">
            <Field label="Name" required><input required value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} /></Field>
            <Field label="Firma"><input value={f.company} onChange={(x) => setF({ ...f, company: x.target.value })} /></Field>
            <Field label="E-Mail" required><input required type="email" value={f.email} onChange={(x) => setF({ ...f, email: x.target.value })} /></Field>
            <Field label="Personen"><input type="number" min={1} max={e.seatsLeft ?? 20} value={f.persons} onChange={(x) => setF({ ...f, persons: Number(x.target.value) })} /></Field>
          </div>
          <Field label="Anmerkung"><textarea rows={2} value={f.note} onChange={(x) => setF({ ...f, note: x.target.value })} /></Field>
          <input className="hp" tabIndex={-1} autoComplete="off" value={f.website} onChange={(x) => setF({ ...f, website: x.target.value })} aria-hidden="true" />
          {e.seatsLeft !== null && <p className="small muted">Noch {e.seatsLeft} Plätze frei.</p>}
          {err && <p className="text-red">{err}</p>}
          <button className="btn primary" type="submit">Anmelden</button>
        </form>}
    </div></div>
  );
}
