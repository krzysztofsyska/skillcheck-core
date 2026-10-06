import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTransportRetry } from '../../tools/agent-pipeline/lib/transport.mjs';
import { evaluatePreflight } from '../../tools/agent-pipeline/lib/merge.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { validateReview } from '../../tools/agent-pipeline/lib/review.mjs';
import { parseContract } from '../../tools/agent-pipeline/lib/contract.mjs';
import { HEAD, BASE, contractBody, observation, taskRecord, loadedPolicy } from './helpers.mjs';

test('repair budget, auth failures, disabled flags, missing secrets, and missing protection stay closed', async () => {
  const { policy, policySha } = loadedPolicy();
  const contractHash = parseContract(contractBody()).hash;
  const record = taskRecord({
    state: 'PR_REVIEW', review_request_id: 'request', repair_round: 3, policy_sha: policySha, contract_hash: contractHash,
  });
  record.ci_run_id = 1; record.review_run_id = 2; record.binding.review_dispatched = true;
  record.binding.substantive_reviews = 1;
  record.binding.required_tests = ['npm run typecheck'];
  const obs = observation();
  obs.policySha = policySha;
  obs.github.ci = { workflow_id: policy.workflow_ids.verify, workflow_path: policy.workflows.verify, run_id: 1, run_attempt: 1, policy_sha: policySha, head_sha: HEAD, base_sha: BASE, conclusion: 'failure', jobs: [{ conclusion: 'failure' }], commands_executed: policy.required_ci_commands };
  obs.github.review = { workflow_id: policy.workflow_ids.review, workflow_path: policy.workflows.review, run_id: 2, run_attempt: 1, policy_sha: policySha, payload: { schema_version: 1, request_id: 'request', repository_id: policy.repository_id, pr_number: 50, head_sha: HEAD, base_sha: BASE, contract_hash: contractHash, verdict: 'PASS_WITH_FIXES', acceptance_checks: [{ id: 'npm run typecheck', status: 'PASS', required: true }], findings: [{ id: 'f1', severity: 'minor', path: 'app/demo/page.tsx', line: 1, description: 'fix', required_fix: 'fix' }], limitations: [] } };
  obs.github.pull = { headSha: HEAD, baseSha: BASE };
  const limited = plan(record, obs);
  assert.equal(limited.record.blocked_reason, 'REPAIR_LIMIT');

  const sleeps = [];
  await assert.rejects(withTransportRetry(async () => { const error = new Error('denied'); error.status = 401; throw error; }, { sleep: async ms => sleeps.push(ms), rng: () => 0 }));
  assert.deepEqual(sleeps, []);
  let attempts = 0;
  await assert.rejects(withTransportRetry(async () => {
    attempts += 1;
    const error = new Error('busy');
    error.status = attempts === 1 ? 429 : 503;
    if (attempts === 1) error.retryAfter = '1';
    throw error;
  }, { sleep: async ms => sleeps.push(ms), rng: () => 0, maxAttempts: 3 }));
  assert.equal(attempts, 3);
  assert.equal(sleeps[0] >= 60_000, true);

  const disabled = observation();
  disabled.simulation = false;
  disabled.flags = { enabled: false, mergeEnabled: false };
  let current = plan(null, disabled).record;
  current = plan(current, disabled).record;
  const held = plan(current, disabled);
  assert.equal(held.effects.length, 0);
  assert.equal(held.record.binding.suppressed[0].reason, 'PIPELINE_DISABLED');
  assert.equal(disabled.policy.flags.AGENT_PIPELINE_ENABLED, false);

  const unconfigured = observation();
  unconfigured.simulation = false;
  unconfigured.flags = { enabled: true, mergeEnabled: false };
  unconfigured.secrets = { cursor: false };
  let pending = plan(null, unconfigured).record;
  pending = plan(pending, unconfigured).record;
  assert.equal(plan(pending, unconfigured).record.blocked_reason, 'BLOCKED_CONFIGURATION');
  const preflight = evaluatePreflight(observation().github.protection);
  assert.equal(preflight.ok, false);
  assert.match(preflight.reason, /UNCONFIRMED|UNPINNED/);
  assert.equal(validateReview({ workflow_id: policy.workflow_ids.review, workflow_path: policy.workflows.review, run_id: 1, run_attempt: 1, policy_sha: policySha, payload: {} }, { workflowId: policy.workflow_ids.review, workflowPath: policy.workflows.review, runId: 1, runAttempt: 1, policySha, requestId: 'x', repositoryId: policy.repository_id, prNumber: 1, headSha: HEAD, baseSha: BASE, contractHash: 'hash', requiredChecks: [] }).pass, false);
});
