import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { assessConfiguration } from '../../tools/agent-pipeline/lib/configuration.mjs';
import { guardEffects } from '../../tools/agent-pipeline/lib/controller.mjs';

const paidCredentials = {
  CURSOR_API_KEY: 'fake-paid-cursor',
  OPENAI_API_KEY: 'fake-paid-openai',
  ANTHROPIC_API_KEY: 'fake-paid-anthropic',
  GITHUB_REPOSITORY: 'krzysztofsyska/skillcheck-core',
  AGENT_PIPELINE_APP_ID: '123',
  AGENT_PIPELINE_APP_PRIVATE_KEY: 'fake-private-key',
};
const on = { enabled: true, mergeEnabled: true };
const off = { enabled: false, mergeEnabled: false };

test('SC-436 explicitly selects SUBSCRIPTION_ONLY with both control flags OFF', () => {
  const policy = loadPolicy();
  assert.equal(policy.execution_mode, 'SUBSCRIPTION_ONLY');
  assert.equal(policy.flags.AGENT_PIPELINE_ENABLED, false);
  assert.equal(policy.flags.AGENT_PIPELINE_MERGE_ENABLED, false);
  assert.deepEqual(assessConfiguration({}, off, policy), { ok: true, mode: 'read-only', missing: [] });
});

test('LIVE rejects subscription-only before any paid provider credentials can help', () => {
  const policy = loadPolicy();
  for (const env of [{}, paidCredentials, { ...paidCredentials, CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth' }]) {
    const result = assessConfiguration(env, on, policy);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('SUBSCRIPTION_ONLY_RUNTIME_NOT_READY'));
    assert.equal(result.missing.includes('CURSOR_API_KEY'), false, 'no Cursor fallback');
    assert.equal(result.missing.includes('CLAUDE_BUDGET_UNAPPROVED'), false, 'no billed Claude fallback');
  }
  assert.ok(assessConfiguration(paidCredentials, on, { ...policy, execution_mode: 'typo' })
    .missing.includes('EXECUTION_MODE_UNRECOGNIZED'));
});

test('SC-436 defense-in-depth blocks dispatch, builder, merge and PR writes even after a false-positive preflight', () => {
  const policy = loadPolicy();
  const effects = [
    { type: 'cursor.create', external: true, branch: 'feat/sc-safe', payload: {} },
    { type: 'cursor.followup', external: true },
    { type: 'github.dispatch', workflow: 'review', external: true },
    { type: 'github.dispatch', workflow: 'verify', external: true },
    { type: 'github.createPr', base: 'integration', external: true },
    { type: 'github.merge', gate: 'A', external: true },
  ];
  const obs = { policy, simulation: false, flags: on, preflight: { ok: true } };
  const gated = guardEffects(effects, obs);
  assert.deepEqual(gated.allowed, []);
  assert.equal(gated.suppressed.length, effects.length);
  const disabled = guardEffects(effects, { ...obs, flags: off });
  assert.equal(disabled.allowed.length, 0);
  // Read-only / local simulation is still possible without side effects.
  const dry = guardEffects(effects, { ...obs, simulation: true });
  assert.equal(dry.allowed.length, effects.length);
  const internal = guardEffects([{ type: 'notify', external: false }], obs);
  assert.equal(internal.allowed.length, 1);
});
