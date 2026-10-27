/**
 * Verschlüsselte Sicherung (Export/Import) – Kapitel 3 "Nacht-Tresor" und Kapitel 13.
 *
 * Dateiformat *.apb:  "APB2" | salt(16) | iv(12) | AES-256-GCM( gzip( tar ) ) | tag(16)
 * Inhalt des tar:     manifest.json, db/<tabelle>.json, files/<ablagepfad>
 *
 * Import in zwei Schritten: analyse() entpackt in einen Zwischenordner und vergleicht jede
 * Zeile mit dem Bestand (neu / identisch / abweichend inkl. Datumsvergleich). apply() spielt
 * danach nach Wahl des Administrators ein ("neuerer Stand gewinnt", "Bestand behalten",
 * "Sicherung übernehmen" oder pro Eintrag).
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, writeFile, appendFile, unlink, copyFile } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createCipheriv, createDecipheriv, randomBytes, scrypt as _scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { createGzip, createGunzip } from 'node:zlib';

import tar from 'tar-stream';
import { APP_VERSION } from '@aperio/shared';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { randomToken } from '../lib/crypto';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const MAGIC = Buffer.from('APB2');
const KDF = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Tabellen in Abhängigkeitsreihenfolge mit Primärschlüssel */
export const BACKUP_TABLES: { name: string; pk: string[] }[] = [
  { name: 'users', pk: ['id'] },
  { name: 'teams', pk: ['id'] },
  { name: 'team_members', pk: ['team_id', 'user_id'] },
  { name: 'settings', pk: ['key'] },
  { name: 'api_tokens', pk: ['id'] },
  { name: 'projects', pk: ['id'] },
  { name: 'project_members', pk: ['project_id', 'user_id'] },
  { name: 'tasks', pk: ['id'] },
  { name: 'task_dependencies', pk: ['task_id', 'depends_on_id'] },
  { name: 'comments', pk: ['id'] },
  { name: 'whiteboards', pk: ['id'] },
  { name: 'files', pk: ['id'] },
  { name: 'file_versions', pk: ['id'] },
  { name: 'project_documents', pk: ['id'] },
  { name: 'cad_items', pk: ['id'] },
  { name: 'cad_revisions', pk: ['id'] },
  { name: 'cad_references', pk: ['parent_id', 'child_id'] },
  { name: 'cad_state_history', pk: ['id'] },
  { name: 'cad_exports', pk: ['id'] },
  { name: 'share_links', pk: ['id'] },
  { name: 'time_entries', pk: ['id'] },
  { name: 'time_corrections', pk: ['id'] },
  { name: 'absences', pk: ['id'] },
  { name: 'vacation_adjustments', pk: ['id'] },
  { name: 'holidays', pk: ['day'] },
  { name: 'chat_channels', pk: ['id'] },
  { name: 'chat_members', pk: ['channel_id', 'user_id'] },
  { name: 'chat_messages', pk: ['id'] },
  { name: 'calls', pk: ['id'] },
  { name: 'mail_messages', pk: ['id'] },
  { name: 'kvp_ideas', pk: ['id'] },
  { name: 'kvp_photos', pk: ['id'] },
  { name: 'notifications', pk: ['id'] },
  { name: 'favorites', pk: ['user_id', 'entity_type', 'entity_id'] },
  { name: 'private_notes', pk: ['id'] },
  { name: 'audit_log', pk: ['id'] },
];

const DATE_COLS = ['updated_at', 'created_at', 'at', 'requested_at', 'started_at'];

async function passphraseFor(ctx: AppContext, override?: string): Promise<string> {
  if (override) return override;
  if (ctx.config.backupKey) return ctx.config.backupKey;
  const s = await ctx.settings.get('backup');
  if (s.passphrase) return s.passphrase;
  const generated = randomToken(18);
  await ctx.settings.set('backup', { ...s, passphrase: generated });
  return generated;
}

function backupDir(ctx: AppContext, target?: string) {
  return target && target.trim() ? target : ctx.config.backupDir;
}

export interface BackupResult { file: string; size: number; createdAt: string }

