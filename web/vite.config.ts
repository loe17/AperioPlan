import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Hintergrund-Unschärfe im Videoanruf: Die freie Bilderkennung (MediaPipe Selfie Segmentation)
 * wird mit ausgeliefert, damit sie auch ohne Internet funktioniert – unter /mediapipe/.
 */
function mediapipe(): Plugin {
  const copy = (target: string) => {
    const pkg = dirname(createRequire(import.meta.url).resolve('@mediapipe/selfie_segmentation/package.json'));
    mkdirSync(target, { recursive: true });
    for (const f of ['selfie_segmentation.js', 'selfie_segmentation.binarypb', 'selfie_segmentation.tflite', 'selfie_segmentation_landscape.tflite',
      'selfie_segmentation_solution_simd_wasm_bin.data', 'selfie_segmentation_solution_simd_wasm_bin.js', 'selfie_segmentation_solution_simd_wasm_bin.wasm',
      'selfie_segmentation_solution_wasm_bin.js', 'selfie_segmentation_solution_wasm_bin.wasm']) {
      if (existsSync(join(pkg, f))) cpSync(join(pkg, f), join(target, f));
    }
  };
  return {
    name: 'aperio-mediapipe',
    buildStart() { copy(join(__dirname, 'public', 'mediapipe')); },
  };
}

export default defineConfig({
  plugins: [react(), mediapipe()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
