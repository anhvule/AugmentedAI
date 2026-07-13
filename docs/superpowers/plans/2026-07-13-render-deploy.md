# Deploy Deem to Render — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Deem to Render as a single Dockerized web service — the Node `apps/api` serves the built `apps/web` SPA + `/api/*` and supervises the Python `deemsvc` child process — with a persistent disk for the data store.

**Architecture:** One `Dockerfile` (Node 20 + Python 3.11) builds the Nx web bundle and creates the `deemsvc` venv; the container runs `node apps/api/src/index.js`, which binds Render's `$PORT`, serves `dist/apps/web`, and spawns `deemsvc` on `127.0.0.1:8731`. A `render.yaml` Blueprint wires the service, a persistent disk at `/data`, and the `/api/health` check.

**Tech Stack:** Render (Docker runtime), Docker, Node 20 (bookworm), Python 3.11, npm, Nx.

## Global Constraints

- **Branch:** `deploy-render` (off `main`, the Nx layout).
- **Only one product-code change:** the `$PORT` bind in `apps/api/src/index.js`. Everything else is new deploy config (`Dockerfile`, `.dockerignore`, `render.yaml`, README).
- **Port:** the api must bind `process.env.PORT || process.env.DEEM_PORT || 4501` (Render assigns `$PORT`; `DEEM_PORT` kept for local/e2e). deemsvc stays internal on `127.0.0.1:8731`.
- **Build output:** `npm run build` → `dist/apps/web` (served via `DEEM_WEB_DIST` default).
- **Health:** `GET /api/health` is public (auth allowlist) — Render `healthCheckPath`.
- **Persistence:** `DEEM_DATA_DIR=/data`, a mounted disk.
- **deemsvc packaging:** `pip install ./deemsvc` provides `deemsvc/.venv/bin/uvicorn` (deps: fastapi, uvicorn[standard], anthropic; setuptools; `requires-python >=3.11`).
- **Secrets:** `ANTHROPIC_API_KEY` set in Render (`sync: false`); the **mock** agent needs no key. Never commit keys.

---

## File Structure

```
Dockerfile              # Node+Python image: build web, create deemsvc venv, run api
.dockerignore           # keep build context lean / no baked-in state
render.yaml             # Render Blueprint: web service + disk + health + env
apps/api/src/index.js   # MODIFY line 447 only ($PORT bind)
README.md               # ADD "Deploy to Render" section
```

---

## Task 1: Containerize the app (buildable, runnable image)

**Files:**
- Modify: `apps/api/src/index.js:447`
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: nothing.
- Produces: an image whose container binds `$PORT`, serves the SPA at `/`, answers `GET /api/health`, and (best-effort) starts `deemsvc`.

- [ ] **Step 1: Fix the port bind**

Modify `apps/api/src/index.js` line 447. Change:
```js
const PORT = process.env.DEEM_PORT || 4501;
```
to:
```js
// Render (and any PaaS) assigns $PORT; DEEM_PORT stays for local dev / e2e.
const PORT = process.env.PORT || process.env.DEEM_PORT || 4501;
```

- [ ] **Step 2: Write the `.dockerignore`**

Create `.dockerignore` (repo root):
```
node_modules
**/node_modules
.git
dist
.nx
deemsvc/.venv
**/__pycache__
*.pyc
data
test-results
playwright-report
blob-report
*.log
My Movie 2-compressed.mp4
.DS_Store
```

- [ ] **Step 3: Write the `Dockerfile`**

Create `Dockerfile` (repo root):
```dockerfile
# Deem single-container deploy: the Node API serves the built web + /api and
# supervises the Python deemsvc child process, so both runtimes ship together.
FROM node:20-bookworm-slim

# python3 + venv for the deemsvc sidecar the API spawns; git for the agent's
# git operations; ca-certificates for outbound HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first for layer caching. Dev deps (nx/vite) are needed to build.
COPY package.json package-lock.json ./
RUN npm ci

# App source (node_modules/dist/data excluded via .dockerignore).
COPY . .

# Build the web SPA -> dist/apps/web. Disable the Nx daemon in the image build.
ENV NX_DAEMON=false
RUN npm run build

# Create the deemsvc venv the supervisor expects at deemsvc/.venv/bin/uvicorn.
RUN python3 -m venv deemsvc/.venv \
    && deemsvc/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && deemsvc/.venv/bin/pip install --no-cache-dir ./deemsvc

ENV NODE_ENV=production
# Render assigns $PORT at runtime; the API binds it. deemsvc stays internal (8731).
CMD ["node", "apps/api/src/index.js"]
```

- [ ] **Step 4: Build the image**

Run:
```bash
docker build -t deem-deploy-test .
```
Expected: build completes without error; the final stage runs `pip install ./deemsvc` successfully (pulls fastapi/uvicorn/anthropic) and `npm run build` emits `dist/apps/web`.

- [ ] **Step 5: Run the container and verify health + SPA + $PORT**

