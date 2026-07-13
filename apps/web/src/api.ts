import { useEffect, DependencyList } from 'react';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
  return data as T;
}

export const api = {
  get: <T = unknown>(url: string) => req<T>('GET', url),
  post: <T = unknown>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  patch: <T = unknown>(url: string, body: unknown) => req<T>('PATCH', url, body),
  del: <T = unknown>(url: string) => req<T>('DELETE', url),
};

type EventHandler = (type: string, payload: any) => void;
let source: EventSource | null = null;
const listeners = new Set<EventHandler>();

function ensureSource(): void {
  if (source) return;
  source = new EventSource('/api/events');
  for (const type of ['task', 'phase', 'log', 'activity', 'projects', 'chat']) {
    source.addEventListener(type, (e) => {
      const payload = JSON.parse((e as MessageEvent).data);
      for (const fn of listeners) fn(type, payload);
    });
  }
}

export function useEvents(handler: EventHandler, deps: DependencyList = []): void {
  useEffect(() => {
    ensureSource();
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, deps);
}

export const fmtDate = (ts: number): string =>
  new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
