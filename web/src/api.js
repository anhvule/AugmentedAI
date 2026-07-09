import { useEffect } from 'react';

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

export const api = {
  get: (url) => req('GET', url),
  post: (url, body = {}) => req('POST', url, body),
  patch: (url, body) => req('PATCH', url, body),
  del: (url) => req('DELETE', url),
};

let source = null;
const listeners = new Set();

function ensureSource() {
  if (source) return;
  source = new EventSource('/api/events');
  for (const type of ['task', 'phase', 'log', 'activity', 'projects', 'chat']) {
    source.addEventListener(type, (e) => {
      const payload = JSON.parse(e.data);
      for (const fn of listeners) fn(type, payload);
    });
  }
}

// Subscribe to live server events; handler(type, payload).
export function useEvents(handler, deps = []) {
  useEffect(() => {
    ensureSource();
    listeners.add(handler);
    return () => listeners.delete(handler);
  }, deps);
}

export const fmtDate = (ts) =>
  new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
