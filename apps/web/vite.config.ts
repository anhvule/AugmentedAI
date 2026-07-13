import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  resolve: {
    // Vite/Rollup don't read tsconfig "paths" on their own; mirror the
    // @deem/shared alias from tsconfig.base.json so the bundle resolves it.
    alias: {
      '@deem/shared': path.resolve(__dirname, '../../libs/shared/src/index.ts'),
    },
  },
  plugins: [react()],
  server: {
    port: 4500,
    host: 'localhost',
    proxy: { '/api': 'http://localhost:4501' },
  },
  build: {
    outDir: '../../dist/apps/web',
    emptyOutDir: true,
  },
});
