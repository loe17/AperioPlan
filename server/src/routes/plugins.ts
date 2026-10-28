/**
 * Entwickler-Schnittstelle (Kapitel 8): Erweiterungen als Plugin-Ordner mit manifest.json.
 * Ein Plugin kann als zusätzlicher Reiter in Projekten und/oder als eigene Seite erscheinen.
 * Es läuft im Browser in einem eigenen Rahmen und nutzt die normale REST-API.
 */
import type { FastifyInstance } from 'fastify';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { audit } from '../services/audit';

export interface PluginManifest {
  id: string; name: string; version: string; description?: string; author?: string;
  /** für den App-Store */
  category?: string; features?: string[];
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
  if (!existsSync(dir)) await mkdir(dir, { recursive: true }).catch(() => {});
  if (!existsSync(dir)) return;
  // Hilfsskript für Plugins: Aussehen von AperioPlan übernehmen, Schnittstelle und Datenablage
  app.get('/plugin-sdk.js', async (_req, reply) => reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(PLUGIN_SDK));
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      const id = req.url.split('/')[2];
      const { enabled } = await ctx.settings.get('plugins');
      if (!id || !enabled.includes(id)) return reply.status(404).send('Plugin nicht aktiv');
    });
    await scope.register(fastifyStatic, { root: dir, prefix: '/plugins/', decorateReply: false });
  });
}

const PLUGIN_SDK = `/* AperioPlan Plugin-SDK – einbinden mit <script src="/plugin-sdk.js"></script> */
(function () {
  var params = new URLSearchParams(location.search);
  var plugin = location.pathname.split('/')[2];
  // Aussehen übernehmen: Stylesheets und Hell/Dunkel aus AperioPlan (gleiche Adresse, daher erlaubt)
  try {
    var pd = window.parent && window.parent !== window ? window.parent.document : null;
    if (pd) {
      pd.querySelectorAll('link[rel=stylesheet], style').forEach(function (n) { document.head.appendChild(n.cloneNode(true)); });
      var sync = function () { document.documentElement.dataset.theme = pd.documentElement.dataset.theme || 'light'; };
      sync(); new MutationObserver(sync).observe(pd.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      document.body && document.body.classList.add('plugin-body');
    }
  } catch (e) { /* eigenständig geöffnet */ }
  async function api(method, path, body) {
    var res = await fetch('/api' + path, { method: method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    var text = await res.text(); var json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((json && json.error) || res.statusText);
    return json;
  }
  function data(collection, scope) {
    var base = '/plugin-data/' + plugin + '/' + collection;
    scope = scope || 'shared';
    return {
      list: function () { return api('GET', base + '?scope=' + scope); },
      get: function (id) { return api('GET', base + '/' + id); },
      add: function (d) { return api('POST', base, { scope: scope, data: d }); },
      put: function (id, d) { return api('PUT', base + '/' + id, { data: d }); },
      remove: function (id) { return api('DELETE', base + '/' + id); },
    };
  }
  window.AperioPlan = {
    plugin: plugin, projectId: params.get('projectId'), api: api, data: data,
    me: function () { return api('GET', '/auth/me'); },
    get: function (p) { return api('GET', p); }, post: function (p, b) { return api('POST', p, b || {}); },
    toast: function (msg) { try { window.parent.dispatchEvent(new CustomEvent('aperio:warning', { detail: msg })); } catch (e) { alert(msg); } },
  };
})();`;
