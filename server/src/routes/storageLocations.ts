/**
 * Mehrere Speicherorte: Standardablage plus eingebundene Netzlaufwerke (NAS, Windows-Freigabe, NFS) und Archiv.
 * Abteilungen oder einzelne Projekte bekommen einen Speicherort; abgeschlossene Projekte lassen sich ins Archiv verschieben.
 */
import type { FastifyInstance } from 'fastify';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';

/** Pfade, die Dateien referenzieren: werden beim Verschieben eines Projektordners angepasst */
const PATH_COLUMNS: [string, string][] = [
  ['files', 'path'], ['file_versions', 'path'], ['projects', 'folder_path'], ['cad_items', 'file_path'], ['cad_revisions', 'file_path'],
  ['cad_exports', 'file_path'], ['share_links', 'folder_path'],
];

export default async function storageLocationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  app.get('/storage/locations', async (req) => {
    requireUser(req);
    const st = await ctx.settings.get('storage');
    const list = [{ id: 'main', name: 'Standardablage', path: ctx.config.storageRoot, networkPath: st.networkPath, teamIds: [] as string[], archive: false }, ...st.locations];
    const out = [];
    for (const l of list) {
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from projects where ${l.id === 'main' ? sql`coalesce(folder_path, '') not like '@%'` : sql`folder_path like ${`@${l.id}/%`}`}`;
      out.push({ ...l, isDefault: (st.defaultLocation || 'main') === l.id, projects: n?.n ?? 0, space: await storage.space(l.path), reachable: existsSync(l.path) });
    }
    return out;
  });

  /** Unter dem Ordner für Netzlaufwerke eingebundene Ordner (install.sh speicherort) zur Auswahl */
  app.get('/storage/locations/detected', async (req) => {
    requireRole(req, 'admin');
    const dir = ctx.config.locationsDir;
    if (!existsSync(dir)) return { dir, folders: [] };
    const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    const folders = [];
    for (const name of names) folders.push({ name, path: join(dir, name), space: await storage.space(join(dir, name)) });
    return { dir, folders };
  });

  /** Projektordner in einen anderen Speicherort verschieben – Verweise und Versionen bleiben erhalten */
  app.post('/projects/:id/move-storage', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ locationId: z.string().min(1).max(40) }), req.body);
    const [p] = await sql<{ number: string; name: string; folder_path: string | null; status: string }[]>`select number, name, folder_path, status from projects where id = ${id}`;
    if (!p) throw notFound('Projekt nicht gefunden');
    if (!p.folder_path) throw badRequest('Projekt hat keinen Ordner');
    const st = await ctx.settings.get('storage');
    if (b.locationId !== 'main' && !st.locations.some((l) => l.id === b.locationId)) throw badRequest('Speicherort unbekannt');
    const tail = p.folder_path.replace(/^@[a-z0-9_-]+\//, '');
    const target = b.locationId === 'main' ? tail : `@${b.locationId}/${tail}`;
    if (target === p.folder_path) return { ok: true, folderPath: target };
    if (await storage.stat(target)) throw badRequest('Am Ziel gibt es bereits einen Ordner mit diesem Namen');
    const [locked] = await sql<{ n: number }[]>`select count(*)::int as n from files where path like ${`${p.folder_path}/%`} and locked_by is not null`;
    if (locked?.n) throw badRequest(`${locked.n} Dateien sind ausgecheckt – bitte zuerst einchecken`);
    // Altversionen liegen in .versions/<Pfad>; die Ordner wandern mit
    await storage.moveTree(p.folder_path, target);
    const oldPrefix = `${p.folder_path}/`, newPrefix = `${target}/`;
    await sql.begin(async (tx) => {
      for (const [table, col] of PATH_COLUMNS) {
        await tx.unsafe(`update ${table} set ${col} = $1 || substr(${col}, $2) where ${col} = $3 or ${col} like $4`,
          [newPrefix.slice(0, -1), oldPrefix.length, p.folder_path, `${oldPrefix.replace(/[%_]/g, '\\$&')}%`]);
      }
    });
    await audit(sql, u, { action: 'project.storage', entityType: 'project', entityId: id, projectId: id, summary: `Projektordner verschoben: ${p.folder_path} → ${target}` });
    return { ok: true, folderPath: target };
  });
}
