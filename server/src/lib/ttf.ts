/**
 * TrueType-Schrift lesen und für die PDF-Einbettung verkleinern.
 * Verkleinert wird, indem alle nicht benutzten Glyphen leer werden – die Glyphen-Nummern bleiben gleich,
 * dadurch kann das PDF direkt mit Glyphen-Nummern arbeiten (Identity-H).
 */
import { readFileSync } from 'node:fs';

interface Table { offset: number; length: number }

export class TrueTypeFont {
  readonly buf: Buffer;
  readonly tables = new Map<string, Table>();
  readonly unitsPerEm: number;
  readonly bbox: [number, number, number, number];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly italicAngle: number;
  readonly numGlyphs: number;
  readonly postscriptName: string;
  private readonly longLoca: boolean;
  private readonly advance: number[] = [];
  private readonly cmap = new Map<number, number>();

  constructor(file: string | Buffer) {
    this.buf = typeof file === 'string' ? readFileSync(file) : file;
    const b = this.buf;
    const n = b.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      this.tables.set(b.toString('latin1', o, o + 4), { offset: b.readUInt32BE(o + 8), length: b.readUInt32BE(o + 12) });
    }
    const head = this.t('head').offset;
    this.unitsPerEm = b.readUInt16BE(head + 18);
    this.bbox = [b.readInt16BE(head + 36), b.readInt16BE(head + 38), b.readInt16BE(head + 40), b.readInt16BE(head + 42)];
    this.longLoca = b.readInt16BE(head + 50) === 1;
    const hhea = this.t('hhea').offset;
    this.ascent = b.readInt16BE(hhea + 4);
    this.descent = b.readInt16BE(hhea + 6);
    const numHMetrics = b.readUInt16BE(hhea + 34);
    this.numGlyphs = b.readUInt16BE(this.t('maxp').offset + 4);
    const os2 = this.tables.get('OS/2');
    this.capHeight = os2 && b.readUInt16BE(os2.offset) >= 2 ? b.readInt16BE(os2.offset + 88) : this.ascent;
    const post = this.t('post').offset;
    this.italicAngle = b.readInt32BE(post + 4) / 65536;
    const hmtx = this.t('hmtx').offset;
    let last = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      if (g < numHMetrics) last = b.readUInt16BE(hmtx + g * 4);
      this.advance.push(last);
    }
    this.readCmap();
    this.postscriptName = this.readName(6) ?? 'Font';
  }

  private t(tag: string): Table {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`Schrift ohne Tabelle ${tag}`);
    return t;
  }

  private readCmap() {
    const b = this.buf, base = this.t('cmap').offset;
    const n = b.readUInt16BE(base + 2);
    let best = -1, bestFmt = 0;
    for (let i = 0; i < n; i++) {
      const pid = b.readUInt16BE(base + 4 + i * 8), eid = b.readUInt16BE(base + 6 + i * 8), off = b.readUInt32BE(base + 8 + i * 8);
      const fmt = b.readUInt16BE(base + off);
      if (pid === 3 && (eid === 10 || eid === 1) && (fmt === 12 || (fmt === 4 && bestFmt !== 12))) { best = base + off; bestFmt = fmt; }
    }
    if (best < 0) throw new Error('Schrift ohne Unicode-Zeichentabelle');
    if (bestFmt === 4) {
      const segX2 = b.readUInt16BE(best + 6), seg = segX2 / 2;
      const ends = best + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < seg; s++) {
        const end = b.readUInt16BE(ends + s * 2), start = b.readUInt16BE(starts + s * 2), delta = b.readInt16BE(deltas + s * 2), ro = b.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else { g = b.readUInt16BE(ranges + s * 2 + ro + (c - start) * 2); if (g) g = (g + delta) & 0xffff; }
          if (g) this.cmap.set(c, g);
        }
      }
    } else {
      const groups = b.readUInt32BE(best + 12);
      for (let i = 0; i < groups; i++) {
        const o = best + 16 + i * 12, start = b.readUInt32BE(o), end = b.readUInt32BE(o + 4), g0 = b.readUInt32BE(o + 8);
        for (let c = start; c <= end; c++) this.cmap.set(c, g0 + (c - start));
      }
    }
  }

  private readName(id: number): string | null {
    const t = this.tables.get('name'); if (!t) return null;
    const b = this.buf, count = b.readUInt16BE(t.offset + 2), strings = t.offset + b.readUInt16BE(t.offset + 4);
    for (let i = 0; i < count; i++) {
      const r = t.offset + 6 + i * 12;
      if (b.readUInt16BE(r + 6) !== id) continue;
      const pid = b.readUInt16BE(r), len = b.readUInt16BE(r + 8), off = b.readUInt16BE(r + 10);
      const raw = b.subarray(strings + off, strings + off + len);
      if (pid === 3 || pid === 0) { let s = ''; for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k)); return s; }
      return raw.toString('latin1');
    }
    return null;
  }

  glyph(codePoint: number): number { return this.cmap.get(codePoint) ?? 0; }
  /** Breite in 1/1000 der Schriftgröße */
  width(gid: number): number { return Math.round((this.advance[gid] ?? 0) * 1000 / this.unitsPerEm); }

  private locaOf(g: number): [number, number] {
    const b = this.buf, loca = this.t('loca').offset;
    return this.longLoca ? [b.readUInt32BE(loca + g * 4), b.readUInt32BE(loca + g * 4 + 4)] : [b.readUInt16BE(loca + g * 2) * 2, b.readUInt16BE(loca + g * 2 + 2) * 2];
  }

  /** Schriftdatei, die nur die angegebenen Glyphen (plus Bestandteile zusammengesetzter Glyphen) enthält */
  subset(used: Set<number>): Buffer {
    const b = this.buf, glyf = this.t('glyf').offset;
    const keep = new Set<number>([0, ...used]);
    // zusammengesetzte Glyphen: Bestandteile mitnehmen
    const queue = [...keep];
    while (queue.length) {
      const g = queue.pop()!;
      const [s, e] = this.locaOf(g);
      if (e <= s || b.readInt16BE(glyf + s) >= 0) continue;
      let p = glyf + s + 10;
      for (;;) {
        const flags = b.readUInt16BE(p), comp = b.readUInt16BE(p + 2);
        if (!keep.has(comp)) { keep.add(comp); queue.push(comp); }
        p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
        if (!(flags & 0x20)) break;
      }
    }
    const parts: Buffer[] = [];
    const loca: number[] = [];
    let pos = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      loca.push(pos);
      if (!keep.has(g)) continue;
      const [s, e] = this.locaOf(g);
      if (e > s) { const d = b.subarray(glyf + s, glyf + e); parts.push(d); pos += d.length; if (pos % 4) { const pad = 4 - (pos % 4); parts.push(Buffer.alloc(pad)); pos += pad; } }
    }
    loca.push(pos);
    const newGlyf = Buffer.concat(parts);
    const newLoca = Buffer.alloc(loca.length * 4);
    loca.forEach((v, i) => newLoca.writeUInt32BE(v, i * 4));
    const out = new Map<string, Buffer>();
    for (const tag of ['cmap', 'cvt ', 'fpgm', 'gasp', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'prep']) {
      const t = this.tables.get(tag); if (t) out.set(tag, Buffer.from(b.subarray(t.offset, t.offset + t.length)));
    }
    out.set('glyf', newGlyf); out.set('loca', newLoca);
    const head = out.get('head')!; head.writeInt16BE(1, 50); head.writeUInt32BE(0, 8); // lange loca, Prüfsumme neu
    return writeFont(out);
  }
}

function checksum(d: Buffer): number {
  let sum = 0;
  const padded = d.length % 4 ? Buffer.concat([d, Buffer.alloc(4 - (d.length % 4))]) : d;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function writeFont(tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let es = 0; while (1 << (es + 1) <= n) es++;
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0); header.writeUInt16BE(n, 4);
  header.writeUInt16BE((1 << es) * 16, 6); header.writeUInt16BE(es, 8); header.writeUInt16BE(n * 16 - (1 << es) * 16, 10);
  let offset = header.length;
  const bodies: Buffer[] = [];
  tags.forEach((tag, i) => {
    const d = tables.get(tag)!;
    const o = 12 + i * 16;
    header.write(tag, o, 'latin1'); header.writeUInt32BE(checksum(d), o + 4); header.writeUInt32BE(offset, o + 8); header.writeUInt32BE(d.length, o + 12);
    const pad = (4 - (d.length % 4)) % 4;
    bodies.push(d, Buffer.alloc(pad)); offset += d.length + pad;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headIdx = tags.indexOf('head');
  const headOff = font.readUInt32BE(12 + headIdx * 16 + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOff + 8);
  return font;
}
