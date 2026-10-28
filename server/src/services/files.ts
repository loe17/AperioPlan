import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { AppContext } from '../context';
import type { Db } from '../db';
import { badRequest } from '../lib/errors';

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  dxf: 'image/vnd.dxf', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', step: 'application/step', stp: 'application/step', mp4: 'video/mp4',
};
export const mimeOf = (name: string) => MIME[name.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';

export const VERSIONS_DIR = '.versionen';
export const TRASH_DIR = '.papierkorb';

/** Bereinigt einen relativen Pfad innerhalb eines Projektordners. */
export function cleanRel(p: string | undefined): string {
  const s = posix.normalize(('/' + (p ?? '')).replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '');
  if (s.split('/').some((seg) => seg === '..')) throw badRequest('Ungültiger Pfad');
  return s === '.' ? '' : s;
}

export function safeName(name: string): string {
  const n = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!n || n === '.' || n === '..' || n.startsWith('.')) throw badRequest('Ungültiger Dateiname');
  return n;
}

export interface StoredFile { id: string; path: string; name: string; size: number; version: number }

/**
 * Speichert eine Datei unter einem Ablagepfad. Existiert sie bereits, wird der alte Stand
 * als Version in .versionen/ abgelegt und die Versionsnummer hochgezählt.
 */
export async function storeFile(ctx: AppContext, opts: {
  projectId: string | null; path: string; stream: Readable; userId: string | null; via?: string; comment?: string;
}): Promise<StoredFile> {
  const { sql, storage } = ctx;
  const name = posix.basename(opts.path);
  const existing = await storage.stat(opts.path);
  const [row] = await sql<{ id: string; version: number; size: number; sha256: string | null; uploaded_by: string | null; locked_by: string | null }[]>`
    select id, version, size, sha256, uploaded_by, locked_by from files where path = ${opts.path}`;
  if (row?.locked_by && row.locked_by !== opts.userId) throw badRequest('Datei ist gesperrt (ausgecheckt)');
  let version = 1;
  if (existing?.isFile()) {
    const oldVersion = row?.version ?? 1;
    const dir = posix.dirname(opts.path);
    const versionPath = `${dir === '.' ? '' : dir + '/'}${VERSIONS_DIR}/${name}/v${oldVersion}_${name}`;
    await storage.move(opts.path, versionPath);
    let fileId = row?.id;
    if (!fileId) {
      const [created] = await sql<{ id: string }[]>`insert into files (project_id, path, name, size, mime, version)
        values (${opts.projectId}, ${opts.path}, ${name}, ${existing.size}, ${mimeOf(name)}, 1) returning id`;
      fileId = created!.id;
    }
    await sql`insert into file_versions (file_id, version, path, size, sha256, uploaded_by, comment)
      values (${fileId}, ${oldVersion}, ${versionPath}, ${existing.size}, ${row?.sha256 ?? null}, ${row?.uploaded_by ?? null}, '')
      on conflict (file_id, version) do nothing`;
    version = oldVersion + 1;
  }
  const { size, sha256 } = await storage.write(opts.path, opts.stream);
  const [f] = await sql<StoredFile[]>`insert into files (project_id, path, name, size, sha256, mime, version, uploaded_by, uploaded_via)
    values (${opts.projectId}, ${opts.path}, ${name}, ${size}, ${sha256}, ${mimeOf(name)}, ${version}, ${opts.userId}, ${opts.via ?? null})
    on conflict (path) do update set size = excluded.size, sha256 = excluded.sha256, version = excluded.version,
      uploaded_by = excluded.uploaded_by, uploaded_via = excluded.uploaded_via, updated_at = now(), project_id = coalesce(files.project_id, excluded.project_id)
    returning id, path, name, size::float as size, version`;
  return f!;
}

/** Gleicht den Ordnerinhalt mit der Datenbank ab (z. B. Dateien, die im Windows-Explorer abgelegt wurden). */
export async function syncFolder(ctx: AppContext, tx: Db, projectId: string | null, absRel: string) {
  const entries = await ctx.storage.list(absRel);
  const files = entries.filter((e) => !e.isDir);
  if (!files.length) return;
  const known = await tx<{ path: string; size: number }[]>`select path, size::float as size from files where path = any(${files.map((f) => f.path)})`;
  const map = new Map(known.map((k) => [k.path, k.size]));
  for (const f of files) {
    if (!map.has(f.path)) {
      await tx`insert into files (project_id, path, name, size, mime, created_at, updated_at)
        values (${projectId}, ${f.path}, ${f.name}, ${f.size}, ${mimeOf(f.name)}, ${f.modified}, ${f.modified}) on conflict (path) do nothing`;
    } else if (map.get(f.path) !== f.size) {
      await tx`update files set size = ${f.size}, updated_at = ${f.modified} where path = ${f.path}`;
    }
  }
}
