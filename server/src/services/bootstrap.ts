import type { FastifyBaseLogger } from 'fastify';
import { mkdir } from 'node:fs/promises';
import type { AppContext } from '../context';
import { hashPassword } from '../lib/crypto';

/** Erststart: Administrator admin/admin anlegen (Passwortwechsel wird erzwungen). */
export async function bootstrap(ctx: AppContext, log: FastifyBaseLogger) {
  await mkdir(ctx.config.storageRoot, { recursive: true });
  await mkdir(ctx.config.backupDir, { recursive: true });
  const [row] = await ctx.sql<{ count: number }[]>`select count(*)::int as count from users`;
  const count = row?.count ?? 0;
  if (count === 0) {
    await ctx.sql`insert into users (username, display_name, password_hash, role, must_change_password)
      values ('admin', 'Administrator', ${await hashPassword('admin')}, 'admin', true)`;
    log.warn('Erstzugang angelegt: Benutzer "admin", Passwort "admin" – muss bei der ersten Anmeldung geändert werden');
  }
}
