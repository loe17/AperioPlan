import {
  formatProjectNumber, formatSubprojectNumber, nextProjectSequence, projectFolderName, type ProjectModule,
} from '@aperio/shared';
import type { AppContext } from '../context';
import type { Db as Sql } from '../db';
import { badRequest, notFound } from '../lib/errors';

/** Vergibt die nächste Projektnummer (fortlaufend oder mit Jahreszahl) bzw. Teilprojektnummer. */
export async function allocateProjectNumber(tx: Sql, ctx: AppContext, parentId: string | null, override?: string, info: { teamId?: string | null; customer?: string | null } = {}) {
  await tx`select pg_advisory_xact_lock(4711)`;
  if (override) {
    const [exists] = await tx`select 1 from projects where number = ${override}`;
    if (exists) throw badRequest(`Projektnummer ${override} ist bereits vergeben`);
    const seq = Number(/(\d+)$/.exec(override)?.[1] ?? 0);
    return { number: override, seq, year: null as number | null };
  }
  const s = await ctx.settings.get('projectNumbers');
  if (parentId) {
    const [parent] = await tx<{ number: string }[]>`select number from projects where id = ${parentId}`;
    if (!parent) throw notFound('Hauptprojekt nicht gefunden');
    const n = (await tx<{ n: number }[]>`select count(*)::int as n from projects where parent_id = ${parentId}`)[0]!.n;
    let idx = n;
    let number = formatSubprojectNumber(parent.number, idx, s.subStyle);
    while ((await tx`select 1 from projects where number = ${number}`).length) number = formatSubprojectNumber(parent.number, ++idx, s.subStyle);
    return { number, seq: idx, year: null as number | null };
  }
  const year = new Date().getFullYear();
  const perYear = s.format === 'year' || (s.format === 'pattern' && s.yearlyReset);
  const team = info.teamId ? (await tx<{ short_code: string; name: string }[]>`select short_code, name from teams where id = ${info.teamId}`)[0] : undefined;
  const nctx = { team: team ? team.short_code || team.name.slice(0, 3) : '', customer: info.customer ?? '' };
  const rows = perYear
    ? await tx<{ seq: number }[]>`select seq from projects where parent_id is null and year = ${year}`
    : await tx<{ seq: number }[]>`select seq from projects where parent_id is null and year is null`;
  let seq = nextProjectSequence(rows.map((r) => r.seq), s);
  let number = formatProjectNumber(seq, s, year, nctx);
  while ((await tx`select 1 from projects where number = ${number}`).length) {
    seq = nextProjectSequence([seq], s);
    number = formatProjectNumber(seq, s, year, nctx);
  }
  return { number, seq, year: perYear ? year : null };
}

/** Legt die Standard-Ordnerstruktur an (01_CAD, 02_Zeichnungen, ...). */
/** Ordnerliste für neue Projekte; Unterordner als „01_CAD/Teile“. Unzulässige Teile (.., Laufwerk) werden entfernt. */
export function cleanFolderList(list: string[] | undefined) {
  return (list ?? []).map((f) => f.replace(/\\/g, '/').split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..' && !/[:*?"<>|]/.test(x)).join('/')).filter(Boolean);
}

export async function createProjectFolders(ctx: AppContext, tx: Sql, projectId: string, number: string, name: string, parentId: string | null, locationId?: string | null, teamId?: string | null) {
  const st = await ctx.settings.get('storage');
  // Speicherort: ausdrücklich gewählt, sonst der der Abteilung, sonst der Standard
  const loc = locationId ?? st.locations.find((l) => teamId && l.teamIds.includes(teamId) && !l.archive)?.id ?? st.defaultLocation ?? 'main';
  let base = loc && loc !== 'main' && st.locations.some((l) => l.id === loc) ? `@${loc}/Projekte` : 'Projekte';
  const s = await ctx.settings.get('projectNumbers');
  if (parentId) {
    const [parent] = await tx<{ folder_path: string | null }[]>`select folder_path from projects where id = ${parentId}`;
    if (parent?.folder_path) base = parent.folder_path;
  }
  const folder = `${base}/${projectFolderName(number, name)}`;
  const storage = await ctx.settings.get('storage');
  await ctx.storage.ensureDir(folder);
  for (const f of cleanFolderList(storage.projectFolders)) await ctx.storage.ensureDir(`${folder}/${f}`);
  await tx`update projects set folder_path = ${folder} where id = ${projectId}`;
  return folder;
}

export const normalizeModules = (mods: string[] | undefined, defaults: ProjectModule[]) => (mods?.length ? mods : defaults);
