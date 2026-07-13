# Deem → Nx Monorepo Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Deem into an Nx monorepo — `apps/web` (React + Vite + **TypeScript**), `apps/api` (Express, **JavaScript**, logic unchanged), `apps/web-e2e` (browser Playwright), `libs/shared` (**TS** API-contract types) — and remove Electron entirely.

**Architecture:** Nx initialized in place (preserves git history, `deemsvc`, `docs`). Only the React frontend and the shared contract are TypeScript; the ~1,800-LOC dynamic Express backend is relocated as-is (JS) and wrapped in Nx `serve`/`build`/`test` targets. In production the api serves the web build; in dev, Vite proxies `/api` to the api. Browser Playwright replaces the retired Electron e2e suite, reusing its Page Objects.

**Tech Stack:** Nx (latest), npm, React 18, Vite, `@nx/react`/`@nx/vite`/`@nx/node`/`@nx/playwright`/`@nx/js`, Express (ESM), `@playwright/test`, `node:test` (api).

## Global Constraints

- **Language split:** `apps/web` + `libs/shared` are **TypeScript** (`strict: true`). `apps/api` **stays JavaScript** (ESM) — relocate, do not rewrite logic.
- **Package manager:** npm. **Nx:** initialize in place (never `create-nx-workspace` into a new dir — it would lose `deemsvc`/`docs`/git history).
- **Path alias:** `@deem/shared` → `libs/shared/src/index.ts` (in `tsconfig.base.json`).
- **Ports:** api dev `4501`; web dev `4500` (Vite) proxying `/api` → `http://localhost:4501`. Preserve `DEEM_PORT` and `DEEM_DATA_DIR` env overrides in the api.
- **Selectors (e2e):** role/text/label only (no `data-testid`). Reuse the existing POM class/method names verbatim.
- **Prod parity:** the api's static block must still serve the SPA (fallback for non-`/api` routes); only the served directory path changes (from `../dist` to the `apps/web` build output).
- **Removed at the end:** `electron/`, the `electron` devDependency, the old `tests/e2e/` Electron harness, root `app`/`dev`/`build`/`start`/`test`/`dev:*` scripts (replaced by Nx + thin root wrappers), root `dist/`.
- **Untouched:** `deemsvc/` (Python), `data/`, `demo-target/`, `docs/`.
- **Verified API payload shapes** (for `libs/shared`, observed in current code):
  - profile: `{ id, name, email }`
  - settings: `{ defaultTokenBudget, maxConcurrentRuns, phaseTimeoutMinutes, telegramConfigured, telegramToken }`
  - project: `{ id, name, description, repoPath, agent, agentLabel, branch, health, tasks: Task[] }`
  - task: `{ id, name, description, status, runStatus, updatedAt, requirements: string[], branch, planAccepted }`
  - dashboard: `{ runningNow, tasksTracked, projectCount, active: Task[] }`
- **Verified UI facts** (unchanged by this migration — the browser e2e reuses them): title `Deem`; login tabs `Sign in`/`Create account`, register submit `Create account & enter`, fields `Name`/`Email`/`Password` (password 8+ chars), dashboard heading `Operational Dashboard`, stat `Running now`; `Add New Project` modal (`Project name *`, `Description`, `Local repository path *`, `Agent` combobox option `Mock runner (no API cost)`, submit `Create project`) → `/projects/:id` `<h2>{name}</h2>`; `+ New Task` modal (`Task name *`, `Description`, `Requirements`) submit `Create task` → `/tasks/:id` `<h2>{name}</h2>` + `Back to Project`; `Settings` → overlay heading `Integrations & budgets`, field `Default token budget per task`, submit `Save settings`; `Export Task.md` calls `window.open('/api/tasks/:id/export/task', '_blank')`.

---

## File Structure

```
nx.json · tsconfig.base.json · package.json (root, thin wrappers)
apps/
  web/        index.html, src/{main.tsx,App.tsx,pages/*.tsx,components/ui.tsx,api.ts,styles.css}, vite.config.ts, tsconfig*.json, project.json
  api/        src/{index.js,store.js,auth.js,events.js,workflow.js,…,agents/,tests/*.test.js}, project.json, jsconfig.json
  web-e2e/    src/{specs/*.spec.ts,pages/*.ts,fixtures/temp-repo.ts}, playwright.config.ts, project.json
libs/
  shared/     src/{index.ts,types.ts}, project.json, tsconfig*.json
.github/workflows/ci.yml
```

