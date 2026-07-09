import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uid } from './store.js';
import { sseHandler, broadcast } from './events.js';
import { PHASES, ensurePhases, startPhase, acceptPlan, stop, isRunning, phaseRecord, log, budgetExhausted } from './workflow.js';
import { exportMarkdown } from './exporters.js';
import { AGENT_LABELS } from './agents/index.js';
import { register, verify, createSession, destroySession, sessionCookie, clearCookie, authMiddleware } from './auth.js';
import { handleChatMessage, recordExchange } from './chat.js';
import { syncTelegram } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', authMiddleware);

const state = () => db.get();
const findTask = (id) => state().tasks.find((t) => t.id === id);
const findProject = (id) => state().projects.find((p) => p.id === id);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  try {
    const user = register(req.body);
    res.setHeader('Set-Cookie', sessionCookie(createSession(user.id)));
    res.json(publicUser(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  const user = verify(req.body);
  if (!user) return res.status(401).json({ error: 'invalid email or password' });
  res.setHeader('Set-Cookie', sessionCookie(createSession(user.id)));
  res.json(publicUser(user));
});

app.get('/api/profile', (req, res) => res.json(publicUser(req.user)));

app.post('/api/logout', (req, res) => {
  destroySession(req.user.token);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

// ---------- workspace settings ----------
app.get('/api/settings', (req, res) => {
  const { telegramToken, defaultTokenBudget } = state().settings;
  res.json({ telegramToken: telegramToken ? '••••' + telegramToken.slice(-4) : '', defaultTokenBudget, telegramConfigured: !!telegramToken });
});

app.patch('/api/settings', (req, res) => {
  const s = state().settings;
  if ('telegramToken' in req.body) {
    s.telegramToken = String(req.body.telegramToken || '').trim();
    s.telegramOffset = 0;
    syncTelegram();
  }
  if ('defaultTokenBudget' in req.body) s.defaultTokenBudget = Math.max(1000, Number(req.body.defaultTokenBudget) || 500000);
  db.save();
  res.json({ ok: true });
});

// ---------- chat control ----------
app.get('/api/chat', (req, res) => res.json(state().chats.slice(-100)));
app.post('/api/chat', (req, res) => {
  const reply = handleChatMessage(req.body.message);
  recordExchange('web', req.body.message, reply);
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
  t.updatedAt = Date.now();
  db.save();
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
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.DEEM_PORT || 4501;
app.listen(PORT, () => console.log(`Deem server listening on http://localhost:${PORT}`));
syncTelegram();
