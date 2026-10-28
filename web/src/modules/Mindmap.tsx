import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useToast } from '../components/ui';
import { Icon } from '../components/Icon';

export interface MindNode { id: string; text: string; color?: string; collapsed?: boolean; note?: string; link?: string; taskId?: string; children: MindNode[] }

export const BRANCH_COLORS = ['#4f46e5', '#e5484d', '#16a34a', '#f59e0b', '#0ea5e9', '#d946ef', '#14b8a6', '#f97316', '#64748b'];
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------------------------------------------------------------- Baum-Hilfen
const clone = (n: MindNode): MindNode => JSON.parse(JSON.stringify(n));
function find(root: MindNode, id: string, parent: MindNode | null = null): { node: MindNode; parent: MindNode | null } | null {
  if (root.id === id) return { node: root, parent };
  for (const c of root.children) { const r = find(c, id, root); if (r) return r; }
  return null;
}
const contains = (n: MindNode, id: string): boolean => n.id === id || n.children.some((c) => contains(c, id));
const countNodes = (n: MindNode): number => 1 + n.children.reduce((s, c) => s + countNodes(c), 0);

/** Gliederung als Markdown (Einrückung mit Leerzeichen) */
export function toOutline(n: MindNode, depth = 0): string {
  const line = depth === 0 ? `# ${n.text}` : `${'  '.repeat(depth - 1)}- ${n.text.replace(/\n/g, ' ')}`;
  return [line, ...(n.note && depth > 0 ? [`${'  '.repeat(depth)}  > ${n.note.replace(/\n/g, ' ')}`] : []), ...n.children.map((c) => toOutline(c, depth + 1))].join('\n');
}
/** Gliederung (Markdown-Liste, eingerückter Text) in eine Mindmap umwandeln */
export function fromOutline(text: string, fallbackTitle = 'Mindmap'): MindNode {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*>/.test(l));
  let root: MindNode = { id: 'root', text: fallbackTitle, children: [] };
  const stack: { indent: number; node: MindNode }[] = [];
  for (const raw of lines) {
    const h = raw.match(/^#\s+(.*)/);
    if (h && !stack.length && !root.children.length) { root = { ...root, text: h[1]!.trim() }; continue; }
    const m = raw.match(/^(\s*)(?:[-*+]|\d+[.)]|#{2,6})?\s*(.*)$/)!;
    const indent = raw.match(/^#{2,6}/) ? raw.match(/^#+/)![0].length * -10 + 100 : m[1]!.replace(/\t/g, '    ').length;
    const node: MindNode = { id: newId(), text: m[2]!.trim(), children: [] };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1]!.node : root).children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

// ---------------------------------------------------------------- Anordnung
interface Box { node: MindNode; x: number; y: number; w: number; h: number; depth: number; dir: 1 | -1; color: string; lines: string[]; parent: Box | null }
const PAD_X = 12, PAD_Y = 7, LINE = 19, MAX_W = 220, H_GAP = 46, V_GAP = 10;

let measureCtx: CanvasRenderingContext2D | null = null;
function wrap(text: string, font: string, maxW: number): { lines: string[]; w: number } {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx!; ctx.font = font;
  const lines: string[] = [];
  for (const para of (text || ' ').split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/)) {
      const t = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = word; } else cur = t;
    }
    lines.push(cur);
  }
  return { lines, w: Math.min(maxW, Math.max(24, ...lines.map((l) => ctx.measureText(l).width))) };
}

