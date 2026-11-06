import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { fmtDateTime } from '../lib/format';
import { Dropdown, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import {
  MM_ICONS, MM_PRIORITIES, allNodes, ancestors, clone, contains, countNodes, find, fromFreeMind, fromOutline, iconFor, jpegToPdf, newId, reId,
  toFreeMind, toHtml, toOutline, toText, type MindAttr, type MindNode,
} from './MindmapFormats';

export type { MindNode } from './MindmapFormats';
export { fromOutline, toOutline } from './MindmapFormats';

export const BRANCH_COLORS = ['#4f46e5', '#e5484d', '#16a34a', '#f59e0b', '#0ea5e9', '#d946ef', '#14b8a6', '#f97316', '#64748b'];
const TEXT_COLORS = ['#1a1d20', '#4f46e5', '#b91c1c', '#15803d', '#b45309', '#0369a1', '#a21caf', '#64748b', '#ffffff'];
const BG_COLORS = ['#fff7c2', '#ffe1e1', '#dcfce7', '#dbeafe', '#f3e8ff', '#ffedd5', '#e2e8f0', '#1e293b'];
const CLOUD_COLORS = ['#d6e4ff', '#ffe4c4', '#d9f99d', '#fde2f3', '#e5e7eb', '#cffafe'];
const SIZES: [number | undefined, string][] = [[12, 'klein'], [undefined, 'normal'], [18, 'groß'], [22, 'sehr groß']];

// ---------------------------------------------------------------- Anordnung
interface Box {
  node: MindNode; x: number; y: number; w: number; h: number; depth: number; dir: 1 | -1; color: string; lines: string[]; parent: Box | null;
  fs: number; lh: number; weight: number; iconsW: number; attrs: string[]; edgeStyle: NonNullable<MindNode['edgeStyle']>; edgeWidth: number | null; shape: NonNullable<MindNode['shape']>;
}
const PAD_X = 12, PAD_Y = 7, MAX_W = 220, H_GAP = 46, V_GAP = 10, ATTR_H = 16, BADGE_W = 16;

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
const badgeCount = (n: MindNode) => [n.taskId, n.note, n.link, n.reminder, n.ref].filter(Boolean).length;
const fontOf = (n: MindNode, depth: number, family: string) => {
  const fs = n.size ?? (depth === 0 ? 17 : 14);
  const weight = n.bold || depth <= 1 ? 600 : 400;
  return { fs, weight, lh: Math.round(fs * 1.36), font: `${n.italic ? 'italic ' : ''}${weight} ${fs}px ${family}` };
};

function layout(root: MindNode, family: string, folded: (n: MindNode) => boolean): Box[] {
  const out: Box[] = [];
  const size = (n: MindNode, depth: number) => {
    const f = fontOf(n, depth, family);
    const { lines, w } = wrap(n.text, f.font, depth === 0 ? 260 : MAX_W);
    const iconsW = (n.icons?.length ?? 0) * (f.fs + 4);
    const attrs = (n.attrs ?? []).map((a) => `${a.k}: ${a.v}`);
    const attrW = attrs.length ? wrap(attrs.join('\n'), `12px ${family}`, MAX_W).w : 0;
    const w2 = Math.ceil(Math.max(w + iconsW, attrW)) + PAD_X * 2 + 4 + (depth === 0 ? 12 : 0) + badgeCount(n) * BADGE_W;
    const h = lines.length * f.lh + PAD_Y * 2 + (depth === 0 ? 8 : 0) + attrs.length * ATTR_H + (attrs.length ? 4 : 0);
    return { ...f, lines, w: w2, h, iconsW, attrs };
  };
  const heights = new Map<string, number>();
  const sub = (n: MindNode, depth: number): number => {
    const own = size(n, depth).h;
    const kids = folded(n) ? 0 : n.children.reduce((s, c, i) => s + sub(c, depth + 1) + (i ? V_GAP : 0), 0);
    const h = Math.max(own, kids);
    heights.set(n.id, h);
    return h;
  };
  const mk = (n: MindNode, depth: number, x: number, y: number, dir: 1 | -1, color: string, parent: Box | null, s: ReturnType<typeof size>): Box => ({
    node: n, x: dir > 0 ? x : x - s.w, y, w: s.w, h: s.h, depth, dir, color: n.color ?? color, lines: s.lines, parent, fs: s.fs, lh: s.lh, weight: s.weight,
    iconsW: s.iconsW, attrs: s.attrs, edgeStyle: n.edgeStyle ?? parent?.edgeStyle ?? 'bezier', edgeWidth: n.edgeWidth ?? parent?.edgeWidth ?? null,
    shape: depth === 0 ? 'box' : n.shape ?? 'box',
  });
  const place = (n: MindNode, depth: number, x: number, top: number, dir: 1 | -1, color: string, parent: Box | null) => {
    const s = size(n, depth), sh = heights.get(n.id)!;
    const box = mk(n, depth, x, top + sh / 2 - s.h / 2, dir, color, parent, s);
    out.push(box);
    if (folded(n)) return;
    const total = n.children.reduce((a, c, i) => a + heights.get(c.id)! + (i ? V_GAP : 0), 0);
    let y = top + (sh - total) / 2;
    const nx = dir > 0 ? x + s.w + H_GAP : x - s.w - H_GAP;
    for (const c of n.children) { place(c, depth + 1, nx, y, dir, c.color ?? box.color, box); y += heights.get(c.id)! + V_GAP; }
  };
  const rs = size(root, 0);
  const rootBox = mk(root, 0, -rs.w / 2, -rs.h / 2, 1, root.color ?? '#334155', null, rs);
  out.push(rootBox);
  if (folded(root)) return out;
  root.children.forEach((c) => sub(c, 1));
  const totalH = root.children.reduce((a, c) => a + heights.get(c.id)! + V_GAP, 0);
  const right: MindNode[] = [], left: MindNode[] = [];
  let acc = 0;
  for (const c of root.children) { if (acc < totalH / 2 || root.children.length < 3) { right.push(c); acc += heights.get(c.id)! + V_GAP; } else left.push(c); }
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
  const y1 = p.shape === 'fork' ? p.y + p.h : p.y + p.h / 2;
  const x2 = c.dir > 0 ? c.x : c.x + c.w, y2 = c.shape === 'fork' ? c.y + c.h : c.y + c.h / 2;
  const mx = (x1 + x2) / 2;
  if (c.edgeStyle === 'linear') return `M${x1},${y1} L${x2},${y2}`;
  if (c.edgeStyle === 'angled') return `M${x1},${y1} H${mx} V${y2} H${x2}`;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}
const edgeW = (b: Box) => b.edgeWidth ?? Math.max(1.5, 4 - b.depth);

/** Wolken: Fläche hinter einem Punkt und allen sichtbaren Unterpunkten */
function clouds(boxes: Box[]) {
  const out: { id: string; x: number; y: number; w: number; h: number; color: string }[] = [];
  for (const b of boxes) {
    if (!b.node.cloud) continue;
    const inside = boxes.filter((x) => contains(b.node, x.node.id));
    const minX = Math.min(...inside.map((x) => x.x)) - 10, maxX = Math.max(...inside.map((x) => x.x + x.w)) + 10;
    const minY = Math.min(...inside.map((x) => x.y)) - 10, maxY = Math.max(...inside.map((x) => x.y + x.h)) + 10;
    out.push({ id: b.node.id, x: minX, y: minY, w: maxX - minX, h: maxY - minY, color: b.node.cloud });
  }
  return out;
}
/** Pfeilverbindungen zwischen beliebigen Punkten */
function arrowPaths(boxes: Box[], byId: Map<string, Box>) {
  const out: { key: string; d: string; label?: string; lx: number; ly: number }[] = [];
  for (const b of boxes) for (const [i, a] of (b.node.arrows ?? []).entries()) {
    const t = byId.get(a.to);
    if (!t) continue;
    const right = t.x + t.w / 2 > b.x + b.w / 2;
    const x1 = right ? b.x + b.w : b.x, y1 = b.y + b.h / 2, x2 = right ? t.x : t.x + t.w, y2 = t.y + t.h / 2;
    const bend = Math.min(140, Math.max(50, Math.abs(x2 - x1) / 3));
    const c1x = x1 + (right ? bend : -bend), c2x = x2 + (right ? -bend : bend), cy = Math.min(y1, y2) - 40;
    out.push({ key: `${b.node.id}-${i}`, d: `M${x1},${y1} C${c1x},${cy} ${c2x},${cy} ${x2},${y2}`, label: a.label, lx: (x1 + x2) / 2, ly: cy + 10 });
  }
  return out;
}

// ---------------------------------------------------------------- Export als Bild
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Symbole für den Export: aus der unsichtbaren Vorlage im Editor (gleiche Grafiken wie auf dem Bildschirm) */
function iconSvg(name: string, size: number, color: string, x: number, y: number) {
  const inner = document.querySelector(`.mm-iconsrc [data-i="${name}"] svg`)?.innerHTML ?? '<circle cx="12" cy="12" r="8"/>';
  return `<g transform="translate(${x},${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="color:${color}">${inner}</g>`;
}
function prioSvg(p: string, size: number, x: number, y: number) {
  const r = size / 2;
  return `<circle cx="${x + r}" cy="${y + r}" r="${r}" fill="#e5484d"/><text x="${x + r}" y="${y + r + size * 0.33}" font-size="${size * 0.8}" font-weight="700" fill="#fff" text-anchor="middle">${p.slice(1)}</text>`;
}

/** Eigenständiges SVG der ganzen Karte (für PNG, SVG und PDF) */
function toSvg(boxes: Box[], family: string, dark: boolean) {
  const byId = new Map(boxes.map((b) => [b.node.id, b]));
  const cl = clouds(boxes);
  const all = [...boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })), ...cl];
  const minX = Math.min(...all.map((b) => b.x)) - 30, maxX = Math.max(...all.map((b) => b.x + b.w)) + 30;
  const minY = Math.min(...all.map((b) => b.y)) - 60, maxY = Math.max(...all.map((b) => b.y + b.h)) + 30;
  const bg = dark ? '#121417' : '#ffffff', fg = dark ? '#e6edf3' : '#1a1d20', card = dark ? '#1a1d21' : '#ffffff', muted = dark ? '#94a3b8' : '#64748b';
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" font-family="${esc(family)}">`,
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${muted}"/></marker></defs>`,
    `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${bg}"/>`];
  for (const c of cl) parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="22" fill="${c.color}" fill-opacity="0.45" stroke="${c.color}" stroke-width="2"/>`);
  for (const b of boxes) if (b.parent) parts.push(`<path d="${edgePath(b.parent, b)}" fill="none" stroke="${b.color}" stroke-width="${edgeW(b)}"/>`);
  for (const b of boxes) {
    const n = b.node, root = b.depth === 0, first = b.depth === 1;
    const fill = n.bg ?? (root ? b.color : b.shape === 'fork' ? 'none' : first ? `${b.color}22` : card);
    const color = n.fg ?? (root && !n.bg ? '#ffffff' : fg);
    if (b.shape === 'fork') parts.push(`<line x1="${b.x}" y1="${b.y + b.h}" x2="${b.x + b.w}" y2="${b.y + b.h}" stroke="${b.color}" stroke-width="${edgeW(b)}"/>`);
    if (b.shape !== 'fork' || n.bg) parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${root ? 14 : b.shape === 'bubble' ? Math.min(b.h / 2, 20) : 8}" fill="${fill}" stroke="${b.color}" stroke-width="${root || b.shape === 'fork' ? 0 : 1.5}"/>`);
    const left = b.x + (root ? 18 : PAD_X), top = b.y + PAD_Y + (root ? 4 : 0);
    (n.icons ?? []).forEach((ic, i) => parts.push(MM_PRIORITIES.includes(ic) ? prioSvg(ic, b.fs, left + i * (b.fs + 4), top + (b.lh - b.fs) / 2) : iconSvg(iconFor(ic)?.icon ?? 'circle', b.fs, color, left + i * (b.fs + 4), top + (b.lh - b.fs) / 2)));
    b.lines.forEach((l, i) => parts.push(`<text x="${left + b.iconsW}" y="${top + (i + 1) * b.lh - b.lh * 0.27}" font-size="${b.fs}" font-weight="${b.weight}"${n.italic ? ' font-style="italic"' : ''} fill="${color}">${esc(l)}</text>`));
    b.attrs.forEach((a, i) => parts.push(`<text x="${left}" y="${top + b.lines.length * b.lh + 4 + (i + 1) * ATTR_H - 4}" font-size="12" fill="${muted}">${esc(a)}</text>`));
  }
  for (const a of arrowPaths(boxes, byId)) {
    parts.push(`<path d="${a.d}" fill="none" stroke="${muted}" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#arr)"/>`);
    if (a.label) parts.push(`<text x="${a.lx}" y="${a.ly}" font-size="12" text-anchor="middle" fill="${muted}" stroke="${bg}" stroke-width="4" paint-order="stroke">${esc(a.label)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

function download(name: string, blob: Blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const fileName = (s: string) => (s || 'Mindmap').replace(/[\\/:*?"<>|]/g, '_');

/** Symbol eines Punkts (eingebaut oder Priorität) */
function NodeIcon({ k, size }: { k: string; size: number }) {
  if (MM_PRIORITIES.includes(k)) return <span className="mm-prio" style={{ width: size, height: size, fontSize: size * 0.72 }}>{k.slice(1)}</span>;
  return <Icon name={iconFor(k)?.icon ?? 'circle'} size={size} />;
}

const matches = (n: MindNode, q: string) => {
  const s = q.toLowerCase();
  return n.text.toLowerCase().includes(s) || (n.note ?? '').toLowerCase().includes(s) || (n.attrs ?? []).some((a) => `${a.k} ${a.v}`.toLowerCase().includes(s));
};
const toLocalInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

// ---------------------------------------------------------------- Editor
export function MindmapEditor({ map, onSaved, projectId, focusNode }: { map: { id: string; data: MindNode; version: number; canEdit: boolean }; onSaved?: (title: string) => void; projectId: string | null; focusNode?: string | null }) {
  const toast = useToast();
  const [data, setData] = useState<MindNode>(map.data);
  const [sel, setSel] = useState<string>(() => (focusNode && find(map.data, focusNode) ? focusNode : 'root'));
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; target: string | null; mode: 'child' | 'before' | 'after' } | null>(null);
  const [panel, setPanel] = useState<null | 'content' | 'format'>(null);
  const [mode, setMode] = useState<'map' | 'table'>('map');
  const [status, setStatus] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const [query, setQuery] = useState('');
  const [onlyHits, setOnlyHits] = useState(false);
  const [arrowFrom, setArrowFrom] = useState<string | null>(null);
  /** vorübergehend aufgeklappt (Suche, Sprung) bzw. eigene Klappung für Nur-Lesen */
  const [peek, setPeek] = useState<Set<string>>(() => new Set(focusNode ? ancestors(map.data, focusNode) : []));
  const [fold, setFold] = useState<Map<string, boolean>>(new Map());
  const version = useRef(map.version);
  const hist = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const host = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const family = useMemo(() => getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif', []);
  const folded = useCallback((n: MindNode) => (fold.has(n.id) ? fold.get(n.id)! : Boolean(n.collapsed) && !peek.has(n.id)) && n.children.length > 0, [fold, peek]);
  const boxes = useMemo(() => layout(data, family, folded), [data, family, folded]);
  const byId = useMemo(() => new Map(boxes.map((b) => [b.node.id, b])), [boxes]);
  const ro = !map.canEdit;
  const selected = find(data, sel)?.node ?? data;
  const hits = useMemo(() => (query.trim() ? allNodes(data).filter((x) => matches(x.node, query.trim())).map((x) => x.node.id) : []), [data, query]);
  const hitSet = useMemo(() => new Set(hits), [hits]);
  const keep = useMemo(() => { const s = new Set<string>(); for (const h of hits) { s.add(h); ancestors(data, h).forEach((a) => s.add(a)); } return s; }, [hits, data]);

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
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (status !== 'saved') e.preventDefault(); };
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h);
  }, [status]);

  // ---- Ansicht
  const barHeight = () => host.current?.querySelector<HTMLElement>('.mm-bar')?.offsetHeight ?? 46;
  const fit = useCallback(() => {
    const el = host.current; if (!el || !boxes.length) return;
    const minX = Math.min(...boxes.map((b) => b.x)), maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const bar = barHeight();
    const k = Math.min(1.2, (el.clientWidth - 60) / (maxX - minX), (el.clientHeight - bar - 60) / (maxY - minY));
    setView({ k, x: el.clientWidth / 2 - ((minX + maxX) / 2) * k, y: bar + (el.clientHeight - bar) / 2 - ((minY + maxY) / 2) * k });
  }, [boxes]);
  useEffect(() => { fit(); }, [map.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoom = (f: number, cx?: number, cy?: number) => setView((v) => {
    const el = host.current!; const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    const k = Math.min(3, Math.max(0.15, v.k * f));
    return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
  });
  // ausgewählten Punkt sichtbar halten (nicht beim ersten Anzeigen – da wird eingepasst)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const b = byId.get(sel), el = host.current; if (!b || !el || mode !== 'map') return;
    const top = barHeight() + 10, right = panel ? 310 : 20;
    setView((v) => {
      const sx = b.x * v.k + v.x, sy = b.y * v.k + v.y;
      let { x, y } = v;
      if (sx < 20) x += 20 - sx; else if (sx + b.w * v.k > el.clientWidth - right) x -= sx + b.w * v.k - el.clientWidth + right;
      if (sy < top) y += top - sy; else if (sy + b.h * v.k > el.clientHeight - 20) y -= sy + b.h * v.k - el.clientHeight + 20;
      return x !== v.x || y !== v.y ? { ...v, x, y } : v;
    });
  }, [sel, byId]); // eslint-disable-line react-hooks/exhaustive-deps
  /** zu einem Punkt springen: Vorfahren aufklappen, auswählen */
  const jump = (id: string) => {
    if (!find(data, id)) return;
    const path = ancestors(data, id);
    setPeek((p) => new Set([...p, ...path]));
    setFold((f) => { const n = new Map(f); path.forEach((a) => n.delete(a)); return n; });
    setMode('map'); setSel(id); host.current?.focus();
  };

  // ---- Bearbeiten
  const stamp = (n: MindNode) => { n.modified = Date.now(); };
  const addChild = (id = sel) => { const n: MindNode = { id: newId(), text: '', children: [], created: Date.now() }; change((d) => { const t = find(d, id)!.node; t.collapsed = false; t.children.push(n); }, n.id); setPeek((p) => new Set([...p, id])); setEdit({ id: n.id, text: '' }); };
  const addSibling = () => {
    if (sel === 'root') return addChild();
    const n: MindNode = { id: newId(), text: '', children: [], created: Date.now() };
    change((d) => { const f = find(d, sel)!; const i = f.parent!.children.findIndex((c) => c.id === sel); f.parent!.children.splice(i + 1, 0, n); }, n.id);
    setEdit({ id: n.id, text: '' });
  };
  const remove = (id = sel) => {
    if (id === 'root') return;
    const f = find(data, id)!; const sibs = f.parent!.children; const i = sibs.findIndex((c) => c.id === id);
    const next = sibs[i + 1]?.id ?? sibs[i - 1]?.id ?? f.parent!.id;
    change((d) => { const p = find(d, id)!.parent!; p.children = p.children.filter((c) => c.id !== id); }, next);
  };
  const moveSibling = (delta: -1 | 1) => {
    if (sel === 'root') return;
    change((d) => { const f = find(d, sel)!; const arr = f.parent!.children; const i = arr.findIndex((c) => c.id === sel); const j = i + delta; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j]!, arr[i]!]; });
  };
  const commitEdit = () => {
    if (!edit) return;
    const text = edit.text.trim();
    const node = find(data, edit.id)?.node;
    setEdit(null);
    if (!node) return;
    if (!text && !node.text && edit.id !== 'root') { // leerer neuer Punkt: verwerfen
      const before = hist.current.past.pop();
      const parentId = find(data, edit.id)!.parent!.id;
      if (before) { const d = JSON.parse(before) as MindNode; setData(d); setSel(find(d, parentId) ? parentId : 'root'); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void save(d), 700); }
      return;
    }
    if (text && text !== node.text) change((d) => { const n = find(d, edit.id)!.node; n.text = text; stamp(n); });
  };
  const toggle = (id = sel) => { const n = find(data, id)?.node; if (n?.children.length) setFolded([id], !folded(n)); };
  /** Klappen: Bearbeiter speichern es in der Karte, wer nur liest, für sich */
  const setFolded = (ids: string[], value: boolean) => {
    if (!ids.length) return;
    setPeek((p) => { const n = new Set(p); ids.forEach((i) => n.delete(i)); return n; });
    if (ro) { setFold((f) => { const n = new Map(f); ids.forEach((i) => n.set(i, value)); return n; }); return; }
    change((d) => { for (const id of ids) { const n = find(d, id)?.node; if (n) { if (value) n.collapsed = true; else delete n.collapsed; } } });
  };
  const subtree = () => allNodes(selected).filter((x) => x.node.children.length > 0);
  const foldAll = (value: boolean) => setFolded(subtree().filter((x) => x.depth > 0 || (value ? false : true)).map((x) => x.node.id), value);
  /** eine Ebene mehr zeigen: die obersten eingeklappten Punkte aufklappen */
  const unfoldLevel = () => {
    const vis: { id: string; depth: number }[] = [];
    const walk = (n: MindNode, d: number) => { if (!n.children.length) return; if (folded(n)) { vis.push({ id: n.id, depth: d }); return; } n.children.forEach((c) => walk(c, d + 1)); };
    walk(selected, 0);
    const min = Math.min(...vis.map((v) => v.depth));
    setFolded(vis.filter((v) => v.depth === min).map((v) => v.id), false);
  };
  /** eine Ebene weniger: die tiefsten aufgeklappten Punkte einklappen */
  const foldLevel = () => {
    const vis: { id: string; depth: number }[] = [];
    const walk = (n: MindNode, d: number) => { if (!n.children.length || folded(n)) return; vis.push({ id: n.id, depth: d }); n.children.forEach((c) => walk(c, d + 1)); };
    walk(selected, 0);
    const cand = vis.filter((v) => v.depth > 0 || selected.id !== 'root');
    const max = Math.max(...cand.map((v) => v.depth));
    setFolded(cand.filter((v) => v.depth === max).map((v) => v.id), true);
  };
  const setProp = (patch: Partial<MindNode>, id = sel) => change((d) => {
    const n = find(d, id)!.node;
    Object.assign(n, patch);
    for (const k of Object.keys(patch) as (keyof MindNode)[]) if (patch[k] === undefined || patch[k] === '' || (Array.isArray(patch[k]) && !(patch[k] as unknown[]).length)) delete n[k];
    stamp(n);
  });
  const toggleIcon = (k: string) => {
    const cur = selected.icons ?? [];
    let next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    if (MM_PRIORITIES.includes(k) && !cur.includes(k)) next = next.filter((x) => x === k || !MM_PRIORITIES.includes(x));
    setProp({ icons: next });
  };
  const addArrow = (from: string, to: string) => {
    if (from === to) return;
    const n = find(data, from)?.node;
    if (n?.arrows?.some((a) => a.to === to)) return;
    setProp({ arrows: [...(n?.arrows ?? []), { to }] }, from);
    toast('Pfeil gesetzt – Beschriftung unter „Inhalt“');
  };

  const createTask = async () => {
    if (!projectId) return;
    try {
      const t = await post<{ id: string; number: number }>(`/projects/${projectId}/tasks`, { title: selected.text.slice(0, 500) || 'Aufgabe', description: selected.note ?? '' });
      setProp({ taskId: t.id }); toast(`Aufgabe P${t.number} angelegt`);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  // ---- Zwischenablage: Teilbäume kopieren, ausschneiden, einfügen (auch als Gliederung aus anderen Programmen)
  const CLIP = 'aperio-mm-clip';
  const onCopy = (e: React.ClipboardEvent, cut = false) => {
    if (edit || (e.target as HTMLElement).closest('input, textarea')) return;
    e.preventDefault();
    const text = sel === 'root' ? toOutline(selected) : toOutline({ ...selected, id: 'root' }).replace(/^# /, '- ');
    e.clipboardData.setData('text/plain', text);
    try { localStorage.setItem(CLIP, JSON.stringify({ text, node: selected })); } catch { /* privat */ }
    if (cut && sel !== 'root') remove();
    toast(cut ? 'Ausgeschnitten' : 'Kopiert');
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (ro || edit || (e.target as HTMLElement).closest('input, textarea')) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text.trim()) return;
    e.preventDefault();
    let nodes: MindNode[];
    try {
      const stored = JSON.parse(localStorage.getItem(CLIP) ?? 'null') as { text: string; node: MindNode } | null;
      if (stored && stored.text === text) nodes = [reId(stored.node)];
      else { const r = fromOutline(text, ''); nodes = r.text ? [{ ...r, id: newId() }] : r.children; }
    } catch { const r = fromOutline(text, ''); nodes = r.text ? [{ ...r, id: newId() }] : r.children; }
    if (!nodes.length) return;
    change((d) => { const t = find(d, sel)!.node; t.collapsed = false; t.children.push(...nodes.map((n) => ({ ...n, created: n.created ?? Date.now() }))); }, nodes[0]!.id);
  };

  // ---- Tastatur
  const onKey = (e: React.KeyboardEvent) => {
    if (edit || (e.target as HTMLElement).closest('input, textarea, select, .mm-panel')) return;
    const b = byId.get(sel);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape' && arrowFrom) { setArrowFrom(null); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); if (!ro) setProp({ bold: selected.bold ? undefined : true }); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); if (!ro) setProp({ italic: selected.italic ? undefined : true }); return; }
    if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); if (!ro) moveSibling(e.key === 'ArrowUp' ? -1 : 1); return; }
    if (mod) return; // Strg+C/X/V laufen über die Zwischenablage-Ereignisse
    if (e.key === 'Tab') { e.preventDefault(); if (!ro) addChild(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (!ro) addSibling(); return; }
    if (e.key === 'F2' || (e.key.length === 1 && e.key !== ' ' && !ro)) { e.preventDefault(); setEdit({ id: sel, text: e.key.length === 1 ? e.key : selected.text }); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (!ro) remove(); return; }
    if (e.key === ' ') { e.preventDefault(); toggle(); return; }
    if (e.key === 'Home') { e.preventDefault(); setSel('root'); return; }
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

  // ---- Maus: Fläche verschieben, Punkte ziehen
  const toWorld = (cx: number, cy: number) => { const r = host.current!.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };
  const onBgDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.mm-node, .mm-panel, .mm-bar, textarea, .mm-table')) return;
    host.current?.focus();
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    const move = (ev: PointerEvent) => setView((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const onNodeDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || edit) return;
    e.stopPropagation();
    if (arrowFrom) { addArrow(arrowFrom, id); setArrowFrom(null); setSel(arrowFrom); return; }
    setSel(id); host.current?.focus();
    if (ro || id === 'root') return;
    const start = { x: e.clientX, y: e.clientY };
    let state: typeof drag = null;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / view.k, dy = (ev.clientY - start.y) / view.k;
      if (!state && Math.hypot(dx, dy) < 6) return;
      const w = toWorld(ev.clientX, ev.clientY);
      const hit = boxes.find((b) => w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y - 4 && w.y <= b.y + b.h + 4 && !contains(find(data, id)!.node, b.node.id));
      let m: 'child' | 'before' | 'after' = 'child';
      if (hit && hit.depth > 0) { const r = (w.y - hit.y) / hit.h; m = r < 0.25 ? 'before' : r > 0.75 ? 'after' : 'child'; }
      state = { id, dx, dy, target: hit?.node.id ?? null, mode: m };
      setDrag(state);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!state?.target) return;
      const { target, mode: m } = state;
      change((d) => {
        const f = find(d, id)!; f.parent!.children = f.parent!.children.filter((c) => c.id !== id);
        const t = find(d, target)!;
        if (m === 'child') { t.node.children.push(f.node); t.node.collapsed = false; }
        else { const arr = t.parent!.children; arr.splice(arr.findIndex((c) => c.id === target) + (m === 'after' ? 1 : 0), 0, f.node); }
      }, id);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // ---- Export und Import
  const name = fileName(data.text);
  const renderCanvas = async () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const svg = toSvg(boxes, family, dark);
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.width * 2; c.height = img.height * 2;
    const g = c.getContext('2d')!; g.fillStyle = dark ? '#121417' : '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.scale(2, 2); g.drawImage(img, 0, 0);
    return c;
  };
  const exportAs = async (kind: 'png' | 'svg' | 'pdf' | 'html' | 'md' | 'txt' | 'mm') => {
    if (kind === 'svg') return download(`${name}.svg`, new Blob([toSvg(boxes, family, document.documentElement.dataset.theme === 'dark')], { type: 'image/svg+xml' }));
    if (kind === 'png') { const c = await renderCanvas(); return c.toBlob((b) => b && download(`${name}.png`, b), 'image/png'); }
    if (kind === 'pdf') {
      const c = await renderCanvas();
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (blob) download(`${name}.pdf`, jpegToPdf(new Uint8Array(await blob.arrayBuffer()), c.width, c.height));
      return;
    }
    if (kind === 'html') return download(`${name}.html`, new Blob([toHtml(data)], { type: 'text/html' }));
    if (kind === 'md') return download(`${name}.md`, new Blob([toOutline(data)], { type: 'text/markdown' }));
    if (kind === 'txt') return download(`${name}.txt`, new Blob([toText(data)], { type: 'text/plain' }));
    return download(`${name}.mm`, new Blob([toFreeMind(data)], { type: 'application/x-freemind' }));
  };
  /** Datei unter dem gewählten Punkt einfügen: FreeMind (.mm) oder Gliederung (.md, .txt) */
  const importFile = async (f: File) => {
    try {
      const text = await f.text();
      const sub = /\.mm$/i.test(f.name) ? fromFreeMind(text) : fromOutline(text, f.name.replace(/\.[^.]+$/, ''));
      const node = reId({ ...sub, id: 'x' });
      change((d) => { const t = find(d, sel)!.node; t.collapsed = false; t.children.push(node); }, node.id);
      toast(`${countNodes(node)} Punkte eingefügt`);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const editBox = edit ? byId.get(edit.id) : null;
  const cl = useMemo(() => clouds(boxes), [boxes]);
  const arrows = useMemo(() => arrowPaths(boxes, byId), [boxes, byId]);
  const hitIndex = hits.indexOf(sel);
  const nextHit = (back = false) => { if (!hits.length) return; const i = hitIndex < 0 ? 0 : (hitIndex + (back ? hits.length - 1 : 1)) % hits.length; jump(hits[i]!); };
  const now = new Date().toISOString();

  return (
    <div className="mm" ref={host} tabIndex={0} onKeyDown={onKey} onPointerDown={onBgDown} onCopy={(e) => onCopy(e)} onCut={(e) => !ro && onCopy(e, true)} onPaste={onPaste}
      onWheel={(e) => { if (mode !== 'map') return; const r = host.current!.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); }}>
      <div className="mm-bar">
        {!ro && <>
          <button className="btn sm" onClick={() => addChild()} title="Unterpunkt (Tab)"><Icon name="plus" /> Unterpunkt</button>
          <button className="btn sm" onClick={addSibling} title="Gleiche Ebene (Enter)">Nachbar</button>
          <button className="btn sm" onClick={() => undo()} title="Rückgängig (Strg+Z)" disabled={!hist.current.past.length}><Icon name="undo" /></button>
          <button className="btn sm" onClick={() => undo(true)} title="Wiederholen (Strg+Y)" disabled={!hist.current.future.length}><Icon name="redo" /></button>
        </>}
        <Dropdown align="left" trigger={(t) => <button className="btn sm" onClick={t}>Ansicht <Icon name="chevron-down" size={14} /></button>}>
          {(close) => <>
            <div className="item" onClick={() => { close(); foldAll(false); }}>Alles aufklappen</div>
            <div className="item" onClick={() => { close(); foldAll(true); }}>Alles einklappen</div>
            <div className="item" onClick={() => { close(); unfoldLevel(); }}>Eine Ebene mehr zeigen</div>
            <div className="item" onClick={() => { close(); foldLevel(); }}>Eine Ebene weniger zeigen</div>
            <hr />
            <div className="item" onClick={() => { close(); setMode(mode === 'map' ? 'table' : 'map'); }}><Icon name={mode === 'map' ? 'list' : 'dependency'} /> {mode === 'map' ? 'Als Tabelle' : 'Als Karte'}</div>
            <div className="item" onClick={() => { close(); fit(); }}><Icon name="maximize" /> Ganze Karte zeigen</div>
            <div className="small muted" style={{ padding: '4px 10px' }}>Gilt für den gewählten Punkt und alles darunter</div>
          </>}
        </Dropdown>
        {mode === 'map' && <>
          <button className="btn sm" onClick={() => zoom(1 / 1.2)} title="Verkleinern" aria-label="Verkleinern">−</button>
          <button className="btn sm" onClick={() => zoom(1.2)} title="Vergrößern" aria-label="Vergrößern">+</button>
        </>}
        <span className="mm-search">
          <Icon name="search" size={14} />
          <input ref={search} value={query} placeholder="Suchen (Strg+F)" onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); nextHit(e.shiftKey); } if (e.key === 'Escape') { setQuery(''); host.current?.focus(); } }} />
          {query && <span className="small muted">{hits.length ? `${hitIndex + 1 || '–'}/${hits.length}` : '0'}</span>}
          {query && <label className="small row" title="Alles andere abblenden"><input type="checkbox" checked={onlyHits} onChange={(e) => setOnlyHits(e.target.checked)} /> Filter</label>}
        </span>
        <span className="grow" />
        <span className="small muted mm-status">{status === 'saved' ? `${countNodes(data)} Punkte · gespeichert` : status === 'saving' ? 'speichert …' : 'ungespeichert'}</span>
        <Dropdown trigger={(t) => <button className="btn sm" onClick={t}>Datei <Icon name="chevron-down" size={14} /></button>}>
          {(close) => <>
            <div className="small muted" style={{ padding: '4px 10px' }}>Exportieren als</div>
            {([['png', 'Bild (PNG)'], ['svg', 'Vektorgrafik (SVG)'], ['pdf', 'PDF'], ['html', 'Webseite (HTML)'], ['md', 'Gliederung (Markdown)'], ['txt', 'Text'], ['mm', 'FreeMind / Freeplane (.mm)']] as const)
              .map(([k, l]) => <div key={k} className="item" onClick={() => { close(); void exportAs(k); }}><Icon name="download" /> {l}</div>)}
            {!ro && <><hr /><div className="item" title="FreeMind-Datei (.mm) oder Gliederung (.md, .txt) unter dem gewählten Punkt einfügen" onClick={() => { close(); fileInput.current?.click(); }}><Icon name="upload" /> Importieren …</div></>}
          </>}
        </Dropdown>
        <input ref={fileInput} type="file" hidden accept=".mm,.md,.txt,.markdown" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        <button className={`btn sm ${panel ? 'primary' : ''}`} onClick={() => setPanel(panel ? null : 'content')}><Icon name="edit" /> Details</button>
      </div>

      {mode === 'map' ? (
        <div className="mm-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="mm-edges" style={{ overflow: 'visible' }} width="1" height="1">
            {cl.map((c) => <rect key={c.id} x={c.x} y={c.y} width={c.w} height={c.h} rx={22} fill={c.color} fillOpacity={0.45} stroke={c.color} strokeWidth={2} />)}
            {boxes.filter((b) => b.parent).map((b) => <path key={b.node.id} d={edgePath(b.parent!, b)} stroke={b.color} strokeWidth={edgeW(b)} fill="none"
              opacity={drag?.id === b.node.id || (onlyHits && query && !keep.has(b.node.id)) ? 0.25 : 1} />)}
            {boxes.filter((b) => b.shape === 'fork' && b.depth > 0).map((b) => <line key={`u${b.node.id}`} x1={b.x} y1={b.y + b.h} x2={b.x + b.w} y2={b.y + b.h} stroke={b.color} strokeWidth={edgeW(b)} />)}
          </svg>
          {boxes.map((b) => {
            const n = b.node;
            const isDrag = drag?.id === n.id, isTarget = drag?.target === n.id;
            const dim = onlyHits && query && !keep.has(n.id);
            const overdue = n.reminder && n.reminder < now;
            const cls = `mm-node d${Math.min(b.depth, 2)} shape-${b.shape} ${sel === n.id ? 'sel' : ''} ${isTarget ? `drop-${drag!.mode}` : ''} ${hitSet.has(n.id) ? 'hit' : ''} ${n.bg ? 'has-bg' : ''} ${arrowFrom ? 'pick' : ''}`;
            return (
              <div key={n.id} className={cls} onPointerDown={(e) => onNodeDown(e, n.id)} onDoubleClick={() => !ro && setEdit({ id: n.id, text: n.text })}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h, '--c': b.color, ...(n.bg ? { '--bg': n.bg } : {}), ...(n.fg ? { color: n.fg } : {}),
                  fontSize: b.fs, lineHeight: `${b.lh}px`, fontWeight: b.weight, fontStyle: n.italic ? 'italic' : undefined,
                  transform: isDrag ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined, opacity: isDrag ? 0.7 : dim ? 0.25 : 1 } as React.CSSProperties}>
                <div className="mm-line">
                  {n.icons?.length ? <span className="mm-icons" style={{ height: b.lh }}>{n.icons.map((k) => <NodeIcon key={k} k={k} size={b.fs} />)}</span> : null}
                  <span>{b.lines.map((l, i) => <div key={i}>{l || ' '}</div>)}</span>
                </div>
                {b.attrs.length > 0 && <div className="mm-attrs">{b.attrs.map((a, i) => <div key={i}>{a}</div>)}</div>}
                {badgeCount(n) > 0 && <span className="mm-badges">
                  {n.taskId && <Icon name="check" size={12} />}
                  {n.note && <Icon name="note" size={12} />}
                  {n.reminder && <span title={`Erinnerung ${fmtDateTime(n.reminder)}`} style={{ color: overdue ? 'var(--red)' : undefined, display: 'inline-flex' }}><Icon name="clock" size={12} /></span>}
                  {n.link && <a href={n.link} target={n.link.startsWith('/') ? undefined : '_blank'} rel="noreferrer" title={n.link} onPointerDown={(e) => e.stopPropagation()} style={{ color: 'inherit', display: 'inline-flex' }}><Icon name="link" size={12} /></a>}
                  {n.ref && <button className="mm-ref" title={`Gehe zu „${find(data, n.ref)?.node.text ?? ''}“`} onPointerDown={(e) => e.stopPropagation()} onClick={() => jump(n.ref!)}><Icon name="arrow-right" size={12} /></button>}
                </span>}
                {folded(n) && <button className="mm-count" style={{ [b.dir > 0 ? 'right' : 'left']: -22 } as React.CSSProperties} onPointerDown={(e) => e.stopPropagation()} onClick={() => toggle(n.id)}>{countNodes(n) - 1}</button>}
                {!folded(n) && n.children.length > 0 && b.depth > 0 && sel === n.id && <button className="mm-count small" title="Einklappen (Leertaste)" style={{ [b.dir > 0 ? 'right' : 'left']: -22 } as React.CSSProperties} onPointerDown={(e) => e.stopPropagation()} onClick={() => toggle(n.id)}>−</button>}
              </div>
            );
          })}
          <svg className="mm-edges mm-arrows" style={{ overflow: 'visible' }} width="1" height="1">
            <defs><marker id="mm-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" /></marker></defs>
            {arrows.map((a) => <g key={a.key}>
              <path d={a.d} fill="none" stroke="var(--text-3)" strokeWidth={1.5} strokeDasharray="6 4" markerEnd="url(#mm-arr)" />
              {a.label && <text x={a.lx} y={a.ly} fontSize={12} textAnchor="middle" fill="var(--text-2)" stroke="var(--bg-soft)" strokeWidth={4} paintOrder="stroke">{a.label}</text>}
            </g>)}
          </svg>
          {editBox && <textarea className="mm-edit" autoFocus value={edit!.text} placeholder="Gedanke …" style={{ left: editBox.x, top: editBox.y, width: Math.max(editBox.w, 180), minHeight: editBox.h, fontSize: editBox.fs, lineHeight: `${editBox.lh}px` }}
            onChange={(e) => setEdit({ ...edit!, text: e.target.value })} onBlur={commitEdit} onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => { const v = e.target.value; e.target.setSelectionRange(v.length, v.length); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') { e.preventDefault(); setEdit(null); if (!find(data, edit!.id)?.node.text) commitEdit(); host.current?.focus(); }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); host.current?.focus(); }
              if (e.key === 'Tab') { e.preventDefault(); const id = edit!.id; commitEdit(); setTimeout(() => addChild(id), 0); }
            }} />}
        </div>
      ) : (
        <TableView data={data} query={query} onOpen={jump} />
      )}

      {arrowFrom && <div className="mm-hint">Punkt anklicken, auf den der Pfeil zeigen soll – <b>Esc</b> bricht ab.</div>}
      {panel && (
        <div className="mm-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.text || 'Punkt'}</b><button className="icon-btn" onClick={() => setPanel(null)} aria-label="Schließen"><Icon name="x" /></button></div>
          <div className="row" style={{ gap: 4 }}>
            <button className={`btn sm ${panel === 'content' ? 'primary' : ''}`} onClick={() => setPanel('content')}>Inhalt</button>
            {!ro && <button className={`btn sm ${panel === 'format' ? 'primary' : ''}`} onClick={() => setPanel('format')}>Aussehen</button>}
          </div>
          {panel === 'content' || ro ? (
            <ContentPanel key={sel} node={selected} data={data} ro={ro} projectId={projectId} isRoot={sel === 'root'} setProp={setProp} onJump={jump}
              onArrow={() => { setArrowFrom(sel); }} onTask={() => void createTask()} onRemove={() => remove()} />
          ) : (
            <FormatPanel node={selected} setProp={setProp} toggleIcon={toggleIcon} isRoot={sel === 'root'} />
          )}
          <p className="hint">Tastatur: <b>Tab</b> Unterpunkt · <b>Enter</b> Nachbar · <b>Tippen</b> oder <b>F2</b> Text · <b>Entf</b> löschen · <b>Leertaste</b> klappen · <b>Strg+C/X/V</b> kopieren, ausschneiden, einfügen · <b>Strg+B/I</b> fett, kursiv · <b>Strg+↑/↓</b> verschieben · <b>Strg+F</b> suchen · Punkte mit der Maus auf andere ziehen.</p>
        </div>
      )}
      <div className="mm-iconsrc" hidden aria-hidden>{MM_ICONS.map((i) => <span key={i.key} data-i={i.icon}><Icon name={i.icon} size={24} /></span>)}</div>
      {!panel && !ro && boxes.length === 1 && mode === 'map' && <div className="mm-hint">Mit <b>Tab</b> den ersten Gedanken anlegen, mit <b>Enter</b> den nächsten.</div>}
    </div>
  );
}

/** Inhalt eines Punkts: Notiz, Link, Verknüpfung, Attribute, Erinnerung, Pfeile, Aufgabe */
function ContentPanel({ node: n, data, ro, projectId, isRoot, setProp, onJump, onArrow, onTask, onRemove }: {
  node: MindNode; data: MindNode; ro: boolean; projectId: string | null; isRoot: boolean; setProp: (p: Partial<MindNode>) => void; onJump: (id: string) => void;
  onArrow: () => void; onTask: () => void; onRemove: () => void;
}) {
  const others = allNodes(data).filter((x) => x.node.id !== n.id);
  const [attrs, setAttrs] = useState<MindAttr[]>(n.attrs ?? []);
  const saveAttrs = (list: MindAttr[]) => setProp({ attrs: list.filter((a) => a.k.trim()) });
  return <>
    <label className="small muted">Notiz</label>
    <textarea rows={5} readOnly={ro} defaultValue={n.note ?? ''} onBlur={(e) => e.target.value !== (n.note ?? '') && setProp({ note: e.target.value || undefined })} placeholder="Weitere Gedanken, Details …" />
    <label className="small muted">Link (Webseite, E-Mail oder Seite in AperioPlan)</label>
    <input readOnly={ro} defaultValue={n.link ?? ''} placeholder="https://…, mailto:… oder /projects/…" onBlur={(e) => e.target.value !== (n.link ?? '') && setProp({ link: e.target.value.trim() || undefined })} />
    {n.link && (n.link.startsWith('/') ? <Link to={n.link} className="small">Link öffnen</Link> : <a href={n.link} target="_blank" rel="noreferrer" className="small">Link öffnen</a>)}
    <label className="small muted">Verknüpfung zu einem anderen Punkt</label>
    <div className="row" style={{ gap: 4 }}>
      <select disabled={ro} value={n.ref ?? ''} onChange={(e) => setProp({ ref: e.target.value || undefined })}>
        <option value="">– keine –</option>{others.map((x) => <option key={x.node.id} value={x.node.id}>{`${'· '.repeat(x.depth)}${x.node.text || '(leer)'}`}</option>)}
      </select>
      {n.ref && <button className="btn sm" onClick={() => onJump(n.ref!)} title="Hinspringen"><Icon name="arrow-right" /></button>}
    </div>
    <label className="small muted">Attribute</label>
    {attrs.map((a, i) => (
      <div key={i} className="row" style={{ gap: 4 }}>
        <input readOnly={ro} value={a.k} placeholder="Name" style={{ width: '45%' }} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} onBlur={() => saveAttrs(attrs)} />
        <input readOnly={ro} value={a.v} placeholder="Wert" onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} onBlur={() => saveAttrs(attrs)} />
        {!ro && <button className="btn ghost sm" onClick={() => { const l = attrs.filter((_, j) => j !== i); setAttrs(l); saveAttrs(l); }} aria-label="Entfernen"><Icon name="x" /></button>}
      </div>
    ))}
    {!ro && <button className="btn ghost sm" onClick={() => setAttrs([...attrs, { k: '', v: '' }])}><Icon name="plus" /> Attribut</button>}
    <label className="small muted">Erinnerung</label>
    <div className="row" style={{ gap: 4 }}>
      <input type="datetime-local" readOnly={ro} defaultValue={toLocalInput(n.reminder)} onBlur={(e) => { const v = e.target.value ? new Date(e.target.value).toISOString() : undefined; if (v !== n.reminder) setProp({ reminder: v }); }} />
      {n.reminder && !ro && <button className="btn ghost sm" onClick={() => setProp({ reminder: undefined })} aria-label="Erinnerung entfernen"><Icon name="x" /></button>}
    </div>
    <span className="small muted">Zur gewählten Zeit kommt eine Benachrichtigung an alle, mit denen die Mindmap geteilt ist.</span>
    <label className="small muted">Pfeile zu anderen Punkten</label>
    {(n.arrows ?? []).map((a, i) => (
      <div key={i} className="row" style={{ gap: 4 }}>
        <button className="btn ghost sm" onClick={() => onJump(a.to)} title="Hinspringen"><Icon name="arrow-right" /></button>
        <span className="small grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{find(data, a.to)?.node.text}</span>
        <input readOnly={ro} defaultValue={a.label ?? ''} placeholder="Beschriftung" style={{ width: 110 }} onBlur={(e) => e.target.value !== (a.label ?? '') && setProp({ arrows: (n.arrows ?? []).map((x, j) => (j === i ? { to: x.to, ...(e.target.value.trim() ? { label: e.target.value.trim() } : {}) } : x)) })} />
        {!ro && <button className="btn ghost sm" onClick={() => setProp({ arrows: (n.arrows ?? []).filter((_, j) => j !== i) })} aria-label="Pfeil entfernen"><Icon name="x" /></button>}
      </div>
    ))}
    {!ro && <button className="btn ghost sm" onClick={onArrow}><Icon name="arrow-right" /> Pfeil zu einem Punkt …</button>}
    {projectId && !isRoot && (n.taskId
      ? <Link className="btn sm" to={`/projects/${projectId}?task=${n.taskId}`}><Icon name="check" /> Zur Aufgabe</Link>
      : !ro && <button className="btn sm" onClick={onTask}><Icon name="check" /> Als Aufgabe anlegen</button>)}
    {(n.created || n.modified) && <span className="small muted">{n.created ? `angelegt ${fmtDateTime(new Date(n.created).toISOString())}` : ''}{n.created && n.modified ? ' · ' : ''}{n.modified ? `geändert ${fmtDateTime(new Date(n.modified).toISOString())}` : ''}</span>}
    {!ro && !isRoot && <button className="btn ghost sm danger" onClick={onRemove}><Icon name="trash" /> Punkt löschen</button>}
  </>;
}

/** Aussehen: Farben, Schrift, Form, Linie, Wolke, Symbole */
function FormatPanel({ node: n, setProp, toggleIcon, isRoot }: { node: MindNode; setProp: (p: Partial<MindNode>) => void; toggleIcon: (k: string) => void; isRoot: boolean }) {
  const swatches = (list: string[], value: string | undefined, key: 'color' | 'fg' | 'bg' | 'cloud', none: string) => (
    <div className="row wrap" style={{ gap: 4 }}>
      {list.map((c) => <button key={c} className={`mm-swatch ${value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setProp({ [key]: c })} aria-label={`Farbe ${c}`} />)}
      <button className="btn ghost sm" onClick={() => setProp({ [key]: undefined })}>{none}</button>
    </div>
  );
  return <>
    <label className="small muted">Farbe des Astes</label>{swatches(BRANCH_COLORS, n.color, 'color', 'automatisch')}
    <label className="small muted">Textfarbe</label>{swatches(TEXT_COLORS, n.fg, 'fg', 'normal')}
    <label className="small muted">Hintergrund</label>{swatches(BG_COLORS, n.bg, 'bg', 'keiner')}
    <label className="small muted">Schrift</label>
    <div className="row wrap" style={{ gap: 4 }}>
      <button className={`btn sm ${n.bold ? 'primary' : ''}`} onClick={() => setProp({ bold: n.bold ? undefined : true })} title="Fett (Strg+B)"><b>F</b></button>
      <button className={`btn sm ${n.italic ? 'primary' : ''}`} onClick={() => setProp({ italic: n.italic ? undefined : true })} title="Kursiv (Strg+I)"><i>K</i></button>
      <select value={String(n.size ?? '')} onChange={(e) => setProp({ size: e.target.value ? Number(e.target.value) : undefined })} style={{ width: 'auto' }}>
        {SIZES.map(([v, l]) => <option key={l} value={v ?? ''}>{l}</option>)}
      </select>
    </div>
    {!isRoot && <>
      <label className="small muted">Form</label>
      <div className="row wrap" style={{ gap: 4 }}>
        {([['box', 'Kasten'], ['bubble', 'Blase'], ['fork', 'Linie']] as const).map(([v, l]) => <button key={v} className={`btn sm ${(n.shape ?? 'box') === v ? 'primary' : ''}`} onClick={() => setProp({ shape: v === 'box' ? undefined : v })}>{l}</button>)}
      </div>
      <label className="small muted">Verbindungslinie (gilt auch für Unterpunkte)</label>
      <div className="row wrap" style={{ gap: 4 }}>
        {([['bezier', 'Kurve'], ['linear', 'Gerade'], ['angled', 'Eckig']] as const).map(([v, l]) => <button key={v} className={`btn sm ${(n.edgeStyle ?? 'bezier') === v ? 'primary' : ''}`} onClick={() => setProp({ edgeStyle: v === 'bezier' ? undefined : v })}>{l}</button>)}
        <select value={String(n.edgeWidth ?? '')} onChange={(e) => setProp({ edgeWidth: e.target.value ? Number(e.target.value) : undefined })} style={{ width: 'auto' }} aria-label="Linienstärke">
          <option value="">Stärke automatisch</option>{[1, 2, 3, 4, 6, 8].map((w) => <option key={w} value={w}>{w} px</option>)}
        </select>
      </div>
    </>}
    <label className="small muted">Wolke um diesen Ast</label>{swatches(CLOUD_COLORS, n.cloud, 'cloud', 'keine')}
    <label className="small muted">Symbole</label>
    <div className="mm-iconpick">
      {MM_ICONS.map((i) => <button key={i.key} className={(n.icons ?? []).includes(i.key) ? 'on' : ''} title={i.label} onClick={() => toggleIcon(i.key)}><Icon name={i.icon} size={16} /></button>)}
      {MM_PRIORITIES.map((p) => <button key={p} className={(n.icons ?? []).includes(p) ? 'on' : ''} title={`Priorität ${p.slice(1)}`} onClick={() => toggleIcon(p)}><NodeIcon k={p} size={16} /></button>)}
    </div>
    {(n.icons?.length ?? 0) > 0 && <button className="btn ghost sm" onClick={() => setProp({ icons: undefined })}>Alle Symbole entfernen</button>}
  </>;
}

