import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../../tools/agent-pipeline/feedback-cli.mjs';

const REPOSITORY = 'krzysztofsyska/skillcheck-core';
const ROOT = `/repos/${REPOSITORY}`;
const ORIGIN = 'a'.repeat(40);
const BASELINE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);

// Exercise the real readSnapshot adapter, not a hand-built snapshot supplied
// directly to the planner. Every provider operation in this fixture is a read.
function world({ comparisonBase = BASELINE, fullFilePages = false, managed = false, unchanged = false } = {}) {
  const binding = { pr: 49, agentId: 'bc-snapshot-test', branch: 'chore/cost-probe-test',
    originIntegration: ORIGIN, initialHead: BASELINE };
  const currentHead = unchanged ? BASELINE : HEAD;
  const requests = [];
  const pull = { number: 49, head: { sha: currentHead }, base: { sha: BASE } };
  const github = {
    readPull: async pr => { assert.equal(pr, binding.pr); return pull; },
    readChangedFiles: async (base, head) => {
      assert.equal(base, BASE); assert.equal(head, currentHead);
      return ['docs/cost-probe-test.md'];
    },
    readProjection: async () => ({ tasks: managed ? { task: { pr_number: 49 } } : {} }),
    request: async (path, options) => {
      assert.ok(!options?.method || options.method === 'GET', 'No mutation is allowed');
      requests.push(path);
      if (path === `${ROOT}/pulls/49/reviews?per_page=100&page=1`
          || path === `${ROOT}/pulls/49/comments?per_page=100&page=1`) return [];
      if (path === `${ROOT}/compare/${ORIGIN}...${BASELINE}`
          || path === `${ROOT}/compare/${BASELINE}...${currentHead}`) return { status: 'ahead' };
      if (path === `${ROOT}/compare/${BASELINE}...${HEAD}?per_page=100`) {
        return { status: 'ahead', base_commit: { sha: comparisonBase }, total_commits: 1, commits: [{ sha: HEAD }] };
      }
      if (path.startsWith(`${ROOT}/commits/${HEAD}?per_page=100&page=`)) {
        const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
        assert.ok(page >= 1 && page <= 3);
        return { sha: HEAD, files: fullFilePages
          ? Array.from({ length: 100 }, (_, i) => ({ filename: `docs/page-${page}-${i}.md` }))
          : [{ filename: 'docs/cost-probe-test.md' }] };
      }
      throw new Error(`Unexpected read: ${path}`);
    },
  };
  const cursor = {
    getAgent: async id => { assert.equal(id, binding.agentId); return { id }; },
    getRun: async (id, runId) => {
      assert.equal(id, binding.agentId); assert.equal(runId, 'reserved-run');
      return { id: runId, agentId: id, status: 'FINISHED' };
    },
  };
  return { github, cursor, binding, requests };
}

for (const phase of ['COST_PROBE_CURSOR_DONE', 'COST_PROBE_REVIEW_PENDING']) {
  test(`${phase}: uses the saved pilot baseline without repairHead`, async () => {
    const w = world();
    const state = { phase, baselineHead: BASELINE, runId: 'reserved-run' };
    assert.equal(state.repairHead, undefined);
    const snapshot = await readSnapshot(w.github, w.cursor, w.binding, state);
    assert.equal(snapshot.repair.base, BASELINE);
    assert.equal(snapshot.repair.head, HEAD);
    assert.equal(snapshot.repair.complete, true);
    assert.equal(snapshot.repair.commits.length, 1);
    assert.deepEqual(snapshot.repair.commits[0].files, [{ filename: 'docs/cost-probe-test.md' }]);
  });
}

for (const phase of ['FIXING', 'REVIEW_PENDING']) {
  test(`${phase}: preserves ordinary repair ancestry checks`, async () => {
    const w = world();
    const snapshot = await readSnapshot(w.github, w.cursor, w.binding,
      { phase, repairHead: BASELINE, runId: 'reserved-run' });
    assert.equal(snapshot.repair.base, BASELINE);
    assert.equal(snapshot.repair.complete, true);
    assert.equal(snapshot.repair.commits.length, 1);
  });
}

for (const phase of ['COST_PROBE_CURSOR_DONE', 'REVIEW_PENDING']) {
  test(`${phase}: rejects a comparison for the wrong base`, async () => {
    const w = world({ comparisonBase: OTHER });
    const state = phase.startsWith('COST_PROBE_')
      ? { phase, baselineHead: BASELINE, runId: 'reserved-run' }
      : { phase, repairHead: BASELINE, runId: 'reserved-run' };
    const snapshot = await readSnapshot(w.github, w.cursor, w.binding, state);
    assert.equal(snapshot.repair.complete, false);
    assert.deepEqual(snapshot.repair.commits, []);
    assert.equal(w.requests.some(path => path.includes('/commits/')), false);
  });
}

test('pilot does not accept a conflicting legacy repairHead as its baseline', async () => {
  const w = world({ comparisonBase: OTHER });
  const snapshot = await readSnapshot(w.github, w.cursor, w.binding,
    { phase: 'COST_PROBE_CURSOR_DONE', baselineHead: BASELINE, repairHead: OTHER, runId: 'reserved-run' });
  assert.equal(snapshot.repair.base, BASELINE);
  assert.equal(snapshot.repair.complete, false);
  assert.deepEqual(snapshot.repair.commits, []);
});

test('commit-file pagination still refuses an unproven three-full-page list', async () => {
  const w = world({ fullFilePages: true });
  const snapshot = await readSnapshot(w.github, w.cursor, w.binding,
    { phase: 'FIXING', repairHead: BASELINE, runId: 'reserved-run' });
  assert.equal(snapshot.repair.complete, true);
  assert.equal(snapshot.repair.commits[0].files, null);
  assert.equal(w.requests.filter(path => path.includes('/commits/')).length, 3);
});

test('controller-owned PR is still rejected before gathering repair evidence', async () => {
  const w = world({ managed: true });
  await assert.rejects(readSnapshot(w.github, w.cursor, w.binding,
    { phase: 'COST_PROBE_CURSOR_DONE', baselineHead: BASELINE, runId: 'reserved-run' }), /MANAGED_BY_CONTROLLER/);
  assert.equal(w.requests.some(path => path.endsWith('?per_page=100')), false);
});

test('unchanged pilot head never manufactures a repair proof', async () => {
  const w = world({ unchanged: true });
  const snapshot = await readSnapshot(w.github, w.cursor, w.binding,
    { phase: 'COST_PROBE_CURSOR_DONE', baselineHead: BASELINE, runId: 'reserved-run' });
  assert.equal(snapshot.repair, null);
  assert.equal(w.requests.some(path => path.includes('/commits/')), false);
});