---

## Task 1: Scaffold Nx in place

**Files:**
- Create: `nx.json`, `tsconfig.base.json`
- Modify: `package.json` (add nx devDeps; keep old scripts for now — they still work until later tasks move code)
- Create: `.nx/` cache dir is auto-generated (add to `.gitignore`)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a working Nx workspace — `npx nx report` lists installed plugins; `tsconfig.base.json` defines the `@deem/shared` path alias later tasks import.

- [ ] **Step 1: Install Nx and plugins**

Run:
```bash
npm install -D nx@latest @nx/js@latest @nx/react@latest @nx/vite@latest @nx/node@latest @nx/playwright@latest @nx/eslint@latest typescript@latest
```
Expected: packages added to `devDependencies`; no errors.

- [ ] **Step 2: Initialize Nx in the existing repo**

Run:
```bash
npx nx@latest init --no-interactive
```
Expected: creates `nx.json` and a `.nx/` cache dir, updates `package.json`. It does NOT move any source. If it prompts despite `--no-interactive`, accept defaults (npm, no remote cache).

- [ ] **Step 3: Create the base TS config with the shared alias**

Create `tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "emitDeclarationOnly": false,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2022",
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@deem/shared": ["libs/shared/src/index.ts"]
    }
  }
}
```

- [ ] **Step 4: Ignore Nx cache**

Add to `.gitignore` (append):
```
# Nx
.nx/cache
.nx/workspace-data
dist
```

- [ ] **Step 5: Verify the workspace**

Run:
```bash
npx nx report
```
Expected: prints Nx + plugin versions (`@nx/react`, `@nx/vite`, `@nx/node`, `@nx/playwright`, `@nx/js`) with no error.

- [ ] **Step 6: Commit**

```bash
git add nx.json tsconfig.base.json package.json package-lock.json .gitignore
git commit -m "build(nx): initialize Nx workspace in place with plugins + shared alias"
```

---

## Task 2: `libs/shared` — TypeScript API contract

**Files:**
- Create: `libs/shared/src/types.ts`, `libs/shared/src/index.ts`, `libs/shared/project.json`, `libs/shared/tsconfig.json`, `libs/shared/tsconfig.lib.json`
- (Prefer generating these, then replacing `types.ts`/`index.ts` content.)

**Interfaces:**
- Consumes: `tsconfig.base.json` alias from Task 1.
- Produces: `@deem/shared` exporting `Profile`, `Settings`, `Project`, `Task`, `Dashboard`, `Agent` — imported by `apps/web` in Task 4.

- [ ] **Step 1: Generate the library**

