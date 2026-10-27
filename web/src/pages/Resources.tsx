import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { api, post, patch, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { fmtDate, fmtDateTime, fmtTime, isoDate } from '../lib/format';
import { Avatar, Confirm, Empty, Field, Modal, Pill, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

export interface Resource { id: string; name: string; kind: string; location: string; capacity: number | null; description: string; color: string; requiresApproval: boolean; approverId: string | null; approverName: string | null; allowedTeamIds: string[]; active: boolean; canBook: boolean }
export interface Booking { id: string; resourceId: string; resourceName: string; resourceKind: string; color: string; userId: string; userName: string; startsAt: string; endsAt: string; status: string; seriesId: string | null; title: string | null; note: string | null; mine: boolean; projectNumber: string | null }

export const KIND_META: Record<string, { label: string; icon: string }> = {
  room: { label: 'Raum', icon: 'door' }, vehicle: { label: 'Fahrzeug', icon: 'car' }, equipment: { label: 'Gerät', icon: 'equipment' }, other: { label: 'Sonstiges', icon: 'box' },
};

const DAY = 86400000;
const START_H = 7, END_H = 20, HOUR_W = 64;
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const monday = (d: Date) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const toLocalInput = (d: Date) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

/** Ressourcen buchen: Belegungsplan, eigene Buchungen, Genehmigungen */
export default function ResourcesPage() {
  useCrumbs([{ label: 'Ressourcen' }]);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'plan') as 'plan' | 'mine' | 'review';
  const { data: review } = useApi<Booking[]>('/resources/bookings/review');
  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>Ressourcen</h1><div className="sub">Besprechungsräume, Firmenwagen und Geräte reservieren – Doppelbuchungen sind ausgeschlossen.</div></div>
      </div>
      <Tabs value={tab} onChange={(v) => setParams({ tab: v })} tabs={[
        { id: 'plan', label: <><Icon name="calendar" /> Belegungsplan</> },
        { id: 'mine', label: <><Icon name="user" /> Meine Buchungen</> },
        ...(review?.length ? [{ id: 'review' as const, label: <><Icon name="check-circle" /> Zu genehmigen ({review.length})</> }] : []),
      ]} />
      {tab === 'plan' && <Plan />}
      {tab === 'mine' && <MyBookings />}
      {tab === 'review' && <Review rows={review ?? []} />}
    </div>
  );
}

function useResourceUpdates(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'resources.changed') reload(); }), [reload]);
}

