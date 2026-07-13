import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureWorkspace, removeWorkspace } from '../workspace.js';

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deem-ws-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@deem.local');
  git('config', 'user.name', 'Deem Test');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("prod");');
  git('add', '-A');
  git('commit', '-m', 'first');
  return { dir, git };
}

const project = (dir) => ({ repoPath: dir, branch: 'main' });
const task = { id: 'task_wstest1', name: 'Harden the login flow' };

test('workspace is an isolated worktree; the user checkout is never touched', () => {
  const { dir, git } = tempRepo();
  const before = git('rev-parse', 'HEAD');
  const userBranchBefore = git('rev-parse', '--abbrev-ref', 'HEAD');

  const ws = ensureWorkspace(project(dir), task);
  assert.equal(ws.isolated, true);
  assert.notEqual(ws.dir, dir);
  assert.equal(ws.branch, 'task/harden-the-login-flow');

  // Work happens in the worktree...
  fs.writeFileSync(path.join(ws.dir, 'fix.js'), 'export const ok = true;');
  execFileSync('git', ['add', '-A'], { cwd: ws.dir });
  execFileSync('git', ['commit', '-m', 'work'], { cwd: ws.dir });

  // ...and the user's checkout is byte-for-byte untouched.
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), userBranchBefore);
  assert.equal(fs.existsSync(path.join(dir, 'fix.js')), false);
  // But the branch (with the work) is visible from the main repo for review/merge.
  assert.equal(git('rev-list', '--count', 'main..task/harden-the-login-flow'), '1');

  removeWorkspace(project(dir), task.id);
  assert.equal(fs.existsSync(ws.dir), false);
});

test('workspace branches from the explicit base, not from wherever HEAD is', () => {
  const { dir, git } = tempRepo();
  // Simulate a drifted checkout: user is on some other branch with extra work.
  git('checkout', '-b', 'wip-something');
  fs.writeFileSync(path.join(dir, 'wip.js'), 'wip');
  git('add', '-A');
  git('commit', '-m', 'wip');

  const ws = ensureWorkspace(project(dir), { id: 'task_wstest2', name: 'Another task' });
  assert.equal(ws.isolated, true);
  // The worktree must NOT contain the wip file — it branched from main.
  assert.equal(fs.existsSync(path.join(ws.dir, 'wip.js')), false);
  removeWorkspace(project(dir), 'task_wstest2');
});

test('non-git project falls back to the project path, unisolated', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'deem-plain-'));
  const ws = ensureWorkspace({ repoPath: plain, branch: 'main' }, task);
  assert.equal(ws.isolated, false);
  assert.equal(ws.dir, plain);
});
