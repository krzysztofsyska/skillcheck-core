import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoReleaseReaders } from '../../tools/agent-pipeline/lib/auto-release-readers.mjs';
import { qualifyRelease } from '../../tools/agent-pipeline/lib/auto-release-collector.mjs';

const I = 'a'.repeat(40), M = 'b'.repeat(40);
const mkClient = (over = {}) => {
  const calls = [];
  return { calls,
    request: async (p, o) => { calls.push([o?.method ?? 'GET', p]); return over.request ? over.request(p) : []; },
    readBranch: async n => ({ commit: { sha: n === 'main' ? M : I } }),
    readComparison: async () => ({ commits: [], files: [] }),
    readReleasePlan: async () => null, ...over.client };
};
const mk = c => createAutoReleaseReaders({ client: c, repository: 'o/r', policy: {} });

test('branch sha must be a full sha', async () => {
  const r = mk(mkClient({ client: { readBranch: async () => ({ commit: { sha: 'x' } }) } }));
  await assert.rejects(r.readBranchSha('main'), /BRANCH_SHA_INVALID/);
  assert.equal(await mk(mkClient()).readBranchSha('main'), M);
});
test('migration path/ref are validated and only GET is used', async () => {
  const c = mkClient({ request: async () => ({ encoding: 'base64', content: Buffer.from('select 1').toString('base64') }) });
  const r = mk(c);
  await assert.rejects(r.readMigrationSql('../x.sql', I), /MIGRATION_REF_INVALID/);
  await assert.rejects(r.readMigrationSql('supabase/migrations/a.sql', 'main'), /MIGRATION_REF_INVALID/);
  assert.equal(await r.readMigrationSql('supabase/migrations/a.sql', I), 'select 1');
  assert.ok(c.calls.every(([m]) => m === 'GET'));
});
test('truncated rulesets list is refused', async () => {
  const r = mk(mkClient({ request: async () => Array.from({ length: 100 }, (_, i) => ({ id: i })) }));
  await assert.rejects(r.readRulesets(), /RULESETS_INCOMPLETE/);
});
test('without evidence readers the release is DENIED (fail closed)', async () => {
  const d = await qualifyRelease({ readers: mk(mkClient()), trusted: { p24Hold: true }, policy: {} });
  assert.equal(d.decision, 'DENY');
  assert.ok(d.reasons.some(x => x.startsWith('COLLECT:')));
});

const ciRun = (o = {}) => ({ name: 'sc-agent/ci', app: { id: 7 }, head_sha: I, status: 'completed', conclusion: 'success', ...o });
const mkCi = (runs, total = runs.length) => createAutoReleaseReaders({ client: mkClient({ request: async () => ({ total_count: total, check_runs: runs }) }), repository: 'o/r', policy: { controller_app_id: 7, required_checks: { integration: ['sc-agent/ci'] } } });
test('CI evidence: exact SHA, pinned app, unique run', async () => {
  assert.deepEqual(await mkCi([ciRun()]).readCiEvidence(I), { head_sha: I, completed: true, conclusion: 'success' });
  assert.equal((await mkCi([ciRun({ status: 'in_progress', conclusion: null })]).readCiEvidence(I)).completed, false);
  await assert.rejects(mkCi([ciRun({ app: { id: 8 } })]).readCiEvidence(I), /CI_NOT_UNIQUE/);
  await assert.rejects(mkCi([ciRun({ head_sha: M })]).readCiEvidence(I), /CI_NOT_UNIQUE/);
  await assert.rejects(mkCi([ciRun(), ciRun()]).readCiEvidence(I), /CI_NOT_UNIQUE/);
  await assert.rejects(mkCi([ciRun()], 2).readCiEvidence(I), /CI_INCOMPLETE/);
  await assert.rejects(mkCi([ciRun()]).readCiEvidence('main'), /CI_REF_INVALID/);
  await assert.rejects(mk(mkClient()).readCiEvidence(I), /CI_APP_NOT_PINNED/);
});

