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
// apps/api/src → repo root is three levels up (post Nx move); deemsvc/ lives there.
const UVICORN = path.join(__dirname, '..', '..', '..', 'deemsvc', '.venv', 'bin', 'uvicorn');
const DEEMSVC_CWD = path.join(__dirname, '..', '..', '..', 'deemsvc');

async function waitForHealth(baseUrl, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

export function startDeemsvc({
  port = 8731,
  // Base restart delay and cap for exponential backoff (see spawnChild's
  // 'exit' handler below): the delay doubles on each consecutive
  // unexpected exit and is capped at maxRestartDelayMs, so a crash-looping
  // deemsvc backs off instead of retrying every restartDelayMs forever.
  // The delay resets to restartDelayMs once a restarted process passes a
  // health check, so a process that ran fine for a long time before a
  // one-off crash restarts promptly rather than inheriting a long delay
  // accumulated by an earlier crash loop.
  restartDelayMs = 2000,
  maxRestartDelayMs = 60_000,
  // Overridable so tests can point the supervisor at a lightweight fixture
  // script instead of spawning the real uvicorn binary.
  command = UVICORN,
  args = ['deemsvc.service.app:app', '--host', '127.0.0.1', '--port', String(port)],
  cwd = DEEMSVC_CWD,
  env = process.env,
  healthTimeoutMs = 15_000,
  healthPollIntervalMs = 200,
} = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let currentDelay = restartDelayMs;

  function spawnChild() {
    child = spawn(command, args, { cwd, env });
    child.stdout.on('data', (chunk) => process.stdout.write(`[deemsvc] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[deemsvc] ${chunk}`));
    child.on('error', (err) => {
      console.error(`[deemsvc] failed to start: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (stopped) return;
      const delay = currentDelay;
      // Grow the backoff now, before scheduling the restart, so a fast
      // crash loop backs off immediately rather than needing a health
      // check to observe the failure.
      currentDelay = Math.min(currentDelay * 2, maxRestartDelayMs);
      console.error(`[deemsvc] exited unexpectedly (code=${code} signal=${signal}) — restarting in ${delay}ms`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (stopped) return;
        spawnChild();
        // If this restart reaches a healthy state, the process wasn't
        // crash-looping — reset the backoff so a later one-off crash
        // restarts promptly instead of inheriting an inflated delay.
        waitForHealth(baseUrl, healthTimeoutMs, healthPollIntervalMs).then((healthy) => {
          if (healthy) currentDelay = restartDelayMs;
        });
      }, delay);
    });
  }

  function stop() {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child) child.kill('SIGTERM');
  }

  spawnChild();

  return waitForHealth(baseUrl, healthTimeoutMs, healthPollIntervalMs).then((healthy) => {
    if (!healthy) {
      // Never came up — stop the supervisor rather than leaving an
      // unreachable restart loop running in the background.
      stop();
      throw new Error('deemsvc did not become healthy within ' + healthTimeoutMs + 'ms');
    }
    return { baseUrl, stop };
  });
}
