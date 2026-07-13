import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uid } from './store.js';
import { sseHandler, broadcast } from './events.js';
import {
  PHASES, ensurePhases, startPhase, acceptPlan, stop, isRunning, phaseRecord, log,
  budgetExhausted, queueDepth, recoverInterrupted, shutdown,
} from './workflow.js';
import { removeWorkspace } from './workspace.js';
import { audit, auditTail } from './audit.js';
import { exportMarkdown } from './exporters.js';
import { AGENT_LABELS, DEEMSVC_AGENTS } from './agents/index.js';
import { register, verify, createSession, destroySession, sessionCookie, clearCookie, authMiddleware } from './auth.js';
import { handleChatMessage, recordExchange } from './chat.js';
import { syncTelegram } from './telegram.js';
import { startDeemsvc } from './deemsvc-supervisor.js';
import { startRun, streamEvents, getState, resumeStep } from './deemsvc-client.js';
import { projectEvent } from './deemsvc-projector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', authMiddleware);

let deemsvc = null;
try {
  deemsvc = await startDeemsvc({ port: 8731 });
  console.log(`[deemsvc] ready at ${deemsvc.baseUrl}`);
} catch (err) {
  console.error(`[deemsvc] failed to start — deemsvc-backed agent options will error until this is fixed: ${err.message}`);
}

const state = () => db.get();
const findTask = (id) => state().tasks.find((t) => t.id === id);
const findProject = (id) => state().projects.find((p) => p.id === id);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// ---------- health (public, no secrets) ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.floor(process.uptime()), runs: queueDepth() });
});

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  try {
    const user = register(req.body);
    audit(user.email, 'auth.register');
    res.setHeader('Set-Cookie', sessionCookie(createSession(user.id)));
    res.json(publicUser(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const user = verify(req.body);
    if (!user) {
      audit(req.body?.email, 'auth.login_failed');
      return res.status(401).json({ error: 'invalid email or password' });
    }
    audit(user.email, 'auth.login');
    res.setHeader('Set-Cookie', sessionCookie(createSession(user.id)));
    res.json(publicUser(user));
  } catch (err) {
    audit(req.body?.email, 'auth.login_locked');
    res.status(429).json({ error: err.message });
  }
});

app.get('/api/profile', (req, res) => res.json(publicUser(req.user)));

