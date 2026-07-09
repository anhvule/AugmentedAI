// Task isolation via git worktrees. The user's checkout is NEVER mutated:
// every task gets its own working directory on its own branch, created from
// an explicit base — safe to point at a production repository.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

export function isGitRepo(cwd) {
  // .git is a directory in a normal checkout and a file in a worktree.
  return Boolean(cwd && fs.existsSync(path.join(cwd, '.git')));
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export function workspaceDir(taskId) {
  return path.join(os.homedir(), '.deem', 'worktrees', taskId);
}

// Returns { dir, isolated, branch?, error? }. Non-git projects fall back to
// the project path itself (nothing to isolate).
export function ensureWorkspace(project, task) {
  const repo = project.repoPath;
  if (!isGitRepo(repo)) return { dir: repo, isolated: false };

  const dir = workspaceDir(task.id);
  if (fs.existsSync(path.join(dir, '.git'))) {
    return { dir, isolated: true, branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').out };
  }

  const branch = `task/${slug(task.name)}`;
  const base = project.branch || 'main';
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, 'worktree', 'prune');

  const branchExists = git(repo, 'rev-parse', '--verify', branch).ok;
  let res = branchExists
    ? git(repo, 'worktree', 'add', dir, branch)
    : git(repo, 'worktree', 'add', '-b', branch, dir, base);
  if (!res.ok && branchExists) {
    // Branch checked out elsewhere (e.g. the user's own checkout): work on a
    // suffixed branch instead of touching theirs.
    res = git(repo, 'worktree', 'add', '-b', `${branch}-${task.id.slice(-4)}`, dir, base);
  }
  if (!res.ok) return { dir: repo, isolated: false, error: res.err.slice(0, 300) };

  return { dir, isolated: true, branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').out };
}

export function removeWorkspace(project, taskId) {
  const dir = workspaceDir(taskId);
  if (!isGitRepo(project?.repoPath) || !fs.existsSync(dir)) return false;
  git(project.repoPath, 'worktree', 'remove', '--force', dir);
  git(project.repoPath, 'worktree', 'prune');
  return !fs.existsSync(dir);
}
