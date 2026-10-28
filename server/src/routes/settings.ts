import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { badRequest } from '../lib/errors';
import { DEFAULT_SETTINGS, SettingsService, type SettingsMap } from '../services/settings';
import { ldapTest } from '../lib/ldap';
import { audit } from '../services/audit';

export default async function settingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, settings } = ctx;

  /** Für alle angemeldeten Benutzer sichtbare Einstellungen */
  app.get('/settings/public', async (req) => {
    requireUser(req);
    const storage = await settings.get('storage');
    return {
      company: await settings.get('company'),
      presence: await settings.get('presence'),
      projectNumbers: await settings.get('projectNumbers'),
      defaultModules: await settings.get('defaultModules'),
      cadMask: await settings.get('cadMask'),
      storage: { mode: storage.mode, networkPath: storage.networkPath, projectFolders: storage.projectFolders },
      time: await settings.get('time'),
      aiEnabled: (await settings.get('ai')).enabled,
      mailEnabled: (await settings.get('mail')).enabled,
      officeEnabled: Boolean(ctx.config.officeUrl),
      turnUrls: ctx.config.turnUrls,
    };
  });

  app.get('/settings', async (req) => {
    requireRole(req, 'admin');
    const all = await settings.all();
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(all) as (keyof SettingsMap)[]) out[k] = SettingsService.redact(k, all[k]);
    return out;
  });

  app.put('/settings/:key', async (req) => {
    const u = requireRole(req, 'admin');
    const { key } = parse(z.object({ key: z.string() }), req.params);
    if (!(key in DEFAULT_SETTINGS)) throw badRequest('Unbekannte Einstellung');
    const k = key as keyof SettingsMap;
    const body = parse(z.record(z.string(), z.unknown()).or(z.array(z.unknown())), req.body);
    const defaults = DEFAULT_SETTINGS[k];
    const value = Array.isArray(defaults) ? body : { ...(defaults as object), ...(await settings.get(k) as object), ...(body as object) };
    const merged = await settings.mergeSecrets(k, value as SettingsMap[typeof k]);
    await settings.set(k, merged);
    await audit(sql, u, { action: 'settings.update', entityType: 'settings', entityId: key, summary: `Einstellung "${key}" geändert`,
      details: SettingsService.redact(k, merged) });
    return { ok: true };
  });

  app.post('/settings/ldap/test', async (req) => {
    requireRole(req, 'admin');
    const s = await settings.mergeSecrets('ldap', { ...(await settings.get('ldap')), ...(req.body as object) });
    try {
      return { ok: true, message: await ldapTest(s) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });
}
