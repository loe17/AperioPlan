import {
  formatProjectNumber, formatSubprojectNumber, nextProjectSequence, projectFolderName, type ProjectModule,
} from '@aperio/shared';
import type { AppContext } from '../context';
import type { Db as Sql } from '../db';
import { badRequest, notFound } from '../lib/errors';

/** Vergibt die nächste Projektnummer (fortlaufend oder mit Jahreszahl) bzw. Teilprojektnummer. */
export async function allocateProjectNumber(tx: Sql, ctx: AppContext, parentId: string | null, override?: string) {
  await tx`select pg_advisory_xact_lock(4711)`;
  if (override) {
    const [exists] = await tx`select 1 from projects where number = ${override}`;
    if (exists) throw badRequest(`Projektnummer ${override} ist bereits vergeben`);
    const seq = Number(/(\d+)$/.exec(override)?.[1] ?? 0);
    return { number: override, seq, year: null as number | null };
  }
  if (parentId) {
    const [parent] = await tx<{ number: string }[]>`select number from projects where id = ${parentId}`;
    if (!parent) throw notFound('Hauptprojekt nicht gefunden');
    const n = (await tx<{ n: number }[]>`select count(*)::int as n from projects where parent_id = ${parentId}`)[0]!.n;
    let idx = n;
    let number = formatSubprojectNumber(parent.number, idx);
    while ((await tx`select 1 from projects where number = ${number}`).length) number = formatSubprojectNumber(parent.number, ++idx);
    return { number, seq: idx, year: null as number | null };
  }
  const s = await ctx.settings.get('projectNumbers');
  const year = new Date().getFullYear();
  const rows = s.format === 'year'
    ? await tx<{ seq: number }[]>`select seq from projects where parent_id is null and year = ${year}`
    : await tx<{ seq: number }[]>`select seq from projects where parent_id is null and year is null`;
  let seq = nextProjectSequence(rows.map((r) => r.seq), s);
  let number = formatProjectNumber(seq, s, year);
  while ((await tx`select 1 from projects where number = ${number}`).length) {
    seq = nextProjectSequence([seq], s);
    number = formatProjectNumber(seq, s, year);
  }
  return { number, seq, year: s.format === 'year' ? year : null };
}

/** Legt die Standard-Ordnerstruktur an (01_CAD, 02_Zeichnungen, ...). */
export async function createProjectFolders(ctx: AppContext, tx: Sql, projectId: string, number: string, name: string, parentId: string | null) {
  let base = 'Projekte';
  if (parentId) {
    const [parent] = await tx<{ folder_path: string | null }[]>`select folder_path from projects where id = ${parentId}`;
    if (parent?.folder_path) base = parent.folder_path;
  }
  const folder = `${base}/${projectFolderName(number, name)}`;
  const storage = await ctx.settings.get('storage');
  await ctx.storage.ensureDir(folder);
  for (const f of storage.projectFolders) await ctx.storage.ensureDir(`${folder}/${f}`);
  await tx`update projects set folder_path = ${folder} where id = ${projectId}`;
  return folder;
}

export const normalizeModules = (mods: string[] | undefined, defaults: ProjectModule[]) => (mods?.length ? mods : defaults);
