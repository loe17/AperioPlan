import { useEffect, useState } from 'react';
import { TASK_STATUSES } from '@aperio/shared';
import { patch, post, del, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { relDue, fmtHours } from '../lib/format';
import { useT } from '../i18n';
import { Avatar, Confirm, Field, Modal, PRIORITY_META, STATUS_META, StatusDot, Pill, useAction } from '../components/ui';
import { quickCreateTask, type Task } from '../components/TaskPanel';
import { Icon } from '../components/Icon';

export interface KanbanColumn { id: string; name: string; color: string; baseStatus: string; sort: number }
interface Col { key: string; status: string; custom: KanbanColumn | null; label: string; color?: string; order: number }

const BASE_ORDER: Record<string, number> = { todo: 100, in_progress: 200, review: 300, done: 400 };

/** Grundspalten und eigene Spalten in einer Reihenfolge */
export function boardColumns(custom: KanbanColumn[], label: (s: string) => string): Col[] {
  const cols: Col[] = TASK_STATUSES.map((s) => ({ key: s, status: s, custom: null, label: label(s), order: BASE_ORDER[s]! }));
  for (const c of custom) cols.push({ key: c.id, status: c.baseStatus, custom: c, label: c.name, color: c.color, order: c.sort });
  return cols.sort((a, b) => a.order - b.order);
}

/** Kanban-Board: Aufgaben visuell zwischen Spalten verschieben; eigene Spalten gehören zu einer Grundstufe */
export function Kanban({ projectId, tasks, onOpen, canEdit, canManage = false }: { projectId: string; tasks: Task[]; onOpen: (id: string) => void; canEdit: boolean; canManage?: boolean }) {
  const t = useT();
  const act = useAction();
  const { data: custom, reload } = useApi<KanbanColumn[]>(`/projects/${projectId}/columns`);
  const [editCol, setEditCol] = useState<Partial<KanbanColumn> | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  useEffect(() => realtime.subscribe(`project:${projectId}`, (e) => { if (e === 'columns.changed') void reload(); }), [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ status: string; index: number } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [local, setLocal] = useState<Record<string, Partial<Task>>>({});

  const view = tasks.map((x) => ({ ...x, ...local[x.id] }));
  const known = new Set((custom ?? []).map((c) => c.id));
  const colOf = (x: Task) => (x.columnId && known.has(x.columnId) ? x.columnId : x.status);
  const cols = boardColumns(custom ?? [], (s) => t(STATUS_META[s]!.label)).map((c) => ({ ...c, items: view.filter((x) => colOf(x) === c.key).sort((a, b) => a.sort - b.sort) }));

  const drop = async (key: string, index: number) => {
    const task = view.find((x) => x.id === dragId);
    setDragId(null); setOver(null);
    if (!task) return;
    const col = cols.find((c) => c.key === key)!;
    const items = col.items.filter((x) => x.id !== task.id);
    const before = items[index - 1]?.sort;
    const after = items[index]?.sort;
    const sort = before === undefined && after === undefined ? 1000 : before === undefined ? after! - 1000 : after === undefined ? before + 1000 : (before + after) / 2;
    const columnId = col.custom?.id ?? null;
    setLocal((l) => ({ ...l, [task.id]: { status: col.status, columnId, sort } }));
    const same = colOf(task) === key;
    await act(() => patch(`/tasks/${task.id}`, same ? { sort } : columnId ? { columnId, sort } : { status: col.status, columnId: null, sort }));
    invalidate(`/projects/${projectId}/tasks`);
    setLocal((l) => { const c = { ...l }; delete c[task.id]; return c; });
  };

  /** Eigene Spalte per Ziehen der Überschrift verschieben */
  const dropColumn = async (targetKey: string) => {
    const moving = (custom ?? []).find((c) => c.id === dragCol);
    setDragCol(null);
    if (!moving || targetKey === moving.id) return;
    const ordered = cols.filter((c) => c.key !== moving.id);
    const idx = ordered.findIndex((c) => c.key === targetKey);
    const prev = ordered[idx - 1]?.order ?? 0;
    const sort = (prev + ordered[idx]!.order) / 2;
    await act(() => patch(`/columns/${moving.id}`, { sort }));
    void reload();
  };

  return (
    <div className="kanban">
      {cols.map((col) => (
        <div key={col.key} className={`kanban-col ${over?.status === col.key || (dragCol && dragCol !== col.key) ? 'drop' : ''}`}
          style={col.color ? { borderTop: `3px solid ${col.color}` } : undefined}
          onDragOver={(e) => { if (dragCol) { e.preventDefault(); return; } if (!dragId) return; e.preventDefault(); if (over?.status !== col.key) setOver({ status: col.key, index: col.items.length }); }}
          onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null); }}
          onDrop={(e) => { e.preventDefault(); if (dragCol) { void dropColumn(col.key); return; } void drop(col.key, over?.status === col.key ? over.index : col.items.length); }}>
          <div className="kanban-col-head" draggable={canManage && Boolean(col.custom)} title={col.custom ? `gehört zu „${t(STATUS_META[col.status]!.label)}“` : undefined}
            onDragStart={(e) => { if (!col.custom) return; e.stopPropagation(); setDragCol(col.custom.id); e.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setDragCol(null)}>
            {col.custom ? <span className="status-dot" style={{ background: col.color }} /> : <StatusDot status={col.status} />} {col.label} <span className="muted">({col.items.length})</span>
            <span className="right row" style={{ gap: 2 }}>
              {canManage && col.custom && <button className="btn ghost sm" title="Spalte bearbeiten" onClick={() => setEditCol(col.custom)}><Icon name="edit" /></button>}
              {canEdit && <button className="btn ghost sm" title="Aufgabe hinzufügen" onClick={() => { setAdding(col.key); setNewTitle(''); }}><Icon name="plus" /></button>}
            </span>
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
                    if (over?.status !== col.key || over.index !== idx) setOver({ status: col.key, index: idx });
                  }}
                  style={over?.status === col.key && dragId && dragId !== task.id ? (over.index === i ? { boxShadow: '0 -3px 0 var(--accent)' } : over.index === i + 1 && i === col.items.length - 1 ? { boxShadow: '0 3px 0 var(--accent)' } : undefined) : undefined}
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
            {adding === col.key && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!newTitle.trim()) return;
                await act(() => quickCreateTask(projectId, { title: newTitle, status: col.status, ...(col.custom ? { columnId: col.custom.id } : {}) }));
                setNewTitle('');
              }}>
                <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Titel der Aufgabe, Enter zum Anlegen" onBlur={() => !newTitle && setAdding(null)} onKeyDown={(e) => e.key === 'Escape' && setAdding(null)} />
              </form>
            )}
          </div>
        </div>
      ))}
      {canManage && (
        <button className="kanban-add" onClick={() => setEditCol({ name: '', color: '#f59e0b', baseStatus: 'in_progress' })}><Icon name="plus" /> Spalte hinzufügen</button>
      )}
      {editCol && <ColumnModal projectId={projectId} column={editCol} onClose={() => setEditCol(null)} onSaved={() => { setEditCol(null); void reload(); invalidate(`/projects/${projectId}/tasks`); }} />}
    </div>
  );
}

