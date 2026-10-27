import { useEffect, useState } from 'react';
import { TASK_PRIORITIES, TASK_STATUSES } from '@aperio/shared';
import { del, get, invalidate, patch, post, put } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../session';
import { useT } from '../i18n';
import { fmtDateTime, fmtHours } from '../lib/format';
import { Avatar, Confirm, Field, PRIORITY_META, SlideOver, STATUS_META, useAction, UserSelect } from './ui';

export interface Task {
  id: string; projectId: string; number: number; title: string; description: string; status: string; priority: string;
  assigneeId: string | null; assigneeName: string | null; teamId: string | null; teamName: string | null;
  startDate: string | null; dueDate: string | null; estimateHours: number | null; milestone: boolean; sort: number;
  commentCount: number; hoursBooked: number; dependsOn: string[]; createdAt: string; completedAt: string | null;
  projectNumber?: string; projectName?: string;
}

export function Comments({ type, id }: { type: 'task' | 'cad_item' | 'kvp'; id: string }) {
  const t = useT();
  const { data, reload } = useApi<{ id: string; body: string; userId: string; userName: string; createdAt: string }[]>(`/comments/${type}/${id}`);
  const [text, setText] = useState('');
  const act = useAction();
  return (
    <div>
      <h3 style={{ margin: '18px 0 10px' }}>💬 {t('Kommentare')}</h3>
      {data?.map((c) => (
        <div key={c.id} className="msg">
          <Avatar id={c.userId} name={c.userName} />
          <div className="grow"><div className="who">{c.userName}<span className="when">{fmtDateTime(c.createdAt)}</span></div><div className="body">{c.body}</div></div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Kommentar schreiben …') + ' (@benutzername erwähnt)'} style={{ minHeight: 50 }}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) { await act(() => post(`/comments/${type}/${id}`, { body: text })); setText(''); reload(); }
          }} />
        <button className="btn primary" disabled={!text.trim()} onClick={async () => { await act(() => post(`/comments/${type}/${id}`, { body: text })); setText(''); reload(); }}>Senden</button>
      </div>
    </div>
  );
}

export function TaskPanel({ taskId, onClose, allTasks }: { taskId: string; onClose: () => void; allTasks?: Task[] }) {
  const t = useT();
  const { users, teams } = useSession();
  const act = useAction();
  const { data: task, setData } = useApi<Task>(`/tasks/${taskId}`);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<{ title: string; description: string } | null>(null);
  const { data: history } = useApi<any[]>(task ? `/audit?projectId=${task.projectId}&entityType=task&entityId=${taskId}&limit=20` : null);

  useEffect(() => { if (task) setDraft({ title: task.title, description: task.description }); }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task || !draft) return <SlideOver title="…" onClose={onClose}><div className="muted">{t('Wird geladen …')}</div></SlideOver>;

  const save = async (changes: Partial<Task>) => {
    const r = await act(() => patch<Task>(`/tasks/${task.id}`, changes));
    if (r) { setData({ ...task, ...r }); invalidate(`/projects/${task.projectId}/tasks`); invalidate('/tasks/mine'); }
  };

  return (
    <SlideOver onClose={onClose}
      title={<div className="row"><span className="mono muted">P{task.number}</span><span className="pill">{task.projectNumber}</span></div>}
      actions={<>
        <button className="btn sm" title="Zeit auf diese Aufgabe stempeln" onClick={() => act(() => post('/time/clock-in', { projectId: task.projectId, taskId: task.id }).then(() => invalidate('/time')), 'Stempeluhr läuft')}>⏱️ {t('Einstempeln')}</button>
        <button className="btn sm danger" onClick={() => setConfirmDelete(true)}>{t('Löschen')}</button>
      </>}>
      <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} onBlur={() => draft.title.trim() && draft.title !== task.title && save({ title: draft.title })}
        style={{ fontSize: 20, fontWeight: 650, border: 'none', padding: '4px 0', boxShadow: 'none' }} />
      <div className="grid2" style={{ marginTop: 12 }}>
        <Field label={t('Status')}>
          <select value={task.status} onChange={(e) => save({ status: e.target.value })}>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s]!.ico} {t(STATUS_META[s]!.label)}</option>)}
          </select>
        </Field>
        <Field label={t('Priorität')}>
          <select value={task.priority} onChange={(e) => save({ priority: e.target.value })}>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{t(PRIORITY_META[p]!.label)}</option>)}
          </select>
        </Field>
        <Field label={t('Bearbeiter')}><UserSelect users={users} value={task.assigneeId} onChange={(v) => save({ assigneeId: v })} /></Field>
        <Field label={t('Abteilung')}>
          <select value={task.teamId ?? ''} onChange={(e) => save({ teamId: e.target.value || null })}>
            <option value="">–</option>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.icon} {tm.name}</option>)}
          </select>
        </Field>
        <Field label={t('Start')}><input type="date" value={task.startDate ?? ''} onChange={(e) => save({ startDate: e.target.value || null })} /></Field>
        <Field label={t('Fällig')}><input type="date" value={task.dueDate ?? ''} onChange={(e) => save({ dueDate: e.target.value || null })} /></Field>
        <Field label="Geschätzter Aufwand (Std.)"><input type="number" min={0} step={0.5} defaultValue={task.estimateHours ?? ''} onBlur={(e) => save({ estimateHours: e.target.value ? Number(e.target.value) : null })} /></Field>
        <Field label="Gebucht"><div style={{ padding: '6px 0' }}>⏱️ {fmtHours(task.hoursBooked)}{task.estimateHours ? ` von ${fmtHours(task.estimateHours)}` : ''}</div></Field>
      </div>
      <label className="row small" style={{ marginBottom: 12 }}><input type="checkbox" checked={task.milestone} onChange={(e) => save({ milestone: e.target.checked })} /> Meilenstein</label>
      <Field label={t('Beschreibung')}>
        <textarea rows={6} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} onBlur={() => draft.description !== task.description && save({ description: draft.description })} />
      </Field>
      {allTasks && (
        <Field label="Abhängig von (blockiert durch)">
          <select multiple value={task.dependsOn} style={{ minHeight: 90 }} onChange={async (e) => {
            const ids = [...e.target.selectedOptions].map((o) => o.value);
            const r = await act(() => put<Task>(`/tasks/${task.id}/dependencies`, { dependsOn: ids }));
            if (r) { setData({ ...task, ...r }); invalidate(`/projects/${task.projectId}/tasks`); }
          }}>
            {allTasks.filter((x) => x.id !== task.id).map((x) => <option key={x.id} value={x.id}>P{x.number} {x.title}</option>)}
          </select>
        </Field>
      )}
      <Comments type="task" id={task.id} />
      {history && history.length > 0 && (
        <div>
          <h3 style={{ margin: '18px 0 8px' }}>📜 Verlauf</h3>
          {history.map((h) => <div key={h.id} className="small muted">{fmtDateTime(h.at)} · {h.userName}: {h.summary}</div>)}
        </div>
      )}
      {confirmDelete && <Confirm danger text={`Aufgabe „${task.title}“ wirklich löschen?`} onClose={() => setConfirmDelete(false)}
        onConfirm={async () => { await del(`/tasks/${task.id}`); invalidate(`/projects/${task.projectId}/tasks`); onClose(); }} />}
    </SlideOver>
  );
}

/** Schnell-Dialog zum Anlegen einer Aufgabe */
export async function quickCreateTask(projectId: string, data: Partial<Task>) {
  const r = await post<Task>(`/projects/${projectId}/tasks`, data);
  invalidate(`/projects/${projectId}/tasks`);
  return r;
}

export const loadTask = (id: string) => get<Task>(`/tasks/${id}`);
