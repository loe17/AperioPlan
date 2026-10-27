import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; }), [from]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = isoDate(new Date());
  const holidayMap = new Map((mode === 'me' ? mine?.holidays : holidays)?.map((h: any) => [h.day, h.name]) ?? []);

  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>{mode === 'me' ? t('Mein Kalender') : t('Teamkalender')}</h1>
          <div className="sub">{mode === 'team' ? 'Zeigt nur, wer wann „Abwesend“ ist – keine Gründe, keine Krankheiten.' : 'Fristen Ihrer Aufgaben, Ihre Abwesenheiten und Feiertage'}</div></div>
        <div className="actions">
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
            <div key={k} className={`cal-day ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${wd >= 5 ? 'weekend' : ''} ${k === today ? 'today' : ''}`}>
              <span className="num">{d.getDate()}</span>
              {hol && <div className="cal-ev holiday" title={String(hol)}><Icon name="holiday" /> {String(hol)}</div>}
              {ownAbs.map((a: any) => <div key={a.id} className={`cal-ev absent ${a.status === 'pending' ? 'pending' : ''}`}>{a.kind === 'vacation' ? 'Urlaub' : 'Abwesend'}{a.status === 'pending' ? ' (beantragt)' : ''}</div>)}
              {mode === 'me' && (mine?.bookings ?? []).filter((b: any) => isoDate(new Date(b.startsAt)) <= k && isoDate(new Date(b.endsAt)) >= k).map((b: any) => (
                <div key={b.id} className={`cal-ev booking ${b.status === 'pending' ? 'pending' : ''}`} style={{ cursor: 'pointer', borderLeft: `3px solid ${b.color}` }} onClick={() => nav('/calendar/resources?tab=mine')} title={b.title ?? ''}>
                  {new Date(b.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} {b.resourceName}
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
    </div>
  );
}
