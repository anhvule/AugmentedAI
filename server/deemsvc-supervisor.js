// Spawns and supervises the deemsvc Python service as a managed child
// process — the same spawn()-and-watch shape server/agents/claude.js and
// server/agents/codex.js already use for agent subprocesses (pipe
// stdout/stderr, react to 'error'/'close', let the caller decide what to do
// next). Unlike those per-task, per-run subprocesses, deemsvc is a single
// long-lived singleton the API server boots once and keeps alive for the
// life of the process, restarting it with a backoff if it dies unexpectedly.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UVICORN = path.join(__dirname, '..', 'deemsvc', '.venv', 'bin', 'uvicorn');
const DEEMSVC_CWD = path.join(__dirname, '..', 'deemsvc');

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function startDeemsvc({ port = 8731, restartDelayMs = 2000 } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = null;
  let stopped = false;

  function spawnChild() {
    child = spawn(UVICORN, ['deemsvc.service.app:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: DEEMSVC_CWD,
      env: process.env,
    });
    child.stdout.on('data', (chunk) => process.stdout.write(`[deemsvc] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[deemsvc] ${chunk}`));
    child.on('error', (err) => {
      console.error(`[deemsvc] failed to start: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (stopped) return;
      console.error(`[deemsvc] exited unexpectedly (code=${code} signal=${signal}) — restarting in ${restartDelayMs}ms`);
      setTimeout(spawnChild, restartDelayMs);
    });
  }

  spawnChild();

  return waitForHealth(baseUrl, 15_000).then((healthy) => {
    if (!healthy) throw new Error('deemsvc did not become healthy within 15s');
    return {
      baseUrl,
      stop() {
        stopped = true;
        if (child) child.kill('SIGTERM');
      },
    };
  });
}
