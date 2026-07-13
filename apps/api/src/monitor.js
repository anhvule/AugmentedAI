// Debug telemetry: per-task tool activity plus live process stats for the
// running agent, polled from `ps`.
import { execFile } from 'node:child_process';
import { db } from './store.js';
import { broadcast } from './events.js';

const timers = new Map(); // taskId -> interval
const lastEvent = new Map(); // taskId -> ts

function activity(taskId) {
  const state = db.get();
  if (!state.activity[taskId]) {
    state.activity[taskId] = {
      sessionId: null,
      sessionFile: null,
      transcriptLines: 0,
      totalToolCalls: 0,
      lastTool: null,
      tools: {},
      process: null,
    };
  }
  return state.activity[taskId];
}

export function touchActivity(taskId, ev) {
  const a = activity(taskId);
  lastEvent.set(taskId, Date.now());
  if (ev.type === 'session') {
    a.sessionId = ev.sessionId;
    if (ev.sessionFile) a.sessionFile = ev.sessionFile;
  } else if (ev.type === 'tool') {
    a.totalToolCalls += 1;
    a.lastTool = ev.name;
    a.tools[ev.name] = (a.tools[ev.name] || 0) + 1;
    a.transcriptLines += 2;
  } else if (ev.type === 'log') {
    a.transcriptLines += 1;
    logLine(taskId, ev.message);
  } else if (ev.type === 'process') {
    a.process = { ...(a.process || {}), pid: ev.pid, command: ev.command, cwd: ev.cwd, alive: true };
  }
  db.save();
  broadcast('activity', { taskId, activity: a });
}

function logLine(taskId, message) {
  const state = db.get();
  state.logs.push({ taskId, ts: Date.now(), level: 'info', source: 'agent', message });
  broadcast('log', { taskId, ts: Date.now(), level: 'info', source: 'agent', message });
}

function fmtElapsed(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

export function startMonitor(taskId) {
  lastEvent.set(taskId, Date.now());
  const a = activity(taskId);
  if (!a.process) a.process = { pid: process.pid, command: 'deem internal runner', cwd: process.cwd(), alive: true };
  a.process.startedAt = Date.now();
  const timer = setInterval(() => {
    const act = activity(taskId);
    const pid = act.process?.pid;
    if (!pid) return;
    execFile('ps', ['-o', '%cpu=,rss=,etimes=', '-p', String(pid)], (err, stdout) => {
      const idleSec = Math.floor((Date.now() - (lastEvent.get(taskId) || Date.now())) / 1000);
      if (!err && stdout.trim()) {
        const [cpu, rss, etimes] = stdout.trim().split(/\s+/).map(Number);
        Object.assign(act.process, {
          cpu: `${cpu.toFixed(1)}% CPU`,
          memMb: Math.round(rss / 1024),
          up: `up ${fmtElapsed(Math.min(etimes, Math.floor((Date.now() - act.process.startedAt) / 1000)))}`,
          idle: `idle ${idleSec}s`,
          alive: true,
        });
      } else {
        Object.assign(act.process, { idle: `idle ${idleSec}s` });
      }
      db.save();
      broadcast('activity', { taskId, activity: act });
    });
  }, 2000);
  timers.set(taskId, timer);
}

export function stopMonitor(taskId) {
  clearInterval(timers.get(taskId));
  timers.delete(taskId);
  const a = db.get().activity[taskId];
  if (a?.process) {
    a.process.alive = false;
    db.save();
    broadcast('activity', { taskId, activity: a });
  }
}
