/** Verschlüsselte Sicherung: Liste, sofort sichern, herunterladen, Import mit Duplikat-Prüfung (Kapitel 3 und 13). */
import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { mkdir, stat, unlink } from 'node:fs/promises';

import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireRole } from '../lib/auth';
import { badRequest } from '../lib/errors';
import { audit } from '../services/audit';
import { analyzeImport, applyImport, backupPath, discardImport, listBackups, runBackup } from '../services/backup';

export default async function backupRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/backups', async (req) => {
    requireRole(req, 'admin');
    return listBackups(ctx);
  });

  app.post('/backups', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ includeFiles: z.boolean().optional() }), req.body ?? {});
    const r = await runBackup(ctx, { reason: `manuell (${u.displayName})`, includeFiles: b.includeFiles });
    await audit(ctx.sql, u, { action: 'backup.create', entityType: 'backup', summary: `Sicherung erstellt: ${r.file.split('/').pop()}` });
    return r;
  });

  app.get('/backups/:name', async (req, reply) => {
    requireRole(req, 'admin');
    const { name } = parse(z.object({ name: z.string() }), req.params);
    const p = await backupPath(ctx, name);
    const st = await stat(p).catch(() => null);
    if (!st) throw badRequest('Sicherung nicht gefunden');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', st.size);
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(createReadStream(p));
  });

  app.delete('/backups/:name', async (req) => {
    const u = requireRole(req, 'admin');
    const { name } = parse(z.object({ name: z.string() }), req.params);
    await unlink(await backupPath(ctx, name));
    await audit(ctx.sql, u, { action: 'backup.delete', entityType: 'backup', summary: `Sicherung gelöscht: ${name}` });
    return { ok: true };
  });

  /** Vorhandene Sicherung prüfen (vor dem Einspielen) */
  app.post('/backups/:name/analyze', async (req) => {
    requireRole(req, 'admin');
    const { name } = parse(z.object({ name: z.string() }), req.params);
    const b = parse(z.object({ passphrase: z.string().optional() }), req.body ?? {});
    return analyzeImport(ctx, await backupPath(ctx, name), b.passphrase || undefined);
  });

  /** Sicherungsdatei hochladen und prüfen (Felder: passphrase, file) */
  app.post('/backups/upload', async (req) => {
    requireRole(req, 'admin');
    let pass: string | undefined;
    let saved: string | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'passphrase') pass = String(part.value) || undefined;
      if (part.type === 'file') {
        await mkdir(join(ctx.config.backupDir, '.upload'), { recursive: true });
        saved = join(ctx.config.backupDir, '.upload', `upload-${Date.now()}.apb`);
        await pipeline(part.file, createWriteStream(saved));
      }
    }
    if (!saved) throw badRequest('Keine Datei empfangen');
    try {
      return await analyzeImport(ctx, saved, pass);
    } finally {
      await unlink(saved).catch(() => {});
    }
  });

  app.post('/backups/import/:id/apply', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = parse(z.object({ strategy: z.enum(['newer', 'local', 'backup']).default('newer'), overrides: z.record(z.string(), z.enum(['local', 'backup'])).default({}) }), req.body ?? {});
    const r = await applyImport(ctx, id, b.strategy, b.overrides);
    await audit(ctx.sql, u, { action: 'backup.import', entityType: 'backup', summary: `Sicherung eingespielt (${r.inserted} neu, ${r.updated} übernommen, ${r.files} Dateien)`, details: r });
    return r;
  });

  app.delete('/backups/import/:id', async (req) => {
    requireRole(req, 'admin');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await discardImport(ctx, id);
    return { ok: true };
  });
}

