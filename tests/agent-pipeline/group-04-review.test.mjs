import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proseIsNotReview, validateReview } from '../../tools/agent-pipeline/lib/review.mjs';
import { validateCi } from '../../tools/agent-pipeline/lib/ci.mjs';
import { loadedPolicy } from './helpers.mjs';

function envelope(payload, workflowId) {
  const { policy } = loadedPolicy();
  return {
    workflow_id: workflowId ?? policy.workflow_ids.review,
    workflow_path: policy.workflows.review,
    run_id: 4,
    run_attempt: 1,
    policy_sha: 'policy',
    payload,
  };
}

function expected(patch = {}) {
  const { policy } = loadedPolicy();
  return {
    workflowId: policy.workflow_ids.review,
    workflowPath: policy.workflows.review,
    runId: 4,
    runAttempt: 1,
    policySha: 'policy',
    requestId: 'request',
    repositoryId: policy.repository_id,
    prNumber: 50,
    headSha: 'a'.repeat(40),
    baseSha: 'c'.repeat(40),
    contractHash: 'hash',
    requiredChecks: ['npm run typecheck'],
    ...patch,
  };
}

function payload(patch = {}) {
  const { policy } = loadedPolicy();
  return {
    schema_version: 1,
    request_id: 'request',
    repository_id: policy.repository_id,
    pr_number: 50,
    head_sha: 'a'.repeat(40),
    base_sha: 'c'.repeat(40),
    contract_hash: 'hash',
    verdict: 'PASS',
    acceptance_checks: [{ id: 'npm run typecheck', status: 'PASS', required: true }],
    findings: [],
    limitations: [],
    ...patch,
  };
}

test('damaged, forged, incomplete, skipped, and foreign workflow results are not PASS', () => {
  const { policy } = loadedPolicy();
  assert.equal(validateReview(null, expected()).pass, false);
  assert.equal(validateReview(envelope({}), expected()).ok, false);
  assert.equal(validateReview(envelope(payload({ verdict: 'LGTM' })), expected()).reason, 'verdict_enum');
  assert.equal(validateReview(envelope(payload({ request_id: 'other' })), expected()).reason, 'request_mismatch');
  assert.equal(validateReview(envelope(payload(), 'other-workflow'), expected()).reason, 'workflow_mismatch');
  assert.equal(validateReview(envelope(payload({ acceptance_checks: [{ id: 'npm run typecheck', status: 'SKIPPED', required: true }] })), expected()).reason, 'required_check_blocks_pass');
  assert.equal(validateReview(envelope(payload({ acceptance_checks: [{ id: 'npm run typecheck', status: 'NOT_RUN', required: true }] })), expected()).pass, false);
  assert.equal(proseIsNotReview('no major issues').pass, false);
  const ci = validateCi({
    workflow_id: 'untrusted', workflow_path: policy.workflows.verify, run_attempt: 1, policy_sha: 'policy',
    head_sha: 'a'.repeat(40), base_sha: 'c'.repeat(40), conclusion: 'success', jobs: [{ conclusion: 'success' }],
    commands_executed: policy.required_ci_commands, name: 'sc-agent/ci',
  }, { workflowId: policy.workflow_ids.verify, workflowPath: policy.workflows.verify, policySha: 'policy', headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40), requiredCommands: policy.required_ci_commands });
  assert.equal(ci.pass, false);
  for (const conclusion of ['cancelled', 'skipped', 'neutral', 'timed_out']) {
    const result = validateCi({ ...ci, workflow_id: policy.workflow_ids.verify, conclusion, jobs: [] }, { workflowId: policy.workflow_ids.verify, workflowPath: policy.workflows.verify, policySha: 'policy', headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40), requiredCommands: [] });
    assert.equal(result.pass, false, conclusion);
  }
});
