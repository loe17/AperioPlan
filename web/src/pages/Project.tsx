import { InvoiceList } from '../modules/Invoices';
import { MindmapList } from './Mindmaps';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { TASK_PRIORITIES, TASK_STATUSES } from '@aperio/shared';
import { useApi, rememberedTab, rememberTab } from '../lib/hooks';
import { del, patch, put, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCrumbs } from '../components/Layout';
import { useSession, useCan, useModuleOk } from '../session';
import { useT } from '../i18n';
import { fmtDate } from '../lib/format';
import { Tabs, Avatar, ErrorBox, Loading, Modal, Field, PRIORITY_META, Progress, STATUS_META, StatusDot, StatusPill, useAction, UserSelect } from '../components/ui';
import { TaskPanel, quickCreateTask, type Task } from '../components/TaskPanel';
import { Kanban } from '../modules/Kanban';
import { ProjectPurchasing } from '../modules/Purchasing';
import { CalculationList } from '../modules/Calculations';
import { TaskTable } from '../modules/TaskTable';
import { Gantt } from '../modules/Gantt';
import { Whiteboards } from '../modules/Whiteboard';
import { Report } from '../modules/Report';
import { Documents } from '../modules/Documents';
import { AuditView } from '../modules/AuditView';
import { ProjectSettings, MODULE_LABELS, STATUS_OPTIONS } from '../modules/ProjectSettings';
import { ProjectFiles } from '../modules/ProjectFiles';
import { ProjectCad } from '../modules/ProjectCad';
import { PcbCenter } from '../modules/PcbCenter';
import { ProjectChat } from '../modules/ProjectChat';
import { ProjectTime } from '../modules/ProjectTime';
import { AiPanel } from '../modules/AiPanel';
import { EntityIcon, Icon, IconPicker } from '../components/Icon';

const TASK_VIEWS = ['kanban', 'list', 'gantt'];

