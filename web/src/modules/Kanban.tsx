import { useState } from 'react';
import { TASK_STATUSES } from '@aperio/shared';
import { patch, invalidate } from '../lib/api';
import { relDue, fmtHours } from '../lib/format';
import { useT } from '../i18n';
import { Avatar, PRIORITY_META, STATUS_META, StatusDot, Pill, useAction } from '../components/ui';
import { quickCreateTask, type Task } from '../components/TaskPanel';
import { Icon } from '../components/Icon';

/** Kanban-Board: Aufgaben visuell zwischen Spalten verschieben */
export function Kanban({ projectId, tasks, onOpen, canEdit }: { projectId: string; tasks: Task[]; onOpen: (id: string) => void; canEdit: boolean }) {
  const t = useT();
  const act = useAction();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ status: string; index: number } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [local, setLocal] = useState<Record<string, Partial<Task>>>({});

  const view = tasks.map((x) => ({ ...x, ...local[x.id] }));
  const cols = TASK_STATUSES.map((s) => ({ status: s, items: view.filter((x) => x.status === s).sort((a, b) => a.sort - b.sort) }));

  const drop = async (status: string, index: number) => {
    const task = view.find((x) => x.id === dragId);
    setDragId(null); setOver(null);
    if (!task) return;
    const items = cols.find((c) => c.status === status)!.items.filter((x) => x.id !== task.id);
    const before = items[index - 1]?.sort;
    const after = items[index]?.sort;
    const sort = before === undefined && after === undefined ? 1000 : before === undefined ? after! - 1000 : after === undefined ? before + 1000 : (before + after) / 2;
    setLocal((l) => ({ ...l, [task.id]: { status, sort } }));
    await act(() => patch(`/tasks/${task.id}`, task.status === status ? { sort } : { status, sort }));
    invalidate(`/projects/${projectId}/tasks`);
    setLocal((l) => { const c = { ...l }; delete c[task.id]; return c; });
  };

  return (
    <div className="kanban">
      {cols.map((col) => (
        <div key={col.status} className={`kanban-col ${over?.status === col.status ? 'drop' : ''}`}
          onDragOver={(e) => { if (!dragId) return; e.preventDefault(); if (over?.status !== col.status) setOver({ status: col.status, index: col.items.length }); }}
          onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null); }}
          onDrop={(e) => { e.preventDefault(); void drop(col.status, over?.status === col.status ? over.index : col.items.length); }}>
          <div className="kanban-col-head"><StatusDot status={col.status} /> {t(STATUS_META[col.status]!.label)} <span className="muted">({col.items.length})</span>
            {canEdit && <button className="btn ghost sm right" onClick={() => { setAdding(col.status); setNewTitle(''); }}>＋</button>}
          </div>
          <div className="kanban-cards">
            {col.items.map((task, i) => {
              const due = relDue(task.status === 'done' ? null : task.dueDate);
              return (
                <div key={task.id} className={`kcard ${dragId === task.id ? 'dragging' : ''}`} draggable={canEdit}
                  onDragStart={(e) => { setDragId(task.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { setDragId(null); setOver(null); }}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault(); e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const idx = e.clientY < r.top + r.height / 2 ? i : i + 1;
                    if (over?.status !== col.status || over.index !== idx) setOver({ status: col.status, index: idx });
                  }}
                  style={over?.status === col.status && dragId && dragId !== task.id ? (over.index === i ? { boxShadow: '0 -3px 0 var(--accent)' } : over.index === i + 1 && i === col.items.length - 1 ? { boxShadow: '0 3px 0 var(--accent)' } : undefined) : undefined}
                  onClick={() => onOpen(task.id)}>
                  <div className="title"><span className="muted mono small">P{task.number}</span> {task.milestone && <Icon name="milestone" className="mr" />}{task.title}</div>
                  <div className="meta">
                    {task.priority !== 'normal' && <Pill tone={PRIORITY_META[task.priority]!.tone}>{t(PRIORITY_META[task.priority]!.label)}</Pill>}
                    {due.text && <span style={{ color: due.tone ? `var(--${due.tone})` : undefined }}><Icon name="calendar" /> {t(due.text)}</span>}
                    {task.assigneeId && <span className="row" style={{ gap: 4 }}><Avatar id={task.assigneeId} name={task.assigneeName} /> {task.assigneeName}{task.teamName ? ` (${task.teamName})` : ''}</span>}
                    {task.commentCount > 0 && <span><Icon name="chat" /> {task.commentCount}</span>}
                    {task.hoursBooked > 0.05 && <span><Icon name="timer" /> {fmtHours(task.hoursBooked)}</span>}
                    {task.dependsOn.length > 0 && <span title="hat Abhängigkeiten"><Icon name="link" /> {task.dependsOn.length}</span>}
                  </div>
                </div>
              );
            })}
            {adding === col.status && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!newTitle.trim()) return;
                await act(() => quickCreateTask(projectId, { title: newTitle, status: col.status }));
                setNewTitle('');
              }}>
                <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Titel der Aufgabe, Enter zum Anlegen" onBlur={() => !newTitle && setAdding(null)} onKeyDown={(e) => e.key === 'Escape' && setAdding(null)} />
              </form>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
