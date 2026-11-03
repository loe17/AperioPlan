import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers';
import { BACKUP_TABLES } from '../src/services/backup';

/** Jede Tabelle mit Nutzdaten muss in der Sicherung stehen – sonst fehlen nach einer Wiederherstellung Daten */
const NOT_BACKED_UP = ['sessions', 'login_tickets', 'bridge_clients', 'schema_migrations'];
let env: TestEnv;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.close(); });

describe('Sicherung', () => {
  it('enthält alle Tabellen, jeweils mit Primärschlüssel', async () => {
    const tables = (await env.ctx.sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public'`).map((r) => r.t);
    const listed = BACKUP_TABLES.map((t) => t.name);
    expect(tables.filter((t) => !listed.includes(t) && !NOT_BACKED_UP.includes(t))).toEqual([]);
    expect(listed.filter((t) => !tables.includes(t))).toEqual([]);
    const pks = await env.ctx.sql<{ t: string; c: string }[]>`select tc.table_name as t, string_agg(k.column_name, ',' order by k.ordinal_position) as c
      from information_schema.table_constraints tc join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
      where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' group by 1`;
    const pk = new Map(pks.map((r) => [r.t, r.c]));
    for (const t of BACKUP_TABLES) expect(`${t.name}:${t.pk.join(',')}`).toBe(`${t.name}:${pk.get(t.name)}`);
  });
});
