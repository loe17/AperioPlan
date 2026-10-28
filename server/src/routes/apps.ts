/**
 * App-Store: mitgelieferte Anwendungen ein-/ausschalten, Plugins (Ordner mit manifest.json) installieren,
 * als ZIP hochladen und entfernen. Dazu eine einfache Datenablage, damit Plugins ohne eigenen Server Daten speichern können.
 */
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { APPS, TOOLS, appInfo, type Tool } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { readZip } from '../lib/zip';
import { audit } from '../services/audit';
import { loadManifests, pluginsDir, type PluginManifest } from './plugins';

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

export default async function appRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, settings } = ctx;

  /** Alle Anwendungen: mitgelieferte und Plugins. Nicht-Administratoren sehen nur eingeschaltete. */
  app.get('/apps', async (req) => {
    const u = requireUser(req);
    const { installed } = await settings.get('apps');
    const { enabled } = await settings.get('plugins');
    const builtin = APPS.map((a) => ({ ...a, source: 'builtin' as const, installed: installed.includes(a.id), allowed: u.tools.includes(a.id) }));
    const plugins = (await loadManifests()).map((m) => ({
      id: m.id, name: m.name, version: m.version, author: m.author ?? '', summary: m.description ?? '', features: m.features ?? [],
      category: m.category ?? 'Plugins', icon: m.page?.icon ?? m.projectTab?.icon ?? 'puzzle', route: m.page ? `/plugin/${m.id}` : undefined,
      projectTab: m.projectTab?.label ?? null, source: 'plugin' as const, installed: enabled.includes(m.id), allowed: enabled.includes(m.id),
    }));
    const all = [...builtin, ...plugins];
    return u.role === 'admin' ? all : all.filter((a) => a.installed);
  });

  async function setInstalled(id: string, on: boolean) {
    if ((TOOLS as readonly string[]).includes(id)) {
      const s = await settings.get('apps');
      const next = on ? [...new Set([...s.installed, id as Tool])] : s.installed.filter((x) => x !== id);
      await settings.set('apps', { installed: next });
      return 'builtin';
    }
    const manifests = await loadManifests();
    if (!manifests.some((m) => m.id === id)) throw notFound('Anwendung nicht gefunden');
    const s = await settings.get('plugins');
    await settings.set('plugins', { enabled: on ? [...new Set([...s.enabled, id])] : s.enabled.filter((x) => x !== id) });
    return 'plugin';
  }

  app.post('/apps/:id/install', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(z.object({ id: z.string().max(60) }), req.params);
    const b = parse(z.object({ grantAll: z.boolean().default(true) }), req.body ?? {});
    const info = appInfo(id);
    const { installed } = await settings.get('apps');
    // Vorausgesetzte Anwendungen werden mitinstalliert
    const deps: string[] = [];
    const collect = (x: string) => { for (const r of appInfo(x)?.requires ?? []) if (!installed.includes(r) && !deps.includes(r)) { collect(r); deps.push(r); } };
    collect(id);
    let kind: Awaited<ReturnType<typeof setInstalled>> = 'builtin';
    for (const x of [...deps, id]) {
      kind = await setInstalled(x, true);
      // Benutzer und Abteilungen mit eigener Werkzeugliste bekommen die neue Anwendung dazu (sonst sähe sie niemand)
      if (kind === 'builtin' && b.grantAll) {
        await sql`update users set tools = array_append(tools, ${x}) where tools is not null and not (${x} = any(tools))`;
        await sql`update teams set default_tools = array_append(default_tools, ${x}) where default_tools is not null and not (${x} = any(default_tools))`;
      }
    }
    await audit(sql, u, { action: 'app.install', entityType: 'app', entityId: id, summary: `Anwendung „${info?.name ?? id}“ installiert` });
    ctx.hub.publish('global', 'apps.changed', {});
    return { ok: true, alsoInstalled: deps };
  });

  app.post('/apps/:id/uninstall', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(z.object({ id: z.string().max(60) }), req.params);
    const { installed } = await settings.get('apps');
    const dependents = APPS.filter((a) => a.requires?.includes(id as Tool) && installed.includes(a.id));
    if (dependents.length) throw badRequest(`Wird noch gebraucht von: ${dependents.map((d) => d.name).join(', ')}`);
    await setInstalled(id, false);
    await audit(sql, u, { action: 'app.uninstall', entityType: 'app', entityId: id, summary: `Anwendung „${appInfo(id)?.name ?? id}“ ausgeschaltet (Daten bleiben erhalten)` });
    ctx.hub.publish('global', 'apps.changed', {});
    return { ok: true };
  });

  /**
   * Plugin als ZIP hochladen: manifest.json im Hauptordner oder in genau einem Unterordner.
   * Ein vorhandenes Plugin gleicher Kennung wird ersetzt (Aktualisierung).
   */
  app.post('/apps/upload', async (req) => {
    const u = requireRole(req, 'admin');
    const file = await req.file();
    if (!file) throw badRequest('Keine Datei');
    const buf = await file.toBuffer();
    if (buf.length > 50 * 1024 * 1024) throw badRequest('Das Paket ist größer als 50 MB');
    let entries;
    try { entries = readZip(buf); } catch { throw badRequest('Keine gültige ZIP-Datei'); }
    const mf = entries.find((e) => /^([^/]+\/)?manifest\.json$/.test(e.name));
    if (!mf) throw badRequest('Im Paket fehlt die Datei manifest.json');
    const prefix = mf.name.slice(0, mf.name.length - 'manifest.json'.length);
    let m: PluginManifest;
    try { m = JSON.parse(mf.data.toString('utf8')); } catch { throw badRequest('manifest.json ist kein gültiges JSON'); }
    if (!m.id || !PLUGIN_ID.test(m.id)) throw badRequest('Ungültige Kennung (id) im Manifest: nur Kleinbuchstaben, Ziffern und Bindestrich');
    if (!m.name || !m.version) throw badRequest('Im Manifest fehlen name oder version');
    if ((TOOLS as readonly string[]).includes(m.id)) throw badRequest('Diese Kennung ist für eine mitgelieferte Anwendung reserviert');
    const root = join(pluginsDir(), m.id);
    const tmp = `${root}.neu`;
    await rm(tmp, { recursive: true, force: true });
    for (const e of entries) {
      if (!e.name.startsWith(prefix) || e.name.endsWith('/')) continue;
      const rel = normalize(e.name.slice(prefix.length));
      if (rel.startsWith('..') || rel.startsWith('/') || rel.includes('\0')) throw badRequest(`Unzulässiger Pfad im Paket: ${e.name}`);
      const target = join(tmp, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, e.data);
    }
    await rm(root, { recursive: true, force: true });
    const { rename } = await import('node:fs/promises');
    await rename(tmp, root);
    await audit(sql, u, { action: 'app.upload', entityType: 'app', entityId: m.id, summary: `Plugin „${m.name}“ ${m.version} hochgeladen` });
    return { ok: true, manifest: m };
  });

  /** Plugin-Dateien löschen (nur Plugins, nicht mitgelieferte Anwendungen) */
  app.delete('/apps/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(z.object({ id: z.string().regex(PLUGIN_ID) }), req.params);
    if ((TOOLS as readonly string[]).includes(id)) throw badRequest('Mitgelieferte Anwendungen lassen sich nur ausschalten');
    const dir = join(pluginsDir(), id);
    if (!existsSync(dir)) throw notFound();
    await setInstalled(id, false).catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await audit(sql, u, { action: 'app.delete', entityType: 'app', entityId: id, summary: `Plugin ${id} entfernt` });
    return { ok: true };
  });

  // ------------------------------------------------ Datenablage für Plugins
  async function checkPlugin(plugin: string) {
    const { enabled } = await settings.get('plugins');
    if (!enabled.includes(plugin)) throw forbidden('Plugin ist nicht aktiv');
  }
  const pathParams = z.object({ plugin: z.string().regex(PLUGIN_ID), collection: z.string().regex(/^[\w-]{1,60}$/) });

  /** Liste: scope=shared (alle Benutzer) oder scope=user (nur eigene) */
  app.get('/plugin-data/:plugin/:collection', async (req) => {
    const u = requireUser(req);
    const p = parse(pathParams, req.params);
    const q = parse(z.object({ scope: z.enum(['shared', 'user']).default('shared'), limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query);
    await checkPlugin(p.plugin);
    return sql`select id, scope, owner_id as "ownerId", data, created_at as "createdAt", updated_at as "updatedAt" from plugin_data
      where plugin = ${p.plugin} and collection = ${p.collection} and scope = ${q.scope} ${q.scope === 'user' ? sql`and owner_id = ${u.id}` : sql``}
      order by created_at desc limit ${q.limit}`;
  });

  app.post('/plugin-data/:plugin/:collection', async (req) => {
    const u = requireUser(req);
    const p = parse(pathParams, req.params);
    const b = parse(z.object({ scope: z.enum(['shared', 'user']).default('shared'), data: z.record(z.string(), z.unknown()) }), req.body);
    await checkPlugin(p.plugin);
    if (JSON.stringify(b.data).length > 1_000_000) throw badRequest('Eintrag zu groß (max. 1 MB)');
    const [row] = await sql`insert into plugin_data (plugin, collection, scope, owner_id, data) values (${p.plugin}, ${p.collection}, ${b.scope}, ${u.id}, ${sql.json(b.data as never)})
      returning id, scope, owner_id as "ownerId", data, created_at as "createdAt", updated_at as "updatedAt"`;
    return row;
  });

  async function loadDoc(u: { id: string; role: string }, plugin: string, collection: string, id: string, write: boolean) {
    const [row] = await sql<{ id: string; scope: string; owner_id: string | null }[]>`select id, scope, owner_id from plugin_data where id = ${id} and plugin = ${plugin} and collection = ${collection}`;
    if (!row) throw notFound();
    if (row.scope === 'user' && row.owner_id !== u.id) throw notFound();
    // gemeinsame Einträge dürfen alle ändern; löschen nur Ersteller und Administratoren
    void write;
    return row;
  }

  app.get('/plugin-data/:plugin/:collection/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(pathParams.extend(idParam.shape), req.params);
    await checkPlugin(p.plugin);
    await loadDoc(u, p.plugin, p.collection, p.id, false);
    const [row] = await sql`select id, scope, owner_id as "ownerId", data, created_at as "createdAt", updated_at as "updatedAt" from plugin_data where id = ${p.id}`;
    return row;
  });

  app.put('/plugin-data/:plugin/:collection/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(pathParams.extend(idParam.shape), req.params);
    const b = parse(z.object({ data: z.record(z.string(), z.unknown()) }), req.body);
    await checkPlugin(p.plugin);
    await loadDoc(u, p.plugin, p.collection, p.id, true);
    if (JSON.stringify(b.data).length > 1_000_000) throw badRequest('Eintrag zu groß (max. 1 MB)');
    const [row] = await sql`update plugin_data set data = ${sql.json(b.data as never)}, updated_at = now() where id = ${p.id}
      returning id, scope, owner_id as "ownerId", data, created_at as "createdAt", updated_at as "updatedAt"`;
    return row;
  });

  app.delete('/plugin-data/:plugin/:collection/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(pathParams.extend(idParam.shape), req.params);
    await checkPlugin(p.plugin);
    const row = await loadDoc(u, p.plugin, p.collection, p.id, true);
    if (row.owner_id !== u.id && u.role !== 'admin') throw forbidden('Nur der Ersteller oder ein Administrator kann löschen');
    await sql`delete from plugin_data where id = ${p.id}`;
    return { ok: true };
  });
}
