import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileFromEnv } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { httpWorld } from './http-world.mjs';

// Exercise the real controller, real GitHub/CI/Codex adapter code and a mocked
// HTTP boundary. These tests cannot authorize LIVE operation or GitHub ruleset changes.
test('integration merges automatically after CI/review without owner, production still waits', async () => {
  const w = httpWorld(), old = globalThis.fetch;
  w.env.AGENT_PIPELINE_MERGE_ENABLED = 'true';
  globalThis.fetch = w.fetch;
  const step = () => reconcileFromEnv(w.env, { policy: w.policy });
  const task = () => Object.values(w.projection()).find(record => record.task_id === 'SC-DEMO-001');
  const promotion = () => Object.values(w.projection()).find(record => record.binding.lane === 'promotion');
  try {
    for (let i = 0; i < 100 && task()?.state !== 'ACCEPTED'; i++) await step();
    assert.equal(task()?.state, 'ACCEPTED', JSON.stringify(task()));
    assert.equal(task().binding.approval, null, 'no owner acceptance is used');
    assert.ok(w.comments.some(comment => comment.body.includes('kind: READY_FOR_OWNER') && comment.body.includes('SC-DEMO-001')));
    assert.equal(w.comments.some(comment => /actions\/runs\/\d+/.test(comment.body)), false);
    assert.equal(w.mergeCount, 1);
    assert.equal(w.runs.some(run => run.workflow_id === w.policy.workflow_ids.accept), false);
    assert.ok(w.checks.some(check => check.name === 'sc-agent/integration-ready' && check.conclusion === 'success'));
    assert.ok(w.checks.some(check => check.name === 'sc-agent/review' && check.conclusion === 'success'));
    assert.ok(w.checks.some(check => check.name === 'sc-agent/ci' && check.conclusion === 'success'));
    for (let i = 0; i < 100 && !promotion()?.binding.approval?.run_id; i++) await step();
    assert.equal(promotion()?.binding.approval?.gate, 'B', 'production still requires owner approval');
    assert.equal(w.mergeCount, 1, 'production remains unmerged');
    await step();
    assert.equal(w.mergeCount, 1, 'nothing can promote based on integration-only evidence');
  } finally {
    globalThis.fetch = old;
  }
});

test('without protected branch gates LIVE integration never auto-merges', async () => {
  const w = httpWorld(), old = globalThis.fetch;
  w.env.AGENT_PIPELINE_MERGE_ENABLED = 'true';
  w.protection.rules.find(rule => rule.name === 'quality-gates').rules = [];
  globalThis.fetch = w.fetch;
  const step = () => reconcileFromEnv(w.env, { policy: w.policy });
  try {
    for (let i = 0; i < 65; i++) await step();
    assert.equal(w.mergeCount, 0);
    assert.equal(w.runs.some(run => run.workflow_id === w.policy.workflow_ids.accept), false);
  } finally {
    globalThis.fetch = old;
  }
});
