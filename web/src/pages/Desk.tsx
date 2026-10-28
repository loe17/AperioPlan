import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DEFAULT_DASHBOARD, type DashboardWidget, type DashboardWidgetType } from '@aperio/shared';
import { useApi } from '../lib/hooks';
import { get, put, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useCan, useMe } from '../session';
import { useT } from '../i18n';
import { Empty, Modal, Pill, useAction } from '../components/ui';
import { fmtDate, fmtTime } from '../lib/format';
import { ClockWidget } from './Time';
import { ProjectCards, type ProjectRow } from './Projects';
import type { Task } from '../components/TaskPanel';
import { Icon } from '../components/Icon';

interface Catalog { type: DashboardWidgetType; label: string; icon: string; desc: string; size: 1 | 2 | 3 | 4; tool?: string }
const CATALOG: Catalog[] = [
  { type: 'clock', label: 'Uhr', icon: 'clock', desc: 'Uhrzeit und Datum, auf Wunsch mit zweiter Zeitzone', size: 1 },
  { type: 'weather', label: 'Wetter', icon: 'cloud-sun', desc: 'Aktuelles Wetter und Vorhersage für Ihren Ort', size: 2 },
  { type: 'stats', label: 'Überblick', icon: 'chart', desc: 'Offene, überfällige und erledigte Aufgaben', size: 2 },
  { type: 'tasks', label: 'Meine Aufgaben', icon: 'check-circle', desc: 'Ihre offenen Aufgaben nach Frist', size: 2 },
  { type: 'stamp', label: 'Stempeluhr', icon: 'timer', desc: 'Ein- und ausstempeln', size: 1, tool: 'time' },
  { type: 'today', label: 'Heute', icon: 'calendar', desc: 'Ihre Termine heute und morgen', size: 2, tool: 'calendar' },
  { type: 'favorites', label: 'Favoriten', icon: 'star', desc: 'Ihre Lieblingsprojekte', size: 4 },
  { type: 'notifications', label: 'Benachrichtigungen', icon: 'bell', desc: 'Neueste ungelesene Hinweise', size: 2 },
  { type: 'note', label: 'Notizzettel', icon: 'note', desc: 'Kurze Notiz direkt auf der Startseite', size: 1 },
  { type: 'links', label: 'Schnellzugriff', icon: 'link', desc: 'Eigene Links, z. B. Intranet oder Lieferantenportal', size: 1 },
  { type: 'absent', label: 'Heute abwesend', icon: 'palm', desc: 'Wer ist heute nicht im Haus?', size: 1, tool: 'absences' },
  { type: 'mail', label: 'E-Mail', icon: 'mail', desc: 'Ungelesene Nachrichten im Posteingang', size: 2, tool: 'mail' },
  { type: 'crm', label: 'Kundentermine', icon: 'building', desc: 'Anstehende Kundentermine und lange nicht kontaktierte Kunden', size: 2, tool: 'crm' },
  { type: 'deliveries', label: 'Liefertermine', icon: 'truck', desc: 'Erwartete Lieferungen aus dem Einkauf', size: 2, tool: 'purchasing' },
  { type: 'board', label: 'Schwarzes Brett', icon: 'pin', desc: 'Neueste Mitteilungen', size: 2, tool: 'board' },
  { type: 'meetings', label: 'Meetings', icon: 'video', desc: 'Ihre nächsten Videokonferenzen', size: 2, tool: 'meetings' },
  { type: 'calls', label: 'Verpasste Anrufe', icon: 'phone', desc: 'Anrufe, die niemand angenommen hat', size: 1, tool: 'phone' },
];

