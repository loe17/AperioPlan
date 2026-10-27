/**
 * Externe Freigaben (Kapitel 10):
 *  - guest:   Gastzugang auf freigegebene Bereiche eines Projekts (nur lesen)
 *  - share:   „Daten teilen“ – Dateien/Ordner per Link, optional mit Passwort und Ablaufdatum
 *  - request: „Daten anfordern“ – Externe laden ohne Konto in einen Projektordner hoch
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { posix } from 'node:path';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound, HttpError } from '../lib/errors';
import { hashPassword, randomToken, verifyPassword } from '../lib/crypto';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { cleanRel, safeName, storeFile, TRASH_DIR, VERSIONS_DIR } from '../services/files';
import { sendStoredFile } from './files';

interface LinkRow {
  id: string; token: string; kind: 'guest' | 'share' | 'request'; label: string; project_id: string; folder_path: string | null;
  file_ids: string[]; areas: string[]; password_hash: string | null; expires_at: Date | null; max_uses: number | null;
  use_count: number; created_by: string | null; revoked_at: Date | null;
}

export default async function linkRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage, config } = ctx;
  const linkUrl = (token: string) => `${config.publicUrl}/s/${token}`;

  app.get('/projects/:id/links', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id, 'edit');
    const rows = await sql`select l.id, l.token, l.kind, l.label, l.folder_path as "folderPath", l.file_ids as "fileIds", l.areas,
      (l.password_hash is not null) as "hasPassword", l.expires_at as "expiresAt", l.max_uses as "maxUses", l.use_count as "useCount",
      l.created_at as "createdAt", l.revoked_at as "revokedAt", us.display_name as "createdByName"
      from share_links l left join users us on us.id = l.created_by where l.project_id = ${id} order by l.created_at desc`;
    return rows.map((r) => ({ ...r, url: linkUrl(r.token as string) }));
  });

  app.post('/projects/:id/links', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const p = await projectAccess(sql, u, id, 'edit');
    const b = parse(z.object({
      kind: z.enum(['guest', 'share', 'request']),
      label: z.string().trim().default(''),
      folderPath: z.string().default(''),
      fileIds: z.array(z.string().uuid()).default([]),
      areas: z.array(z.enum(['files', 'drawings', 'tasks'])).default([]),
      password: z.string().optional(),
      expiresAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().default(null),
      maxUses: z.number().int().positive().nullable().default(null),
    }), req.body);
    if (b.kind === 'guest' && !b.areas.length) throw badRequest('Bitte mindestens einen Bereich für den Gastzugang wählen');
    const folder = `${p.folder_path}${cleanRel(b.folderPath) ? '/' + cleanRel(b.folderPath) : ''}`;
    if (b.kind === 'request') await storage.ensureDir(folder);
    const token = randomToken(24);
    const [l] = await sql`insert into share_links (token, kind, label, project_id, folder_path, file_ids, areas, password_hash, expires_at, max_uses, created_by)
      values (${token}, ${b.kind}, ${b.label}, ${id}, ${folder}, ${b.fileIds}, ${b.areas}, ${b.password ? await hashPassword(b.password) : null},
        ${b.expiresAt ? new Date(b.expiresAt) : null}, ${b.maxUses}, ${u.id}) returning id`;
    const kindLabel = { guest: 'Gastlink', share: 'Teilen-Link', request: 'Anforderungslink' }[b.kind];
    await audit(sql, u, { action: 'link.create', entityType: 'share_link', entityId: l!.id, projectId: id, summary: `${kindLabel} „${b.label || folder}“ erstellt` });
    return { id: l!.id, token, url: linkUrl(token) };
  });

  app.delete('/links/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [l] = await sql<{ project_id: string }[]>`select project_id from share_links where id = ${id}`;
    if (!l) throw notFound();
    await projectAccess(sql, u, l.project_id, 'edit');
    await sql`update share_links set revoked_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'link.revoke', entityType: 'share_link', entityId: id, projectId: l.project_id, summary: 'Freigabelink widerrufen' });
    return { ok: true };
  });

  // ================================================== öffentlicher Teil (ohne Anmeldung)
  async function loadLink(req: FastifyRequest, token: string, countUse = false): Promise<LinkRow & { project_name: string; project_number: string }> {
    const [l] = await sql<(LinkRow & { project_name: string; project_number: string })[]>`select l.*, p.name as project_name, p.number as project_number
      from share_links l join projects p on p.id = l.project_id where l.token = ${token}`;
    if (!l || l.revoked_at) throw notFound('Link ungültig oder widerrufen');
    if (l.expires_at && l.expires_at < new Date()) throw new HttpError(410, 'Dieser Link ist abgelaufen', 'expired');
    if (l.max_uses && l.use_count >= l.max_uses) throw new HttpError(410, 'Dieser Link wurde bereits vollständig genutzt', 'used_up');
    if (l.password_hash) {
      const pw = String(req.headers['x-link-password'] ?? '');
      if (!pw || !(await verifyPassword(pw, l.password_hash))) throw new HttpError(401, 'Passwort erforderlich', 'password');
    }
    if (countUse) await sql`update share_links set use_count = use_count + 1 where id = ${l.id}`;
    return l;
  }

  const linkRel = (l: LinkRow, path?: string) => {
    const rel = cleanRel(path);
    return rel ? `${l.folder_path}/${rel}` : l.folder_path!;
  };

  app.get('/public/links/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    const [l] = await sql<(LinkRow & { project_name: string; project_number: string; creator: string | null })[]>`
      select l.*, p.name as project_name, p.number as project_number, us.display_name as creator
      from share_links l join projects p on p.id = l.project_id left join users us on us.id = l.created_by where l.token = ${token}`;
    if (!l || l.revoked_at) throw notFound('Link ungültig oder widerrufen');
    const expired = (l.expires_at && l.expires_at < new Date()) || (l.max_uses ? l.use_count >= l.max_uses : false);
    const company = await ctx.settings.get('company');
    return { kind: l.kind, label: l.label, project: `${l.project_number} ${l.project_name}`, company: company.name, creator: l.creator,
      needsPassword: Boolean(l.password_hash), expired, expiresAt: l.expires_at, areas: l.areas };
  });

  app.get('/public/links/:token/files', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    const { path } = parse(z.object({ path: z.string().optional() }), req.query);
    const l = await loadLink(req, token);
    if (l.kind === 'request') throw forbidden();
    if (l.kind === 'guest' && !l.areas.includes('files')) throw forbidden();
    if (l.file_ids.length) {
      return { path: '', entries: await sql`select id, name, size::float as size, updated_at as modified, false as "isDir", name as "relPath" from files where id = any(${l.file_ids})` };
    }
    const entries = (await storage.list(linkRel(l, path))).filter((e) => e.name !== VERSIONS_DIR && e.name !== TRASH_DIR);
    const rel = cleanRel(path);
    return { path: rel, entries: entries.map((e) => ({ name: e.name, isDir: e.isDir, size: e.size, modified: e.modified, relPath: rel ? `${rel}/${e.name}` : e.name })) };
  });

  app.get('/public/links/:token/download', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    const q = parse(z.object({ path: z.string().optional(), fileId: z.string().uuid().optional(), inline: z.coerce.boolean().default(false), pw: z.string().optional() }), req.query);
    if (q.pw && !req.headers['x-link-password']) req.headers['x-link-password'] = q.pw;
    const l = await loadLink(req, token, true);
    if (l.kind === 'request') throw forbidden();
    if (q.fileId) {
      const allowed = l.file_ids.includes(q.fileId) || (l.kind === 'guest' && l.areas.includes('drawings'));
      if (!allowed) throw forbidden();
      const [f] = await sql<{ path: string; name: string; project_id: string }[]>`select path, name, project_id from files where id = ${q.fileId}`;
      if (!f || f.project_id !== l.project_id) throw notFound();
      return sendStoredFile(ctx, reply, f.path, f.name, q.inline);
    }
    if (l.file_ids.length || !q.path) throw badRequest('Datei angeben');
    if (l.kind === 'guest' && !l.areas.includes('files')) throw forbidden();
    const full = linkRel(l, q.path);
    return sendStoredFile(ctx, reply, full, posix.basename(full), q.inline);
  });

  /** „Daten anfordern“: Upload ohne Benutzerkonto */
  app.post('/public/links/:token/upload', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    const l = await loadLink(req, token);
    if (l.kind !== 'request') throw forbidden();
    const uploader = String(req.headers['x-uploader-name'] ?? '').slice(0, 120) || 'Unbekannt';
    const saved: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? part.filename);
      let target = `${l.folder_path}/${name}`;
      if (await storage.stat(target)) {
        const dot = name.lastIndexOf('.');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        target = `${l.folder_path}/${dot > 0 ? name.slice(0, dot) : name}_${stamp}${dot > 0 ? name.slice(dot) : ''}`;
      }
      await storeFile(ctx, { projectId: l.project_id, path: target, stream: part.file, userId: null, via: `Anforderungslink: ${uploader}` });
      saved.push(posix.basename(target));
    }
    if (!saved.length) throw badRequest('Keine Datei empfangen');
    await sql`update share_links set use_count = use_count + 1 where id = ${l.id}`;
    await audit(sql, null, { action: 'link.upload', entityType: 'share_link', entityId: l.id, projectId: l.project_id,
      summary: `${uploader} hat über Anforderungslink ${saved.length} Datei(en) hochgeladen: ${saved.join(', ')}` });
    await notify(ctx, [l.created_by], { kind: 'link.upload', title: `${uploader} hat Dateien hochgeladen`, body: saved.join(', '),
      link: `/projects/${l.project_id}?tab=files&path=${encodeURIComponent(l.folder_path!.split('/').slice(3).join('/'))}` });
    ctx.hub.publish(`project:${l.project_id}`, 'files.changed', {});
    return { ok: true, files: saved };
  });

  /** Gastzugang: Aufgaben (nur lesen) */
  app.get('/public/links/:token/tasks', async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    const l = await loadLink(req, token);
    if (l.kind !== 'guest' || !l.areas.includes('tasks')) throw forbidden();
    return sql`select number, title, status, due_date as "dueDate", milestone from tasks where project_id = ${l.project_id} order by number`;
  });

  /** Gastzugang: freigegebene Zeichnungen (PDF der Fertigungsableitungen) */
  app.get('/public/links/:token/drawings', async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    const l = await loadLink(req, token);
    if (l.kind !== 'guest' || !l.areas.includes('drawings')) throw forbidden();
    return sql`select c.base_number as "baseNumber", lpad(c.revision::text, 2, '0') as revision, c.designation, e.format, f.id as "fileId", f.name
      from cad_items c join cad_exports e on e.item_id = c.id and e.revision = c.revision and e.status = 'done'
      join files f on f.path = e.file_path
      where c.project_id = ${l.project_id} and c.state = 'released' order by c.base_number, e.format`;
  });
}
