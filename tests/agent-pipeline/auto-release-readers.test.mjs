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
