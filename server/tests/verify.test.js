import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyExecution, runTestCommands } from '../verify.js';

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deem-verify-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@deem.local');
  git('config', 'user.name', 'Deem Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello');
  git('add', '-A');
  git('commit', '-m', 'first');
  return { dir, git };
}

const task = { id: 'task_v', name: 'Sample task' };

test('verification fails when the claimed branch has no commits', () => {
  const { dir } = tempRepo();
  const v = verifyExecution(task, { repoPath: dir, branch: 'main' }, { branch: 'task/ghost' });
  assert.equal(v.checked, true);
  assert.equal(v.verified, false);
});

test('verification passes with real committed changes and reports true file list', () => {
  const { dir, git } = tempRepo();
  git('checkout', '-b', 'task/sample-task');
  fs.writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;');
  git('add', '-A');
  git('commit', '-m', 'work');
  const v = verifyExecution(task, { repoPath: dir, branch: 'main' }, { branch: 'task/sample-task', filesChanged: ['made-up.js'] });
  assert.equal(v.verified, true);
  assert.deepEqual(v.files, ['feature.js']); // git truth, not the agent's claim
});

test('verification is skipped outside a git repository', () => {
  const v = verifyExecution(task, { repoPath: '/nonexistent-dir' }, {});
  assert.equal(v.checked, false);
});

test('harness runs test commands and judges by exit code', async () => {
  const { dir } = tempRepo();
  const plan = {
    autoCases: [
      { title: 'passes', commands: ['true'] },
      { title: 'fails', commands: ['exit 1'] },
    ],
    manualCases: [{ title: 'human check' }],
  };
  const r = await runTestCommands(plan, dir, null, { timeoutMs: 10000 });
  assert.equal(r.results.find((x) => x.title === 'passes').status, 'passed');
  assert.equal(r.results.find((x) => x.title === 'fails').status, 'failed');
  assert.equal(r.results.find((x) => x.title === 'human check').status, 'manual');
  assert.equal(r.failed, 1);
});
