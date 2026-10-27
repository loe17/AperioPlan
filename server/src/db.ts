import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config';

export type Sql = postgres.Sql<{}>;

export function createDb(url = config.databaseUrl): Sql {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    transform: { undefined: null },
    // Kalenderdaten (date) als "JJJJ-MM-TT" belassen – keine Zeitzonenverschiebung
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
  });
}

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'migrations'), join(here, '..', 'migrations')]) if (existsSync(c)) return c;
  throw new Error('Migrationsordner nicht gefunden');
}

/** Spielt alle noch nicht ausgeführten SQL-Migrationen in alphabetischer Reihenfolge ein. */
export async function migrate(sql: Sql, log: (m: string) => void = () => {}): Promise<void> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const text = await readFile(join(dir, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    log(`Migration ausgeführt: ${f}`);
  }
}

/** Verbindung oder laufende Transaktion */
export type Db = Sql | postgres.TransactionSql<{}>;
