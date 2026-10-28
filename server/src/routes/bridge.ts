/**
 * Wächter der CAD- und PCB-Bridge: verbundene Arbeitsplätze, Versionsprüfung und
 * geführte Einrichtung (Installationspaket mit Serveradresse und persönlichem Zugangsschlüssel).
 */
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireTool, requireUser } from '../lib/auth';
import { forbidden, notFound } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import { writeZip } from '../lib/zip';
import { audit } from '../services/audit';
import { installerFiles, type BridgeKind } from '../services/bridgeInstaller';

/** Dateinamen der Pakete im Release bzw. im Download-Ordner */
export const BRIDGE_PACKAGES: Record<string, string> = {
  'cad-win': 'AperioPlan-CAD-Bridge-win-x64.zip',
  'pcb-win': 'AperioPlan-PCB-Bridge-win-x64.zip',
  'pcb-linux': 'AperioPlan-PCB-Bridge-linux-x64.tar.gz',
  'pcb-mac': 'AperioPlan-PCB-Bridge-osx-arm64.tar.gz',
};

const cmp = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0), pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export default async function bridgeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, config } = ctx;
  const downloadUrl = (file: string) => `/api/bridge/download/${encodeURIComponent(file)}`;

  /** Lebenszeichen eines Wächters beim Start und danach alle paar Minuten */
  app.post('/bridge/hello', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ kind: z.enum(['cad', 'pcb', 'export']), host: z.string().trim().min(1).max(120), os: z.string().max(80).default(''),
      version: z.string().max(40).default(''), appVersion: z.string().max(120).default('') }), req.body);
    await sql`insert into bridge_clients (user_id, kind, host, os, version, app_version, ip) values (${u.id}, ${b.kind}, ${b.host}, ${b.os}, ${b.version}, ${b.appVersion}, ${req.ip})
      on conflict (user_id, kind, host) do update set os = excluded.os, version = excluded.version, app_version = excluded.app_version, ip = excluded.ip, last_seen = now()`;
    const updateAvailable = Boolean(b.version) && cmp(b.version, APP_VERSION) < 0;
    const pkg = b.kind === 'pcb' ? (/linux/i.test(b.os) ? 'pcb-linux' : /mac|darwin|osx/i.test(b.os) ? 'pcb-mac' : 'pcb-win') : 'cad-win';
    return { ok: true, server: config.publicUrl, latestVersion: APP_VERSION, updateAvailable, downloadUrl: downloadUrl(BRIDGE_PACKAGES[pkg]!) };
  });

  /** Welche Arbeitsplätze sind verbunden? Administratoren sehen alle, sonst nur die eigenen. */
  app.get('/bridge/clients', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ kind: z.enum(['cad', 'pcb', 'export']).optional() }), req.query);
    const rows = await sql<{ lastSeen: Date; version: string }[]>`select c.id, c.kind, c.host, c.os, c.version, c.app_version as "appVersion", c.ip, c.first_seen as "firstSeen", c.last_seen as "lastSeen",
      c.user_id as "userId", u.display_name as "userName" from bridge_clients c join users u on u.id = c.user_id
      where true ${u.role === 'admin' ? sql`` : sql`and c.user_id = ${u.id}`} ${q.kind ? sql`and c.kind = ${q.kind}` : sql``} order by c.last_seen desc`;
    return rows.map((r) => ({ ...r, online: Date.now() - new Date(r.lastSeen).getTime() < 15 * 60_000, outdated: Boolean(r.version) && cmp(r.version, APP_VERSION) < 0 }));
  });

  app.delete('/bridge/clients/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [c] = await sql<{ user_id: string }[]>`select user_id from bridge_clients where id = ${id}`;
    if (!c) throw notFound();
    if (c.user_id !== u.id && u.role !== 'admin') throw forbidden();
    await sql`delete from bridge_clients where id = ${id}`;
    return { ok: true };
  });

  /** Stehen die Programmpakete auf dem Server bereit (sonst Download aus dem GitHub-Release)? */
  app.get('/bridge/info', async (req) => {
    requireUser(req);
    const local: Record<string, { size: number; modified: Date } | null> = {};
    for (const [k, f] of Object.entries(BRIDGE_PACKAGES)) {
      const p = join(config.downloadsDir, f);
      local[k] = existsSync(p) ? await stat(p).then((s) => ({ size: s.size, modified: s.mtime })) : null;
    }
    return { version: APP_VERSION, downloadsDir: config.downloadsDir, packages: local, releaseUrl: `https://github.com/${config.updateRepo}/releases/latest` };
  });

  /** Programmpaket: aus dem Download-Ordner des Servers, sonst Weiterleitung auf das GitHub-Release */
  app.get('/bridge/download/:file', async (req, reply) => {
    const { file } = parse(z.object({ file: z.string().regex(/^[\w.-]+$/) }), req.params);
    if (!Object.values(BRIDGE_PACKAGES).includes(file)) throw notFound();
    const p = join(config.downloadsDir, file);
    if (existsSync(p)) {
      reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${file}"`);
      return reply.send(createReadStream(p));
    }
    return reply.redirect(`https://github.com/${config.updateRepo}/releases/latest/download/${file}`);
  });

  /**
   * Installationspaket für diesen Arbeitsplatz: enthält Serveradresse und einen neuen persönlichen
   * Zugangsschlüssel. Der Schlüssel erscheint unter Einstellungen → API-Schlüssel und kann dort widerrufen werden.
   */
  app.post('/bridge/installer', async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(['cad', 'pcb']), platform: z.enum(['windows', 'linux', 'mac']).default('windows') }), req.body);
    const u = requireTool(req, b.kind);
    const token = `ap_${randomToken(32)}`;
    const name = `${b.kind === 'cad' ? 'CAD' : 'PCB'}-Wächter (Einrichtung ${new Date().toLocaleDateString('de-DE')})`;
    const [row] = await sql<{ id: string }[]>`insert into api_tokens (user_id, name, token_hash) values (${u.id}, ${name}, ${sha256(token)}) returning id`;
    await audit(sql, u, { action: 'token.create', entityType: 'api_token', entityId: row!.id, summary: `Installationspaket ${b.kind.toUpperCase()}-Bridge erzeugt (API-Schlüssel „${name}“)` });
    const files = installerFiles(b.kind as BridgeKind, b.platform, { server: config.publicUrl, token, user: u.displayName, version: APP_VERSION,
      packages: Object.fromEntries(Object.entries(BRIDGE_PACKAGES).map(([k, f]) => [k, downloadUrl(f)])) });
    const zip = writeZip(files.map((f) => ({ name: f.name, data: Buffer.from(f.text, 'utf8') })));
    const fname = `AperioPlan-${b.kind.toUpperCase()}-Bridge-Einrichtung${b.platform === 'windows' ? '' : `-${b.platform}`}.zip`;
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${fname}"`);
    return zip;
  });

}
