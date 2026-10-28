import type { FastifyInstance, FastifyReply } from 'fastify';
import { posix } from 'node:path';
import { projectFolderName, sanitizeName, DEFAULT_PROJECT_FOLDERS } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { cleanRel, mimeOf, safeName, storeFile, syncFolder, TRASH_DIR, VERSIONS_DIR } from '../services/files';
import { allocateProjectNumber, cleanFolderList } from '../services/projects';

export async function sendStoredFile(ctx: AppContext, reply: FastifyReply, path: string, name: string, inline = false) {
  const st = await ctx.storage.stat(path);
  if (!st?.isFile()) throw notFound('Datei nicht gefunden');
  reply.header('content-type', mimeOf(name));
  reply.header('content-length', st.size);
  reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  return reply.send(ctx.storage.read(path));
}

export default async function fileRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  async function projectFolder(userId: Parameters<typeof projectAccess>[1], projectId: string, need: 'read' | 'edit' = 'read') {
    const p = await projectAccess(sql, userId, projectId, need);
    if (!p.folder_path) throw badRequest('Projekt hat keinen Ordner');
    return p;
  }

  /** Ordnerinhalt eines Projekts (Pfad relativ zum Projektordner) */
  app.get('/projects/:id/files', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { path } = parse(z.object({ path: z.string().optional() }), req.query);
    const p = await projectFolder(u, id);
    const rel = cleanRel(path);
    const abs = rel ? `${p.folder_path}/${rel}` : p.folder_path!;
    await syncFolder(ctx, sql, id, abs);
    const entries = (await storage.list(abs)).filter((e) => e.name !== VERSIONS_DIR && e.name !== TRASH_DIR);
    const meta = await sql<any[]>`select f.id, f.path, f.version, f.locked_by as "lockedBy", lu.display_name as "lockedByName",
        f.uploaded_via as "uploadedVia", uu.display_name as "uploadedByName"
      from files f left join users lu on lu.id = f.locked_by left join users uu on uu.id = f.uploaded_by
      where f.path = any(${entries.filter((e) => !e.isDir).map((e) => e.path)})`;
    const byPath = new Map(meta.map((m) => [m.path, m]));
    return {
      path: rel,
      folderPath: p.folder_path,
      entries: entries.map((e) => ({ name: e.name, isDir: e.isDir, size: e.size, modified: e.modified, relPath: rel ? `${rel}/${e.name}` : e.name, ...(byPath.get(e.path) ?? {}) })),
    };
  });

  app.post('/projects/:id/files/upload', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { path } = parse(z.object({ path: z.string().optional() }), req.query);
    const p = await projectFolder(u, id, 'edit');
    const rel = cleanRel(path);
    const saved = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? part.filename);
      const target = `${p.folder_path}${rel ? '/' + rel : ''}/${name}`;
      const f = await storeFile(ctx, { projectId: id, path: target, stream: part.file, userId: u.id });
      if (part.file.truncated) throw badRequest('Datei zu groß');
      saved.push(f);
      await audit(sql, u, { action: 'file.upload', entityType: 'file', entityId: f.id, projectId: id, summary: `Datei ${rel ? rel + '/' : ''}${name} hochgeladen (Version ${f.version})` });
    }
    ctx.hub.publish(`project:${id}`, 'files.changed', { path: rel });
    return saved;
  });

  app.post('/projects/:id/files/folder', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ path: z.string().default(''), name: z.string().min(1) }), req.body);
    const p = await projectFolder(u, id, 'edit');
    const rel = cleanRel(b.path);
    await storage.ensureDir(`${p.folder_path}${rel ? '/' + rel : ''}/${safeName(b.name)}`);
    ctx.hub.publish(`project:${id}`, 'files.changed', { path: rel });
    return { ok: true };
  });

  /** Umbenennen / Verschieben innerhalb des Projektordners */
  app.post('/projects/:id/files/move', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ from: z.string().min(1), to: z.string().min(1) }), req.body);
    const p = await projectFolder(u, id, 'edit');
    const from = `${p.folder_path}/${cleanRel(b.from)}`;
    const to = `${p.folder_path}/${cleanRel(b.to)}`;
    if (await storage.stat(to)) throw badRequest('Ziel existiert bereits');
    const [locked] = await sql`select 1 from files where (path = ${from} or path like ${from + '/%'}) and locked_by is not null and locked_by <> ${u.id}`;
    if (locked) throw badRequest('Enthält gesperrte Dateien');
    await storage.move(from, to);
    await sql`update files set path = ${to} || substr(path, ${from.length + 1}), name = case when path = ${from} then ${posix.basename(to)} else name end,
      updated_at = now() where path = ${from} or path like ${from + '/%'}`;
    await sql`update cad_items set file_path = ${to} || substr(file_path, ${from.length + 1}) where file_path = ${from} or file_path like ${from + '/%'}`;
    await audit(sql, u, { action: 'file.move', entityType: 'file', projectId: id, summary: `${b.from} → ${b.to}` });
    ctx.hub.publish(`project:${id}`, 'files.changed', {});
    return { ok: true };
  });

  /** Löschen = Verschieben in den Papierkorb des Projekts */
  app.post('/projects/:id/files/delete', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ path: z.string().min(1) }), req.body);
    const p = await projectFolder(u, id, 'edit');
    const rel = cleanRel(b.path);
    if (!rel) throw badRequest('Projektordner kann nicht gelöscht werden');
    const from = `${p.folder_path}/${rel}`;
    const [cad] = await sql`select 1 from cad_items where file_path = ${from} or file_path like ${from + '/%'}`;
    if (cad) throw badRequest('Enthält CAD-Dateien – bitte in der CAD-Bridge verwalten');
    const to = `${p.folder_path}/${TRASH_DIR}/${new Date().toISOString().replace(/[:.]/g, '-')}_${posix.basename(rel)}`;
    await storage.move(from, to);
    await sql`delete from files where path = ${from} or path like ${from + '/%'}`;
    await audit(sql, u, { action: 'file.delete', entityType: 'file', projectId: id, summary: `${rel} in den Papierkorb verschoben` });
    ctx.hub.publish(`project:${id}`, 'files.changed', {});
    return { ok: true };
  });

  app.get('/projects/:id/files/download', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ path: z.string().min(1), inline: z.coerce.boolean().default(false) }), req.query);
    const p = await projectFolder(u, id);
    const rel = cleanRel(q.path);
    return sendStoredFile(ctx, reply, `${p.folder_path}/${rel}`, posix.basename(rel), q.inline);
  });

  /** Dateien ohne Projekt: Chat-Anhänge (nur Mitglieder der Unterhaltung) und CRM-Anhänge (mit CRM-Recht) */
  async function mayReadLoose(u: Parameters<typeof projectAccess>[1], path: string) {
    if (u.role === 'guest') return false;
    const chat = /^Chat\/([0-9a-f-]{36})\//.exec(path);
    if (chat) {
      const [m] = await sql`select 1 from chat_members where channel_id = ${chat[1]!} and user_id = ${u.id}
        union select 1 from chat_channels c join team_members tm on tm.team_id = c.team_id where c.id = ${chat[1]!} and tm.user_id = ${u.id}`;
      return Boolean(m);
    }
    if (path.startsWith('CRM/')) return u.tools.includes('crm');
    return false;
  }

  app.get('/files/:id/download', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ inline: z.coerce.boolean().default(false), version: z.coerce.number().int().optional() }), req.query);
    const [f] = await sql<{ path: string; name: string; project_id: string | null; version: number }[]>`select path, name, project_id, version from files where id = ${id}`;
    if (!f) throw notFound();
    if (f.project_id) await projectAccess(sql, u, f.project_id);
    else if (u.role !== 'admin' && !(await mayReadLoose(u, f.path))) throw notFound();
    if (q.version && q.version !== f.version) {
      const [v] = await sql<{ path: string }[]>`select path from file_versions where file_id = ${id} and version = ${q.version}`;
      if (!v) throw notFound('Version nicht gefunden');
      return sendStoredFile(ctx, reply, v.path, `v${q.version}_${f.name}`, q.inline);
    }
    return sendStoredFile(ctx, reply, f.path, f.name, q.inline);
  });

  app.get('/files/:id/versions', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [f] = await sql<{ project_id: string | null; version: number; size: number; updated_at: Date; uploaded_by_name: string | null }[]>`
      select f.project_id, f.version, f.size::float as size, f.updated_at, us.display_name as uploaded_by_name
      from files f left join users us on us.id = f.uploaded_by where f.id = ${id}`;
    if (!f) throw notFound();
    if (f.project_id) await projectAccess(sql, u, f.project_id);
    const older = await sql`select v.version, v.size::float as size, v.created_at as "createdAt", us.display_name as "uploadedByName", v.comment
      from file_versions v left join users us on us.id = v.uploaded_by where v.file_id = ${id} order by v.version desc`;
    return [{ version: f.version, size: f.size, createdAt: f.updated_at, uploadedByName: f.uploaded_by_name, current: true }, ...older];
  });

  /** Datei für andere sperren (Office-Dokumente u. ä.) */
  app.post('/files/:id/lock', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { lock } = parse(z.object({ lock: z.boolean() }), req.body);
    const [f] = await sql<{ project_id: string; locked_by: string | null }[]>`select project_id, locked_by from files where id = ${id}`;
    if (!f) throw notFound();
    await projectAccess(sql, u, f.project_id, 'edit');
    if (f.locked_by && f.locked_by !== u.id && u.role !== 'admin') throw badRequest('Von jemand anderem gesperrt');
    await sql`update files set locked_by = ${lock ? u.id : null} where id = ${id}`;
    ctx.hub.publish(`project:${f.project_id}`, 'files.changed', {});
    return { ok: true };
  });

  // ------------------------------------------------ Scan-Assistent für Bestandsordner
  app.get('/storage/scan', async (req) => {
    requireRole(req, 'admin');
    const { path } = parse(z.object({ path: z.string().default('') }), req.query);
    const rel = cleanRel(path);
    const entries = (await storage.list(rel)).filter((e) => e.isDir && !e.name.startsWith('.'));
    const linked = await sql<{ folder_path: string; id: string; number: string }[]>`select folder_path, id, number from projects where folder_path is not null`;
    const byPath = new Map(linked.map((l) => [l.folder_path, l]));
    const out = [];
    for (const e of entries) {
      const sub = await storage.list(e.path);
      const m = /^(\d{4}(?:-[A-Z]+)?|[A-Z]+-\d{4}-\d{3,6})[ _-]+(.+)$/.exec(e.name);
      out.push({
        name: e.name, path: e.path, modified: e.modified,
        files: sub.filter((s) => !s.isDir).length, folders: sub.filter((s) => s.isDir).length,
        linkedProject: byPath.get(e.path) ?? null,
        suggestion: m ? { number: m[1], name: m[2]!.replace(/_/g, ' ') } : { number: null, name: e.name.replace(/_/g, ' ') },
      });
    }
    return { path: rel, entries: out };
  });

  /** Bestandsordner als Projekt einbinden, auf Wunsch normgerecht umbenennen */
  app.post('/storage/import', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({
      path: z.string().min(1), name: z.string().trim().min(1), number: z.string().trim().regex(/^[\w-]+$/).nullable().default(null),
      teamId: z.string().uuid().nullable().default(null), rename: z.boolean().default(true), createFolders: z.boolean().default(true),
      moveToProjects: z.boolean().default(false),
    }), req.body);
    const src = cleanRel(b.path);
    if (!(await storage.stat(src))?.isDirectory()) throw badRequest('Ordner nicht gefunden');
    const [already] = await sql`select number from projects where folder_path = ${src}`;
    if (already) throw badRequest(`Ordner ist bereits Projekt ${already.number} zugeordnet`);
    const defaults = await ctx.settings.get('defaultModules');
    const storageSettings = await ctx.settings.get('storage');
    const result = await sql.begin(async (tx) => {
      const { number, seq, year } = await allocateProjectNumber(tx, ctx, null, b.number ?? undefined);
      let folder = src;
      const parentDir = posix.dirname(src) === '.' ? '' : posix.dirname(src);
      const base = b.moveToProjects ? 'Projekte' : parentDir;
      if (b.rename || b.moveToProjects) {
        const target = `${base ? base + '/' : ''}${b.rename ? projectFolderName(number, b.name) : posix.basename(src)}`;
        if (target !== src) {
          if (await storage.stat(target)) throw badRequest(`Zielordner ${target} existiert bereits`);
          await storage.move(src, target);
          folder = target;
        }
      }
      const [p] = await tx<{ id: string }[]>`insert into projects (number, seq, year, name, team_id, modules, folder_path, created_by, description)
        values (${number}, ${seq}, ${year}, ${b.name}, ${b.teamId}, ${tx.json(defaults)}, ${folder}, ${u.id}, ${'Aus Bestandsordner übernommen: ' + src})
        returning id`;
      await tx`insert into project_members (project_id, user_id, role) values (${p!.id}, ${u.id}, 'owner')`;
      await tx`insert into chat_channels (kind, project_id, name) values ('project', ${p!.id}, ${number + ' ' + b.name})`;
      if (b.createFolders) for (const f of cleanFolderList(storageSettings.projectFolders ?? DEFAULT_PROJECT_FOLDERS)) await storage.ensureDir(`${folder}/${f}`);
      // Dateien indizieren
      const all = await storage.walk(folder, 8);
      for (const e of all) {
        if (e.isDir || e.path.includes(`/${VERSIONS_DIR}/`) || e.path.includes(`/${TRASH_DIR}/`)) continue;
        await tx`insert into files (project_id, path, name, size, mime, created_at, updated_at, uploaded_via)
          values (${p!.id}, ${e.path}, ${e.name}, ${e.size}, ${mimeOf(e.name)}, ${e.modified}, ${e.modified}, 'Bestandsimport') on conflict (path) do nothing`;
      }
      return { id: p!.id, number, folderPath: folder, files: all.filter((e) => !e.isDir).length };
    });
    await audit(sql, u, { action: 'project.import', entityType: 'project', entityId: result.id, projectId: result.id,
      summary: `Bestandsordner ${src} als Projekt ${result.number} eingebunden (${result.files} Dateien)` });
    return result;
  });

  app.get('/storage/suggest-name', async (req) => {
    requireUser(req);
    const { name } = parse(z.object({ name: z.string() }), req.query);
    return { name: sanitizeName(name) };
  });
}