const PROMOTE = 42;
const run = (id, status = 'completed', o = {}) => ({ id, workflow_id: PROMOTE, status, ...o });
// Serves an unfiltered, paginated listing. `script` may return a different run list per call
// (call index starts at 0) to model runs changing between requests.
const mkLock = (runsOrScript = [], opts = {}) => {
  let call = 0;
  const c = mkClient({ request: async p => {
    const u = new URL(p, 'https://x');
    assert.equal(u.searchParams.get('status'), null);
    const all = typeof runsOrScript === 'function' ? runsOrScript(call) : runsOrScript;
    call += 1;
    const n = Number(u.searchParams.get('page'));
    const per = Number(u.searchParams.get('per_page'));
    return { total_count: opts.total ?? all.length, workflow_runs: all.slice((n - 1) * per, n * per) };
  } });
  return { c, r: createAutoReleaseReaders({ client: c, repository: 'o/r', policy: { workflow_ids: { promote: PROMOTE }, ...opts.policy } }) };
};
test('lock: one unfiltered snapshot, free only when every promote run is completed, GET only', async () => {
  const { c, r } = mkLock([run(1), run(2)]);
  assert.deepEqual(await r.readLock(), { held: false, inflight: 0 });
  assert.ok(c.calls.every(([m, p]) => m === 'GET' && p.startsWith(`/repos/o/r/actions/workflows/${PROMOTE}/runs?per_page=100&page=`)));
  assert.equal(c.calls.length, 2); // page 1 + consistency re-read
  assert.deepEqual(await mkLock([]).r.readLock(), { held: false, inflight: 0 });
});
test('lock: any non-completed (incl. unknown) status holds the lock', async () => {
  for (const s of ['queued', 'in_progress', 'waiting', 'requested', 'pending', 'action_required', 'something_new']) {
    assert.deepEqual(await mkLock([run(1), run(2, s)]).r.readLock(), { held: true, inflight: 1 });
  }
  assert.deepEqual(await mkLock([run(1, 'queued'), run(2, 'in_progress')]).r.readLock(), { held: true, inflight: 2 });
});
test('lock: a run moving between statuses during the read is still counted (no per-status gap)', async () => {
  // Call 0 sees it waiting, the re-read sees it in_progress: it is never missed.
  const { r } = mkLock(call => [run(7, call === 0 ? 'waiting' : 'in_progress')]);
  assert.deepEqual(await r.readLock(), { held: true, inflight: 1 });
});
test('lock: a completed run re-run between reads (same id) holds the lock', async () => {
  const { r } = mkLock(call => [run(7, call === 0 ? 'completed' : 'in_progress'), run(8)]);
  assert.deepEqual(await r.readLock(), { held: true, inflight: 1 });
  // and the reverse (active → completed during the read) stays conservatively held
  assert.deepEqual(await mkLock(call => [run(7, call === 0 ? 'queued' : 'completed')]).r.readLock(), { held: true, inflight: 1 });
});
test('lock: reads every page; an active run on a later page holds the lock', async () => {
  const runs = Array.from({ length: 250 }, (_, k) => run(k + 1));
  runs[230] = run(231, 'queued');
  const { c, r } = mkLock(runs);
  assert.deepEqual(await r.readLock(), { held: true, inflight: 1 });
  assert.equal(c.calls.length, 4);
});
test('lock: unpinned, truncated, inconsistent, shifting or foreign listings fail closed', async () => {
  await assert.rejects(mk(mkClient()).readLock(), /LOCK_WORKFLOW_NOT_PINNED/);
  await assert.rejects(mkLock([], { policy: { workflow_ids: { promote: '42' } } }).r.readLock(), /LOCK_WORKFLOW_NOT_PINNED/);
  await assert.rejects(mkLock([run(1)], { total: 2 }).r.readLock(), /LOCK_INCOMPLETE/);
  await assert.rejects(mkLock([run(1), run(1)]).r.readLock(), /LOCK_INCOMPLETE/);
  await assert.rejects(mkLock(Array.from({ length: 1001 }, (_, k) => run(k + 1))).r.readLock(), /LOCK_INCOMPLETE/);
  // A new run appears during pagination: total_count changes → refuse.
  await assert.rejects(mkLock(call => Array.from({ length: 150 + (call > 0 ? 1 : 0) }, (_, k) => run(k + 1))).r.readLock(), /LOCK_INCOMPLETE/);
  // Same total but a different run set on re-read (one deleted, one created) → refuse.
  await assert.rejects(mkLock(call => [run(call === 0 ? 1 : 2, 'queued')]).r.readLock(), /LOCK_INCOMPLETE/);
  await assert.rejects(mkLock([run(1, 'waiting', { workflow_id: 7 })]).r.readLock(), /LOCK_FOREIGN_RUN/);
  await assert.rejects(mkLock([run(1, null)]).r.readLock(), /LOCK_FOREIGN_RUN/);
  await assert.rejects(mkLock([run('1')]).r.readLock(), /LOCK_FOREIGN_RUN/);
  const bad = createAutoReleaseReaders({ client: mkClient({ request: async () => ({}) }), repository: 'o/r', policy: { workflow_ids: { promote: PROMOTE } } });
  await assert.rejects(bad.readLock(), /LOCK_INCOMPLETE/);
});
test('lock reader alone never turns the decision into ALLOW', async () => {
  const { r } = mkLock([run(1)]);
  const d = await qualifyRelease({ readers: r, trusted: { p24Hold: true }, policy: { workflow_ids: { promote: PROMOTE } } });
  assert.equal(d.decision, 'DENY');
  assert.ok(!d.reasons.includes('COLLECT:READ_LOCK_FAILED'));
  assert.ok(d.reasons.includes('P24_HOLD'));
});

