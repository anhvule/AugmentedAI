import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAgent } from '../agents/mock.js';

const task = {
  id: 'task_fixed',
  name: 'Sample task',
  description: 'Do the thing',
  requirements: ['req one', 'req two'],
};
const project = { repoPath: '/nonexistent', branch: 'main' };
const job = (phase, attempt = 1) => ({ phase, task, project, attempt, onEvent: () => {} });

test('plan artifact has steps with deliverables and validation', async () => {
  const res = await mockAgent.run(job('plan'));
  assert.equal(res.ok, true);
  assert.ok(res.json.steps.length >= 3);
  for (const s of res.json.steps) {
    assert.ok(s.deliverables.length > 0);
    assert.ok(s.validation.length > 0);
  }
});

test('evaluation is deterministic for the same task and attempt', async () => {
  const a = await mockAgent.run(job('execution'));
  const b = await mockAgent.run(job('execution'));
  assert.deepEqual(a.json.evaluation.criteria, b.json.evaluation.criteria);
});

test('evaluation always meets the acceptance threshold', async () => {
  const res = await mockAgent.run(job('execution'));
  const total = Object.values(res.json.evaluation.criteria).reduce((x, y) => x + y, 0);
  assert.ok(total >= 42, `total ${total} should be >= 42`);
});
