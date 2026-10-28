/**
 * Schlanker PDF-Erzeuger für Angebote, Kalkulationen und Protokolle – ohne fremde Pakete.
 * Schrift: Helvetica (in jedem PDF-Betrachter eingebaut) mit Windows-Zeichensatz, damit Umlaute, ß und € stimmen.
 * Koordinaten werden von oben links in Punkt (1/72 Zoll) angegeben; A4 = 595 × 842.
 */

const W_REG: Record<string, number> = {};
const W_BOLD: Record<string, number> = {};
(() => {
  const chars = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  const reg = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  const bold = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
  [...chars].forEach((c, i) => { W_REG[c] = reg[i]!; W_BOLD[c] = bold[i]!; });
  const same: [string, string][] = [['ä', 'a'], ['ö', 'o'], ['ü', 'u'], ['Ä', 'A'], ['Ö', 'O'], ['Ü', 'U'], ['é', 'e'], ['è', 'e'], ['á', 'a'], ['à', 'a'], ['ç', 'c'], ['ñ', 'n'], ['É', 'E']];
  for (const [a, b] of same) { W_REG[a] = W_REG[b]!; W_BOLD[a] = W_BOLD[b]!; }
  W_REG['ß'] = 611; W_BOLD['ß'] = 611; W_REG['€'] = 556; W_BOLD['€'] = 556; W_REG['–'] = 556; W_BOLD['–'] = 556;
  W_REG['„'] = 333; W_REG['“'] = 333; W_REG['”'] = 333; W_BOLD['„'] = 500; W_BOLD['“'] = 500; W_BOLD['”'] = 500;
  W_REG['·'] = 278; W_BOLD['·'] = 278; W_REG['×'] = 584; W_BOLD['×'] = 584; W_REG['°'] = 400; W_BOLD['°'] = 400;
})();

/** Unicode → Windows-1252 (WinAnsiEncoding) */
const WIN: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
function encode(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = WIN[ch] ?? ch.charCodeAt(0);
    const c = code > 255 ? 63 : code; // nicht darstellbar → ?
    if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out;
}

export interface TextOpts { size?: number; bold?: boolean; color?: string; align?: 'left' | 'right' | 'center'; width?: number }

const rgb = (hex = '#000000') => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((x) => x.toFixed(3)).join(' '); };

export class Pdf {
  readonly width = 595;
  readonly height = 842;
  readonly margin = 50;
  private pages: string[][] = [];
  private cur: string[] = [];
  /** aktuelle Schreibposition von oben */
  y = 50;
  onNewPage?: (pdf: Pdf, pageNo: number) => void;
  private info: Record<string, string>;

  constructor(title = 'Dokument', author = 'AperioPlan') {
    this.info = { Title: title, Author: author, Producer: 'AperioPlan' };
    this.addPage();
  }

  addPage() {
    this.cur = [];
    this.pages.push(this.cur);
    this.y = this.margin;
    this.onNewPage?.(this, this.pages.length);
  }

  get pageCount() { return this.pages.length; }

  static measure(s: string, size = 10, bold = false) {
    const w = bold ? W_BOLD : W_REG;
    let n = 0;
    for (const ch of s) n += w[ch] ?? 556;
    return (n * size) / 1000;
  }