// Stage 4e: Codex evidence wired through the auto-release readers.
import { codexAggregateProblems } from '../../tools/agent-pipeline/lib/codex-evidence.mjs';
const H1 = '1'.repeat(40), MG1 = '2'.repeat(40), RID = 199175422;
const codexManifest = { integration_sha: I, main_sha: M, tasks: [{ task_id: 'T1', head_sha: H1, merge_sha: MG1 }], commits: [MG1] };
const codexArgs = { repository: 'o/r', base: M, head: I, manifest: codexManifest };
const codexClient = (over = {}) => mkClient({ client: {
  readPullsForCommit: async () => [{ number: 5 }],
  readPull: async () => ({ number: 5, merged: true, base: { ref: 'integration', repo: { full_name: 'o/r' } }, merge_commit_sha: MG1 }),
  readCommit: async s => ({ sha: s, parents: [{ sha: '9'.repeat(40) }, { sha: H1 }] }),
  readReviews: async () => [{ id: 7, user: { id: RID, login: 'chatgpt-codex-connector[bot]' }, commit_id: H1, state: 'COMMENTED', body: 'No major issues.', submitted_at: 't' }],
  readReviewThreads: async () => over.threads ?? [{ isResolved: true }],
  ...over.client } });
const mkCodex = (c, codexReviewerId) => createAutoReleaseReaders({ client: c, repository: 'o/r', policy: {}, codexReviewerId });

test('codex reader: unpinned reviewer id fails closed with an explicit error', async () => {
  for (const id of [undefined, 0, -1, '199175422', 1.5]) await assert.rejects(mkCodex(codexClient(), id).readCodexEvidence(codexArgs), /CODEX_REVIEWER_NOT_PINNED/);
});
test('codex reader: client without the read-only Codex methods is refused', async () => {
  await assert.rejects(mkCodex(mkClient(), RID).readCodexEvidence(codexArgs), /CODEX_CLIENT_INVALID/);
});
test('codex reader: pinned reviewer yields an aggregate the evaluator accepts only for the same pin', async () => {
  const c = codexClient();
  const ev = await mkCodex(c, RID).readCodexEvidence(codexArgs);
  const current = { repository: 'o/r', integrationSha: I, mainSha: M };
  assert.equal(ev.source, 'trusted_codex_reader');
  assert.deepEqual(codexAggregateProblems(ev, { current, manifest: codexManifest, reviewerId: RID }), []);
  assert.ok(codexAggregateProblems(ev, { current, manifest: codexManifest, reviewerId: 42 }).includes('CODEX_REVIEWER_MISMATCH'));
  assert.ok(c.calls.every(([m]) => m === 'GET'));
});
test('codex reader: open thread or foreign reviewer never becomes clean evidence', async () => {
  const open = await mkCodex(codexClient({ threads: [{ isResolved: false }] }), RID).readCodexEvidence(codexArgs);
  const current = { repository: 'o/r', integrationSha: I, mainSha: M };
  assert.ok(codexAggregateProblems(open, { current, manifest: codexManifest, reviewerId: RID }).includes('CODEX_OPEN_FINDINGS'));
  await assert.rejects(mkCodex(codexClient(), 42).readCodexEvidence(codexArgs), /CODEX_REVIEW_MISSING_FOR_HEAD/);
  await assert.rejects(mkCodex(codexClient(), RID).readCodexEvidence({ ...codexArgs, repository: 'x/y' }), /CODEX_INPUT_INVALID/);
});

