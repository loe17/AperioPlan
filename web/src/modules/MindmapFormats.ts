/**
 * Mindmap-Daten: Baum-Hilfen sowie Import und Export (Gliederung, Text, HTML, FreeMind .mm, PDF).
 * Die Formate folgen FreeMind 1.0 (https://freemind.sourceforge.io), damit Karten mit FreeMind und Freeplane
 * ausgetauscht werden können.
 */
export interface MindArrow { to: string; label?: string }
export interface MindAttr { k: string; v: string }
export interface MindNode {
  id: string; text: string; children: MindNode[];
  /** Farbe des Astes (Linie und Rahmen) */
  color?: string; collapsed?: boolean; note?: string; link?: string; taskId?: string;
  fg?: string; bg?: string; bold?: boolean; italic?: boolean; size?: number; shape?: 'box' | 'bubble' | 'fork';
  edgeStyle?: 'bezier' | 'linear' | 'angled'; edgeWidth?: number; icons?: string[]; cloud?: string;
  arrows?: MindArrow[]; attrs?: MindAttr[]; created?: number; modified?: number; reminder?: string; ref?: string;
}

/** Symbole (wie die eingebauten Symbole von FreeMind); icon = Name im Symbolsatz von AperioPlan */
export const MM_ICONS: { key: string; icon: string; label: string; fm: string }[] = [
  { key: 'idea', icon: 'lightbulb', label: 'Idee', fm: 'idea' },
  { key: 'question', icon: 'info', label: 'Frage', fm: 'help' },
  { key: 'yes', icon: 'check-circle', label: 'Ja, erledigt', fm: 'button_ok' },
  { key: 'no', icon: 'x-circle', label: 'Nein', fm: 'button_cancel' },
  { key: 'important', icon: 'alert', label: 'Wichtig', fm: 'messagebox_warning' },
  { key: 'stop', icon: 'ban', label: 'Stopp', fm: 'stop-sign' },
  { key: 'flag', icon: 'flag', label: 'Markierung', fm: 'flag' },
  { key: 'star', icon: 'star', label: 'Stern', fm: 'bookmark' },
  { key: 'heart', icon: 'heart', label: 'Gefällt', fm: 'ksmiletris' },
  { key: 'target', icon: 'target', label: 'Ziel', fm: 'go' },
  { key: 'launch', icon: 'rocket', label: 'Start', fm: 'launch' },
  { key: 'clock', icon: 'clock', label: 'Zeit', fm: 'clock' },
  { key: 'calendar', icon: 'calendar', label: 'Termin', fm: 'calendar' },
  { key: 'person', icon: 'user', label: 'Person', fm: 'kaddressbook' },
  { key: 'group', icon: 'users', label: 'Gruppe', fm: 'family' },
  { key: 'mail', icon: 'mail', label: 'E-Mail', fm: 'Mail' },
  { key: 'phone', icon: 'phone', label: 'Telefon', fm: 'kmail' },
  { key: 'key', icon: 'key', label: 'Schlüssel', fm: 'password' },
  { key: 'attach', icon: 'paperclip', label: 'Anhang', fm: 'attach' },
  { key: 'home', icon: 'home', label: 'Zuhause', fm: 'gohome' },
  { key: 'money', icon: 'euro', label: 'Geld', fm: 'euro' },
  { key: 'tool', icon: 'wrench', label: 'Werkzeug', fm: 'wrench' },
];
/** Prioritäten 1–5 (FreeMind: full-1 … full-5) */
export const MM_PRIORITIES = ['p1', 'p2', 'p3', 'p4', 'p5'];
export const iconFor = (key: string) => MM_ICONS.find((i) => i.key === key);

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clone = <T,>(n: T): T => JSON.parse(JSON.stringify(n));
export function find(root: MindNode, id: string, parent: MindNode | null = null): { node: MindNode; parent: MindNode | null; depth: number } | null {
  const walk = (n: MindNode, p: MindNode | null, d: number): ReturnType<typeof find> => {
    if (n.id === id) return { node: n, parent: p, depth: d };
    for (const c of n.children) { const r = walk(c, n, d + 1); if (r) return r; }
    return null;
  };
  return walk(root, parent, 0);
}
export const contains = (n: MindNode, id: string): boolean => n.id === id || n.children.some((c) => contains(c, id));
export const countNodes = (n: MindNode): number => 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
export function allNodes(root: MindNode): { node: MindNode; depth: number; parent: MindNode | null }[] {
  const out: { node: MindNode; depth: number; parent: MindNode | null }[] = [];
  const walk = (n: MindNode, d: number, p: MindNode | null) => { out.push({ node: n, depth: d, parent: p }); n.children.forEach((c) => walk(c, d + 1, n)); };
  walk(root, 0, null);
  return out;
}
/** Vorfahren eines Punkts (für „aufklappen bis hierher“) */
export function ancestors(root: MindNode, id: string): string[] {
  const path: string[] = [];
  const walk = (n: MindNode): boolean => { if (n.id === id) return true; for (const c of n.children) if (walk(c)) { path.push(n.id); return true; } return false; };
  walk(root);
  return path;
}
/** Teilbaum mit neuen IDs (Einfügen, Kopie); Pfeile innerhalb des Teilbaums wandern mit */
export function reId(n: MindNode): MindNode {
  const map = new Map<string, string>();
  const walk1 = (x: MindNode) => { map.set(x.id, newId()); x.children.forEach(walk1); };
  walk1(n);
  const walk2 = (x: MindNode): MindNode => {
    const y: MindNode = { ...x, id: map.get(x.id)!, children: x.children.map(walk2) };
    if (y.arrows) { const a = y.arrows.filter((r) => map.has(r.to)).map((r) => ({ ...r, to: map.get(r.to)! })); if (a.length) y.arrows = a; else delete y.arrows; }
    if (y.ref) { if (map.has(y.ref)) y.ref = map.get(y.ref); else delete y.ref; }
    delete y.taskId;
    return y;
  };
  return walk2(n);
}