export default function ProjectPage() {
  const moduleOk = useModuleOk();
  const { id } = useParams();
  const t = useT();
  const act = useAction();
  const { users, teams, settings, me } = useSession();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [ai, setAi] = useState(false);
  const { data: project, error } = useApi<any>(`/projects/${id}`);
  const { data: tasks } = useApi<Task[]>(`/projects/${id}/tasks`);
  const { data: plugins } = useApi<any[]>('/plugins');
  const pluginTabs = (plugins ?? []).filter((p) => p.enabled && p.projectTab);
  const [filter, setFilter] = useState({ q: '', assignee: '', team: '', priority: '', status: '' });
  const [newTask, setNewTask] = useState(false);

  const tab = params.get('tab') ?? rememberedTab(`project:${id}`) ?? project?.modules?.[0] ?? 'overview';
  const taskId = params.get('task');
  const setTab = (v: string) => { rememberTab(`project:${id}`, v); params.set('tab', v); params.delete('task'); setParams(params, { replace: true }); };
  const openTask = (tid: string) => { params.set('task', tid); setParams(params); };
  const closeTask = () => { params.delete('task'); setParams(params); };

  useEffect(() => realtime.subscribe(`project:${id}`, (event) => {
    if (event.startsWith('task.')) invalidate(`/projects/${id}/tasks`);
    if (event === 'project.updated') invalidate(`/projects/${id}`);
  }), [id]);

  const crumbs = [] as { label: string; to?: string }[];
  if (project?.teamName) crumbs.push({ label: project.teamName, to: `/teams/${project.teamId}` });
  if (project?.parent) crumbs.push({ label: project.parent.number, to: `/projects/${project.parent.id}` });
  if (project) crumbs.push({ label: `Projekt ${project.number} (${project.name})`, to: `/projects/${project.id}` });
  const tabLabel = tab === 'overview' ? 'Übersicht' : tab === 'documents' ? 'Dokumente' : tab === 'audit' ? 'Änderungsprotokoll' : tab === 'settings' ? 'Einstellungen' : MODULE_LABELS[tab]?.label;
  if (tabLabel) crumbs.push({ label: t(tabLabel) });
  useCrumbs(crumbs);

  const filtered = useMemo(() => (tasks ?? []).filter((x) =>
    (!filter.q || `${x.title} ${x.description} P${x.number}`.toLowerCase().includes(filter.q.toLowerCase()))
    && (!filter.assignee || (filter.assignee === 'none' ? !x.assigneeId : x.assigneeId === filter.assignee))
    && (!filter.team || x.teamId === filter.team)
    && (!filter.priority || x.priority === filter.priority)
    && (!filter.status || x.status === filter.status)), [tasks, filter]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!project) return <Loading />;

  const tabs = [
    { id: 'overview', label: `${t('Übersicht')}` },
    ...project.modules.filter(moduleOk).map((m: string) => ({ id: m, label: t(MODULE_LABELS[m]?.label ?? m) })),
    ...(can('mindmap') ? [{ id: 'mindmaps', label: 'Mindmaps' }] : []),
    ...(can('crm') ? [{ id: 'invoices', label: 'Rechnungen' }] : []),
    ...pluginTabs.map((p) => ({ id: `plugin:${p.id}`, label: p.projectTab.label })),
    { id: 'documents', label: 'Dokumente' },
    { id: 'audit', label: `${t('Änderungsprotokoll')}` },
    ...(project.canManage ? [{ id: 'settings', label: `${t('Einstellungen')}` }] : []),
  ];
  const isTaskView = TASK_VIEWS.includes(tab);
  const statusLabel = STATUS_OPTIONS.find(([v]) => v === project.status)?.[1];

  return (
    <div className={`page ${['kanban', 'gantt', 'whiteboard', 'chat'].includes(tab) ? 'wide' : ''}`}>
      <div className="page-head">
        <div className="entity-big"><EntityIcon value={project.icon} size={30} /></div>
        <div className="grow">
          <div className="row">
            <h1>{project.name}</h1>
            <button className="icon-btn" title={project.favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten'} onClick={async () => {
              await act(() => (project.favorite ? del(`/favorites/project/${project.id}`) : put(`/favorites/project/${project.id}`, {})));
              invalidate(`/projects/${project.id}`); invalidate('/favorites');
            }}>{project.favorite ? <Icon name="star-filled" /> : <Icon name="star" />}</button>
          </div>
          <div className="sub row wrap">
            <span className="mono">{project.number}</span>
            <span className="pill">{statusLabel}</span>
            {project.customer && (project.customerId && can('crm') ? <Link to={`/crm/${project.customerId}`}><Icon name="building" /> {project.customer}</Link> : <span>Kunde: {project.customer}</span>)}
            {(project.startDate || project.dueDate) && <span><Icon name="calendar" /> {fmtDate(project.startDate)} – {fmtDate(project.dueDate)}</span>}
            {project.networkPath && <span title="Im Windows-Explorer öffnen" className="mono small"><Icon name="folder-open" /> {project.networkPath}</span>}
          </div>
        </div>
        <div className="actions">
          {settings?.mailEnabled && <Link className="btn" to={`/mail?projectId=${project.id}`}><Icon name="mail" /> E-Mails</Link>}
          {settings?.aiEnabled && <button className="btn" onClick={() => setAi(true)}><Icon name="sparkles" /> KI</button>}
          {isTaskView && project.canEdit && <button className="btn primary" onClick={() => setNewTask(true)}>＋ {t('Neue Aufgabe')}</button>}
        </div>
      </div>

      {project.locked && (
        <div className="locked-banner">
          <Icon name="lock" />
          <span className="grow">Dieses Projekt ist <b>{statusLabel}</b> und nur noch lesbar.{me?.role === 'admin' ? '' : ' Nur ein Administrator kann den Status zurücksetzen.'}</span>
          {me?.role === 'admin' && (
            <select value="" onChange={async (e) => { if (!e.target.value) return; await act(() => patch(`/projects/${project.id}`, { status: e.target.value }), 'Status zurückgesetzt'); invalidate(`/projects/${project.id}`); }} style={{ width: 'auto' }}>
              <option value="">Status zurücksetzen …</option>
              {STATUS_OPTIONS.filter(([v]) => v !== project.status).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          )}
        </div>
      )}

      <Tabs value={tab} onChange={setTab} tabs={tabs} />

      {isTaskView && tab !== 'gantt' && (
        <div className="toolbar">
          <input placeholder={`${t('Filtern nach …')}`} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} style={{ width: 220 }} />
          <select value={filter.assignee} onChange={(e) => setFilter({ ...filter, assignee: e.target.value })}>
            <option value="">{t('Bearbeiter')}: alle</option><option value="none">ohne Bearbeiter</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
          <select value={filter.team} onChange={(e) => setFilter({ ...filter, team: e.target.value })}>
            <option value="">{t('Abteilung')}: alle</option>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </select>
          <select value={filter.priority} onChange={(e) => setFilter({ ...filter, priority: e.target.value })}>
            <option value="">{t('Priorität')}: alle</option>{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{t(PRIORITY_META[p]!.label)}</option>)}
          </select>
          {tab === 'list' && <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">{t('Status')}: alle</option>{TASK_STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_META[s]!.label)}</option>)}
          </select>}
          {Object.values(filter).some(Boolean) && <button className="btn ghost sm" onClick={() => setFilter({ q: '', assignee: '', team: '', priority: '', status: '' })}>Filter zurücksetzen</button>}
          <span className="muted small right">{filtered.length} von {tasks?.length ?? 0} Aufgaben</span>
        </div>
      )}

      {tab === 'overview' && <Overview project={project} tasks={tasks ?? []} onOpen={openTask} />}
      {tab === 'kanban' && <Kanban projectId={project.id} tasks={filtered} onOpen={openTask} canEdit={project.canEdit} canManage={project.canManage} />}
      {tab === 'list' && <TaskTable tasks={filtered} onOpen={openTask} />}
      {tab === 'gantt' && <Gantt projectId={project.id} tasks={tasks ?? []} onOpen={openTask} canEdit={project.canEdit} />}
      {tab === 'whiteboard' && <Whiteboards projectId={project.id} canEdit={project.canEdit} />}
      {tab === 'mindmaps' && <MindmapList projectId={project.id} canEdit={project.canEdit} />}
      {tab === 'invoices' && <InvoiceList projectId={project.id} />}
      {tab === 'report' && <Report project={project} tasks={tasks ?? []} canEdit={project.canEdit} />}
      {tab === 'files' && <ProjectFiles projectId={project.id} project={project} canEdit={project.canEdit} />}
      {tab === 'cad' && <ProjectCad projectId={project.id} project={project} canEdit={project.canEdit} />}
      {tab === 'pcb' && <PcbCenter projectId={project.id} canEdit={project.canEdit && !project.locked} />}
      {tab === 'chat' && <ProjectChat projectId={project.id} project={project} />}
      {tab === 'time' && <ProjectTime projectId={project.id} project={project} />}
      {tab === 'purchasing' && <ProjectPurchasing project={project} canEdit={!project.locked && me?.role !== 'guest'} />}
      {tab === 'calculation' && <CalculationList projectId={project.id} canEdit={!project.locked && me?.role !== 'guest'} />}
      {tab.startsWith('plugin:') && (() => {
        const p = pluginTabs.find((x) => `plugin:${x.id}` === tab);
        return p ? <iframe title={p.name} src={`/plugins/${p.id}/${p.projectTab.entry}?projectId=${project.id}&projectNumber=${encodeURIComponent(project.number)}`} style={{ width: '100%', height: 'calc(100vh - 250px)', border: '1px solid var(--line)', borderRadius: 10 }} /> : null;
      })()}
      {tab === 'documents' && <Documents projectId={project.id} canEdit={project.canEdit} canManage={project.canManage} />}
      {tab === 'audit' && <AuditView projectId={project.id} />}
      {tab === 'settings' && project.canManage && <ProjectSettings key={project.updatedAt} project={project} />}

      {ai && <AiPanel projectId={project.id} onClose={() => setAi(false)} />}
      {taskId && <TaskPanel taskId={taskId} onClose={closeTask} allTasks={tasks} />}
      {newTask && <NewTaskDialog projectId={project.id} onClose={() => setNewTask(false)} onCreated={(tid) => { setNewTask(false); openTask(tid); }} />}
    </div>
  );
}