Run:
```bash
npx nx g @nx/js:lib shared --directory=libs/shared --bundler=none --unitTestRunner=none --linter=none --no-interactive
```
Expected: creates `libs/shared` with `src/index.ts` and tsconfigs, and adds the alias to `tsconfig.base.json` (verify it matches `@deem/shared`; if the generator used a different name like `@deem/shared`, keep it consistent with Task 1's path — edit `tsconfig.base.json` so the alias is exactly `@deem/shared`).

- [ ] **Step 2: Write the contract types**

Create/replace `libs/shared/src/types.ts`:
```ts
export type Agent = 'mock' | 'claude-code' | 'codex';

export interface Profile {
  id: string;
  name: string;
  email: string;
}

export interface Settings {
  defaultTokenBudget: number;
  maxConcurrentRuns: number;
  phaseTimeoutMinutes: number;
  telegramConfigured: boolean;
  telegramToken?: string;
}

export interface Task {
  id: string;
  name: string;
  description: string;
  status: string;
  runStatus?: string;
  updatedAt: number;
  requirements: string[];
  branch: string;
  planAccepted?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  agent: Agent;
  agentLabel: string;
  branch: string;
  health: string;
  tasks: Task[];
}

export interface Dashboard {
  runningNow: number;
  tasksTracked: number;
  projectCount: number;
  active: Task[];
}
```

- [ ] **Step 3: Barrel export**

Replace `libs/shared/src/index.ts`:
```ts
export * from './types';
```

- [ ] **Step 4: Typecheck the library**

Run:
```bash
npx nx run shared:build 2>/dev/null || npx tsc --noEmit -p libs/shared/tsconfig.lib.json
```
Expected: no type errors. (If `shared:build` target doesn't exist because `--bundler=none`, the `tsc --noEmit` fallback is the gate.)

- [ ] **Step 5: Commit**

```bash
git add libs/shared tsconfig.base.json
git commit -m "feat(shared): add @deem/shared TypeScript API-contract types"
```

---

## Task 3: `apps/api` — relocate the Express server (JavaScript)

**Files:**
- Create: `apps/api/project.json`, `apps/api/jsconfig.json`
- Move: `server/**` → `apps/api/src/**` (all `.js`, including `agents/` and `tests/`)
- Modify: `apps/api/src/store.js` (data-dir default path), `apps/api/src/index.js` (static path + keep `DEEM_PORT`)

**Interfaces:**
- Consumes: nothing from TS tasks (api is standalone JS).
- Produces: Nx targets `serve` (`node src/index.js`, port 4501), `build` (copy to `dist/apps/api`), `test` (`node --test src/tests/*.test.js`). `/api/health` responds when served. The web build path it serves is `dist/apps/web` (wired in Task 4/6; until then it serves nothing, which is fine — health/API still work).

- [ ] **Step 1: Move the server source (preserve git history)**

Run:
```bash
mkdir -p apps/api/src
git mv server/* apps/api/src/
```
Expected: `apps/api/src/index.js`, `store.js`, `agents/`, `tests/`, etc. `server/` is now empty/removed.

- [ ] **Step 2: Fix the data-dir default (paths shifted one level deeper)**

`apps/api/src/store.js` currently resolves the default data dir relative to `server/` (`../data`). After the move it's `apps/api/src/`, so the default must point back to the repo-root `data/`. Change the `DATA_DIR` line:
```js
// DEEM_DATA_DIR wins; default points at the repo-root data/ dir.
const DATA_DIR = process.env.DEEM_DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
```
(3× `..` = `apps/api/src` → repo root, then `data`.)

- [ ] **Step 3: Fix the static-serve path to the web build**

In `apps/api/src/index.js`, the static block currently is:
```js
const dist = path.join(__dirname, '..', 'dist');
```
Change it to point at the web app's Nx build output (served in prod), and keep the SPA fallback intact:
```js
// In production the api serves apps/web's Vite build. DEEM_WEB_DIST lets
// deploys/e2e override the location; default is the Nx output dir.
const dist = process.env.DEEM_WEB_DIST || path.join(__dirname, '..', '..', '..', 'dist', 'apps', 'web');
```
Leave the `if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get(/^(?!\/api).*/, …) }` block otherwise unchanged. Keep `const PORT = process.env.DEEM_PORT || 4501;` as-is.

- [ ] **Step 4: Add a jsconfig so editors/Nx treat it as a JS project (not type-checked)**

Create `apps/api/jsconfig.json`:
```json
{
  "compilerOptions": {
    "checkJs": false,
    "allowJs": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022"
  },
  "include": ["src/**/*.js"]
}
```

- [ ] **Step 5: Add the Nx project with serve/build/test targets**

Create `apps/api/project.json`:
```json
{
  "name": "api",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "projectType": "application",
  "sourceRoot": "apps/api/src",
  "targets": {
    "serve": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --watch apps/api/src/index.js",
        "env": { "DEEM_PORT": "4501" }
      }
    },
    "build": {
      "executor": "nx:run-commands",
      "outputs": ["{workspaceRoot}/dist/apps/api"],
      "options": {
        "command": "node -e \"require('node:fs').cpSync('apps/api/src','dist/apps/api',{recursive:true})\""
      }
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test apps/api/src/tests/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 6: Verify api tests still pass after the move**

Run:
```bash
npx nx test api
```
Expected: the three suites (`mock`, `verify`, `workspace`) run and pass, exactly as they did under `server/tests/`. If a test fails on a moved path, fix the relative path in that test file (the move shifted nothing within `src/`, so imports like `../store.js` are unchanged — only failures would be from tests that referenced `../../` outside `server/`).

- [ ] **Step 7: Verify the server boots and health responds**

Run (in one shell, background it, then curl):
```bash
DEEM_PORT=4501 node apps/api/src/index.js & sleep 1; curl -s localhost:4501/api/health; kill %1
```
Expected: a JSON health payload (non-error). The static block logs nothing because `dist/apps/web` doesn't exist yet — that's expected until Task 4.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "refactor(api): relocate Express server into apps/api (JS), Nx targets, fixed data/web paths"
```

---

## Task 4: `apps/web` — React + Vite + TypeScript

**Files:**
- Create: `apps/web/project.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/tsconfig.app.json`, `apps/web/index.html`
- Move + convert: `web/src/*.jsx|*.js` → `apps/web/src/*.tsx|*.ts`
- Create: `apps/web/src/api.ts`, `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: `@deem/shared` types (Task 2); the api on `:4501` (Task 3).
- Produces: `nx build web` → `dist/apps/web`; `nx serve web` on `:4500` proxying `/api`.

- [ ] **Step 1: Generate the React app (Vite, TS)**

Run:
```bash
npx nx g @nx/react:app web --directory=apps/web --bundler=vite --unitTestRunner=none --e2eTestRunner=none --style=css --routing=false --no-interactive
```
Expected: creates `apps/web` with a TS/Vite skeleton (`src/main.tsx`, `app/`, `vite.config.ts`, tsconfigs, `project.json`, `index.html`). You will replace the skeleton `src` with the ported Deem UI below.

- [ ] **Step 2: Port the HTML entry**

Replace `apps/web/index.html` `<body>` to mount `#root` and keep the title:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Deem</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Move source files and rename to TS/TSX**

Run:
```bash
git rm -r apps/web/src/app 2>/dev/null; true   # drop the generated skeleton component
git mv web/src/styles.css apps/web/src/styles.css
for f in App Home Project TaskDetail TaskLog Chat Login; do :; done
# Move + rename each component (jsx→tsx), the client (js→ts):
git mv web/src/App.jsx apps/web/src/App.tsx
git mv web/src/pages apps/web/src/pages
git mv web/src/components apps/web/src/components
git mv web/src/api.js apps/web/src/api.ts
git mv web/src/main.jsx apps/web/src/main.tsx
# Rename page/component extensions:
for f in $(git ls-files apps/web/src/pages apps/web/src/components | grep '\.jsx$'); do git mv "$f" "${f%.jsx}.tsx"; done
```
Expected: `apps/web/src` now holds `App.tsx`, `pages/*.tsx`, `components/ui.tsx`, `api.ts`, `main.tsx`, `styles.css`. `web/` is empty.

- [ ] **Step 4: Fix import extensions and entry**

Replace `apps/web/src/main.tsx` (drop `.jsx` extensions; extensionless TS imports):
```tsx
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import App from './App';
import Home from './pages/Home';
import Project from './pages/Project';
import TaskDetail from './pages/TaskDetail';
import TaskLog from './pages/TaskLog';
import Chat from './pages/Chat';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'projects/:projectId', element: <Project /> },
      { path: 'tasks/:taskId', element: <TaskDetail /> },
      { path: 'tasks/:taskId/log', element: <TaskLog /> },
      { path: 'chat', element: <Chat /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
```

- [ ] **Step 5: Type the API client**

Replace `apps/web/src/api.ts`:
```ts
import { useEffect, DependencyList } from 'react';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
  return data as T;
}

export const api = {
  get: <T = unknown>(url: string) => req<T>('GET', url),
  post: <T = unknown>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  patch: <T = unknown>(url: string, body: unknown) => req<T>('PATCH', url, body),
  del: <T = unknown>(url: string) => req<T>('DELETE', url),
};

type EventHandler = (type: string, payload: any) => void;
let source: EventSource | null = null;
const listeners = new Set<EventHandler>();

function ensureSource(): void {
  if (source) return;
  source = new EventSource('/api/events');
  for (const type of ['task', 'phase', 'log', 'activity', 'projects', 'chat']) {
    source.addEventListener(type, (e) => {
      const payload = JSON.parse((e as MessageEvent).data);
      for (const fn of listeners) fn(type, payload);
    });
  }
}

export function useEvents(handler: EventHandler, deps: DependencyList = []): void {
  useEffect(() => {
    ensureSource();
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, deps);
}

export const fmtDate = (ts: number): string =>
  new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
```

- [ ] **Step 6: Port the components to compile under `strict`**

For each `apps/web/src/**/*.tsx` (App, Home, Project, TaskDetail, TaskLog, Chat, Login, components/ui), apply this mechanical recipe — the logic and JSX stay identical:
1. Remove `.jsx`/`.js` from local import paths (`./pages/Home.jsx` → `./pages/Home`, `../api.js` → `../api`).
2. Delete `import React from 'react'` if present (the `react-jsx` runtime doesn't need it); keep named hook imports (`useState`, etc.).
3. Type the data the component fetches using `@deem/shared` — e.g. in `Home.tsx`: `const [dash, setDash] = useState<Dashboard | null>(null);` and `api.get<Dashboard>('/api/dashboard')`; in `Project.tsx`: `useState<Project | null>(null)` + `api.get<Project>(...)`; in `App.tsx`: `useState<Profile | null | undefined>(undefined)`; in the settings form: `Settings`. Import from `@deem/shared`.
4. Type component props and event handlers minimally: `({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void })`, `(e: React.FormEvent) => …`, `(e: React.ChangeEvent<HTMLInputElement>) => …`.
5. For `useParams`, cast: `const { projectId } = useParams<{ projectId: string }>();`.

The **strict `nx build web` in Step 8 is the gate** — iterate until it compiles with zero errors. Where a server payload is genuinely untyped, add the field to the appropriate interface in `@deem/shared` rather than using `any`.

- [ ] **Step 7: Configure Vite (proxy + output) and project targets**

Replace `apps/web/vite.config.ts` (keep Nx's plugin set; add the dev proxy and output dir):
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
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
```
Ensure `apps/web/tsconfig.app.json` `extends` `../../tsconfig.base.json` and includes `src`. If Nx generated a `project.json` with `@nx/vite:build`/`@nx/vite:dev-server` targets, leave them — they honor this `vite.config.ts`.

- [ ] **Step 8: Build the web app (strict typecheck gate)**

Run:
```bash
npx nx build web
```
Expected: Vite build succeeds, emits `dist/apps/web/index.html` + assets, **zero TS errors**. Fix type errors per Step 6 until clean.

- [ ] **Step 9: Smoke-test web ↔ api together**

Run:
```bash
DEEM_PORT=4501 node apps/api/src/index.js & sleep 1
npx nx serve web & sleep 4
curl -s localhost:4500/ | grep -q '<div id="root">' && echo WEB_OK
curl -s localhost:4500/api/health && echo API_PROXY_OK
kill %1 %2 2>/dev/null
```
Expected: `WEB_OK` and a health JSON via the proxy (`API_PROXY_OK`).

- [ ] **Step 10: Commit**

```bash
git add apps/web tsconfig.base.json
git commit -m "feat(web): migrate React frontend to apps/web (TypeScript + Vite + @deem/shared)"
```

---

## Task 5: `apps/web-e2e` — browser Playwright

**Files:**
- Create: `apps/web-e2e/project.json`, `apps/web-e2e/playwright.config.ts`
- Create: `apps/web-e2e/src/fixtures/temp-repo.ts`
- Create: `apps/web-e2e/src/pages/{LoginPage,AppShell,HomePage,ProjectPage,TaskPage,SettingsModal}.ts`
- Create: `apps/web-e2e/src/specs/{01-launch,02-project-and-task,03-settings-and-export}.spec.ts`

**Interfaces:**
- Consumes: the built api + web (Task 3/4). Reuses the POM class/method names from the retired Electron suite.
- Produces: `nx e2e web-e2e` green (browser).

- [ ] **Step 1: Generate the Playwright project**

Run:
```bash
npx nx g @nx/playwright:configuration --project=web-e2e --directory=apps/web-e2e --no-interactive 2>/dev/null || npx nx g @nx/playwright:e2e-project --project=web-e2e --no-interactive
```
Expected: creates `apps/web-e2e` with a `playwright.config.ts` and `project.json` exposing an `e2e` target. (Generator name varies by Nx version — the fallback covers it.)

- [ ] **Step 2: Configure Playwright to boot the built app under isolation**

Replace `apps/web-e2e/playwright.config.ts`:
```ts
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
    command: `npx nx build web && DEEM_PORT=${PORT} DEEM_DATA_DIR=${dataDir} DEEM_WEB_DIST=${join(root, 'dist', 'apps', 'web')} node apps/api/src/index.js`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    cwd: root,
  },
});
```

- [ ] **Step 3: Port the temp-repo helper**

Create `apps/web-e2e/src/fixtures/temp-repo.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Project creation triggers real git ops in the api, so give it a throwaway repo.
export function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deem-e2e-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@deem.test']);
  git(['config', 'user.name', 'Deem E2E']);
  writeFileSync(join(dir, 'README.md'), '# e2e fixture repo\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit']);
  return dir;
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Port the Page Objects (browser `Page`, unchanged selectors)**

