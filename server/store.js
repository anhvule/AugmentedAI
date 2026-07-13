// Tiny JSON persistence layer with atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DEEM_DATA_DIR lets tests (and ops) redirect persistence to an isolated dir.
const DATA_DIR = process.env.DEEM_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'deem.json');

const EMPTY = {
  profile: null,
  users: [],
  sessions: [],
  projects: [],
  tasks: [],
  phases: [],
  logs: [],
  activity: {},
  chats: [],
  settings: {
    telegramToken: '',
    telegramOffset: 0,
    defaultTokenBudget: 500000,
    maxConcurrentRuns: 2,
    phaseTimeoutMinutes: 30,
  },
};

let state = null;
let writeTimer = null;

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = { ...structuredClone(EMPTY), ...raw, settings: { ...EMPTY.settings, ...(raw.settings || {}) } };
  } catch {
    state = structuredClone(EMPTY);
  }
  return state;
}

function writeNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
  try {
    fs.chmodSync(DATA_FILE, 0o600); // contains session tokens and bot tokens
  } catch {
    /* best effort */
  }
}

function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow();
  }, 50);
}

// Flush pending debounced writes immediately — called on shutdown so a
// SIGTERM inside the 50ms window cannot lose state.
function flushSync() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (state) writeNow();
}

export const db = {
  get: load,
  save: persist,
  flushSync,
};

export function uid(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}_${s}`;
}