export async function runBackup(ctx: AppContext, opts: { reason?: string; passphrase?: string; includeFiles?: boolean } = {}): Promise<BackupResult> {
  const s = await ctx.settings.get('backup');
  const pass = await passphraseFor(ctx, opts.passphrase);
  const dir = backupDir(ctx, s.targetDir);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(dir, `aperioplan-${stamp}.apb`);
  const includeFiles = opts.includeFiles ?? s.includeFiles;

  const pack = tar.pack();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(pass, salt, 32, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await writeFile(file, Buffer.concat([MAGIC, salt, iv]));
  const done = pipeline(pack, createGzip({ level: 6 }), cipher, createWriteStream(file, { flags: 'a' }));

  const addEntry = (name: string, data: Buffer) =>
    new Promise<void>((res, rej) => pack.entry({ name }, data, (e) => (e ? rej(e) : res())));

  const counts: Record<string, number> = {};
  for (const t of BACKUP_TABLES) {
    const rows = await ctx.sql.unsafe(`select row_to_json(t) as r from ${t.name} t`);
    counts[t.name] = rows.length;
    await addEntry(`db/${t.name}.json`, Buffer.from(JSON.stringify(rows.map((x) => x.r))));
  }

  let fileCount = 0;
  if (includeFiles) {
    const root = ctx.storage.root;
    const walk = async (d: string): Promise<void> => {
      for (const name of await readdir(d).catch(() => [] as string[])) {
        const p = join(d, name);
        const st = await stat(p).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) await walk(p);
        else if (st.isFile()) {
          const rel = relative(root, p).split(sep).join('/');
          await new Promise<void>((res, rej) => {
            const entry = pack.entry({ name: `files/${rel}`, size: st.size, mtime: st.mtime }, (e) => (e ? rej(e) : res()));
            createReadStream(p).on('error', rej).pipe(entry);
          });
          fileCount++;
        }
      }
    };
    await walk(root);
  }

  const manifest = { app: 'AperioPlan', version: APP_VERSION, createdAt: new Date().toISOString(), reason: opts.reason ?? 'manuell', counts, fileCount, includeFiles };
  await addEntry('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  pack.finalize();
  await done;
  await appendFile(file, cipher.getAuthTag());

  await prune(dir, s.keep);
  const st = await stat(file);
  return { file, size: st.size, createdAt: manifest.createdAt };
}

async function prune(dir: string, keep: number) {
  if (!keep || keep < 1) return;
  const files = (await readdir(dir)).filter((f) => /^aperioplan-.*\.apb$/.test(f)).sort().reverse();
  for (const f of files.slice(keep)) await unlink(join(dir, f)).catch(() => {});
}

export async function listBackups(ctx: AppContext) {
  const s = await ctx.settings.get('backup');
  const dir = backupDir(ctx, s.targetDir);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.apb')).sort().reverse();
  const out = [];
  for (const name of names) {
    const st = await stat(join(dir, name));
    out.push({ name, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return out;
}

export async function backupPath(ctx: AppContext, name: string) {
  if (!/^[\w.\-]+\.apb$/.test(name)) throw badRequest('Ungültiger Dateiname');
  const s = await ctx.settings.get('backup');
  return join(backupDir(ctx, s.targetDir), name);
}

// ------------------------------------------------------------------ Import

/** Entschlüsselt und entpackt eine Sicherung in einen Zwischenordner. */
async function extract(file: string, pass: string, target: string) {
  const fh = await open(file, 'r');
  const { size } = await fh.stat();
  const header = Buffer.alloc(32);
  const tag = Buffer.alloc(16);
  await fh.read(header, 0, 32, 0);
  await fh.read(tag, 0, 16, size - 16);
  await fh.close();
  if (!header.subarray(0, 4).equals(MAGIC)) throw badRequest('Keine gültige AperioPlan-Sicherung');
  const key = await scrypt(pass, header.subarray(4, 20), 32, KDF);
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(20, 32));
  decipher.setAuthTag(tag);
  const extractor = tar.extract();
  extractor.on('entry', (h, stream, next) => {
    const name = h.name.replace(/\\/g, '/');
    if (name.includes('..') || name.startsWith('/')) { stream.resume(); return next(); }
    const dest = join(target, name);
    mkdir(dirname(dest), { recursive: true })
      .then(() => pipeline(stream, createWriteStream(dest)))
      .then(() => next(), next);
  });
  try {
    await pipeline(createReadStream(file, { start: 32, end: size - 17 }), decipher, createGunzip(), extractor);
  } catch (e) {
    const msg = (e as Error).message;
    if (/auth|unable to authenticate|bad decrypt/i.test(msg) || (e as { code?: string }).code === 'ERR_CRYPTO_INVALID_AUTH_TAG')
      throw badRequest('Falsches Passwort oder beschädigte Sicherung');
    if ((e as { code?: string }).code === 'Z_DATA_ERROR') throw badRequest('Falsches Passwort oder beschädigte Sicherung');
    throw e;
  }
}

export interface ImportConflict {
  table: string;
  key: string;
  label: string;
  localDate: string | null;
  backupDate: string | null;
  newer: 'local' | 'backup' | 'equal';
}

export interface ImportAnalysis {
  id: string;
  manifest: Record<string, unknown>;
  tables: { name: string; total: number; new: number; same: number; conflicts: number }[];
  conflicts: ImportConflict[];
  files: { total: number; new: number; existing: number };
}

const keyOf = (row: Record<string, unknown>, pk: string[]) => pk.map((k) => String(row[k])).join('|');
const dateOf = (row: Record<string, unknown>) => {
  for (const c of DATE_COLS) if (row[c]) return String(row[c]);
  return null;
};
const labelOf = (row: Record<string, unknown>) =>
  String(row.number ?? row.title ?? row.name ?? row.display_name ?? row.username ?? row.key ?? row.subject ?? row.designation ?? row.summary ?? row.id ?? '');

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

function stagingDir(ctx: AppContext, id: string) {
  if (!/^[\w-]+$/.test(id)) throw badRequest('Ungültige Import-Kennung');
  return join(ctx.config.backupDir, '.import', id);
}

export async function analyzeImport(ctx: AppContext, file: string, passphrase?: string): Promise<ImportAnalysis> {
  const pass = await passphraseFor(ctx, passphrase);
  const id = randomToken(9).replace(/[^\w]/g, 'x');
  const dir = stagingDir(ctx, id);
  await mkdir(dir, { recursive: true });
  try {
    await extract(file, pass, dir);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw badRequest('Sicherung unvollständig (manifest.json fehlt)');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const result: ImportAnalysis = { id, manifest, tables: [], conflicts: [], files: { total: 0, new: 0, existing: 0 } };

  for (const t of BACKUP_TABLES) {
    const p = join(dir, 'db', `${t.name}.json`);
    if (!existsSync(p)) continue;
    const rows: Record<string, unknown>[] = JSON.parse(await readFile(p, 'utf8'));
    const local = await ctx.sql.unsafe(`select row_to_json(t) as r from ${t.name} t`);
    const map = new Map(local.map((x) => [keyOf(x.r, t.pk), x.r as Record<string, unknown>]));
    const stat = { name: t.name, total: rows.length, new: 0, same: 0, conflicts: 0 };
    for (const row of rows) {
      const cur = map.get(keyOf(row, t.pk));
      if (!cur) { stat.new++; continue; }
      if (stable(cur) === stable(row)) { stat.same++; continue; }
      stat.conflicts++;
      const ld = dateOf(cur), bd = dateOf(row);
      const newer = ld && bd ? (new Date(bd) > new Date(ld) ? 'backup' : new Date(bd) < new Date(ld) ? 'local' : 'equal') : 'equal';
      result.conflicts.push({ table: t.name, key: keyOf(row, t.pk), label: labelOf(row), localDate: ld, backupDate: bd, newer });
    }
    result.tables.push(stat);
  }

  const filesDir = join(dir, 'files');
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdir(d).catch(() => [] as string[])) {
      const p = join(d, name);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else {
        result.files.total++;
        const rel = relative(filesDir, p).split(sep).join('/');
        if (existsSync(ctx.storage.abs(rel))) result.files.existing++; else result.files.new++;
      }
    }
  };
  await walk(filesDir);
  await writeFile(join(dir, 'analysis.json'), JSON.stringify(result));
  return result;
}

export type ImportStrategy = 'newer' | 'local' | 'backup';

export async function applyImport(ctx: AppContext, id: string, strategy: ImportStrategy, overrides: Record<string, 'local' | 'backup'> = {}) {
  const dir = stagingDir(ctx, id);
  if (!existsSync(join(dir, 'analysis.json'))) throw badRequest('Import nicht gefunden oder abgelaufen');
  const analysis: ImportAnalysis = JSON.parse(await readFile(join(dir, 'analysis.json'), 'utf8'));
  const decide = (c: ImportConflict): 'local' | 'backup' => {
    const o = overrides[`${c.table}:${c.key}`];
    if (o) return o;
    if (strategy === 'local') return 'local';
    if (strategy === 'backup') return 'backup';
    return c.newer === 'backup' ? 'backup' : 'local';
  };
  const takeBackup = new Set(analysis.conflicts.filter((c) => decide(c) === 'backup').map((c) => `${c.table}:${c.key}`));
  const summary = { inserted: 0, updated: 0, skipped: 0, files: 0 };
  const overwritePaths = new Set<string>();

  await ctx.sql.begin(async (tx) => {
    let replica = false;
    try { await tx.unsafe(`set local session_replication_role = replica`); replica = true; } catch { /* kein Superuser */ }
    for (const t of BACKUP_TABLES) {
      const p = join(dir, 'db', `${t.name}.json`);
      if (!existsSync(p)) continue;
      const rows: Record<string, unknown>[] = JSON.parse(await readFile(p, 'utf8'));
      if (!rows.length) continue;
      const cols = (await tx<{ column_name: string }[]>`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${t.name}`).map((c) => c.column_name);
      const nonPk = cols.filter((c) => !t.pk.includes(c));
      const q = (c: string) => `"${c}"`;
      const insert = `insert into ${t.name} select * from json_populate_record(null::${t.name}, $1::json) on conflict (${t.pk.map(q).join(',')}) do nothing`;
      const upsert = nonPk.length
        ? `insert into ${t.name} select * from json_populate_record(null::${t.name}, $1::json) on conflict (${t.pk.map(q).join(',')})
           do update set (${nonPk.map(q).join(',')}) = row(${nonPk.map((c) => `excluded.${q(c)}`).join(',')})`
        : insert;
      for (const row of rows) {
        const k = `${t.name}:${keyOf(row, t.pk)}`;
        if (takeBackup.has(k)) {
          if (t.name === 'audit_log' && !replica) { summary.skipped++; continue; }
          await tx.unsafe(upsert, [row as never]);
          summary.updated++;
          if (t.name === 'files' && row.path) overwritePaths.add(String(row.path));
        } else {
          const r = await tx.unsafe(insert, [row as never]);
          if (r.count) summary.inserted++; else summary.skipped++;
        }
      }
    }
    await tx.unsafe(`select setval(pg_get_serial_sequence('audit_log','id'), greatest((select max(id) from audit_log), 1))`);
    await tx.unsafe(`select setval(pg_get_serial_sequence('kvp_ideas','number'), greatest((select max(number) from kvp_ideas), 1))`);
  });

  const filesDir = join(dir, 'files');
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdir(d).catch(() => [] as string[])) {
      const p = join(d, name);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else {
        const rel = relative(filesDir, p).split(sep).join('/');
        const dest = ctx.storage.abs(rel);
        const overwrite = strategy === 'backup' || overwritePaths.has(rel);
        if (!existsSync(dest) || overwrite) {
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(p, dest);
          summary.files++;
        }
      }
    }
  };
  await walk(filesDir);
  await rm(dir, { recursive: true, force: true });
  ctx.settings.clearCache();
  return summary;
}

export async function discardImport(ctx: AppContext, id: string) {
  await rm(stagingDir(ctx, id), { recursive: true, force: true });
}

