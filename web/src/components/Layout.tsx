import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { APP_VERSION } from '@aperio/shared';
import { useSession } from '../session';
import { useApi, useHotkey, useLocalState } from '../lib/hooks';
import { post, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useT } from '../i18n';
import { fmtDateTime } from '../lib/format';
import { Avatar, Dropdown } from './ui';
import { CommandPalette } from './CommandPalette';
import { ChangelogDialog } from './ChangelogDialog';
import { IncomingCalls, useChannels } from '../modules/ChatView';

// ---------------------------------------------------------------- Brotkrumen
export interface Crumb { label: string; to?: string }
const CrumbCtx = createContext<(c: Crumb[]) => void>(() => {});
export function useCrumbs(crumbs: Crumb[]) {
  const set = useContext(CrumbCtx);
  const key = JSON.stringify(crumbs);
  useEffect(() => { set(crumbs); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

interface ProjectLite { id: string; number: string; name: string; icon: string; teamId: string | null; parentId: string | null; favorite: boolean; status: string }

function NavItem({ to, ico, label, count, end }: { to: string; ico: string; label: string; count?: number; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <span className="ico">{ico}</span><span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </NavLink>
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
              <span className={`chev ${isOpen ? 'open' : ''}`} onClick={() => setOpen({ ...open, [team.id]: !isOpen })}>▶</span>
              <Link to={`/teams/${team.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {team.icon} {team.name}
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
      <button className="icon-btn" onClick={toggle} title="Benachrichtigungen">🔔{unread > 0 && <span className="badge-count">{unread}</span>}</button>
    )}>
      {(close) => (
        <div style={{ width: 360, maxHeight: 440, overflow: 'auto' }}>
          <div className="row" style={{ padding: '4px 8px 8px' }}>
            <b className="grow">{t('Posteingang')}</b>
            {unread > 0 && <button className="btn ghost sm" onClick={async () => { await post('/notifications/read'); invalidate('/notifications'); }}>{t('Alle als gelesen markieren')}</button>}
          </div>
          {!data?.length && <div className="muted" style={{ padding: 12 }}>{t('Keine neuen Benachrichtigungen')}</div>}
          {data?.slice(0, 30).map((n) => (
            <div key={n.id} className="item" style={{ alignItems: 'flex-start', opacity: n.readAt ? 0.6 : 1 }} onClick={async () => {
              close();
              if (!n.readAt) { await post('/notifications/read', { ids: [n.id] }); invalidate('/notifications'); }
              if (n.link) nav(n.link);
            }}>
              <span>{n.readAt ? '○' : '●'}</span>
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
          <div className="item" onClick={() => { close(); nav('/settings/profile'); }}>👤 {t('Profil')}</div>
          <div className="item" onClick={() => setTheme('light')}>{theme === 'light' ? '●' : '○'} ☀️ {t('Hellmodus')}</div>
          <div className="item" onClick={() => setTheme('dark')}>{theme === 'dark' ? '●' : '○'} 🌙 {t('Dunkelmodus')}</div>
          <div className="item" onClick={() => setTheme('system')}>{theme === 'system' ? '●' : '○'} 🖥️ {t('Wie System')}</div>
          <hr />
          <div className="item" onClick={async () => { await post('/auth/logout'); location.href = '/'; }}>🚪 {t('Abmelden')}</div>
        </>
      )}
    </Dropdown>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const t = useT();
  const { me, settings, theme, setTheme } = useSession();
  const [collapsed, setCollapsed] = useLocalState('aperio-sidebar-collapsed', false);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [palette, setPalette] = useState(false);
  const [changelog, setChangelog] = useState(false);
  const [connected, setConnected] = useState(realtime.connected);
  const { data: projects } = useApi<ProjectLite[]>('/projects');
  const { data: notifications } = useApi<{ readAt: string | null }[]>('/notifications');
  const { data: favorites } = useApi<{ entityId: string; number: string; name: string; icon: string }[]>('/favorites');
  const { data: plugins } = useApi<any[]>('/plugins');
  const unread = notifications?.filter((n) => !n.readAt).length ?? 0;
  const { data: channels } = useChannels();
  const chatUnread = channels?.reduce((s, c) => s + (c.unread ?? 0), 0) ?? 0;
  const location = useLocation();

  useEffect(() => realtime.onStatus(setConnected), []);
  useHotkey('mod+k', () => setPalette(true));
  useHotkey('mod+\\', () => setCollapsed(!collapsed));
  useEffect(() => {
    if (window.innerWidth < 860) setCollapsed(true);
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const isGuest = me?.role === 'guest';

  return (
    <CrumbCtx.Provider value={setCrumbs}>
      <div className={`app ${collapsed ? 'collapsed' : ''}`}>
        <nav className="sidebar">
          <div className="sidebar-head">
            <span className="logo">A</span>
            <span className="grow">{settings?.company.logoText ?? 'AperioPlan'}</span>
            <button className="icon-btn" onClick={() => setCollapsed(true)} title="Seitenleiste einklappen (Strg + \)">«</button>
          </div>
          <div className="sidebar-scroll">
            <div className="nav-title">📁 {t('Mein Schreibtisch')}</div>
            <NavItem to="/" end ico="🏠" label={t('Übersicht')} />
            {!isGuest && <NavItem to="/inbox" ico="📥" label={t('Posteingang')} count={unread} />}
            {!isGuest && <NavItem to="/calendar" end ico="📅" label={t('Mein Kalender')} />}
            {!isGuest && <NavItem to="/time" ico="⏱️" label={t('Stempeluhr')} />}
            {!isGuest && <NavItem to="/absences" ico="🏖️" label={t('Urlaubskonto')} />}
            {!isGuest && <NavItem to="/notes" ico="🔒" label={t('Private Notizen')} />}

            {favorites && favorites.length > 0 && (
              <div className="nav-section">
                <div className="nav-title">⭐ {t('Favoriten')}</div>
                {favorites.map((f) => <NavItem key={f.entityId} to={`/projects/${f.entityId}`} ico={f.icon} label={`${f.number} ${f.name}`} />)}
              </div>
            )}

            <div className="nav-section">
              <div className="nav-title">👥 {t('Meine Teams')}</div>
              <TeamTree projects={projects ?? []} />
              <NavItem to="/projects" end ico="🗂️" label={t('Alle Projekte')} />
            </div>

            <div className="nav-section">
              <div className="nav-title">🧰 {t('Werkzeuge')}</div>
              <NavItem to="/cad" ico="📐" label={t('CAD-Zentrale')} />
              {!isGuest && <NavItem to="/chat" ico="💬" label={t('Chat')} count={chatUnread} />}
              {!isGuest && settings?.mailEnabled && <NavItem to="/mail" ico="✉️" label={t('E-Mail')} />}
              {!isGuest && <NavItem to="/kvp" ico="💡" label={t('KVP-Ideenbox')} />}
              {!isGuest && <NavItem to="/calendar/team" ico="🗓️" label={t('Teamkalender')} />}
              {plugins?.filter((p) => p.enabled && p.page).map((p) => <NavItem key={p.id} to={`/plugin/${p.id}`} ico={p.page.icon ?? '🧩'} label={p.page.label} />)}
              <NavItem to="/settings" ico="⚙️" label={t('Einstellungen')} />
            </div>
          </div>
          <div className="sidebar-foot">
            <button className="version-btn" onClick={() => setChangelog(true)} title={t('Was ist neu?')}>v{APP_VERSION}</button>
            <span className={`dot ${connected ? 'ok' : 'off'}`} />
            <span>{connected ? t('Verbunden') : t('Getrennt')}</span>
          </div>
        </nav>

        <div className="main">
          <header className="topbar">
            {collapsed && <button className="icon-btn" onClick={() => setCollapsed(false)} title="Seitenleiste öffnen">☰</button>}
            <div className="breadcrumbs">
              <Link to="/">Home</Link>
              {crumbs.map((c, i) => (
                <span key={i} className="row" style={{ gap: 6 }}>
                  <span className="sep">›</span>
                  {c.to ? <Link to={c.to}>{c.label}</Link> : <span style={{ color: 'var(--text)' }}>{c.label}</span>}
                </span>
              ))}
            </div>
            <div className="search-trigger" onClick={() => setPalette(true)}>🔍 <span className="label">{t('Blitzsuche')}</span><kbd>Strg + K</kbd></div>
            <button className="icon-btn" title="Hell/Dunkel" onClick={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' || (theme === 'system' && document.documentElement.dataset.theme === 'dark') ? '☀️' : '🌙'}
            </button>
            {!isGuest && <Notifications />}
            <UserMenu />
          </header>
          <main className="content">{children}</main>
        </div>
        {palette && <CommandPalette onClose={() => setPalette(false)} />}
        {changelog && <ChangelogDialog onClose={() => setChangelog(false)} />}
        <IncomingCalls />
      </div>
    </CrumbCtx.Provider>
  );
}
