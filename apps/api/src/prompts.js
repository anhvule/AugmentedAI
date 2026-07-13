// Structured prompts per pipeline phase. Every prompt demands a strict JSON
// artifact so quality is systematic, not dependent on prose parsing.
import { contextSections } from './rag.js';

function taskContext(task, project) {
  return [
    `Project: ${project.name} (local repo at ${project.repoPath}, default branch ${project.branch || 'main'})`,
    `Task: ${task.name}`,
    `Description: ${task.description || '(none)'}`,
    `Requirements checklist:`,
    ...(task.requirements?.length ? task.requirements.map((r) => `- ${r}`) : ['- (derive from description)']),
    task.notes ? `Notes: ${task.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const JSON_ONLY =
  'Respond with ONLY a JSON object matching the schema — no markdown fences, no prose outside JSON. ' +
  'If information is missing or uncertain, write "unknown" — NEVER invent files, results, scores or facts. ' +
  'Your claims are cross-checked against git and real command output; fabricated claims cause automatic rejection.';

export function buildPrompt(phase, { task, project, artifacts = {}, feedback = '', diff = '' }) {
  const ctx = taskContext(task, project) + contextSections(project, task);
  switch (phase) {
    case 'plan':
      return `You are the planning phase of an engineering pipeline.\n${ctx}\n
Inspect the repository as needed, then produce an implementation plan of 3-6 concrete steps.\n${JSON_ONLY}
Schema: {"approach": string, "steps": [{"title": string, "description": string, "runner": "LOCAL RUNNER", "deliverables": [string], "validation": [string]}]}`;
    case 'execution':
      return `You are the implementation phase of an engineering pipeline. Implement the task in this repository on a git branch named task/<slug>. Commit your work.\n${ctx}\n
Accepted plan:\n${JSON.stringify(artifacts.plan?.steps || [], null, 2)}\n${feedback ? `Feedback from the previous rejected attempt — you MUST address it:\n${feedback}\n` : ''}
After implementing, ${JSON_ONLY}
Schema: {"summary": string, "stepsCompleted": [string], "deviations": [string], "filesChanged": [string], "branch": string, "evaluation": {"criteria": {"Requirements Met": 0-10, "Code Correctness": 0-10, "Plan Adherence": 0-10, "No Regression Risk": 0-10, "Code Quality": 0-10, "Completeness": 0-10}, "notes": string}}
Score the evaluation honestly against the plan validations.`;
    case 'review':
      return `You are the independent code-review phase of an engineering pipeline. Judge ONLY what the diff below and the repository content support — not the implementer's claims. Do not modify files.\n${ctx}\n
Plan: ${JSON.stringify(artifacts.plan?.steps?.map((s) => s.title) || [])}\nFiles changed (verified by the harness from git): ${JSON.stringify(artifacts.execution?.filesChanged || [])}\n
Actual git diff (ground truth — these are the ONLY changes that exist):\n${diff || '(no diff available — treat unverifiable claims as unmet)'}\n
For every strength, issue and score, cite concrete evidence: a file path plus what you observed there. If the diff does not support a claim, do not make it.\n${JSON_ONLY}
Schema: {"verdict": "approved"|"rejected", "summary": string, "strengths": [string], "issues": [string], "evidence": [string], "scores": {"Correctness": 0-10, "Plan Adherence": 0-10, "Code Quality": 0-10, "Risk and Regressions": 0-10, "Completeness": 0-10, "Improvement Opportunities": 0-10}}
Each evidence item: "<file>: <what you verified there>".`;
    case 'test_plan':
      return `You are the test-planning phase. Design automated and manual test cases for the implemented change. Do not modify files.\n${ctx}\nExecution summary: ${artifacts.execution?.summary || ''}\nFiles changed: ${JSON.stringify(artifacts.execution?.filesChanged || [])}\n
${JSON_ONLY}
Schema: {"environment": [string], "autoCases": [{"title": string, "priority": "HIGH PRIORITY"|"MEDIUM PRIORITY"|"LOW PRIORITY", "relatedChanges": [string], "setup": [string], "commands": [string], "expected": [string], "notes": string}], "manualCases": [{"title": string, "steps": [string], "expected": [string]}]}
Commands must be runnable from the repo root and exit 0 on success.`;
    case 'test_results':
      return `You are the test-execution phase. Implement any missing automated tests from the test plan and commit them to the task branch. NOTE: the harness will re-run every auto case command itself afterwards and its exit codes override your report — so make the commands actually pass.\n${ctx}\nTest plan: ${JSON.stringify(artifacts.test_plan || {}, null, 2)}\n
${JSON_ONLY}
Schema: {"results": [{"title": string, "status": "passed"|"failed", "output": string}], "summary": string}`;
    case 'summary':
      return `You are the reporting phase. Write the final report for this task. Do not modify files.\n${ctx}\n
Execution: ${artifacts.execution?.summary || ''}\nReview verdict: ${artifacts.review?.verdict || ''}\nTest summary: ${artifacts.test_results?.summary || ''}\n
${JSON_ONLY}
Schema: {"report": string, "requirements": [{"requirement": string, "met": boolean}], "followUps": [string]}`;
    default:
      throw new Error(`unknown phase ${phase}`);
  }
}
