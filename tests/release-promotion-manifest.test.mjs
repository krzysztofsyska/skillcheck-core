import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFile, prNumberFromSubject } from '../tools/release/promotion-manifest.mjs';

test('extracts PR numbers from every merge subject style used on integration', () => {
  assert.equal(prNumberFromSubject('Merge pull request #163 from krzysztofsyska/fix/x'), 163);
  assert.equal(prNumberFromSubject('Merge PR #133: classify isolated SQL as backend L3'), 133);
  assert.equal(prNumberFromSubject('Merge SC-014-B2 isolated competency attempt backend (#135)'), 135);
  assert.equal(prNumberFromSubject('chore(ops): restrict Vercel auto deployments (#110)'), 110);
  assert.equal(prNumberFromSubject('Merge SC-012-A offline interview plan generator (PR #76)'), 76);
  assert.equal(prNumberFromSubject('direct commit without reference'), null);
});

test('classifies release-relevant paths', () => {
  assert.equal(classifyFile('supabase/migrations/20261021084732_sc019_credits_payments_inventory.sql'), 'migration');
  assert.equal(classifyFile('.github/workflows/checks.yml'), 'ci-governance');
  assert.equal(classifyFile('app/api/sales/route.ts'), 'api');
  assert.equal(classifyFile('app/dashboard/page.tsx'), 'frontend');
  assert.equal(classifyFile('lib/billing.ts'), 'backend');
  assert.equal(classifyFile('vercel.json'), 'runtime-config');
});

test('committed manifest accounts for every promoted commit and pending migrations', () => {
  const manifest = JSON.parse(readFileSync(new URL('../docs/release/promotion-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.unattributed.length, 0);
  assert.equal(manifest.attributed_count, manifest.commit_count);
  assert.match(manifest.head_sha, /^[a-f0-9]{40}$/);
  assert.match(manifest.base_sha, /^[a-f0-9]{40}$/);
  for (const step of manifest.steps) assert.ok(Number.isInteger(step.pr), `step ${step.step_sha} has no PR`);
});

test('proposed controller runbook stays inactive and fail-closed', () => {
  const runbook = JSON.parse(readFileSync(new URL('../docs/release/production-runbook.proposed.json', import.meta.url), 'utf8'));
  assert.equal(runbook.status, 'PROPOSED_NOT_APPROVED');
  assert.ok(runbook.operations.length >= 13);
  assert.ok(runbook.smoke_tests.length > 0);
  assert.ok(runbook.rollback.length > 0);
  assert.deepEqual(runbook.secret_names, []);
  assert.ok(runbook.operations.every(op => !/db push/i.test(op) || /never|nigdy|zakaz/i.test(op)));
});