app.post('/api/logout', (req, res) => {
  destroySession(req.user.token);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

// ---------- workspace settings ----------
app.get('/api/settings', (req, res) => {
  const { telegramToken, defaultTokenBudget, maxConcurrentRuns, phaseTimeoutMinutes } = state().settings;
  res.json({
    telegramToken: telegramToken ? '••••' + telegramToken.slice(-4) : '',
    defaultTokenBudget,
    maxConcurrentRuns,
    phaseTimeoutMinutes,
    telegramConfigured: !!telegramToken,
  });
});

app.patch('/api/settings', (req, res) => {
  const s = state().settings;
  if ('telegramToken' in req.body) {
    s.telegramToken = String(req.body.telegramToken || '').trim();
    s.telegramOffset = 0;
    syncTelegram();
  }
  if ('defaultTokenBudget' in req.body) s.defaultTokenBudget = Math.max(1000, Number(req.body.defaultTokenBudget) || 500000);
  if ('maxConcurrentRuns' in req.body) s.maxConcurrentRuns = Math.min(8, Math.max(1, Number(req.body.maxConcurrentRuns) || 2));
  if ('phaseTimeoutMinutes' in req.body) s.phaseTimeoutMinutes = Math.min(240, Math.max(1, Number(req.body.phaseTimeoutMinutes) || 30));
  db.save();
  audit(req.user.email, 'settings.update', { keys: Object.keys(req.body) });
  res.json({ ok: true });
});

// ---------- audit trail ----------
app.get('/api/audit', (req, res) => res.json(auditTail(Number(req.query.lines) || 200)));

// ---------- chat control ----------
app.get('/api/chat', (req, res) => res.json(state().chats.slice(-100)));
app.post('/api/chat', (req, res) => {
  const reply = handleChatMessage(req.body.message);
  recordExchange('web', req.body.message, reply);
  audit(req.user.email, 'chat.command', { message: String(req.body.message || '').slice(0, 200) });
  res.json({ reply });
});

// ---------- projects ----------
app.get('/api/projects', (req, res) => {
  const projects = [...state().projects].sort((a, b) => b.createdAt - a.createdAt);
  res.json(
    projects.map((p) => {
      const tasks = state().tasks.filter((t) => t.projectId === p.id);
      const latest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
      return { ...p, agentLabel: AGENT_LABELS[p.agent], taskCount: tasks.length, latestTask: latest };
    })
  );
});

app.post('/api/projects', (req, res) => {
  const { name, description, repoPath, agent = 'mock', branch = 'main', permissionMode = 'restricted' } = req.body;
  if (!name || String(name).length > 120) return res.status(400).json({ error: 'name is required (max 120 chars)' });
  if (!repoPath || !path.isAbsolute(repoPath)) return res.status(400).json({ error: 'repoPath must be an absolute path' });
  const healthy = fs.existsSync(repoPath);
  const proj = {
    id: uid('proj'),
    name,
    description: description || 'New Deem project ready for local execution.',
    repoPath,
    agent,
    provider: agent === 'codex' ? 'openai' : agent === 'claude-code' ? 'anthropic' : 'deem',
    branch,
    permissionMode: permissionMode === 'full' ? 'full' : 'restricted',
    health: healthy ? 'healthy' : 'needs attention',
    createdAt: Date.now(),
  };
  state().projects.push(proj);
  db.save();
  audit(req.user.email, 'project.create', { projectId: proj.id, repoPath, agent });
  broadcast('projects', {});
  res.json(proj);
});

app.patch('/api/projects/:id', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'not found' });
  const { name, description, repoPath, agent, branch, permissionMode } = req.body;
  if (repoPath !== undefined && !path.isAbsolute(repoPath)) return res.status(400).json({ error: 'repoPath must be an absolute path' });
  Object.assign(proj, {
    ...(name && { name }),
    ...(description !== undefined && { description }),
    ...(repoPath !== undefined && { repoPath, health: fs.existsSync(repoPath) ? 'healthy' : 'needs attention' }),
    ...(agent && { agent, provider: agent === 'codex' ? 'openai' : agent === 'claude-code' ? 'anthropic' : 'deem' }),
    ...(branch && { branch }),
    ...(permissionMode && { permissionMode: permissionMode === 'full' ? 'full' : 'restricted' }),
  });
  db.save();
  audit(req.user.email, 'project.update', { projectId: proj.id });
  broadcast('projects', {});
  res.json(proj);
});

app.get('/api/projects/:id', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'not found' });
  const tasks = state()
    .tasks.filter((t) => t.projectId === proj.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ ...proj, agentLabel: AGENT_LABELS[proj.agent], tasks });
});

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const tasks = state().tasks;
  const runningTasks = tasks.filter((t) => t.runStatus === 'running');
  res.json({
    runningNow: runningTasks.length,
    tasksTracked: tasks.length,
    projectCount: state().projects.length,
    active: runningTasks.map((t) => ({
      ...t,
      projectName: findProject(t.projectId)?.name,
    })),
  });
});