Create the six POMs under `apps/web-e2e/src/pages/`. They are the exact selector logic from the retired Electron suite, now taking a Playwright `Page`. `LoginPage.ts`:
```ts
import { Page } from '@playwright/test';

export class LoginPage {
  constructor(private page: Page) {}
  async register(name: string, email: string, password: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click();
    await this.page.getByLabel('Name').fill(name);
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Create account & enter' }).click();
  }
}
```
`AppShell.ts`:
```ts
import { Page } from '@playwright/test';
export class AppShell {
  constructor(private page: Page) {}
  openSettings(): Promise<void> {
    return this.page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
}
```
`HomePage.ts`:
```ts
import { Page, Locator } from '@playwright/test';
export class HomePage {
  constructor(private page: Page) {}
  dashboardHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Operational Dashboard' });
  }
  async createProject(opts: { name: string; description?: string; repoPath: string }): Promise<void> {
    await this.page.getByRole('button', { name: 'Add New Project' }).click();
    await this.page.getByLabel('Project name').fill(opts.name);
    if (opts.description) await this.page.getByLabel('Description').fill(opts.description);
    await this.page.getByLabel('Local repository path').fill(opts.repoPath);
    await this.page.getByRole('combobox', { name: 'Agent' }).selectOption({ label: 'Mock runner (no API cost)' });
    await this.page.getByRole('button', { name: 'Create project' }).click();
  }
}
```
`ProjectPage.ts`:
```ts
import { Page, Locator } from '@playwright/test';
export class ProjectPage {
  constructor(private page: Page) {}
  heading(name: string): Locator { return this.page.getByRole('heading', { name }); }
  async createTask(opts: { name: string; description?: string; requirements?: string[] }): Promise<void> {
    await this.page.getByRole('button', { name: '+ New Task' }).click();
    await this.page.getByLabel('Task name').fill(opts.name);
    if (opts.description) await this.page.getByLabel('Description').fill(opts.description);
    if (opts.requirements?.length) await this.page.getByLabel('Requirements').fill(opts.requirements.join('\n'));
    await this.page.getByRole('button', { name: 'Create task' }).click();
  }
}
```
`TaskPage.ts`:
```ts
import { Page, Locator } from '@playwright/test';
export class TaskPage {
  constructor(private page: Page) {}
  heading(name: string): Locator { return this.page.getByRole('heading', { name }); }
  backToProjectLink(): Locator { return this.page.getByRole('link', { name: 'Back to Project' }); }
  exportTaskButton(): Locator { return this.page.getByRole('button', { name: 'Export Task.md' }); }
}
```
`SettingsModal.ts`:
```ts
import { Page, Locator } from '@playwright/test';
export class SettingsModal {
  constructor(private page: Page) {}
  heading(): Locator { return this.page.getByRole('heading', { name: 'Integrations & budgets' }); }
  budgetInput(): Locator { return this.page.getByLabel('Default token budget per task'); }
  async setBudget(value: number): Promise<void> {
    await this.budgetInput().fill(String(value));
    await this.page.getByRole('button', { name: 'Save settings' }).click();
  }
}
```

