import { deflateSync } from 'node:zlib';

/**
 * Vorschaubild aus einer CAD-Datei holen, ohne das CAD-Programm: SolidWorks, Inventor, Solid Edge und CATIA
 * speichern beim Sichern ein kleines Bild in der Datei (PNG, JPEG oder Windows-Bitmap). Viele dieser Dateien
 * sind „Compound Files“ (wie alte Office-Dateien) – dann werden die einzelnen Datenströme gelesen, damit
 * zerteilte Bilder wieder zusammenpassen. Ergebnis ist immer PNG oder JPEG, sonst null.
 */
export function extractPreview(buf: Buffer): { type: 'png' | 'jpeg'; data: Buffer } | null {
  const streams = isCompound(buf) ? readCompound(buf) : [];
  let best: { type: 'png' | 'jpeg'; data: Buffer; area: number } | null = null;
  for (const s of streams.length ? [...streams, buf] : [buf]) {
    for (const img of findImages(s)) if (!best || img.area > best.area) best = img;
  }
  return best ? { type: best.type, data: best.data } : null;
}

// ------------------------------------------------------------------ Compound File (CFB)
const CFB_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END = 0xfffffffe, FREE = 0xffffffff;
const isCompound = (b: Buffer) => b.length > 512 && b.subarray(0, 8).equals(CFB_SIG);

/** Alle Datenströme einer Compound-Datei (fehlerhafte Dateien liefern einfach weniger) */
function readCompound(b: Buffer): Buffer[] {
  try {
    const sectorSize = 1 << b.readUInt16LE(0x1e);
    const miniSize = 1 << b.readUInt16LE(0x20);
    const cutoff = b.readUInt32LE(0x38);
    const sector = (n: number) => b.subarray((n + 1) * sectorSize, (n + 2) * sectorSize);
    // Belegungstabelle (FAT) über die DIFAT-Liste
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) { const s = b.readUInt32LE(0x4c + i * 4); if (s !== FREE) fatSectors.push(s); }
    let difat = b.readUInt32LE(0x44);
    for (let guard = 0; difat !== END && difat !== FREE && guard < 10000; guard++) {
      const d = sector(difat);
      for (let i = 0; i < sectorSize / 4 - 1; i++) { const s = d.readUInt32LE(i * 4); if (s !== FREE) fatSectors.push(s); }
      difat = d.readUInt32LE(sectorSize - 4);
    }
    const fat: number[] = [];
    for (const s of fatSectors) { const d = sector(s); for (let i = 0; i < sectorSize / 4; i++) fat.push(d.readUInt32LE(i * 4)); }
    const chain = (start: number, table: number[], limit = 1e6) => {
      const out: number[] = [];
      for (let s = start; s !== END && s !== FREE && s < table.length && out.length < limit; s = table[s]!) out.push(s);
      return out;
    };
    const readChain = (start: number) => Buffer.concat(chain(start, fat).map(sector));
    const dir = readChain(b.readUInt32LE(0x30));
    const entries: { type: number; start: number; size: number }[] = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) entries.push({ type: dir[o + 66]!, start: dir.readUInt32LE(o + 116), size: dir.readUInt32LE(o + 120) });
    const root = entries[0];
    if (!root || root.type !== 5) return [];
    const miniStream = readChain(root.start);
    const miniFat: number[] = [];
    const mf = readChain(b.readUInt32LE(0x3c));
    for (let i = 0; i + 4 <= mf.length && i / 4 < b.readUInt32LE(0x40) * (sectorSize / 4); i += 4) miniFat.push(mf.readUInt32LE(i));
    const out: Buffer[] = [];
    for (const e of entries.slice(1)) {
      if (e.type !== 2 || e.size < 64) continue;
      const data = e.size < cutoff
        ? Buffer.concat(chain(e.start, miniFat).map((s) => miniStream.subarray(s * miniSize, (s + 1) * miniSize)))
        : readChain(e.start);
      out.push(data.subarray(0, e.size));
    }
    return out;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ Bilder suchen
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sane = (w: number, h: number) => w >= 16 && h >= 16 && w <= 8192 && h <= 8192;

