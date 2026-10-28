import { mkdir, readdir, stat, rename, rm, copyFile, cp, statfs } from 'node:fs/promises';
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
  /** Weitere Speicherorte: Pfade beginnen mit "@<id>/" (z. B. @archiv/Projekte/0100_Anlage) */
  private mounts = new Map<string, string>();
  constructor(public readonly root: string) {}

  setMounts(m: Record<string, string>) {
    this.mounts = new Map(Object.entries(m).map(([k, v]) => [k, resolve(v)]));
  }

  /** Wurzelordner und Rest eines Pfads */
  private split(rel: string): { base: string; rest: string; prefix: string } {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const m = /^@([a-z0-9_-]+)(?:\/(.*))?$/.exec(clean);
    if (m) {
      const base = this.mounts.get(m[1]!);
      if (!base) throw badRequest(`Speicherort „${m[1]}“ ist nicht eingerichtet`);
      return { base, rest: m[2] ?? '', prefix: `@${m[1]}/` };
    }
    return { base: this.root, rest: clean, prefix: '' };
  }

  /** Wandelt einen relativen Pfad sicher in einen absoluten um (kein Ausbruch aus dem Wurzelordner). */
  abs(rel: string): string {
    const { base, rest } = this.split(rel);
    const p = resolve(base, rest);
    if (p !== base && !p.startsWith(base + sep)) throw badRequest('Ungültiger Pfad');
    return p;
  }

  rel(abs: string): string {
    for (const [id, base] of this.mounts) if (abs === base || abs.startsWith(base + sep)) return `@${id}/${relative(base, abs).split(sep).join('/')}`.replace(/\/$/, '');
    return relative(this.root, abs).split(sep).join('/');
  }

  /** Freier und gesamter Platz eines Ordners */
  async space(absDir: string): Promise<{ free: number; total: number } | null> {
    try {
      const s = await statfs(absDir);
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch { return null; }
  }

  /** Ordner in einen anderen Speicherort verschieben (auch über Laufwerksgrenzen) */
  async moveTree(from: string, to: string) {
    const a = this.abs(from), b = this.abs(to);
    await mkdir(dirname(b), { recursive: true });
    try { await rename(a, b); } catch (e) {
      if ((e as { code?: string }).code !== 'EXDEV') throw e;
      await cp(a, b, { recursive: true, preserveTimestamps: true, errorOnExist: true });
      await rm(a, { recursive: true, force: true });
    }
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
