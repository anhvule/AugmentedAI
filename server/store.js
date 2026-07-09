// Tiny JSON persistence layer with atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'deem.json');

const EMPTY = {
  profile: null,
  projects: [],
  tasks: [],
  phases: [],
  logs: [],
  activity: {},
};

let state = null;
let writeTimer = null;

function load() {
  if (state) return state;
  try {
    state = { ...EMPTY, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch {
    state = structuredClone(EMPTY);
  }
  return state;
}

function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 50);
}

export const db = {
  get: load,
  save: persist,
};

export function uid(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}_${s}`;
}