// ---------- tasks ----------
app.post('/api/projects/:id/tasks', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  const { name, description = '', requirements = [], notes = '', status = 'pending', priority = 'Medium' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const t = {
    id: uid('task'),
    projectId: proj.id,
    name,
    description,
    requirements: Array.isArray(requirements)
      ? requirements
      : String(requirements).split('\n').map((s) => s.trim()).filter(Boolean),
    notes,
    status,
    priority,
    branch: proj.branch || 'main',
    workspace: 'root project',
    llmProcessId: null,
    runStatus: 'idle',
    currentPhase: 'plan',
    planAccepted: false,
    attempts: 0,
    maxAttempts: 4,
    autoRun: { plan: true, execution: true, review: true, tests: true },
    acceptance: { threshold: 42 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, totalTokens: 0 },
    budget: { tokens: state().settings.defaultTokenBudget },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state().tasks.push(t);
  db.save();
  ensurePhases(t.id);
  log(t.id, `task created in project ${proj.name}`);
  broadcast('task', { taskId: t.id, patch: t });
  res.json(t);
});

app.get('/api/tasks/:id', (req, res) => {
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  ensurePhases(t.id);
  const proj = findProject(t.projectId);
  res.json({
    task: t,
    project: { ...proj, agentLabel: AGENT_LABELS[proj.agent] },
    phases: PHASES.map((p) => phaseRecord(t.id, p)),
    activity: state().activity[t.id] || null,
  });
});

app.patch('/api/tasks/:id', (req, res) => {
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const allowed = ['name', 'description', 'requirements', 'notes', 'status', 'priority', 'maxAttempts'];
  for (const k of allowed) if (k in req.body) t[k] = req.body[k];
  if ('autoRun' in req.body) t.autoRun = { ...t.autoRun, ...req.body.autoRun };
  if ('budget' in req.body) t.budget = { ...t.budget, ...req.body.budget };
  if (req.body.status === 'archived') {
    // Closing a task retires its isolated worktree; the branch survives in the repo.
    const removed = removeWorkspace(findProject(t.projectId), t.id);
    if (removed) log(t.id, 'isolated workspace removed (task archived)');
  }
  t.updatedAt = Date.now();
  db.save();
  audit(req.user.email, 'task.update', { taskId: t.id, keys: Object.keys(req.body) });
  broadcast('task', { taskId: t.id, patch: t });
  res.json(t);
});

app.post('/api/tasks/:id/run', async (req, res) => {
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (isRunning(t.id)) return res.status(409).json({ error: 'a phase is already running' });
  if (budgetExhausted(t)) return res.status(400).json({ error: `token budget exhausted (${t.usage.totalTokens}/${t.budget.tokens})` });
  const phase = req.body.phase || t.currentPhase || 'plan';
  if (phase === 'execution' && !t.planAccepted) return res.status(400).json({ error: 'plan must be accepted first' });
  audit(req.user.email, 'task.run', { taskId: t.id, phase });
  startPhase(t.id, phase).catch((err) => log(t.id, `run failed: ${err.message}`, 'error'));
  res.json({ ok: true, phase });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  audit(req.user.email, 'task.stop', { taskId: req.params.id });
  res.json({ stopped: stop(req.params.id) });
});

app.post('/api/tasks/:id/accept-plan', (req, res) => {
  try {
    acceptPlan(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Starts (or re-attaches to) a deemsvc SSE stream for a run and projects each
// journal record onto the task's execution state. Shared by the initial run
// route and the resume route — a resumed run's Python-side SSE generator only
// re-opens once the orchestrator restarts, so resume must re-attach exactly
// the same way the initial run did or the UI never sees the outcome.
function attachDeemsvcStream(taskId, runId) {
  streamEvents(deemsvc.baseUrl, runId, (record) => projectEvent(taskId, record));
}

app.post('/api/tasks/:id/run-deemsvc', async (req, res) => {
  if (!deemsvc) return res.status(503).json({ error: 'deemsvc is not running' });
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const p = findProject(t.projectId);
  if (!DEEMSVC_AGENTS.has(p.agent)) {
    return res.status(400).json({ error: `project agent "${p.agent}" is not a deemsvc backend` });
  }

  try {
    const { run_id } = await startRun(deemsvc.baseUrl, {
      goal: t.description,
      acceptance_criteria: t.requirements || [],
      baseline_ref: req.body.baselineRef,
      worktree: req.body.worktreePath,
      token_ceiling: state().settings.defaultTokenBudget,
      max_attempts: 4,
      agent: p.agent,
    });

    attachDeemsvcStream(t.id, run_id);
    res.json({ runId: run_id });
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/deemsvc-state/:runId', async (req, res) => {
  if (!deemsvc) return res.status(503).json({ error: 'deemsvc is not running' });
  try {
    res.json(await getState(deemsvc.baseUrl, req.params.runId));
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/deemsvc-resume/:runId', async (req, res) => {
  if (!deemsvc) return res.status(503).json({ error: 'deemsvc is not running' });
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  try {
    const result = await resumeStep(deemsvc.baseUrl, req.params.runId, req.body.stepId);
    attachDeemsvcStream(t.id, req.params.runId);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/logs', (req, res) => {
  res.json(state().logs.filter((l) => l.taskId === req.params.id).slice(-500));
});

app.get('/api/tasks/:id/export/:kind', (req, res) => {
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  try {
    const md = exportMarkdown(req.params.kind, {
      task: t,
      project: findProject(t.projectId),
      phases: state().phases.filter((p) => p.taskId === t.id),
      activity: state().activity[t.id],
    });
    const names = {
      task: 'Task.md', plan: 'Plan.md', execution: 'Execution.md', review: 'Review.md',
      test_plan: 'TestPlan.md', test_results: 'TestResults.md', summary: 'Summary.md',
    };
    res.setHeader('Content-Disposition', `attachment; filename="${names[req.params.kind] || 'Export.md'}"`);
    res.type('text/markdown').send(md);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- skills & knowledge (RAG) ----------
app.post('/api/projects/:id/skills', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'not found' });
  proj.skills = proj.skills || [];
  const skill = { id: uid('skill'), name: req.body.name || 'Untitled skill', instructions: req.body.instructions || '', enabled: true };
  proj.skills.push(skill);
  db.save();
  broadcast('projects', {});
  res.json(skill);
});

app.patch('/api/projects/:id/skills/:skillId', (req, res) => {
  const skill = findProject(req.params.id)?.skills?.find((s) => s.id === req.params.skillId);
  if (!skill) return res.status(404).json({ error: 'not found' });
  for (const k of ['name', 'instructions', 'enabled']) if (k in req.body) skill[k] = req.body[k];
  db.save();
  broadcast('projects', {});
  res.json(skill);
});

app.delete('/api/projects/:id/skills/:skillId', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'not found' });
  proj.skills = (proj.skills || []).filter((s) => s.id !== req.params.skillId);
  db.save();
  broadcast('projects', {});
  res.json({ ok: true });
});

app.post('/api/projects/:id/knowledge', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'not found' });
  proj.knowledge = proj.knowledge || [];
  const entry = { id: uid('doc'), title: req.body.title || 'Untitled', content: String(req.body.content || ''), addedAt: Date.now() };
  proj.knowledge.push(entry);
  db.save();
  broadcast('projects', {});
  res.json(entry);
});

app.delete('/api/projects/:id/knowledge/:docId', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'not found' });
  proj.knowledge = (proj.knowledge || []).filter((d) => d.id !== req.params.docId);
  db.save();
  broadcast('projects', {});
  res.json({ ok: true });
});

