import { useEffect, useRef, useState } from 'react';
import { get, post, put, del, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { Confirm, Empty, useAction } from '../components/ui';

type Tool = 'select' | 'note' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text';
interface Item {
  id: string; type: 'note' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text';
  x: number; y: number; w: number; h: number; color: string; text?: string; points?: [number, number][];
}

const NOTE_COLORS = ['#fff3bf', '#d3f9d8', '#d0ebff', '#ffd8e8', '#e5dbff', '#ffe8cc'];
const STROKES = ['#1a1d20', '#4f46e5', '#d9534f', '#5a8f6a', '#c98a12'];
const uid = () => Math.random().toString(36).slice(2, 10);

/** Freie Zeichenfläche für Schaltpläne, Skizzen und digitale Haftnotizen */
export function Whiteboards({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data: boards } = useApi<{ id: string; name: string }[]>(`/projects/${projectId}/whiteboards`);
  const [active, setActive] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => { if (!active && boards?.length) setActive(boards[0]!.id); }, [boards, active]);
  const [confirm, setConfirm] = useState(false);

  return (
    <div>
      <div className="toolbar">
        {boards?.map((b) => <button key={b.id} className={`btn sm ${active === b.id ? 'primary' : ''}`} onClick={() => setActive(b.id)}>{b.name}</button>)}
        {canEdit && <button className="btn sm" onClick={async () => {
          const name = prompt('Name des Whiteboards', 'Skizze');
          if (!name) return;
          const w = await act(() => post(`/projects/${projectId}/whiteboards`, { name }));
          invalidate(`/projects/${projectId}/whiteboards`);
          if (w) setActive(w.id);
        }}>＋ Neues Whiteboard</button>}
        {canEdit && active && <button className="btn sm danger right" onClick={() => setConfirm(true)}>Whiteboard löschen</button>}
      </div>
      {!boards?.length && <Empty icon="🎨" title="Noch kein Whiteboard">Legen Sie eine freie Zeichenfläche für Skizzen, Schaltpläne und Haftnotizen an.</Empty>}
      {active && <Board key={active} id={active} projectId={projectId} canEdit={canEdit} />}
      {confirm && active && <Confirm danger text="Whiteboard mit allen Inhalten löschen?" onClose={() => setConfirm(false)} onConfirm={async () => {
        await del(`/whiteboards/${active}`); setActive(null); invalidate(`/projects/${projectId}/whiteboards`);
      }} />}
    </div>
  );
}

