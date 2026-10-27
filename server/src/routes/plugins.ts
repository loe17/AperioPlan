/**
 * Entwickler-Schnittstelle (Kapitel 8): Erweiterungen als Plugin-Ordner mit manifest.json.
 * Ein Plugin kann als zusätzlicher Reiter in Projekten und/oder als eigene Seite erscheinen.
 * Es läuft im Browser in einem eigenen Rahmen und nutzt die normale REST-API.
 */
import type { FastifyInstance } from 'fastify';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { audit } from '../services/audit';

export interface PluginManifest {
  id: string; name: string; version: string; description?: string; author?: string;
  projectTab?: { label: string; icon?: string; entry: string };
  page?: { label: string; icon?: string; entry: string };
}

export const pluginsDir = () => resolve(process.env.PLUGINS_DIR ?? './data/plugins');

export async function loadManifests(): Promise<PluginManifest[]> {
  const dir = pluginsDir();
  if (!existsSync(dir)) return [];
  const out: PluginManifest[] = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name, 'manifest.json');
    if (!existsSync(p)) continue;
    try {
      const m = JSON.parse(await readFile(p, 'utf8')) as PluginManifest;
      if (m.id === name) out.push(m);
    } catch { /* fehlerhaftes Manifest überspringen */ }
  }
  return out;
}

export default async function pluginRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/plugins', async (req) => {
    const u = requireUser(req);
    const all = await loadManifests();
    const { enabled } = await ctx.settings.get('plugins');
    return all.map((m) => ({ ...m, enabled: enabled.includes(m.id) })).filter((m) => m.enabled || u.role === 'admin');
  });

  app.put('/plugins/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const s = await ctx.settings.get('plugins');
    const next = enabled ? [...new Set([...s.enabled, id])] : s.enabled.filter((x) => x !== id);
    await ctx.settings.set('plugins', { enabled: next });
    await audit(ctx.sql, u, { action: 'plugin.toggle', entityType: 'plugin', entityId: id, summary: `Plugin ${id} ${enabled ? 'aktiviert' : 'deaktiviert'}` });
    return { ok: true };
  });
}

/** Plugin-Dateien unter /plugins/<id>/… ausliefern (nur aktivierte Plugins) */
export async function registerPluginStatic(app: FastifyInstance, ctx: AppContext) {
  const dir = pluginsDir();
  if (!existsSync(dir)) return;
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      const id = req.url.split('/')[2];
      const { enabled } = await ctx.settings.get('plugins');
      if (!id || !enabled.includes(id)) return reply.status(404).send('Plugin nicht aktiv');
    });
    await scope.register(fastifyStatic, { root: dir, prefix: '/plugins/', decorateReply: false });
  });
}