// ---------------------------------------------------------------- Gliederung (Markdown) und Text
/** Gliederung als Markdown (Einrückung mit Leerzeichen) */
export function toOutline(n: MindNode, depth = 0): string {
  const line = depth === 0 ? `# ${n.text}` : `${'  '.repeat(depth - 1)}- ${n.text.replace(/\n/g, ' ')}`;
  return [line, ...(n.note && depth > 0 ? [`${'  '.repeat(depth)}  > ${n.note.replace(/\n/g, ' ')}`] : []), ...n.children.map((c) => toOutline(c, depth + 1))].join('\n');
}
/** Eingerückter Text (Tabulator je Ebene), wie „Als Text exportieren“ in FreeMind */
export function toText(n: MindNode, depth = 0): string {
  return [`${'\t'.repeat(depth)}${n.text.replace(/\n/g, ' ')}`, ...n.children.map((c) => toText(c, depth + 1))].join('\n');
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

// ---------------------------------------------------------------- HTML
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Eigenständige HTML-Seite mit aufklappbarer Gliederung, Notizen und Attributen */
export function toHtml(root: MindNode): string {
  const node = (n: MindNode): string => {
    const style = [n.fg ? `color:${n.fg}` : '', n.bg ? `background:${n.bg};padding:0 4px;border-radius:4px` : '', n.bold ? 'font-weight:600' : '', n.italic ? 'font-style:italic' : ''].filter(Boolean).join(';');
    const title = n.link ? `<a href="${esc(n.link)}">${esc(n.text)}</a>` : esc(n.text);
    const extra = [
      n.icons?.length ? `<span class="tags">${n.icons.map((i) => esc(MM_PRIORITIES.includes(i) ? `Priorität ${i.slice(1)}` : iconFor(i)?.label ?? i)).join(' · ')}</span>` : '',
      n.reminder ? `<span class="tags">Erinnerung ${esc(new Date(n.reminder).toLocaleString('de-DE'))}</span>` : '',
      n.note ? `<div class="note">${esc(n.note).replace(/\n/g, '<br>')}</div>` : '',
      n.attrs?.length ? `<table>${n.attrs.map((a) => `<tr><th>${esc(a.k)}</th><td>${esc(a.v)}</td></tr>`).join('')}</table>` : '',
    ].join('');
    const head = `<span style="${style}">${title}</span>${extra}`;
    return n.children.length ? `<li><details open><summary>${head}</summary><ul>${n.children.map(node).join('')}</ul></details></li>` : `<li>${head}</li>`;
  };
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(root.text)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1a1d20}h1{font-size:24px}ul{list-style:none;padding-left:22px;border-left:1px solid #e3e6ea;margin:4px 0}li{margin:3px 0}
summary{cursor:pointer}.note{color:#555;font-size:13px;margin:2px 0 4px;white-space:normal}.tags{color:#777;font-size:12px;margin-left:8px}table{font-size:12px;border-collapse:collapse;margin:2px 0}th,td{border:1px solid #e3e6ea;padding:1px 6px;text-align:left}th{background:#f5f6f8;font-weight:500}</style></head>
<body><h1>${esc(root.text)}</h1>${root.note ? `<p class="note">${esc(root.note)}</p>` : ''}<ul>${root.children.map(node).join('')}</ul></body></html>`;
}

// ---------------------------------------------------------------- FreeMind (.mm)
const xml = (s: string) => esc(s).replace(/\n/g, '&#10;');
const EDGE_TO_FM: Record<string, string> = { bezier: 'bezier', linear: 'linear', angled: 'sharp_linear' };
const EDGE_FROM_FM: Record<string, MindNode['edgeStyle']> = { bezier: 'bezier', sharp_bezier: 'bezier', linear: 'linear', sharp_linear: 'angled', horizontal: 'angled' };

/** Als FreeMind-Datei (.mm, Version 1.0.1) – lesbar mit FreeMind und Freeplane */
export function toFreeMind(root: MindNode): string {
  const node = (n: MindNode, depth: number, pos?: 'left' | 'right'): string => {
    const a: string[] = [`ID="ID_${xml(n.id)}"`, `TEXT="${xml(n.text)}"`];
    if (n.created) a.push(`CREATED="${n.created}"`);
    if (n.modified) a.push(`MODIFIED="${n.modified}"`);
    if (pos) a.push(`POSITION="${pos}"`);
    if (n.collapsed && n.children.length) a.push('FOLDED="true"');
    if (n.fg) a.push(`COLOR="${n.fg}"`);
    if (n.bg) a.push(`BACKGROUND_COLOR="${n.bg}"`);
    if (n.shape) a.push(`STYLE="${n.shape === 'fork' ? 'fork' : 'bubble'}"`);
    if (n.link || n.ref) a.push(`LINK="${xml(n.ref ? `#ID_${n.ref}` : n.link!)}"`);
    const inner: string[] = [];
    if (n.color || n.edgeStyle || n.edgeWidth) inner.push(`<edge${n.color ? ` COLOR="${n.color}"` : ''}${n.edgeStyle ? ` STYLE="${EDGE_TO_FM[n.edgeStyle]}"` : ''}${n.edgeWidth ? ` WIDTH="${n.edgeWidth}"` : ''}/>`);
    if (n.bold || n.italic || n.size) inner.push(`<font NAME="SansSerif" SIZE="${n.size ?? (depth === 0 ? 18 : 12)}"${n.bold ? ' BOLD="true"' : ''}${n.italic ? ' ITALIC="true"' : ''}/>`);
    for (const i of n.icons ?? []) inner.push(`<icon BUILTIN="${MM_PRIORITIES.includes(i) ? `full-${i.slice(1)}` : iconFor(i)?.fm ?? i}"/>`);
    if (n.cloud) inner.push(`<cloud COLOR="${n.cloud}"/>`);
    for (const r of n.arrows ?? []) inner.push(`<arrowlink DESTINATION="ID_${xml(r.to)}" ENDARROW="Default" STARTARROW="None"${r.label ? ` MIDDLE_LABEL="${xml(r.label)}"` : ''}/>`);
    for (const at of n.attrs ?? []) inner.push(`<attribute NAME="${xml(at.k)}" VALUE="${xml(at.v)}"/>`);
    if (n.note) inner.push(`<richcontent TYPE="NOTE"><html><head></head><body>${n.note.split('\n').map((p) => `<p>${esc(p)}</p>`).join('')}</body></html></richcontent>`);
    if (n.reminder) inner.push(`<hook NAME="plugins/TimeManagementReminder.xml"><Parameters REMINDUSERAT="${Date.parse(n.reminder)}"/></hook>`);
    const half = Math.ceil(n.children.length / 2);
    inner.push(...n.children.map((c, i) => node(c, depth + 1, depth === 0 ? (i < half ? 'right' : 'left') : undefined)));
    return inner.length ? `<node ${a.join(' ')}>\n${inner.join('\n')}\n</node>` : `<node ${a.join(' ')}/>`;
  };
  return `<map version="1.0.1">\n<!-- Erstellt mit AperioPlan. FreeMind: http://freemind.sourceforge.net -->\n${node(root, 0)}\n</map>\n`;
}

const hex = (v: string | null) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);
/** FreeMind- oder Freeplane-Datei (.mm) einlesen */
export function fromFreeMind(text: string): MindNode {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const top = doc.querySelector('map > node');
  if (!top || doc.querySelector('parsererror')) throw new Error('Das ist keine gültige FreeMind-Datei (.mm).');
  const ids = new Map<string, string>();
  const pending: { node: MindNode; arrows: { dest: string; label?: string }[]; ref?: string }[] = [];
  const kids = (el: Element, tag: string) => [...el.children].filter((c) => c.tagName === tag);
  const walk = (el: Element, depth: number): MindNode => {
    const id = depth === 0 ? 'root' : newId();
    const fmId = el.getAttribute('ID');
    if (fmId) ids.set(fmId, id);
    const rich = kids(el, 'richcontent');
    const plain = (t?: Element) => (t?.textContent ?? '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const n: MindNode = { id, text: el.getAttribute('TEXT') ?? plain(rich.find((r) => r.getAttribute('TYPE') === 'NODE')), children: [] };
    const note = rich.find((r) => r.getAttribute('TYPE') === 'NOTE');
    if (note) { const ps = [...note.querySelectorAll('p')]; n.note = (ps.length ? ps.map((p) => (p.textContent ?? '').trim()).join('\n') : plain(note)).slice(0, 10000) || undefined; if (!n.note) delete n.note; }
    const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    if (num(el.getAttribute('CREATED'))) n.created = num(el.getAttribute('CREATED'));
    if (num(el.getAttribute('MODIFIED'))) n.modified = num(el.getAttribute('MODIFIED'));
    if (el.getAttribute('FOLDED') === 'true') n.collapsed = true;
    if (hex(el.getAttribute('COLOR'))) n.fg = hex(el.getAttribute('COLOR'));
    if (hex(el.getAttribute('BACKGROUND_COLOR'))) n.bg = hex(el.getAttribute('BACKGROUND_COLOR'));
    const style = el.getAttribute('STYLE');
    if (style === 'fork' || style === 'bubble') n.shape = style;
    const link = el.getAttribute('LINK');
    let ref: string | undefined;
    if (link?.startsWith('#')) ref = link.slice(1); else if (link && /^(https?:\/\/|mailto:|\/)/.test(link)) n.link = link;
    const edge = kids(el, 'edge')[0];
    if (edge) {
      if (hex(edge.getAttribute('COLOR'))) n.color = hex(edge.getAttribute('COLOR'));
      const es = EDGE_FROM_FM[edge.getAttribute('STYLE') ?? ''];
      if (es) n.edgeStyle = es;
      const w = edge.getAttribute('WIDTH');
      if (w && /^\d+$/.test(w) && Number(w) >= 1) n.edgeWidth = Math.min(8, Number(w));
    }
    const font = kids(el, 'font')[0];
    if (font) {
      if (font.getAttribute('BOLD') === 'true') n.bold = true;
      if (font.getAttribute('ITALIC') === 'true') n.italic = true;
      const s = Number(font.getAttribute('SIZE'));
      if (s && s !== 12 && s >= 9 && s <= 40) n.size = Math.round(s * (14 / 12));
    }
    const icons = kids(el, 'icon').map((i) => i.getAttribute('BUILTIN') ?? '').map((b) => (/^full-[1-5]$/.test(b) ? `p${b.slice(5)}` : MM_ICONS.find((x) => x.fm === b)?.key)).filter((x): x is string => Boolean(x));
    if (icons.length) n.icons = [...new Set(icons)].slice(0, 12);
    const cloud = kids(el, 'cloud')[0];
    if (cloud) n.cloud = hex(cloud.getAttribute('COLOR')) ?? '#d6e4ff';
    const attrs = kids(el, 'attribute').map((x) => ({ k: x.getAttribute('NAME') ?? '', v: x.getAttribute('VALUE') ?? '' })).filter((x) => x.k);
    if (attrs.length) n.attrs = attrs.slice(0, 50);
    const hook = kids(el, 'hook').find((h) => /TimeManagementReminder/.test(h.getAttribute('NAME') ?? ''));
    const at = hook?.querySelector('Parameters')?.getAttribute('REMINDUSERAT');
    if (at && /^\d+$/.test(at)) n.reminder = new Date(Number(at)).toISOString();
    const arrows = kids(el, 'arrowlink').map((x) => ({ dest: x.getAttribute('DESTINATION') ?? '', label: x.getAttribute('MIDDLE_LABEL') ?? undefined })).filter((x) => x.dest);
    pending.push({ node: n, arrows, ref });
    n.children = kids(el, 'node').map((c) => walk(c, depth + 1));
    return n;
  };
  const root = walk(top, 0);
  for (const p of pending) {
    const arrows = p.arrows.filter((x) => ids.has(x.dest)).map((x) => ({ to: ids.get(x.dest)!, ...(x.label ? { label: x.label } : {}) }));
    if (arrows.length) p.node.arrows = arrows;
    if (p.ref && ids.has(p.ref)) p.node.ref = ids.get(p.ref);
  }
  return root;
}

// ---------------------------------------------------------------- PDF (ein Bild auf einer Seite)
/** Minimales PDF mit einem JPEG-Bild – Seitengröße passt sich dem Bild an (lange Seite wie DIN A4) */
export function jpegToPdf(jpeg: Uint8Array, w: number, h: number): Blob {
  const scale = 842 / Math.max(w, h);
  const pw = Math.round(w * scale * 100) / 100, ph = Math.round(h * scale * 100) / 100;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Uint8Array) => { parts.push(b); len += b.length; };
  const str = (s: string) => push(enc.encode(s));
  str('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const obj = (n: number, body: () => void) => { offsets[n] = len; str(`${n} 0 obj\n`); body(); str('\nendobj\n'); };
  obj(1, () => str('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => str('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => { str(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); push(jpeg); str('\nendstream'); });
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, () => str(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = len;
  str(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}
