import { useMemo, useState } from 'react';
import { useT } from '../i18n';
import { fmtDate, fmtHours, relDue } from '../lib/format';
import { Avatar, Empty, PRIORITY_META, Pill, StatusPill } from '../components/ui';
import type { Task } from '../components/TaskPanel';

type SortKey = 'number' | 'title' | 'status' | 'priority' | 'assigneeName' | 'dueDate' | 'hoursBooked';
const PRIO_ORDER: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const STATUS_ORDER: Record<string, number> = { todo: 0, in_progress: 1, review: 2, done: 3 };

/** Aufgabenliste & Tabelle mit Sortierung (Filter liegen in der Werkzeugleiste des Projekts) */
export function TaskTable({ tasks, onOpen, showProject }: { tasks: Task[]; onOpen: (id: string) => void; showProject?: boolean }) {
  const t = useT();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'number', dir: 1 });
  const rows = useMemo(() => [...tasks].sort((a, b) => {
    const k = sort.key;
    const va = k === 'priority' ? PRIO_ORDER[a.priority] : k === 'status' ? STATUS_ORDER[a.status] : (a as any)[k];
    const vb = k === 'priority' ? PRIO_ORDER[b.priority] : k === 'status' ? STATUS_ORDER[b.status] : (b as any)[k];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
  }), [tasks, sort]);
  const th = (key: SortKey, label: string) => (
    <th className="sortable" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  );
  if (!tasks.length) return <Empty icon="📋" title="Keine Aufgaben" />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          {th('number', '#')}{showProject && <th>Projekt</th>}{th('title', t('Titel'))}{th('status', t('Status'))}{th('priority', t('Priorität'))}
          {th('assigneeName', t('Bearbeiter'))}<th>{t('Abteilung')}</th>{th('dueDate', t('Fällig'))}{th('hoursBooked', 'Gebucht')}
        </tr></thead>
        <tbody>
          {rows.map((x) => {
            const due = relDue(x.status === 'done' ? null : x.dueDate);
            return (
              <tr key={x.id} className="click" onClick={() => onOpen(x.id)}>
                <td className="mono muted">P{x.number}</td>
                {showProject && <td className="mono small">{x.projectNumber}</td>}
                <td>{x.milestone && '◆ '}{x.title}</td>
                <td><StatusPill status={x.status} /></td>
                <td>{x.priority !== 'normal' ? <Pill tone={PRIORITY_META[x.priority]!.tone}>{t(PRIORITY_META[x.priority]!.label)}</Pill> : <span className="muted">{t('Normal')}</span>}</td>
                <td>{x.assigneeId ? <span className="row" style={{ gap: 6 }}><Avatar id={x.assigneeId} name={x.assigneeName} />{x.assigneeName}</span> : <span className="muted">–</span>}</td>
                <td>{x.teamName ?? <span className="muted">–</span>}</td>
                <td style={{ color: due.tone ? `var(--${due.tone})` : undefined }}>{x.dueDate ? fmtDate(x.dueDate) : '–'}</td>
                <td>{x.hoursBooked > 0.05 ? fmtHours(x.hoursBooked) : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
