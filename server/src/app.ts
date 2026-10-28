import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { config as defaultConfig, type Config } from './config';
import { createDb, migrate, type Sql } from './db';
import { Hub } from './lib/hub';
import { HttpError } from './lib/errors';
import { resolveUser } from './lib/auth';
import { forbidden } from './lib/errors';
import { TOOL_ROUTES } from '@aperio/shared';
import { SettingsService } from './services/settings';
import { Storage } from './services/storage';
import { Presence } from './services/presence';
import { bootstrap } from './services/bootstrap';
import type { AppContext } from './context';
import { routes } from './routes';
import { registerPluginStatic } from './routes/plugins';
import { initWebhooks } from './lib/webhooks';

export interface BuildOptions {
  sql?: Sql;
  config?: Partial<Config>;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = { ...defaultConfig, ...opts.config };
  const sql = opts.sql ?? createDb(config.databaseUrl);
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: true,
  });

  await migrate(sql, (m) => app.log.info(m));
  const hub = new Hub();
  const settings = new SettingsService(sql);
  const ctx: AppContext = {
    sql,
    hub,
    settings,
    config,
    storage: new Storage(config.storageRoot),
    presence: new Presence(sql, hub, settings),
  };
  await bootstrap(ctx, app.log);
  // weitere Speicherorte einbinden – und nach jeder Änderung der Einstellung neu
  const mountLocations = (st: { locations?: { id: string; path: string }[] }) => ctx.storage.setMounts(Object.fromEntries((st.locations ?? []).map((l) => [l.id, l.path])));
  mountLocations(await settings.get('storage'));
  settings.onChange = (key, value) => { if (key === 'storage') mountLocations(value as { locations: { id: string; path: string }[] }); };

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 * 1024, files: 50 } });
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.user = await resolveUser(sql, req);
    // Werkzeugrechte zentral prüfen: nicht freigeschaltete Werkzeuge sind auch über die Schnittstelle gesperrt.
    // Anwendungen, die im App-Store ausgeschaltet sind, stehen niemandem zur Verfügung.
    const u = req.user;
    if (u) {
      const { installed } = await ctx.settings.get('apps');
      u.tools = u.tools.filter((t) => installed.includes(t));
      const path = req.url.slice(4).split('?')[0]!;
      const hit = TOOL_ROUTES.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'));
      if (hit && !u.tools.includes(hit[1])) {
        throw forbidden(installed.includes(hit[1]) ? 'Dieses Werkzeug ist für Sie nicht freigeschaltet' : 'Diese Anwendung ist nicht installiert (App-Store)');
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message, code: err.code, details: (err as HttpError & { details?: unknown }).details });
    if (err instanceof ZodError) return reply.status(400).send({ error: err.message, code: 'validation' });
    const e = err as { statusCode?: number; message: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message, code: e.code });
    if (e.code === '23505') return reply.status(409).send({ error: 'Eintrag existiert bereits', code: 'conflict' });
    req.log.error(err);
    return reply.status(500).send({ error: 'Interner Fehler', code: 'internal' });
  });

  initWebhooks(ctx.settings);
  await app.register(async (api) => routes(api, ctx), { prefix: '/api' });
  await registerPluginStatic(app, ctx);

  // Web-Oberfläche ausliefern (Single-Page-App)
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, maxAge: '1h', setHeaders: (res, path) => { if (path.includes('/assets/')) res.header('cache-control', 'public, max-age=31536000, immutable'); else if (path.endsWith('.html')) res.header('cache-control', 'no-cache'); } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Nicht gefunden' });
      return reply.type('text/html').sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    ctx.presence.stop();
    if (!opts.sql) await sql.end({ timeout: 5 });
  });

  return { app, ctx };
}

