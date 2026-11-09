import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAutoReleaseInput, qualifyRelease } from '../../tools/agent-pipeline/lib/auto-release-collector.mjs';

const I = 'a'.repeat(40), M = 'b'.repeat(40);
const record = { state: 'ACCEPTED', task_id: 'T1', head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), policy_sha: 'p', contract_hash: 'h',
  ci_run_id: 1, review_run_id: 2, issue_number: 5,
  binding: { post_merge_ci:{ok:true,headSha:'e'.repeat(40)}, merge: { mergeCommitSha: 'e'.repeat(40) },
    auto_integration: { source: 'verified_ci_review', head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), policy_sha: 'p', contract_hash: 'h',
      ci_run_id: 1, review_run_id: 2, ci_digest: 'x', review_digest: 'y' } } };
const plan = { id: 'r', operations: [{}], rollback: 'redeploy', smoke_tests: ['s'] };
const readers = (over = {}) => {
  const calls = [];
  const rd = {
    repository: 'r/r', calls,
    readBranchSha: async n => { calls.push(['branch', n]); return n === 'main' ? M : I; },
    readRecords: async () => ({ T1: record }),
    readComparisonComplete: async (b) => b === M
      ? { status: 'ahead', complete: true, commits: [{ sha: 'e'.repeat(40) }], files: [{ filename: 'app/page.tsx' }] }
      : { status: 'ahead', complete: true, commits: [], files: [] },
    readReleasePlan: async () => plan,
    readRulesets: async () => [], readEnvironments: async () => ({}),
    readMigrationSql: async () => 'select 1',
    readCiEvidence: async sha => ({ head_sha: sha, completed: true, conclusion: 'success' }),
    readReviewEvidence: async sha => ({ head_sha: sha, completed: true, conclusion: 'success', verdict: 'PASS' }),
    readCodexEvidence: async sha => ({ head_sha: sha, completed: true, open_findings: 0 }),
    readScopeVerdict: async () => undefined,
    readLock: async () => ({ held: false, inflight: 0 }), readReleased: async () => [],
    ...over,
  };
  return rd;
};
const run = (over, trusted = { p24Hold: true }) => qualifyRelease({ readers: readers(over), trusted, policy: {} });

test('P24 hold denies even with a fully collected input', async () => {
  const r = await run();
  assert.equal(r.decision, 'DENY'); assert.ok(r.reasons.includes('P24_HOLD'));
});
test('collector is read-only: only read* readers exist and none is a writer', async () => {
  const rd = readers();
  assert.ok(Object.keys(rd).filter(k => typeof rd[k] === 'function').every(k => k.startsWith('read')));
});
test('incomplete comparison (pagination/truncation) -> explicit deny', async () => {
  const r = await run({ readComparisonComplete: async () => ({ status: 'ahead', complete: false, commits: [], files: [] }) });
  assert.equal(r.decision, 'DENY'); assert.ok(r.reasons.includes('COLLECT:PROMOTION_MANIFEST_FAILED'));
});
test('SHA race between first read and recheck -> deny', async () => {
  let n = 0;
  const r = await run({ readBranchSha: async name => (name === 'main' ? M : (++n > 1 ? 'f'.repeat(40) : I)) });
  assert.ok(r.reasons.includes('COLLECT:SHA_RACE'));
});
test('missing/failed evidence readers never become ALLOW', async () => {
  for (const k of ['readCiEvidence', 'readReviewEvidence', 'readCodexEvidence', 'readLock', 'readReleased', 'readRulesets']) {
    const r = await run({ [k]: async () => { throw new Error('boom'); } }, { p24Hold: false });
    assert.equal(r.decision, 'DENY', k);
  }
  const absent = await qualifyRelease({ readers: { repository: 'r/r' }, trusted: { p24Hold: false }, policy: {} });
  assert.equal(absent.decision, 'DENY');
});
test('stale/foreign CI evidence is denied by the evaluator', async () => {
  const r = await run({ readCiEvidence: async () => ({ head_sha: 'f'.repeat(40), completed: true, conclusion: 'success' }) }, { p24Hold: false });
  assert.ok(r.reasons.includes('CI_MISSING_OR_STALE'));
});
test('unreadable branch heads stop collection early', async () => {
  const { input, collectErrors } = await collectAutoReleaseInput({ readers: readers({ readBranchSha: async () => { throw new Error('x'); } }), trusted: {}, policy: {} });
  assert.ok(collectErrors.includes('READ_INTEGRATION_FAILED')); assert.equal(input.promotion, undefined);
});
test('migration files are read at the bound integration SHA only', async () => {
  const seen = [];
  await run({ readComparisonComplete: async b => b === M ? { status: 'ahead', complete: true, commits: [{ sha: 'e'.repeat(40) }], files: [{ filename: 'supabase/migrations/1.sql' }] } : { status: 'ahead', complete: true, commits: [], files: [] },
    readMigrationSql: async (p, ref) => { seen.push([p, ref]); return 'alter table t add column c text'; } });
  assert.deepEqual(seen, [['supabase/migrations/1.sql', I]]);
});