- [ ] **Step 5: Write the three browser specs**

Create `apps/web-e2e/src/specs/01-launch.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';

test('Flow 1: title and dashboard after registering', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Deem');
  const login = new LoginPage(page);
  const home = new HomePage(page);
  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
  await expect(home.dashboardHeading()).toBeVisible();
  await expect(page.getByText('Running now')).toBeVisible();
});
```
Create `apps/web-e2e/src/specs/02-project-and-task.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';
import { TaskPage } from '../pages/TaskPage';
import { makeTempRepo, cleanupDir } from '../fixtures/temp-repo';

test('Flow 2: create a project and a task', async ({ page }) => {
  const repo = makeTempRepo();
  try {
    const login = new LoginPage(page);
    const home = new HomePage(page);
    const project = new ProjectPage(page);
    const taskPage = new TaskPage(page);
    await page.goto('/');
    await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
    await expect(home.dashboardHeading()).toBeVisible();
    await home.createProject({ name: 'Q3 Marketing Launch', description: 'E2E', repoPath: repo });
    await expect(project.heading('Q3 Marketing Launch')).toBeVisible();
    await project.createTask({ name: 'Wire up landing page', requirements: ['User can submit the form'] });
    await expect(taskPage.heading('Wire up landing page')).toBeVisible();
    await expect(taskPage.backToProjectLink()).toBeVisible();
    await taskPage.backToProjectLink().click();
    await expect(project.heading('Q3 Marketing Launch')).toBeVisible();
    await expect(page.getByText('Wire up landing page')).toBeVisible();
  } finally {
    cleanupDir(repo);
  }
});
```

