import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate, useEvents } from '../api.js';
import { Kicker, StatusBadge } from '../components/ui.jsx';

function NewProjectModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', description: '', repoPath: '', agent: 'mock', branch: 'main' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    try {
      onCreated(await api.post('/api/projects', form));
    } catch (ex) {
      setErr(ex.message);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <Kicker>New project</Kicker>
        <h2>Add project</h2>
        <label className="field">
          <span className="lab">Project name *</span>
          <input className="text" value={form.name} onChange={set('name')} required autoFocus />
        </label>
        <label className="field">
          <span className="lab">Description</span>
          <input className="text" value={form.description} onChange={set('description')} placeholder="New Deem project ready for local execution." />
        </label>
        <label className="field">
          <span className="lab">Local repository path *</span>
          <input className="text" value={form.repoPath} onChange={set('repoPath')} placeholder="/Users/you/repos/my-app" required />
          <span className="hint">The agent runs inside this directory and works on a per-task git branch.</span>
        </label>
        <div className="grid2">
          <label className="field">
            <span className="lab">Agent</span>
            <select className="text" value={form.agent} onChange={set('agent')}>
              <option value="mock">Mock runner (no API cost)</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="field">
            <span className="lab">Default branch</span>
            <input className="text" value={form.branch} onChange={set('branch')} />
          </label>
        </div>
        {err && <p style={{ color: '#a03325' }}>{err}</p>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="pill primary" type="submit">Create project</button>
          <button className="pill" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

export default function Home() {
  const [dash, setDash] = useState(null);
  const [projects, setProjects] = useState([]);
  const [modal, setModal] = useState(false);
  const navigate = useNavigate();

  const refresh = () => {
    api.get('/api/dashboard').then(setDash);
    api.get('/api/projects').then(setProjects);
  };
  useEffect(refresh, []);
  useEvents(() => refresh(), []);

  if (!dash) return null;

  return (
    <div className="grid2">
      <div>
        <div className="card">
          <div className="row between">
            <div>
              <Kicker>Workspace home</Kicker>
              <h2>Operational Dashboard</h2>
            </div>
            <button className="pill primary" onClick={() => setModal(true)}>Add New Project</button>
          </div>
          <p className="lead">Track active work, jump into task detail pages, and review the newest projects from one landing page.</p>
          <div className="stats">
            <div className="stat">
              <Kicker>Running now</Kicker>
              <div className="num">{dash.runningNow}</div>
              <div className="desc">Tasks currently moving through the workflow.</div>
            </div>
            <div className="stat">
              <Kicker>Tasks tracked</Kicker>
              <div className="num">{dash.tasksTracked}</div>
              <div className="desc">Sorted by the latest work across planning, execution, review, and manual updates.</div>
            </div>
            <div className="stat">
              <Kicker>Projects</Kicker>
              <div className="num">{dash.projectCount}</div>
              <div className="desc">Newest projects stay at the top with the latest task activity attached.</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="row between">
            <div>
              <Kicker>Running tasks</Kicker>
              <h3>Active workflow work</h3>
            </div>
            <span className="badge blue">{dash.active.length} active</span>
          </div>
          {dash.active.length === 0 && <div className="empty">Nothing running right now.</div>}
          {dash.active.map((t) => (
            <div className="task-row" key={t.id} onClick={() => navigate(`/tasks/${t.id}`)}>
              <div className="row between">
                <h3>{t.name}</h3>
                <span>
                  <span className="badge green">healthy</span>{' '}
                  <span className="badge blue">{t.currentPhase}</span>
                </span>
              </div>
              <div className="meta">
                {t.projectName} · {t.attempts} / {t.maxAttempts} attempts · {fmtDate(t.updatedAt)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <Kicker>Projects</Kicker>
            <h3>Newest projects first</h3>
          </div>
          <span className="badge gray">{projects.length} projects</span>
        </div>
        {projects.length === 0 && <div className="empty">No projects yet — add one to get started.</div>}
        {projects.map((p) => (
          <div className="task-row" key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
            <div className="row between">
              <h3>{p.name}</h3>
              <span className="badge blue">{p.agentLabel}</span>
            </div>
            <div className="desc">{p.description}</div>
            <div className="meta" style={{ marginTop: 6 }}>
              {p.taskCount} tasks · Created {fmtDate(p.createdAt)} · <StatusBadge status={p.health} />
            </div>
            {p.latestTask && (
              <div className="card inner" style={{ marginTop: 10, padding: '12px 16px' }}>
                <Kicker>Latest working on project</Kicker>
                <div style={{ fontWeight: 700, margin: '4px 0' }}>{p.latestTask.name}</div>
                <div className="meta">
                  <StatusBadge status={p.latestTask.status} /> {fmtDate(p.latestTask.updatedAt)}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {modal && (
        <NewProjectModal
          onClose={() => setModal(false)}
          onCreated={(p) => {
            setModal(false);
            navigate(`/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
