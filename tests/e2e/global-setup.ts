import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// electron/main.cjs loads the prebuilt UI from dist/. Build it once before the
// suite so every spec launches the real production bundle.
export default function globalSetup() {
  const dist = path.join(process.cwd(), 'dist', 'index.html');
  console.log('[e2e] building web bundle (npm run build)…');
  execSync('npm run build', { stdio: 'inherit' });
  if (!fs.existsSync(dist)) {
    throw new Error(`[e2e] build did not produce ${dist}`);
  }
}