function Plan() {
  const [view, setView] = useState<'day' | 'week'>('week');
  const [kind, setKind] = useState('');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const from = view === 'day' ? anchor : monday(anchor);
  const to = new Date(from.getTime() + (view === 'day' ? 1 : 7) * DAY);
  const { data: resources } = useApi<Resource[]>('/resources');
  const { data: bookings, reload } = useApi<Booking[]>(`/resources/bookings?from=${from.toISOString()}&to=${to.toISOString()}`);
  useResourceUpdates(reload);
  const [dialog, setDialog] = useState<{ resourceId?: string; start: Date; end: Date } | null>(null);
  const [detail, setDetail] = useState<Booking | null>(null);
  const list = (resources ?? []).filter((r) => r.active && (!kind || r.kind === kind));
  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * DAY));
  const step = view === 'day' ? DAY : 7 * DAY;
  const today = isoDate(new Date());

  if (resources && !resources.length) return <Empty icon="calendar" title="Noch keine Ressourcen angelegt">Administratoren legen Räume, Fahrzeuge und Geräte unter Einstellungen → Ressourcen an.</Empty>;

  return (
    <div>
      <div className="toolbar">
        <button className="btn sm" onClick={() => setAnchor(new Date(anchor.getTime() - step))}><Icon name="chevron-left" /></button>
        <button className="btn sm" onClick={() => setAnchor(startOfDay(new Date()))}>Heute</button>
        <button className="btn sm" onClick={() => setAnchor(new Date(anchor.getTime() + step))}><Icon name="chevron-right" /></button>
        <b>{view === 'day' ? from.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : `${fmtDate(from)} – ${fmtDate(new Date(to.getTime() - DAY))}`}</b>
        <input type="date" value={isoDate(anchor)} onChange={(e) => e.target.value && setAnchor(startOfDay(new Date(e.target.value)))} style={{ width: 150 }} />
        <div className="row right" style={{ gap: 6 }}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Alle Arten</option>{Object.entries(KIND_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className={`btn sm ${view === 'day' ? 'primary' : ''}`} onClick={() => setView('day')}>Tag</button>
          <button className={`btn sm ${view === 'week' ? 'primary' : ''}`} onClick={() => setView('week')}>Woche</button>
          <button className="btn primary" onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); setDialog({ start: s, end: new Date(s.getTime() + 3600000) }); }}><Icon name="plus" /> Buchen</button>
        </div>
      </div>

      <div className="table-wrap resource-plan">
        {view === 'week' ? (
          <table className="table" style={{ tableLayout: 'fixed', minWidth: 900 }}>
            <thead><tr><th style={{ width: 220 }}>Ressource</th>{days.map((d) => <th key={d.toISOString()} style={{ color: isoDate(d) === today ? 'var(--accent)' : undefined }}>{d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</th>)}</tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.id}>
                <td><ResourceLabel r={r} /></td>
                {days.map((d) => {
                  const dayEnd = new Date(d.getTime() + DAY);
                  const items = (bookings ?? []).filter((b) => b.resourceId === r.id && new Date(b.startsAt) < dayEnd && new Date(b.endsAt) > d);
                  return (
                    <td key={d.toISOString()} className="slot" style={{ verticalAlign: 'top', cursor: r.canBook ? 'copy' : 'default', background: d.getDay() % 6 === 0 ? 'var(--bg-soft)' : undefined }}
                      onClick={() => { if (!r.canBook) return; const s = new Date(d); s.setHours(9); setDialog({ resourceId: r.id, start: s, end: new Date(s.getTime() + 3600000) }); }}>
                      {items.map((b) => (
                        <div key={b.id} className={`booking-chip ${b.status === 'pending' ? 'pending' : ''}`} style={{ borderLeftColor: r.color }} onClick={(e) => { e.stopPropagation(); setDetail(b); }}
                          title={`${b.userName}${b.title ? ` – ${b.title}` : ''}`}>
                          <span className="mono">{new Date(b.startsAt) < d ? '…' : fmtTime(b.startsAt)}–{new Date(b.endsAt) > dayEnd ? '…' : fmtTime(b.endsAt)}</span> {b.mine ? 'Ich' : b.userName.split(' ')[0]}
                        </div>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        ) : (
          <div style={{ display: 'flex', minWidth: 220 + (END_H - START_H) * HOUR_W }}>
            <div style={{ width: 220, flex: 'none' }}>
              <div className="gantt-head" style={{ height: 34, padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>Ressource</div>
              {list.map((r) => <div key={r.id} style={{ height: 48, padding: '6px 10px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}><ResourceLabel r={r} /></div>)}
            </div>
            <div style={{ position: 'relative', flex: 1 }}>
              <div className="gantt-head" style={{ display: 'flex', height: 34, borderBottom: '1px solid var(--line)' }}>
                {Array.from({ length: END_H - START_H }, (_, i) => <div key={i} style={{ width: HOUR_W, flex: 'none', borderLeft: '1px solid var(--line)', padding: '8px 4px' }}>{String(START_H + i).padStart(2, '0')}:00</div>)}
              </div>
              {list.map((r) => {
                const items = (bookings ?? []).filter((b) => b.resourceId === r.id);
                return (
                  <div key={r.id} style={{ position: 'relative', height: 48, borderBottom: '1px solid var(--line)', display: 'flex' }}>
                    {Array.from({ length: (END_H - START_H) * 2 }, (_, i) => (
                      <div key={i} style={{ width: HOUR_W / 2, flex: 'none', borderLeft: i % 2 === 0 ? '1px solid var(--line)' : '1px dashed var(--line)', cursor: r.canBook ? 'copy' : 'default' }}
                        onClick={() => { if (!r.canBook) return; const s = new Date(from); s.setHours(START_H, i * 30); setDialog({ resourceId: r.id, start: s, end: new Date(s.getTime() + 3600000) }); }} />
                    ))}
                    {items.map((b) => {
                      const s = Math.max(new Date(b.startsAt).getTime(), from.getTime() + START_H * 3600000);
                      const e = Math.min(new Date(b.endsAt).getTime(), from.getTime() + END_H * 3600000);
                      if (e <= s) return null;
                      const left = ((s - from.getTime()) / 3600000 - START_H) * HOUR_W;
                      return (
                        <div key={b.id} className={`booking-bar ${b.status === 'pending' ? 'pending' : ''}`} style={{ left, width: Math.max(18, ((e - s) / 3600000) * HOUR_W - 2), background: r.color }}
                          onClick={() => setDetail(b)} title={`${fmtTime(b.startsAt)}–${fmtTime(b.endsAt)} ${b.userName}`}>
                          {fmtTime(b.startsAt)} {b.mine ? 'Ich' : b.userName}{b.title ? ` · ${b.title}` : ''}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>Auf eine freie Stelle klicken, um zu buchen. Gestrichelt umrandete Buchungen warten noch auf Genehmigung. Kollegen sehen nur, von wem eine Ressource belegt ist – den Anlass sehen nur Sie und der Genehmiger.</p>
      {dialog && <BookingDialog resources={(resources ?? []).filter((r) => r.active && r.canBook)} initial={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {detail && <BookingDetail booking={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); reload(); }} />}
    </div>
  );
}

export function ResourceLabel({ r }: { r: Pick<Resource, 'name' | 'kind' | 'color' | 'location' | 'capacity' | 'requiresApproval'> }) {
  return (
    <div className="row" style={{ gap: 8, minWidth: 0 }}>
      <span className="resource-icon" style={{ color: r.color, background: `${r.color}1f` }}><Icon name={KIND_META[r.kind]?.icon ?? 'box'} /></span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
        <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {[r.location, r.capacity ? `${r.capacity} ${r.kind === 'vehicle' ? 'Sitze' : 'Plätze'}` : '', r.requiresApproval ? 'mit Genehmigung' : ''].filter(Boolean).join(' · ')}
        </div>
      </div>
    </div>
  );
}

function BookingDialog({ resources, initial, onClose, onDone }: { resources: Resource[]; initial: { resourceId?: string; start: Date; end: Date }; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const { data: projects } = useApi<any[]>('/projects');
  const [d, setD] = useState({ resourceId: initial.resourceId ?? resources[0]?.id ?? '', start: toLocalInput(initial.start), end: toLocalInput(initial.end), title: '', note: '', projectId: '', repeat: false, until: '' });
  const [error, setError] = useState<{ message: string; alternatives: { id: string; name: string }[] } | null>(null);
  const [free, setFree] = useState<{ id: string; name: string }[] | null>(null);
  const r = resources.find((x) => x.id === d.resourceId);

  useEffect(() => {
    if (!d.start || !d.end || new Date(d.end) <= new Date(d.start)) { setFree(null); return; }
    const t = setTimeout(() => post('/resources/availability', { startsAt: new Date(d.start).toISOString(), endsAt: new Date(d.end).toISOString(), kind: r?.kind }).then(setFree).catch(() => setFree(null)), 250);
    return () => clearTimeout(t);
  }, [d.start, d.end, r?.kind]);
  const isFree = free ? free.some((f) => f.id === d.resourceId) : null;

  const submit = async () => {
    setError(null);
    try {
      const res = await api<{ status: string; count: number }>('/resources/bookings', { method: 'POST', body: {
        resourceId: d.resourceId, startsAt: new Date(d.start).toISOString(), endsAt: new Date(d.end).toISOString(), title: d.title, note: d.note,
        projectId: d.projectId || null, repeatWeeklyUntil: d.repeat && d.until ? d.until : null,
      } });
      await act(async () => res, res.status === 'pending' ? 'Anfrage gesendet – wartet auf Genehmigung' : `Gebucht${res.count > 1 ? ` (${res.count} Termine)` : ''}`);
      invalidate('/resources'); invalidate('/calendar');
      onDone();
    } catch (e) {
      const err = e as Error;
      const det = await fetchAlternatives();
      setError({ message: err.message, alternatives: det });
    }
  };
  async function fetchAlternatives() {
    return (await post('/resources/availability', { startsAt: new Date(d.start).toISOString(), endsAt: new Date(d.end).toISOString(), kind: r?.kind }).catch(() => [])).filter((x: any) => x.id !== d.resourceId);
  }

  return (
    <Modal title="Ressource buchen" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.resourceId || isFree === false} onClick={submit}>{r?.requiresApproval ? 'Anfrage senden' : 'Buchen'}</button>
    </>}>
      <Field label="Ressource" required>
        <select value={d.resourceId} onChange={(e) => setD({ ...d, resourceId: e.target.value })}>
          {Object.entries(KIND_META).map(([k, v]) => {
            const group = resources.filter((x) => x.kind === k);
            return group.length ? <optgroup key={k} label={v.label}>{group.map((x) => <option key={x.id} value={x.id}>{x.name}{x.location ? ` (${x.location})` : ''}</option>)}</optgroup> : null;
          })}
        </select>
      </Field>
      {r?.description && <div className="hint" style={{ marginTop: -8, marginBottom: 10 }}>{r.description}</div>}
      <div className="grid2">
        <Field label="Von" required><input type="datetime-local" value={d.start} onChange={(e) => { const s = e.target.value; const dur = new Date(d.end).getTime() - new Date(d.start).getTime(); setD({ ...d, start: s, end: toLocalInput(new Date(new Date(s).getTime() + (dur > 0 ? dur : 3600000))) }); }} /></Field>
        <Field label="Bis" required><input type="datetime-local" value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} /></Field>
      </div>
      {isFree !== null && (
        <div className={`card flat row`} style={{ marginBottom: 12, borderColor: isFree ? 'var(--green)' : 'var(--red)' }}>
          <Icon name={isFree ? 'check-circle' : 'x-circle'} style={{ color: isFree ? 'var(--green)' : 'var(--red)' }} />
          <span>{isFree ? 'Im gewählten Zeitraum frei.' : 'Im gewählten Zeitraum belegt.'}</span>
          {!isFree && free && free.length > 0 && <span className="small">Frei wären: {free.filter((f) => f.id !== d.resourceId).slice(0, 4).map((f) => <a key={f.id} style={{ cursor: 'pointer', marginRight: 8 }} onClick={() => setD({ ...d, resourceId: f.id })}>{f.name}</a>)}</span>}
        </div>
      )}
      <Field label="Anlass" hint="sehen nur Sie und der Genehmiger"><input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="z. B. Kundentermin, Baustelle Ulm" /></Field>
      <Field label="Projekt (optional)"><select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })}><option value="">–</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
      <label className="row" style={{ marginBottom: 8 }}><input type="checkbox" checked={d.repeat} onChange={(e) => setD({ ...d, repeat: e.target.checked })} /> <Icon name="repeat" /> Wöchentlich wiederholen</label>
      {d.repeat && <Field label="Wiederholen bis"><input type="date" value={d.until} min={d.start.slice(0, 10)} onChange={(e) => setD({ ...d, until: e.target.value })} /></Field>}
      {r?.requiresApproval && <div className="hint"><Icon name="info" /> Diese Ressource muss genehmigt werden{r.approverName ? ` (durch ${r.approverName})` : ''}.</div>}
      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', marginTop: 10 }}>
          <div className="error-text">{error.message}</div>
          {error.alternatives.length > 0 && <div className="row wrap" style={{ marginTop: 8 }}>{error.alternatives.slice(0, 5).map((a) => <button key={a.id} className="btn sm" onClick={() => { setD({ ...d, resourceId: a.id }); setError(null); }}>{a.name} nehmen</button>)}</div>}
        </div>
      )}
    </Modal>
  );
}

function BookingDetail({ booking: b, onClose, onChanged }: { booking: Booking; onClose: () => void; onChanged: () => void }) {
  const act = useAction();
  const { me } = useSession();
  const [cancel, setCancel] = useState<null | 'one' | 'series'>(null);
  const [edit, setEdit] = useState(false);
  const [times, setTimes] = useState({ start: toLocalInput(new Date(b.startsAt)), end: toLocalInput(new Date(b.endsAt)), title: b.title ?? '' });
  const canChange = b.mine || me?.role === 'admin';
  return (
    <Modal title={b.resourceName} onClose={onClose} footer={canChange ? <>
      {b.seriesId && <button className="btn danger" onClick={() => setCancel('series')}>Ganze Serie stornieren</button>}
      <button className="btn danger" onClick={() => setCancel('one')}>Stornieren</button>
      {b.mine && !edit && <button className="btn primary" onClick={() => setEdit(true)}>Verschieben</button>}
      {edit && <button className="btn primary" onClick={async () => {
        const r = await act(() => patch(`/resources/bookings/${b.id}`, { startsAt: new Date(times.start).toISOString(), endsAt: new Date(times.end).toISOString(), title: times.title }), 'Gespeichert');
        if (r) onChanged();
      }}>Speichern</button>}
    </> : <button className="btn" onClick={onClose}>Schließen</button>}>
      <div className="row" style={{ marginBottom: 10 }}><Avatar id={b.userId} name={b.userName} /><b>{b.userName}</b>{b.status === 'pending' && <Pill tone="amber">wartet auf Genehmigung</Pill>}{b.seriesId && <Pill><Icon name="repeat" size={12} /> Serie</Pill>}</div>
      {edit ? (
        <>
          <div className="grid2">
            <Field label="Von"><input type="datetime-local" value={times.start} onChange={(e) => setTimes({ ...times, start: e.target.value })} /></Field>
            <Field label="Bis"><input type="datetime-local" value={times.end} onChange={(e) => setTimes({ ...times, end: e.target.value })} /></Field>
          </div>
          <Field label="Anlass"><input value={times.title} onChange={(e) => setTimes({ ...times, title: e.target.value })} /></Field>
        </>
      ) : (
        <table className="table"><tbody>
          <tr><td className="muted">Zeitraum</td><td>{fmtDateTime(b.startsAt)} – {fmtDateTime(b.endsAt)}</td></tr>
          {b.title !== null && <tr><td className="muted">Anlass</td><td>{b.title || '–'}</td></tr>}
          {b.projectNumber && <tr><td className="muted">Projekt</td><td>{b.projectNumber}</td></tr>}
        </tbody></table>
      )}
      {cancel && <Confirm danger text={cancel === 'series' ? 'Diesen und alle folgenden Termine der Serie stornieren?' : 'Buchung stornieren?'} onClose={() => setCancel(null)} onConfirm={async () => {
        const reason = !b.mine ? prompt('Grund für die Stornierung (wird dem Buchenden mitgeteilt)') ?? '' : '';
        await act(() => post(`/resources/bookings/${b.id}/cancel`, { series: cancel === 'series', reason }), 'Storniert');
        invalidate('/calendar');
        onChanged();
      }} />}
    </Modal>
  );
}

function MyBookings() {
  const from = useMemo(() => new Date(Date.now() - DAY), []);
  const to = useMemo(() => new Date(Date.now() + 365 * DAY), []);
  const { data, reload } = useApi<Booking[]>(`/resources/bookings?mine=1&from=${from.toISOString()}&to=${to.toISOString()}`);
  useResourceUpdates(reload);
  const [detail, setDetail] = useState<Booking | null>(null);
  if (!data?.length) return <Empty icon="calendar" title="Keine anstehenden Buchungen" />;
  return (
    <>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Ressource</th><th>Zeitraum</th><th>Anlass</th><th>Status</th></tr></thead>
        <tbody>{data.map((b) => (
          <tr key={b.id} className="click" onClick={() => setDetail(b)}>
            <td><span className="row" style={{ gap: 6 }}><Icon name={KIND_META[b.resourceKind]?.icon ?? 'box'} style={{ color: b.color }} />{b.resourceName}</span></td>
            <td>{fmtDateTime(b.startsAt)} – {fmtTime(b.endsAt)}{b.seriesId && <Icon name="repeat" size={13} style={{ marginLeft: 6 }} />}</td>
            <td>{b.title || <span className="muted">–</span>}</td>
            <td>{b.status === 'pending' ? <Pill tone="amber">wartet auf Genehmigung</Pill> : <Pill tone="green">bestätigt</Pill>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {detail && <BookingDetail booking={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); reload(); }} />}
    </>
  );
}

function Review({ rows }: { rows: Booking[] }) {
  const act = useAction();
  if (!rows.length) return <Empty icon="calendar" title="Keine offenen Anfragen" />;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Ressource</th><th>Wer</th><th>Zeitraum</th><th>Anlass</th><th /></tr></thead>
      <tbody>{rows.map((b) => (
        <tr key={b.id}>
          <td>{b.resourceName}</td>
          <td><span className="row" style={{ gap: 6 }}><Avatar id={b.userId} name={b.userName} />{b.userName}</span></td>
          <td>{fmtDateTime(b.startsAt)} – {fmtTime(b.endsAt)}{b.seriesId && <Pill><Icon name="repeat" size={12} /> Serie</Pill>}</td>
          <td>{b.title || '–'}{b.note && <div className="small muted">{b.note}</div>}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            <button className="btn sm primary" onClick={async () => { await act(() => post(`/resources/bookings/${b.id}/decide`, { approve: true }), 'Genehmigt'); invalidate('/resources'); }}>Genehmigen</button>{' '}
            <button className="btn sm danger" onClick={async () => { const note = prompt('Begründung (optional)') ?? ''; await act(() => post(`/resources/bookings/${b.id}/decide`, { approve: false, note }), 'Abgelehnt'); invalidate('/resources'); }}>Ablehnen</button>
          </td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