/** Tabellenansicht: alle Punkte untereinander mit Notiz, Attributen und Erinnerung */
function TableView({ data, query, onOpen }: { data: MindNode; query: string; onOpen: (id: string) => void }) {
  const rows = allNodes(data).filter((x) => !query.trim() || matches(x.node, query.trim()));
  return (
    <div className="mm-table">
      <table className="table small">
        <thead><tr><th>Punkt</th><th>Notiz</th><th>Attribute</th><th>Symbole</th><th>Erinnerung</th><th>Geändert</th></tr></thead>
        <tbody>{rows.map(({ node: n, depth }) => (
          <tr key={n.id} className="click" onClick={() => onOpen(n.id)}>
            <td style={{ paddingLeft: 8 + depth * 18, fontWeight: depth < 2 ? 600 : 400, color: n.fg }}>{n.text || <span className="muted">(leer)</span>}</td>
            <td className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.note ?? ''}</td>
            <td>{(n.attrs ?? []).map((a) => `${a.k}: ${a.v}`).join(' · ')}</td>
            <td><span className="row" style={{ gap: 2 }}>{(n.icons ?? []).map((k) => <NodeIcon key={k} k={k} size={14} />)}</span></td>
            <td>{n.reminder ? fmtDateTime(n.reminder) : ''}</td>
            <td className="muted">{n.modified ? fmtDateTime(new Date(n.modified).toISOString()) : ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
