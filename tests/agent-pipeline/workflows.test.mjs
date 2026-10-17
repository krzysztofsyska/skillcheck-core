import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';

const files = [
  '.github/workflows/agent-reconcile.yml',
  '.github/workflows/agent-verify.yml',
  '.github/workflows/agent-review.yml',
  '.github/workflows/agent-accept.yml',
  '.github/workflows/agent-promote.yml',
  '.github/workflows/agent-gates.yml',
  '.github/workflows/agent-handoff.yml',
  '.github/workflows/checks.yml',
];

test('workflow YAML parses and the permission model stays fail-closed', () => {
  for (const file of files) {
    const parsed = spawnSync('python3', ['-c', 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))', file], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('pull_request_target'), false, file);
  }
  const review = readFileSync('.github/workflows/agent-review.yml', 'utf8');
  const verify = readFileSync('.github/workflows/agent-verify.yml', 'utf8');
  const gates = readFileSync('.github/workflows/agent-gates.yml', 'utf8');
  assert.match(review, /openai\/codex-action@bdf19a4a223ec2549a3e2274a0cf61556bc07675/);
  assert.match(review, /codex-version: "0\.160\.1"/);
  assert.match(review, /permission-profile: ":read-only"/);
  assert.equal(review.includes('CURSOR_API_KEY'), false);
  assert.match(verify, /persist-credentials: false/);
  assert.equal(verify.includes('secrets.'), false);
  assert.equal(gates.includes('SC-OPS-001'), false);
  const checks = readFileSync('.github/workflows/checks.yml', 'utf8');
  assert.match(checks, /push:\n {4}branches:\n {6}- main\n {6}- integration\n {2}pull_request:/);
  assert.equal(checks.includes('workflow_dispatch'), false);
  assert.equal(gates.includes('declared_scope" != "OPERATIONS"'), false);
  const controllerOnly = classify({
    files: ['tools/agent-pipeline/cli.mjs'],
    body: 'TASK: SC-OPS-002B\nSCOPE: OPERATIONS\nLEVEL: L3\nOWNER_APPROVAL: PENDING\nPRODUCTION_APPROVAL: PENDING\nREVIEW_VERDICT: PENDING\nPROMOTION: NO\n',
    base: 'integration',
    headRef: 'feat/sc-ops-002b-agent-orchestration',
  });
  assert.equal(controllerOnly.ok, true);
  const bypass = classify({
    files: ['app/page.tsx'],
    body: 'TASK: SC-OPS-002B\nSCOPE: OPERATIONS\nLEVEL: L1\nOWNER_APPROVAL: PENDING\nPRODUCTION_APPROVAL: PENDING\nREVIEW_VERDICT: PENDING\nPROMOTION: NO\n',
    base: 'integration',
    headRef: 'feat/example',
  });
  assert.equal(bypass.ok, false);
});


test('model uses an isolated environment on main, without controller credentials', () => {
  const parsed = spawnSync('python3', ['-c', 'import yaml,json; print(json.dumps(yaml.safe_load(open(".github/workflows/agent-review.yml"))["jobs"]))'], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const jobs = JSON.parse(parsed.stdout);
  const model = jobs.model;
  const authorize = jobs.authorize;
  assert.equal(model.environment, 'agent-review');
  assert.equal(model.needs, 'authorize');
  assert.equal(model.if, "success() && needs.authorize.outputs.allowed == 'true' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && github.run_attempt == 1 && vars.AGENT_PIPELINE_ENABLED == 'true'");
  assert.deepEqual(model.permissions, { contents: 'read' });
  assert.equal(model.env, undefined);
  const secrets = [...JSON.stringify(model).matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]);
  assert.deepEqual(secrets, ['OPENAI_API_KEY']);
  assert.equal(authorize.environment, undefined);
  assert.equal(authorize.if, "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && github.run_attempt == 1 && vars.AGENT_PIPELINE_ENABLED == 'true'");
  assert.deepEqual(authorize.permissions, { contents: 'read' });
  assert.equal(JSON.stringify(authorize).includes('secrets.'), false);
  assert.equal(JSON.stringify(authorize).includes('inputs'), false);
  assert.equal(authorize.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(authorize.steps[0].with['persist-credentials'], false);
  assert.match(authorize.steps[2].run, /authorize-review-dispatch\.mjs/);
  assert.equal(authorize.steps[2].env.ACTOR_ID, '${{ github.actor_id }}');
  assert.equal(authorize.steps[2].env.PIPELINE_ENABLED, '${{ vars.AGENT_PIPELINE_ENABLED }}');
  assert.equal(authorize.steps[2].env.RUN_ATTEMPT, '${{ github.run_attempt }}');
});

test('example secret map keeps OpenAI out of the controller environment', () => {
  const example = JSON.parse(readFileSync('.github/agent-pipeline/config.example.json', 'utf8'));
  assert.equal(example.secrets.OPENAI_API_KEY, 'SET_IN_GITHUB_ENVIRONMENT_AGENT_REVIEW_NOT_IN_GIT');
  assert.equal(example.secrets.OPENAI_API_KEY.includes('AGENT_CONTROL'), false);
  assert.match(example.secrets.CURSOR_API_KEY, /AGENT_CONTROL/);
  assert.match(example.secrets.APP_PRIVATE_KEY, /AGENT_CONTROL/);
  assert.equal(example.flags.AGENT_PIPELINE_ENABLED, false);
  assert.equal(example.flags.AGENT_PIPELINE_MERGE_ENABLED, false);
});