function layout(root: MindNode, fontFamily: string): Box[] {
  const out: Box[] = [];
  const size = (n: MindNode, depth: number) => {
    const font = depth === 0 ? `600 17px ${fontFamily}` : depth === 1 ? `600 14px ${fontFamily}` : `14px ${fontFamily}`;
    const { lines, w } = wrap(n.text, font, depth === 0 ? 260 : MAX_W);
    return { lines, w: Math.ceil(w) + PAD_X * 2 + 4 + (depth === 0 ? 12 : 0) + (n.taskId || n.note || n.link ? 18 : 0), h: lines.length * (depth === 0 ? 22 : LINE) + PAD_Y * 2 + (depth === 0 ? 8 : 0) };
  };
  const heights = new Map<string, number>();
  const sub = (n: MindNode, depth: number): number => {
    const own = size(n, depth).h;
    const kids = n.collapsed ? 0 : n.children.reduce((s, c, i) => s + sub(c, depth + 1) + (i ? V_GAP : 0), 0);
    const h = Math.max(own, kids);
    heights.set(n.id, h);
    return h;
  };
  const place = (n: MindNode, depth: number, x: number, top: number, dir: 1 | -1, color: string, parent: Box | null) => {
    const s = size(n, depth), sh = heights.get(n.id)!;
    const box: Box = { node: n, x: dir > 0 ? x : x - s.w, y: top + sh / 2 - s.h / 2, w: s.w, h: s.h, depth, dir, color: n.color ?? color, lines: s.lines, parent };
    out.push(box);
    if (n.collapsed) return;
    const total = n.children.reduce((a, c, i) => a + heights.get(c.id)! + (i ? V_GAP : 0), 0);
    let y = top + (sh - total) / 2;
    const nx = dir > 0 ? x + s.w + H_GAP : x - s.w - H_GAP;
    for (const c of n.children) { place(c, depth + 1, nx, y, dir, c.color ?? box.color, box); y += heights.get(c.id)! + V_GAP; }
  };
  const rs = size(root, 0);
  const rootBox: Box = { node: root, x: -rs.w / 2, y: -rs.h / 2, w: rs.w, h: rs.h, depth: 0, dir: 1, color: root.color ?? '#334155', lines: rs.lines, parent: null };
  out.push(rootBox);
  if (root.collapsed) return out;
  root.children.forEach((c) => sub(c, 1));
  const totalH = root.children.reduce((a, c) => a + heights.get(c.id)! + V_GAP, 0);
  const right: MindNode[] = [], left: MindNode[] = [];
  let acc = 0;
  root.children.forEach((c, i) => { if (acc < totalH / 2 || root.children.length < 3) { right.push(c); acc += heights.get(c.id)! + V_GAP; } else left.push(c); void i; });
  const side = (list: MindNode[], dir: 1 | -1) => {
    const h = list.reduce((a, c, i) => a + heights.get(c.id)! + (i ? V_GAP * 2 : 0), 0);
    let y = -h / 2;
    for (const c of list) {
      const idx = root.children.indexOf(c);
      place(c, 1, dir > 0 ? rs.w / 2 + H_GAP + 10 : -rs.w / 2 - H_GAP - 10, y, dir, c.color ?? BRANCH_COLORS[idx % BRANCH_COLORS.length]!, rootBox);
      y += heights.get(c.id)! + V_GAP * 2;
    }
  };
  side(right, 1); side(left, -1);
  return out;
}

function edgePath(p: Box, c: Box) {
  const x1 = p.depth === 0 ? p.x + p.w / 2 + (c.dir * p.w) / 2 : c.dir > 0 ? p.x + p.w : p.x;
  const y1 = p.y + p.h / 2;
  const x2 = c.dir > 0 ? c.x : c.x + c.w, y2 = c.y + c.h / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** eigenständiges SVG für Export als Bild */
function toSvg(boxes: Box[], fontFamily: string, dark: boolean) {
  const minX = Math.min(...boxes.map((b) => b.x)) - 30, maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 30;
  const minY = Math.min(...boxes.map((b) => b.y)) - 30, maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 30;
  const bg = dark ? '#121417' : '#ffffff', fg = dark ? '#e6edf3' : '#1a1d20', card = dark ? '#1a1d21' : '#ffffff';
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" font-family="${esc(fontFamily)}">`, `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${bg}"/>`];
  for (const b of boxes) if (b.parent) parts.push(`<path d="${edgePath(b.parent, b)}" fill="none" stroke="${b.color}" stroke-width="${Math.max(1.5, 4 - b.depth)}"/>`);
  for (const b of boxes) {
    const root = b.depth === 0, first = b.depth === 1;
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${root ? 14 : 8}" fill="${root ? b.color : first ? b.color + '22' : card}" stroke="${b.color}" stroke-width="${root ? 0 : 1.5}"/>`);
    b.lines.forEach((l, i) => parts.push(`<text x="${b.x + (root ? 18 : PAD_X)}" y="${b.y + PAD_Y + (root ? 4 : 0) + (i + 1) * (root ? 22 : LINE) - 5}" font-size="${root ? 17 : 14}" font-weight="${root || first ? 600 : 400}" fill="${root ? '#fff' : fg}">${esc(l)}</text>`));
  }
  parts.push('</svg>');
  return parts.join('');
}