  /** Zeilenumbruch nach Wörtern (lange Wörter werden hart getrennt) */
  static wrap(s: string, width: number, size = 10, bold = false): string[] {
    const out: string[] = [];
    for (const para of String(s ?? '').split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        if (!word) continue;
        const cand = line ? `${line} ${word}` : word;
        if (Pdf.measure(cand, size, bold) <= width) { line = cand; continue; }
        if (line) out.push(line);
        let w = word;
        while (Pdf.measure(w, size, bold) > width && w.length > 1) {
          let k = w.length - 1;
          while (k > 1 && Pdf.measure(w.slice(0, k), size, bold) > width) k--;
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }

  text(x: number, y: number, s: string, o: TextOpts = {}) {
    const size = o.size ?? 10;
    let px = x;
    if (o.align && o.align !== 'left' && o.width !== undefined) {
      const w = Pdf.measure(s, size, o.bold);
      px = o.align === 'right' ? x + o.width - w : x + (o.width - w) / 2;
    }
    this.cur.push(`BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${rgb(o.color)} rg ${px.toFixed(2)} ${(this.height - y - size).toFixed(2)} Td (${encode(s)}) Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color = '#cccccc') {
    this.cur.push(`${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, fill = '#f3f4f6') {
    this.cur.push(`${rgb(fill)} rg ${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  /** Platz sicherstellen, sonst neue Seite */
  ensure(h: number) { if (this.y + h > this.height - this.margin - 20) this.addPage(); }

  /** Absatz an der aktuellen Position, mit Umbruch und Seitenwechsel */
  paragraph(s: string, o: TextOpts & { gap?: number } = {}) {
    const size = o.size ?? 10;
    const width = o.width ?? this.width - 2 * this.margin;
    for (const l of Pdf.wrap(s, width, size, o.bold)) {
      this.ensure(size * 1.35);
      this.text(this.margin, this.y, l, { ...o, width });
      this.y += size * 1.35;
    }
    this.y += o.gap ?? 4;
  }

  /** Tabelle mit Kopfzeile (wird auf jeder neuen Seite wiederholt) */
  table(cols: { label: string; width: number; align?: 'left' | 'right' }[], rows: (string | { text: string; bold?: boolean })[][], o: { size?: number; zebra?: boolean } = {}) {
    const size = o.size ?? 9;
    const x0 = this.margin;
    const head = () => {
      this.ensure(size * 2.2);
      this.rect(x0, this.y - 2, cols.reduce((a, c) => a + c.width, 0), size * 1.8, '#eef0f4');
      let x = x0;
      for (const c of cols) { this.text(x + 4, this.y + 2, c.label, { size, bold: true, align: c.align, width: c.width - 8 }); x += c.width; }
      this.y += size * 1.9;
    };
    head();
    rows.forEach((r, ri) => {
      const cells = r.map((c, i) => { const t = typeof c === 'string' ? { text: c } : c; return { ...t, lines: Pdf.wrap(t.text, cols[i]!.width - 8, size, t.bold) }; });
      const h = Math.max(...cells.map((c) => c.lines.length)) * size * 1.3 + 4;
      if (this.y + h > this.height - this.margin - 20) { this.addPage(); head(); }
      if (o.zebra && ri % 2 === 1) this.rect(x0, this.y - 2, cols.reduce((a, c) => a + c.width, 0), h, '#f8f9fb');
      let x = x0;
      cells.forEach((c, i) => {
        c.lines.forEach((l, li) => this.text(x + 4, this.y + li * size * 1.3, l, { size, bold: c.bold, align: cols[i]!.align, width: cols[i]!.width - 8 }));
        x += cols[i]!.width;
      });
      this.y += h;
      this.line(x0, this.y - 2, x0 + cols.reduce((a, c) => a + c.width, 0), this.y - 2, 0.3, '#e5e7eb');
    });
    this.y += 6;
  }

  /** Fußzeile auf allen Seiten (z. B. „Seite 1 von 3“) */
  footer(fn: (pageNo: number, total: number) => string) {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const s = fn(i + 1, total);
      const w = Pdf.measure(s, 8);
      p.push(`BT /F1 8 Tf ${rgb('#6b7280')} rg ${((this.width - w) / 2).toFixed(2)} 28 Td (${encode(s)}) Tj ET`);
    });
  }

  toBuffer(): Buffer {
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const catalog = add(''); const pagesId = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const p of this.pages) {
      const content = p.join('\n');
      const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< ${Object.entries(this.info).map(([k, v]) => `/${k} (${encode(v)})`).join(' ')} /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

export const eur = (n: number | null | undefined) => `${(n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
export const num = (n: number | null | undefined, d = 2) => (n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: d });
