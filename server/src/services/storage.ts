import { mkdir, readdir, stat, rename, rm, copyFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { badRequest } from '../lib/errors';

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: Date;
}

/**
 * Dateiablage. Das Wurzelverzeichnis ist entweder ein lokaler Ordner auf dem Server
 * oder ein eingebundenes Netzlaufwerk (NAS / SMB / Windows-Freigabe), siehe deploy/README.
 */
export class Storage {
  constructor(public readonly root: string) {}

  /** Wandelt einen relativen Pfad sicher in einen absoluten um (kein Ausbruch aus dem Wurzelordner). */
  abs(rel: string): string {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const p = resolve(this.root, clean);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw badRequest('Ungültiger Pfad');
    return p;
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }

  async ensureDir(rel: string) {
    await mkdir(this.abs(rel), { recursive: true });
  }

  async list(rel: string): Promise<DirEntry[]> {
    const dir = this.abs(rel);
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: DirEntry[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const s = await stat(join(dir, name)).catch(() => null);
      if (!s) continue;
      out.push({ name, path: this.rel(join(dir, name)), isDir: s.isDirectory(), size: s.size, modified: s.mtime });
    }
    return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'de'));
  }

  /** Speichert einen Datenstrom und liefert Größe und SHA-256-Prüfsumme. */
  async write(rel: string, data: Readable): Promise<{ size: number; sha256: string }> {
    const target = this.abs(rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.upload-${process.pid}-${Date.now()}`;
    const hash = createHash('sha256');
    let size = 0;
    data.on('data', (chunk: Buffer) => { hash.update(chunk); size += chunk.length; });
    await pipeline(data, createWriteStream(tmp));
    await rename(tmp, target);
    return { size, sha256: hash.digest('hex') };
  }

  read(rel: string) {
    return createReadStream(this.abs(rel));
  }

  async stat(rel: string) {
    return stat(this.abs(rel)).catch(() => null);
  }

  async move(from: string, to: string) {
    await mkdir(dirname(this.abs(to)), { recursive: true });
    await rename(this.abs(from), this.abs(to));
  }

  async copy(from: string, to: string) {
    await mkdir(dirname(this.abs(to)), { recursive: true });
    await copyFile(this.abs(from), this.abs(to));
  }

  async remove(rel: string) {
    await rm(this.abs(rel), { recursive: true, force: true });
  }

  /** Durchläuft rekursiv alle Ordner bis zur angegebenen Tiefe. */
  async walk(rel: string, depth = 2): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    const go = async (r: string, d: number) => {
      for (const e of await this.list(r)) {
        out.push(e);
        if (e.isDir && d > 1) await go(e.path, d - 1);
      }
    };
    await go(rel, depth);
    return out;
  }
}
