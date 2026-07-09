// Render phase artifacts to Markdown for the per-tab "Export *.md" buttons.
const list = (items = [], mark = '-') => items.map((i) => `${mark} ${i}`).join('\n') || '_none_';

export function exportMarkdown(kind, { task, project, phases, activity }) {
  const art = (p) => phases.find((x) => x.phase === p)?.data || {};
  const head = (title) => `# ${title} — ${task.name}\n\n_Project: ${project.name} · Task ${task.id} · ${new Date().toISOString()}_\n\n`;

  switch (kind) {
    case 'task':
      return (
        head('Task') +
        `## Brief\n${task.description || '(none)'}\n\n## Requirements\n${list(task.requirements)}\n\n` +
        `## Notes\n${task.notes || '_none_'}\n\n## Metadata\n` +
        list([
          `Status: ${task.status}`,
          `Priority: ${task.priority}`,
          `Agent: ${project.agent}`,
          `Branch: ${task.branch || project.branch || 'main'}`,
          `Attempts: ${task.attempts}/${task.maxAttempts}`,
        ])
      );
    case 'plan': {
      const plan = art('plan');
      return (
        head('Plan') +
        `${plan.approach || ''}\n\n` +
        (plan.steps || [])
          .map(
            (s, i) =>
              `## ${i + 1}. ${s.title}\n${s.description}\n\n**Deliverables**\n${list(s.deliverables)}\n\n**Validation**\n${list(s.validation)}\n`
          )
          .join('\n')
      );
    }
    case 'execution': {
      const ex = art('execution');
      const crit = ex.evaluation?.criteria || {};
      return (
        head('Execution') +
        `## Summary\n${ex.summary || ''}\n\n## Steps completed\n${list(ex.stepsCompleted)}\n\n` +
        `## Deviations from plan\n${list(ex.deviations)}\n\n## Files changed\n${list(ex.filesChanged, '- `') .replace(/- `(.*)/g, '- `$1`')}\n\n` +
        `## Evaluation (${Object.values(crit).reduce((a, b) => a + b, 0)}/60)\n` +
        list(Object.entries(crit).map(([k, v]) => `${k}: ${v}/10`)) +
        `\n\n${ex.evaluation?.notes || ''}`
      );
    }
    case 'review': {
      const rv = art('review');
      return (
        head('Review') +
        `## Verdict: ${rv.verdict || 'n/a'} (${Object.values(rv.scores || {}).reduce((a, b) => a + b, 0)}/60)\n${rv.summary || ''}\n\n` +
        `## Strengths\n${list(rv.strengths)}\n\n## Issues\n${list(rv.issues)}\n\n## Scores\n` +
        list(Object.entries(rv.scores || {}).map(([k, v]) => `${k}: ${v}/10`))
      );
    }
    case 'test_plan': {
      const tp = art('test_plan');
      return (
        head('Test Plan') +
        `## Environment\n${list(tp.environment)}\n\n` +
        (tp.autoCases || [])
          .map(
            (c, i) =>
              `## Auto ${i + 1}. ${c.title} (${c.priority})\n**Setup**\n${list(c.setup)}\n\n**Commands**\n\`\`\`\n${(c.commands || []).join('\n')}\n\`\`\`\n\n**Expected**\n${list(c.expected)}\n\n${c.notes || ''}\n`
          )
          .join('\n') +
        (tp.manualCases || [])
          .map((c, i) => `\n## Manual ${i + 1}. ${c.title}\n**Steps**\n${list(c.steps)}\n\n**Expected**\n${list(c.expected)}\n`)
          .join('\n')
      );
    }
    case 'test_results': {
      const tr = art('test_results');
      return (
        head('Test Results') +
        (tr.results || []).map((r) => `- **${r.status.toUpperCase()}** — ${r.title}\n  \`${r.output || ''}\``).join('\n') +
        `\n\n${tr.summary || ''}`
      );
    }
    case 'summary': {
      const sm = art('summary');
      return (
        head('Summary') +
        `${sm.report || ''}\n\n## Requirements\n` +
        list((sm.requirements || []).map((r) => `${r.met ? '✅' : '❌'} ${r.requirement}`)) +
        `\n\n## Follow-ups\n${list(sm.followUps)}\n\n## Debug\n` +
        list([
          `Session: ${activity?.sessionId || 'n/a'}`,
          `Total tool calls: ${activity?.totalToolCalls ?? 0}`,
          `Transcript lines: ${activity?.transcriptLines ?? 0}`,
        ])
      );
    }
    default:
      throw new Error(`unknown export kind ${kind}`);
  }
}
