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
  const parsed = spawnSync('python3', ['-c', 'import yaml,json; print(json.dumps(yaml.safe_load(open(".github/workflows/agent-review.yml"))["jobs"]["model"]))'], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const model = JSON.parse(parsed.stdout);
  assert.equal(model.environment, 'agent-review');
  assert.equal(model.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(model.permissions, { contents: 'read' });
  assert.equal(model.env, undefined);
  const secrets = [...JSON.stringify(model).matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]);
  assert.deepEqual(secrets, ['OPENAI_API_KEY']);
});
