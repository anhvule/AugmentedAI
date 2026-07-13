// Maps deemsvc JSONL journal records onto the existing task/phase shape in
// data/deem.json, so every current UI tab renders unchanged. Per this plan's
// scope (a single "generate" step per run), every record is projected onto
// the task's "execution" phase; a multi-step DAG (future work) will project
// onto multiple phases instead.
import { db } from './store.js';
import { broadcast } from './events.js';
import { phaseRecord } from './workflow.js';

const RUNNING_STATUSES = new Set(['ready', 'dispatched', 'executing', 'verifying', 'retrying']);
const TERMINAL_STATUS = { passed: 'passed', escalated: 'failed', abandoned: 'failed' };

export function projectEvent(taskId, record) {
  const rec = phaseRecord(taskId, 'execution');
  if (!rec) return; // task predates deemsvc phases, or isn't tracked here

  const patch = {};
  if (RUNNING_STATUSES.has(record.to) && rec.status !== 'running') {
    patch.status = 'running';
    patch.startedAt = rec.startedAt || Date.now();
  } else if (record.to in TERMINAL_STATUS) {
    patch.status = TERMINAL_STATUS[record.to];
    patch.finishedAt = Date.now();
    if (record.to !== 'passed') {
      patch.error = `deemsvc: step ${record.step} -> ${record.to}`;
    }
  } else {
    return; // no phase-relevant transition (e.g. a repeated/no-op status)
  }

  Object.assign(rec, patch);
  db.save();
  // Matches the 'phase' event shape server/workflow.js's setPhase already
  // broadcasts: { taskId, phase, ...patch }.
  broadcast('phase', { taskId, phase: 'execution', ...patch });
}
