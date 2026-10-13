import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { observation, taskRecord } from './helpers.mjs';

function verifiedTask() {
  const record = taskRecord({ state: 'READY_FOR_OWNER', review_run_id: 31, ci_run_id: 41 });
  record.binding.evidence = { ci: { ok: true, pass: true }, review: { ok: true, pass: true } };
  const obs = observation();
  obs.simulation = false;
  obs.flags = { enabled: true, mergeEnabled: true };
  obs.policy = { ...obs.policy, integration_merge_policy: 'verified_ci_review' };
  obs.preflight = { ok: true };
  obs.lockHolder = 'only-merge-writer';
  obs.mergeLock = { holder: 'only-merge-writer' };
  obs.github.branch = {
    name: record.binding.branch, sha: record.head_sha,
    repositoryId: obs.policy.repository_id, files: ['app/demo/page.tsx'],
  };
  obs.github.pull = {
    number: record.pr_number, headSha: record.head_sha, baseSha: record.base_sha,
    headRef: record.binding.branch, baseRef: 'integration',
    headRepositoryId: record.repository_id, baseRepositoryId: record.repository_id,
    merged: false,
  };
  obs.github.protection = {
    exclusiveWritersConfirmed: true, scOps001Exception: false, mainProtected: true,
    integrationProtected: true, agentStateProtected: true, qualityGatesBypass: false,
    administrationWriteUsed: false, environmentsConfirmed: true, requiredChecksPinnedToApp: true,
  };
  obs.github.ci = { run_id: 41, run_attempt: 1, payload: { verified: true } };
  obs.github.review = { run_id: 31, run_attempt: 1, payload: { verdict: 'PASS', findings: [] } };
  return { record, obs };
}

test('current CI + independent review schedules integration merge without owner approval', () => {
  const { record, obs } = verifiedTask();
  const result = plan(record, obs);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].type, 'github.merge');
  assert.equal(result.effects[0].gate, 'A');
  assert.equal(result.record.binding.approval, null);
  assert.equal(result.record.binding.auto_integration.source, 'verified_ci_review');
  assert.equal(result.record.binding.auto_integration.head_sha, record.head_sha);
  assert.equal(result.record.binding.merge.phase, 'awaiting_confirmation');
});

test('disabled LIVE flags, unconfirmed protection, or missing evidence cannot merge', () => {
  const cases = [
    o => { o.flags.mergeEnabled = false; },
    o => { o.flags.enabled = false; },
    o => { o.preflight.ok = false; },
    o => { o.github.protection.integrationProtected = false; },
    o => { o.github.protection.environmentsConfirmed = false; },
    o => { o.github.review = null; },
    o => { o.github.ci = null; },
    o => { o.github.pull.baseSha = 'f'.repeat(40); },
  ];
  for (const change of cases) {
    const { record, obs } = verifiedTask();
    change(obs);
    const result = plan(record, obs);
    assert.equal(result.effects.some(e => e.type === 'github.merge'), false);
  }
});

test('a production approval record never enters automatic integration', () => {
  const { record, obs } = verifiedTask();
  record.binding.approval = { gate: 'B' };
  const result = plan(record, obs);
  assert.equal(result.effects.some(e => e.type === 'github.merge'), false);
  assert.equal(result.record.blocked_reason, 'GATE_MISMATCH');
});

test('legacy offline fixtures still use explicit owner gate A for backward compatibility', () => {
  const { record, obs } = verifiedTask();
  obs.simulation = true;
  const result = plan(record, obs);
  assert.equal(result.effects.some(e => e.type === 'github.merge'), false);
  assert.equal(result.record.binding.approval?.gate, 'A');
});