function download(name: string, blob: Blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- Editor
export function MindmapEditor({ map, onSaved, projectId }: { map: { id: string; data: MindNode; version: number; canEdit: boolean }; onSaved?: (title: string) => void; projectId: string | null }) {
  const toast = useToast();
  const [data, setData] = useState<MindNode>(map.data);
  const [sel, setSel] = useState<string>('root');
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; target: string | null; mode: 'child' | 'before' | 'after' } | null>(null);
  const [panel, setPanel] = useState(false);
  const [status, setStatus] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const version = useRef(map.version);
  const hist = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const host = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const fontFamily = useMemo(() => getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif', []);
  const boxes = useMemo(() => layout(data, fontFamily), [data, fontFamily]);
  const byId = useMemo(() => new Map(boxes.map((b) => [b.node.id, b])), [boxes]);
  const ro = !map.canEdit;
  const selected = find(data, sel)?.node ?? data;

  // ---- speichern
  const save = useCallback(async (d: MindNode) => {
    setStatus('saving');
    try {
      const r = await api<{ version: number }>(`/mindmaps/${map.id}`, { method: 'PUT', body: { data: d, version: version.current }, quiet: true });
      version.current = r.version; setStatus('saved'); onSaved?.(d.text);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const cur = (e as ApiError & { details?: unknown }).details as { data: MindNode; version: number } | undefined;
        const fresh = cur?.data ? cur : await api<any>(`/mindmaps/${map.id}`);
        version.current = fresh.version; setData(fresh.data); setStatus('saved');
        toast('Jemand anderes hat die Mindmap gleichzeitig geändert. Die neueste Fassung wurde geladen – bitte Ihre letzte Änderung prüfen.', 'error');
      } else { setStatus('dirty'); toast((e as Error).message, 'error'); }
    }
  }, [map.id, onSaved, toast]);

  const change = (fn: (d: MindNode) => void, keepSel?: string) => {
    if (ro) return;
    const before = JSON.stringify(data);
    const d = clone(data); fn(d);
    hist.current.past.push(before); if (hist.current.past.length > 100) hist.current.past.shift();
    hist.current.future = [];
    setData(d); if (keepSel) setSel(keepSel);
    setStatus('dirty');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(d), 700);
  };
  const undo = (redo = false) => {
    const from = redo ? hist.current.future : hist.current.past, to = redo ? hist.current.past : hist.current.future;
    const s = from.pop(); if (!s) return;
    to.push(JSON.stringify(data));
    const d = JSON.parse(s) as MindNode; setData(d); setStatus('dirty');
    if (!find(d, sel)) setSel('root');
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void save(d), 700);
  };

  // Änderungen anderer übernehmen, wenn hier gerade nichts offen ist
  useEffect(() => realtime.subscribe(`mindmap:${map.id}`, (event, payload: any) => {
    if (event === 'mindmap.updated' && status === 'saved' && !edit) { version.current = payload.version; setData(payload.data); }
    if (event === 'mindmap.deleted') toast('Diese Mindmap wurde gelöscht.', 'error');
  }), [map.id, status, edit, toast]);
  useEffect(() => () => { window.clearTimeout(timer.current); }, []);
  // ungespeichert verlassen
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (status !== 'saved') e.preventDefault(); };
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h);
  }, [status]);

  // ---- Ansicht
  const fit = useCallback(() => {
    const el = host.current; if (!el || !boxes.length) return;
    const minX = Math.min(...boxes.map((b) => b.x)), maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const bar = 46;
    const k = Math.min(1.2, (el.clientWidth - 60) / (maxX - minX), (el.clientHeight - bar - 60) / (maxY - minY));
    setView({ k, x: el.clientWidth / 2 - ((minX + maxX) / 2) * k, y: bar + (el.clientHeight - bar) / 2 - ((minY + maxY) / 2) * k });
  }, [boxes]);
  useEffect(() => { fit(); }, [map.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoom = (f: number, cx?: number, cy?: number) => setView((v) => {
    const el = host.current!; const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    const k = Math.min(3, Math.max(0.15, v.k * f));
    return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
  });
  // ausgewählten Knoten sichtbar halten
  useEffect(() => {
    const b = byId.get(sel), el = host.current; if (!b || !el) return;
    const sx = b.x * view.k + view.x, sy = b.y * view.k + view.y;
    let { x, y } = view;
    if (sx < 20) x += 20 - sx; else if (sx + b.w * view.k > el.clientWidth - 20) x -= sx + b.w * view.k - el.clientWidth + 20;
    if (sy < 20) y += 20 - sy; else if (sy + b.h * view.k > el.clientHeight - 20) y -= sy + b.h * view.k - el.clientHeight + 20;
    if (x !== view.x || y !== view.y) setView({ ...view, x, y });
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Bearbeiten
  const addChild = (id = sel) => { const n = { id: newId(), text: '', children: [] }; change((d) => { const t = find(d, id)!.node; t.collapsed = false; t.children.push(n); }, n.id); setEdit({ id: n.id, text: '' }); };
  const addSibling = () => {
    if (sel === 'root') return addChild();
    const n = { id: newId(), text: '', children: [] };
    change((d) => { const f = find(d, sel)!; const i = f.parent!.children.findIndex((c) => c.id === sel); f.parent!.children.splice(i + 1, 0, n); }, n.id);
    setEdit({ id: n.id, text: '' });
  };
  const remove = (id = sel) => {
    if (id === 'root') return;
    const f = find(data, id)!; const sibs = f.parent!.children; const i = sibs.findIndex((c) => c.id === id);
    const next = sibs[i + 1]?.id ?? sibs[i - 1]?.id ?? f.parent!.id;
    change((d) => { const p = find(d, id)!.parent!; p.children = p.children.filter((c) => c.id !== id); }, next);
  };
  const commitEdit = () => {
    if (!edit) return;
    const text = edit.text.trim();
    const node = find(data, edit.id)?.node;
    setEdit(null);
    if (!node) return;
    if (!text && !node.text && edit.id !== 'root') { // leerer neuer Knoten: verwerfen
      const before = hist.current.past.pop();
      if (before) { const d = JSON.parse(before) as MindNode; setData(d); setSel(find(d, find(data, edit.id)!.parent!.id) ? find(data, edit.id)!.parent!.id : 'root'); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void save(d), 700); }
      return;
    }
    if (text && text !== node.text) change((d) => { find(d, edit.id)!.node.text = text; });
  };
  const toggle = (id = sel) => { const n = find(data, id)?.node; if (n?.children.length) change((d) => { const t = find(d, id)!.node; t.collapsed = !t.collapsed; }); };
  const setProp = (patch: Partial<MindNode>) => change((d) => { Object.assign(find(d, sel)!.node, patch); for (const k of Object.keys(patch) as (keyof MindNode)[]) if (patch[k] === undefined || patch[k] === '') delete find(d, sel)!.node[k]; });

  const createTask = async () => {
    if (!projectId) return;
    try {
      const t = await post<{ id: string; number: number }>(`/projects/${projectId}/tasks`, { title: selected.text.slice(0, 500) || 'Aufgabe', description: selected.note ?? '' });
      setProp({ taskId: t.id }); toast(`Aufgabe P${t.number} angelegt`);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  // ---- Tastatur
  const onKey = (e: React.KeyboardEvent) => {
    if (edit || (e.target as HTMLElement).closest('input, textarea, select, .mm-panel')) return;
    const b = byId.get(sel);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (!ro) addChild(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (!ro) addSibling(); return; }
    if (e.key === 'F2' || (e.key.length === 1 && !mod && e.key !== ' ' && !ro)) { e.preventDefault(); setEdit({ id: sel, text: e.key.length === 1 ? e.key : selected.text }); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (!ro) remove(); return; }
    if (e.key === ' ') { e.preventDefault(); toggle(); return; }
    if (!b) return;
    const kids = boxes.filter((x) => x.parent === b);
    const go = (id?: string) => { if (id) { e.preventDefault(); setSel(id); } };
    if (e.key === 'ArrowRight') go(b.depth === 0 ? kids.find((k) => k.dir > 0)?.node.id : b.dir > 0 ? kids[Math.floor(kids.length / 2)]?.node.id : b.parent?.node.id);
    if (e.key === 'ArrowLeft') go(b.depth === 0 ? kids.find((k) => k.dir < 0)?.node.id : b.dir < 0 ? kids[Math.floor(kids.length / 2)]?.node.id : b.parent?.node.id);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const cands = boxes.filter((x) => x !== b && x.dir === b.dir && x.depth === b.depth && (e.key === 'ArrowUp' ? x.y < b.y : x.y > b.y));
      cands.sort((p, q) => Math.abs(p.y - b.y) - Math.abs(q.y - b.y));
      go(cands[0]?.node.id);
    }
  };

  // ---- Maus: verschieben der Fläche, Knoten ziehen
  const toWorld = (cx: number, cy: number) => { const r = host.current!.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };
  const onBgDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.mm-node, .mm-panel, .mm-bar, textarea')) return;
    host.current?.focus();
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    const move = (ev: PointerEvent) => setView((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const onNodeDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || edit) return;
    e.stopPropagation(); setSel(id); host.current?.focus();
    if (ro || id === 'root') return;
    const start = { x: e.clientX, y: e.clientY };
    let state: typeof drag = null;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / view.k, dy = (ev.clientY - start.y) / view.k;
      if (!state && Math.hypot(dx, dy) < 6) return;
      const w = toWorld(ev.clientX, ev.clientY);
      const hit = boxes.find((b) => w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y - 4 && w.y <= b.y + b.h + 4 && !contains(find(data, id)!.node, b.node.id));
      let mode: 'child' | 'before' | 'after' = 'child';
      if (hit && hit.depth > 0) { const r = (w.y - hit.y) / hit.h; mode = r < 0.25 ? 'before' : r > 0.75 ? 'after' : 'child'; }
      state = { id, dx, dy, target: hit?.node.id ?? null, mode };
      setDrag(state);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!state?.target) return;
      const { target, mode } = state;
      change((d) => {
        const f = find(d, id)!; f.parent!.children = f.parent!.children.filter((c) => c.id !== id);
        const t = find(d, target)!;
        if (mode === 'child') { t.node.children.push(f.node); t.node.collapsed = false; }
        else { const arr = t.parent!.children; arr.splice(arr.findIndex((c) => c.id === target) + (mode === 'after' ? 1 : 0), 0, f.node); }
      }, id);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const exportImage = async (kind: 'svg' | 'png') => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const svg = toSvg(boxes, fontFamily, dark);
    const name = (data.text || 'Mindmap').replace(/[\\/:*?"<>|]/g, '_');
    if (kind === 'svg') return download(`${name}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.width * 2; c.height = img.height * 2;
    const g = c.getContext('2d')!; g.scale(2, 2); g.drawImage(img, 0, 0);
    c.toBlob((b) => b && download(`${name}.png`, b), 'image/png');
  };

  const editBox = edit ? byId.get(edit.id) : null;
  return (
    <div className="mm" ref={host} tabIndex={0} onKeyDown={onKey} onPointerDown={onBgDown}
      onWheel={(e) => { const r = host.current!.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); }}>
      <div className="mm-bar">
        {!ro && <>
          <button className="btn sm" onClick={() => addChild()} title="Unterpunkt (Tab)"><Icon name="plus" /> Unterpunkt</button>
          <button className="btn sm" onClick={addSibling} title="Gleiche Ebene (Enter)">Nachbar</button>
          <button className="btn sm" onClick={() => undo()} title="Rückgängig (Strg+Z)" disabled={!hist.current.past.length}><Icon name="undo" /></button>
          <button className="btn sm" onClick={() => undo(true)} title="Wiederholen (Strg+Y)" disabled={!hist.current.future.length}><Icon name="redo" /></button>
        </>}
        <button className="btn sm" onClick={() => zoom(1 / 1.2)} title="Verkleinern">−</button>
        <button className="btn sm" onClick={fit} title="Ganze Mindmap zeigen"><Icon name="maximize" /></button>
        <button className="btn sm" onClick={() => zoom(1.2)} title="Vergrößern">+</button>
        <span className="grow" />
        <span className="small muted">{status === 'saved' ? `${countNodes(data)} Punkte · gespeichert` : status === 'saving' ? 'speichert …' : 'ungespeichert'}</span>
        <button className="btn sm" onClick={() => void exportImage('png')}>Bild (PNG)</button>
        <button className="btn sm" onClick={() => void exportImage('svg')}>SVG</button>
        <button className="btn sm" onClick={() => download(`${data.text || 'Mindmap'}.md`, new Blob([toOutline(data)], { type: 'text/markdown' }))}>Gliederung</button>
        <button className={`btn sm ${panel ? 'primary' : ''}`} onClick={() => setPanel(!panel)}><Icon name="edit" /> Details</button>
      </div>
      <div className="mm-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="mm-edges" style={{ overflow: 'visible' }} width="1" height="1">
          {boxes.filter((b) => b.parent).map((b) => <path key={b.node.id} d={edgePath(b.parent!, b)} stroke={b.color} strokeWidth={Math.max(1.5, 4 - b.depth)} fill="none" opacity={drag?.id === b.node.id ? 0.3 : 1} />)}
        </svg>
        {boxes.map((b) => {
          const isDrag = drag?.id === b.node.id, isTarget = drag?.target === b.node.id;
          const cls = `mm-node d${Math.min(b.depth, 2)} ${sel === b.node.id ? 'sel' : ''} ${isTarget ? `drop-${drag!.mode}` : ''}`;
          return (
            <div key={b.node.id} className={cls} onPointerDown={(e) => onNodeDown(e, b.node.id)} onDoubleClick={() => !ro && setEdit({ id: b.node.id, text: b.node.text })}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h, '--c': b.color, transform: isDrag ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined, opacity: isDrag ? 0.7 : 1 } as React.CSSProperties}>
              {b.lines.map((l, i) => <div key={i}>{l || ' '}</div>)}
              {(b.node.taskId || b.node.note || b.node.link) && <span className="mm-badges">{b.node.taskId ? <Icon name="check" size={12} /> : b.node.link ? <Icon name="link" size={12} /> : <Icon name="note" size={12} />}</span>}
              {b.node.collapsed && b.node.children.length > 0 && <button className="mm-count" style={{ [b.dir > 0 ? 'right' : 'left']: -22 } as React.CSSProperties} onPointerDown={(e) => e.stopPropagation()} onClick={() => toggle(b.node.id)}>{countNodes(b.node) - 1}</button>}
              {!b.node.collapsed && b.node.children.length > 0 && b.depth > 0 && sel === b.node.id && <button className="mm-count small" title="Einklappen (Leertaste)" style={{ [b.dir > 0 ? 'right' : 'left']: -22 } as React.CSSProperties} onPointerDown={(e) => e.stopPropagation()} onClick={() => toggle(b.node.id)}>−</button>}
            </div>
          );
        })}
        {editBox && <textarea className="mm-edit" autoFocus value={edit!.text} placeholder="Gedanke …" style={{ left: editBox.x, top: editBox.y, width: Math.max(editBox.w, 180), minHeight: editBox.h }}
          onChange={(e) => setEdit({ ...edit!, text: e.target.value })} onBlur={commitEdit} onPointerDown={(e) => e.stopPropagation()}
          onFocus={(e) => { const v = e.target.value; e.target.setSelectionRange(v.length, v.length); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); setEdit(null); if (!find(data, edit!.id)?.node.text) commitEdit(); host.current?.focus(); }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); host.current?.focus(); }
            if (e.key === 'Tab') { e.preventDefault(); const id = edit!.id; commitEdit(); setTimeout(() => addChild(id), 0); }
          }} />}
      </div>
      {panel && (
        <div className="mm-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b>{selected.text || 'Punkt'}</b><button className="icon-btn" onClick={() => setPanel(false)} aria-label="Schließen"><Icon name="x" /></button></div>
          {!ro && <>
            <label className="small muted">Farbe</label>
            <div className="row wrap" style={{ gap: 4 }}>
              {BRANCH_COLORS.map((c) => <button key={c} className={`mm-swatch ${selected.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setProp({ color: c })} aria-label={`Farbe ${c}`} />)}
              <button className="btn ghost sm" onClick={() => setProp({ color: undefined })}>automatisch</button>
            </div>
          </>}
          <label className="small muted">Notiz</label>
          <textarea rows={5} readOnly={ro} key={`n${sel}`} defaultValue={selected.note ?? ''} onBlur={(e) => e.target.value !== (selected.note ?? '') && setProp({ note: e.target.value || undefined })} placeholder="Weitere Gedanken, Details …" />
          <label className="small muted">Link</label>
          <input readOnly={ro} key={`l${sel}`} defaultValue={selected.link ?? ''} placeholder="https://… oder /projects/…" onBlur={(e) => e.target.value !== (selected.link ?? '') && setProp({ link: e.target.value.trim() || undefined })} />
          {selected.link && (selected.link.startsWith('/') ? <Link to={selected.link} className="small">Link öffnen</Link> : <a href={selected.link} target="_blank" rel="noreferrer" className="small">Link öffnen</a>)}
          {projectId && sel !== 'root' && (selected.taskId
            ? <Link className="btn sm" to={`/projects/${projectId}?task=${selected.taskId}`}><Icon name="check" /> Zur Aufgabe</Link>
            : !ro && <button className="btn sm" onClick={() => void createTask()}><Icon name="check" /> Als Aufgabe anlegen</button>)}
          {!ro && sel !== 'root' && <button className="btn ghost sm danger" onClick={() => remove()}><Icon name="trash" /> Punkt löschen</button>}
          <p className="hint">Tastatur: <b>Tab</b> Unterpunkt · <b>Enter</b> Nachbar · <b>Tippen</b> oder <b>F2</b> Text ändern · <b>Entf</b> löschen · <b>Leertaste</b> ein-/ausklappen · <b>Pfeile</b> wechseln · Punkte mit der Maus auf andere ziehen.</p>
        </div>
      )}
      {!panel && !ro && boxes.length === 1 && <div className="mm-hint">Mit <b>Tab</b> den ersten Gedanken anlegen, mit <b>Enter</b> den nächsten.</div>}
    </div>
  );
}