Run:
```bash
docker rm -f deem-deploy-test 2>/dev/null; \
docker run -d --name deem-deploy-test -e PORT=10000 -e DEEM_DATA_DIR=/data -p 10000:10000 deem-deploy-test && \
sleep 6 && \
echo "HEALTH:" && curl -fs localhost:10000/api/health && echo && \
echo "SPA:" && (curl -fs localhost:10000/ | grep -q 'id="root"' && echo SPA_OK || echo SPA_FAIL)
```
Expected: `HEALTH:` prints a JSON body containing `"ok":true`; `SPA:` prints `SPA_OK`. This proves the api bound the injected `$PORT` (10000), served the built SPA, and the health route is public. (deemsvc may log a startup warning if it needs a key — that's fine; health/SPA must still pass.)

- [ ] **Step 6: Tear down the test container**

Run:
```bash
docker rm -f deem-deploy-test
```
Expected: container removed.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/index.js Dockerfile .dockerignore
git commit -m "feat(deploy): containerize Deem (Node+Python image) + bind \$PORT for Render"
```

---

## Task 2: Render Blueprint + README

**Files:**
- Create: `render.yaml`
- Modify: `README.md` (add a "Deploy to Render" section)

**Interfaces:**
- Consumes: the `Dockerfile` from Task 1.
- Produces: a Render Blueprint that Render can import to provision the service.

- [ ] **Step 1: Write `render.yaml`**

Create `render.yaml` (repo root):
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
        sync: false   # set in the Render dashboard; the mock agent works without it
    disk:
      name: deem-data
      mountPath: /data
      sizeGB: 1
```

- [ ] **Step 2: Validate the Blueprint YAML**

Run:
```bash
node -e "const fs=require('fs');const s=fs.readFileSync('render.yaml','utf8');if(!/type:\s*web/.test(s)||!/dockerfilePath:\s*\.\/Dockerfile/.test(s)||!/healthCheckPath:\s*\/api\/health/.test(s)||!/mountPath:\s*\/data/.test(s)){throw new Error('render.yaml missing a required field')}console.log('render.yaml OK')"
```
Expected: prints `render.yaml OK`. (Confirms the Blueprint declares the docker web service, the Dockerfile path, the health check, and the disk mount that `DEEM_DATA_DIR` points at.)

- [ ] **Step 3: Add the README deploy section**

Append to `README.md` (before any trailing license/footer, else at end):
```markdown
## Deploy to Render

Deem deploys to [Render](https://render.com) as a single Dockerized web
service — the Node API serves the built web app and `/api`, and supervises the
Python `deemsvc` — with a persistent disk for the JSON store.

1. Push this repo to GitHub (or connect it directly in Render).
2. In Render: **New → Blueprint**, point it at this repo. Render reads
   `render.yaml` and provisions the `deem` web service + a 1 GB disk at `/data`.
3. Set `ANTHROPIC_API_KEY` in the service's **Environment** (needed for real /
   deemsvc agents; the **mock** agent runs without it).
4. Deploy. Render builds the `Dockerfile`, runs `node apps/api/src/index.js`
   bound to the assigned `$PORT`, and health-checks `GET /api/health`.

**Notes**
- Data (JSON store + audit log) persists under `DEEM_DATA_DIR=/data` on the
  mounted disk, surviving restarts and deploys.
- Deem drives AI agents against *local* git repositories; a cloud container has
  none, so a hosted deploy is a control-plane / demo, not full desktop parity.
- Local Docker parity: `docker build -t deem . && docker run -e PORT=10000 -p 10000:10000 deem`, then open `http://localhost:10000`.
```

- [ ] **Step 4: Commit**

```bash
git add render.yaml README.md
git commit -m "feat(deploy): Render Blueprint (render.yaml) + deploy docs"
```

---

## Self-Review

**Spec coverage:**
- §4.1 `$PORT` fix → Task 1 Step 1. ✓
- §4.2 Dockerfile (Node+Python, build web, deemsvc venv, CMD) → Task 1 Step 3. ✓
- §4.3 `.dockerignore` → Task 1 Step 2. ✓
- §4.4 `render.yaml` (docker web service, disk, health, env incl. ANTHROPIC_API_KEY sync:false) → Task 2 Step 1. ✓
- §4.5 README deploy section → Task 2 Step 3. ✓
- §7 verification (docker build + run + health + SPA) → Task 1 Steps 4–6. ✓

**Placeholder scan:** no TBD/TODO; every step has exact file content or an exact command with expected output. ✓

**Type/name consistency:** ports (`$PORT`/`DEEM_PORT`/`10000`/`8731`), paths (`dist/apps/web`, `/data`, `deemsvc/.venv/bin/uvicorn`), env names (`NODE_ENV`/`DEEM_DATA_DIR`/`ANTHROPIC_API_KEY`), and the image tag (`deem-deploy-test`) are consistent across tasks. The `render.yaml` `mountPath: /data` matches `DEEM_DATA_DIR=/data`. ✓