function NewTaskDialog({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const { users, teams } = useSession();
  const act = useAction();
  const [d, setD] = useState({ title: '', description: '', assigneeId: null as string | null, teamId: '', priority: 'normal', startDate: '', dueDate: '', status: 'todo' });
  return (
    <Modal title={t('Neue Aufgabe')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('Abbrechen')}</button>
      <button className="btn primary" disabled={!d.title.trim()} onClick={async () => {
        const r = await act(() => quickCreateTask(projectId, { ...d, teamId: d.teamId || null, startDate: d.startDate || null, dueDate: d.dueDate || null }));
        if (r) onCreated(r.id);
      }}>{t('Anlegen')}</button>
    </>}>
      <Field label={t('Titel')} required><input autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <Field label={t('Beschreibung')}><textarea value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      <div className="grid2">
        <Field label={t('Bearbeiter')}><UserSelect users={users} value={d.assigneeId} onChange={(v) => setD({ ...d, assigneeId: v })} /></Field>
        <Field label={t('Abteilung')}><select value={d.teamId} onChange={(e) => setD({ ...d, teamId: e.target.value })}><option value="">–</option>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}</select></Field>
        <Field label={t('Priorität')}><select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })}>{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{t(PRIORITY_META[p]!.label)}</option>)}</select></Field>
        <Field label={t('Status')}><select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })}>{TASK_STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_META[s]!.label)}</option>)}</select></Field>
        <Field label={t('Start')}><input type="date" value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value })} /></Field>
        <Field label={t('Fällig')}><input type="date" value={d.dueDate} onChange={(e) => setD({ ...d, dueDate: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function Overview({ project, tasks, onOpen }: { project: any; tasks: Task[]; onOpen: (id: string) => void }) {
  const t = useT();
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, tasks.filter((x) => x.status === s).length]));
  const done = counts.done ?? 0;
  const overdue = tasks.filter((x) => x.status !== 'done' && x.dueDate && new Date(x.dueDate) < new Date(new Date().toDateString()));
  const next = tasks.filter((x) => x.status !== 'done' && x.dueDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 6);
  return (
    <div className="stack">
      {project.description && <div className="card" style={{ whiteSpace: 'pre-wrap' }}>{project.description}</div>}
      <div className="card-grid">
        <div className="card">
          <div className="muted small">Fortschritt</div>
          <div className="stat">{tasks.length ? Math.round((done / tasks.length) * 100) : 0} %</div>
          <Progress value={tasks.length ? done / tasks.length : 0} />
          <div className="row small muted" style={{ marginTop: 8, gap: 10 }}>
            {TASK_STATUSES.map((s) => <span key={s} className="row" style={{ gap: 5 }}><StatusDot status={s} /> {counts[s]}</span>)}
          </div>
        </div>
        <div className="card"><div className="muted small">Überfällig</div><div className="stat" style={{ color: overdue.length ? 'var(--red)' : undefined }}>{overdue.length}</div></div>
        <div className="card">
          <div className="muted small">{t('Mitglieder')}</div>
          <div className="row wrap" style={{ marginTop: 8, gap: 4 }}>{project.members.map((m: any) => <Avatar key={m.userId} id={m.userId} name={m.displayName} />)}</div>
        </div>
      </div>
      {project.children.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>{t('Teilprojekte')}</h3>
          <div className="card-grid">
            {project.children.map((c: any) => (
              <Link key={c.id} to={`/projects/${c.id}`} className="card click" style={{ color: 'inherit', textDecoration: 'none' }}>
                <div className="row"><EntityIcon value={c.icon} /><b className="mono">{c.number}</b><span>{c.name}</span></div>
              </Link>
            ))}
          </div>
        </div>
      )}
      {next.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>Nächste Fristen</h3>
          <div className="table-wrap"><table className="table"><tbody>
            {next.map((x) => (
              <tr key={x.id} className="click" onClick={() => onOpen(x.id)}>
                <td className="mono muted" style={{ width: 60 }}>P{x.number}</td><td>{x.title}</td><td><StatusPill status={x.status} /></td>
                <td>{x.assigneeName ?? '–'}</td><td style={{ color: overdue.includes(x) ? 'var(--red)' : undefined }}>{fmtDate(x.dueDate)}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      )}
    </div>
  );
}
