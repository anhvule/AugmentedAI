import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uid } from './store.js';
import { sseHandler, broadcast } from './events.js';
import { PHASES, ensurePhases, startPhase, acceptPlan, stop, isRunning, phaseRecord, log } from './workflow.js';
import { exportMarkdown } from './exporters.js';
import { AGENT_LABELS } from './agents/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const state = () => db.get();
const findTask = (id) => state().tasks.find((t) => t.id === id);
const findProject = (id) => state().projects.find((p) => p.id === id);

// ---------- session / profile ----------
app.get('/api/profile', (req, res) => res.json(state().profile));
app.post('/api/profile', (req, res) => {
  const { name, email } = req.body;
  state().profile = { name: name || 'Operator', email: email || '' };
  db.save();
  res.json(state().profile);
});
app.post('/api/logout', (req, res) => {
  state().profile = null;
  db.save();
  res.json({ ok: true });
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
  const { name, description, repoPath, agent = 'mock', branch = 'main' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const healthy = repoPath && fs.existsSync(repoPath);
  const proj = {
    id: uid('proj'),
    name,
    description: description || 'New Deem project ready for local execution.',
    repoPath: repoPath || '',
    agent,
    provider: agent === 'codex' ? 'openai' : agent === 'claude-code' ? 'anthropic' : 'deem',
    branch,
    health: healthy ? 'healthy' : 'needs attention',
    createdAt: Date.now(),
  };
  state().projects.push(proj);
  db.save();
  broadcast('projects', {});
  res.json(proj);
});

app.patch('/api/projects/:id', (req, res) => {
  const proj = findProject(req.params.id);
  if (!proj) return res.status(404).json({ error: 'not found' });
  const { name, description, repoPath, agent, branch } = req.body;
  Object.assign(proj, {
    ...(name && { name }),
    ...(description !== undefined && { description }),
    ...(repoPath !== undefined && { repoPath, health: fs.existsSync(repoPath) ? 'healthy' : 'needs attention' }),
    ...(agent && { agent, provider: agent === 'codex' ? 'openai' : agent === 'claude-code' ? 'anthropic' : 'deem' }),
    ...(branch && { branch }),
  });
  db.save();
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
  t.updatedAt = Date.now();
  db.save();
  broadcast('task', { taskId: t.id, patch: t });
  res.json(t);
});

app.post('/api/tasks/:id/run', async (req, res) => {
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (isRunning(t.id)) return res.status(409).json({ error: 'a phase is already running' });
  const phase = req.body.phase || t.currentPhase || 'plan';
  if (phase === 'execution' && !t.planAccepted) return res.status(400).json({ error: 'plan must be accepted first' });
  startPhase(t.id, phase).catch((err) => log(t.id, `run failed: ${err.message}`, 'error'));
  res.json({ ok: true, phase });
});

app.post('/api/tasks/:id/stop', (req, res) => {
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

// ---------- events ----------
app.get('/api/events', sseHandler);

// ---------- static (production build) ----------
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.DEEM_PORT || 4501;
app.listen(PORT, () => console.log(`Deem server listening on http://localhost:${PORT}`));
