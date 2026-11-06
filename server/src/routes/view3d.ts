import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { VIEW3D_NATIVE, extOf, isView3dDirect } from '@aperio/shared';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { extractPreview } from '../services/cadPreview';
import { sendStoredFile } from './files';
import { windowsPath } from './projects';

const PREVIEW_DIR = '.aperio/view3d';

/**
 * 3D-Ansicht von Dateien im selben Fenster. Austauschformate (STEP, STL, glTF …) zeigt der Browser direkt.
 * Native CAD-Dateien wandelt ein CAD-Arbeitsplatz mit dem passenden Programm nach STEP um
 * (Umwandlungsdienst der CAD-Bridge); bis dahin gibt es das in der Datei gespeicherte Vorschaubild.
 */
export default async function view3dRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  /** Welche Arbeitsplätze wandeln gerade um (aus den Abrufen der letzten Minuten) */
  const workers = new Map<string, { formats: string[]; programs: string[]; seen: number }>();
  const onlineWorkers = () => [...workers.entries()].filter(([, w]) => Date.now() - w.seen < 3 * 60_000).map(([name, w]) => ({ name, ...w }));

  async function loadFile(u: AuthUser, id: string) {
    const [f] = await sql<{ id: string; path: string; name: string; project_id: string | null; version: number; size: string }[]>`
      select id, path, name, project_id, version, size from files where id = ${id}`;
    if (!f) throw notFound('Datei nicht gefunden');
    if (f.project_id) await projectAccess(sql, u, f.project_id);
    else if (u.role !== 'admin') throw notFound('Datei nicht gefunden');
    return f;
  }

  app.get('/files/:id/view3d', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const f = await loadFile(u, id);
    const ext = extOf(f.name);
    if (isView3dDirect(f.name)) return { kind: 'direct', name: f.name, format: ext };
    const native = VIEW3D_NATIVE[ext];
    if (!native) throw badRequest('Für diese Datei gibt es keine 3D-Ansicht.');
    const [c] = await sql<{ status: string; error: string | null; requested_at: Date; completed_at: Date | null; worker: string | null }[]>`
      select status, error, requested_at, completed_at, worker from view_conversions where file_id = ${id} and version = ${f.version}`;
    const able = onlineWorkers().filter((w) => w.formats.includes(ext));
    return {
      kind: 'native', name: f.name, format: ext, label: native.label, program: native.program, version: f.version,
      conversion: c ? { status: c.status, error: c.error, requestedAt: c.requested_at, completedAt: c.completed_at, worker: c.worker } : null,
      workers: able.map((w) => w.name), anyWorker: onlineWorkers().length > 0,
    };
  });

  /** Umwandlung anstoßen (je Dateiversion einmal; fehlgeschlagene neu einreihen) */
  app.post('/files/:id/view3d/convert', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const f = await loadFile(u, id);
    const ext = extOf(f.name);
    if (!VIEW3D_NATIVE[ext]) throw badRequest('Diese Datei muss nicht umgewandelt werden.');
    await sql`insert into view_conversions (file_id, version, format, requested_by) values (${id}, ${f.version}, ${ext}, ${u.id})
      on conflict (file_id, version) do update set status = 'queued', error = null, requested_at = now(), requested_by = ${u.id}
      where view_conversions.status = 'failed'`;
    return { ok: true };
  });

  app.get('/files/:id/view3d/model', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const f = await loadFile(u, id);
    const [c] = await sql<{ result_path: string | null }[]>`select result_path from view_conversions where file_id = ${id} and version = ${f.version} and status = 'done'`;
    if (!c?.result_path) throw notFound('Noch nicht umgewandelt');
    return sendStoredFile(ctx, reply, c.result_path, `${f.name.replace(/\.[^.]+(\.\d+)?$/, '')}.step`, true);
  });

  /** Vorschaubild aus der Datei (zwischengespeichert je Version) */
  app.get('/files/:id/view3d/preview', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const f = await loadFile(u, id);
    const base = `${PREVIEW_DIR}/${id}-v${f.version}`;
    for (const t of ['png', 'jpg'] as const) {
      if ((await storage.stat(`${base}.${t}`))?.isFile()) {
        reply.header('cache-control', 'private, max-age=86400');
        return sendStoredFile(ctx, reply, `${base}.${t}`, `vorschau.${t}`, true);
      }
    }
    if ((await storage.stat(`${base}.none`))?.isFile()) throw notFound('Kein Vorschaubild in der Datei');
    if (Number(f.size) > 300 * 1024 * 1024) throw notFound('Datei zu groß für ein Vorschaubild');
    const chunks: Buffer[] = [];
    for await (const ch of storage.read(f.path)) chunks.push(ch as Buffer);
    const img = extractPreview(Buffer.concat(chunks));
    if (!img) { await storage.write(`${base}.none`, Readable.from(Buffer.alloc(0))); throw notFound('Kein Vorschaubild in der Datei'); }
    const ext = img.type === 'png' ? 'png' : 'jpg';
    await storage.write(`${base}.${ext}`, Readable.from(img.data));
    reply.header('cache-control', 'private, max-age=86400');
    return sendStoredFile(ctx, reply, `${base}.${ext}`, `vorschau.${ext}`, true);
  });

  // ------------------------------------------------ Umwandlungsdienst (CAD-Bridge auf einem CAD-Arbeitsplatz)
  /** Nächsten Auftrag holen, den dieser Arbeitsplatz kann und dessen Benutzer die Datei sehen darf */
  app.post('/view3d/conversions/claim', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({ worker: z.string().trim().min(1).max(120), formats: z.array(z.string().max(12)).max(40), programs: z.array(z.string().max(60)).max(20).default([]) }), req.body);
    workers.set(b.worker, { formats: b.formats.map((x) => x.toLowerCase()), programs: b.programs, seen: Date.now() });
    const candidates = await sql<{ id: string; file_id: string; project_id: string | null; name: string; path: string; format: string; version: number; current: number }[]>`
      select c.id, c.file_id, f.project_id, f.name, f.path, c.format, c.version, f.version as current from view_conversions c join files f on f.id = c.file_id
      where (c.status = 'queued' or (c.status = 'running' and c.started_at < now() - interval '30 minutes')) and c.format = any(${b.formats.map((x) => x.toLowerCase())})
      order by c.requested_at limit 25`;
    for (const c of candidates) {
      if (c.project_id) { try { await projectAccess(sql, u, c.project_id); } catch { continue; } } else if (u.role !== 'admin') continue;
      const [job] = await sql`update view_conversions set status = 'running', started_at = now(), worker = ${b.worker}
        where id = ${c.id} and (status = 'queued' or (status = 'running' and started_at < now() - interval '30 minutes')) returning id`;
      if (!job) continue;
      // Baugruppen brauchen ihre Teile: liegt die Ablage im Netzwerk, öffnet der Arbeitsplatz die Datei direkt dort
      const networkPath = c.version === c.current ? windowsPath(await ctx.settings.get('storage'), c.path) : null;
      return { job: { id: c.id, fileName: c.name, format: c.format, downloadUrl: `/api/files/${c.file_id}/download?version=${c.version}`, networkPath } };
    }
    return { job: null };
  });

  app.post('/view3d/conversions/:id/complete', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [c] = await sql<{ file_id: string; version: number; status: string }[]>`select file_id, version, status from view_conversions where id = ${id}`;
    if (!c) throw notFound();
    await loadFile(u, c.file_id);
    const target = `${PREVIEW_DIR}/${c.file_id}-v${c.version}.step`;
    let saved = false;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      await storage.write(target, part.file);
      saved = true;
    }
    if (!saved) throw badRequest('Keine Datei empfangen');
    await sql`update view_conversions set status = 'done', result_path = ${target}, error = null, completed_at = now() where id = ${id}`;
    ctx.hub.publish('global', 'view3d.converted', { fileId: c.file_id });
    return { ok: true };
  });

  app.post('/view3d/conversions/:id/fail', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ error: z.string().max(2000) }), req.body);
    const [c] = await sql<{ file_id: string }[]>`select file_id from view_conversions where id = ${id}`;
    if (!c) throw notFound();
    await loadFile(u, c.file_id);
    await sql`update view_conversions set status = 'failed', error = ${b.error}, completed_at = now() where id = ${id}`;
    ctx.hub.publish('global', 'view3d.converted', { fileId: c.file_id });
    return { ok: true };
  });

  /** CAD-Teil der CAD-Bridge → Datei-ID für die 3D-Ansicht */
  app.get('/view3d/cad/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [r] = await sql<{ file_id: string | null; project_id: string; name: string | null }[]>`
      select f.id as file_id, c.project_id, f.name from cad_items c left join files f on f.path = c.file_path where c.id = ${id}`;
    if (!r) throw notFound();
    await projectAccess(sql, u, r.project_id);
    if (!r.file_id) throw notFound('Zu diesem Teil ist noch keine Datei eingecheckt.');
    return { fileId: r.file_id, name: r.name };
  });

  /** Für die Einstellungen: verbundene Umwandlungsdienste */
  app.get('/view3d/workers', async (req) => {
    requireUser(req);
    return onlineWorkers().map((w) => ({ name: w.name, formats: w.formats, programs: w.programs, lastSeen: new Date(w.seen) }));
  });
}