Create `apps/web-e2e/src/specs/03-settings-and-export.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';
import { TaskPage } from '../pages/TaskPage';
import { AppShell } from '../pages/AppShell';
import { SettingsModal } from '../pages/SettingsModal';
import { makeTempRepo, cleanupDir } from '../fixtures/temp-repo';

test('Flow 3a: settings budget persists across reopen', async ({ page }) => {
  const login = new LoginPage(page);
  const shell = new AppShell(page);
  const settings = new SettingsModal(page);
  await page.goto('/');
  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
  await shell.openSettings();
  await expect(settings.heading()).toBeVisible();
  await settings.setBudget(250000);
  await expect(settings.heading()).toBeHidden();
  await shell.openSettings();
  await expect(settings.budgetInput()).toHaveValue('250000');
});

test('Flow 3b: export opens a new browser tab at the export URL', async ({ page, context }) => {
  const repo = makeTempRepo();
  try {
    const login = new LoginPage(page);
    const home = new HomePage(page);
    const project = new ProjectPage(page);
    const taskPage = new TaskPage(page);
    await page.goto('/');
    await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
    await home.createProject({ name: 'Export Proj', repoPath: repo });
    await expect(project.heading('Export Proj')).toBeVisible();
    await project.createTask({ name: 'Exportable task' });
    await expect(taskPage.heading('Exportable task')).toBeVisible();
    // window.open('/api/tasks/:id/export/task','_blank') opens a new tab.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      taskPage.exportTaskButton().click(),
    ]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    expect(popup.url()).toContain('/api/tasks/');
    expect(popup.url()).toContain('/export/task');
    await popup.close();
  } finally {
    cleanupDir(repo);
  }
});
```

