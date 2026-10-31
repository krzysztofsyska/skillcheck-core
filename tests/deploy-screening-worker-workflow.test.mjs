import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync(new URL('../.github/workflows/deploy-screening-worker.yml', import.meta.url), 'utf8');

test('screening-worker deploy is manual, main-only and gated by the owner approval environment', () => {
  const triggers = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.match(triggers, /^\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggers, /push|pull_request|schedule|workflow_run|repository_dispatch/);
  assert.match(yml, /^\s+if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(yml, /^\s+environment: production-approval$/m);
  assert.match(yml, /^permissions: \{\}$/m);
  assert.doesNotMatch(yml, /write/);
  assert.match(yml, /persist-credentials: false/);
});

test('only the screening-worker function of the production project is deployed', () => {
  const deploys = yml.match(/supabase [a-z ]+deploy[^\n]*/g);
  assert.deepEqual(deploys, ['supabase functions deploy screening-worker --project-ref "$PROJECT_REF"']);
  assert.match(yml, /PROJECT_REF: wsvjawuikxfzjyivxgsu/);
  assert.doesNotMatch(yml, /db push|migration|secrets set|--no-verify-jwt/);
  // The token is read only inside the deploy step, never echoed.
  assert.equal(yml.match(/secrets\./g).length, 1);
  assert.doesNotMatch(yml, /echo[^\n]*SUPABASE_ACCESS_TOKEN\b(?! is not set)/);
});

test('every action is pinned to a full commit SHA and the CLI to an exact version', () => {
  for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
  assert.match(yml, /version: \d+\.\d+\.\d+$/m);
});
