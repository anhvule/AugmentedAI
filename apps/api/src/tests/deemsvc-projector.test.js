import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../store.js';
import { ensurePhases, phaseRecord } from '../workflow.js';
import { projectEvent } from '../deemsvc-projector.js';

test('a READY transition marks the execution phase running', () => {
  const state = db.get();
  state.tasks.push({ id: 't1', projectId: 'p1' });
  ensurePhases('t1');

  projectEvent('t1', { step: 'impl', from: 'blocked', to: 'ready' });
  projectEvent('t1', { step: 'impl', from: 'ready', to: 'dispatched' });
  projectEvent('t1', { step: 'impl', from: 'dispatched', to: 'executing' });

  const rec = phaseRecord('t1', 'execution');
  assert.equal(rec.status, 'running');
  assert.ok(rec.startedAt);
});

test('a PASSED transition marks the execution phase passed with finishedAt set', () => {
  const state = db.get();
  state.tasks.push({ id: 't2', projectId: 'p1' });
  ensurePhases('t2');

  projectEvent('t2', { step: 'impl', from: 'dispatched', to: 'executing' });
  projectEvent('t2', { step: 'impl', from: 'verifying', to: 'passed' });

  const rec = phaseRecord('t2', 'execution');
  assert.equal(rec.status, 'passed');
  assert.ok(rec.finishedAt);
});

test('an ESCALATED transition marks the execution phase failed with the reason in error', () => {
  const state = db.get();
  state.tasks.push({ id: 't3', projectId: 'p1' });
  ensurePhases('t3');

  projectEvent('t3', { step: 'impl', from: 'verifying', to: 'escalated' });

  const rec = phaseRecord('t3', 'execution');
  assert.equal(rec.status, 'failed');
  assert.ok(rec.error);
});
