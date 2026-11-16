import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTRIBUTION_EXCEPTIONS, classifyFile, prNumberFromSubject, resolveStepPr } from '../tools/release/promotion-manifest.mjs';

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

const TOOL = new URL('../tools/release/promotion-manifest.mjs', import.meta.url).pathname;

function tinyHistory(subjects) {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-manifest-'));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'base');
  writeFileSync(join(dir, 'a.txt'), '0');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'head');
  subjects.forEach((subject, i) => {
    writeFileSync(join(dir, 'a.txt'), String(i + 1));
    git('commit', '-q', '-am', subject);
  });
  const run = () => spawnSync('node', [TOOL, '--base', 'base', '--head', 'head'], { cwd: dir, encoding: 'utf8' });
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('attribution exception is data with a verifiable source: exactly one pinned SHA to #356', () => {
  assert.deepEqual(Object.keys(ATTRIBUTION_EXCEPTIONS), ['0632e05ad5c8ca9b695c9550ecd73145452424a5']);
  const entry = ATTRIBUTION_EXCEPTIONS['0632e05ad5c8ca9b695c9550ecd73145452424a5'];
  assert.equal(entry.pr, 356);
  assert.match(entry.source, /commits\/0632e05ad5c8ca9b695c9550ecd73145452424a5\/pulls/);
  assert.match(entry.source, /2026-11-08T12:39:52Z/);
  assert.match(entry.source, /13:39:52/);
});

test('the exception applies to that SHA and nothing else', () => {
  const sha = '0632e05ad5c8ca9b695c9550ecd73145452424a5';
  const subject = 'fix(SC-BULK): bind manual preselection moves to recruitment and company';
  const hit = resolveStepPr({ sha, subject });
  assert.equal(hit.pr, 356);
  assert.equal(hit.exception.sha, sha);
  // Same subject, different SHA: no attribution by guessing from the title.
  assert.deepEqual(resolveStepPr({ sha: 'f'.repeat(40), subject }), { pr: null, exception: null });
  // A PR number in the subject always wins and records no exception.
  assert.deepEqual(resolveStepPr({ sha, subject: 'x (#9)' }), { pr: 9, exception: null });
  // Prototype keys are not entries.
  assert.deepEqual(resolveStepPr({ sha: 'constructor', subject }), { pr: null, exception: null });
});

test('generator still fails closed (exit 2) on a commit with no PR number and no map entry', () => {
  const h = tinyHistory(['feat: attributed (#7)', 'direct commit without reference']);
  try {
    const result = h.run();
    assert.equal(result.status, 2, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.unattributed.length, 1);
    assert.equal(manifest.attributed_count, manifest.commit_count - 1);
    assert.deepEqual(manifest.attribution_exceptions_used, []);
  } finally { h.cleanup(); }
});

test('generator exits 0 when every commit carries a PR number', () => {
  const h = tinyHistory(['feat: one (#7)', 'fix: two (#8)']);
  try {
    const result = h.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).unattributed.length, 0);
  } finally { h.cleanup(); }
});

test('proposed controller runbook stays inactive and fail-closed', () => {
  const runbook = JSON.parse(readFileSync(new URL('../docs/release/production-runbook.proposed.json', import.meta.url), 'utf8'));
  assert.equal(runbook.status, 'PROPOSED_NOT_APPROVED');
  assert.ok(runbook.operations.length >= 12);
  assert.ok(runbook.operations.some(op => /M13 .*NOT applied/.test(op)));
  assert.ok(runbook.smoke_tests.length > 0);
  assert.ok(runbook.rollback.length > 0);
  assert.deepEqual(runbook.secret_names, []);
  assert.ok(runbook.operations.every(op => !/db push/i.test(op) || /never|nigdy|zakaz/i.test(op)));
});


function releasedHistory({ outsideParent = false, divergentTree = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-post-release-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
      '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'original');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  git('switch', '-q', '-c', 'integration');
  writeFileSync(join(dir, 'a.txt'), 'release');
  git('commit', '-q', '-am', 'feat: previous release (#7)');
  const releasedHead = git('rev-parse', 'integration');
  git('switch', '-q', 'main');
  if (outsideParent) git('commit', '--allow-empty', '-q', '-m', 'unbackported main-only commit');
  if (divergentTree) git('merge', '-q', '--no-ff', '-s', 'ours', '-m', 'release with a different tree', 'integration');
  else git('merge', '-q', '--no-ff', '-m', 'production merge', 'integration');
  const productionSha = git('rev-parse', 'main');
  git('switch', '-q', 'integration');
  writeFileSync(join(dir, 'a.txt'), 'next release');
  git('commit', '-q', '-am', 'fix: post-release (#8)');
  const run = () => spawnSync('node', [TOOL, '--base', 'main', '--head', 'integration'],
    { cwd: dir, encoding: 'utf8' });
  return { run, productionSha, releasedHead, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('post-release merge tree equals released integration: list only new commits, preserve actual main SHA', () => {
  const h = releasedHistory();
  try {
    const result = h.run();
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.base_sha, h.productionSha);
    assert.equal(manifest.history_base_sha, h.releasedHead);
    assert.equal(manifest.commit_count, 1);
    assert.equal(manifest.attributed_count, 1);
    assert.deepEqual(manifest.steps.map(s => s.pr), [8]);
    assert.deepEqual(manifest.files, ['a.txt']);
    assert.deepEqual(manifest.unattributed, []);
  } finally { h.cleanup(); }
});

test('post-release history refuses a main-only parent not contained in integration', () => {
  const h = releasedHistory({ outsideParent: true });
  try {
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PROMOTION_HISTORY_DIVERGED/);
  } finally { h.cleanup(); }
});

test('post-release history refuses a production merge whose tree differs from released integration', () => {
  const h = releasedHistory({ divergentTree: true });
  try {
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PROMOTION_HISTORY_DIVERGED/);
  } finally { h.cleanup(); }
});
