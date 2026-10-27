import { buildApp } from './app';
import { config } from './config';
import { startScheduler } from './services/scheduler';
import { createDb, migrate } from './db';
import { hashPassword } from './lib/crypto';

// Wartungsbefehl: node dist/index.js reset-admin  → setzt admin/admin mit Passwortzwang
if (process.argv[2] === 'reset-admin') {
  const sql = createDb();
  await migrate(sql);
  const hash = await hashPassword('admin');
  const r = await sql`update users set password_hash = ${hash}, must_change_password = true, active = true, auth_source = 'local', role = 'admin'
    where username = 'admin' returning id`;
  if (!r.length) await sql`insert into users (username, display_name, password_hash, role, must_change_password) values ('admin', 'Administrator', ${hash}, 'admin', true)`;
  await sql`delete from sessions where user_id in (select id from users where username = 'admin')`;
  console.log('Benutzer "admin" zurückgesetzt – Passwort "admin" (muss bei der Anmeldung geändert werden).');
  await sql.end();
  process.exit(0);
}

const { app, ctx } = await buildApp();
startScheduler(ctx, app.log);
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} empfangen – fahre herunter`);
    await app.close();
    process.exit(0);
  });
}
