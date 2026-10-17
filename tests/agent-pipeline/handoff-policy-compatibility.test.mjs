import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(
  new URL('../../.github/agent-pipeline/policy.json', import.meta.url), 'utf8',
));

test('handoff bootstrap preserves the verified CI/review integration policy from PR #124', () => {
  assert.equal(policy.integration_merge_policy, 'verified_ci_review');
  assert.deepEqual(policy.required_checks.integration, [
    'sc-agent/ci', 'sc-agent/review', 'sc-agent/integration-ready',
  ]);
  assert.equal(policy.required_checks.integration.includes('sc-agent/owner-acceptance'), false);
});

test('automatic integration does not replace the separate production approval checks', () => {
  for (const check of ['sc-agent/ci', 'sc-agent/review', 'sc-agent/production-approval', 'sc-agent/promotion-scope']) {
    assert.ok(policy.required_checks.main.includes(check), `Production must retain ${check}`);
  }
  assert.equal(policy.required_checks.main.includes('sc-agent/integration-ready'), false);
  assert.equal(policy.environments.production_approval.name, 'production-approval');
  assert.equal(policy.environments.owner_acceptance.name, 'owner-acceptance');
});
