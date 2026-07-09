// Chat command engine — one brain shared by the in-app Command Center and
// the Telegram bridge. Plain-language-ish commands, deterministic parsing.
import { db, uid } from './store.js';
import { startPhase, stop, isRunning, ensurePhases, log, budgetExhausted } from './workflow.js';
import { broadcast } from './events.js';

const state = () => db.get();

function findProject(ref) {
  const r = String(ref || '').trim().toLowerCase();
  return state().projects.find((p) => p.id === r || p.name.toLowerCase() === r) ||
    state().projects.find((p) => p.name.toLowerCase().includes(r));
}

function findTask(ref) {
  const r = String(ref || '').trim().toLowerCase();
  return state().tasks.find((t) => t.id === r) ||
    state().tasks.find((t) => t.name.toLowerCase() === r) ||
    state().tasks.find((t) => t.name.toLowerCase().includes(r));
}

function taskLine(t) {
  const proj = state().projects.find((p) => p.id === t.projectId);
  return `• ${t.name} [${t.status}${t.runStatus === 'running' ? ' ▸ running' : ''}] — ${proj?.name} (${t.id})`;
}

const HELP = `Deem commands:
• status — workspace overview
• projects — list projects
• tasks <project> — list a project's tasks
• new task in <project>: <name> | <description> | <req1; req2; ...>
• run <task name or id> — start/resume the pipeline
• stop <task name or id> — stop the running phase
• report <task name or id> — final report & scores
Anything else shows this help.`;

export function handleChatMessage(text) {
  const msg = String(text || '').trim();
  const lower = msg.toLowerCase();

  if (!msg || lower === 'help' || lower === '/help' || lower === 'start' || lower === '/start') return HELP;

  if (lower === 'status' || lower === '/status') {
    const tasks = state().tasks;
    const running = tasks.filter((t) => t.runStatus === 'running');
    return [
      `Workspace: ${state().projects.length} projects, ${tasks.length} tasks, ${running.length} running.`,
      ...running.map(taskLine),
      ...(running.length ? [] : ['Nothing running right now.']),
    ].join('\n');
  }

  if (lower === 'projects' || lower === '/projects') {
    if (!state().projects.length) return 'No projects yet.';
    return state()
      .projects.map((p) => `• ${p.name} — ${state().tasks.filter((t) => t.projectId === p.id).length} tasks, agent ${p.agent} (${p.id})`)
      .join('\n');
  }

  let m = lower.match(/^\/?tasks\s+(.+)$/);
  if (m) {
    const proj = findProject(m[1]);
    if (!proj) return `No project matches “${m[1]}”.`;
    const tasks = state().tasks.filter((t) => t.projectId === proj.id);
    return tasks.length ? tasks.map(taskLine).join('\n') : `${proj.name} has no tasks yet.`;
  }

  m = msg.match(/^\/?new task in\s+([^:]+):\s*(.+)$/i);
  if (m) {
    const proj = findProject(m[1]);
    if (!proj) return `No project matches “${m[1].trim()}”. Say “projects” to list them.`;
    const [name, description = '', reqs = ''] = m[2].split('|').map((s) => s.trim());
    if (!name) return 'Give the task a name: new task in <project>: <name> | <description> | <req1; req2>';
    const t = {
      id: uid('task'), projectId: proj.id, name,
      description, requirements: reqs.split(';').map((s) => s.trim()).filter(Boolean),
      notes: 'Created via chat control.', status: 'pending', priority: 'Medium',
      branch: proj.branch || 'main', workspace: 'root project', llmProcessId: null,
      runStatus: 'idle', currentPhase: 'plan', planAccepted: false,
      attempts: 0, maxAttempts: 4,
      autoRun: { plan: true, execution: true, review: true, tests: true },
      acceptance: { threshold: 42 },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, totalTokens: 0 },
      budget: { tokens: state().settings.defaultTokenBudget },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    state().tasks.push(t);
    db.save();
    ensurePhases(t.id);
    log(t.id, 'task created via chat control');
    broadcast('task', { taskId: t.id, patch: t });
    startPhase(t.id, 'plan').catch((err) => log(t.id, err.message, 'error'));
    return `Created “${name}” in ${proj.name} and started the pipeline. Say “report ${name}” anytime.`;
  }

  m = lower.match(/^\/?run\s+(.+)$/);
  if (m) {
    const t = findTask(m[1]);
    if (!t) return `No task matches “${m[1]}”.`;
    if (isRunning(t.id)) return `“${t.name}” already has a running phase.`;
    if (budgetExhausted(t)) return `“${t.name}” has exhausted its token budget (${t.usage.totalTokens}/${t.budget.tokens}).`;
    const phase = t.currentPhase || 'plan';
    startPhase(t.id, phase).catch((err) => log(t.id, err.message, 'error'));
    return `Started phase ${phase} for “${t.name}”.`;
  }

  m = lower.match(/^\/?stop\s+(.+)$/);
  if (m) {
    const t = findTask(m[1]);
    if (!t) return `No task matches “${m[1]}”.`;
    return stop(t.id) ? `Stopped “${t.name}”.` : `“${t.name}” has nothing running.`;
  }

  m = lower.match(/^\/?report\s+(.+)$/);
  if (m) {
    const t = findTask(m[1]);
    if (!t) return `No task matches “${m[1]}”.`;
    const phases = state().phases.filter((p) => p.taskId === t.id);
    const exec = phases.find((p) => p.phase === 'execution')?.data;
    const review = phases.find((p) => p.phase === 'review')?.data;
    const summary = phases.find((p) => p.phase === 'summary')?.data;
    const evalTotal = Object.values(exec?.evaluation?.criteria || {}).reduce((a, b) => a + b, 0);
    const reviewTotal = Object.values(review?.scores || {}).reduce((a, b) => a + b, 0);
    return [
      `${t.name} — ${t.status}, phase ${t.currentPhase}, attempts ${t.attempts}/${t.maxAttempts}`,
      exec ? `Implementation evaluation: ${evalTotal}/60` : 'Not implemented yet.',
      review ? `Review: ${review.verdict} (${reviewTotal}/60)` : '',
      t.usage?.totalTokens ? `Tokens: ${t.usage.totalTokens} ($${t.usage.costUsd})` : '',
      summary ? `\n${summary.report}` : '',
    ].filter(Boolean).join('\n');
  }

  return `I didn't recognise that.\n\n${HELP}`;
}

// Persisted chat history for the in-app Command Center.
export function recordExchange(source, message, reply) {
  const chats = state().chats;
  chats.push({ id: uid('msg'), source, message, reply, ts: Date.now() });
  if (chats.length > 300) state().chats = chats.slice(-300);
  db.save();
  broadcast('chat', { source, message, reply, ts: Date.now() });
}
