import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDigest, gateAPayload } from '../../tools/agent-pipeline/lib/approval.mjs';
import { validateReview } from '../../tools/agent-pipeline/lib/review.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { parseContract } from '../../tools/agent-pipeline/lib/contract.mjs';
import { HEAD, NEXT_HEAD, BASE, contractBody, observation, taskRecord, loadedPolicy } from './helpers.mjs';

function ready(recordPatch = {}, obsPatch = {}) {
  const { policy } = loadedPolicy();
  const contractHash = parseContract(contractBody()).hash;
  const canonical = gateAPayload({
    repositoryId: policy.repository_id, taskId: 'SC-DEMO-001', prNumber: 50, headSha: HEAD, baseSha: BASE,
    contractHash, policySha: 'policy', reviewRunId: 9, reviewRunAttempt: 1, reviewDigest: 'r',
    ciRunId: 8, ciRunAttempt: 1, ciDigest: 'c', files: ['app/demo/page.tsx'],
  });
  const record = taskRecord({
    state: 'READY_FOR_OWNER',
    contract_hash: contractHash,
    policy_sha: 'policy',
    review_run_id: 9,
    ci_run_id: 8,
    approval_request_id: 'request-a',
    ...recordPatch,
  });
  record.policy_sha = 'policy';
  record.binding.approval = {
    gate: 'A', phase: 'armed', request_id: 'request-a', digest: approvalDigest(canonical), canonical,
    workflow_id: policy.workflow_ids.accept, workflow_path: policy.workflows.accept, ref: 'refs/heads/main', run_id: 11,
  };
  const obs = observation();
  obs.policySha = 'policy';
  obs.github.pull = { number: 50, headSha: HEAD, baseSha: BASE, headRef: record.binding.branch, baseRef: 'integration', headRepositoryId: policy.repository_id, body: 'skillcheck-task:SC-DEMO-001' };
  return { record, obs: Object.assign(obs, obsPatch), policy };
}

test('a newer head, base, or policy rejects the previous PASS and approval', () => {
  const { policy } = loadedPolicy();
  const stale = validateReview({
    workflow_id: policy.workflow_ids.review, workflow_path: policy.workflows.review, run_id: 1, run_attempt: 1, policy_sha: 'old',
    payload: { schema_version: 1, request_id: 'r', repository_id: policy.repository_id, pr_number: 50, head_sha: HEAD, base_sha: BASE, contract_hash: 'hash', verdict: 'PASS', acceptance_checks: [], findings: [], limitations: [] },
  }, {
    workflowId: policy.workflow_ids.review, workflowPath: policy.workflows.review, runId: 1, runAttempt: 1, policySha: 'new', requestId: 'r', repositoryId: policy.repository_id, prNumber: 50, headSha: NEXT_HEAD, baseSha: BASE, contractHash: 'hash', requiredChecks: [],
  });
  assert.equal(stale.pass, false);

  const moved = ready();
  moved.obs.github.pull.headSha = NEXT_HEAD;
  const decision = plan(moved.record, moved.obs);
  assert.equal(decision.record.technical_state, 'APPROVAL_STALE');
  assert.equal(decision.record.approval_request_id, null);
  assert.equal(decision.effects.some(effect => effect.type === 'github.merge'), false);

  const policyChanged = ready();
  policyChanged.obs.policySha = 'other-policy';
  const shifted = plan(policyChanged.record, policyChanged.obs);
  assert.equal(shifted.record.technical_state, 'APPROVAL_STALE');
  assert.equal(shifted.record.binding.approval, null);
});
