import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDigest, evaluateApproval, gateAPayload, gateBPayload } from '../../tools/agent-pipeline/lib/approval.mjs';
import { loadedPolicy } from './helpers.mjs';

function requestFor(canonical, gate, workflow = gate === 'B' ? 'promote' : 'accept') {
  const { policy } = loadedPolicy();
  return {
    gate,
    request_id: 'request',
    digest: approvalDigest(canonical),
    canonical,
    workflow_id: policy.workflow_ids[workflow],
    workflow_path: policy.workflows[workflow],
    ref: 'refs/heads/main',
    run_id: 20,
  };
}

test('comments, reactions, spoofed logins, and gate A do not authorize gate B', () => {
  const { policy } = loadedPolicy();
  const canonical = gateAPayload({
    repositoryId: policy.repository_id, taskId: 'SC-DEMO-001', prNumber: 50, headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40),
    contractHash: 'h', policySha: 'p', reviewRunId: 1, reviewRunAttempt: 1, reviewDigest: 'r', ciRunId: 2, ciRunAttempt: 1, ciDigest: 'c', files: [],
  });
  const request = requestFor(canonical, 'A');
  const run = { run_id: 20, run_attempt: 1, workflow_id: request.workflow_id, workflow_path: request.workflow_path, ref: request.ref, environment: { name: 'owner-acceptance', id: null } };
  const commentOnly = evaluateApproval({ request, run, payload: [], expectedUser: policy.owner, expectedEnvironment: policy.environments.owner_acceptance });
  assert.equal(commentOnly.ok, false);
  const spoof = evaluateApproval({
    request, run,
    payload: [{ state: 'approved', user: { id: 1, login: 'krzysztofsyska', type: 'User' }, environments: [{ name: 'owner-acceptance', id: null }], comment: 'APPROVED' }],
    expectedUser: policy.owner,
    expectedEnvironment: policy.environments.owner_acceptance,
  });
  assert.equal(spoof.reason, 'reviewer_mismatch');
  const bot = evaluateApproval({
    request, run,
    payload: [{ state: 'approved', user: { id: policy.owner.id, login: 'krzysztofsyska', type: 'Bot' }, environments: [{ name: 'owner-acceptance', id: null }] }],
    expectedUser: policy.owner,
    expectedEnvironment: policy.environments.owner_acceptance,
  });
  assert.equal(bot.ok, false);
  const asB = evaluateApproval({
    request: requestFor(canonical, 'B'),
    run: { ...run, workflow_id: policy.workflow_ids.promote, workflow_path: policy.workflows.promote, environment: { name: 'production-approval', id: null } },
    payload: [{ state: 'approved', user: { id: policy.owner.id, type: 'User' }, environments: [{ name: 'production-approval', id: null }] }],
    expectedUser: policy.owner,
    expectedEnvironment: policy.environments.production_approval,
  });
  assert.equal(asB.reason, 'gate_mismatch');
  const realB = gateBPayload({ repositoryId: policy.repository_id, promotionPr: 90, integrationSha: 'b'.repeat(40), mainSha: 'd'.repeat(40), policySha: 'p', tasks: [], manifestHash: 'm', operations: [], secretNames: ['CURSOR_API_KEY'] });
  assert.equal(JSON.stringify(realB).includes('sk-'), false);
  assert.equal(evaluateApproval({
    request: { ...requestFor(realB, 'B'), workflow_id: policy.workflow_ids.promote, workflow_path: policy.workflows.promote },
    run: { run_id: 20, run_attempt: 1, workflow_id: policy.workflow_ids.promote, workflow_path: policy.workflows.promote, ref: 'refs/heads/main', environment: { name: 'production-approval', id: null } },
    payload: [{ state: 'approved', user: { id: policy.owner.id, type: 'User' }, environments: [{ name: 'production-approval', id: null }], comment: 'yes in chat' }],
    expectedUser: policy.owner,
    expectedEnvironment: policy.environments.production_approval,
  }).ok, true);
});