- [ ] **Step 6: Run the browser e2e**

Run:
```bash
npx nx e2e web-e2e
```
Expected: Playwright starts the webServer (builds web, boots api serving it under the temp data dir on 4599), then `5 passed` (Flows 1, 2, 3a, 3b). Debug against real behavior: if Flow 3b's popup URL is a download that never commits, assert on `context.waitForEvent('page')` firing (a new tab was opened) and skip the `waitForLoadState`; if project creation 400s, confirm `makeTempRepo` produced a committed repo.

- [ ] **Step 7: Commit**

```bash
git add apps/web-e2e
git commit -m "test(web-e2e): browser Playwright suite (launch, project/task, settings/export)"
```

---

## Task 6: Remove Electron, wire root scripts, docs, CI

**Files:**
- Delete: `electron/`, `tests/e2e/`, root `dist/` (if present), the `electron` devDep, dead root scripts
- Modify: `package.json` (root scripts), `README.md`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: an Electron-free, Nx-driven repo; root `npm run dev/build/test` delegate to Nx; CI runs affected lint/test/build/e2e.

- [ ] **Step 1: Delete Electron and the old Electron e2e harness**

Run:
```bash
git rm -r electron tests/e2e
git rm -r dist 2>/dev/null; true
```
Expected: those paths removed. (`tests/` may now be empty — remove it if so.)

