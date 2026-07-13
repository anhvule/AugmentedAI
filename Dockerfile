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
