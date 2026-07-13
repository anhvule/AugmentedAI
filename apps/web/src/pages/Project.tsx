import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Agent, KnowledgeDoc, Project as ProjectType, Skill, Task } from '@deem/shared';
import { api, fmtDate, useEvents } from '../api';
import { Kicker, StatusBadge } from '../components/ui';

const FILTERS = ['all', 'pending', 'planned', 'implemented', 'reviewed', 'test_planned', 'tested', 'done', 'failed', 'archived'];

interface NewTaskForm {
  name: string;
  description: string;
  requirements: string;
  notes: string;
  status: string;
}

function NewTaskModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (t: Task) => void;
}) {
  const [form, setForm] = useState<NewTaskForm>({ name: '', description: '', requirements: '', notes: '', status: 'pending' });
  const set = (k: keyof NewTaskForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const [preview, setPreview] = useState(false);

  const submit = async () => {
    const t = await api.post<Task>(`/api/projects/${projectId}/tasks`, form);
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

interface ProjectSettingsForm {
  name: string;
  description: string;
  repoPath: string;
  agent: Agent;
  branch: string;
  permissionMode: string;
}

function SettingsModal({
  project,
  onClose,
  onSaved,
  refresh,
}: {
  project: ProjectType;
  onClose: () => void;
  onSaved: (p: ProjectType) => void;
  refresh: () => void;
}) {
  const [tab, setTab] = useState<'general' | 'skills' | 'knowledge'>('general');
  const [form, setForm] = useState<ProjectSettingsForm>({
    name: project.name, description: project.description, repoPath: project.repoPath,
    agent: project.agent, branch: project.branch, permissionMode: project.permissionMode || 'restricted',
  });
  const [skill, setSkill] = useState<Pick<Skill, 'name' | 'instructions'>>({ name: '', instructions: '' });
  const [doc, setDoc] = useState<Pick<KnowledgeDoc, 'title' | 'content'>>({ title: '', content: '' });
  const set = (k: keyof Omit<ProjectSettingsForm, 'agent'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onSaved(await api.patch<ProjectType>(`/api/projects/${project.id}`, form));
  };

  const addSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!skill.name.trim()) return;
    await api.post(`/api/projects/${project.id}/skills`, skill);
    setSkill({ name: '', instructions: '' });
    refresh();
  };

  const addDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!doc.title.trim() || !doc.content.trim()) return;
    await api.post(`/api/projects/${project.id}/knowledge`, doc);
    setDoc({ title: '', content: '' });
    refresh();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <Kicker>Project settings</Kicker>
            <h2>Update settings</h2>
          </div>
          <button className="pill" onClick={onClose}>Close</button>
        </div>
        <div className="tabs">
          {([
            ['general', 'General'],
            ['skills', `Skills (${project.skills?.length || 0})`],
            ['knowledge', `Knowledge (${project.knowledge?.length || 0})`],
          ] as const).map(([key, label]) => (
            <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>

        {tab === 'general' && (
          <form onSubmit={submit}>
            <label className="field"><span className="lab">Name</span>
              <input className="text" value={form.name} onChange={set('name')} /></label>
            <label className="field"><span className="lab">Description</span>
              <input className="text" value={form.description} onChange={set('description')} /></label>
            <label className="field"><span className="lab">Local repository path</span>
              <input className="text" value={form.repoPath} onChange={set('repoPath')} /></label>
            <div className="grid2">
              <label className="field"><span className="lab">Agent</span>
                <select className="text" value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value as Agent })}>
                  <option value="mock">Mock runner (no API cost)</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                </select></label>
              <label className="field"><span className="lab">Default branch</span>
                <input className="text" value={form.branch} onChange={set('branch')} /></label>
            </div>
            <label className="field" style={{ maxWidth: 360 }}>
              <span className="lab">Agent permissions</span>
              <select className="text" value={form.permissionMode} onChange={set('permissionMode')}>
                <option value="restricted">Restricted — file edits + dev toolchain only (recommended)</option>
                <option value="full">Full access — agent may run any command</option>
              </select>
              <span className="hint">Applies to real agents. Tasks always run in an isolated git worktree, never your checkout.</span>
            </label>
            <button className="pill primary" type="submit">Save settings</button>
          </form>
        )}

        {tab === 'skills' && (
          <div>
            <p className="lead">Standing instructions injected into every phase prompt — coding standards, conventions, guardrails.</p>
            {(project.skills || []).map((s) => (
              <div className="card inner" key={s.id} style={{ marginBottom: 10 }}>
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{s.name}</h3>
                  <span className="row">
                    <label className="row" style={{ fontSize: 13, fontWeight: 700 }}>
                      <input type="checkbox" checked={s.enabled !== false}
                        onChange={(e) => api.patch(`/api/projects/${project.id}/skills/${s.id}`, { enabled: e.target.checked }).then(refresh)} />
                      enabled
                    </label>
                    <button className="pill small" onClick={() => api.del(`/api/projects/${project.id}/skills/${s.id}`).then(refresh)}>Delete</button>
                  </span>
                </div>
                <p className="meta" style={{ whiteSpace: 'pre-wrap' }}>{s.instructions}</p>
              </div>
            ))}
            <form onSubmit={addSkill} className="card inner">
              <Kicker>Add skill</Kicker>
              <label className="field"><span className="lab">Name</span>
                <input className="text" value={skill.name} onChange={(e) => setSkill({ ...skill, name: e.target.value })} placeholder="TypeScript conventions" /></label>
              <label className="field"><span className="lab">Instructions</span>
                <textarea className="text" value={skill.instructions} onChange={(e) => setSkill({ ...skill, instructions: e.target.value })}
                  placeholder="Always use strict TypeScript. Prefer functional components. Never commit console.log." /></label>
              <button className="pill primary" type="submit">Add skill</button>
            </form>
          </div>
        )}

        {tab === 'knowledge' && (
          <div>
            <p className="lead">Project knowledge base (RAG) — the most relevant chunks are retrieved per task and injected into the agent's prompts.</p>
            {(project.knowledge || []).map((d) => (
              <div className="card inner" key={d.id} style={{ marginBottom: 10 }}>
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{d.title}</h3>
                  <span className="row">
                    <span className="meta">{(d.content || '').length.toLocaleString()} chars</span>
                    <button className="pill small" onClick={() => api.del(`/api/projects/${project.id}/knowledge/${d.id}`).then(refresh)}>Delete</button>
                  </span>
                </div>
                <p className="meta">{(d.content || '').slice(0, 180)}…</p>
              </div>
            ))}
            <form onSubmit={addDoc} className="card inner">
              <Kicker>Add knowledge</Kicker>
              <label className="field"><span className="lab">Title</span>
                <input className="text" value={doc.title} onChange={(e) => setDoc({ ...doc, title: e.target.value })} placeholder="Architecture notes / API contract / domain glossary" /></label>
              <label className="field"><span className="lab">Content</span>
                <textarea className="text" style={{ minHeight: 140 }} value={doc.content} onChange={(e) => setDoc({ ...doc, content: e.target.value })}
                  placeholder="Paste docs, notes, specs — anything the agent should know about this project." /></label>
              <button className="pill primary" type="submit">Add to knowledge base</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const [proj, setProj] = useState<ProjectType | null>(null);
  const [filter, setFilter] = useState('all');
  const [taskModal, setTaskModal] = useState(false);
  const [settings, setSettings] = useState(false);
  const navigate = useNavigate();

  const refresh = () => { api.get<ProjectType>(`/api/projects/${projectId}`).then(setProj).catch(() => {}); };
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
        <SettingsModal project={proj} onClose={() => setSettings(false)} refresh={refresh}
          onSaved={() => { setSettings(false); refresh(); }} />
      )}
    </div>
  );
}
