import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Kleines ZIP-Werkzeug für Office-Dateien (docx, xlsx, pptx, odt, ods, odp sind ZIP-Archive).
 * Liest und schreibt unverschlüsselte Archive mit den Verfahren „gespeichert“ und „deflate“.
 */
export interface ZipEntry { name: string; data: Buffer; store?: boolean }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readZip(buf: Buffer): ZipEntry[] {
  // Ende des zentralen Verzeichnisses suchen
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`ZIP-Verfahren ${method} nicht unterstützt`); })();
    out.push({ name, data, store: method === 0 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const store = e.store ?? false;
    const body = store ? e.data : deflateRawSync(e.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(store ? 0 : 8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Ersetzt Platzhalter wie {{Titel}} in den XML-Teilen eines Office-Dokuments.
 * Word teilt Text manchmal in mehrere Abschnitte auf – das Muster erlaubt deshalb
 * XML-Markierungen zwischen den Zeichen eines Platzhalters.
 */
export function fillOfficeTemplate(file: Buffer, values: Record<string, string>): Buffer {
  const entries = readZip(file);
  const gap = '(?:<[^>]*>)*';
  const patterns = Object.entries(values).map(([k, v]) => ({
    re: new RegExp(['{', '{', ...k.split(''), '}', '}'].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(gap), 'g'),
    value: xmlEscape(v),
  }));
  for (const e of entries) {
    if (!/\.xml$/i.test(e.name) || e.name.startsWith('[Content_Types]')) continue;
    let s = e.data.toString('utf8');
    if (!s.includes('{')) continue;
    for (const p of patterns) s = s.replace(p.re, p.value);
    e.data = Buffer.from(s, 'utf8');
  }
  return writeZip(entries);
}
