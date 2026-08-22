import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(here, '../UE5HTML5Exporter/Resources/WebTemplate');

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    assetsDir: 'runtime',
    rollupOptions: {
      output: {
        entryFileNames: 'runtime/viewer-[hash].js',
        chunkFileNames: 'runtime/[name]-[hash].js',
        assetFileNames: 'runtime/[name]-[hash][extname]'
      }
    }
  },
  plugins: [{
    name: 'copy-discord-activity-deployment-files',
    closeBundle() {
      const migrations = path.resolve(here, '../supabase/migrations');
      const migrationOutput = path.join(outputDirectory, 'supabase/migrations');
      mkdirSync(migrationOutput, { recursive: true });
      cpSync(migrations, migrationOutput, { recursive: true });
      cpSync(
        path.resolve(here, '../docs/DISCORD_ACTIVITY_WORKFLOW.md'),
        path.join(outputDirectory, 'DISCORD_ACTIVITY_WORKFLOW.md'),
      );
    },
  }],
});
