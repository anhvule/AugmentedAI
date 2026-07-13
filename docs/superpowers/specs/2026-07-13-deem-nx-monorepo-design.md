# Deem → Nx Monorepo (React + TS + browser E2E) — Design

**Date:** 2026-07-13
**Status:** Approved for planning
**Author:** paired with product owner

## 1. Goal

Convert Deem from its current ad-hoc multi-folder layout into an **Nx monorepo**,
**remove Electron entirely** (Deem becomes a pure web app), **migrate the
JavaScript/JSX source to TypeScript**, and provide a **browser-based Playwright
e2e** project. The Python `deemsvc` stays as a sibling outside the Nx graph.

## 2. Current state (baseline)

- `web/` — React 18 + Vite, all `.jsx`/`.js` (10 source files), no TypeScript.
- `server/` — Express, Node ESM (`"type": "module"`), `node:test` suites in
  `server/tests/`. Serves the built UI from `dist/` and exposes `/api/*`. Binds
  `process.env.DEEM_PORT || 4501` (note: does **not** read Heroku's `$PORT`
  today); data persists to a JSON store whose dir is
  `process.env.DEEM_DATA_DIR || <repo>/data`.
- `electron/main.cjs` — desktop shell; boots the server in its main process and
  loads `http://localhost:PORT`. **To be deleted.**
- `tests/e2e/` — the Playwright **Electron** suite (launches the desktop app via
  `_electron`). **Replaced** by a browser e2e project; POMs are reused.
- `deemsvc/` — Python service (`pyproject.toml`). Untouched, outside Nx.
- npm (`package-lock.json`).

## 3. Decisions

| Decision | Choice |
|----------|--------|
| Workspace | Nx (latest), npm, **initialized in place** to preserve git history, `deemsvc`, `docs` |
| Electron | **Removed completely** — shell, `electron` devDep, `app` script, e2e Electron harness |
| Language | **Migrate JS/JSX → TS/TSX** across web + api |
| Web bundler | **Vite** (keep current), via `@nx/vite` |
| API | `@nx/node` (esbuild), Express |
| E2E | `@nx/playwright`, **browser** (Chromium) — retire the Electron suite |
| Shared code | `libs/shared` (`@deem/shared`) for the web/api API-contract types |
| API tests | Migrate `node:test` → **Vitest** under `apps/api` (single Nx test runner) |
| Prod topology | **api serves the built web** (`dist/apps/web`) + `/api` — same single-service model as today |

## 4. Target layout

```
/ (Nx workspace root)
  nx.json
  tsconfig.base.json          # path aliases: @deem/shared
  package.json                # root scripts delegate to nx
  apps/
    web/                      # React + Vite + TS      (from web/)
      index.html
      src/ main.tsx, app/, pages/*.tsx, components/, api.ts, styles.css
      vite.config.ts, tsconfig*.json, project.json
    api/                      # Express + TS           (from server/)
      src/ main.ts, app.ts, store.ts, auth.ts, routes/…, *.spec.ts (vitest)
      tsconfig*.json, project.json
    web-e2e/                  # Playwright browser e2e (replaces tests/e2e)
      src/ specs/, pages/ (reused POMs, TS), fixtures/temp-repo.ts
      playwright.config.ts, project.json
  libs/
    shared/                   # @deem/shared — shared TS types (API contract)
      src/ index.ts, types.ts
  deemsvc/                    # Python — untouched, outside Nx
  docs/ · data/ · demo-target/  # kept
```

Removed: `electron/`, root `dist/` (Nx emits to `dist/apps/*`), `tests/e2e/`
(Electron harness), root `app`/`build`/`dev`/`start`/`test:e2e` scripts
(replaced by Nx targets and root convenience scripts that call `nx`).

## 5. Components & data flow

- **apps/web** — React SPA. `api.ts` calls `/api/*`. Dev: Vite dev server on one
  port with a **proxy** for `/api` → the api port. Build → `dist/apps/web`.
