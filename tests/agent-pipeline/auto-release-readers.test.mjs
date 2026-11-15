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
const mkLock = (byStatus = {}, opts = {}) => {
  const c = mkClient({ request: async p => {
    const status = new URL(p, 'https://x').searchParams.get('status');
    const runs = (byStatus[status] ?? []).map(o => ({ workflow_id: PROMOTE, status, ...o }));
    return { total_count: opts.total?.[status] ?? runs.length, workflow_runs: runs };
  } });
  return { c, r: createAutoReleaseReaders({ client: c, repository: 'o/r', policy: { workflow_ids: { promote: PROMOTE }, ...opts.policy } }) };
};
test('lock: free only when no promote run is active, GET only', async () => {
  const { c, r } = mkLock();
  assert.deepEqual(await r.readLock(), { held: false, inflight: 0 });
  assert.ok(c.calls.every(([m, p]) => m === 'GET' && p.startsWith(`/repos/o/r/actions/workflows/${PROMOTE}/runs?status=`)));
  assert.equal(c.calls.length, 5);
});
test('lock: any queued, waiting or running promote run holds the lock', async () => {
  for (const s of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    assert.deepEqual(await mkLock({ [s]: [{}] }).r.readLock(), { held: true, inflight: 1 });
  }
  assert.deepEqual(await mkLock({ queued: [{}], in_progress: [{}] }).r.readLock(), { held: true, inflight: 2 });
});
test('lock: unpinned, truncated, inconsistent or foreign runs fail closed', async () => {
  await assert.rejects(mk(mkClient()).readLock(), /LOCK_WORKFLOW_NOT_PINNED/);
  await assert.rejects(mkLock({}, { policy: { workflow_ids: { promote: '42' } } }).r.readLock(), /LOCK_WORKFLOW_NOT_PINNED/);
  await assert.rejects(mkLock({ queued: [{}] }, { total: { queued: 2 } }).r.readLock(), /LOCK_INCOMPLETE/);
  await assert.rejects(mkLock({ in_progress: Array.from({ length: 100 }, () => ({})) }).r.readLock(), /LOCK_INCOMPLETE/);
  await assert.rejects(mkLock({ waiting: [{ workflow_id: 7 }] }).r.readLock(), /LOCK_FOREIGN_RUN/);
  await assert.rejects(mkLock({ queued: [{ status: 'completed' }] }).r.readLock(), /LOCK_FOREIGN_RUN/);
  const bad = createAutoReleaseReaders({ client: mkClient({ request: async () => ({}) }), repository: 'o/r', policy: { workflow_ids: { promote: PROMOTE } } });
  await assert.rejects(bad.readLock(), /LOCK_INCOMPLETE/);
});
test('lock reader alone never turns the decision into ALLOW', async () => {
  const { r } = mkLock();
  const d = await qualifyRelease({ readers: r, trusted: { p24Hold: true }, policy: { workflow_ids: { promote: PROMOTE } } });
  assert.equal(d.decision, 'DENY');
  assert.ok(!d.reasons.includes('COLLECT:READ_LOCK_FAILED'));
  assert.ok(d.reasons.includes('P24_HOLD'));
});
