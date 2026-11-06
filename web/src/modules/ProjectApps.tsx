import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PROJECT_TAB_INFO, type ProjectTab } from '@aperio/shared';
import { patch, invalidate } from '../lib/api';
import { useLocalState } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { useModuleOk } from '../session';
import { Dropdown, Loading, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

/** Projekt, wie es die Reiter einer App bekommen */
export interface TabProject { id: string; number: string; name: string; customerId?: string | null; customer?: string; canEdit: boolean; canManage: boolean; locked: boolean; budget?: number | null; [k: string]: unknown }
export interface TabProps { project: TabProject; canEdit: boolean }

const tab = (load: () => Promise<Record<string, unknown>>, name: string) => lazy(async () => ({ default: (await load())[name] as ComponentType<TabProps> }));

/** Reiter der Apps im Projekt – jeweils aus der Seite der App, erst bei Bedarf geladen */
const APP_TABS: Partial<Record<ProjectTab, ComponentType<TabProps>>> = {
  sales: tab(() => import('../pages/Crm'), 'ProjectSales'),
  material: tab(() => import('../pages/Warehouse'), 'ProjectMaterialTab'),
  meetings: tab(() => import('../pages/Meetings'), 'ProjectMeetings'),
  service: tab(() => import('../pages/Service'), 'ProjectService'),
  quality: tab(() => import('../pages/Quality'), 'ProjectQuality'),
  manufacturing: tab(() => import('../pages/Manufacturing'), 'ProjectManufacturing'),
  changes: tab(() => import('../pages/Plm'), 'ProjectChanges'),
  expenses: tab(() => import('../pages/Expenses'), 'ProjectExpenses'),
  approvals: tab(() => import('../pages/Approvals'), 'ProjectApprovals'),
  esign: tab(() => import('../pages/Esign'), 'ProjectEsign'),
  co2: tab(() => import('../pages/Sustainability'), 'ProjectCo2'),
  bills: tab(() => import('../pages/Finance'), 'ProjectBills'),
  resources: tab(() => import('../pages/Resources'), 'ProjectResources'),
};

export const hasAppTab = (t: string) => t in APP_TABS;

export function ProjectAppTab({ tab: t, project }: { tab: string; project: TabProject }) {
  const C = APP_TABS[t as ProjectTab];
  if (!C) return null;
  return <Suspense fallback={<Loading />}><C project={project} canEdit={project.canEdit && !project.locked} /></Suspense>;
}

/** Kopfzeile eines App-Reiters: Hinweis, Link zur Gesamtübersicht, Knopf „neu“ */
export function TabHead({ hint, to, toLabel, newLabel, onNew, children }: { hint?: ReactNode; to?: string; toLabel?: string; newLabel?: string; onNew?: (() => void) | false; children?: ReactNode }) {
  return (
    <div className="toolbar">
      {hint && <span className="small muted">{hint}</span>}
      {children}
      <span className="grow" />
      {to && <Link className="btn ghost" to={to}>{toLabel ?? 'Gesamtübersicht'} <Icon name="arrow-right" /></Link>}
      {onNew && <button className="btn primary" onClick={onNew}><Icon name="plus" /> {newLabel ?? 'Neu'}</button>}
    </div>
  );
}

/** Bei Änderungen im Projekt oder global neu laden */
export function useLiveReload(channels: string[], events: string[], reload: () => unknown) {
  const key = `${channels.join('|')}#${events.join('|')}`;
  useEffect(() => {
    const offs = channels.map((c) => realtime.subscribe(c, (e) => { if (events.some((x) => e === x || (x.endsWith('.') && e.startsWith(x)))) void reload(); }));
    return () => offs.forEach((f) => f());
  }, [key, reload]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Gesamtübersicht: Einträge nach Projekt gruppiert (ohne Projekt am Ende oder als eigene Gruppe) */
export function ProjectGroups<T extends { projectId?: string | null; projectNumber?: string | null; projectName?: string | null }>({ rows, tab: t, noneLabel = 'Ohne Projekt', noneFirst, children }: {
  rows: T[]; tab?: string; noneLabel?: string; noneFirst?: boolean; children: (rows: T[]) => ReactNode;
}) {
  const groups = new Map<string, { id: string | null; number: string; name: string; rows: T[] }>();
  for (const r of rows) {
    const k = r.projectId ?? '';
    if (!groups.has(k)) groups.set(k, { id: r.projectId ?? null, number: r.projectNumber ?? '', name: r.projectName ?? '', rows: [] });
    groups.get(k)!.rows.push(r);
  }
  const list = [...groups.values()].sort((a, b) => (!a.id ? (noneFirst ? -1 : 1) : !b.id ? (noneFirst ? 1 : -1) : a.number.localeCompare(b.number, 'de', { numeric: true })));
  return (
    <div className="pgroups">
      {list.map((g) => (
        <section key={g.id ?? 'none'} className="pgroup">
          <div className="pgroup-head">
            {g.id ? <Link to={`/projects/${g.id}${t ? `?tab=${t}` : ''}`}><Icon name="projects" /> <b className="mono">{g.number}</b> {g.name}</Link> : <span><Icon name="inbox" /> <b>{noneLabel}</b></span>}
            <span className="muted small">{g.rows.length}</span>
          </div>
          {children(g.rows)}
        </section>
      ))}
    </div>
  );
}

/** Schalter „nach Projekt gruppieren“ – merkt sich die Wahl je Seite */
export function useGrouping(key: string, initial = true): [boolean, ReactNode] {
  const [on, setOn] = useLocalState<boolean>(`aperio-group-${key}`, initial);
  return [on, <label key="g" className="row small" style={{ gap: 6 }}><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> nach Projekt gruppieren</label>];
}

/** „+“ am Ende der Reiterleiste: weiteren App-Reiter im Projekt einschalten */
export function AddTabButton({ project, onAdded }: { project: { id: string; modules: string[] }; onAdded: (tab: string) => void }) {
  const moduleOk = useModuleOk();
  const act = useAction();
  const missing = (Object.keys(PROJECT_TAB_INFO) as ProjectTab[]).filter((t) => !project.modules.includes(t) && moduleOk(t));
  if (!missing.length) return null;
  return (
    <Dropdown trigger={(toggle) => <button className="tab tab-add" title="Reiter hinzufügen" onClick={toggle}><Icon name="plus" size={15} /></button>}>
      {(close) => <div style={{ maxHeight: '60vh', overflowY: 'auto', width: 280 }}>
        <div className="small muted" style={{ padding: '4px 10px 6px' }}>Reiter hinzufügen – nur Apps, die bei Ihnen installiert sind</div>
        {missing.map((t) => (
          <div key={t} className="item" onClick={async () => {
            close();
            if (await act(() => patch(`/projects/${project.id}`, { modules: [...project.modules, t] }))) { invalidate(`/projects/${project.id}`); onAdded(t); }
          }}><Icon name={PROJECT_TAB_INFO[t].icon} /><span><b style={{ fontWeight: 550 }}>{PROJECT_TAB_INFO[t].label}</b><div className="small muted">{PROJECT_TAB_INFO[t].hint}</div></span></div>
        ))}
      </div>}
    </Dropdown>
  );
}
