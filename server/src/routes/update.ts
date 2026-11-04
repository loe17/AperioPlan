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
/** Frühe Testfassungen, die noch „1.0“/„1.1“ hießen – inhaltlich älter als 0.1.x, daher nie anbieten */
const LEGACY = new Set(['1.0.0', '1.1.0']);
/** Ab dieser Version sind alle Datenbank-Änderungen nur noch Ergänzungen – ältere Stände lassen sich gefahrlos installieren */
export const MIN_INSTALLABLE = '0.2.0';

/** Prüft ein Wechselziel: ist es älter als die laufende Version, und ist es überhaupt erlaubt? */
export function checkTarget(ref: string, current: string, confirmOlder: boolean): { older: boolean } {
  const target = ref.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(target)) return { older: false }; // Zweig, z. B. main
  if (LEGACY.has(target)) throw badRequest('Die frühen Testfassungen 1.0 und 1.1 lassen sich nicht installieren.');
  const older = cmp(target, current) < 0;
  if (older && cmp(target, MIN_INSTALLABLE) < 0) throw badRequest(`Versionen vor ${MIN_INSTALLABLE} lassen sich nicht installieren.`);
  if (older && !confirmOlder) throw badRequest('Bitte bestätigen, dass eine ältere Version installiert werden soll.');
  return { older };
}

type Version = { version: string; ref: string; name: string; notes: string; url: string | null; publishedAt: string | null; prerelease: boolean };

async function listVersions(repo: string): Promise<{ versions: Version[]; source: 'release' | 'tag' | 'main' }> {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'AperioPlan' };
  const ok = (v: string) => /^\d+\.\d+\.\d+$/.test(v) && !LEGACY.has(v) && cmp(v, MIN_INSTALLABLE) >= 0;
  const rel = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers, signal: AbortSignal.timeout(10_000) });
  if (rel.ok) {
    const list = (await rel.json()) as { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string | null; draft: boolean; prerelease: boolean }[];
    const versions = list.filter((r) => !r.draft && ok(r.tag_name.replace(/^v/, '')))
      .map((r) => ({ version: r.tag_name.replace(/^v/, ''), ref: r.tag_name, name: r.name || r.tag_name, notes: r.body ?? '', url: r.html_url, publishedAt: r.published_at, prerelease: r.prerelease }));
    if (versions.length) return { versions: versions.sort((a, b) => cmp(b.version, a.version)), source: 'release' };
  }
  const tags = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, { headers, signal: AbortSignal.timeout(10_000) });
  if (tags.ok) {
    const list = (await tags.json()) as { name: string }[];
    const versions = list.filter((t) => ok(t.name.replace(/^v/, ''))).map((t) => ({ version: t.name.replace(/^v/, ''), ref: t.name, name: t.name, notes: '', url: null, publishedAt: null, prerelease: false }));
    if (versions.length) return { versions: versions.sort((a, b) => cmp(b.version, a.version)), source: 'tag' };
  }
  const main = await fetch(`https://raw.githubusercontent.com/${repo}/main/shared/src/version.ts`, { signal: AbortSignal.timeout(10_000) });
  if (main.ok) {
    const v = /version: '(\d+\.\d+\.\d+)'/.exec(await main.text())?.[1];
    if (v) return { versions: [{ version: v, ref: 'main', name: `Entwicklungsstand ${v}`, notes: '', url: null, publishedAt: null, prerelease: false }], source: 'main' };
  }
  return { versions: [], source: 'release' };
}

export default async function updateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/system/update/check', async (req) => {
    requireRole(req, 'admin');
    try {
      const { versions, source } = await listVersions(ctx.config.updateRepo);
      const latest = versions.find((v) => !v.prerelease) ?? versions[0];
      if (!latest) return { current: APP_VERSION, latest: null, updateAvailable: false, error: 'Keine Versionsinformation gefunden' };
      return { current: APP_VERSION, latest: latest.version, ref: latest.ref, notes: latest.notes, url: latest.url, publishedAt: latest.publishedAt,
        updateAvailable: cmp(latest.version, APP_VERSION) > 0, source };
    } catch (e) {
      return { current: APP_VERSION, latest: null, updateAvailable: false, error: `GitHub nicht erreichbar: ${(e as Error).message}` };
    }
  });

  /** Alle installierbaren Versionen – auch ältere – mit Kennzeichnung neuer/aktuell/älter */
  app.get('/system/update/versions', async (req) => {
    requireRole(req, 'admin');
    try {
      const { versions, source } = await listVersions(ctx.config.updateRepo);
      const history = await ctx.sql<{ at: Date; summary: string; user: string | null }[]>`select at, summary, user_name as user
        from audit_log where action = 'system.update' order by at desc limit 20`;
      return { current: APP_VERSION, source, minimum: MIN_INSTALLABLE,
        versions: versions.map((v) => ({ ...v, relation: cmp(v.version, APP_VERSION) > 0 ? 'newer' : cmp(v.version, APP_VERSION) === 0 ? 'current' : 'older' })), history };
    } catch (e) {
      return { current: APP_VERSION, versions: [], history: [], error: `GitHub nicht erreichbar: ${(e as Error).message}` };
    }
  });

  app.post('/system/update', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ ref: z.string().regex(/^[\w.\-/]+$/).default('main'), backupFirst: z.boolean().default(true), confirmOlder: z.boolean().default(false) }), req.body ?? {});
    const trigger = ctx.config.updateTriggerFile;
    if (!trigger) throw badRequest('Der Updater-Dienst ist nicht eingerichtet (nur bei Docker-Installation verfügbar)');
    const { older } = checkTarget(b.ref, APP_VERSION, b.confirmOlder);
    // Vor dem Wechsel auf eine ältere Version immer sichern – auch wenn das Häkchen fehlt
    if (b.backupFirst || older) await runBackup(ctx, { reason: `vor ${older ? 'Wechsel zurück' : 'Aktualisierung'} auf ${b.ref}` });
    await writeFile(trigger, b.ref);
    await audit(ctx.sql, u, { action: 'system.update', entityType: 'system', summary: `${older ? 'Wechsel auf ältere Version' : 'Aktualisierung auf'} ${b.ref} angestoßen (vorher ${APP_VERSION})` });
    return { ok: true, older };
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
