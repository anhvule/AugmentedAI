// Deterministic simulated agent. Produces realistic artifacts for every
// phase with zero API cost, emits tool/process events like a real runner,
// and (when the project points at a git repo) works on a real task branch so
// the end-to-end flow is genuine.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DELAY = Number(process.env.DEEM_MOCK_DELAY_MS || 900);

// Seeded PRNG so a given task+attempt always evaluates the same way —
// "systematic, not random".
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function taskSlug(task) {
  return task.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

async function emitTools(onEvent, tools) {
  for (const name of tools) {
    onEvent({ type: 'tool', name });
    onEvent({ type: 'log', message: `tool ${name}` });
    await sleep(DELAY / tools.length);
  }
}

function requirementList(task) {
  return task.requirements?.length
    ? task.requirements
    : [`Implements: ${task.description || task.name}`];
}

function buildPlan(task) {
  const reqs = requirementList(task);
  const steps = [
    {
      title: 'Inspect project structure and relevant modules',
      description:
        'Read the project layout, entry points and existing styles/components that relate to the task so changes integrate with the current architecture.',
      runner: 'LOCAL RUNNER',
      deliverables: ['Notes on affected files and integration points'],
      validation: ['Affected files identified and reachable from the project root'],
    },
    {
      title: `Implement: ${task.name}`,
      description: task.description || task.name,
      runner: 'LOCAL RUNNER',
      deliverables: reqs.map((r) => `Change satisfying: ${r}`),
      validation: ['No syntax errors reported by the toolchain', 'Change is visible in the running app'],
    },
    {
      title: 'Integrate and wire up the change',
      description: 'Connect the new code to the existing entry point so it takes effect on every page/run.',
      runner: 'LOCAL RUNNER',
      deliverables: ['Updated entry point importing and using the new code'],
      validation: ['Project compiles without errors'],
    },
    {
      title: 'Run and visually validate',
      description:
        'Start the project, confirm the requirement is met, existing behaviour still works, and no console errors appear.',
      runner: 'LOCAL RUNNER',
      deliverables: ['Validation notes with observed behaviour'],
      validation: reqs,
    },
  ];
  return {
    approach:
      `Plan for “${task.name}”: make the smallest coherent change that satisfies every requirement, ` +
      'integrated with the existing structure, then validate it running.',
    steps,
  };
}

function execute(task, project, attempt, onEvent) {
  const cwd = project.repoPath;
  const branch = `task/${taskSlug(task)}`;
  const filesChanged = [];
  let repoNote = 'Project path is not a git repository — changes recorded as artifacts only.';

  if (cwd && fs.existsSync(path.join(cwd, '.git'))) {
    git(cwd, 'checkout', '-B', branch);
    const artifactDir = path.join(cwd, '.deem');
    fs.mkdirSync(artifactDir, { recursive: true });
    const file = path.join(artifactDir, `${task.id}.md`);
    fs.writeFileSync(
      file,
      `# ${task.name}\n\nAttempt ${attempt}\n\n${task.description || ''}\n\n` +
        requirementList(task).map((r) => `- [x] ${r}`).join('\n') + '\n'
    );
    filesChanged.push(path.relative(cwd, file));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', `${task.name} (deem attempt ${attempt})`);
    repoNote = `Work committed on branch ${branch}.`;
    onEvent({ type: 'log', message: `git: committed on ${branch}` });
  }
  return { branch, filesChanged, repoNote };
}

const EXEC_CRITERIA = [
  'Requirements Met',
  'Code Correctness',
  'Plan Adherence',
  'No Regression Risk',
  'Code Quality',
  'Completeness',
];
const REVIEW_CRITERIA = [
  'Correctness',
  'Plan Adherence',
  'Code Quality',
  'Risk and Regressions',
  'Completeness',
  'Improvement Opportunities',
];

function scores(criteria, seed, floor = 7) {
  const rand = rng(seed);
  const out = {};
  for (const c of criteria) out[c] = floor + Math.floor(rand() * (10 - floor + 1));
  return out;
}

export const mockAgent = {
  name: 'mock',
  async run(job) {
    const { phase, task, project, attempt = 1, onEvent } = job;
    onEvent({ type: 'session', sessionId: `mock_${task.id}_${phase}`, sessionFile: null });
    const seed = `${task.id}:${phase}:${attempt}`;

    switch (phase) {
      case 'plan': {
        await emitTools(onEvent, ['list_projects', 'search_code', 'get_code_snippet', 'search_graph']);
        return { ok: true, json: buildPlan(task) };
      }
      case 'execution': {
        await emitTools(onEvent, [
          'exec_command', 'search_code', 'exec_command', 'get_code_snippet',
          'exec_command', 'trace_path', 'exec_command', 'exec_command',
        ]);
        const { branch, filesChanged, repoNote } = execute(task, project, attempt, onEvent);
        const s = scores(EXEC_CRITERIA, seed, attempt > 1 ? 9 : 8);
        return {
          ok: true,
          json: {
            summary:
              `${task.name} was implemented per the accepted plan${attempt > 1 ? ` (attempt ${attempt}, incorporating evaluator feedback)` : ''}. ` +
              `${repoNote} The change satisfies the stated requirements and integrates with the existing structure.`,
            stepsCompleted: buildPlan(task).steps.map((st) => st.title),
            deviations: attempt > 1 ? [] : ['Minor styling beyond the minimal plan scope, kept for coherence'],
            filesChanged,
            branch,
            evaluation: { criteria: s, notes: 'All plan steps implemented; validations pass on local run.' },
          },
        };
      }
      case 'review': {
        await emitTools(onEvent, ['get_code_snippet', 'search_code', 'trace_path']);
        const s = scores(REVIEW_CRITERIA, seed, attempt > 1 ? 8 : 7);
        const total = Object.values(s).reduce((a, b) => a + b, 0);
        return {
          ok: true,
          json: {
            verdict: total >= 42 ? 'approved' : 'rejected',
            summary:
              `The implementation of “${task.name}” is complete and integrated. ` +
              'It follows the accepted plan with reasonable deviations and no regression risk was observed.',
            strengths: [
              'Implements every stated requirement with clean integration into the existing entry point',
              'Correct resource cleanup and no side effects outside task scope',
              'Consistent naming and structure with the surrounding codebase',
            ],
            issues: total >= 54 ? [] : ['No automated visual regression evidence attached; add a screenshot or test'],
            scores: s,
          },
        };
      }
      case 'test_plan': {
        await emitTools(onEvent, ['search_code', 'exec_command']);
        return {
          ok: true,
          json: {
            environment: [
              'Standard project toolchain is available for automated checks.',
              'The app can be started locally for manual validation.',
            ],
            autoCases: requirementList(task).slice(0, 3).map((r, i) => ({
              title: `Verify: ${r}`,
              priority: i === 0 ? 'HIGH PRIORITY' : 'MEDIUM PRIORITY',
              relatedChanges: ['(see Files Changed in Execution)'],
              setup: ['Install dependencies', 'Use the project test runner'],
              commands: ['echo "auto test placeholder" && true'],
              expected: [r],
              notes: 'Generated by Deem test planner.',
            })),
            manualCases: [
              {
                title: 'Manual smoke check of the running app',
                steps: ['Start the app', 'Exercise the changed behaviour', 'Watch for console errors'],
                expected: requirementList(task),
              },
            ],
          },
        };
      }
      case 'test_results': {
        await emitTools(onEvent, ['exec_command', 'exec_command']);
        return {
          ok: true,
          json: {
            results: requirementList(task).slice(0, 3).map((r) => ({
              title: `Verify: ${r}`,
              status: 'passed',
              output: 'ok',
            })),
            summary: 'All planned automated cases passed; manual case verified during execution validation.',
          },
        };
      }
      case 'summary': {
        await emitTools(onEvent, ['search_graph']);
        return {
          ok: true,
          json: {
            report:
              `“${task.name}” went through the full Deem pipeline: plan accepted, implementation completed ` +
              `in ${Math.max(1, attempt - 1)} attempt(s), review approved, tests planned and passed. The task is done.`,
            requirements: requirementList(task).map((r) => ({ requirement: r, met: true })),
            followUps: ['Merge the task branch into the default branch when ready'],
          },
        };
      }
      default:
        return { ok: false, text: `unknown phase ${phase}` };
    }
  },
};
