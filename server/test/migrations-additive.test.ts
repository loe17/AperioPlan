import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ältere Versionen müssen mit einer neueren Datenbank weiterlaufen (Wechsel zurück ohne Datenverlust).
 * Deshalb dürfen Migrationen nur ergänzen: keine Tabellen oder Spalten löschen oder umbenennen,
 * keine Datentypen ändern und keine Pflichtspalten ohne Vorgabewert hinzufügen.
 */
const dir = join(__dirname, '..', 'migrations');
const FORBIDDEN: [RegExp, string][] = [
  [/\bdrop\s+table\b/i, 'Tabelle löschen'],
  [/\bdrop\s+column\b/i, 'Spalte löschen'],
  [/\brename\b/i, 'umbenennen'],
  [/\balter\s+column\s+\w+\s+(set\s+data\s+)?type\b/i, 'Datentyp ändern'],
  [/\bset\s+not\s+null\b/i, 'nachträglich Pflichtfeld'],
  [/\btruncate\b/i, 'Tabelle leeren'],
  [/^\s*delete\s+from\b/im, 'Daten löschen'],
];

describe('Migrationen', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  it.each(files)('%s ergänzt nur', (f) => {
    const text = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '');
    for (const [re, what] of FORBIDDEN) expect(re.test(text), `${f}: ${what}`).toBe(false);
    // neue Pflichtspalten in bestehenden Tabellen brauchen einen Vorgabewert
    for (const m of text.matchAll(/add\s+column\s+[^,;]*?\bnot\s+null\b[^,;]*/gi)) expect(/\bdefault\b|primary\s+key/i.test(m[0]), `${f}: ${m[0]}`).toBe(true);
  });
});
