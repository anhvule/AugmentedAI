# Deem Playwright E2E Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Playwright E2E test suite that launches the real Deem Electron app in full isolation and covers three critical user flows (launch, project+task creation, settings/export).

**Architecture:** Playwright's `_electron` API launches `electron/main.cjs` (which boots the in-process Express server and opens the single `BrowserWindow`). A custom test fixture gives each test a throwaway data directory (`DEEM_DATA_DIR`) and a throwaway git repo, so tests never touch the user's real `data/deem.json`. Page Object Model classes wrap the UI using role/text/label selectors only. One product-source line is changed to make the data directory env-configurable.

**Tech Stack:** Node ESM, Electron 43, `@playwright/test`, TypeScript (Playwright's built-in transpilation — no tsconfig needed).

## Global Constraints

- **Selectors:** role/text/label only (`getByRole`, `getByText`, `getByLabel`). No `data-testid` — none exist in `web/src`. No brittle CSS/XPath paths.
- **Isolation:** every test uses a unique temp `DEEM_DATA_DIR` and a unique temp git repo; teardown always runs (even on failure).
- **Concurrency:** `workers: 1`, `fullyParallel: false` — the app binds one port and persists to one JSON store; never run two Electron instances at once.
- **Port:** tests use `DEEM_PORT=4599` (avoids dev `4501` / packaged `4517`).
- **Launch args:** always include `--no-sandbox`.
- **No product behavior changes** other than the single `store.js` `DEEM_DATA_DIR` line.
- **Test root:** all new files live under `tests/e2e/`.
- **Verified UI facts (copy verbatim into selectors):**
  - Window/document title: `Deem` (`web/index.html` `<title>Deem</title>`).
  - Login tabs: buttons `Sign in`, `Create account`; register submit: `Create account & enter`; fields labelled `Name`, `Email`, `Password`. **Password must be 8+ chars** (`server/auth.js`) — use `'secret123'` in tests.
  - Dashboard heading: `Operational Dashboard`; stat label text `Running now`.
  - New-project trigger: `Add New Project`; modal fields `Project name *`, `Description`, `Local repository path *`, select `Agent` (option `Mock runner (no API cost)`), `Default branch`; submit `Create project`. On success navigates to `/projects/:id`, which renders `<h2>{project.name}</h2>`.
  - New-task trigger: `+ New Task`; modal fields `Task name *`, `Description`, `Requirements`, `Notes`, select `Initial status`; submit `Create task`. On success navigates to `/tasks/:id`, which renders `<h2>{task.name}</h2>` plus `Export Task.md` button and `Back to Project` link.
  - Topbar button `Settings` opens the workspace-settings overlay: heading `Integrations & budgets`, number field `Default token budget per task`, submit `Save settings`.
  - Export: `Export Task.md` calls `window.open('/api/tasks/:id/export/task', '_blank')`; `electron/main.cjs`'s `setWindowOpenHandler` allows localhost URLs → a new Electron window opens at that URL.

---

## File Structure

```
tests/e2e/
  playwright.config.ts        # single project; workers:1; globalSetup
  global-setup.ts             # `npm run build` once so dist/ exists
  fixtures/
    temp-repo.ts              # makeTempRepo(), cleanupDir()
    electron.ts               # test/expect fixtures: app, window, tmpRepo
  pages/
    LoginPage.ts
    AppShell.ts
    HomePage.ts
    ProjectPage.ts
    SettingsModal.ts
  specs/
    01-launch.spec.ts
    02-project-and-task.spec.ts
    03-settings-and-export.spec.ts
  README.md
server/store.js               # MODIFY line 7 only (DEEM_DATA_DIR)
package.json                  # MODIFY: devDep + test:e2e script
```

---

## Task 1: Test infrastructure, isolation, and Flow 1 (launch)

Foundational scaffolding — config, build step, data-dir isolation, the Electron fixture, the login/home POMs, and the launch spec. These are folded together because none is independently testable without the others; the deliverable is a green Flow 1.

**Files:**
- Modify: `server/store.js:7`
- Modify: `package.json` (devDependency + script)
- Create: `tests/e2e/playwright.config.ts`
- Create: `tests/e2e/global-setup.ts`
- Create: `tests/e2e/fixtures/temp-repo.ts`
- Create: `tests/e2e/fixtures/electron.ts`
- Create: `tests/e2e/pages/LoginPage.ts`
- Create: `tests/e2e/pages/AppShell.ts`
- Create: `tests/e2e/pages/HomePage.ts`
- Test: `tests/e2e/specs/01-launch.spec.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `server/store.js` honors `process.env.DEEM_DATA_DIR`.
  - `tests/e2e/fixtures/electron.ts` exports `test` and `expect` with fixtures `app: ElectronApplication`, `window: Page`, `tmpRepo: string`.
  - `tests/e2e/fixtures/temp-repo.ts` exports `makeTempRepo(): string` and `cleanupDir(dir: string): void`.
  - `LoginPage(page).register(name, email, password): Promise<void>`.
  - `AppShell(page).openSettings(): Promise<void>`, `.gotoHome(): Promise<void>`.
  - `HomePage(page).dashboardHeading(): Locator`, `.createProject({name, description?, repoPath}): Promise<void>`.

- [ ] **Step 1: Install Playwright test runner**

Run:
```bash
npm install -D @playwright/test@^1.49.0
```
Expected: `@playwright/test` added to `devDependencies`. (Electron is already a devDependency, so Playwright drives the installed Electron directly — no `npx playwright install` browser download needed.)

- [ ] **Step 2: Add the `test:e2e` script**

Modify `package.json` `scripts` — add this line alongside the existing scripts:
```json
    "test:e2e": "playwright test --config tests/e2e/playwright.config.ts",
```

- [ ] **Step 3: Make the data directory env-configurable**

Modify `server/store.js` line 7. Change:
```js
const DATA_DIR = path.join(__dirname, '..', 'data');
```
to:
```js
// DEEM_DATA_DIR lets tests (and ops) redirect persistence to an isolated dir.
const DATA_DIR = process.env.DEEM_DATA_DIR || path.join(__dirname, '..', 'data');
```

- [ ] **Step 4: Write the Playwright config**

Create `tests/e2e/playwright.config.ts`:
```ts
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
```

- [ ] **Step 5: Write the global setup (build once)**

Create `tests/e2e/global-setup.ts`:
```ts
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
```

- [ ] **Step 6: Write the temp-repo helper**

Create `tests/e2e/fixtures/temp-repo.ts`:
```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Project creation points the agent at a local git repository. Tests must never
// touch a real repo, so we spin up a throwaway one with a single commit.
export function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deem-e2e-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@deem.test']);
  git(['config', 'user.name', 'Deem E2E']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e fixture repo\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit']);
  return dir;
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 7: Write the Electron fixture**

Create `tests/e2e/fixtures/electron.ts`:
```ts
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
```

- [ ] **Step 8: Write the LoginPage POM**

Create `tests/e2e/pages/LoginPage.ts`:
```ts
import { Page } from '@playwright/test';

// No data-testid attributes exist; fields are wrapped <label> elements, so
// getByLabel resolves them by their visible text.
export class LoginPage {
  constructor(private page: Page) {}

  async register(name: string, email: string, password: string): Promise<void> {
    // The form defaults to "Sign in"; switch to the create-account tab first.
    // exact:true so it doesn't also match the "Create account & enter" submit.
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click();
    await this.page.getByLabel('Name').fill(name);
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Create account & enter' }).click();
  }
}
```

- [ ] **Step 9: Write the AppShell POM**

Create `tests/e2e/pages/AppShell.ts`:
```ts
import { Page } from '@playwright/test';

// The persistent top bar shown on every authenticated screen.
export class AppShell {
  constructor(private page: Page) {}

  openSettings(): Promise<void> {
    // exact:true so it never matches "Update settings" / "Save settings".
    return this.page.getByRole('button', { name: 'Settings', exact: true }).click();
  }

  gotoHome(): Promise<void> {
    return this.page.getByRole('link', { name: 'Home' }).click();
  }
}
```

- [ ] **Step 10: Write the HomePage POM**

Create `tests/e2e/pages/HomePage.ts`:
```ts
import { Page, Locator } from '@playwright/test';

export class HomePage {
  constructor(private page: Page) {}

  dashboardHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Operational Dashboard' });
  }

  // Opens "Add New Project", fills it, submits. Navigates to /projects/:id.
  async createProject(opts: {
    name: string;
    description?: string;
    repoPath: string;
  }): Promise<void> {
    await this.page.getByRole('button', { name: 'Add New Project' }).click();
    await this.page.getByLabel('Project name').fill(opts.name);
    if (opts.description) await this.page.getByLabel('Description').fill(opts.description);
    await this.page.getByLabel('Local repository path').fill(opts.repoPath);
    await this.page.getByLabel('Agent').selectOption({ label: 'Mock runner (no API cost)' });
    await this.page.getByRole('button', { name: 'Create project' }).click();
  }
}
```

- [ ] **Step 11: Write the Flow 1 launch spec**

Create `tests/e2e/specs/01-launch.spec.ts`:
```ts
import { test, expect } from '../fixtures/electron';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';

test.describe('Flow 1: launch & initial state', () => {
  test('opens a single window titled "Deem"', async ({ app, window }) => {
    expect(await window.title()).toBe('Deem');
    expect(app.windows().length).toBe(1);
  });

  test('shows the dashboard after registering', async ({ window }) => {
    const login = new LoginPage(window);
    const home = new HomePage(window);
    await login.register('Aiko Sato', 'aiko@example.com', 'secret');
    await expect(home.dashboardHeading()).toBeVisible();
    await expect(window.getByText('Running now')).toBeVisible();
  });
});
```

- [ ] **Step 12: Run Flow 1 and verify it passes**

Run:
```bash
npm run test:e2e -- specs/01-launch.spec.ts
```
Expected: global setup builds the bundle, then `2 passed`. If the launch times out, confirm `dist/index.html` exists and that no stray process holds port 4599.

- [ ] **Step 13: Commit**

```bash
git add tests/e2e server/store.js package.json package-lock.json
git commit -m "test(e2e): scaffold Playwright Electron suite + Flow 1 launch"
```

---

## Task 2: Flow 2 — project & task creation (core interaction)

**Files:**
- Create: `tests/e2e/pages/ProjectPage.ts`
- Test: `tests/e2e/specs/02-project-and-task.spec.ts`

**Interfaces:**
- Consumes: `test`/`expect`/`tmpRepo`/`window` from `fixtures/electron.ts`; `LoginPage`, `HomePage` from Task 1.
- Produces: `ProjectPage(page).heading(name): Locator`, `.createTask({name, description?, requirements?}): Promise<void>`.

- [ ] **Step 1: Write the ProjectPage POM**

Create `tests/e2e/pages/ProjectPage.ts`:
```ts
import { Page, Locator } from '@playwright/test';

export class ProjectPage {
  constructor(private page: Page) {}

  heading(name: string): Locator {
    return this.page.getByRole('heading', { name });
  }

  // Opens "+ New Task", fills it, submits. Navigates to /tasks/:id.
  async createTask(opts: {
    name: string;
    description?: string;
    requirements?: string[];
  }): Promise<void> {
    await this.page.getByRole('button', { name: '+ New Task' }).click();
    await this.page.getByLabel('Task name').fill(opts.name);
    if (opts.description) await this.page.getByLabel('Description').fill(opts.description);
    if (opts.requirements?.length) {
      await this.page.getByLabel('Requirements').fill(opts.requirements.join('\n'));
    }
    await this.page.getByRole('button', { name: 'Create task' }).click();
  }
}
```

- [ ] **Step 2: Write the Flow 2 spec (register → project → task)**

Create `tests/e2e/specs/02-project-and-task.spec.ts`:
```ts
import { test, expect } from '../fixtures/electron';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';

test('Flow 2: create a project and a task', async ({ window, tmpRepo }) => {
  const login = new LoginPage(window);
  const home = new HomePage(window);
  const project = new ProjectPage(window);

  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
  await expect(home.dashboardHeading()).toBeVisible();

  // Create a project pointed at the isolated throwaway git repo.
  await home.createProject({
    name: 'Q3 Marketing Launch',
    description: 'E2E-created project',
    repoPath: tmpRepo,
  });
  // On success the app routes to the project page (renders the project name).
  await expect(project.heading('Q3 Marketing Launch')).toBeVisible();

  // Create a task; the app then routes to the task detail page.
  await project.createTask({
    name: 'Wire up landing page',
    description: 'Build the campaign landing page',
    requirements: ['User can submit the signup form', 'Form validates email'],
  });
  // Task detail renders the task name as a heading + a Back to Project link.
  await expect(window.getByRole('heading', { name: 'Wire up landing page' })).toBeVisible();
  await expect(window.getByRole('link', { name: 'Back to Project' })).toBeVisible();

  // Back on the project page, the new task shows in the task list.
  await window.getByRole('link', { name: 'Back to Project' }).click();
  await expect(project.heading('Q3 Marketing Launch')).toBeVisible();
  await expect(window.getByText('Wire up landing page')).toBeVisible();
});
```

- [ ] **Step 3: Run Flow 2 and verify it passes**

Run:
```bash
npm run test:e2e -- specs/02-project-and-task.spec.ts
```
Expected: `1 passed`. If "Create project" errors in-app (red text), the repo path was rejected — confirm `makeTempRepo()` produced a committed git repo.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): Flow 2 — project and task creation"
```

---

## Task 3: Flow 3 — settings round-trip & export window, plus README

**Files:**
- Create: `tests/e2e/pages/SettingsModal.ts`
- Test: `tests/e2e/specs/03-settings-and-export.spec.ts`
- Create: `tests/e2e/README.md`

**Interfaces:**
- Consumes: `test`/`expect`/`window`/`tmpRepo` from `fixtures/electron.ts`; `LoginPage`, `HomePage`, `ProjectPage`, `AppShell` from Tasks 1–2.
- Produces: `SettingsModal(page).heading(): Locator`, `.budgetInput(): Locator`, `.setBudget(value): Promise<void>`.

- [ ] **Step 1: Write the SettingsModal POM**

Create `tests/e2e/pages/SettingsModal.ts`:
```ts
import { Page, Locator } from '@playwright/test';

// The in-app workspace-settings overlay (NOT a separate window).
export class SettingsModal {
  constructor(private page: Page) {}

  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Integrations & budgets' });
  }

  budgetInput(): Locator {
    // Label carries a trailing hint span; getByLabel substring-matches it.
    return this.page.getByLabel('Default token budget per task');
  }

  async setBudget(value: number): Promise<void> {
    await this.budgetInput().fill(String(value));
    await this.page.getByRole('button', { name: 'Save settings' }).click();
  }
}
```

- [ ] **Step 2: Write the Flow 3 spec (settings persistence + export window)**

Create `tests/e2e/specs/03-settings-and-export.spec.ts`:
```ts
import { test, expect } from '../fixtures/electron';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';
import { AppShell } from '../pages/AppShell';
import { SettingsModal } from '../pages/SettingsModal';

