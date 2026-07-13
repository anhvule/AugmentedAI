# Deploy Deem to Render — Design

**Date:** 2026-07-13
**Status:** Approved for planning
**Branch base:** `main` (Nx monorepo, post PR #4)

## 1. Goal

Deploy Deem to **Render** as a **single Dockerized web service** that builds the
Nx monorepo and runs the Node `apps/api` — which serves the built `apps/web`
SPA and `/api/*`, and supervises the Python `deemsvc` child process — backed by
a **persistent disk** for the data store.

## 2. Why Render (and why one container)

Deem's backend is a long-lived, stateful Express server: it holds SSE
connections (`/api/events`), spawns agent child processes, does git-worktree
work, persists to a JSON file store, runs a background workflow queue + watchdog,
and **supervises a Python `deemsvc` (uvicorn) child process**. This does not fit
serverless (Vercel); it needs a persistent process, which Render's Web Service
provides. Because the api spawns `deemsvc` in-process via `spawn`, both runtimes
must live in one image → a **Dockerfile** (Render's native envs are
single-language).

## 3. Verified facts (main, Nx layout)

- Build: `npm run build` = `nx run-many -t build -p web api`; web emits to
  `dist/apps/web` (`apps/web/vite.config.ts` `outDir: ../../dist/apps/web`).
- Start: `node apps/api/src/index.js`.
- **Port:** `apps/api/src/index.js:447` → `const PORT = process.env.DEEM_PORT || 4501;`
  — does **not** read the platform `$PORT`. Must be fixed for Render.
- **Static serve:** `DEEM_WEB_DIST || <repoRoot>/dist/apps/web` (default resolves
  correctly from `apps/api/src`), with SPA fallback for non-`/api` routes.
- **Health:** `GET /api/health` is in the auth allowlist (`apps/api/src/auth.js`
  `PUBLIC = {'/register','/login','/health'}`) → reachable without a session.
  Suitable for Render's `healthCheckPath`.
- **deemsvc:** started by `startDeemsvc({ port: 8731 })`; the supervisor spawns
  `deemsvc/.venv/bin/uvicorn deemsvc.service.app:app --host 127.0.0.1 --port 8731`
  with cwd `<repoRoot>/deemsvc` (paths already `../../../` from `apps/api/src`).
  Internal only (127.0.0.1) — not exposed. Degrades gracefully if it fails to
  start (index.js wraps `startDeemsvc` in try/catch and continues).
- **deemsvc packaging:** `deemsvc/pyproject.toml` — `requires-python >=3.11`,
  deps `fastapi`, `uvicorn[standard]`, `anthropic`; setuptools build backend,
  packages under `src/`. `pip install ./deemsvc` provides the `uvicorn` binary.

## 4. Deliverables

1. **`apps/api/src/index.js` (1-line fix):**
   `const PORT = process.env.PORT || process.env.DEEM_PORT || 4501;`
   (Render assigns `$PORT`; keep `DEEM_PORT` for local/e2e.) Only product change.
2. **`Dockerfile`** (repo root):
   - `FROM node:20-bookworm-slim`; `apt-get install python3 python3-venv git ca-certificates`.
   - `npm ci` (needs devDeps: nx/vite for the build).
   - `npm run build` → `dist/apps/web`.
   - `python3 -m venv deemsvc/.venv && deemsvc/.venv/bin/pip install ./deemsvc`.
   - `ENV NODE_ENV=production`; `CMD ["node","apps/api/src/index.js"]`.
3. **`.dockerignore`:** `node_modules`, `.git`, `dist`, `deemsvc/.venv`,
   `deemsvc/**/__pycache__`, `data`, `.nx`, `test-results`, `playwright-report`.
4. **`render.yaml`** (Blueprint):
   ```yaml
   services:
     - type: web
       name: deem
       runtime: docker
       dockerfilePath: ./Dockerfile
       healthCheckPath: /api/health
       envVars:
         - key: NODE_ENV
           value: production
         - key: DEEM_DATA_DIR
           value: /data
         - key: ANTHROPIC_API_KEY
           sync: false   # set in Render dashboard; mock agent works without it
       disk:
         name: deem-data
         mountPath: /data
         sizeGB: 1
   ```
5. **README** "Deploy to Render" section (connect repo / Blueprint, set
   `ANTHROPIC_API_KEY`, note the caveats).

## 5. Data flow / runtime

Render builds the image → starts one container → `node apps/api/src/index.js`
binds `$PORT` → serves `dist/apps/web` (SPA) + `/api/*` → on boot spawns
`deemsvc` on `127.0.0.1:8731`. State (JSON store + audit log) writes under
`DEEM_DATA_DIR=/data` on the persistent disk. Render polls `/api/health`.

## 6. Error handling & caveats

- **No `$PORT` fix ⇒ deploy fails** its health check — the one hard blocker,
  addressed by deliverable 1.
- **deemsvc optional at boot** — if the venv/key is missing it logs a warning
  and continues; deemsvc-backed agents error until configured. The **mock**
  agent needs no key.
- **Persistence** — without the disk, the JSON store resets on every deploy;
  the mounted `/data` disk prevents that.
- **Agent-on-local-repos** — Deem operates on *local* git repos; a cloud
  container has none, so this deploy is a hosted control-plane/demo, not full
  desktop parity. (Documented, not "fixed".)

## 7. Verification

- Local `docker build .` succeeds (if Docker is available in the work env);
  `docker run -e PORT=10000 -p 10000:10000 <img>` → `curl /api/health` returns
  `{"ok":true,...}` and `/` serves the SPA (`<div id="root">`).
- If Docker is unavailable locally, verify config by inspection; Render's build
  is the integration test. Do **not** claim a successful deploy without evidence.

## 8. Out of scope (YAGNI)

- Splitting `deemsvc` into a second Render service (one container is simpler;
  revisit if resource isolation is needed).
- A managed database (still JSON-on-disk).
- Vercel/CDN frontend split (chose single-service Render).
- CI-driven deploys — Render auto-builds from the connected branch; no GitHub
  Actions deploy step needed.
