// SC-AUTO-RELEASE (#369) stage 4g: released ledger reader (read-only, exact SHAs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoReleaseReaders } from '../../tools/agent-pipeline/lib/auto-release-readers.mjs';

const I = 'a'.repeat(40), M = 'b'.repeat(40), X = 'c'.repeat(40);
const cmp = (o = {}) => ({ status: 'ahead', ahead_by: 3, behind_by: 0, base_commit: { sha: M }, merge_base_commit: { sha: M }, ...o });
const mk = response => {
  const calls = [];
  const client = {
    request: async (p, o) => { calls.push([o?.method ?? 'GET', p]); return typeof response === 'function' ? response(p) : response; },
    readBranch: async () => ({ commit: { sha: I } }), readComparison: async () => ({}), readReleasePlan: async () => null,
  };
  return { calls, r: createAutoReleaseReaders({ client, repository: 'o/r', policy: {} }) };
};

test('candidate not yet in main is not released; one GET bound to both SHAs', async () => {
  const { r, calls } = mk(cmp());
  assert.deepEqual(await r.readReleased({ base: M, head: I }), []);
  assert.deepEqual(calls, [['GET', `/repos/o/r/compare/${M}...${I}?per_page=1`]]);
  assert.deepEqual(await mk(cmp({ status: 'diverged', behind_by: 2 })).r.readReleased({ base: M, head: I }), []);
});
test('candidate reachable from main is already released', async () => {
  assert.deepEqual(await mk(cmp({ status: 'behind', ahead_by: 0, behind_by: 4, merge_base_commit: { sha: I } })).r.readReleased({ base: M, head: I }), [I]);
  assert.deepEqual(await mk(cmp({ status: 'identical', ahead_by: 0, behind_by: 0, base_commit: { sha: I }, merge_base_commit: { sha: I } })).r.readReleased({ base: I, head: I }), [I]);
});
test('invalid refs are refused before any request', async () => {
  const { r, calls } = mk(cmp());
  for (const args of [undefined, {}, { base: 'main', head: I }, { base: M, head: 'integration' }, { base: M, head: I.slice(1) }]) {
    await assert.rejects(r.readReleased(args), /RELEASED_REF_INVALID/);
  }
  assert.equal(calls.length, 0);
});
test('malformed, inconsistent or foreign comparisons throw (collector => DENY)', async () => {
  const bad = [
    [null, /RELEASED_UNREADABLE/],
    [cmp({ ahead_by: -1 }), /RELEASED_UNREADABLE/],
    [cmp({ behind_by: '0' }), /RELEASED_UNREADABLE/],
    [cmp({ ahead_by: 1.5 }), /RELEASED_UNREADABLE/],
    [cmp({ base_commit: { sha: X } }), /RELEASED_BINDING_MISMATCH/],
    [cmp({ base_commit: undefined }), /RELEASED_BINDING_MISMATCH/],
    [cmp({ status: 'unknown' }), /RELEASED_STATUS_INCONSISTENT/],
    [cmp({ status: 'toString' }), /RELEASED_STATUS_INCONSISTENT/],
    [cmp({ status: 'ahead', ahead_by: 0 }), /RELEASED_STATUS_INCONSISTENT/],
    [cmp({ status: 'identical', ahead_by: 1 }), /RELEASED_STATUS_INCONSISTENT/],
    [cmp({ status: 'behind', ahead_by: 0, behind_by: 0 }), /RELEASED_STATUS_INCONSISTENT/],
    [cmp({ status: 'diverged', behind_by: 0 }), /RELEASED_STATUS_INCONSISTENT/],
    // "behind" but the merge base is not the candidate: the response is about other commits.
    [cmp({ status: 'behind', ahead_by: 0, behind_by: 1, merge_base_commit: { sha: X } }), /RELEASED_BINDING_MISMATCH/],
    [cmp({ status: 'behind', ahead_by: 0, behind_by: 1, merge_base_commit: undefined }), /RELEASED_BINDING_MISMATCH/],
  ];
  for (const [res, re] of bad) await assert.rejects(mk(res).r.readReleased({ base: M, head: I }), re);
});
test('request failure propagates (never treated as "not released")', async () => {
  await assert.rejects(mk(() => { throw new Error('http_500'); }).r.readReleased({ base: M, head: I }), /http_500/);
});