test('Flow 3a: settings budget persists across reopen', async ({ window }) => {
  const login = new LoginPage(window);
  const shell = new AppShell(window);
  const settings = new SettingsModal(window);

  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');

  await shell.openSettings();
  await expect(settings.heading()).toBeVisible();
  await settings.setBudget(250000);

  // Save closes the overlay after a short confirmation.
  await expect(settings.heading()).toBeHidden();

  // Reopen — the overlay refetches /api/settings, proving the value persisted.
  await shell.openSettings();
  await expect(settings.budgetInput()).toHaveValue('250000');
});

test('Flow 3b: export opens a new Electron window at the export URL', async ({
  app,
  window,
  tmpRepo,
}) => {
  const login = new LoginPage(window);
  const home = new HomePage(window);
  const project = new ProjectPage(window);

  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
  await home.createProject({ name: 'Export Proj', repoPath: tmpRepo });
  await expect(project.heading('Export Proj')).toBeVisible();
  await project.createTask({ name: 'Exportable task' });
  await expect(window.getByRole('heading', { name: 'Exportable task' })).toBeVisible();

  // "Export Task.md" calls window.open(...'_blank'), which main.cjs's
  // setWindowOpenHandler allows (localhost) → a new Electron window opens.
  const [popup] = await Promise.all([
    app.waitForEvent('window'),
    window.getByRole('button', { name: 'Export Task.md' }).click(),
  ]);
  expect(popup.url()).toContain('/api/tasks/');
  expect(popup.url()).toContain('/export/task');
  await popup.close();
});
```

- [ ] **Step 3: Run Flow 3 and verify it passes**

Run:
```bash
npm run test:e2e -- specs/03-settings-and-export.spec.ts
```
Expected: `2 passed`. If 3b times out on `waitForEvent('window')`, confirm the export URL is localhost (allowed) rather than routed to `shell.openExternal`.

- [ ] **Step 4: Write the suite README**

Create `tests/e2e/README.md`:
```markdown
# Deem E2E tests (Playwright + Electron)

