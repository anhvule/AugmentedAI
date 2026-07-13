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
      // Widened from the original 300ms to give real subprocess spawn
      // overhead more margin to still observe >=2 spawns reliably in CI.
      healthTimeoutMs: 450,
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
      // Base delay is large enough (150ms, doubling to 300/600/...) that
      // real Node subprocess spawn overhead (observed ~100-150ms per spawn
      // on typical dev/CI hardware) stays a minority of each measured gap,
      // so the growth-ratio assertion below isn't swamped by that overhead.
      restartDelayMs: 150,
      maxRestartDelayMs: 3000,
      healthTimeoutMs: 2000,
      healthPollIntervalMs: 20,
    }),
  );

  const timestamps = readLines(logFile).map(Number);
  assert.ok(timestamps.length >= 3, `expected at least 3 spawns to observe growth, got ${timestamps.length}`);

  const deltas = [];
  for (let i = 1; i < timestamps.length; i += 1) deltas.push(timestamps[i] - timestamps[i - 1]);
  assert.ok(deltas.length >= 2, `expected at least 2 deltas to compare growth, got ${deltas.length}`);

  // Each gap should be at least as large as the previous one (allow
  // generous scheduling slack for process-spawn jitter) — this is what
  // distinguishes real exponential backoff from a fixed retry delay.
  for (let i = 1; i < deltas.length; i += 1) {
    assert.ok(
      deltas[i] >= deltas[i - 1] - 30,
      `expected delta[${i}]=${deltas[i]} to be >= previous delta[${i - 1}]=${deltas[i - 1]} (backoff should not shrink)`,
    );
  }

  // The "non-decreasing" check above would still pass for a constant delay
  // (e.g. every gap ~50ms), so it can't by itself distinguish real
  // exponential growth from the old constant-delay-forever behavior. With
  // restartDelayMs=50 the deltas should roughly double each time (50 -> 100
  // -> 200 -> ...), so require the last observed gap to be clearly larger
  // than the first — a constant delay fails this outright, while doubling
  // clears it with room to spare even after scheduling jitter.
  const firstDelta = deltas[0];
  const lastDelta = deltas[deltas.length - 1];
  assert.ok(
    lastDelta > firstDelta * 1.5,
    `expected the last delta (${lastDelta}ms) to be meaningfully larger than the first (${firstDelta}ms), ` +
      'indicating real exponential growth rather than a constant restart delay',
  );
});

test('backoff resets to the base delay after a restart passes its health check', async () => {
  const port = await getFreePort();
  const logFile = tempLogFile();

  // Attempts 0-2 crash immediately (grows the backoff: 150 -> 300 -> 600ms).
  // Attempt 3 serves health for 300ms (long enough to be observed as
  // healthy) before crashing on its own. Attempts 4+ crash immediately
  // again. If the reset behavior is correct, the restart scheduled after
  // attempt 3's crash uses the *base* delay (~150ms) rather than the
  // inflated value (1200ms) the crash loop had accumulated beforehand.
  // (Base delay bumped up from the original 50ms so real Node subprocess
  // spawn overhead stays a small fraction of each measured gap below.)
  const handle = await startDeemsvc({
    port,
    command: process.execPath,
    args: [FIXTURE, '--port', String(port)],
    env: {
      ...process.env,
      FAKE_SCRIPT: 'crash,crash,crash,serve300,crash,crash',
      FAKE_LOG_FILE: logFile,
    },
    restartDelayMs: 150,
    maxRestartDelayMs: 4000,
    healthTimeoutMs: 4000,
    healthPollIntervalMs: 20,
  });
  assert.ok(handle.baseUrl);

  // Wait past attempt 3's scripted 300ms alive period plus its post-crash
  // restart. Sized for the larger delays above (150+300+600+300+150 =
  // 1500ms of scheduled delay/alive-time) plus generous spawn-overhead
  // margin for 5 subprocess starts.
  await new Promise((r) => setTimeout(r, 2600));
  handle.stop();

  const timestamps = readLines(logFile).map((l) => Number(l)).filter((n) => !Number.isNaN(n));
  assert.ok(timestamps.length >= 5, `expected at least 5 spawns (attempts 0-4), got ${timestamps.length}`);

  // Gap between attempt 2 (crash) and attempt 3 (serve300) starting isolates
  // the backoff delay *before* the reset — it should reflect the grown
  // value (~600ms, i.e. 150 -> 300 -> 600) rather than the base delay. This
  // proves growth actually happened, so the later "it's back down" check
  // below can't be trivially satisfied by a supervisor that never grew the
  // delay in the first place.
  const preResetDelay = timestamps[3] - timestamps[2];
  assert.ok(
    preResetDelay > 400,
    `expected the pre-reset restart delay (${preResetDelay}ms) to reflect grown backoff (~600ms), not the ` +
      'base delay (150ms) — if this fails, the backoff may not be growing at all',
  );

  // Gap between attempt 3 (serve300) starting and attempt 4 starting,
  // minus the 300ms it stayed alive, isolates the actual restart delay
  // that was used after attempt 3 crashed.
  const restartDelayAfterHealthy = timestamps[4] - timestamps[3] - 300;
  assert.ok(
    restartDelayAfterHealthy < 500,
    `expected restart delay after a healthy period (${restartDelayAfterHealthy}ms) to stay near the base ` +
      `delay (150ms), not the inflated pre-reset value (1200ms) — reset-on-health-check may be broken`,
  );
  // The real proof of "reset" is that the post-healthy delay is clearly
  // smaller than the pre-reset delay we just confirmed was grown — not
  // merely that it's some small absolute number (which a supervisor with no
  // growth at all would also satisfy trivially).
  assert.ok(
    restartDelayAfterHealthy < preResetDelay / 2,
    `expected restart delay after a healthy period (${restartDelayAfterHealthy}ms) to be well below the ` +
      `pre-reset delay (${preResetDelay}ms), proving the backoff actually reset rather than staying inflated`,
  );
});

test('stop() during a pending restart delay prevents the scheduled respawn', async () => {
  const port = await getFreePort();
  const logFile = tempLogFile();

  const handle = await startDeemsvc({
    port,
    command: process.execPath,
    args: [FIXTURE, '--port', String(port)],
    env: {
      ...process.env,
      FAKE_UVICORN_MODE: 'serve-then-crash',
      FAKE_EXIT_AFTER_MS: '100',
      FAKE_LOG_FILE: logFile,
    },
    restartDelayMs: 300,
    maxRestartDelayMs: 2000,
    healthTimeoutMs: 2000,
    healthPollIntervalMs: 20,
  });
  assert.ok(handle.baseUrl);

  // Wait past the scripted 100ms alive period so the child has crashed on
  // its own and a restart is now pending, waiting out its (300ms) backoff
  // delay — then call stop() squarely inside that delay window.
  await new Promise((r) => setTimeout(r, 180));
  handle.stop();

  // Wait past when the pending restart would have fired (100ms alive +
  // 300ms delay = 400ms from process start) to confirm stop() actually
  // cancelled the scheduled respawn rather than merely racing it.
  await new Promise((r) => setTimeout(r, 350));

  const spawns = readLines(logFile).filter((l) => l !== 'SIGTERM');
  assert.equal(
    spawns.length,
    1,
    `expected exactly 1 spawn (no respawn after stop() during the pending backoff delay), got ${spawns.length}`,
  );
});
