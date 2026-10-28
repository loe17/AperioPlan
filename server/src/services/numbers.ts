import { formatNumberPattern, type NumberContext } from '@aperio/shared';
import type { Db as Sql } from '../db';

/**
 * Fortlaufende Nummern für Kunden, Angebote, Reklamationen, Bestellungen, Kalkulationen.
 * Enthält das Muster ein Jahr ({JJ}/{JJJJ}), beginnt die Zählung jedes Jahr neu.
 */
export async function nextNumber(sql: Sql, key: string, pattern: string, exists: (n: string) => Promise<boolean>, c: NumberContext = {}): Promise<string> {
  const year = c.year ?? new Date().getFullYear();
  const counter = /\{JJ(JJ)?\}/.test(pattern) ? `${key}:${year}` : key;
  for (let guard = 0; guard < 1000; guard++) {
    const [row] = await sql<{ value: number }[]>`insert into number_counters (key, value) values (${counter}, 1)
      on conflict (key) do update set value = number_counters.value + 1 returning value`;
    const n = formatNumberPattern(pattern, row!.value, { ...c, year });
    if (!(await exists(n))) return n;
  }
  throw new Error('Keine freie Nummer gefunden');
}
