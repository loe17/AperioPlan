import { MODULE_TOOL } from '@aperio/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, invalidate, setUnauthorizedHandler } from './lib/api';
import { setAvatarVersions } from './lib/avatars';
import { realtime } from './lib/realtime';

export interface Me {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: 'admin' | 'teamlead' | 'member' | 'guest';
  mustChangePassword: boolean;
  locale: string;
  theme: 'system' | 'light' | 'dark';
  authSource: 'local' | 'ldap';
  teams: { id: string; name: string; icon: string; isLead: boolean }[];
  tools: string[];
  departmentId: string | null;
  phone: string;
  avatarVersion: number;
  hasAvatar: boolean;
  totpEnabled: boolean;
  onboarded: boolean;
  statusMode: 'auto' | 'online' | 'idle' | 'away' | 'offline';
  showLastSeen: boolean;
  /** Lohnabrechnung: darf abrechnen / hat eigene Lohnzettel */
  payrollManager?: boolean;
  payslips?: boolean;
}

export interface UserLite { id: string; displayName: string; username: string; email?: string | null; role: string; online?: boolean; avatarColor?: string | null; avatarVersion?: number; hasAvatar?: boolean; phone?: string; departmentId?: string | null; status?: string; lastSeenAt?: string | null }
export interface TeamLite { id: string; name: string; icon: string; description: string; parentId: string | null; defaultTools?: string[] | null; members: { userId: string; isLead: boolean; displayName: string }[] }

export interface PublicSettings {
  company: { name: string; logoText: string };
  projectNumbers: { format: 'sequential' | 'year'; prefix: string; digits: number; step: number };
  defaultModules: string[];
  cadMask: {
    fields: { key: string; label: string; type: string; required: boolean; catalog?: string; defaultValue?: string; appliesTo?: string[] }[];
    catalogs: { name: string; label: string; values: string[] }[];
    askCreateDrawing: boolean;
    drawingTemplate: string;
    subassemblies: { code: string; label: string }[];
  };
  storage: { mode: string; networkPath: string; projectFolders: string[] };
  time: { roundMinutes: number; maxDailyHours: number };
  aiEnabled: boolean;
  mailEnabled: boolean;
  officeEnabled: boolean;
  turnUrls: string[];
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  settings: PublicSettings | null;
  users: UserLite[];
  teams: TeamLite[];
  /** lädt den angemeldeten Benutzer neu; true = angemeldet */
  refresh: () => Promise<boolean>;
  refreshLists: () => Promise<void>;
  setTheme: (t: 'system' | 'light' | 'dark') => void;
  theme: 'system' | 'light' | 'dark';
}

const Ctx = createContext<SessionValue>(null as never);
export const useSession = () => useContext(Ctx);
export const useMe = () => useContext(Ctx).me!;
/** Ist ein Werkzeug für den angemeldeten Benutzer freigeschaltet? */
export function useCan() {
  const { me } = useContext(Ctx);
  return (tool: string) => Boolean(me) && me!.role !== 'guest' && (me!.tools ?? []).includes(tool);
}

/** Projektbereich verfügbar? (CAD, PCB, Chat, Zeiten, Einkauf, Kalkulation brauchen ihre Anwendung) */
export function useModuleOk() {
  const { me } = useContext(Ctx);
  return (m: string) => {
    const tool = MODULE_TOOL[m];
    if (!tool || !me || me.role === 'guest') return true;
    return (me.tools ?? []).includes(tool);
  };
}

function applyTheme(t: 'system' | 'light' | 'dark') {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('aperio-theme', t); } catch { /* privat */ }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [teams, setTeams] = useState<TeamLite[]>([]);
  const [theme, setThemeState] = useState<'system' | 'light' | 'dark'>(() => {
    try { return (localStorage.getItem('aperio-theme') as 'system') || 'system'; } catch { return 'system'; }
  });

  const refreshLists = useCallback(async () => {
    const [s, u, t] = await Promise.all([get<PublicSettings>('/settings/public'), get<UserLite[]>('/users'), get<TeamLite[]>('/teams')]);
    setSettings(s); setUsers(u); setTeams(t);
    setAvatarVersions(u);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await get<Me>('/auth/me');
      setMe(m);
      setAvatarVersions([m]);
      if (m.theme && m.theme !== theme) { setThemeState(m.theme); applyTheme(m.theme); }
      if (!m.mustChangePassword) {
        await refreshLists();
        realtime.start();
      }
      return true;
    } catch {
      setMe(null);
      realtime.stop();
      return false;
    } finally {
      setLoading(false);
    }
  }, [refreshLists]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setUnauthorizedHandler(() => { setMe(null); realtime.stop(); });
    void refresh();
  }, [refresh]);

  // Systemeinstellung (Windows Hell/Dunkel) live folgen
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [theme]);

  // Anwesenheit aktualisieren
  useEffect(() => realtime.subscribe('global', (event, data) => {
    if (event === 'presence') setUsers((us) => us.map((u) => (u.id === data.userId ? { ...u, online: data.online, ...(data.status ? { status: data.status, lastSeenAt: data.lastSeenAt } : {}) } : u)));
    if (event === 'user.changed') void refreshLists();
    // App-Store: Anwendung ein- oder ausgeschaltet → Rechte und Seitenleiste neu laden
    if (event === 'apps.changed') { void refresh(); invalidate('/apps'); invalidate('/plugins'); }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!me) return;
    return realtime.subscribe(`user:${me.id}`, (event) => {
      if (event === 'notification') invalidate('/notifications');
      // Rolle, Rechte oder Profil wurden geändert (z. B. vom Administrator) – sofort übernehmen
      if (event === 'session.changed') { void refresh(); invalidate('/'); }
    });
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTheme = (t: 'system' | 'light' | 'dark') => {
    setThemeState(t);
    applyTheme(t);
    if (me) void fetch('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: t }) });
  };

  return <Ctx.Provider value={{ me, loading, settings, users, teams, refresh, refreshLists, setTheme, theme }}>{children}</Ctx.Provider>;
}