// Stage 4f: controller review check, distinct from Codex and scope evidence.
const reviewCheck = (over = {}) => ({
  name: 'sc-agent/review', app: { id: 7 }, head_sha: I,
  status: 'completed', conclusion: 'success', ...over,
});
const mkReviewCheck = (runs, total = runs.length, policyOverride = {}) => {
  const c = mkClient({ request: async () => ({ total_count: total, check_runs: runs }) });
  const r = createAutoReleaseReaders({
    client: c, repository: 'o/r',
    policy: { controller_app_id: 7, required_checks: { integration: ['sc-agent/review'] }, ...policyOverride },
  });
  return { c, r };
};
test('review check: exact SHA, pinned controller App, unique completed success', async () => {
  const { c, r } = mkReviewCheck([reviewCheck()]);
  assert.deepEqual(await r.readReviewEvidence(I), {
    head_sha: I, completed: true, conclusion: 'success', verdict: 'PASS',
  });
  assert.ok(c.calls.every(([method, p]) => method === 'GET' && p.includes(`/commits/${I}/check-runs?`)));
});
test('review check: pending, cancelled or failing check never emits PASS', async () => {
  const pending = await mkReviewCheck([reviewCheck({ status: 'in_progress', conclusion: 'success' })]).r.readReviewEvidence(I);
  assert.deepEqual(pending, { head_sha: I, completed: false, conclusion: null, verdict: null });
  for (const conclusion of ['failure', 'cancelled', 'neutral', null]) {
    const v = await mkReviewCheck([reviewCheck({ conclusion })]).r.readReviewEvidence(I);
    assert.equal(v.verdict, null);
  }
});
test('review check: foreign App, stale SHA, duplicates and incomplete pages are refused', async () => {
  await assert.rejects(mkReviewCheck([reviewCheck({ app: { id: 9 } })]).r.readReviewEvidence(I), /REVIEW_PROVENANCE_MISMATCH/);
  await assert.rejects(mkReviewCheck([reviewCheck({ head_sha: M })]).r.readReviewEvidence(I), /REVIEW_PROVENANCE_MISMATCH/);
  await assert.rejects(mkReviewCheck([reviewCheck({ name: 'sc-agent/ci' })]).r.readReviewEvidence(I), /REVIEW_PROVENANCE_MISMATCH/);
  await assert.rejects(mkReviewCheck([reviewCheck(), reviewCheck()]).r.readReviewEvidence(I), /REVIEW_NOT_UNIQUE/);
  await assert.rejects(mkReviewCheck([reviewCheck()], 2).r.readReviewEvidence(I), /REVIEW_INCOMPLETE/);
  await assert.rejects(mkReviewCheck([]).r.readReviewEvidence(I), /REVIEW_NOT_UNIQUE/);
  await assert.rejects(mkReviewCheck([reviewCheck()]).r.readReviewEvidence('integration'), /REVIEW_REF_INVALID/);
  await assert.rejects(mkReviewCheck([reviewCheck()], 1, { controller_app_id: null }).r.readReviewEvidence(I), /REVIEW_APP_NOT_PINNED/);
  await assert.rejects(mkReviewCheck([reviewCheck()], 1, { required_checks: { integration: [] } }).r.readReviewEvidence(I), /REVIEW_CHECK_NOT_REQUIRED/);
});
test('review check alone does not authorize a release without independent scope evidence', async () => {
  const { r } = mkReviewCheck([reviewCheck()]);
  const d = await qualifyRelease({ readers: r, trusted: { p24Hold: false }, policy: {} });
  assert.equal(d.decision, 'DENY');
  assert.ok(!d.reasons.includes('COLLECT:READ_REVIEW_FAILED'));
  assert.ok(d.reasons.includes('SCOPE_VERDICT_MISSING') || d.reasons.includes('NO_PROMOTION_MANIFEST'));
});
