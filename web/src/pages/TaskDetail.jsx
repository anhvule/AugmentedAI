import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, useEvents } from '../api.js';
import { Kicker, StatusBadge, ScoreChips, ScoreTotal, Section } from '../components/ui.jsx';

const TABS = [
  ['task', 'Task'], ['plan', 'Plan'], ['execution', 'Execution'], ['review', 'Review'],
  ['test_plan', 'Test Plan'], ['test_results', 'Test Results'], ['summary', 'Summary'],
];
const PHASE_LABEL = Object.fromEntries(TABS);

function List({ items, empty = 'none' }) {
  if (!items?.length) return <div className="empty">{empty}</div>;
  return <ul className="clean">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

export default function TaskDetail() {
  const { taskId } = useParams();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('task');

  const refresh = () => api.get(`/api/tasks/${taskId}`).then(setData).catch(() => {});
  useEffect(() => { refresh(); }, [taskId]);
  useEvents((type, payload) => {
    if (payload.taskId === taskId && type !== 'log') refresh();
  }, [taskId]);

  if (!data) return null;
  const { task, project, phases, activity } = data;
  const phase = (name) => phases.find((p) => p.phase === name) || {};
  const runningPhase = phases.find((p) => p.status === 'running')?.phase;
  const art = (name) => phase(name).data;

  const run = (p) => api.post(`/api/tasks/${taskId}/run`, { phase: p }).catch((e) => alert(e.message));
  const stopRun = () => api.post(`/api/tasks/${taskId}/stop`);
  const acceptPlan = () => api.post(`/api/tasks/${taskId}/accept-plan`).catch((e) => alert(e.message));
  const setAutoRun = (key, val) => api.patch(`/api/tasks/${taskId}`, { autoRun: { [key]: val } });
  const exportMd = (kind) => window.open(`/api/tasks/${taskId}/export/${kind}`, '_blank');

  const phaseActions = (p) => {
    const rec = phase(p);
    if (rec.status === 'running') return <button className="pill" onClick={stopRun}>Stop</button>;
    if (p === 'execution' && !task.planAccepted) return null;
    if (['ready', 'stopped', 'failed'].includes(rec.status))
      return <button className="pill primary" onClick={() => run(p)}>Run {PHASE_LABEL[p]}</button>;
    if (rec.status === 'done')
      return <button className="pill" onClick={() => run(p)}>Rerun</button>;
    return null;
  };

  const autoRunPanel = (key, title, desc) => (
    <div className="card inner" style={{ marginTop: 14 }}>
      <div className="row between">
        <Kicker>Auto run</Kicker>
        <StatusBadge status={task.autoRun[key] ? 'done' : 'blocked'}>{task.autoRun[key] ? 'ON' : 'OFF'}</StatusBadge>
      </div>
      <h3 style={{ margin: '6px 0 2px' }}>{title}</h3>
      <label className="row" style={{ margin: '6px 0', fontWeight: 700 }}>
        <input type="checkbox" checked={task.autoRun[key]} onChange={(e) => setAutoRun(key, e.target.checked)} /> On
      </label>
      <div className="meta">{desc}</div>
    </div>
  );

  return (
    <div>
      <div className="card">
        <div className="row between">
          <div className="row">
            <h2 style={{ marginRight: 8 }}>{task.name}</h2>
            <StatusBadge status={task.status} />
            {task.planAccepted && <span className="badge green">Accepted</span>}
            {runningPhase && <span className="spin" />}
          </div>
          <div className="row">
            <Link className="pill" to={`/tasks/${taskId}/log`}>View Log</Link>
            <Link className="pill" to={`/projects/${project.id}`}>Back to Project</Link>
          </div>
        </div>
        <div className="tabs">
          {TABS.map(([key, label]) => (
            <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
              {label}
              {runningPhase === key && <span className="dot" />}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 18, alignItems: 'start' }}>
        <div>
          {tab === 'task' && (
            <Section kicker="Task" title="Task Details" strip
              right={<><button className="pill" onClick={() => exportMd('task')}>Export Task.md</button>{phaseActions('plan')}</>}>
              <div className="card inner" style={{ marginTop: 14 }}>
                <Kicker>Task brief</Kicker>
                <h3>What needs to happen</h3>
                <p className="lead" style={{ margin: 0 }}>{task.description || 'No description.'}</p>
              </div>
              <div className="card inner" style={{ marginTop: 14 }}>
                <Kicker>Requirements</Kicker>
                <h3>Checklist for completion</h3>
                <List items={task.requirements} empty="No checklist items yet." />
              </div>
              <div className="card inner" style={{ marginTop: 14 }}>
                <Kicker>Notes</Kicker>
                <h3>Additional context</h3>
                <p style={{ margin: 0 }}>{task.notes || 'No additional notes.'}</p>
              </div>
              <div className="card inner" style={{ marginTop: 14 }}>
                <div className="row between">
                  <div>
                    <Kicker>Task actions</Kicker>
                    <h3>Close this task</h3>
                  </div>
                  <button className="pill" onClick={() => api.patch(`/api/tasks/${taskId}`, { status: 'archived' })}>Close Task</button>
                </div>
              </div>
            </Section>
          )}

          {tab === 'plan' && (
            <Section kicker="Plan" title="Implementation Plan" strip
              right={
                <>
                  <StatusBadge status={phase('plan').status} />
                  <button className="pill" onClick={() => exportMd('plan')}>Export Plan.md</button>
                  {art('plan') && !task.planAccepted && (
                    <button className="pill primary" onClick={acceptPlan}>Accept Plan</button>
                  )}
                  {phaseActions('plan')}
                </>
              }>
              {!art('plan') && <div className="empty">No plan yet — run the plan phase.</div>}
              {art('plan') && (
                <>
                  <p className="lead">{art('plan').approach}</p>
                  {art('plan').steps?.map((s, i) => (
                    <div className="step" key={i}>
                      <div className="row between">
                        <h3>{i + 1}. {s.title}</h3>
                        <span className="badge blue">{s.runner || 'LOCAL RUNNER'}</span>
                      </div>
                      <p style={{ margin: '4px 0 0', color: '#4d5875' }}>{s.description}</p>
                      <div className="cols">
                        <div><h4>Deliverables</h4><List items={s.deliverables} /></div>
                        <div><h4>Validation</h4><List items={s.validation} /></div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </Section>
          )}

          {tab === 'execution' && (
            <Section kicker="Execution" title="Execution" strip
              right={
                <>
                  <StatusBadge status={phase('execution').status} />
                  <button className="pill" onClick={() => exportMd('execution')}>Export Execution.md</button>
                  {phaseActions('execution')}
                </>
              }>
              {phase('execution').status === 'running' && (
                <div className="card inner" style={{ marginTop: 14 }}>
                  <Kicker>Implementing</Kicker>
                  <p style={{ margin: '6px 0 0' }}>
                    The agent is working. Stop the current running work if you need to update the task before rerunning it.
                  </p>
                </div>
              )}
              {phase('execution').status === 'blocked' && <div className="empty">Blocked — accept the plan first.</div>}
              {phase('execution').error && <p style={{ color: '#a03325' }}>{phase('execution').error}</p>}
              {art('execution') && (
                <>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <Kicker>Execution summary</Kicker>
                    <p style={{ margin: '6px 0 0' }}>{art('execution').summary}</p>
                  </div>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <div className="row between"><Kicker>Steps completed</Kicker>
                      <span className="badge gray">{art('execution').stepsCompleted?.length || 0}</span></div>
                    <List items={art('execution').stepsCompleted} />
                  </div>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <div className="row between"><Kicker>Deviations from plan</Kicker>
                      <span className="badge gray">{art('execution').deviations?.length || 0}</span></div>
                    <List items={art('execution').deviations} empty="No deviations." />
                  </div>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <div className="row between"><Kicker>Files changed</Kicker>
                      <span className="badge gray">{art('execution').filesChanged?.length || 0}</span></div>
                    <List items={art('execution').filesChanged} empty="No files recorded." />
                    {art('execution').branch && <div className="meta">Branch: <code>{art('execution').branch}</code></div>}
                  </div>
                </>
              )}
            </Section>
          )}

          {tab === 'review' && (
            <Section kicker="Review" title="Review" strip
              right={
                <>
                  <StatusBadge status={phase('review').status} />
                  <button className="pill" onClick={() => exportMd('review')}>Export Review.md</button>
                  {phaseActions('review')}
                </>
              }>
              {!art('review') && <div className="empty">No review yet.</div>}
              {art('review') && (
                <>
                  <div className={`verdict ${art('review').verdict === 'approved' ? '' : 'bad'}`} style={{ marginTop: 14 }}>
                    <div className="row between">
                      <div>
                        <Kicker>Verdict</Kicker>
                        <div className="pill-verdict" style={{ marginTop: 6 }}>
                          {art('review').verdict === 'approved' ? 'Approved' : 'Rejected'}
                        </div>
                      </div>
                      <ScoreTotal scores={art('review').scores} label="Score" />
                    </div>
                    <div className="bar">
                      <i style={{ width: `${(Object.values(art('review').scores || {}).reduce((a, b) => a + b, 0) / 60) * 100}%` }} />
                    </div>
                    <p style={{ margin: 0 }}>{art('review').summary}</p>
                  </div>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <div className="row between"><Kicker>Strengths</Kicker>
                      <span className="badge gray">{art('review').strengths?.length || 0}</span></div>
                    <List items={art('review').strengths} />
                  </div>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <div className="row between"><Kicker>Issues</Kicker>
                      <span className="badge gray">{art('review').issues?.length || 0}</span></div>
                    <List items={art('review').issues} empty="No issues raised." />
                  </div>
                </>
              )}
            </Section>
          )}

          {tab === 'test_plan' && (
            <Section kicker="Test plan" title="Test Plan" strip
              right={
                <>
                  <StatusBadge status={phase('test_plan').status} />
                  <button className="pill" onClick={() => exportMd('test_plan')}>Export TestPlan.md</button>
                  {phaseActions('test_plan')}
                  {art('test_plan') && <button className="pill primary" onClick={() => setTab('test_results')}>Go to Test Results →</button>}
                </>
              }>
              {!art('test_plan') && <div className="empty">No test plan yet.</div>}
              {art('test_plan') && (
                <>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <Kicker>Environment</Kicker>
                    <List items={art('test_plan').environment} />
                  </div>
                  {art('test_plan').autoCases?.map((c, i) => (
                    <div className="step" key={i}>
                      <div className="row between">
                        <h3>{i + 1}. {c.title}</h3>
                        <span><span className="badge blue">Auto-run</span> <span className="badge red">{c.priority}</span></span>
                      </div>
                      <div className="cols">
                        <div>
                          <h4>Related changes</h4><List items={c.relatedChanges} />
                          <h4>Commands</h4><pre className="code">{(c.commands || []).join('\n')}</pre>
                        </div>
                        <div>
                          <h4>Setup</h4><List items={c.setup} />
                          <h4>Expected results</h4><List items={c.expected} />
                        </div>
                      </div>
                      {c.notes && <div className="meta">{c.notes}</div>}
                    </div>
                  ))}
                  {art('test_plan').manualCases?.map((c, i) => (
                    <div className="step" key={`m${i}`}>
                      <div className="row between">
                        <h3>Manual {i + 1}. {c.title}</h3>
                        <span className="badge tan">Manual</span>
                      </div>
                      <div className="cols">
                        <div><h4>Manual steps</h4><List items={c.steps} /></div>
                        <div><h4>Expected results</h4><List items={c.expected} /></div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </Section>
          )}

          {tab === 'test_results' && (
            <Section kicker="Test results" title="Test Results" strip
              right={
                <>
                  <StatusBadge status={phase('test_results').status} />
                  <button className="pill" onClick={() => exportMd('test_results')}>Export TestResults.md</button>
                  {phaseActions('test_results')}
                </>
              }>
              {!art('test_results') && <div className="empty">No test results yet.</div>}
              {art('test_results') && (
                <>
                  {art('test_results').results?.map((r, i) => (
                    <div className="card inner" style={{ marginTop: 14 }} key={i}>
                      <div className="row between">
                        <h3 style={{ margin: 0 }}>{r.title}</h3>
                        <StatusBadge status={r.status === 'passed' ? 'done' : 'failed'}>{r.status}</StatusBadge>
                      </div>
                      {r.output && <pre className="code" style={{ marginTop: 10 }}>{r.output}</pre>}
                    </div>
                  ))}
                  <p className="lead" style={{ marginTop: 14 }}>{art('test_results').summary}</p>
                </>
              )}
            </Section>
          )}

          {tab === 'summary' && (
            <Section kicker="Summary" title="Final Report" strip
              right={
                <>
                  <StatusBadge status={phase('summary').status} />
                  <button className="pill" onClick={() => exportMd('summary')}>Export Summary.md</button>
                  {phaseActions('summary')}
                </>
              }>
              {!art('summary') && <div className="empty">No summary yet — it is generated when the pipeline completes.</div>}
              {art('summary') && (
                <>
                  <p className="lead" style={{ marginTop: 14 }}>{art('summary').report}</p>
                  <div className="card inner">
                    <Kicker>Requirements</Kicker>
                    <ul className="clean">
                      {art('summary').requirements?.map((r, i) => (
                        <li key={i}>{r.met ? '✅' : '❌'} {r.requirement}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="card inner" style={{ marginTop: 14 }}>
                    <Kicker>Follow-ups</Kicker>
                    <List items={art('summary').followUps} />
                  </div>
                </>
              )}
            </Section>
          )}
        </div>

        {/* ---------- right sidebar ---------- */}
        <div>
          {tab === 'execution' && (
            <>
              <div className="card">
                <div className="row between">
                  <Kicker>Implementation retries</Kicker>
                  <StatusBadge status={task.autoRun.execution ? 'done' : 'blocked'}>{task.autoRun.execution ? 'ON' : 'OFF'}</StatusBadge>
                </div>
                <p className="meta" style={{ marginTop: 8 }}>
                  {task.autoRun.execution
                    ? `Auto retry is on. Implementation retries up to ${task.maxAttempts - 1} times until it is accepted or the budget is exhausted.`
                    : 'Auto retry is off. Rerun execution manually after updating the task.'}
                </p>
                <div className="meta"><b>{task.attempts} / {task.maxAttempts}</b> attempts used</div>
              </div>
              <div className="card" style={{ marginTop: 14 }}>
                <Kicker>Implementation evaluation</Kicker>
                {art('execution')?.evaluation ? (
                  <div>
                    <div className="row between" style={{ marginTop: 8 }}>
                      <p className="meta" style={{ margin: 0, maxWidth: 200 }}>{art('execution').evaluation.notes}</p>
                      <ScoreTotal scores={art('execution').evaluation.criteria} />
                    </div>
                    <ScoreChips scores={art('execution').evaluation.criteria} />
                  </div>
                ) : (
                  <p className="meta" style={{ marginTop: 8 }}>Scores will appear after implementation runs.</p>
                )}
              </div>
              {autoRunPanel('execution', 'Auto Run Execution', 'Start implementation automatically after the plan is accepted.')}
              {autoRunPanel('review', 'Auto Run Review', 'Start the independent review automatically after implementation is accepted.')}
              {autoRunPanel('tests', 'Auto Run Tests', 'Generate the test plan, run tests and produce the summary automatically after review approval.')}
            </>
          )}

          {tab === 'review' && art('review') && (
            <div className="card">
              <Kicker>Review scores</Kicker>
              <div className="row between" style={{ marginTop: 8 }}>
                <p className="meta" style={{ margin: 0, maxWidth: 200 }}>{art('review').summary}</p>
                <ScoreTotal scores={art('review').scores} />
              </div>
              <ScoreChips scores={art('review').scores} />
            </div>
          )}

          <div className="card" style={{ marginTop: tab === 'execution' || (tab === 'review' && art('review')) ? 14 : 0 }}>
            <div className="row between">
              <div>
                <Kicker>Phase status</Kicker>
                <h3>Workflow progress</h3>
              </div>
              <StatusBadge status={task.status === 'done' ? 'done' : runningPhase ? 'running' : task.status}>
                {task.status === 'done' ? 'COMPLETED' : runningPhase ? 'RUNNING' : task.status.replace(/_/g, ' ')}
              </StatusBadge>
            </div>
            <div className="side-list">
              <div className="side-item"><span>Task</span><StatusBadge status="done">DONE</StatusBadge></div>
              {phases.map((p) => (
                <div className="side-item" key={p.phase}>
                  <span>{PHASE_LABEL[p.phase]}</span>
                  <StatusBadge status={p.status}>
                    {p.status === 'done' ? 'DONE' : p.status.toUpperCase()}
                  </StatusBadge>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <div className="row between">
              <div>
                <Kicker>Task metadata</Kicker>
                <h3>Identifiers and runtime context</h3>
              </div>
              <StatusBadge status={task.status} />
            </div>
            <div className="kv">
              <div><div className="k">Task ID</div><div className="v"><code>{task.id}</code></div></div>
              <div><div className="k">LLM process ID</div><div className="v"><code>{task.llmProcessId || '—'}</code></div></div>
              <div><div className="k">Project</div><div className="v">{project.name}</div></div>
              <div><div className="k">Agent</div><div className="v">{project.agentLabel?.toLowerCase()}</div></div>
              <div><div className="k">Provider</div><div className="v">{project.provider}</div></div>
              <div><div className="k">Run status</div><div className="v"><StatusBadge status={task.runStatus}>{task.runStatus.toUpperCase()}</StatusBadge></div></div>
              <div><div className="k">Task status</div><div className="v">{task.status}</div></div>
              <div><div className="k">Priority</div><div className="v">{task.priority}</div></div>
              <div><div className="k">Workspace</div><div className="v">{task.workspace}</div></div>
              <div><div className="k">Branch</div><div className="v"><code>{task.branch}</code></div></div>
              <div><div className="k">Current phase</div><div className="v">{task.currentPhase}</div></div>
              <div><div className="k">Attempts</div><div className="v">{task.attempts} / {task.maxAttempts}</div></div>
              <div style={{ gridColumn: '1 / -1' }}><div className="k">Updated</div><div className="v">{fmtDate(task.updatedAt)}</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
