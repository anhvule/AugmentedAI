import { mockAgent } from './mock.js';
import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';

// Uniform adapter interface:
//   run(job) -> Promise<{ ok, json, text }>
//   job = { phase, prompt, cwd, task, project, attempt, onEvent, registerChild }
// onEvent receives { type: 'tool'|'log'|'session'|'assistant', ... }
const AGENTS = {
  mock: mockAgent,
  'claude-code': claudeAgent,
  codex: codexAgent,
};

export function getAgent(name) {
  return AGENTS[name] || AGENTS.mock;
}

export const AGENT_LABELS = {
  mock: 'MOCK RUNNER',
  'claude-code': 'CLAUDE CODE',
  codex: 'CODEX',
  'fable5-native': 'FABLE 5 (NATIVE)',
  'claude-code-cli': 'CLAUDE CODE (DEEMSVC)',
  'codex-cli': 'CODEX (DEEMSVC)',
};

// Every value the "Fable 5 (native)" project setting can take routes through
// deemsvc's POST /runs `agent` field unchanged — see server/index.js's
// /api/tasks/:id/run-deemsvc route.
export const DEEMSVC_AGENTS = new Set(['fable5-native', 'claude-code-cli', 'codex-cli']);

// Best-effort extraction of a JSON object from model output.
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return null;
}
