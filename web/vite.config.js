import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: path.resolve(here, '../UE5HTML5Exporter/Resources/WebTemplate'),
    emptyOutDir: true,
    assetsDir: 'runtime',
    rollupOptions: {
      output: {
        entryFileNames: 'runtime/viewer.js',
        chunkFileNames: 'runtime/[name].js',
        assetFileNames: 'runtime/[name][extname]'
      }
    }
  }
});