- [ ] **Step 2: Drop the Electron dependency and rewrite root scripts**

Modify `package.json`: remove `"electron"` from `devDependencies` and remove `@playwright/test`/`concurrency`-only leftovers that Nx now owns only if unused. Replace the `scripts` block with thin Nx wrappers:
```json
  "scripts": {
    "dev": "nx run-many -t serve -p api web",
    "build": "nx run-many -t build -p web api",
    "start": "node apps/api/src/index.js",
    "test": "nx test api",
    "e2e": "nx e2e web-e2e"
  },
```
Then run `npm install` to prune the removed `electron` package.

- [ ] **Step 3: Verify no Electron references remain in product code**

Run:
```bash
git grep -il electron -- ':!docs' ':!*.md' ':!package-lock.json'
```
Expected: no output (all Electron code is gone; docs/history may still mention it).

- [ ] **Step 4: Update the README to web-only**

In `README.md`, replace the "Quick start" commands with the Nx workflow and drop the desktop/`npm run app` line:
```markdown
## Quick start

```bash
npm install
npm run dev     # nx serves api (:4501) + web (:4500, proxying /api)
npm run build   # builds web + api into dist/apps/*
npm test        # api tests (node:test)
npm run e2e     # browser Playwright e2e
```

Deem is now a web application (the Electron desktop shell was removed).
```

- [ ] **Step 5: Add CI**

Create `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx nx run-many -t lint test build e2e --parallel=3
```

- [ ] **Step 6: Full local verification**

Run:
```bash
npm run build && npm test && npm run e2e
```
Expected: web + api build; api tests pass; browser e2e `5 passed`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove Electron, wire Nx root scripts + CI, web-only docs"
```

---

## Self-Review

**Spec coverage:**
- §3 workspace/in-place init, plugins, alias → Task 1. ✓
- §3/§5 libs/shared TS contract → Task 2. ✓
- §3/§5 apps/api relocated as JS, node:test target, static/data path fixes, prod-serves-web → Task 3 (+ Task 4 Step 9 smoke). ✓
- §4/§5 apps/web React+Vite+TS, `@deem/shared`, `/api` proxy → Task 4. ✓
- §7 browser Playwright, POM reuse, temp-repo, 3 flows, popup-via-`waitForEvent('page')` → Task 5. ✓
- §3 remove Electron; §6 root scripts; §6 CI; §9 docs → Task 6. ✓
- §11 out-of-scope (deemsvc/db/packaging) → not touched. ✓

**Placeholder scan:** no TBD/TODO; every step carries complete code or an exact command. ✓

**Type/name consistency:** `@deem/shared` exports (`Profile`/`Settings`/`Project`/`Task`/`Dashboard`/`Agent`) are defined in Task 2 and consumed by name in Task 4 Step 6. POM class/method names (`register`, `dashboardHeading`, `createProject`, `heading`, `createTask`, `backToProjectLink`, `exportTaskButton`, `openSettings`, `setBudget`, `budgetInput`) are consistent between Task 5 Steps 4 and 5. Ports (`4500`/`4501`/`4599`) and env names (`DEEM_PORT`/`DEEM_DATA_DIR`/`DEEM_WEB_DIST`) are consistent across Tasks 3–5. ✓

**Note on Nx version variance:** generator flags/output differ across Nx majors. Each task gates on a concrete command (`nx test api`, `nx build web`, `nx e2e web-e2e`) rather than on generated file contents — the implementer adapts generated `project.json`/tsconfig to match these gates.