- **apps/api** — Express. In dev, `nx serve api` runs a watch build on port
  `4501`. In prod, `nx build api` bundles to `dist/apps/api`; the server serves
  `dist/apps/web` statically (SPA fallback) plus `/api/*` — mirroring the
  current `server/index.js` static block. The `DEEM_DATA_DIR` env override is
  preserved (used by e2e isolation).
- **libs/shared** — TypeScript interfaces for the request/response payloads that
  both web and api use (projects, tasks, settings, profile). Imported as
  `@deem/shared`. This is where the TS migration earns its keep.

## 6. Dev / build / task orchestration

- `nx serve web` + `nx serve api` (or `nx run-many -t serve`) for local dev;
  root `npm run dev` delegates to `nx run-many -t serve`.
- `nx build web && nx build api` for production; root `npm run build` delegates.
- `nx test api` (vitest), `nx e2e web-e2e` (playwright), `nx lint` per project.
- Nx caching + project graph come for free; CI can `nx affected -t lint test build`.

## 7. E2E (browser Playwright)

- `@nx/playwright` scaffolds `apps/web-e2e` with a `webServer` block that boots
  the app (built api serving the built web) on a **test port** with an isolated
  **`DEEM_DATA_DIR`** (fresh temp dir per run) so tests never touch real data.
- **POM reuse:** `LoginPage`, `HomePage`, `ProjectPage`, `TaskPage`,
  `SettingsModal` port from the Electron suite almost unchanged (role/text/label
  selectors are browser-agnostic). The `_electron` fixture is dropped; specs use
  Playwright's `page`/`context`.
- **temp-repo helper** stays (Node-side): project creation still triggers real
  git operations in the api, so specs create a throwaway `git init` repo and pass
  its path.
- **Flows carried over:** (1) launch → dashboard visible after registering;
  (2) create project (temp repo) → create task → task detail + list;
  (3) settings budget persists across reopen. The former Electron
  "export opens a new window" assertion becomes a **browser popup** check via
  `context.waitForEvent('page')` on the `Export Task.md` `window.open`.

## 8. Migration approach & phasing

The plan will phase the work so each step stays independently testable:

1. **Scaffold Nx** in place (nx.json, tsconfig.base.json, plugins) — repo still builds.
2. **libs/shared** — extract API-contract types.
3. **apps/api** — move `server/` → TS, wire `@nx/node`, migrate tests to Vitest,
   keep prod static-serve of the web build. `nx test api` green.
4. **apps/web** — move `web/` → TS/TSX, wire `@nx/vite`, `/api` dev proxy.
   `nx build web` + `nx serve web` work against the api.
5. **apps/web-e2e** — browser Playwright, port the POMs + flows. `nx e2e web-e2e` green.
6. **Remove Electron** — delete `electron/`, the `electron` devDep, the old
   `tests/e2e/` harness, and dead root scripts; update docs to "web-only".
7. **Root wiring / CI** — root convenience scripts + an `nx affected` CI workflow.

## 9. Error handling, risk, compatibility

- **Invasive imports:** every import path changes; do it per-project with a green
  build gate at each phase.
- **TS surfacing errors:** ~20 files gain types; expect a type-fixing pass. Start
  `strict` but allow targeted `// TODO(types)` only where a payload shape is
  genuinely dynamic, tracked in the shared lib.
- **Prod parity:** the api-serves-web static block must reproduce today's
  behavior (SPA fallback for non-`/api` routes). Verified against
  `server/index.js`'s existing static section.
- **`deemsvc`** is not an Nx project; its own `pyproject.toml`/pytest flow is
  unaffected.

## 10. Relationship to the open E2E PR

The current Electron e2e suite lives in PR #3 (branch `e2e-playwright-suite`).
This conversion **retires** that suite in favor of a browser e2e. Decide at
integration time whether to close PR #3 unmerged or merge it first then delete
the Electron harness here. This migration branches from `main` and does not
depend on that PR.

## 11. Out of scope (YAGNI)

- Porting `deemsvc` (Python) into the Nx graph.
- Auto-update / desktop packaging (Electron is gone).
- Reworking the JSON store into a database (still `DEEM_DATA_DIR` JSON).
- New product features — this is a structural/tooling migration only.
