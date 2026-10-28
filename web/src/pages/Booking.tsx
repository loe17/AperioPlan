import { useEffect, useMemo, useState } from 'react';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';

type Tab = 'bookings' | 'types';
const DAYS: [string, string][] = [['mon', 'Montag'], ['tue', 'Dienstag'], ['wed', 'Mittwoch'], ['thu', 'Donnerstag'], ['fri', 'Freitag'], ['sat', 'Samstag'], ['sun', 'Sonntag']];
const when = (d: string) => new Date(d).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'booking.changed') void reload(); }), [reload]);
}

export default function BookingPage() {
  useCrumbs([{ label: 'Terminbuchung' }]);
  const [tab, setTab] = useTabState<Tab>('booking', 'bookings');
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Terminbuchung</h1><div className="sub">Kunden buchen freie Termine selbst über einen Link</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'bookings', label: 'Gebuchte Termine' }, { id: 'types', label: 'Terminarten' }]} />
      {tab === 'bookings' ? <Bookings /> : <Types />}
    </div>
  );
}

function Bookings() {
  const [past, setPast] = useState(false);
  const [mine, setMine] = useState(false);
  const { data, reload } = useApi<any[]>(`/booking/bookings?${new URLSearchParams({ ...(past ? { past: '1' } : {}), ...(mine ? { mine: '1' } : {}) })}`);
  const act = useAction();
  const [cancel, setCancel] = useState<any | null>(null);
  useLive(reload);
  return (
    <div>
      <div className="toolbar">
        <select value={past ? '1' : ''} onChange={(e) => setPast(Boolean(e.target.value))} style={{ width: 'auto' }}><option value="">kommende</option><option value="1">vergangene</option></select>
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> nur meine</label>
      </div>
      {data && !data.length && <Empty icon="calendar-check" title="Keine Termine">Unter „Terminarten“ eine Terminart anlegen und den Link auf der Webseite oder in der E-Mail-Signatur teilen.</Empty>}
      {data && data.length > 0 && <table className="table"><tbody>{data.map((b) => (
        <tr key={b.id} style={b.status === 'cancelled' ? { opacity: 0.5 } : undefined}>
          <td style={{ width: 150 }}><b>{when(b.startsAt)}</b></td>
          <td><span className="dot" style={{ background: b.color, marginRight: 6 }} />{b.typeName}<div className="small muted">mit {b.hostName}</div></td>
          <td><b>{b.name}</b>{b.company && ` · ${b.company}`}<div className="small"><a href={`mailto:${b.email}`}>{b.email}</a>{b.phone && ` · ${b.phone}`}</div></td>
          <td className="small">{Object.values(b.answers ?? {}).filter(Boolean).join(' · ')}</td>
          <td>{b.meetingLink && <a className="btn sm" href={b.meetingLink} target="_blank" rel="noreferrer"><Icon name="video" /> Meeting</a>}</td>
          <td>{b.status === 'cancelled' ? <Pill>abgesagt</Pill> : !past && <button className="btn ghost sm" onClick={() => setCancel(b)}>Absagen</button>}</td>
        </tr>
      ))}</tbody></table>}
      {cancel && <Confirm danger confirmLabel="Absagen" text={`Termin mit ${cancel.name} am ${when(cancel.startsAt)} absagen? Der Kunde bekommt eine E-Mail.`} onClose={() => setCancel(null)}
        onConfirm={async () => { if (await act(() => post(`/booking/bookings/${cancel.id}/cancel`, {}), 'Abgesagt')) void reload(); }} />}
    </div>
  );
}

