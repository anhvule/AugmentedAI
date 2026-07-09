import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 4500,
    proxy: { '/api': 'http://localhost:4501' },
  },
  build: { outDir: path.join(__dirname, '..', 'dist'), emptyOutDir: true },
});
