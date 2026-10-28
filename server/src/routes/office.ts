/**
 * Büro-Dokumente im Browser (Kapitel 12) über Collabora Online / LibreOffice Online per WOPI.
 * AperioPlan ist der WOPI-Host: Collabora lädt und speichert die Datei über /api/wopi/files/<id>.
 */
import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, notFound, unauthorized } from '../lib/errors';
import { randomToken } from '../lib/crypto';
import { audit } from '../services/audit';
import { safeName, storeFile } from '../services/files';
import { emptyDocx, emptyXlsx } from '../services/officeTemplates';
import { posix } from 'node:path';

interface Claims { f: string; u: string; n: string; w: boolean; e: number }

export async function internalSecret(ctx: AppContext) {
  const s = await ctx.settings.get('security');
  if (s.internalSecret) return s.internalSecret;
  const secret = randomToken(32);
  await ctx.settings.set('security', { internalSecret: secret });
  return secret;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export async function signToken(ctx: AppContext, c: Claims) {
  const body = b64(JSON.stringify(c));
  return `${body}.${createHmac('sha256', await internalSecret(ctx)).update(body).digest('base64url')}`;
}

export async function verifyToken(ctx: AppContext, token: string): Promise<Claims> {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw unauthorized('Ungültiges Zugriffstoken');
  const expected = createHmac('sha256', await internalSecret(ctx)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized('Ungültiges Zugriffstoken');
  const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
  if (c.e < Date.now()) throw unauthorized('Zugriffstoken abgelaufen');
  return c;
}

let discoveryCache: { at: number; map: Map<string, string> } | null = null;
async function discovery(officeUrl: string) {
  if (discoveryCache && Date.now() - discoveryCache.at < 3600_000) return discoveryCache.map;
  const res = await fetch(`${officeUrl.replace(/\/$/, '')}/hosting/discovery`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw badRequest('Office-Server nicht erreichbar');
  const xml = await res.text();
  const map = new Map<string, string>();
  for (const m of xml.matchAll(/<action[^>]*?ext="(\w+)"[^>]*?urlsrc="([^"]+)"/g)) if (!map.has(m[1]!)) map.set(m[1]!, m[2]!);
  for (const m of xml.matchAll(/<action[^>]*?urlsrc="([^"]+)"[^>]*?ext="(\w+)"/g)) if (!map.has(m[2]!)) map.set(m[2]!, m[1]!);
  discoveryCache = { at: Date.now(), map };
  return map;
}

export default async function officeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage, config } = ctx;

  /** Sitzung zum Bearbeiten im Browser vorbereiten */
  app.get('/office/:id/session', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    if (!config.officeUrl) throw badRequest('Kein Office-Server eingerichtet (OFFICE_URL)');
    const [f] = await sql<{ name: string; project_id: string | null; locked_by: string | null }[]>`select name, project_id, locked_by from files where id = ${id}`;
    if (!f) throw notFound();
    const access = f.project_id ? await projectAccess(sql, u, f.project_id) : null;
    const ext = f.name.split('.').pop()!.toLowerCase();
    const urlsrc = (await discovery(config.officeInternalUrl || config.officeUrl)).get(ext);
    if (!urlsrc) throw badRequest(`Dateityp .${ext} wird vom Office-Server nicht unterstützt`);
    const writable = Boolean(access?.canEdit) && (!f.locked_by || f.locked_by === u.id);
    const ttl = 10 * 3600_000;
    const token = await signToken(ctx, { f: id, u: u.id, n: u.displayName, w: writable, e: Date.now() + ttl });
    const wopiSrc = `${(config.officeWopiUrl || config.publicUrl).replace(/\/$/, '')}/api/wopi/files/${id}`;
    const action = `${urlsrc.replace(/[?&]$/, '')}${urlsrc.includes('?') ? '&' : '?'}WOPISrc=${encodeURIComponent(wopiSrc)}&lang=${u.locale}`;
    return { action, accessToken: token, accessTokenTtl: Date.now() + ttl, name: f.name, writable };
  });

  /** Neues leeres Dokument direkt im Projektordner anlegen und gleich im Browser öffnen */
  app.post('/projects/:id/files/new-document', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ folder: z.string().max(500).default(''), name: z.string().trim().min(1).max(150), kind: z.enum(['docx', 'xlsx']) }), req.body);
    const p = await projectAccess(sql, u, id, 'edit');
    if (!p.folder_path) throw badRequest('Projekt hat keinen Ordner');
    const name = `${safeName(b.name.replace(/\.(docx|xlsx)$/i, ''))}.${b.kind}`;
    const path = posix.join(p.folder_path, b.folder.replace(/^\/+|\.\./g, ''), name);
    if (await storage.stat(path)) throw badRequest('Eine Datei mit diesem Namen gibt es dort schon');
    const f = await storeFile(ctx, { projectId: id, path, stream: Readable.from([b.kind === 'docx' ? emptyDocx() : emptyXlsx()]), userId: u.id, via: 'Neues Dokument' });
    ctx.hub.publish(`project:${id}`, 'files.changed', {});
    return { id: f.id, name, path };
  });

  // ------------------------------------------------ WOPI-Schnittstelle (wird vom Office-Server aufgerufen)
  const claims = async (q: unknown) => verifyToken(ctx, parse(z.object({ access_token: z.string() }), q).access_token);

  app.get('/wopi/files/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const c = await claims(req.query);
    if (c.f !== id) throw unauthorized();
    const [f] = await sql<{ name: string; size: number; updated_at: Date; sha256: string | null; version: number }[]>`select name, size::float as size, updated_at, sha256, version from files where id = ${id}`;
    if (!f) throw notFound();
    return {
      BaseFileName: f.name, Size: f.size, OwnerId: 'aperioplan', UserId: c.u, UserFriendlyName: c.n, Version: String(f.version),
      LastModifiedTime: new Date(f.updated_at).toISOString(), UserCanWrite: c.w, SupportsUpdate: c.w, SupportsLocks: false,
      UserCanNotWriteRelative: true, DisablePrint: false, HidePrintOption: false,
    };
  });

  app.get('/wopi/files/:id/contents', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const c = await claims(req.query);
    if (c.f !== id) throw unauthorized();
    const [f] = await sql<{ path: string }[]>`select path from files where id = ${id}`;
    if (!f) throw notFound();
    reply.header('content-type', 'application/octet-stream');
    return reply.send(storage.read(f.path));
  });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/wopi/files/:id/contents', async (req) => {
    const { id } = parse(idParam, req.params);
    const c = await claims(req.query);
    if (c.f !== id || !c.w) throw unauthorized('Nur Lesezugriff');
    const [f] = await sql<{ path: string; project_id: string | null }[]>`select path, project_id from files where id = ${id}`;
    if (!f) throw notFound();
    const body = req.body as Buffer;
    const saved = await storeFile(ctx, { projectId: f.project_id, path: f.path, stream: Readable.from([body]), userId: c.u, via: 'Office im Browser' });
    const [u] = await sql<{ id: string; display_name: string }[]>`select id, display_name from users where id = ${c.u}`;
    await audit(sql, u ? { id: u.id, displayName: u.display_name } as never : null, { action: 'file.office_save', entityType: 'file', entityId: id, projectId: f.project_id,
      summary: `${saved.name} im Browser bearbeitet (Version ${saved.version})` });
    if (f.project_id) ctx.hub.publish(`project:${f.project_id}`, 'files.changed', {});
    return { LastModifiedTime: new Date().toISOString() };
  });
}
