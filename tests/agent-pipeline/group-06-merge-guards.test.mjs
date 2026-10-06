import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDigest, gateAPayload } from '../../tools/agent-pipeline/lib/approval.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { parseContract } from '../../tools/agent-pipeline/lib/contract.mjs';
import { BASE, HEAD, NEXT_HEAD, contractBody, loadedPolicy, observation, taskRecord } from './helpers.mjs';

function armedRecord() {
  const { policy, policySha } = loadedPolicy();
  const contractHash = parseContract(contractBody()).hash;
  const canonical = gateAPayload({
    repositoryId: policy.repository_id, taskId: 'SC-DEMO-001', prNumber: 50, headSha: HEAD, baseSha: BASE, contractHash, policySha,
    reviewRunId: 3, reviewRunAttempt: 1, reviewDigest: 'r', ciRunId: 4, ciRunAttempt: 1, ciDigest: 'c', files: [],
  });
  const record = taskRecord({ state: 'READY_FOR_OWNER', contract_hash: contractHash, policy_sha: policySha, approval_request_id: 'req-a', review_run_id: 3, ci_run_id: 4 });
  record.binding.approval = {
    gate: 'A', phase: 'armed', request_id: 'req-a', digest: approvalDigest(canonical), canonical,
    workflow_id: policy.workflow_ids.accept, workflow_path: policy.workflows.accept, ref: 'refs/heads/main', run_id: 30, armed_at: '2026-10-06T12:00:00.000Z',
  };
  return { record, policy, policySha };
}

function obsFor(record, approval) {
  const obs = observation();
  obs.policySha = record.policy_sha;
  obs.flags = { enabled: true, mergeEnabled: true };
  obs.github.pull = { number: 50, headSha: record.head_sha, baseSha: record.base_sha, headRef: record.binding.branch, baseRef: 'integration', headRepositoryId: obs.policy.repository_id, merged: false };
  obs.github.protection = { exclusiveWritersConfirmed: true, scOps001Exception: false, mainProtected: true, integrationProtected: true, agentStateProtected: true, qualityGatesBypass: false, administrationWriteUsed: false, requiredChecksPinnedToApp: true };
  obs.approval = approval;
  return obs;
}

test('SHA drift, rerun, rejection, and timeout do not merge', () => {
  const { record } = armedRecord();
  const drifted = obsFor(record, null);
  drifted.github.pull.headSha = NEXT_HEAD;
  assert.equal(plan(record, drifted).effects.some(effect => effect.type === 'github.merge'), false);

  const rerun = obsFor(record, { run_id: 30, run_attempt: 2, workflow_id: record.binding.approval.workflow_id, workflow_path: record.binding.approval.workflow_path, ref: 'refs/heads/main', environment: { name: 'owner-acceptance', id: null }, payload: [] });
  const rerunPlan = plan(structuredClone(record), rerun);
  assert.equal(rerunPlan.record.blocked_reason, 'APPROVAL_RERUN');
  assert.equal(rerunPlan.effects.some(effect => effect.type === 'github.merge'), false);

  const denied = obsFor(record, { run_id: 30, run_attempt: 1, workflow_id: record.binding.approval.workflow_id, workflow_path: record.binding.approval.workflow_path, ref: 'refs/heads/main', environment: { name: 'owner-acceptance', id: null }, payload: [{ state: 'rejected', user: { id: 222297538, type: 'User' }, environments: [{ name: 'owner-acceptance', id: null }] }] });
  const denial = plan(structuredClone(record), denied);
  assert.equal(denial.record.state, 'BLOCKED');
  assert.equal(denial.effects.some(effect => effect.type === 'github.merge'), false);

  const waiting = obsFor(structuredClone(record), null);
  waiting.now = '2026-10-10T12:00:01.000Z';
  const timeout = plan(structuredClone(record), waiting);
  assert.equal(timeout.record.blocked_reason, 'APPROVAL_TIMEOUT');
  assert.equal(timeout.effects.length, 0);
});
