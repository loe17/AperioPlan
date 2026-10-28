// Bündelt den Server inkl. @aperio/shared zu dist/index.js; npm-Abhängigkeiten bleiben extern.
import { build } from 'esbuild';
import { readFileSync, cpSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@aperio/'));

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/index.js',
  external,
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
cpSync('migrations', 'dist/migrations', { recursive: true });
cpSync('assets', 'dist/assets', { recursive: true });
console.log('Server gebaut: dist/index.js');
