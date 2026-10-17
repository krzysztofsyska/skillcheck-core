import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../vercel.json', import.meta.url));
const config = JSON.parse(readFileSync(file, 'utf8'));

test('SC deployment allowlist keeps ordinary feature commits out of Vercel', () => {
  assert.equal(config.$schema, 'https://openapi.vercel.sh/vercel.json');
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'git']);
  assert.deepEqual(config.git, {
    deploymentEnabled: {
      '**': false,
      integration: true,
      main: true,
      'release/**': true,
    },
  });
});

test('SC deployment examples: only integration, main and release are eligible', () => {
  const rules = config.git.deploymentEnabled;
  // Vercel's documented priority: any matching true rule beats a false rule.
  // The assertions above fix the rule set, and these examples test intent.
  const isEligible = branch => Object.entries(rules).some(([pattern, enabled]) => {
    if (!enabled) return false;
    if (pattern === branch) return true;
    if (pattern === 'release/**') return branch.startsWith('release/');
    return false;
  });
  for (const branch of ['main', 'integration', 'release/sales-only-20261011', 'release/v1/hotfix']) {
    assert.equal(isEligible(branch), true, branch);
  }
  for (const branch of [
    'feat/sc-019mvp-free-preselection',
    'feat/sc-021-ai-gateway-foundation',
    'fix/sc005-safe-diagnostics',
    'cursor/sc-012b-schema-prototype',
    'chore/vercel-selective-deploy-20261012',
    'docs/sc-010-retention',
    'agent-feedback-state',
  ]) {
    assert.equal(isEligible(branch), false, branch);
  }
});
