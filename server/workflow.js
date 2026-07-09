// The Deem quality pipeline: plan → execution → review → test_plan →
// test_results → summary, with per-phase auto-run, rubric evaluation,
// acceptance thresholds and bounded auto-retry.
import { db, uid } from './store.js';
import { broadcast } from './events.js';
import { getAgent } from './agents/index.js';
import { buildPrompt } from './prompts.js';
import { startMonitor, stopMonitor, touchActivity } from './monitor.js';
import { verifyExecution, runTestCommands, diffText } from './verify.js';
import { ensureWorkspace } from './workspace.js';

export const PHASES = ['plan', 'execution', 'review', 'test_plan', 'test_results', 'summary'];
const STATUS_AFTER = {
  plan: 'planned',
  execution: 'implemented',
  review: 'reviewed',
  test_plan: 'test_planned',
  test_results: 'tested',
  summary: 'done',
};

const running = new Map(); // taskId -> { child, phase }
const queue = []; // { taskId, phase, feedback }
let activeRuns = 0;

const maxConcurrent = () => Math.max(1, Number(db.get().settings.maxConcurrentRuns) || 2);
const phaseTimeoutMs = () => Math.max(1, Number(db.get().settings.phaseTimeoutMinutes) || 30) * 60000;

export function isRunning(taskId) {
  return running.has(taskId);
}

export function queueDepth() {
  return { active: activeRuns, queued: queue.length, limit: maxConcurrent() };
}

export function ensurePhases(taskId) {
  const state = db.get();
  for (const phase of PHASES) {
    if (!state.phases.find((p) => p.taskId === taskId && p.phase === phase)) {
      state.phases.push({
        taskId,
        phase,
        status: phase === 'plan' ? 'ready' : 'blocked',
        startedAt: null,
        finishedAt: null,
        data: null,
        error: null,
      });
    }
  }
  db.save();
}

export function phaseRecord(taskId, phase) {
  return db.get().phases.find((p) => p.taskId === taskId && p.phase === phase);
}

function task(taskId) {
  return db.get().tasks.find((t) => t.id === taskId);
}

function project(projectId) {
  return db.get().projects.find((p) => p.id === projectId);
}

export function log(taskId, message, level = 'info', source = 'deem') {
  const state = db.get();
  state.logs.push({ taskId, ts: Date.now(), level, source, message });
  const mine = state.logs.filter((l) => l.taskId === taskId);
  if (mine.length > 800) {
    const cut = mine.length - 800;
    let removed = 0;
    state.logs = state.logs.filter((l) => l.taskId !== taskId || removed++ >= cut ? true : false);
  }
  db.save();
  broadcast('log', { taskId, ts: Date.now(), level, source, message });
}

function setPhase(taskId, phase, patch) {
  const rec = phaseRecord(taskId, phase);
  Object.assign(rec, patch);
  db.save();
  broadcast('phase', { taskId, phase, ...patch });
}

function setTask(taskId, patch) {
  const t = task(taskId);
  Object.assign(t, patch, { updatedAt: Date.now() });
  db.save();
  broadcast('task', { taskId, patch });
}

function artifacts(taskId) {
  const out = {};
  for (const p of db.get().phases.filter((p) => p.taskId === taskId && p.data)) out[p.phase] = p.data;
  return out;
}

function evalTotal(criteria = {}) {
  return Object.values(criteria).reduce((a, b) => a + Number(b || 0), 0);
}

export async function startPhase(taskId, phase, { feedback = '' } = {}) {
  const t = task(taskId);
  if (!t) throw new Error('task not found');
  if (running.has(taskId)) throw new Error('task already has a running phase');
  ensurePhases(taskId);
  if (activeRuns >= maxConcurrent()) {
    if (queue.some((q) => q.taskId === taskId)) return;
    queue.push({ taskId, phase, feedback });
    setPhase(taskId, phase, { status: 'queued' });
    setTask(taskId, { runStatus: 'queued' });
    log(taskId, `phase ${phase} queued (${activeRuns}/${maxConcurrent()} run slots busy)`);
    return;
  }
  return runPhase(taskId, phase, feedback);
}

