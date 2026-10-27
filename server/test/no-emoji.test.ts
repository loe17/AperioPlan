import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Stellt sicher, dass in der Oberfläche und in Meldungen keine Emojis mehr stehen –
// alle Symbole kommen aus dem eigenen SVG-Satz (web/src/components/Icon.tsx).
const ROOT = join(__dirname, '..', '..');
const DIRS = ['web/src', 'server/src', 'server/migrations', 'shared/src', 'cad-bridge/src', 'e2e', 'docs/plugins'];
const EXT = /\.(tsx?|mjs|js|cs|sql|json|css|html)$/;
// Bereits ausgelieferte Datenbank-Schritte bleiben unverändert; 008 übersetzt die alten Emojis in Symbolnamen.
const ALLOWED = new Set(['server/migrations/001_core.sql', 'server/migrations/002_projects.sql', 'server/migrations/008_icons.sql']);
const EMOJI = /\p{Extended_Pictographic}|\uFE0F/u;
// Erlaubte typografische Zeichen, die Unicode ebenfalls als „Bildzeichen“ führt
const TYPO = /[©®™↔↕]/gu;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (['node_modules', 'dist', 'bin', 'obj'].includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(n)) out.push(p);
  }
  return out;
}

describe('Symbole', () => {
  it('enthält keine Emojis im Quelltext', () => {
    const hits: string[] = [];
    for (const d of DIRS) {
      for (const f of walk(join(ROOT, d))) {
        const rel = relative(ROOT, f).replace(/\\/g, '/');
        if (ALLOWED.has(rel)) continue;
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (EMOJI.test(line.replace(TYPO, ''))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
