import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { APP_VERSION, APPS } from '@aperio/shared';
import { MeetingLobbyNotice } from '../modules/MeetingLobby';
import { PhoneProvider } from '../modules/Phone';
import { useCan, useSession } from '../session';
import { useApi, useHotkey, useLocalState } from '../lib/hooks';
import { post, put, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useT } from '../i18n';
import { fmtDateTime } from '../lib/format';
import { Avatar, Dropdown } from './ui';
import { CommandPalette } from './CommandPalette';
import { ChangelogDialog } from './ChangelogDialog';
import { IncomingCalls, useChannels } from '../modules/ChatView';
import { EntityIcon, Icon } from './Icon';
import { HeaderClock } from './HeaderClock';

// ---------------------------------------------------------------- Brotkrumen
export interface Crumb { label: string; to?: string }
const CrumbCtx = createContext<(c: Crumb[]) => void>(() => {});
export function useCrumbs(crumbs: Crumb[]) {
  const set = useContext(CrumbCtx);
  const key = JSON.stringify(crumbs);
  useEffect(() => { set(crumbs); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

interface ProjectLite { id: string; number: string; name: string; icon: string; teamId: string | null; parentId: string | null; favorite: boolean; status: string }

function NavItem({ to, ico, label, count, end, star, drag }: { to: string; ico: string; label: string; count?: number; end?: boolean;
  star?: { on: boolean; toggle: () => void }; drag?: { onStart: () => void; onOver: () => void; onEnd: () => void } }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''} ${star ? 'has-star' : ''}`}
      draggable={Boolean(drag)} onDragStart={drag ? (e) => { e.dataTransfer.effectAllowed = 'move'; drag.onStart(); } : undefined}
      onDragOver={drag ? (e) => { e.preventDefault(); drag.onOver(); } : undefined} onDragEnd={drag?.onEnd}>
      <span className="ico"><EntityIcon value={ico} /></span><span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {count ? <span className="count">{count}</span> : null}
      {star && <button className={`nav-star ${star.on ? 'on' : ''}`} title={star.on ? 'Aus den Werkzeug-Favoriten entfernen' : 'Zu den Werkzeug-Favoriten'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); star.toggle(); }}><Icon name={star.on ? 'star-filled' : 'star'} size={14} /></button>}
    </NavLink>
  );
}

/** Abschnitt der Seitenleiste mit Überschrift, auf Wunsch einklappbar (Zustand bleibt im Browser gespeichert) */
function NavSection({ id, icon, title, children, collapsible = true }: { id: string; icon: string; title: string; children: ReactNode; collapsible?: boolean }) {
  const [closed, setClosed] = useLocalState<Record<string, boolean>>('aperio-nav-closed', {});
  const isClosed = collapsible && closed[id];
  return (
    <div className={`nav-section ${isClosed ? 'closed' : ''}`} data-section={id}>
      {collapsible
        ? <button type="button" className="nav-title nav-toggle" aria-expanded={!isClosed} onClick={() => setClosed({ ...closed, [id]: !isClosed })}>
            <Icon name={icon} /> <span className="grow">{title}</span><span className={`chev ${isClosed ? '' : 'open'}`}><Icon name="chevron-right" /></span>
          </button>
        : <div className="nav-title"><Icon name={icon} /> {title}</div>}
      {!isClosed && children}
    </div>
  );
}

function TeamTree({ projects }: { projects: ProjectLite[] }) {
  const { me, teams } = useSession();
  const [open, setOpen] = useLocalState<Record<string, boolean>>('aperio-tree', {});
  const location = useLocation();
  const myTeamIds = new Set(me?.teams.map((t) => t.id));
  const shown = me?.role === 'admin' ? teams : teams.filter((t) => myTeamIds.has(t.id));
  return (
    <>
      {shown.map((team) => {
        const ps = projects.filter((p) => p.teamId === team.id && !p.parentId);
        const isOpen = open[team.id];
        return (
          <div key={team.id}>
            <div className={`nav-item ${location.pathname === `/teams/${team.id}` ? 'active' : ''}`}>
              <span className={`chev ${isOpen ? 'open' : ''}`} onClick={() => setOpen({ ...open, [team.id]: !isOpen })}><Icon name="chevron-right" /></span>
              <Link to={`/teams/${team.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <EntityIcon value={team.icon} fallback="team" /> {team.name}
              </Link>
            </div>
            {isOpen && (
              <div className="nav-sub">
                {ps.length === 0 && <div className="nav-item muted small">keine Projekte</div>}
                {ps.map((p) => <NavItem key={p.id} to={`/projects/${p.id}`} ico={p.icon} label={`${p.number} ${p.name}`} />)}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function Notifications() {
  const t = useT();
  const nav = useNavigate();
  const { data } = useApi<{ id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }[]>('/notifications');
  const unread = data?.filter((n) => !n.readAt).length ?? 0;
  return (
    <Dropdown trigger={(toggle) => (
      <button className="icon-btn" onClick={toggle} title="Benachrichtigungen"><Icon name="bell" />{unread > 0 && <span className="badge-count">{unread}</span>}</button>
    )}>
      {(close) => (
        <div style={{ width: 360, maxHeight: 440, overflow: 'auto' }}>
          <div className="row" style={{ padding: '4px 8px 8px' }}>
            <b className="grow">{t('Benachrichtigungen')}</b>
            {unread > 0 && <button className="btn ghost sm" onClick={async () => { await post('/notifications/read'); invalidate('/notifications'); }}>{t('Alle als gelesen markieren')}</button>}
          </div>
          {!data?.length && <div className="muted" style={{ padding: 12 }}>{t('Keine neuen Benachrichtigungen')}</div>}
          {data?.slice(0, 30).map((n) => (
            <div key={n.id} className="item" style={{ alignItems: 'flex-start', opacity: n.readAt ? 0.6 : 1 }} onClick={async () => {
              close();
              if (!n.readAt) { await post('/notifications/read', { ids: [n.id] }); invalidate('/notifications'); }
              if (n.link) nav(n.link);
            }}>
              <span className={`read-dot ${n.readAt ? '' : 'unread'}`} />
              <div className="grow">
                <div style={{ fontWeight: 550 }}>{n.title}</div>
                {n.body && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>}
                <div className="small muted">{fmtDateTime(n.createdAt)}</div>
              </div>
            </div>
          ))}
          <hr />
          <div className="item" onClick={() => { close(); nav('/inbox'); }}>Alle anzeigen</div>
        </div>
      )}
    </Dropdown>
  );
}

function UserMenu() {
  const t = useT();
  const nav = useNavigate();
  const { me, theme, setTheme } = useSession();
  return (
    <Dropdown trigger={(toggle) => (
      <button className="btn ghost" onClick={toggle} style={{ padding: '3px 6px' }}><Avatar id={me!.id} name={me!.displayName} /><span className="small">{me!.displayName}</span></button>
    )}>
      {(close) => (
        <>
          <div style={{ padding: '6px 10px' }}><b>{me!.displayName}</b><div className="small muted">{me!.username} · {me!.role}</div></div>
          <hr />
          <div className="item" onClick={() => { close(); nav('/settings/profile'); }}><Icon name="user" /> {t('Profil')}</div>
          <div className="item" onClick={() => setTheme('light')}><span className={`radio-dot ${theme === 'light' ? 'on' : ''}`} /><Icon name="sun" /> {t('Hellmodus')}</div>
          <div className="item" onClick={() => setTheme('dark')}><span className={`radio-dot ${theme === 'dark' ? 'on' : ''}`} /><Icon name="moon" /> {t('Dunkelmodus')}</div>
          <div className="item" onClick={() => setTheme('system')}><span className={`radio-dot ${theme === 'system' ? 'on' : ''}`} /><Icon name="monitor" /> {t('Wie System')}</div>
          <hr />
          <div className="item" onClick={async () => { await post('/auth/logout'); location.href = '/'; }}><Icon name="logout" /> {t('Abmelden')}</div>
        </>
      )}
    </Dropdown>
  );
}

/** Anwendungen, die unter „Mein Schreibtisch“ stehen */
const DESK_APPS = ['time', 'absences', 'notes', 'chat', 'mail'];
const NAV_ROUTE: Record<string, string> = { calendar: '/calendar/team', resources: '/calendar/resources' };
const NAV_LABEL: Record<string, string> = { crm: 'Kunden (CRM)', calendar: 'Teamkalender', kvp: 'KVP-Ideenbox', chat: 'Chat' };

export function Layout({ children }: { children: ReactNode }) {
  const t = useT();
  const can = useCan();
  const { me, settings, theme, setTheme } = useSession();
  const [collapsed, setCollapsed] = useLocalState('aperio-sidebar-collapsed', false);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [palette, setPalette] = useState(false);
  const [changelog, setChangelog] = useState(false);
  const [connected, setConnected] = useState(realtime.connected);
  const { data: projects } = useApi<ProjectLite[]>('/projects');
  const { data: favorites } = useApi<{ entityId: string; number: string; name: string; icon: string }[]>('/favorites');
  const { data: plugins } = useApi<any[]>('/plugins');
  const { data: toolFavs, setData: setToolFavs } = useApi<string[]>(me?.role === 'guest' ? null : '/favorites/tools');
  const [dragFav, setDragFav] = useState<string | null>(null);
  const { data: channels } = useChannels();
  const chatUnread = channels?.reduce((s, c) => s + (c.unread ?? 0), 0) ?? 0;
  const { data: boardUnread, reload: reloadBoard } = useApi<{ n: number }>(can('board') ? '/board/unread' : null, [can('board')]);
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'board.changed') void reloadBoard(); }), [reloadBoard]);
  const location = useLocation();

  useEffect(() => realtime.onStatus(setConnected), []);
  useHotkey('mod+k', () => setPalette(true));
  useHotkey('mod+\\', () => setCollapsed(!collapsed));
  useEffect(() => {
    if (window.innerWidth < 860) setCollapsed(true);
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const isGuest = me?.role === 'guest';
  // Werkzeuge der Seitenleiste; Favoriten stehen zusätzlich in einem eigenen Bereich (Reihenfolge per Ziehen)
  const toolItems: { id: string; to: string; ico: string; label: string; count?: number }[] = [
    ...APPS.filter((a) => a.route && !DESK_APPS.includes(a.id) && can(a.id) && (a.id !== 'payroll' || me?.payrollManager))
      .map((a) => ({ id: a.id, to: NAV_ROUTE[a.id] ?? a.route!, ico: a.icon, label: t(NAV_LABEL[a.id] ?? a.name), count: a.id === 'board' ? boardUnread?.n : undefined })),
    ...(plugins?.filter((p) => p.enabled && p.page).map((p) => ({ id: `plugin:${p.id}`, to: `/plugin/${p.id}`, ico: p.page.icon ?? 'puzzle', label: p.page.label })) ?? []),
  ];
  const favTools = (toolFavs ?? []).map((id) => toolItems.find((x) => x.id === id)).filter((x): x is (typeof toolItems)[number] => Boolean(x));
  const saveFavs = (list: string[]) => { void put<string[]>('/favorites/tools', { tools: list }).catch(() => {}); };
  const toggleFav = (id: string) => {
    const list = toolFavs?.includes(id) ? toolFavs.filter((x) => x !== id) : [...(toolFavs ?? []), id];
    setToolFavs(list); saveFavs(list);
  };
  const moveFav = (over: string) => {
    if (!dragFav || dragFav === over || !toolFavs) return;
    const list = toolFavs.filter((x) => x !== dragFav);
    list.splice(list.indexOf(over) + (toolFavs.indexOf(dragFav) < toolFavs.indexOf(over) ? 1 : 0), 0, dragFav);
    setToolFavs(list);
  };

  return (
    <CrumbCtx.Provider value={setCrumbs}>
      <PhoneProvider>
      <div className={`app ${collapsed ? 'collapsed' : ''}`}>
        <nav className="sidebar">
          <div className="sidebar-head">
            <img className="logo" src="/logo-mark.svg" alt="" />
            <span className="grow">{settings?.company.logoText ?? 'AperioPlan'}</span>
            <button className="icon-btn" onClick={() => setCollapsed(true)} title="Seitenleiste einklappen (Strg + \)">«</button>
          </div>
          <div className="sidebar-scroll">
            <NavSection id="desk" icon="folder" title={t('Mein Schreibtisch')}>
              <NavItem to="/" end ico="home" label={t('Übersicht')} />
              {can('chat') && <NavItem to="/chat" ico="chat" label={t('Chat')} count={chatUnread} />}
              {can('mail') && <NavItem to="/mail" ico="mail" label={t('E-Mail')} />}
              {!isGuest && <NavItem to="/calendar" end ico="calendar" label={t('Mein Kalender')} />}
              {can('time') && <NavItem to="/time" ico="timer" label={t('Stempeluhr')} />}
              {can('absences') && <NavItem to="/absences" ico="palm" label={t('Urlaubskonto')} />}
              {can('notes') && <NavItem to="/notes" ico="lock" label={t('Private Notizen')} />}
              {me?.payslips && <NavItem to="/payslips" ico="file-text" label={t('Meine Lohnzettel')} />}
              {me?.myHr && <NavItem to="/my-hr" ico="id-card" label={t('Meine Unterlagen')} />}
            </NavSection>

            {favorites && favorites.length > 0 && (
              <NavSection id="favorites" icon="star-filled" title={t('Favoriten')}>
                {favorites.map((f) => <NavItem key={f.entityId} to={`/projects/${f.entityId}`} ico={f.icon} label={`${f.number} ${f.name}`} />)}
              </NavSection>
            )}

            <NavSection id="teams" icon="users" title={t('Meine Teams')}>
              <TeamTree projects={projects ?? []} />
              <NavItem to="/projects" end ico="projects" label={t('Alle Projekte')} />
            </NavSection>

            {favTools.length > 0 && (
              <NavSection id="tool-favorites" icon="star-filled" title={t('Werkzeug-Favoriten')}>
                {favTools.map((x) => <NavItem key={x.id} to={x.to} ico={x.ico} label={x.label} count={x.count} star={{ on: true, toggle: () => toggleFav(x.id) }}
                  drag={{ onStart: () => setDragFav(x.id), onOver: () => moveFav(x.id), onEnd: () => { setDragFav(null); if (toolFavs) saveFavs(toolFavs); } }} />)}
              </NavSection>
            )}

            <NavSection id="tools" icon="tools" title={t('Werkzeuge')}>
              {isGuest && <NavItem to="/cad" ico="cad" label={t('CAD-Bridge')} />}
              {toolItems.map((x) => <NavItem key={x.id} to={x.to} ico={x.ico} label={x.label} count={x.count} star={isGuest ? undefined : { on: Boolean(toolFavs?.includes(x.id)), toggle: () => toggleFav(x.id) }} />)}
            </NavSection>
          </div>
          <div className="sidebar-admin">
            {!isGuest && <NavItem to="/apps" ico="puzzle" label={t('App-Store')} />}
            <NavItem to="/settings" ico="settings" label={t('Einstellungen')} />
          </div>
          <div className="sidebar-foot">
            <button className="version-btn" onClick={() => setChangelog(true)} title={t('Was ist neu?')}>v{APP_VERSION}</button>
            <span className={`dot ${connected ? 'ok' : 'off'}`} />
            <span>{connected ? t('Verbunden') : t('Getrennt')}</span>
          </div>
        </nav>

        <div className="main">
          <header className="topbar">
            {collapsed && <button className="icon-btn" onClick={() => setCollapsed(false)} title="Seitenleiste öffnen"><Icon name="menu" /></button>}
            <div className="breadcrumbs topbar-side">
              <Link to="/">Home</Link>
              {crumbs.map((c, i) => (
                <span key={i} className="row" style={{ gap: 6 }}>
                  <span className="sep">›</span>
                  {c.to ? <Link to={c.to}>{c.label}</Link> : <span style={{ color: 'var(--text)' }}>{c.label}</span>}
                </span>
              ))}
            </div>
            {can('time') && <div className="topbar-center"><HeaderClock /></div>}
            <div className="topbar-side topbar-right">
            <div className="search-trigger" onClick={() => setPalette(true)}><Icon name="search" /> <span className="label">{t('Blitzsuche')}</span><kbd>Strg + K</kbd></div>
            <button className="icon-btn" title="Hell/Dunkel" onClick={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' || (theme === 'system' && document.documentElement.dataset.theme === 'dark') ? <Icon name="sun" /> : <Icon name="moon" />}
            </button>
            {!isGuest && <Notifications />}
            <UserMenu />
            </div>
          </header>
          <main className="content">{children}</main>
        </div>
        {palette && <CommandPalette onClose={() => setPalette(false)} />}
        {changelog && <ChangelogDialog onClose={() => setChangelog(false)} />}
        <IncomingCalls />
        <MeetingLobbyNotice />
      </div>
      </PhoneProvider>
    </CrumbCtx.Provider>
  );
}