function* findImages(b: Buffer): Generator<{ type: 'png' | 'jpeg'; data: Buffer; area: number }> {
  // PNG: Signatur, dann Blöcke bis IEND – Prüfsummen müssen stimmen
  for (let i = b.indexOf(PNG_SIG); i >= 0; i = b.indexOf(PNG_SIG, i + 8)) {
    const png = readPng(b, i);
    if (png) yield png;
  }
  // JPEG: SOI … SOF (Größe) … EOI
  for (let i = b.indexOf(Buffer.from([0xff, 0xd8, 0xff])); i >= 0; i = b.indexOf(Buffer.from([0xff, 0xd8, 0xff]), i + 3)) {
    const jpg = readJpeg(b, i);
    if (jpg) yield jpg;
  }
  // Windows-Bitmap ohne Dateikopf (Inventor, ältere SolidWorks): BITMAPINFOHEADER mit 24 oder 32 Bit
  for (let i = b.indexOf(Buffer.from([40, 0, 0, 0])); i >= 0 && i + 40 < b.length; i = b.indexOf(Buffer.from([40, 0, 0, 0]), i + 4)) {
    const dib = readDib(b, i);
    if (dib) yield dib;
  }
}

function readPng(b: Buffer, start: number) {
  let o = start + 8, w = 0, h = 0;
  for (let n = 0; n < 100000 && o + 12 <= b.length; n++) {
    const len = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    if (o + 12 + len > b.length || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== b.readUInt32BE(o + 8 + len)) return null;
    if (type === 'IHDR') { w = b.readUInt32BE(o + 8); h = b.readUInt32BE(o + 12); }
    o += 12 + len;
    if (type === 'IEND') return sane(w, h) ? { type: 'png' as const, data: Buffer.from(b.subarray(start, o)), area: w * h } : null;
  }
  return null;
}

function readJpeg(b: Buffer, start: number) {
  let o = start + 2, w = 0, h = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    const len = b.readUInt16BE(o + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { h = b.readUInt16BE(o + 5); w = b.readUInt16BE(o + 7); }
    if (marker === 0xda) {
      // Bilddaten bis EOI (FF D9); FF 00 und Restart-Marken gehören zu den Daten
      for (let p = o + 2 + len; p + 1 < b.length; p++) {
        if (b[p] === 0xff && b[p + 1] === 0xd9) return sane(w, h) ? { type: 'jpeg' as const, data: Buffer.from(b.subarray(start, p + 2)), area: w * h } : null;
      }
      return null;
    }
    o += 2 + len;
  }
  return null;
}

function readDib(b: Buffer, o: number) {
  const w = b.readInt32LE(o + 4), hRaw = b.readInt32LE(o + 8), planes = b.readUInt16LE(o + 12), bits = b.readUInt16LE(o + 14), comp = b.readUInt32LE(o + 16);
  const h = Math.abs(hRaw);
  if (planes !== 1 || (bits !== 24 && bits !== 32) || comp !== 0 || !sane(w, h) || w > 2048 || h > 2048) return null;
  const stride = Math.ceil((w * bits) / 32) * 4;
  const px = o + 40;
  if (px + stride * h > b.length) return null;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let uniform = true;
  const first = b.readUInt32LE(px);
  for (let y = 0; y < h; y++) {
    const src = px + (hRaw > 0 ? h - 1 - y : y) * stride; // positive Höhe: Zeilen von unten nach oben
    const dst = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const s = src + x * (bits / 8);
      raw[dst + 1 + x * 3] = b[s + 2]!; raw[dst + 2 + x * 3] = b[s + 1]!; raw[dst + 3 + x * 3] = b[s]!;
    }
    if (uniform && b.readUInt32LE(src) !== first) uniform = false;
  }
  if (uniform) return null; // einfarbige Flächen sind keine Vorschau
  return { type: 'png' as const, data: encodePng(w, h, raw), area: w * h };
}

// ------------------------------------------------------------------ PNG schreiben
function encodePng(w: number, h: number, rawRgbRows: Buffer) {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rawRgbRows)), chunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const _test = { encodePng, readCompound, crc32 };
