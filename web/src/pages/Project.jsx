import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, useEvents } from '../api.js';
import { Kicker, StatusBadge } from '../components/ui.jsx';

const FILTERS = ['all', 'pending', 'planned', 'implemented', 'reviewed', 'test_planned', 'tested', 'done', 'failed', 'archived'];

function NewTaskModal({ projectId, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', description: '', requirements: '', notes: '', status: 'pending' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [preview, setPreview] = useState(false);

  const submit = async () => {
    const t = await api.post(`/api/projects/${projectId}/tasks`, form);
    onCreated(t);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <Kicker>New task</Kicker>
            <h2>Create task</h2>
          </div>
          <div className="row">
            <button className="pill" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
            <button className="pill" onClick={onClose}>Cancel</button>
          </div>
        </div>

        {preview ? (
          <div>
            <h3>{form.name || '(untitled task)'}</h3>
            <p className="lead">{form.description}</p>
            <Kicker>Requirements</Kicker>
            <ul className="clean">
              {form.requirements.split('\n').filter(Boolean).map((r, i) => <li key={i}>☐ {r}</li>)}
            </ul>
            {form.notes && (<><Kicker>Notes</Kicker><p>{form.notes}</p></>)}
            <button className="pill primary" onClick={submit}>Create task</button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label className="field">
              <span className="lab">Task name *</span>
              <input className="text" value={form.name} onChange={set('name')} required autoFocus />
            </label>
            <label className="field">
              <span className="lab">Description</span>
              <textarea className="text" value={form.description} onChange={set('description')} placeholder="What does this task accomplish?" />
            </label>
            <label className="field">
              <span className="lab">Requirements</span>
              <textarea
                className="text"
                value={form.requirements}
                onChange={set('requirements')}
                placeholder={'One requirement per line:\nUser can log in with email\nSession persists across page reloads'}
              />
              <span className="hint">Each line becomes a checklist item in the task detail format.</span>
            </label>
            <label className="field">
              <span className="lab">Notes</span>
              <textarea className="text" value={form.notes} onChange={set('notes')} placeholder="Any additional context, constraints, or references..." />
            </label>
            <label className="field" style={{ maxWidth: 260 }}>
              <span className="lab">Initial status</span>
              <select className="text" value={form.status} onChange={set('status')}>
                <option value="pending">Pending</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <button className="pill primary" type="submit">Create task</button>
          </form>
        )}
      </div>
    </div>
  );
}

function SettingsModal({ project, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: project.name, description: project.description, repoPath: project.repoPath,
    agent: project.agent, branch: project.branch,
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    onSaved(await api.patch(`/api/projects/${project.id}`, form));
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <Kicker>Project settings</Kicker>
        <h2>Update settings</h2>
        <label className="field"><span className="lab">Name</span>
          <input className="text" value={form.name} onChange={set('name')} /></label>
        <label className="field"><span className="lab">Description</span>
          <input className="text" value={form.description} onChange={set('description')} /></label>
        <label className="field"><span className="lab">Local repository path</span>
          <input className="text" value={form.repoPath} onChange={set('repoPath')} /></label>
        <div className="grid2">
          <label className="field"><span className="lab">Agent</span>
            <select className="text" value={form.agent} onChange={set('agent')}>
              <option value="mock">Mock runner (no API cost)</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select></label>
          <label className="field"><span className="lab">Default branch</span>
            <input className="text" value={form.branch} onChange={set('branch')} /></label>
        </div>
        <div className="row">
          <button className="pill primary" type="submit">Save settings</button>
          <button className="pill" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

export default function Project() {
  const { projectId } = useParams();
  const [proj, setProj] = useState(null);
  const [filter, setFilter] = useState('all');
  const [taskModal, setTaskModal] = useState(false);
  const [settings, setSettings] = useState(false);
  const navigate = useNavigate();

  const refresh = () => api.get(`/api/projects/${projectId}`).then(setProj).catch(() => {});
  useEffect(refresh, [projectId]);
  useEvents(() => refresh(), [projectId]);

  if (!proj) return null;
  const tasks = proj.tasks.filter((t) => filter === 'all' || t.status === filter);

  return (
    <div>
      <div className="card">
        <div className="row between">
          <div>
            <Kicker>Project page</Kicker>
            <h2>{proj.name}</h2>
          </div>
          <div className="row">
            <button className="pill" onClick={() => setSettings(true)}>Update settings</button>
            <Link to="/" className="pill">Back to Home</Link>
          </div>
        </div>
        <p className="lead">{proj.description}</p>
        <div className="row wrap meta">
          <span className="badge blue">{proj.agentLabel}</span>
          <StatusBadge status={proj.health} />
          <b>{proj.tasks.length} tasks</b>
          <code>{proj.branch}</code>
          <span>{proj.repoPath}</span>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <Kicker>Task directory</Kicker>
            <h3>Tasks <span className="badge gray">{tasks.length} shown</span></h3>
          </div>
          <button className="pill primary" onClick={() => setTaskModal(true)}>+ New Task</button>
        </div>
        <div className="filters">
          {FILTERS.map((f) => (
            <button key={f} className={`pill small ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
            </button>
          ))}
        </div>
        {tasks.length === 0 && <div className="empty">No tasks in this view.</div>}
        {tasks.map((t) => (
          <div className="task-row" key={t.id} onClick={() => navigate(`/tasks/${t.id}`)}>
            <div className="row between">
              <h3>{t.name}</h3>
              <span className="row">
                <span className="meta">{fmtDate(t.updatedAt)}</span>
                <StatusBadge status={t.status} />
                {t.runStatus === 'running' && <span className="spin" />}
              </span>
            </div>
            <div className="desc">{t.description}</div>
            <div className="meta" style={{ marginTop: 6 }}>
              {t.requirements.length} requirements · <code>{t.branch}</code>
            </div>
          </div>
        ))}
      </div>

      {taskModal && (
        <NewTaskModal
          projectId={proj.id}
          onClose={() => setTaskModal(false)}
          onCreated={(t) => { setTaskModal(false); navigate(`/tasks/${t.id}`); }}
        />
      )}
      {settings && (
        <SettingsModal project={proj} onClose={() => setSettings(false)} onSaved={() => { setSettings(false); refresh(); }} />
      )}
    </div>
  );
}