function drainQueue() {
  while (activeRuns < maxConcurrent() && queue.length) {
    const next = queue.shift();
    const t = task(next.taskId);
    if (!t || running.has(next.taskId)) continue;
    if (phaseRecord(next.taskId, next.phase)?.status !== 'queued') continue;
    log(next.taskId, `phase ${next.phase} dequeued — starting`);
    runPhase(next.taskId, next.phase, next.feedback).catch((err) => log(next.taskId, err.message, 'error'));
  }
}

async function runPhase(taskId, phase, feedback) {
  activeRuns += 1;
  try {
    await executePhase(taskId, phase, feedback);
  } finally {
    activeRuns -= 1;
    drainQueue();
  }
}

async function executePhase(taskId, phase, feedback) {
  const t = task(taskId);
  const proj = project(t.projectId);
  const agent = getAgent(proj.agent);
  const runId = uid('run');

  // Isolated workspace: agents work in a per-task git worktree, never in the
  // user's checkout. Falls back to the project path for non-git projects.
  const ws = ensureWorkspace(proj, t);
  if (ws.error) log(taskId, `workspace isolation unavailable (${ws.error}) — using project path`, 'warn');
  if (ws.isolated && t.workspace !== ws.dir) {
    setTask(taskId, { workspace: ws.dir, branch: ws.branch || t.branch });
    log(taskId, `isolated workspace ready at ${ws.dir} on ${ws.branch}`);
  }

  setPhase(taskId, phase, { status: 'running', startedAt: Date.now(), finishedAt: null, error: null });
  setTask(taskId, { currentPhase: phase, llmProcessId: runId, runStatus: 'running' });
  log(taskId, `phase ${phase} started (agent: ${proj.agent}, attempt ${t.attempts + 1}/${t.maxAttempts})`);

  const entry = { child: null, phase };
  running.set(taskId, entry);
  startMonitor(taskId);

  // Watchdog: a hung agent must not hold a run slot forever.
  const watchdog = setTimeout(() => {
    if (running.get(taskId) !== entry) return;
    running.delete(taskId);
    stopMonitor(taskId);
    if (entry.child && !entry.child.killed) {
      try {
        entry.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    setPhase(taskId, phase, { status: 'failed', finishedAt: Date.now(), error: `timed out after ${Math.round(phaseTimeoutMs() / 60000)} minutes` });
    setTask(taskId, { runStatus: 'idle', status: 'failed' });
    log(taskId, `phase ${phase} killed by watchdog after ${Math.round(phaseTimeoutMs() / 60000)} minutes`, 'error');
  }, phaseTimeoutMs());

  const runUsage = { input: 0, output: 0, costUsd: 0 };
  const onEvent = (ev) => {
    if (ev.type === 'usage') {
      if (ev.absolute) {
        runUsage.input = ev.input;
        runUsage.output = ev.output;
        runUsage.costUsd = ev.costUsd || runUsage.costUsd;
      } else {
        runUsage.input += ev.input || 0;
        runUsage.output += ev.output || 0;
        runUsage.costUsd += ev.costUsd || 0;
      }
      return;
    }
    touchActivity(taskId, ev);
  };
  const registerChild = (child) => {
    entry.child = child;
    touchActivity(taskId, { type: 'process', pid: child.pid, command: `${proj.agent} runner`, cwd: ws.dir });
  };

  const arts = artifacts(taskId);
  const diff = phase === 'review' ? diffText(proj, arts.execution?.verification?.branch || arts.execution?.branch) : '';

  let result;
  try {
    result = await agent.run({
      phase,
      prompt: buildPrompt(phase, { task: t, project: proj, artifacts: arts, feedback, diff }),
      cwd: ws.dir,
      task: t,
      project: proj,
      attempt: t.attempts + 1,
      readOnly: ['review', 'test_plan', 'summary'].includes(phase),
      onEvent,
      registerChild,
    });
  } catch (err) {
    result = { ok: false, text: err.message };
  }

  clearTimeout(watchdog);
  if (running.get(taskId) !== entry) return; // stopped, timed out or superseded while awaiting
  running.delete(taskId);
  stopMonitor(taskId);

  const prevUsage = task(taskId).usage || { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const usage = {
    inputTokens: prevUsage.inputTokens + runUsage.input,
    outputTokens: prevUsage.outputTokens + runUsage.output,
    costUsd: +(prevUsage.costUsd + runUsage.costUsd).toFixed(4),
  };
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  setTask(taskId, { runStatus: 'idle', usage });
  if (runUsage.input + runUsage.output > 0)
    log(taskId, `usage: +${runUsage.input + runUsage.output} tokens this run (${usage.totalTokens} total, $${usage.costUsd})`);

  if (!result.ok || !result.json) {
    setPhase(taskId, phase, { status: 'failed', finishedAt: Date.now(), error: result.text || 'no artifact produced' });
    setTask(taskId, { status: 'failed' });
    log(taskId, `phase ${phase} failed: ${(result.text || 'no artifact').slice(0, 300)}`, 'error');
    return;
  }

  // Ground-truth post-processing: overwrite agent claims with what the
  // harness can actually observe.
  if (phase === 'execution') {
    const v = verifyExecution(t, proj, result.json);
    result.json.verification = v;
    if (v.checked) {
      result.json.filesChanged = v.files; // git is the source of truth
      result.json.branch = v.branch;
      log(
        taskId,
        v.verified ? `harness verification: ${v.note}` : `harness verification FAILED: ${v.note}`,
        v.verified ? 'info' : 'warn'
      );
    } else {
      log(taskId, `harness verification skipped: ${v.note}`, 'warn');
    }
  }
  if (phase === 'test_results') {
    const testPlan = artifacts(taskId).test_plan;
    const harness = await runTestCommands(testPlan, ws.dir);
    if (harness) {
      result.json.agentClaimed = result.json.results || null;
      result.json.results = harness.results;
      result.json.summary = harness.summary;
      result.json.harnessRun = true;
      log(taskId, `harness executed test plan: ${harness.summary}`);
    }
  }

  setPhase(taskId, phase, { status: 'done', finishedAt: Date.now(), data: result.json });
  log(taskId, `phase ${phase} completed`);
  await afterPhase(taskId, phase, result.json);
}

async function afterPhase(taskId, phase, artifact) {
  const t = task(taskId);

  if (phase === 'execution') {
    setTask(taskId, { attempts: t.attempts + 1 });
    // Harness gate first: self-reported scores cannot outvote a missing diff.
    const v = artifact.verification;
    if (v?.checked && !v.verified) {
      log(taskId, `rejecting execution: harness found no real changes (${v.note})`, 'warn');
      return retryOrFail(
        taskId,
        `Harness verification failed: ${v.note}. You must commit real file changes on the task branch — reporting work without a diff is rejected automatically.`
      );
    }
    const total = evalTotal(artifact.evaluation?.criteria);
    const threshold = t.acceptance?.threshold ?? 42;
    if (total < threshold) {
      log(taskId, `implementation evaluation ${total}/60 below threshold ${threshold}`, 'warn');
      return retryOrFail(taskId, `Evaluation scored ${total}/60 (< ${threshold}). Notes: ${artifact.evaluation?.notes || ''}`);
    }
    log(taskId, `implementation evaluation ${total}/60 — accepted`);
  }

  if (phase === 'test_results') {
    const failed = (artifact.results || []).filter((r) => r.status === 'failed');
    if (failed.length) {
      log(taskId, `${failed.length} automated test(s) failed — sending back to implementation`, 'warn');
      return retryOrFail(
        taskId,
        `Automated tests failed (run by the harness):\n${failed.map((f) => `- ${f.title}: ${f.output?.slice(0, 300)}`).join('\n')}`
      );
    }
  }

  if (phase === 'review' && artifact.verdict !== 'approved') {
    log(taskId, `review verdict: ${artifact.verdict}`, 'warn');
    return retryOrFail(taskId, `Review rejected the implementation. Issues:\n- ${(artifact.issues || []).join('\n- ')}`);
  }

  setTask(taskId, { status: STATUS_AFTER[phase] });
  if (phase === 'plan') {
    if (t.autoRun.plan) {
      setTask(taskId, { planAccepted: true });
      log(taskId, 'plan auto-accepted');
    } else {
      log(taskId, 'plan awaiting acceptance');
      return;
    }
  }
  advance(taskId, phase);
}

export function budgetExhausted(t) {
  return t.budget?.tokens && (t.usage?.totalTokens || 0) >= t.budget.tokens;
}

function retryOrFail(taskId, feedback) {
  const t = task(taskId);
  if (t.attempts >= t.maxAttempts || budgetExhausted(t)) {
    const reason = budgetExhausted(t)
      ? `token budget exhausted (${t.usage.totalTokens}/${t.budget.tokens})`
      : `attempt budget exhausted (${t.attempts}/${t.maxAttempts})`;
    setTask(taskId, { status: 'failed' });
    setPhase(taskId, 'execution', { status: 'failed', error: reason });
    log(taskId, `${reason} — task failed`, 'error');
    return;
  }
  if (!t.autoRun.execution) {
    setPhase(taskId, 'execution', { status: 'ready' });
    log(taskId, 'auto retry is off — execution ready for manual rerun', 'warn');
    return;
  }
  log(taskId, `auto-retrying implementation (attempt ${t.attempts + 1}/${t.maxAttempts})`);
  // Re-block downstream phases before the fresh attempt.
  for (const p of ['review', 'test_plan', 'test_results', 'summary']) setPhase(taskId, p, { status: 'blocked', data: phaseRecord(taskId, p).data });
  return startPhase(taskId, 'execution', { feedback });
}

function advance(taskId, donePhase) {
  const t = task(taskId);
  const next = PHASES[PHASES.indexOf(donePhase) + 1];
  if (!next) {
    log(taskId, 'pipeline complete — task done');
    return;
  }
  const auto =
    (next === 'execution' && t.autoRun.execution && t.planAccepted) ||
    (next === 'review' && t.autoRun.review) ||
    (['test_plan', 'test_results', 'summary'].includes(next) && t.autoRun.tests);

  setPhase(taskId, next, { status: 'ready' });
  if (auto) {
    startPhase(taskId, next).catch((err) => log(taskId, `failed to start ${next}: ${err.message}`, 'error'));
  } else {
    log(taskId, `phase ${next} is ready (auto run off)`);
  }
}

export function acceptPlan(taskId) {
  const t = task(taskId);
  if (!phaseRecord(taskId, 'plan')?.data) throw new Error('no plan to accept');
  setTask(taskId, { planAccepted: true });
  log(taskId, 'plan accepted');
  if (phaseRecord(taskId, 'execution').status !== 'running') {
    setPhase(taskId, 'execution', { status: 'ready' });
    if (t.autoRun.execution) startPhase(taskId, 'execution').catch((err) => log(taskId, err.message, 'error'));
  }
}

export function stop(taskId) {
  const queuedIdx = queue.findIndex((q) => q.taskId === taskId);
  if (queuedIdx !== -1) {
    const [q] = queue.splice(queuedIdx, 1);
    setPhase(taskId, q.phase, { status: 'stopped' });
    setTask(taskId, { runStatus: 'idle' });
    log(taskId, `queued phase ${q.phase} cancelled by user`, 'warn');
    return true;
  }
  const entry = running.get(taskId);
  if (!entry) return false;
  running.delete(taskId);
  stopMonitor(taskId);
  if (entry.child && !entry.child.killed) {
    try {
      entry.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setPhase(taskId, entry.phase, { status: 'stopped', finishedAt: Date.now() });
  setTask(taskId, { runStatus: 'idle' });
  log(taskId, `phase ${entry.phase} stopped by user`, 'warn');
  drainQueue();
  return true;
}

// Called once at boot: phases left 'running'/'queued' by a crash or restart
// are marked stopped so the UI reflects reality and reruns are possible.
export function recoverInterrupted() {
  const state = db.get();
  let recovered = 0;
  for (const p of state.phases) {
    if (p.status === 'running' || p.status === 'queued') {
      p.status = 'stopped';
      p.error = 'interrupted by server restart';
      recovered++;
    }
  }
  for (const t of state.tasks) {
    if (t.runStatus === 'running' || t.runStatus === 'queued') t.runStatus = 'idle';
  }
  if (recovered) db.save();
  return recovered;
}

// Graceful shutdown: kill agent children so nothing keeps mutating
// workspaces after the supervisor is gone.
export function shutdown() {
  for (const [taskId, entry] of running) {
    if (entry.child && !entry.child.killed) {
      try {
        entry.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const rec = phaseRecord(taskId, entry.phase);
    if (rec) {
      rec.status = 'stopped';
      rec.error = 'interrupted by shutdown';
    }
    const t = task(taskId);
    if (t) t.runStatus = 'idle';
  }
  running.clear();
  queue.length = 0;
}
