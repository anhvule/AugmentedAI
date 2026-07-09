// Ground-truth verification: the agent's claims are hypotheses; only what the
// harness can observe in git and command exit codes counts as fact.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

export function isGitRepo(cwd) {
  return Boolean(cwd && fs.existsSync(path.join(cwd, '.git')));
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Did the execution actually change anything? Computed from git, never from
// the agent's self-report.
export function verifyExecution(task, project, artifact) {
  const cwd = project.repoPath;
  if (!isGitRepo(cwd)) {
    return { checked: false, verified: false, note: 'project path is not a git repository — harness verification skipped' };
  }
  const branch = artifact.branch || `task/${slug(task.name)}`;
  const base = project.branch || 'main';

  if (!git(cwd, 'rev-parse', '--verify', branch).ok) {
    return { checked: true, verified: false, branch, base, files: [], commits: 0, note: `branch ${branch} does not exist — no work was committed` };
  }

  let files = git(cwd, 'diff', '--name-only', `${base}..${branch}`);
  if (!files.ok) files = git(cwd, 'diff', '--name-only', base, branch);
  let fileList = files.ok ? files.out.split('\n').filter(Boolean) : [];
  if (!fileList.length) {
    // base may equal branch (work committed directly); fall back to the last commit.
    const shown = git(cwd, 'show', '--name-only', '--format=', branch);
    fileList = shown.ok ? shown.out.split('\n').filter(Boolean) : [];
  }
  const commits = Number(git(cwd, 'rev-list', '--count', `${base}..${branch}`).out) ||
    (fileList.length ? 1 : 0);

  const verified = fileList.length > 0;
  return {
    checked: true,
    verified,
    branch,
    base,
    files: fileList,
    commits,
    note: verified
      ? `${fileList.length} file(s) changed across ${commits} commit(s) on ${branch}`
      : `branch ${branch} exists but contains no file changes vs ${base}`,
  };
}

// The real diff, for grounding the reviewer. Truncated to keep prompts sane.
export function diffText(project, branch, maxChars = 7000) {
  const cwd = project.repoPath;
  if (!isGitRepo(cwd) || !branch) return '';
  const base = project.branch || 'main';
  let out = git(cwd, 'diff', `${base}..${branch}`).out;
  if (!out) out = git(cwd, 'show', '--format=', branch).out;
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n… (diff truncated at ${maxChars} chars)`;
  return out;
}

function execCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, env: process.env });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += `\n[harness] timed out after ${timeoutMs / 1000}s`;
    }, timeoutMs);
    const collect = (c) => (out = (out + c.toString()).slice(-4000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// Execute the test plan's auto cases ourselves. The agent may write tests,
// but pass/fail comes from real exit codes.
export async function runTestCommands(testPlan, cwd, branch, { timeoutMs = 120000 } = {}) {
  if (!testPlan) return null;
  if (!cwd || !fs.existsSync(cwd)) {
    return {
      results: (testPlan.autoCases || []).map((c) => ({ title: c.title, status: 'failed', output: 'project path missing', source: 'harness' })),
      summary: 'Project path missing — automated cases could not run.',
    };
  }
  if (branch && isGitRepo(cwd)) git(cwd, 'checkout', branch);

  const results = [];
  for (const c of testPlan.autoCases || []) {
    const command = (c.commands || []).join(' && ') || 'true';
    const { code, out } = await execCommand(command, cwd, timeoutMs);
    results.push({
      title: c.title,
      status: code === 0 ? 'passed' : 'failed',
      output: (out || '(no output)').trim().slice(0, 2000),
      command,
      source: 'harness',
    });
  }
  for (const c of testPlan.manualCases || []) {
    results.push({ title: c.title, status: 'manual', output: 'not run — requires a human', source: 'manual' });
  }
  const auto = results.filter((r) => r.source === 'harness');
  const passed = auto.filter((r) => r.status === 'passed').length;
  return {
    results,
    summary: `${passed}/${auto.length} automated case(s) passed — executed by the Deem harness (exit codes, not agent claims).`,
    failed: auto.length - passed,
  };
}