// ---------- events ----------
app.get('/api/events', sseHandler);

// ---------- static (production build) ----------
// In production the api serves apps/web's Vite build. DEEM_WEB_DIST lets
// deploys/e2e override the location; default is the Nx output dir.
const dist = process.env.DEEM_WEB_DIST || path.join(__dirname, '..', '..', '..', 'dist', 'apps', 'web');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Crash recovery: phases left running by a previous process are unwound
// before we accept new work.
const recovered = recoverInterrupted();
if (recovered) console.log(`[recovery] marked ${recovered} interrupted phase(s) as stopped`);

// Render (and any PaaS) assigns $PORT; DEEM_PORT stays for local dev / e2e.
const PORT = process.env.PORT || process.env.DEEM_PORT || 4501;
app.listen(PORT, () => console.log(`Deem server listening on http://localhost:${PORT}`));
syncTelegram();
audit('system', 'server.start', { recovered });

// Graceful shutdown: kill agent children, record state, flush the store.
let shuttingDown = false;
function shutdownAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — stopping agents and flushing state`);
  shutdown();
  deemsvc?.stop();
  audit('system', 'server.stop', { signal });
  db.flushSync();
  process.exit(0);
}
process.on('SIGINT', () => shutdownAndExit('SIGINT'));
process.on('SIGTERM', () => shutdownAndExit('SIGTERM'));
process.on('exit', () => db.flushSync());
