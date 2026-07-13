// Thin HTTP/SSE client for the deemsvc Python service. No third-party
// dependencies — Node's built-in http/https cover both plain requests and
// a hand-rolled SSE line parser.
import http from 'node:http';
import https from 'node:https';

function transportFor(url) {
  return url.startsWith('https:') ? https : http;
}

function requestJson(baseUrl, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = transportFor(baseUrl).request(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`deemsvc ${method} ${path} -> ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function startRun(baseUrl, payload) {
  return requestJson(baseUrl, 'POST', '/runs', payload);
}

export function getState(baseUrl, runId) {
  return requestJson(baseUrl, 'GET', `/runs/${runId}/state`);
}

export function resumeStep(baseUrl, runId, stepId) {
  return requestJson(baseUrl, 'POST', `/runs/${runId}/resume`, { step_id: stepId });
}

// Parses `data: <json>\n\n` frames as they arrive and hands each parsed
// object to onEvent. Returns { close } to end the connection early.
export function streamEvents(baseUrl, runId, onEvent) {
  const url = new URL(`/runs/${runId}/events`, baseUrl);
  const req = transportFor(baseUrl).get(url, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            onEvent(JSON.parse(line.slice('data: '.length)));
          } catch {
            /* skip a malformed frame rather than crashing the stream */
          }
        }
      }
    });
  });
  req.on('error', () => { /* caller observes via lack of further events */ });
  return { close: () => req.destroy() };
}
