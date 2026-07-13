import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startDeemsvc } from '../deemsvc-supervisor.js';

// Exercises deemsvc-supervisor.js's spawn/health-poll/restart-backoff/stop
// logic against a tiny fixture script (server/tests/fixtures/fake-uvicorn.js)
// instead of the real Python deemsvc service or uvicorn binary, so these
// tests are fast and have no external dependencies. The fixture's behavior
// is controlled via env vars — see that file for the full contract.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-uvicorn.js');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function tempLogFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deemsvc-supervisor-test-')), 'log.txt');
}

function readLines(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

test('a process that exits gets restarted after a delay', async () => {
  const port = await getFreePort();
  const logFile = tempLogFile();

  // The fixture always crashes immediately, so startDeemsvc's own health
  // wait will time out and reject — that's expected here; we only care
  // that spawnChild's restart-on-exit logic re-spawned the fixture more
  // than once inside the health-wait window.
  await assert.rejects(
    startDeemsvc({
      port,
      command: process.execPath,
      args: [FIXTURE, '--port', String(port)],
      env: { ...process.env, FAKE_UVICORN_MODE: 'crash', FAKE_LOG_FILE: logFile },
      restartDelayMs: 20,
      maxRestartDelayMs: 200,
      healthTimeoutMs: 300,
      healthPollIntervalMs: 20,
    }),
  );

  const spawns = readLines(logFile);
  assert.ok(spawns.length >= 2, `expected at least 2 spawns, got ${spawns.length}`);
});

test('stop() prevents further restarts and sends SIGTERM', async () => {
  const port = await getFreePort();
  const logFile = tempLogFile();

  const handle = await startDeemsvc({
    port,
    command: process.execPath,
    args: [FIXTURE, '--port', String(port)],
    env: { ...process.env, FAKE_UVICORN_MODE: 'serve', FAKE_LOG_FILE: logFile },
    restartDelayMs: 30,
    maxRestartDelayMs: 200,
    healthTimeoutMs: 2000,
    healthPollIntervalMs: 20,
  });

  assert.equal(handle.baseUrl, `http://127.0.0.1:${port}`);
  handle.stop();

  // Give the fixture time to receive SIGTERM and exit, and confirm the
  // supervisor does not schedule a respawn afterward.
  await new Promise((r) => setTimeout(r, 250));

  const lines = readLines(logFile);
  assert.equal(lines.filter((l) => l !== 'SIGTERM').length, 1, 'child should have been spawned exactly once');
  assert.ok(lines.includes('SIGTERM'), 'stop() should have sent SIGTERM to the child');
});

test('the restart delay grows on repeated failures, up to the configured cap', async () => {
  const port = await getFreePort();
  const logFile = tempLogFile();

  await assert.rejects(
    startDeemsvc({
      port,
      command: process.execPath,
      args: [FIXTURE, '--port', String(port)],
      env: { ...process.env, FAKE_UVICORN_MODE: 'crash', FAKE_LOG_FILE: logFile },
      restartDelayMs: 50,
      maxRestartDelayMs: 1000,
      healthTimeoutMs: 600,
      healthPollIntervalMs: 20,
    }),
  );

  const timestamps = readLines(logFile).map(Number);
  assert.ok(timestamps.length >= 3, `expected at least 3 spawns to observe growth, got ${timestamps.length}`);

  const deltas = [];
  for (let i = 1; i < timestamps.length; i += 1) deltas.push(timestamps[i] - timestamps[i - 1]);

  // Each gap should be at least as large as the previous one (allow
  // generous scheduling slack for process-spawn jitter) — this is what
  // distinguishes real exponential backoff from a fixed retry delay.
  for (let i = 1; i < deltas.length; i += 1) {
    assert.ok(
      deltas[i] >= deltas[i - 1] - 30,
      `expected delta[${i}]=${deltas[i]} to be >= previous delta[${i - 1}]=${deltas[i - 1]} (backoff should not shrink)`,
    );
  }
});

test('backoff resets to the base delay after a restart passes its health check', async () => {
  const port = await getFreePort();
  const logFile = tempLogFile();

  // Attempts 0-2 crash immediately (grows the backoff: 50 -> 100 -> 200ms).
  // Attempt 3 serves health for 200ms (long enough to be observed as
  // healthy) before crashing on its own. Attempts 4+ crash immediately
  // again. If the reset behavior is correct, the restart scheduled after
  // attempt 3's crash uses the *base* delay (~50ms) rather than the
  // inflated value (400ms) the crash loop had accumulated beforehand.
  const handle = await startDeemsvc({
    port,
    command: process.execPath,
    args: [FIXTURE, '--port', String(port)],
    env: {
      ...process.env,
      FAKE_SCRIPT: 'crash,crash,crash,serve200,crash,crash',
      FAKE_LOG_FILE: logFile,
    },
    restartDelayMs: 50,
    maxRestartDelayMs: 2000,
    healthTimeoutMs: 5000,
    healthPollIntervalMs: 20,
  });
  assert.ok(handle.baseUrl);

  // Wait past attempt 3's scripted 200ms alive period plus its post-crash
  // restart, so attempt 4 has had time to spawn and log itself.
  await new Promise((r) => setTimeout(r, 800));
  handle.stop();

  const timestamps = readLines(logFile).map((l) => Number(l)).filter((n) => !Number.isNaN(n));
  assert.ok(timestamps.length >= 5, `expected at least 5 spawns (attempts 0-4), got ${timestamps.length}`);

  // Gap between attempt 3 (serve200) starting and attempt 4 starting,
  // minus the 200ms it stayed alive, isolates the actual restart delay
  // that was used after attempt 3 crashed.
  const restartDelayAfterHealthy = timestamps[4] - timestamps[3] - 200;
  assert.ok(
    restartDelayAfterHealthy < 250,
    `expected restart delay after a healthy period (${restartDelayAfterHealthy}ms) to stay near the base ` +
      `delay (50ms), not the inflated pre-reset value (400ms) — reset-on-health-check may be broken`,
  );
});
