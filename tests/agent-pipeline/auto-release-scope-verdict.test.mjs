// SC-AUTO-RELEASE (#369) stage 4j: independent scope-verdict reader (read-only, fail closed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoReleaseReaders } from '../../tools/agent-pipeline/lib/auto-release-readers.mjs';
import { evaluateAutoRelease } from '../../tools/agent-pipeline/lib/auto-release.mjs';
import { sha256 } from '../../tools/agent-pipeline/lib/canonical.mjs';

const I = 'a'.repeat(40), M = 'b'.repeat(40);
const CONTROLLER = 7, ISSUER = 11, NAME = 'sc-scope/verdict';
const manifest = { main_sha: M, integration_sha: I, commits: [I], tasks: [] };
const args = { base: M, head: I, manifest };
const body = (o = {}) => ({
  schema: 'sc-scope-verdict/v1', repository: 'o/r', base_sha: M, head_sha: I,
  manifest_hash: sha256(manifest), verdict: 'LOW_RISK_COMPATIBLE', ...o,
});
const run = (o = {}) => ({
  id: 99, name: NAME, app: { id: ISSUER }, head_sha: I, status: 'completed', conclusion: 'success',
  output: { text: JSON.stringify(body()) }, ...o,
});
const mk = (runs, { total = runs.length, policy = {} } = {}) => {
  const calls = [];
  const client = {
    request: async (p, o) => { calls.push([o?.method ?? 'GET', p]); return { total_count: total, check_runs: runs }; },
    readBranch: async () => null, readComparison: async () => null, readReleasePlan: async () => null,
  };
  const r = createAutoReleaseReaders({
    client, repository: 'o/r',
    policy: { controller_app_id: CONTROLLER, scope_verdict: { app_id: ISSUER, check_name: NAME }, ...policy },
  });
  return { r, calls };
};

test('scope verdict: exact SHA, pinned independent App, bound body => trusted verdict (GET only)', async () => {
  const { r, calls } = mk([run()]);
  assert.deepEqual(await r.readScopeVerdict(args), {
    source: 'trusted_independent_scope_reader', verdict: 'LOW_RISK_COMPATIBLE', repository: 'o/r',
    base_sha: M, head_sha: I, manifest_hash: sha256(manifest), check_run_id: 99,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['GET', `/repos/o/r/commits/${I}/check-runs?check_name=${encodeURIComponent(NAME)}&per_page=100`]);
});

test('scope verdict: the output satisfies the evaluator binding; NOT_LOW_RISK never qualifies', async () => {
  const current = { repository: 'o/r', mainSha: M, integrationSha: I };
  const reasons = v => evaluateAutoRelease({ current, scopeVerdict: v, promotion: { manifest } }).reasons;
  assert.ok(!reasons(await mk([run()]).r.readScopeVerdict(args)).some(x => x.startsWith('SCOPE_VERDICT')));
  const not = await mk([run({ output: { text: JSON.stringify(body({ verdict: 'NOT_LOW_RISK' })) } })]).r.readScopeVerdict(args);
  assert.ok(reasons(not).includes('SCOPE_VERDICT_MISMATCH_OR_UNTRUSTED'));
});

test('scope verdict: unpinned or non-independent issuer is refused before any read', async () => {
  for (const [policy, code] of [
    [{ scope_verdict: undefined }, /SCOPE_ISSUER_NOT_PINNED/],
    [{ scope_verdict: { app_id: ISSUER } }, /SCOPE_ISSUER_NOT_PINNED/],
    [{ scope_verdict: { app_id: '11', check_name: NAME } }, /SCOPE_ISSUER_NOT_PINNED/],
    [{ scope_verdict: { app_id: ISSUER, check_name: 'x?y=1' } }, /SCOPE_ISSUER_NOT_PINNED/],
    [{ scope_verdict: { app_id: CONTROLLER, check_name: NAME } }, /SCOPE_ISSUER_NOT_INDEPENDENT/],
  ]) {
    const { r, calls } = mk([run()], { policy });
    await assert.rejects(r.readScopeVerdict(args), code);
    assert.equal(calls.length, 0);
  }
});

test('scope verdict: bad refs or a manifest bound to other SHAs are refused', async () => {
  const { r } = mk([run()]);
  await assert.rejects(r.readScopeVerdict({ ...args, head: 'integration' }), /SCOPE_REF_INVALID/);
  await assert.rejects(r.readScopeVerdict({ ...args, manifest: null }), /SCOPE_MANIFEST_BINDING_INVALID/);
  await assert.rejects(r.readScopeVerdict({ ...args, manifest: { ...manifest, integration_sha: M } }), /SCOPE_MANIFEST_BINDING_INVALID/);
});

test('scope verdict: foreign App, stale SHA, other name, duplicates, truncation are refused', async () => {
  const cases = [
    [[run({ app: { id: CONTROLLER } })], {}, /SCOPE_PROVENANCE_MISMATCH/],
    [[run({ head_sha: M })], {}, /SCOPE_PROVENANCE_MISMATCH/],
    [[run({ name: 'sc-agent/review' })], {}, /SCOPE_PROVENANCE_MISMATCH/],
    [[run(), run({ id: 100 })], {}, /SCOPE_NOT_UNIQUE/],
    [[], {}, /SCOPE_NOT_UNIQUE/],
    [[run()], { total: 2 }, /SCOPE_INCOMPLETE/],
  ];
  for (const [runs, opt, code] of cases) await assert.rejects(mk(runs, opt).r.readScopeVerdict(args), code);
});

test('scope verdict: pending or failing check never becomes a verdict', async () => {
  for (const o of [{ status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'neutral' }, { conclusion: null }]) {
    await assert.rejects(mk([run(o)]).r.readScopeVerdict(args), /SCOPE_NOT_COMPLETED_SUCCESS/);
  }
});

test('scope verdict: body must be exact, bound and known', async () => {
  const text = t => mk([run({ output: { text: t } })]).r.readScopeVerdict(args);
  await assert.rejects(mk([run({ output: null })]).r.readScopeVerdict(args), /SCOPE_OUTPUT_INVALID/);
  await assert.rejects(text('not json'), /SCOPE_OUTPUT_INVALID/);
  await assert.rejects(text('[]'), /SCOPE_OUTPUT_INVALID/);
  await assert.rejects(text('x'.repeat(5000)), /SCOPE_OUTPUT_INVALID/);
  await assert.rejects(text(JSON.stringify({ ...body(), extra: 1 })), /SCOPE_OUTPUT_INVALID/);
  await assert.rejects(text(`{"__proto__":{},${JSON.stringify(body()).slice(1)}`), /SCOPE_OUTPUT_INVALID/);
  await assert.rejects(text(JSON.stringify(body({ schema: 'v0' }))), /SCOPE_OUTPUT_INVALID/);
  for (const o of [{ repository: 'x/y' }, { base_sha: I }, { head_sha: M }, { manifest_hash: sha256({ other: 1 }) }]) {
    await assert.rejects(text(JSON.stringify(body(o))), /SCOPE_BINDING_MISMATCH/);
  }
  await assert.rejects(text(JSON.stringify(body({ verdict: 'PASS' }))), /SCOPE_VERDICT_UNKNOWN/);
});
