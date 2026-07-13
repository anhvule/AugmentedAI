import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PORT = 4599;
// Isolated data dir → fresh profile → tests start at registration; the api
// serves the web build from DEEM_WEB_DIST.
const dataDir = mkdtempSync(join(tmpdir(), 'deem-e2e-'));
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default defineConfig({
  testDir: './src/specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build web, then run the api serving that build on the test port.
    // Paths are quoted because the workspace root may contain spaces.
    command: `npx nx build web && DEEM_PORT=${PORT} DEEM_DATA_DIR="${dataDir}" DEEM_WEB_DIST="${join(root, 'dist', 'apps', 'web')}" node apps/api/src/index.js`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    cwd: root,
  },
});
