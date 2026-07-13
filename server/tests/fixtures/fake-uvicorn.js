#!/usr/bin/env node
// Stand-in "uvicorn" for deemsvc-supervisor.test.js. Lets tests exercise
// spawn/health-poll/restart/stop behavior without depending on the real
// Python deemsvc service or the actual uvicorn binary.
//
// Controlled entirely by env vars (mirroring how deemsvc-supervisor.js's
// `command`/`args`/`env` options let a caller redirect the spawned
// process). Each time the supervisor restarts, it runs a fresh copy of
// this script (a new OS process), so per-attempt behavior is driven by
// counting this fixture's own prior starts via FAKE_LOG_FILE rather than
// any in-memory state.
//
// FAKE_UVICORN_MODE=serve            (default) — serves GET /health with
//   200 and stays alive until SIGTERM.
// FAKE_UVICORN_MODE=crash            — exits immediately with code 1
//   (simulates a crash-looping service).
// FAKE_UVICORN_MODE=serve-then-crash — serves /health, then after
//   FAKE_EXIT_AFTER_MS milliseconds exits with code 1 (simulates a
//   process that ran fine for a while before a one-off crash).
//
// FAKE_SCRIPT, if set, overrides FAKE_UVICORN_MODE with a comma-separated
// list of per-attempt tokens, e.g. "crash,crash,serve50,crash" — the Nth
// restart of this fixture (0-indexed, counted from FAKE_LOG_FILE) uses the
// Nth token (the last token repeats for any further attempts). Tokens:
// "crash" (exit(1) immediately), "serve" (serve /health forever), or
// "serve<ms>" (serve /health, then exit(1) after <ms> milliseconds).
//
// FAKE_LOG_FILE, if set, gets one line appended per process start,
// formatted as `<epoch-ms-at-start>`, so a test can inspect how many times
// the fixture was spawned and how the intervals between spawns behaved
// (e.g. to assert backoff grows/resets). If the fixture is serving and
// receives SIGTERM, it appends a `SIGTERM` line before exiting, so a test
// can confirm the supervisor's stop() actually signaled the child.
import http from 'node:http';
import fs from 'node:fs';

const logFile = process.env.FAKE_LOG_FILE;

const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 0;

function log(line) {
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
}

function priorAttempts() {
  if (!logFile || !fs.existsSync(logFile)) return 0;
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l && l !== 'SIGTERM' && !Number.isNaN(Number(l))).length;
}

const attempt = priorAttempts();
log(String(Date.now()));

let mode = process.env.FAKE_UVICORN_MODE || 'serve';
let exitAfterMs = Number(process.env.FAKE_EXIT_AFTER_MS || 0);

if (process.env.FAKE_SCRIPT) {
  const tokens = process.env.FAKE_SCRIPT.split(',');
  const token = tokens[Math.min(attempt, tokens.length - 1)];
  if (token === 'crash') {
    mode = 'crash';
  } else if (token.startsWith('serve')) {
    const ms = Number(token.slice('serve'.length));
    if (ms > 0) {
      mode = 'serve-then-crash';
      exitAfterMs = ms;
    } else {
      mode = 'serve';
    }
  }
}

if (mode === 'crash') {
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port);

process.on('SIGTERM', () => {
  log('SIGTERM');
  server.close();
  process.exit(0);
});

if (mode === 'serve-then-crash' && exitAfterMs > 0) {
  setTimeout(() => process.exit(1), exitAfterMs);
}