End-to-end tests that launch the real Deem desktop app via Playwright's
`_electron` API, in full isolation from your real workspace.

## Install

```bash
npm install            # includes @playwright/test (devDependency)
```

No browser download is needed — the tests drive the Electron that's already a
project devDependency.

## Run

```bash
npm run test:e2e                                   # all flows
npm run test:e2e -- specs/02-project-and-task.spec.ts   # one flow
npm run test:e2e -- --headed                       # watch the window
```

The suite builds the web bundle once (`npm run build`) in global setup, then
runs serially (`workers: 1`) because the app binds one port and one JSON store.

## Isolation

Each test launches Electron with:
- `DEEM_DATA_DIR` → a fresh temp dir (no profile ⇒ starts at registration),
- `DEEM_PORT=4599`,
and creates projects against a throwaway `git init` repo. Nothing touches your
real `data/deem.json`. Temp dirs and the app are torn down after every test.

## Layout

- `fixtures/electron.ts` — launch/teardown + isolation fixtures.
- `fixtures/temp-repo.ts` — throwaway git repo helper.
- `pages/` — Page Object Model (role/text/label selectors; no `data-testid`).
- `specs/` — one file per user flow.
```

- [ ] **Step 5: Run the whole suite**

Run:
```bash
npm run test:e2e
```
Expected: all specs pass (`5 passed` across the three files).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): Flow 3 — settings persistence + export window, README"
```

---

## Self-Review

**Spec coverage:**
- §4 launch/isolation → Task 1 (config, fixture, `--no-sandbox`, `DEEM_DATA_DIR`, boot wait). ✓
- §5 selectors/auth → all POMs use role/label; register-per-fresh-dir. ✓
- §6 Flow 1 → Task 1 spec (title + dashboard). ✓
- §6 Flow 2 → Task 2 spec (project + task against temp repo). ✓
- §6 Flow 3 → Task 3 spec (settings round-trip + export window). ✓
- §7 deliverables → devDep + `test:e2e` script (Task 1), README (Task 3), `store.js` tweak (Task 1). ✓
- §8 error handling → fixture teardown in `use()` after-block runs on failure; `workers:1`; global-setup fails fast. ✓

**Placeholder scan:** no TBD/TODO; every file has complete code. ✓

**Type consistency:** `makeTempRepo`/`cleanupDir`, fixture names (`app`, `window`, `tmpRepo`), and POM method names (`register`, `createProject`, `createTask`, `heading`, `openSettings`, `setBudget`, `budgetInput`) are used identically across tasks. ✓
