import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { reviewDispatchDecision } from '../../tools/agent-pipeline/lib/review-dispatch.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';

// Offline regression evidence only: no secrets, GitHub writes or paid calls.
const policy = JSON.parse(readFileSync('.github/agent-pipeline/policy.json', 'utf8'));
const validDispatch = { actorId: '456', controllerActorId: 456, pipelineEnabled: 'true', runAttempt: '1' };
function environmentFixture() {
  const p = structuredClone(policy);
  p.environments.owner_acceptance.id = 800;
  p.environments.production_approval.id = 801;
  const environments = {};
  for (const cfg of Object.values(p.environments)) {
    environments[cfg.name] = {
      id: cfg.id, can_admins_bypass: false,
      deployment_branch_policy: { custom_branch_policies: true },
      branch_policies: [{ name: 'main', type: 'branch' }],
      protection_rules: [{ type: 'required_reviewers', prevent_self_review: true,
        reviewers: [{ type: 'User', reviewer: { id: p.owner.id } }] }],
    };
  }
  environments['agent-review'].protection_rules = [];
  return { p, environments };
}
function environmentsConfirmed(p, environments) {
  return protectionFromRulesets([], p, environments).environmentsConfirmed === true;
}
function yamlJobs(path) {
  const result = spawnSync('python3', ['-c',
    'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))["jobs"]))', path],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('bootstrap keeps the accepted PR124 integration policy, not a stale owner gate', () => {
  assert.equal(policy.integration_merge_policy, 'verified_ci_review');
  assert.deepEqual(policy.required_checks.integration,
    ['sc-agent/ci', 'sc-agent/review', 'sc-agent/integration-ready']);
  assert.ok(policy.required_checks.main.includes('sc-agent/production-approval'));
  assert.ok(policy.required_checks.main.includes('sc-agent/promotion-scope'));
});

test('an environment identifier is configuration, not activation or controller authorization', () => {
  assert.equal(policy.environments.agent_review.id, 23622706434);
  assert.equal(policy.flags.AGENT_PIPELINE_ENABLED, false);
  assert.equal(policy.flags.AGENT_PIPELINE_MERGE_ENABLED, false);
  assert.equal(policy.controller_actor_id, null);
  assert.equal(reviewDispatchDecision({ ...validDispatch,
    controllerActorId: policy.controller_actor_id }).ok, false);
});

test('the exact configured controller is accepted only with explicit activation', () => {
  assert.equal(reviewDispatchDecision(validDispatch).ok, true);
  for (const pipelineEnabled of ['false', '', 'TRUE', true, undefined]) {
    assert.equal(reviewDispatchDecision({ ...validDispatch, pipelineEnabled }).ok, false);
  }
});

test('owner identity, untrusted actor encodings and missing controller cannot spend review budget', () => {
  for (const actorId of [String(policy.owner.id), '', '0456', '456x', 456, '-456', '9007199254740992']) {
    assert.equal(reviewDispatchDecision({ ...validDispatch, actorId }).ok, false);
  }
  for (const controllerActorId of [null, 0, -1, '456', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(reviewDispatchDecision({ ...validDispatch, controllerActorId }).ok, false);
  }
});

test('reruns cannot inherit permission to perform another paid review', () => {
  for (const runAttempt of ['2', '3', '01', '', 1, undefined]) {
    assert.equal(reviewDispatchDecision({ ...validDispatch, runAttempt }).ok, false);
  }
});

test('review environment may be unattended but must have its exact ID and main-only policy', () => {
  const { p, environments } = environmentFixture();
  assert.equal(environmentsConfirmed(p, environments), true);
  for (const mutate of [
    e => { e.id++; },
    e => { e.branch_policies = [{ name: 'main', type: 'tag' }]; },
    e => { e.branch_policies = [{ name: '*', type: 'branch' }]; },
    e => { e.branch_policies.push({ name: 'integration', type: 'branch' }); },
    e => { e.branch_policies = []; },
    e => { e.deployment_branch_policy = null; },
    e => { delete e.branch_policies; },
  ]) {
    const copy = structuredClone(environments);
    mutate(copy['agent-review']);
    assert.equal(environmentsConfirmed(p, copy), false);
  }
});

test('missing environment evidence or an unconfigured environment never passes preflight', () => {
  const { p, environments } = environmentFixture();
  assert.equal(environmentsConfirmed(p, {}), false);
  delete environments['agent-review'];
  assert.equal(environmentsConfirmed(p, environments), false);
  p.environments.agent_review.id = null;
  assert.equal(environmentsConfirmed(p, environmentFixture().environments), false);
});

test('environment-bearing model waits for main-only first-run controller authorization', () => {
  const { authorize, model, publish } = yamlJobs('.github/workflows/agent-review.yml');
  assert.equal(authorize.environment, undefined);
  assert.equal(authorize.steps[0].with.ref, '${{ github.sha }}');
  for (const job of [authorize, model]) {
    assert.ok(job.if.includes("github.ref == 'refs/heads/main'"));
    assert.ok(job.if.includes("github.event_name == 'workflow_dispatch'"));
    assert.ok(job.if.includes('github.run_attempt == 1'));
    assert.ok(job.if.includes("vars.AGENT_PIPELINE_ENABLED == 'true'"));
  }
  assert.equal(model.environment, 'agent-review');
  assert.equal(model.needs, 'authorize');
  assert.ok(model.if.includes("needs.authorize.outputs.allowed == 'true'"));
  assert.equal(publish.needs, 'model');
  assert.equal(publish.environment, undefined);
});

test('only the model references the OpenAI secret, never controller or Cursor credentials', () => {
  const { authorize, model, publish } = yamlJobs('.github/workflows/agent-review.yml');
  const references = [...JSON.stringify(model).matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]);
  assert.deepEqual(references, ['OPENAI_API_KEY']);
  assert.equal(JSON.stringify(authorize).includes('secrets.'), false);
  assert.equal(JSON.stringify(publish).includes('secrets.'), false);
  assert.deepEqual(model.permissions, { contents: 'read' });
});

test('artifact verification has a distinct job name instead of the required verify check', () => {
  const { verify } = yamlJobs('.github/workflows/agent-verify.yml');
  assert.equal(verify.name, 'Agent verify / artifact');
  assert.notEqual(verify.name, 'verify');
  assert.equal(JSON.stringify(verify).includes('secrets.'), false);
});
