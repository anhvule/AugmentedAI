import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  // A freshly built bundle + Electron cold start is slow; be generous.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The app binds one port and persists to one JSON store — never run two
  // Electron instances concurrently.
  workers: 1,
  fullyParallel: false,
  globalSetup: './global-setup.ts',
  reporter: [['list']],
});
