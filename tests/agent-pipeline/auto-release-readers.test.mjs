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