const COLORS = ['#6b7280', '#4f46e5', '#0ea5e9', '#16a34a', '#f59e0b', '#ef4444', '#a855f7', '#ec4899'];

function ColumnModal({ projectId, column, onClose, onSaved }: { projectId: string; column: Partial<KanbanColumn>; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const act = useAction();
  const [c, setC] = useState(column);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    const body = { name: c.name, color: c.color, baseStatus: c.baseStatus };
    const r = await act(() => (c.id ? patch(`/columns/${c.id}`, body) : post(`/projects/${projectId}/columns`, { ...body, sort: undefined })), 'Spalte gespeichert');
    if (r) onSaved();
  };
  return (
    <Modal title={c.id ? 'Spalte bearbeiten' : 'Neue Spalte'} onClose={onClose}
      footer={<>{c.id && <button className="btn danger" onClick={() => setConfirm(true)}>Löschen</button>}<span className="grow" />
        <button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!c.name?.trim()} onClick={save}>Speichern</button></>}>
      <Field label="Name" required><input autoFocus value={c.name ?? ''} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="z. B. Wartet auf Kunde" /></Field>
      <Field label="Gehört zur Stufe" hint="damit Fortschritt, Berichte und Gantt weiter stimmen">
        <select value={c.baseStatus} onChange={(e) => setC({ ...c, baseStatus: e.target.value })}>{TASK_STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_META[s]!.label)}</option>)}</select>
      </Field>
      <Field label="Farbe"><div className="row">{COLORS.map((x) => <button key={x} type="button" className={`color-swatch ${c.color === x ? 'active' : ''}`} style={{ background: x }} onClick={() => setC({ ...c, color: x })} />)}</div></Field>
      <div className="hint">Neue Spalten erscheinen hinter ihrer Stufe; die Reihenfolge ändern Sie durch Ziehen der Spaltenüberschrift.</div>
      {confirm && <Confirm danger text="Spalte löschen? Ihre Aufgaben wandern in die Grundspalte der Stufe." confirmLabel="Löschen" onClose={() => setConfirm(false)}
        onConfirm={async () => { await act(() => del(`/columns/${c.id}`), 'Spalte gelöscht'); onSaved(); }} />}
    </Modal>
  );
}
