import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreflight } from '../../tools/agent-pipeline/lib/merge.mjs';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';

// Captured 2026-10-16 from the GitHub API of krzysztofsyska/skillcheck-core.
// This fixture is the read used for the offline proof. It is not a later live read.
const RULESETS = [
  {
    id: 24841688,
    name: 'agent-feedback-state-protection',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { exclude: [], include: ['refs/heads/agent-feedback-state'] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    bypass_actors: null,
  },
  {
    id: 24842345,
    name: 'agent-feedback-state-writer',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { exclude: [], include: ['refs/heads/agent-feedback-state'] } },
    rules: [{ type: 'update' }],
    bypass_actors: null,
  },
];

function gateEnvironment(name, id) {
  return {
    id,
    name,
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    branch_policies: [{ id: name === 'owner-acceptance' ? 62183962 : 62184563, name: 'main', type: 'branch' }],
    protection_rules: [{
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { login: 'krzysztofsyska', id: 222297538 } }],
    }],
  };
}

test('the 2026-10-16 GitHub read fails preflight closed and keeps the controller identity unknown', () => {
  const policy = loadPolicy();
  assert.equal(policy.controller_app_id, null);
  assert.equal(policy.controller_actor_id, null);
  assert.equal(policy.flags.AGENT_PIPELINE_ENABLED, false);
  assert.equal(policy.flags.AGENT_PIPELINE_MERGE_ENABLED, false);
  assert.deepEqual(policy.workflow_ids, {
    reconcile: 376775092,
    verify: 376775095,
    review: 376775093,
    accept: 376775089,
    promote: 376775091,
    gates: 375800413,
  });
  assert.equal(policy.environments.agent_control.id, 23618160050);
  assert.equal(policy.environments.owner_acceptance.id, 23620698987);
  assert.equal(policy.environments.production_approval.id, 23622102440);

  const environments = {
    'owner-acceptance': gateEnvironment('owner-acceptance', policy.environments.owner_acceptance.id),
    'production-approval': gateEnvironment('production-approval', policy.environments.production_approval.id),
  };
  const protection = protectionFromRulesets(RULESETS, policy, environments);
  const preflight = evaluatePreflight(protection);
  assert.equal(preflight.ok, false);
  assert.equal(preflight.reason, 'EXCLUSIVE_WRITERS_UNCONFIRMED');
  assert.equal(protection.exclusiveWritersConfirmed, false);
  assert.equal(protection.mainProtected, false);
  assert.equal(protection.integrationProtected, false);
  assert.equal(protection.agentStateProtected, false);
  assert.equal(protection.requiredChecksPinnedToApp, false);
  assert.equal(protection.environmentsConfirmed, true);
  assert.equal(protection.administrationWriteUsed, false);
  assert.equal(JSON.stringify(RULESETS).includes('SC-OPS-001'), false);
});
