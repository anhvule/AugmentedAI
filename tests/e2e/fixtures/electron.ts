import {
  test as base,
  _electron as electron,
  ElectronApplication,
  Page,
} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempRepo, cleanupDir } from './temp-repo';

// One serial worker => one fixed port is safe (see playwright.config.ts).
const PORT = 4599;

type DeemFixtures = {
  app: ElectronApplication;
  window: Page;
  tmpRepo: string;
};

export const test = base.extend<DeemFixtures>({
  // A fresh data dir means no profile exists yet, so each test starts at the
  // registration screen and never sees another test's state.
  app: async ({}, use) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deem-e2e-data-'));
    const app = await electron.launch({
      args: [path.join(process.cwd(), 'electron', 'main.cjs'), '--no-sandbox'],
      env: { ...process.env, DEEM_PORT: String(PORT), DEEM_DATA_DIR: dataDir },
    });
    await use(app);
    // Always tear down, even on failure, so the port/store are freed.
    await app.close();
    cleanupDir(dataDir);
  },

  window: async ({ app }, use) => {
    // firstWindow() resolves only after the in-process server is up and the
    // window has loaded http://localhost:PORT — this is our "wait for boot".
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },

  tmpRepo: async ({}, use) => {
    const repo = makeTempRepo();
    await use(repo);
    cleanupDir(repo);
  },
});

export const expect = test.expect;
