import { useMemo, useRef, useState } from 'react';
import { patch, invalidate } from '../lib/api';
import { isoDate } from '../lib/format';
import { useAction, Empty } from '../components/ui';
import type { Task } from '../components/TaskPanel';

const DAY = 86400000;
const ROW = 34;
const LABEL = 260;
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y!, m! - 1, d!).getTime(); };

/** Gantt-Diagramm mit Meilensteinen und Abhängigkeiten. Balken per Maus verschieben bzw. am Ende verlängern. */
export function Gantt({ projectId, tasks, onOpen, canEdit }: { projectId: string; tasks: Task[]; onOpen: (id: string) => void; canEdit: boolean }) {
  const act = useAction();
  const [zoom, setZoom] = useState(28);
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'end'; startX: number; deltaDays: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const planned = tasks.filter((t) => t.startDate || t.dueDate).sort((a, b) => (a.startDate ?? a.dueDate!).localeCompare(b.startDate ?? b.dueDate!));
  const unplanned = tasks.filter((t) => !t.startDate && !t.dueDate);

  const { from, days } = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let min = today.getTime() - 7 * DAY;
    let max = today.getTime() + 30 * DAY;
    for (const t of planned) {
      const s = parse(t.startDate ?? t.dueDate!);
      const e = parse(t.dueDate ?? t.startDate!);
      min = Math.min(min, s - 3 * DAY);
      max = Math.max(max, e + 7 * DAY);
    }
    const start = new Date(min); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Montag
    return { from: start.getTime(), days: Math.ceil((max - start.getTime()) / DAY) };
  }, [planned]);

  const xOf = (ms: number) => ((ms - from) / DAY) * zoom;
  const todayX = xOf(new Date(new Date().setHours(0, 0, 0, 0)).getTime());
  const bars = planned.map((t, i) => {
    let s = parse(t.startDate ?? t.dueDate!);
    let e = parse(t.dueDate ?? t.startDate!);
    if (drag?.id === t.id) {
      if (drag.mode === 'move') { s += drag.deltaDays * DAY; e += drag.deltaDays * DAY; }
      else e = Math.max(s, e + drag.deltaDays * DAY);
    }
    return { t, i, x: xOf(s), w: Math.max(zoom, xOf(e + DAY) - xOf(s)), y: i * ROW + 36 };
  });
  const byId = new Map(bars.map((b) => [b.t.id, b]));

  const onDown = (e: React.MouseEvent, id: string, mode: 'move' | 'end') => {
    if (!canEdit) return;
    e.stopPropagation(); e.preventDefault();
    const startX = e.clientX;
    let moved = false;
    setDrag({ id, mode, startX, deltaDays: 0 });
    const move = (ev: MouseEvent) => {
      const dd = Math.round((ev.clientX - startX) / zoom);
      if (dd !== 0) moved = true;
      setDrag((d) => (d ? { ...d, deltaDays: dd } : d));
    };
    const up = async () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (!moved || d.deltaDays === 0) { if (!moved) onOpen(id); return; }
      const t = tasks.find((x) => x.id === id)!;
      const s = parse(t.startDate ?? t.dueDate!);
      const en = parse(t.dueDate ?? t.startDate!);
      const body = d.mode === 'move'
        ? { startDate: isoDate(new Date(s + d.deltaDays * DAY)), dueDate: isoDate(new Date(en + d.deltaDays * DAY)) }
        : { startDate: t.startDate ?? isoDate(new Date(s)), dueDate: isoDate(new Date(Math.max(s, en + d.deltaDays * DAY))) };
      await act(() => patch(`/tasks/${id}`, body));
      invalidate(`/projects/${projectId}/tasks`);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!planned.length) return <Empty icon="📊" title="Noch keine terminierten Aufgaben">Tragen Sie bei Aufgaben Start- und Fälligkeitsdatum ein, dann erscheinen sie hier als Zeitbalken.</Empty>;

  const width = days * zoom;
  const height = planned.length * ROW + 36;
  const weeks: { x: number; label: string }[] = [];
  for (let d = 0; d < days; d += 7) {
    const date = new Date(from + d * DAY);
    weeks.push({ x: d * zoom, label: `KW ${isoWeek(date)} · ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}` });
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted small">Zoom</span>
        <button className="btn sm" onClick={() => setZoom((z) => Math.max(8, z - 6))}>−</button>
        <button className="btn sm" onClick={() => setZoom((z) => Math.min(60, z + 6))}>＋</button>
        <span className="muted small">◆ Meilenstein · Pfeile zeigen Abhängigkeiten · Balken ziehen zum Verschieben, rechte Kante zum Verlängern</span>
      </div>
      <div className="gantt" style={{ maxHeight: 'calc(100vh - 260px)' }}>
        <div style={{ display: 'flex', minWidth: LABEL + width }}>
          <div style={{ width: LABEL, flex: 'none', position: 'sticky', left: 0, zIndex: 4, background: 'var(--card)' }}>
            <div className="gantt-label gantt-head" style={{ height: 36 }}>Aufgabe</div>
            {planned.map((t) => (
              <div key={t.id} className="gantt-label" style={{ height: ROW, cursor: 'pointer' }} onClick={() => onOpen(t.id)}>
                <span className="mono muted small">P{t.number}</span> {t.title}
              </div>
            ))}
          </div>
          <div style={{ position: 'relative', width, height }}>
            <div className="gantt-head" style={{ position: 'sticky', top: 0, height: 36, display: 'flex' }}>
              {weeks.map((w) => <div key={w.x} style={{ position: 'absolute', left: w.x, top: 0, height: 36, borderLeft: '1px solid var(--line)', paddingLeft: 4, lineHeight: '36px', whiteSpace: 'nowrap' }}>{w.label}</div>)}
            </div>
            {Array.from({ length: days }, (_, d) => {
              const wd = new Date(from + d * DAY).getDay();
              return wd === 0 || wd === 6 ? <div key={d} style={{ position: 'absolute', left: d * zoom, top: 36, width: zoom, height: height - 36, background: 'var(--bg-soft)' }} /> : null;
            })}
            {planned.map((_, i) => <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: 36 + (i + 1) * ROW - 1, borderTop: '1px solid var(--line)' }} />)}
            <div style={{ position: 'absolute', left: todayX, top: 0, bottom: 0, borderLeft: '2px solid var(--red)', opacity: 0.6 }} title="Heute" />
            <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
              <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--text-3)" /></marker></defs>
              {bars.flatMap((b) => b.t.dependsOn.map((depId) => {
                const d = byId.get(depId);
                if (!d) return null;
                const x1 = d.x + d.w, y1 = d.y + ROW / 2, x2 = b.x, y2 = b.y + ROW / 2;
                const mid = Math.max(x1 + 8, Math.min(x2 - 8, (x1 + x2) / 2));
                const late = x2 < x1;
                return <path key={`${depId}-${b.t.id}`} d={`M${x1},${y1} H${mid} V${y2} H${x2 - 2}`} fill="none" stroke={late ? 'var(--red)' : 'var(--text-3)'} strokeWidth="1.3" markerEnd="url(#arr)" />;
              }))}
            </svg>
            {bars.map((b) => {
              const late = b.t.status !== 'done' && b.t.dueDate && parse(b.t.dueDate) < new Date().setHours(0, 0, 0, 0);
              if (b.t.milestone) {
                return <div key={b.t.id} className="gantt-milestone" title={b.t.title} style={{ left: b.x + b.w - 7 - zoom / 2, top: b.y + ROW / 2 - 7, cursor: canEdit ? 'grab' : 'pointer' }} onMouseDown={(e) => onDown(e, b.t.id, 'move')} />;
              }
              return (
                <div key={b.t.id} className={`gantt-bar ${b.t.status === 'done' ? 'done' : late ? 'late' : ''}`} title={`${b.t.title}\n${b.t.startDate ?? ''} – ${b.t.dueDate ?? ''}`}
                  style={{ left: b.x, top: b.y + 7, width: b.w }} onMouseDown={(e) => onDown(e, b.t.id, 'move')}>
                  {b.t.title}
                  {canEdit && <span onMouseDown={(e) => onDown(e, b.t.id, 'end')} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize' }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {unplanned.length > 0 && <div className="small muted" style={{ marginTop: 10 }}>Ohne Termin: {unplanned.map((t) => <a key={t.id} onClick={() => onOpen(t.id)} style={{ cursor: 'pointer', marginRight: 10 }}>P{t.number} {t.title}</a>)}</div>}
    </>
  );
}

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y.getTime()) / DAY + 1) / 7);
}