function Types() {
  const { data, reload } = useApi<any[]>('/booking/types');
  const [edit, setEdit] = useState<any | null>(null);
  const toast = useToast();
  useLive(reload);
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({})}><Icon name="plus" /> Terminart</button></span></div>
      {data && !data.length && <Empty icon="calendar-check" title="Noch keine Terminart">z. B. „Erstberatung 30 Minuten“ oder „Online-Vorführung“ – mit den Mitarbeitern, die den Termin übernehmen.</Empty>}
      <div className="bk-types">{data?.map((t) => (
        <div key={t.id} className="card" style={{ borderTop: `4px solid ${t.color}`, opacity: t.active ? 1 : 0.55 }}>
          <div className="row"><b className="grow">{t.name}</b><span className="small muted">{t.durationMin} Min.{t.online ? ' · online' : ''}</span></div>
          <div className="small muted" style={{ margin: '4px 0' }}>{t.upcoming} kommende Termine</div>
          <div className="row" style={{ gap: 6 }}>
            <input readOnly className="mono small grow" value={t.publicUrl} />
            <button className="btn sm" title="Link kopieren" onClick={() => { void navigator.clipboard.writeText(t.publicUrl); toast('Link kopiert'); }}><Icon name="copy" /></button>
            <a className="btn sm" href={t.publicUrl} target="_blank" rel="noreferrer" title="Ansehen"><Icon name="eye" /></a>
            <button className="btn sm" onClick={() => setEdit(t)}><Icon name="edit" /></button>
          </div>
        </div>
      ))}</div>
      {edit && <TypeModal type={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function TypeModal({ type, onClose, onSaved }: { type: any; onClose: () => void; onSaved: () => void }) {
  const { users, me } = useSession();
  const act = useAction();
  const [remove, setRemove] = useState(false);
  const [f, setF] = useState<any>(() => type.id ? { ...type } : { name: '', slug: '', description: '', durationMin: 30, bufferMin: 10, hostIds: me ? [me.id] : [], minNoticeHours: 12, maxDaysAhead: 60, location: '', online: false,
    questions: [], color: '#4f46e5', active: true, availability: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '15:00']] } });
  const setDay = (d: string, wins: [string, string][]) => setF({ ...f, availability: { ...f.availability, [d]: wins } });
  return (
    <Modal size="lg" title={type.id ? type.name : 'Neue Terminart'} onClose={onClose} footer={<>
      {type.id && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.name.trim() || !f.hostIds.length} onClick={async () => {
        const b = { name: f.name, ...(f.slug ? { slug: f.slug } : {}), description: f.description, durationMin: Number(f.durationMin), bufferMin: Number(f.bufferMin), hostIds: f.hostIds, availability: f.availability,
          minNoticeHours: Number(f.minNoticeHours), maxDaysAhead: Number(f.maxDaysAhead), location: f.location, online: f.online, questions: f.questions, color: f.color, active: f.active };
        if (await act(() => (type.id ? patch(`/booking/types/${type.id}`, b) : post('/booking/types', b)), 'Gespeichert')) onSaved();
      }}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Erstberatung" /></Field>
        <Field label="Adresse" hint={`${location.origin}/book/…`}><input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="automatisch" /></Field>
      </div>
      <Field label="Beschreibung"><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid3">
        <Field label="Dauer (Min.)"><input type="number" min={5} step={5} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} /></Field>
        <Field label="Puffer davor/danach (Min.)"><input type="number" min={0} step={5} value={f.bufferMin} onChange={(e) => setF({ ...f, bufferMin: e.target.value })} /></Field>
        <Field label="Farbe"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field>
        <Field label="Frühestens (Std. vorher)"><input type="number" min={0} value={f.minNoticeHours} onChange={(e) => setF({ ...f, minNoticeHours: e.target.value })} /></Field>
        <Field label="Höchstens (Tage im Voraus)"><input type="number" min={1} value={f.maxDaysAhead} onChange={(e) => setF({ ...f, maxDaysAhead: e.target.value })} /></Field>
        <Field label="Ort"><select value={f.online ? 'online' : 'place'} onChange={(e) => setF({ ...f, online: e.target.value === 'online' })}><option value="place">vor Ort / Telefon</option><option value="online">Videokonferenz (Meeting-Link)</option></select></Field>
      </div>
      {!f.online && <Field label="Adresse oder Hinweis"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="z. B. Industriestr. 5, Furtwangen – oder: Wir rufen Sie an" /></Field>}
      <Field label="Wer übernimmt die Termine?" hint="Termine werden gleichmäßig verteilt; belegte Zeiten aus dem Kalender sind gesperrt"><UserPicker users={users} value={f.hostIds} onChange={(ids) => setF({ ...f, hostIds: ids })} /></Field>
      <h3 style={{ margin: '8px 0 4px' }}>Verfügbarkeit</h3>
      <table className="table small"><tbody>{DAYS.map(([d, l]) => {
        const wins: [string, string][] = f.availability[d] ?? [];
        return (
          <tr key={d}><td style={{ width: 110 }}><label className="row"><input type="checkbox" checked={wins.length > 0} onChange={(e) => setDay(d, e.target.checked ? [['09:00', '17:00']] : [])} /> {l}</label></td>
            <td>{wins.map((w, i) => <span key={i} className="row" style={{ gap: 4, display: 'inline-flex', marginRight: 10 }}>
              <input type="time" style={{ width: 110 }} value={w[0]} onChange={(e) => setDay(d, wins.map((x, k) => (k === i ? [e.target.value, x[1]] : x)))} />–
              <input type="time" style={{ width: 110 }} value={w[1]} onChange={(e) => setDay(d, wins.map((x, k) => (k === i ? [x[0], e.target.value] : x)))} />
              <button className="btn ghost sm" onClick={() => setDay(d, wins.filter((_, k) => k !== i))}><Icon name="x" /></button></span>)}
              {wins.length > 0 && <button className="btn ghost sm" onClick={() => setDay(d, [...wins, ['13:00', '17:00']])}><Icon name="plus" /></button>}</td></tr>
        );
      })}</tbody></table>
      <h3 style={{ margin: '8px 0 4px' }}>Fragen an den Kunden</h3>
      {f.questions.map((q: any, i: number) => (
        <div key={q.id} className="row" style={{ gap: 6, marginBottom: 4 }}>
          <input className="grow" value={q.label} onChange={(e) => setF({ ...f, questions: f.questions.map((x: any, k: number) => (k === i ? { ...x, label: e.target.value } : x)) })} />
          <label className="row small"><input type="checkbox" checked={q.required} onChange={(e) => setF({ ...f, questions: f.questions.map((x: any, k: number) => (k === i ? { ...x, required: e.target.checked } : x)) })} /> Pflicht</label>
          <button className="btn ghost sm" onClick={() => setF({ ...f, questions: f.questions.filter((_: any, k: number) => k !== i) })}><Icon name="x" /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setF({ ...f, questions: [...f.questions, { id: Math.random().toString(36).slice(2, 8), label: 'Worum geht es?', required: false }] })}><Icon name="plus" /> Frage</button>
      <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> buchbar</label>
      {remove && <Confirm danger text="Terminart löschen? Gebuchte Termine bleiben im Kalender." onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/booking/types/${type.id}`))) onSaved(); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Öffentliche Buchungsseite
export function PublicBookingPage() {
  const cancel = location.pathname.match(/^\/book\/cancel\/([\w-]+)/)?.[1];
  const slug = location.pathname.match(/^\/book\/([\w-]+)/)?.[1];
  return <div className="pub-page">{cancel ? <PublicCancel token={cancel} /> : slug ? <PublicBook slug={slug} /> : null}</div>;
}

function PublicBook({ slug }: { slug: string }) {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState('');
  const [week, setWeek] = useState(() => isoDate(new Date()));
  const [slots, setSlots] = useState<{ date: string; times: string[] }[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', answers: {} as Record<string, string>, website: '' });
  const [done, setDone] = useState<any>(null);
  useEffect(() => { void get(`/pub/book/${slug}`).then(setInfo).catch((e) => setErr((e as Error).message)); }, [slug]);
  useEffect(() => { setSlots(null); void get(`/pub/book/${slug}/slots?from=${week}&days=7`).then(setSlots).catch((e) => setErr((e as Error).message)); }, [slug, week]);
  const shift = (n: number) => { const d = new Date(`${week}T12:00:00`); d.setDate(d.getDate() + n); const t = isoDate(new Date()); setWeek(isoDate(d) < t ? t : isoDate(d)); };
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  if (err && !info) return <div className="pub-card"><p>{err}</p></div>;
  if (!info) return null;
  if (done) return <div className="pub-card"><h1>Termin bestätigt</h1><p><b>{info.name}</b><br />{new Date(done.start).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' })} mit {done.host}</p>
    {done.meetingLink && <p>Videokonferenz: <a href={done.meetingLink}>{done.meetingLink}</a></p>}<p className="muted">Die Bestätigung mit Kalendereintrag ist per E-Mail unterwegs.</p></div>;
  return (
    <div className="pub-card wide">
      <div className="pub-company">{info.company}</div>
      <h1>{info.name}</h1>
      <p className="muted">{info.durationMin} Minuten{info.location ? ` · ${info.location}` : ''}</p>
      {info.description && <p style={{ whiteSpace: 'pre-wrap' }}>{info.description}</p>}
      {!pick ? <>
        <div className="row" style={{ gap: 8, margin: '12px 0' }}>
          <button className="btn sm" onClick={() => shift(-7)} disabled={week <= isoDate(new Date())}><Icon name="chevron-left" /></button>
          <b className="grow" style={{ textAlign: 'center' }}>ab {new Date(`${week}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: 'long' })}</b>
          <button className="btn sm" onClick={() => shift(7)}><Icon name="chevron-right" /></button>
        </div>
        {!slots ? <p className="muted">Freie Zeiten werden geladen …</p> : <div className="bk-week">{slots.map((d) => (
          <div key={d.date}><div className="bk-day">{new Date(`${d.date}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</div>
            {d.times.length ? d.times.map((t) => <button key={t} className="btn sm bk-slot" onClick={() => setPick(t)}>{new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</button>) : <span className="small muted">–</span>}</div>
        ))}</div>}
        <p className="hint">Zeiten in Ihrer Zeitzone ({tz}).</p>
      </> : <form onSubmit={async (e) => { e.preventDefault(); setErr(''); try { setDone(await post(`/pub/book/${slug}`, { ...f, start: pick })); } catch (x) { setErr((x as Error).message); } }}>
        <div className="card flat row" style={{ margin: '12px 0' }}><Icon name="calendar-check" /><b className="grow">{new Date(pick).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' })}</b><button type="button" className="link" onClick={() => setPick(null)}>ändern</button></div>
        <div className="grid2">
          <Field label="Name" required><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Firma"><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></Field>
          <Field label="E-Mail" required><input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Telefon"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
        {info.questions.map((q: any) => <Field key={q.id} label={q.label} required={q.required}><textarea rows={2} required={q.required} value={f.answers[q.id] ?? ''} onChange={(e) => setF({ ...f, answers: { ...f.answers, [q.id]: e.target.value } })} /></Field>)}
        <input className="hp" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} aria-hidden="true" />
        {err && <p className="text-red">{err}</p>}
        <button className="btn primary" type="submit">Termin buchen</button>
      </form>}
    </div>
  );
}

function PublicCancel({ token }: { token: string }) {
  const [b, setB] = useState<any>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => { void get(`/pub/book/cancel/${token}`).then(setB).catch((e) => setErr((e as Error).message)); }, [token]);
  if (err && !b) return <div className="pub-card"><p>{err}</p></div>;
  if (!b) return null;
  return (
    <div className="pub-card">
      <div className="pub-company">{b.company}</div>
      <h1>{b.typeName}</h1>
      <p>{new Date(b.start).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' })}</p>
      {b.status === 'cancelled' || done ? <p><b>Der Termin ist abgesagt.</b></p>
        : <button className="btn danger" onClick={async () => { try { await post(`/pub/book/cancel/${token}`, {}); setDone(true); } catch (x) { setErr((x as Error).message); } }}>Termin absagen</button>}
      {err && <p className="text-red">{err}</p>}
    </div>
  );
}
