/**
 * Aktualisierung per Klick (Kapitel 4): neue Version auf GitHub prüfen und den Updater-Dienst anstoßen.
 * Der Updater (deploy/updater.sh) baut nur das Programm neu – Daten, Dateien und Einstellungen bleiben erhalten.
 */
import type { FastifyInstance } from 'fastify';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { APP_VERSION } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireRole } from '../lib/auth';
import { badRequest } from '../lib/errors';
import { audit } from '../services/audit';
import { runBackup } from '../services/backup';

const cmp = (a: string, b: string) => {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export default async function updateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/system/update/check', async (req) => {
    requireRole(req, 'admin');
    const repo = ctx.config.updateRepo;
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'AperioPlan' };
    try {
      const rel = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(10_000) });
      if (rel.ok) {
        const j = await rel.json();
        return { current: APP_VERSION, latest: String(j.tag_name).replace(/^v/, ''), ref: j.tag_name, notes: j.body ?? '', url: j.html_url, publishedAt: j.published_at,
          updateAvailable: cmp(String(j.tag_name), APP_VERSION) > 0, source: 'release' };
      }
      const tags = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=30`, { headers, signal: AbortSignal.timeout(10_000) });
      if (tags.ok) {
        const list = (await tags.json()) as { name: string }[];
        const versions = list.map((t) => t.name).filter((n) => /^v?\d+\.\d+\.\d+$/.test(n)).sort((a, b) => cmp(b, a));
        if (versions.length) return { current: APP_VERSION, latest: versions[0]!.replace(/^v/, ''), ref: versions[0], notes: '', updateAvailable: cmp(versions[0]!, APP_VERSION) > 0, source: 'tag' };
      }
      const main = await fetch(`https://raw.githubusercontent.com/${repo}/main/shared/src/version.ts`, { signal: AbortSignal.timeout(10_000) });
      if (main.ok) {
        const text = await main.text();
        const v = /version: '(\d+\.\d+\.\d+)'/.exec(text)?.[1];
        if (v) return { current: APP_VERSION, latest: v, ref: 'main', notes: '', updateAvailable: cmp(v, APP_VERSION) > 0, source: 'main' };
      }
      return { current: APP_VERSION, latest: null, updateAvailable: false, error: 'Keine Versionsinformation gefunden' };
    } catch (e) {
      return { current: APP_VERSION, latest: null, updateAvailable: false, error: `GitHub nicht erreichbar: ${(e as Error).message}` };
    }
  });

  app.post('/system/update', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ ref: z.string().regex(/^[\w.\-/]+$/).default('main'), backupFirst: z.boolean().default(true) }), req.body ?? {});
    const trigger = ctx.config.updateTriggerFile;
    if (!trigger) throw badRequest('Der Updater-Dienst ist nicht eingerichtet (nur bei Docker-Installation verfügbar)');
    if (b.backupFirst) await runBackup(ctx, { reason: `vor Aktualisierung auf ${b.ref}` });
    await writeFile(trigger, b.ref);
    await audit(ctx.sql, u, { action: 'system.update', entityType: 'system', summary: `Aktualisierung auf ${b.ref} angestoßen (aktuell ${APP_VERSION})` });
    return { ok: true };
  });

  app.get('/system/update/status', async (req) => {
    requireRole(req, 'admin');
    const trigger = ctx.config.updateTriggerFile;
    if (!trigger) return { available: false };
    const dir = dirname(trigger);
    const status = await readFile(join(dir, 'status.json'), 'utf8').then(JSON.parse).catch(() => null);
    const log = await readFile(join(dir, 'log.txt'), 'utf8').catch(() => '');
    return { available: true, status, log: log.slice(-8000), version: APP_VERSION };
  });
}