const ZONES = ['', 'Europe/London', 'Europe/Moscow', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney'];
const zoneLabel = (z: string) => z.split('/').pop()!.replace(/_/g, ' ');

export function DeskPage() {
  const t = useT();
  const me = useMe();
  const can = useCan();
  const act = useAction();
  useCrumbs([{ label: `${t('Mein Schreibtisch')}` }]);
  const { data } = useApi<{ widgets: DashboardWidget[]; weatherLocation: any; isDefault: boolean }>('/me/dashboard');
  const [widgets, setWidgets] = useState<DashboardWidget[] | null>(null);
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  useEffect(() => { if (data && !widgets) setWidgets(data.widgets); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = new Date().getHours();
  const greet = h < 11 ? t('Guten Morgen') : h < 18 ? t('Guten Tag') : t('Guten Abend');
  const allowed = (w: DashboardWidget) => { const c = CATALOG.find((x) => x.type === w.type); return c && (!c.tool || can(c.tool)) && !(me.role === 'guest' && c.tool); };
  const save = async (next: DashboardWidget[]) => { setWidgets(next); await put('/me/dashboard', { widgets: next }).catch(() => {}); };
  const update = (id: string, patch: Partial<DashboardWidget>) => widgets && save(widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const remove = (id: string) => widgets && save(widgets.filter((w) => w.id !== id));
  const move = (from: string, to: string) => {
    if (!widgets || from === to) return;
    const list = [...widgets];
    const i = list.findIndex((w) => w.id === from), j = list.findIndex((w) => w.id === to);
    const [w] = list.splice(i, 1);
    list.splice(j, 0, w!);
    void save(list);
  };
  const shown = (widgets ?? []).filter(allowed);

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{greet}, {me.displayName.split(' ')[0]}</h1>
          <div className="sub">{new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        </div>
        <div className="actions">
          {edit && <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" /> Kachel hinzufügen</button>}
          {edit && <button className="btn ghost" title="Auf die Voreinstellung zurücksetzen" onClick={async () => { if (await act(() => put('/me/dashboard', { widgets: null }), 'Zurückgesetzt')) setWidgets(DEFAULT_DASHBOARD); }}><Icon name="undo" /></button>}
          <button className={`btn ${edit ? 'primary' : ''}`} onClick={() => setEdit(!edit)}><Icon name={edit ? 'check' : 'layout'} /> {edit ? 'Fertig' : 'Startseite anpassen'}</button>
        </div>
      </div>
      {widgets && !shown.length && <Empty icon="layout" title="Ihre Startseite ist leer">Über „Startseite anpassen“ fügen Sie Kacheln hinzu.</Empty>}
      <div className={`dash-grid ${edit ? 'editing' : ''}`}>
        {shown.map((w) => {
          const c = CATALOG.find((x) => x.type === w.type)!;
          return (
            <div key={w.id} className={`dash-tile s${w.size} ${drag === w.id ? 'dragging' : ''}`} draggable={edit}
              onDragStart={(e) => { setDrag(w.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDrag(null)}
              onDragOver={(e) => { if (edit && drag) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (drag) move(drag, w.id); setDrag(null); }}>
              {edit && (
                <div className="dash-edit">
                  <Icon name="grip" />
                  <span className="grow small">{c.label}</span>
                  <button className="btn ghost sm" title="Schmaler" disabled={w.size <= 1} onClick={() => update(w.id, { size: (w.size - 1) as 1 })}>−</button>
                  <button className="btn ghost sm" title="Breiter" disabled={w.size >= 4} onClick={() => update(w.id, { size: (w.size + 1) as 2 })}>+</button>
                  <button className="btn ghost sm" title="Entfernen" onClick={() => remove(w.id)}><Icon name="x" /></button>
                </div>
              )}
              <Widget w={w} edit={edit} weatherLocation={data?.weatherLocation} onConfig={(config) => update(w.id, { config })} />
            </div>
          );
        })}
      </div>
      {adding && (
        <Modal title="Kachel hinzufügen" onClose={() => setAdding(false)}>
          <div className="dash-catalog">
            {CATALOG.filter((c) => !c.tool || can(c.tool)).map((c) => (
              <button key={c.type} className="dash-cat" onClick={() => { void save([...(widgets ?? []), { id: Math.random().toString(36).slice(2, 9), type: c.type, size: c.size }]); setAdding(false); }}>
                <Icon name={c.icon} size={20} /><div><b>{c.label}</b><div className="small muted">{c.desc}</div></div>
                {widgets?.some((w) => w.type === c.type) && <Pill>schon da</Pill>}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Tile({ title, icon, to, children, action }: { title: string; icon: string; to?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="dash-card">
      <div className="dash-head"><Icon name={icon} /> {to ? <Link to={to}>{title}</Link> : <span>{title}</span>}<span className="grow" />{action}</div>
      <div className="dash-body">{children}</div>
    </div>
  );
}

function Widget({ w, edit, weatherLocation, onConfig }: { w: DashboardWidget; edit: boolean; weatherLocation: any; onConfig: (c: Record<string, unknown>) => void }) {
  switch (w.type) {
    case 'clock': return <ClockTile w={w} edit={edit} onConfig={onConfig} />;
    case 'weather': return <WeatherTile initial={weatherLocation} />;
    case 'stats': return <StatsTile />;
    case 'tasks': return <TasksTile />;
    case 'stamp': return <ClockWidget compact />;
    case 'today': return <TodayTile />;
    case 'favorites': return <FavoritesTile />;
    case 'notifications': return <NotificationsTile />;
    case 'note': return <NoteTile w={w} onConfig={onConfig} />;
    case 'links': return <LinksTile w={w} edit={edit} onConfig={onConfig} />;
    case 'absent': return <AbsentTile />;
    case 'mail': return <MailTile />;
    case 'crm': return <CrmTile />;
    case 'deliveries': return <DeliveriesTile />;
    case 'board': return <BoardTile />;
    case 'meetings': return <MeetingsTile />;
    case 'calls': return <CallsTile />;
    default: return null;
  }
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

function ClockTile({ w, edit, onConfig }: { w: DashboardWidget; edit: boolean; onConfig: (c: Record<string, unknown>) => void }) {
  const now = useNow();
  const zone = String(w.config?.zone ?? '');
  const analog = Boolean(w.config?.analog);
  const t = (tz?: string) => now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
  const hh = now.getHours() % 12, mm = now.getMinutes(), ss = now.getSeconds();
  return (
    <div className="dash-card clock-tile">
      {analog ? (
        <svg viewBox="0 0 100 100" className="analog">
          <circle cx="50" cy="50" r="46" className="face" />
          {Array.from({ length: 12 }, (_, i) => <line key={i} x1="50" y1="8" x2="50" y2={i % 3 ? 12 : 15} transform={`rotate(${i * 30} 50 50)`} className="tick" />)}
          <line x1="50" y1="50" x2="50" y2="26" transform={`rotate(${hh * 30 + mm / 2} 50 50)`} className="hand h" />
          <line x1="50" y1="50" x2="50" y2="15" transform={`rotate(${mm * 6 + ss / 10} 50 50)`} className="hand m" />
          <line x1="50" y1="56" x2="50" y2="12" transform={`rotate(${ss * 6} 50 50)`} className="hand s" />
          <circle cx="50" cy="50" r="2.5" className="pin" />
        </svg>
      ) : <div className="big-time">{t()}<span className="sec">{String(ss).padStart(2, '0')}</span></div>}
      <div className="small muted">{now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })} · KW {isoWeek(now)}</div>
      {zone && <div className="small" style={{ marginTop: 4 }}><Icon name="globe" /> {zoneLabel(zone)}: <b>{t(zone)}</b></div>}
      {edit && (
        <div className="row wrap small" style={{ marginTop: 8, gap: 6 }}>
          <label className="row"><input type="checkbox" checked={analog} onChange={(e) => onConfig({ ...w.config, analog: e.target.checked })} /> Zeiger</label>
          <select value={zone} onChange={(e) => onConfig({ ...w.config, zone: e.target.value })} style={{ width: 'auto' }}>
            {ZONES.map((z) => <option key={z} value={z}>{z ? zoneLabel(z) : 'keine 2. Zeitzone'}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y.getTime()) / 86400000 + 1) / 7);
}

function WeatherTile({ initial }: { initial: { name: string; latitude: number; longitude: number } | null }) {
  const [loc, setLoc] = useState(initial);
  const [search, setSearch] = useState(!initial);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const { data, error } = useApi<any>(loc ? `/weather?lat=${loc.latitude}&lon=${loc.longitude}` : null);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(() => { get<any[]>(`/weather/search?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits([])); }, 300);
    return () => clearTimeout(id);
  }, [q]);
  const choose = async (h: any) => {
    const l = { name: h.name, latitude: h.latitude, longitude: h.longitude };
    await put('/me/weather-location', l).catch(() => {});
    setLoc(l); setSearch(false); setQ(''); invalidate('/me/dashboard');
  };
  return (
    <Tile title={loc ? `Wetter ${loc.name}` : 'Wetter'} icon="cloud-sun" action={loc && <button className="btn ghost sm" title="Ort ändern" onClick={() => setSearch(!search)}><Icon name="location" /></button>}>
      {search ? (
        <div>
          <input autoFocus placeholder="Ort suchen, z. B. Furtwangen" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.map((h, i) => <div key={i} className="dash-row click" onClick={() => choose(h)}><b>{h.name}</b> <span className="small muted">{h.region}</span></div>)}
        </div>
      ) : error ? <div className="small muted">{(error as Error).message}</div> : !data ? <div className="small muted">Wird geladen …</div> : (
        <div className="weather">
          <div className="row" style={{ gap: 12 }}>
            <Icon name={data.current.icon === 'sun' && !data.current.isDay ? 'moon' : data.current.icon} size={44} />
            <div><div className="big-temp">{Math.round(data.current.temperature)}°</div><div className="small">{data.current.text}</div></div>
            <div className="small muted grow" style={{ textAlign: 'right' }}>gefühlt {Math.round(data.current.feelsLike)}°<br />Wind {Math.round(data.current.wind)} km/h<br />Feuchte {data.current.humidity} %</div>
          </div>
          <div className="weather-days">
            {data.days.slice(1, 4).map((d: any) => (
              <div key={d.date} className="weather-day">
                <div className="small muted">{new Date(d.date).toLocaleDateString('de-DE', { weekday: 'short' })}</div>
                <Icon name={d.icon} size={22} /><div className="small"><b>{Math.round(d.max)}°</b> / {Math.round(d.min)}°</div>
                {d.rain != null && <div className="small muted">{d.rain} %</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Tile>
  );
}

function StatsTile() {
  const { data } = useApi<any>('/dashboard/stats');
  const items: [string, number | undefined, string, string?][] = [['Offene Aufgaben', data?.openTasks, 'check-circle'], ['Überfällig', data?.overdue, 'alert', 'var(--red)'], ['Diese Woche fällig', data?.dueWeek, 'calendar'], ['Erledigt (7 Tage)', data?.doneWeek, 'check', 'var(--green)']];
  return (
    <Tile title="Überblick" icon="chart">
      <div className="dash-stats">{items.map(([l, v, i, c]) => <div key={l}><div className="stat" style={c && v ? { color: c } : undefined}>{v ?? '–'}</div><div className="small muted"><Icon name={i} /> {l}</div></div>)}</div>
    </Tile>
  );
}

function TasksTile() {
  const nav = useNavigate();
  const { data } = useApi<Task[]>('/tasks/mine');
  const today = new Date(new Date().toDateString());
  const list = [...(data ?? [])].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).slice(0, 8);
  return (
    <Tile title={`Meine Aufgaben${data ? ` (${data.length})` : ''}`} icon="check-circle">
      {!list.length ? <div className="small muted">Keine offenen Aufgaben</div> : list.map((x) => (
        <div key={x.id} className="dash-row click" onClick={() => nav(`/projects/${x.projectId}?task=${x.id}`)}>
          <span className="grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.title}</span>
          <span className="small muted mono">{x.projectNumber}</span>
          {x.dueDate && <span className="small" style={{ color: new Date(x.dueDate) < today ? 'var(--red)' : undefined }}>{fmtDate(x.dueDate)}</span>}
        </div>
      ))}
    </Tile>
  );
}

function TodayTile() {
  const start = new Date(new Date().toDateString());
  const end = new Date(start.getTime() + 2 * 86400000);
  const { data } = useApi<any[]>(`/calendar/events?from=${start.toISOString()}&to=${end.toISOString()}`);
  const list = (data ?? []).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
  const tomorrow = new Date(start.getTime() + 86400000);
  return (
    <Tile title="Heute und morgen" icon="calendar" to="/calendar">
      {!list.length ? <div className="small muted">Keine Termine</div> : list.slice(0, 8).map((e, i) => (
        <div key={`${e.id}-${i}`} className="dash-row">
          <span className="small mono" style={{ width: 80 }}>{new Date(e.startsAt) >= tomorrow ? 'morgen' : e.allDay ? 'ganztägig' : fmtTime(e.startsAt)}</span>
          <span className="grow">{e.title}</span>{e.location && <span className="small muted">{e.location}</span>}
        </div>
      ))}
    </Tile>
  );
}

function FavoritesTile() {
  const { data } = useApi<ProjectRow[]>('/projects');
  const favs = data?.filter((p) => p.favorite) ?? [];
  return (
    <Tile title="Favoriten" icon="star-filled" to="/projects">
      {favs.length ? <ProjectCards projects={favs} /> : <div className="small muted">Markieren Sie Projekte mit dem Stern, dann erscheinen sie hier.</div>}
    </Tile>
  );
}

function NotificationsTile() {
  const nav = useNavigate();
  const { data } = useApi<any[]>('/notifications');
  const list = (data ?? []).filter((n) => !n.readAt).slice(0, 6);
  return (
    <Tile title="Benachrichtigungen" icon="bell" to="/inbox">
      {!list.length ? <div className="small muted">Alles gelesen</div> : list.map((n) => (
        <div key={n.id} className="dash-row click" onClick={() => n.link && nav(n.link)}>
          <span className="grow">{n.title}</span><span className="small muted">{fmtTime(n.createdAt)}</span>
        </div>
      ))}
    </Tile>
  );
}

function NoteTile({ w, onConfig }: { w: DashboardWidget; onConfig: (c: Record<string, unknown>) => void }) {
  const [text, setText] = useState(String(w.config?.text ?? ''));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <Tile title="Notizzettel" icon="note">
      <textarea className="dash-note" value={text} placeholder="Hier notieren …" onChange={(e) => {
        setText(e.target.value);
        clearTimeout(timer.current);
        const v = e.target.value;
        timer.current = setTimeout(() => onConfig({ ...w.config, text: v }), 800);
      }} />
    </Tile>
  );
}

function LinksTile({ w, edit, onConfig }: { w: DashboardWidget; edit: boolean; onConfig: (c: Record<string, unknown>) => void }) {
  const links = (w.config?.links as { label: string; url: string }[] | undefined) ?? [];
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  return (
    <Tile title="Schnellzugriff" icon="link">
      {links.map((l, i) => (
        <div key={i} className="dash-row">
          <a className="grow" href={l.url} target={l.url.startsWith('/') ? undefined : '_blank'} rel="noreferrer"><Icon name="arrow-right" /> {l.label}</a>
          {edit && <button className="btn ghost sm" onClick={() => onConfig({ ...w.config, links: links.filter((_, j) => j !== i) })}><Icon name="x" /></button>}
        </div>
      ))}
      {!links.length && !edit && <div className="small muted">Unter „Startseite anpassen“ eigene Links anlegen.</div>}
      {edit && (
        <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
          <input placeholder="Name" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: 1, minWidth: 80 }} />
          <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 2, minWidth: 120 }} />
          <button className="btn sm" disabled={!label.trim() || !/^(https?:\/\/|\/)/.test(url)} onClick={() => { onConfig({ ...w.config, links: [...links, { label: label.trim(), url: url.trim() }] }); setLabel(''); setUrl(''); }}><Icon name="plus" /></button>
        </div>
      )}
    </Tile>
  );
}

function AbsentTile() {
  const { data } = useApi<{ id: string; displayName: string; until: string }[]>('/dashboard/absent-today');
  return (
    <Tile title="Heute abwesend" icon="palm" to="/calendar/team">
      {!data?.length ? <div className="small muted">Alle da</div> : data.map((u) => <div key={u.id} className="dash-row"><span className="grow">{u.displayName}</span><span className="small muted">bis {fmtDate(u.until)}</span></div>)}
    </Tile>
  );
}

function MailTile() {
  const { data: folders } = useApi<any[]>('/mailbox/folders');
  const inbox = folders?.find((f) => f.specialUse === '\\Inbox');
  const { data } = useApi<any[]>(inbox ? `/mailbox/messages?folderId=${inbox.id}&unread=1&limit=6` : null);
  return (
    <Tile title={`E-Mail${inbox?.unseen ? ` (${inbox.unseen} ungelesen)` : ''}`} icon="mail" to="/mail">
      {!folders ? <div className="small muted">Kein Postfach eingerichtet – unter E-Mail einrichten.</div> : !data?.length ? <div className="small muted">Keine ungelesenen Nachrichten</div> : data.map((m) => (
        <Link key={m.id} to="/mail" className="dash-row"><b className="small" style={{ width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(m.from.match(/^"?([^"<]+?)"?\s*</)?.[1] ?? m.from)}</b><span className="grow small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject}</span></Link>
      ))}
    </Tile>
  );
}

function CrmTile() {
  const { data } = useApi<any>('/crm/dashboard');
  return (
    <Tile title="Kundentermine" icon="building" to="/crm">
      {!data ? null : <>
        {data.upcoming.slice(0, 5).map((e: any) => <div key={e.id} className="dash-row"><span className="small mono" style={{ width: 90 }}>{fmtDate(e.startsAt)}</span><Link className="grow" to={`/crm/${e.accountId}`}>{e.accountName}</Link><span className="small muted">{e.title}</span></div>)}
        {!data.upcoming.length && <div className="small muted">Keine Kundentermine in den nächsten 14 Tagen</div>}
        {data.quiet.length > 0 && <div className="small" style={{ marginTop: 6 }}><Icon name="alert" /> {data.quiet.length} Kunden seit über 90 Tagen ohne Kontakt</div>}
      </>}
    </Tile>
  );
}

function DeliveriesTile() {
  const { data } = useApi<any>('/purchasing/dashboard');
  const list = data?.upcoming ?? [];
  return (
    <Tile title="Liefertermine" icon="truck" to="/purchasing">
      {!list.length ? <div className="small muted">Keine offenen Lieferungen</div> : list.slice(0, 6).map((i: any) => (
        <div key={i.id} className="dash-row"><span className="small mono" style={{ width: 90 }}>{fmtDate(i.confirmedDelivery ?? i.plannedDelivery)}</span><span className="grow">{i.designation}</span><span className="small muted">{i.supplierName ?? ''}</span></div>
      ))}
    </Tile>
  );
}

function BoardTile() {
  const { data } = useApi<any[]>('/board/posts?limit=5');
  return (
    <Tile title="Schwarzes Brett" icon="pin" to="/board">
      {!data?.length ? <div className="small muted">Keine Mitteilungen</div> : data.map((p) => (
        <Link key={p.id} to={`/board?post=${p.id}`} className="dash-row">{p.pinned && <Icon name="pin" />}<span className="grow">{p.title}</span>{!p.read && <Pill tone="accent">neu</Pill>}</Link>
      ))}
    </Tile>
  );
}

function MeetingsTile() {
  const { data } = useApi<any[]>('/meetings?upcoming=1');
  return (
    <Tile title="Meetings" icon="video" to="/meetings">
      {!data?.length ? <div className="small muted">Keine Meetings geplant</div> : data.slice(0, 5).map((m) => (
        <div key={m.id} className="dash-row"><span className="small mono" style={{ width: 110 }}>{fmtDate(m.startsAt)} {fmtTime(m.startsAt)}</span><span className="grow">{m.title}</span><Link className="btn sm" to={`/meetings/${m.id}`}>Beitreten</Link></div>
      ))}
    </Tile>
  );
}

function CallsTile() {
  const { data } = useApi<any[]>('/phone/calls?missed=1&limit=6');
  return (
    <Tile title="Verpasste Anrufe" icon="phone" to="/phone">
      {!data?.length ? <div className="small muted">Keine</div> : data.map((c) => (
        <div key={c.id} className="dash-row"><span className="grow">{c.contactName ?? c.accountName ?? c.remoteNumber}</span><span className="small muted">{fmtTime(c.startedAt)}</span></div>
      ))}
    </Tile>
  );
}
