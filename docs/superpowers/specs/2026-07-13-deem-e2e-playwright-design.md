# Deem — Playwright E2E Test Suite (Design)

**Date:** 2026-07-13
**Status:** Approved for planning
**Author:** QA Automation (pairing with product owner)

## 1. Context

Deem is a desktop-first AI engineering tool. The Electron shell
(`electron/main.cjs`) boots the Express API server *inside the main process*,
then opens a **single `BrowserWindow`** (`title: 'Deem'`,
`contextIsolation: true`, **no preload / no custom IPC bridge**) that
`loadURL`s `http://localhost:${DEEM_PORT || 4517}`, where the same server also
serves the built React UI from `dist/`.

Key realities that shape the suite:

- **Auth gate:** `App` renders `<Login>` until `GET /api/profile` resolves.
  Every flow must authenticate first. The store keeps a **single profile**
  (single-user local app).
- **Persistence:** `server/store.js` writes to a **hardcoded**
  `<repo>/data/deem.json`. Only `DEEM_PORT` is env-configurable today, not the
  data directory.
- **No `data-testid` attributes** exist anywhere in `web/src`.
- **Settings is an in-app React modal overlay** (topbar "Settings" button), not
  a separate window.
- **The only desktop/IPC-specific behavior** is external-window handling:
  Export buttons call `window.open('/api/tasks/<id>/export/<kind>', '_blank')`,
  which the main process's `setWindowOpenHandler` intercepts — localhost URLs
  return `{ action: 'allow' }` (a child window opens); any other URL routes to
  `shell.openExternal`. There is **no native save/file dialog** in this app.

## 2. Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | **Playwright** (`@playwright/test` + `_electron`) | Official Electron support, single-window fit, first-class role/text selectors, native TS. |
| Selectors | **Role/text/label only** | Ships without touching product components; Playwright's role engine is resilient. `data-testid`s can be added later. |
| Depth | **UI-scoped against a temp repo** | Assert UI transitions (card/task appears, routing), not full mock-pipeline completion. Fast, low flake. |
| Isolation | **Env-configurable data dir** | One-line `store.js` edit (opted in) so each run uses a throwaway data dir + port and never touches real `data/deem.json`. |

## 3. Architecture & File Layout

```
tests/e2e/
  playwright.config.ts        # single "electron" project; workers: 1 (shared-store safety)
  global-setup.ts             # run `npm run build` once so dist/ exists for Electron
  fixtures/
    electron.ts               # core fixture: per-test isolated data dir + temp git repo,
                              #   launch app via _electron, yield { app, window }, teardown
    temp-repo.ts              # create a throwaway `git init` + initial-commit repo
  pages/                      # Page Object Model
    AppShell.ts               # topbar nav (Home, Command Center, Settings, Log out)
    LoginPage.ts              # sign-in / create-account tabs
    HomePage.ts               # dashboard + "Add New Project" modal
    ProjectPage.ts            # project detail + "+ New Task" modal
    SettingsModal.ts          # workspace settings overlay
  specs/
    01-launch.spec.ts         # Flow 1: launch & initial state
    02-project-and-task.spec.ts   # Flow 2: core interaction
    03-settings-and-export.spec.ts # Flow 3: desktop feature
  README.md                   # install + run instructions
```

## 4. Electron Launch & Isolation

- **Launch:** `_electron.launch({ args: ['electron/main.cjs', '--no-sandbox'], env })`.
  `electronApp.firstWindow()` yields the single window. `--no-sandbox` keeps CI
  and root environments happy (per requirement).
- **Isolation (requires the one product-source edit):** change `store.js`
  line 7 to
  `const DATA_DIR = process.env.DEEM_DATA_DIR || path.join(__dirname, '..', 'data');`.
  The fixture sets, per test:
  - `DEEM_DATA_DIR` → a fresh OS temp dir (fresh dir ⇒ no profile ⇒ register path)
  - `DEEM_PORT` → a dedicated test port (e.g. `4599`) to avoid dev-server collisions
- **Boot wait (Electron-specific):** the window only resolves the URL after the
  in-process server is up. The fixture waits for the app root / login form to be
  visible before yielding — commented as the "wait for full boot" workaround.
- **Cleanup:** `electronApp.close()` and recursive-remove of the temp data dir +
  temp repo in fixture teardown, per test.

## 5. Selectors & Auth

- Resilient selectors only: `getByRole('button', { name: 'Add New Project' })`,
  `getByRole('button', { name: 'Sign in' })`, `getByLabel('Email')`,
  `getByRole('heading', { name: 'Operational Dashboard' })`, etc. A POM header
  comment notes `data-testid`s can harden these later.
- **Auth:** fresh isolated data dir ⇒ no profile ⇒ each spec **registers**
  (name/email/password) via `LoginPage`, landing on the dashboard.

## 6. Target Flows

### Flow 1 — Launch & initial state (`01-launch.spec.ts`)
- Assert `await electronApp.firstWindow()` opens and its title is `Deem`.
- Register, then assert the **"Operational Dashboard"** heading and the stat
  tiles ("Running now", "Tasks tracked", "Projects") are visible.

### Flow 2 — Core interaction (`02-project-and-task.spec.ts`)
- Register → click **"Add New Project"** → fill name / description,
  **repoPath = fixture temp git repo**, agent = **"Mock runner (no API cost)"**,
  branch `main` → **"Create project"**.
- Assert routed to the project page (project name heading visible).
- Click **"+ New Task"** → fill name / description / requirements (one per line)
  → **"Create task"**.
- Assert the new task appears in the project's task list.

### Flow 3 — Desktop feature (`03-settings-and-export.spec.ts`)
1. **Settings modal round-trip:** open **Settings** → change
   **"Default token budget per task"** → **Save** → reopen (or reload) →
   assert the value persisted.
2. **Export → external-window handling:** create a project + task, open a task
   detail, click an **Export** button, and assert via
   `electronApp.waitForEvent('window')` that `setWindowOpenHandler` opened a new
   window whose URL matches `/api/tasks/<id>/export/<kind>`. A comment explains
   the localhost-allow vs `shell.openExternal` branch.

## 7. Deliverables

- All files under `tests/e2e/` (config, global setup, fixtures, POMs, 3 specs, README).
- `package.json`: `@playwright/test` devDependency + `test:e2e` script.
- One-line `store.js` isolation tweak (`DEEM_DATA_DIR`).
- README block: install (`npm i -D @playwright/test`), first-run build note, and
  `npm run test:e2e`.

## 8. Error Handling & Resilience

- Fixture teardown always runs (`electronApp.close()` in `finally`), so a failed
  test still cleans temp dirs and kills the app/agent children.
- `workers: 1` avoids two Electron instances contending for the same port /
  store during a run.
- Global setup fails fast with a clear message if `npm run build` errors before
  any spec runs.

## 9. Out of Scope (YAGNI)

- Full mock-pipeline completion assertions (plan→execution→review artifacts).
- Command Center / Telegram, RAG knowledge base, per-project skills.
- Adding `data-testid` attributes to product components.
- Cross-platform packaging / signed-binary launch (tests launch `main.cjs`).
