import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamEvents, getState } from '../deemsvc-client.js';

// A minimal fake deemsvc HTTP server, so this test never spawns the real
// Python process or depends on network access.
function fakeServer() {
  return http.createServer((req, res) => {
    if (req.url === '/runs/abc/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run_id: 'abc', done: true, steps: {} }));
      return;
    }
    if (req.url === '/runs/abc/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"step":"impl","to":"ready"}\n\n');
      res.write('data: {"step":"impl","to":"passed"}\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('getState parses the JSON response body', async () => {
  const server = fakeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const state = await getState(`http://127.0.0.1:${port}`, 'abc');
  assert.equal(state.run_id, 'abc');
  assert.equal(state.done, true);
  server.close();
});

test('streamEvents delivers each SSE frame as a parsed event, then closes', async () => {
  const server = fakeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const received = [];
  await new Promise((resolve) => {
    const handle = streamEvents(`http://127.0.0.1:${port}`, 'abc', (event) => {
      received.push(event);
      if (received.length === 2) {
        handle.close();
        resolve();
      }
    });
  });
  assert.deepEqual(received, [
    { step: 'impl', to: 'ready' },
    { step: 'impl', to: 'passed' },
  ]);
  server.close();
});
