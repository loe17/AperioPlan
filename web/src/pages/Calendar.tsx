import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { invalidate } from '../lib/api';
import { useCan } from '../session';
import { EventModal, loadEvent, type CalEvent } from '../modules/EventModal';
import { useApi } from '../lib/hooks';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { useT } from '../i18n';
import { isoDate } from '../lib/format';
import { Icon } from '../components/Icon';

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Mein Kalender (Fristen, eigene Abwesenheiten, Feiertage) bzw. DSGVO-sauberer Teamkalender */
export default function CalendarPage({ mode }: { mode: 'me' | 'team' }) {
  const t = useT();
  const nav = useNavigate();
  const { teams, me } = useSession();
  useCrumbs([{ label: mode === 'me' ? `${t('Mein Kalender')}` : `${t('Teamkalender')}` }]);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [teamId, setTeamId] = useState(me?.teams[0]?.id ?? '');
  const start = new Date(month); start.setDate(1 - ((month.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(start.getDate() + 41);
  const from = isoDate(start), to = isoDate(end);
  const { data: mine } = useApi<any>(mode === 'me' ? `/calendar/me?from=${from}&to=${to}` : null);
  const { data: team } = useApi<any[]>(`/calendar/team?from=${from}&to=${to}${mode === 'team' && teamId ? `&teamId=${teamId}` : ''}`);
  const { data: holidays } = useApi<any[]>(`/holidays?year=${month.getFullYear()}`);
  const can = useCan();
  const isoFrom = start.toISOString(), isoTo = new Date(end.getTime() + 86400000).toISOString();
  const eventsUrl = mode === 'me' ? `/calendar/events?from=${isoFrom}&to=${isoTo}` : `/calendar/team/events?from=${isoFrom}&to=${isoTo}${teamId ? `&teamId=${teamId}` : ''}`;
  const { data: events, reload: reloadEvents } = useApi<CalEvent[]>(can('calendar') ? eventsUrl : null);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<{ event?: CalEvent | null; date?: string } | null>(null);
  useEffect(() => {
    const id = params.get('event');
    if (id) loadEvent(id).then((e) => setOpen({ event: e })).catch(() => {}).finally(() => { params.delete('event'); setParams(params, { replace: true }); });
  }, [params.get('event')]); // eslint-disable-line react-hooks/exhaustive-deps
  const dayEvents = (k: string) => (events ?? []).filter((e) => {
    const s = isoDate(new Date(e.startsAt));
    const en = isoDate(new Date(new Date(e.endsAt).getTime() - (e.allDay ? 1 : 0)));
    return s <= k && en >= k;
  });
  const openEvent = async (e: CalEvent) => {
    if (!e.attendees) {
      // Termin eines Kollegen: Einzelheiten nur für Teilnehmer
      const full = await loadEvent(e.id).catch(() => null);
      if (full) setOpen({ event: full });
      return;
    }
    setOpen({ event: e });
  };

  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; }), [from]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = isoDate(new Date());
  const holidayMap = new Map((mode === 'me' ? mine?.holidays : holidays)?.map((h: any) => [h.day, h.name]) ?? []);

  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>{mode === 'me' ? t('Mein Kalender') : t('Teamkalender')}</h1>
          <div className="sub">{mode === 'team' ? 'Abwesenheiten (ohne Gründe) und Termine der Kollegen – private Termine nur als „belegt“.' : 'Termine, Fristen Ihrer Aufgaben, Abwesenheiten und Feiertage – Doppelklick auf einen Tag legt einen Termin an'}</div></div>
        <div className="actions">
          {can('calendar') && mode === 'me' && <Link className="btn ghost" to="/settings/calendar"><Icon name="refresh" /> Kalender verbinden</Link>}
          {can('calendar') && <button className="btn primary" onClick={() => setOpen({ date: isoDate(new Date()) })}><Icon name="plus" /> Termin</button>}
          {mode === 'team' && <select value={teamId} onChange={(e) => setTeamId(e.target.value)} style={{ width: 'auto' }}><option value="">Alle Teams</option>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}</select>}
          <button className="btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
          <button className="btn" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>{t('Heute')}</button>
          <button className="btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
        </div>
      </div>
      <h2 style={{ marginBottom: 10 }}>{month.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}</h2>
      <div className="cal">
        {WD.map((w) => <div key={w} className="cal-head">{w}</div>)}
        {days.map((d) => {
          const k = isoDate(d);
          const wd = (d.getDay() + 6) % 7;
          const absences = (team ?? []).filter((a) => a.startDate <= k && a.endDate >= k);
          const ownAbs = mode === 'me' ? (mine?.absences ?? []).filter((a: any) => a.startDate <= k && a.endDate >= k) : [];
          const tasks = mode === 'me' ? (mine?.tasks ?? []).filter((x: any) => x.dueDate === k) : [];
          const hol = holidayMap.get(k);
          return (
            <div key={k} className={`cal-day ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${wd >= 5 ? 'weekend' : ''} ${k === today ? 'today' : ''}`}
              onDoubleClick={(e) => { if (can('calendar') && e.target === e.currentTarget) setOpen({ date: k }); }} title={can('calendar') ? 'Doppelklick: neuer Termin' : undefined}>
              <span className="num">{d.getDate()}</span>
              {hol && <div className="cal-ev holiday" title={String(hol)}><Icon name="holiday" /> {String(hol)}</div>}
              {ownAbs.map((a: any) => <div key={a.id} className={`cal-ev absent ${a.status === 'pending' ? 'pending' : ''}`}>{a.kind === 'vacation' ? 'Urlaub' : 'Abwesend'}{a.status === 'pending' ? ' (beantragt)' : ''}</div>)}
              {mode === 'me' && (mine?.bookings ?? []).filter((b: any) => isoDate(new Date(b.startsAt)) <= k && isoDate(new Date(b.endsAt)) >= k).map((b: any) => (
                <div key={b.id} className={`cal-ev booking ${b.status === 'pending' ? 'pending' : ''}`} style={{ cursor: 'pointer', borderLeft: `3px solid ${b.color}` }} onClick={() => nav('/calendar/resources?tab=mine')} title={b.title ?? ''}>
                  {new Date(b.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} {b.resourceName}
                </div>
              ))}
              {dayEvents(k).map((e) => (
                <div key={`${e.id}-${e.occurrence ?? ''}`} className={`cal-ev event ${e.myResponse === 'pending' ? 'pending' : ''}`} style={{ cursor: 'pointer', borderLeft: `3px solid ${e.accountColor || 'var(--accent)'}` }}
                  title={`${e.title}${e.location ? ` · ${e.location}` : ''}${mode === 'team' ? ` (${e.ownerName})` : ''}`} onClick={() => openEvent(e)}>
                  {!e.allDay && isoDate(new Date(e.startsAt)) === k && `${new Date(e.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} `}
                  {mode === 'team' ? `${e.ownerName}: ` : ''}{e.private && mode === 'me' && <Icon name="lock" />} {e.title}
                </div>
              ))}
              {tasks.map((x: any) => <div key={x.id} className="cal-ev task" style={{ cursor: 'pointer' }} onClick={() => nav(`/projects/${x.projectId}?task=${x.id}`)} title={x.title}>{x.milestone ? <Icon name="milestone" className="mr" /> : <Icon name="pin" />} {x.projectNumber} {x.title}</div>)}
              {(mode === 'team' ? absences : absences.filter((a) => a.userId !== me?.id)).map((a, i) => (
                <div key={i} className={`cal-ev absent ${a.status === 'pending' ? 'pending' : ''}`} title={`${a.userName}: Abwesend`}>{a.userName}{(a.startDate === k && a.halfDayStart) || (a.endDate === k && a.halfDayEnd) ? ' (½)' : ''}{a.status === 'pending' ? ' ?' : ''}</div>
              ))}
            </div>
          );
        })}
      </div>
      {open && <EventModal event={open.event} defaults={{ date: open.date }} onClose={() => setOpen(null)}
        onSaved={() => { setOpen(null); void reloadEvents(); invalidate('/calendar/me'); }} />}
    </div>
  );
}
