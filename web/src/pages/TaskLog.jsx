import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useEvents } from '../api.js';
import { Kicker, StatusBadge } from '../components/ui.jsx';

export default function TaskLog() {
  const { taskId } = useParams();
  const [data, setData] = useState(null);
  const [logs, setLogs] = useState([]);
  const logEnd = useRef(null);

  const refresh = () => {
    api.get(`/api/tasks/${taskId}`).then(setData).catch(() => {});
    api.get(`/api/tasks/${taskId}/logs`).then(setLogs).catch(() => {});
  };
  useEffect(refresh, [taskId]);
  useEvents((type, payload) => {
    if (payload.taskId !== taskId) return;
    if (type === 'log') setLogs((ls) => [...ls.slice(-499), payload]);
    else if (type === 'activity') setData((d) => (d ? { ...d, activity: payload.activity } : d));
    else refresh();
  }, [taskId]);
  useEffect(() => logEnd.current?.scrollIntoView({ behavior: 'smooth' }), [logs.length]);

  if (!data) return null;
  const { task, project, activity } = data;
  const a = activity || { tools: {}, totalToolCalls: 0, transcriptLines: 0 };
  const proc = a.process;
  const tools = Object.entries(a.tools || {}).sort((x, y) => y[1] - x[1]);
  const maxCount = tools[0]?.[1] || 1;

  return (
    <div>
      <div className="card">
        <div className="row between">
          <div className="row">
            <h2 style={{ marginRight: 8 }}>{task.name}</h2>
            <StatusBadge status={task.runStatus}>{task.runStatus.toUpperCase()}</StatusBadge>
          </div>
          <div className="row">
            <Link className="pill" to={`/tasks/${taskId}`}>Back to Task</Link>
            <Link className="pill" to={`/projects/${project.id}`}>Back to Project</Link>
          </div>
        </div>
        <div className="meta">Debug session for the {project.agentLabel} runner — process, tool activity and live transcript.</div>
      </div>

      <div className="card">
        <Kicker>Process</Kicker>
        {proc ? (
          <div className="proc" style={{ marginTop: 12 }}>
            <div className="row1">
              <span>PID <b>{proc.pid}</b></span>
              <b>{(proc.command || '').split(' ')[0]}</b>
              {proc.cpu && <span className="tag">{proc.cpu}</span>}
              {proc.up && <span className="tag">{proc.up}</span>}
              {proc.idle && <span className="tag">{proc.idle}</span>}
              {proc.memMb ? <span className="tag">{proc.memMb} MB RSS</span> : null}
              <StatusBadge status={proc.alive ? 'running' : 'idle'}>{proc.alive ? 'ALIVE' : 'EXITED'}</StatusBadge>
            </div>
            <div className="dim">cmd {proc.command}</div>
            <div className="dim">cwd {proc.cwd}</div>
          </div>
        ) : (
          <div className="empty">No process has run for this task yet.</div>
        )}
      </div>

      <div className="card">
        <Kicker>Tool activity</Kicker>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="kv" style={{ gridTemplateColumns: '1fr' }}>
            <div><div className="k">Session ID</div><div className="v"><code>{a.sessionId || '—'}</code></div></div>
            <div><div className="k">Transcript lines</div><div className="v">{a.transcriptLines}</div></div>
            <div><div className="k">Total tool calls</div><div className="v">{a.totalToolCalls}</div></div>
            <div><div className="k">Last tool</div><div className="v"><code>{a.lastTool || '—'}</code></div></div>
            <div><div className="k">Session file</div><div className="v" style={{ fontSize: 12 }}>{a.sessionFile || '—'}</div></div>
          </div>
          <div>
            <div className="k kicker" style={{ marginBottom: 8 }}>Current tool usage</div>
            {tools.length === 0 && <div className="empty">No tool calls yet.</div>}
            <div className="toolbars">
              {tools.map(([name, count]) => (
                <div className="toolbar-row" key={name}>
                  <span>{name}</span>
                  <span className="count">{count}</span>
                  <span className="track"><i style={{ width: `${(count / maxCount) * 100}%` }} /></span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <Kicker>Live log</Kicker>
          <span className="badge gray">{logs.length} lines</span>
        </div>
        <div className="logbox" style={{ marginTop: 12 }}>
          {logs.map((l, i) => (
            <div key={i} className={l.level}>
              <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
              [{l.source}] {l.message}
            </div>
          ))}
          {logs.length === 0 && <div>No log lines yet.</div>}
          <div ref={logEnd} />
        </div>
      </div>
    </div>
  );
}
