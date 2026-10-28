import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mitgelieferte Dateien (Schriften usw.) – im Quelltext unter server/assets, im fertigen Paket unter dist/assets */
export function assetPath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const base of [join(here, 'assets'), join(here, '..', 'assets'), join(here, '..', '..', 'assets')]) {
    const p = join(base, rel);
    if (existsSync(p)) return p;
  }
  throw new Error(`Mitgelieferte Datei fehlt: ${rel}`);
}