function Board({ id, projectId, canEdit }: { id: string; projectId: string; canEdit: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState(STROKES[0]!);
  const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]!);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [saved, setSaved] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);
  const action = useRef<null | { kind: 'pan' | 'move' | 'draw' | 'resize'; sx: number; sy: number; ox: number; oy: number; id?: string; orig?: Item }>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = useRef(false);

  useEffect(() => { get(`/whiteboards/${id}`).then((w) => setItems(w.data?.items ?? [])); }, [id]);
  useEffect(() => realtime.subscribe(`project:${projectId}`, (event, data) => {
    if (event === 'whiteboard.changed' && data.id === id && !dirty.current && !action.current) setItems(data.data.items);
  }), [id, projectId]);

  const commit = (next: Item[]) => {
    setItems(next);
    if (!canEdit) return;
    dirty.current = true;
    setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await put(`/whiteboards/${id}`, { data: { items: next } });
      dirty.current = false;
      setSaved(true);
    }, 600);
  };

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  const onDown = (e: React.PointerEvent) => {
    const p = toWorld(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === 'select' || !canEdit || e.button === 1) {
      setSelected(null);
      action.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
      return;
    }
    const base = { id: uid(), x: p.x, y: p.y, w: 0, h: 0, color };
    let item: Item;
    if (tool === 'note') item = { ...base, type: 'note', w: 180, h: 140, color: noteColor, text: '' };
    else if (tool === 'text') item = { ...base, type: 'text', w: 220, h: 40, text: '' };
    else if (tool === 'pen') item = { ...base, type: 'pen', points: [[p.x, p.y]] };
    else item = { ...base, type: tool };
    setItems((s) => [...s, item]);
    setSelected(item.id);
    if (tool === 'note' || tool === 'text') {
      commit([...items, item]);
      setEditing(item.id);
      setTool('select');
      return;
    }
    action.current = { kind: 'draw', sx: p.x, sy: p.y, ox: 0, oy: 0, id: item.id };
  };

  const onMove = (e: React.PointerEvent) => {
    const a = action.current;
    if (!a) return;
    if (a.kind === 'pan') { setView((v) => ({ ...v, x: a.ox + e.clientX - a.sx, y: a.oy + e.clientY - a.sy })); return; }
    const p = toWorld(e);
    setItems((s) => s.map((it) => {
      if (it.id !== a.id) return it;
      if (a.kind === 'move') return { ...it, x: a.orig!.x + p.x - a.sx, y: a.orig!.y + p.y - a.sy, points: a.orig!.points?.map(([px, py]) => [px + p.x - a.sx, py + p.y - a.sy] as [number, number]) };
      if (a.kind === 'resize') return { ...it, w: Math.max(30, a.orig!.w + p.x - a.sx), h: Math.max(20, a.orig!.h + p.y - a.sy) };
      if (it.type === 'pen') return { ...it, points: [...(it.points ?? []), [p.x, p.y]] };
      return { ...it, w: p.x - a.sx, h: p.y - a.sy };
    }));
  };

  const onUp = () => {
    const a = action.current;
    action.current = null;
    if (!a || a.kind === 'pan') return;
    setItems((s) => {
      const next = s.map((it) => (it.id === a.id && it.type !== 'arrow' && it.type !== 'pen' && (it.w < 0 || it.h < 0)
        ? { ...it, x: Math.min(it.x, it.x + it.w), y: Math.min(it.y, it.y + it.h), w: Math.abs(it.w), h: Math.abs(it.h) } : it))
        .filter((it) => it.type === 'pen' ? (it.points?.length ?? 0) > 1 : it.type === 'arrow' ? Math.hypot(it.w, it.h) > 5 : it.w > 3 || it.h > 3);
      commit(next);
      return next;
    });
  };

  const startMove = (e: React.PointerEvent, it: Item) => {
    if (!canEdit || tool !== 'select') return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelected(it.id);
    const p = toWorld(e);
    action.current = { kind: 'move', sx: p.x, sy: p.y, ox: 0, oy: 0, id: it.id, orig: it };
  };

  const startResize = (e: React.PointerEvent, it: Item) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toWorld(e);
    action.current = { kind: 'resize', sx: p.x, sy: p.y, ox: 0, oy: 0, id: it.id, orig: it };
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (editing || !selected || !canEdit) return;
      if (e.key === 'Delete' || e.key === 'Backspace') commit(items.filter((i) => i.id !== selected));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const onWheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.min(3, Math.max(0.2, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    setView({ k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k });
  };

  const edited = items.find((i) => i.id === editing);
  const tools: [Tool, string, string][] = [['select', '🖐️', 'Auswählen / Verschieben'], ['note', '🗒️', 'Haftnotiz'], ['text', '🔤', 'Text'], ['rect', '▭', 'Rechteck'], ['ellipse', '◯', 'Kreis'], ['arrow', '➝', 'Pfeil'], ['pen', '✏️', 'Freihand']];

  return (
    <div className="wb-wrap">
      {canEdit && (
        <div className="wb-tools">
          {tools.map(([t, ico, label]) => <button key={t} className={`btn sm ${tool === t ? 'active' : ''}`} title={label} onClick={() => setTool(t)}>{ico}</button>)}
          <span style={{ width: 1, background: 'var(--line)', margin: '0 4px' }} />
          {(tool === 'note' ? NOTE_COLORS : STROKES).map((c) => (
            <button key={c} className="btn sm" title="Farbe" onClick={() => {
              if (tool === 'note') setNoteColor(c); else setColor(c);
              if (selected) commit(items.map((i) => (i.id === selected ? { ...i, color: c } : i)));
            }} style={{ width: 24, padding: 0, justifyContent: 'center', background: c, outline: (tool === 'note' ? noteColor : color) === c ? '2px solid var(--accent)' : undefined }}>&nbsp;</button>
          ))}
          <span style={{ width: 1, background: 'var(--line)', margin: '0 4px' }} />
          <button className="btn sm" disabled={!selected} title="Auswahl löschen (Entf)" onClick={() => commit(items.filter((i) => i.id !== selected))}>🗑️</button>
          <span className="small muted" style={{ alignSelf: 'center', padding: '0 6px' }}>{saved ? 'gespeichert' : 'speichert …'}</span>
        </div>
      )}
      <div style={{ position: 'absolute', bottom: 10, right: 10, zIndex: 5 }} className="row">
        <button className="btn sm" onClick={() => setView({ x: 0, y: 0, k: 1 })}>{Math.round(view.k * 100)} %</button>
      </div>
      <svg ref={svgRef} width="100%" height="100%" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}
        style={{ cursor: tool === 'select' ? 'grab' : 'crosshair', touchAction: 'none' }}>
        <defs><marker id="wbarrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke" /></marker></defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {items.map((it) => {
            const sel = selected === it.id;
            const common = { onPointerDown: (e: React.PointerEvent) => startMove(e, it), onDoubleClick: () => canEdit && (it.type === 'note' || it.type === 'text' || it.type === 'rect' || it.type === 'ellipse') && setEditing(it.id), style: { cursor: canEdit && tool === 'select' ? 'move' : 'default' } };
            const outline = sel ? <rect x={Math.min(it.x, it.x + it.w) - 4} y={Math.min(it.y, it.y + it.h) - 4} width={Math.abs(it.w) + 8} height={Math.abs(it.h) + 8} fill="none" stroke="var(--accent)" strokeDasharray="4 3" /> : null;
            const handle = sel && canEdit && it.type !== 'pen' && it.type !== 'arrow' ? <rect x={it.x + it.w - 5} y={it.y + it.h - 5} width={10} height={10} fill="var(--accent)" style={{ cursor: 'nwse-resize' }} onPointerDown={(e) => startResize(e, it)} /> : null;
            const label = it.text ? (
              <foreignObject x={it.x} y={it.y} width={Math.max(1, it.w)} height={Math.max(1, it.h)} style={{ pointerEvents: 'none' }}>
                <div style={{ padding: 8, fontSize: it.type === 'text' ? 18 : 14, color: it.type === 'note' ? '#1a1d20' : 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', height: '100%', display: it.type === 'rect' || it.type === 'ellipse' ? 'grid' : 'block', placeItems: 'center', textAlign: it.type === 'rect' || it.type === 'ellipse' ? 'center' : 'left' }}>{it.text}</div>
              </foreignObject>
            ) : null;
            if (it.type === 'note') return <g key={it.id} {...common}><rect x={it.x} y={it.y} width={it.w} height={it.h} rx={4} fill={it.color} filter="drop-shadow(0 2px 3px rgba(0,0,0,.15))" />{label}{outline}{handle}</g>;
            if (it.type === 'text') return <g key={it.id} {...common}><rect x={it.x} y={it.y} width={it.w} height={it.h} fill="transparent" />{label ?? <text x={it.x + 8} y={it.y + 26} fill="var(--text-3)">Text …</text>}{outline}{handle}</g>;
            if (it.type === 'rect') return <g key={it.id} {...common}><rect x={Math.min(it.x, it.x + it.w)} y={Math.min(it.y, it.y + it.h)} width={Math.abs(it.w)} height={Math.abs(it.h)} rx={3} fill="var(--card)" fillOpacity={0.6} stroke={it.color} strokeWidth={2} />{label}{outline}{handle}</g>;
            if (it.type === 'ellipse') return <g key={it.id} {...common}><ellipse cx={it.x + it.w / 2} cy={it.y + it.h / 2} rx={Math.abs(it.w / 2)} ry={Math.abs(it.h / 2)} fill="var(--card)" fillOpacity={0.6} stroke={it.color} strokeWidth={2} />{label}{outline}{handle}</g>;
            if (it.type === 'arrow') return <g key={it.id} {...common}><line x1={it.x} y1={it.y} x2={it.x + it.w} y2={it.y + it.h} stroke="transparent" strokeWidth={12} /><line x1={it.x} y1={it.y} x2={it.x + it.w} y2={it.y + it.h} stroke={it.color} strokeWidth={2} markerEnd="url(#wbarrow)" />{outline}</g>;
            const d = (it.points ?? []).map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
            return <g key={it.id} {...common}><path d={d} fill="none" stroke="transparent" strokeWidth={12} /><path d={d} fill="none" stroke={it.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />{sel && <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1} strokeDasharray="4 3" />}</g>;
          })}
        </g>
      </svg>
      {edited && (
        <textarea autoFocus defaultValue={edited.text ?? ''}
          style={{ position: 'absolute', left: view.x + edited.x * view.k, top: view.y + edited.y * view.k, width: Math.max(120, edited.w * view.k), height: Math.max(40, edited.h * view.k), zIndex: 6, background: edited.type === 'note' ? edited.color : 'var(--card)', color: edited.type === 'note' ? '#1a1d20' : undefined }}
          onBlur={(e) => { const text = e.target.value; setEditing(null); commit(items.map((i) => (i.id === edited.id ? { ...i, text } : i)).filter((i) => i.type !== 'text' || i.text)); }}
          onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }} />
      )}
      {items.length === 0 && <div className="muted" style={{ position: 'absolute', top: '45%', width: '100%', textAlign: 'center', pointerEvents: 'none' }}>Werkzeug wählen und auf die Fläche klicken · Doppelklick bearbeitet Text · Mausrad zoomt</div>}
    </div>
  );
}
