import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexEvidenceReader } from '../../tools/agent-pipeline/lib/codex-evidence.mjs';
import { createGitHubClient } from '../../tools/agent-pipeline/lib/github.mjs';

const B = 'b'.repeat(40), I = 'a'.repeat(40);
const RID = 99, R = 'o/r';
const sh = c => c.repeat(40);
const manifestOf = tasks => ({ integration_sha: I, main_sha: B, tasks, commits: tasks.map(t => t.merge_sha) });
const T1 = { task_id: 'T1', head_sha: sh('1'), merge_sha: sh('2') };
const T2 = { task_id: 'T2', head_sha: sh('3'), merge_sha: sh('4') };
const rev = (head, over = {}) => ({ id: 7, user: { id: RID, login: 'codex[bot]' }, commit_id: head, state: 'COMMENTED', body: 'No major issues.', submitted_at: 't', ...over });
const world = (over = {}) => {
  const calls = { reviews: 0 };
  const prs = { 5: { number: 5, merged: true, base: { ref: 'integration', repo: { full_name: R } }, merge_commit_sha: T1.merge_sha },
    6: { number: 6, merged: true, base: { ref: 'integration', repo: { full_name: R } }, merge_commit_sha: T2.merge_sha } };
  const byCommit = { [T1.merge_sha]: [{ number: 5 }], [T2.merge_sha]: [{ number: 6 }] };
  const heads = { 5: T1.head_sha, 6: T2.head_sha };
  const client = {
    readPullsForCommit: async s => over.pulls?.(s) ?? byCommit[s] ?? [],
    readPull: async n => over.pull?.(n, prs[n]) ?? prs[n],
    readCommit: async s => over.commit?.(s) ?? ({ sha: s, parents: [{ sha: s === T1.merge_sha ? sh('9') : sh('8') }, { sha: s === T1.merge_sha ? T1.head_sha : T2.head_sha }] }),
    readReviews: async n => { calls.reviews++; return over.reviews?.(n) ?? [rev(heads[n])]; },
    readReviewThreads: async n => over.threads ? over.threads(n) : [{ isResolved: true }],
  };
  return { calls, read: createCodexEvidenceReader({ client, repository: R, reviewerId: RID }) };
};
const args = (tasks = [T1, T2]) => ({ repository: R, base: B, head: I, manifest: manifestOf(tasks) });

test('multi-PR release: distinct review and merge SHAs, aggregate bound to manifest', async () => {
  const { read, calls } = world();
  const r = await read(args());
  assert.equal(r.complete && r.completed && r.open_findings === 0, true);
  assert.deepEqual(r.covered_commits, [T1.merge_sha, T2.merge_sha]);
  assert.equal(r.entries[0].review_head_sha, T1.head_sha); assert.equal(r.entries[0].merge_commit_sha, T1.merge_sha);
  assert.notEqual(r.entries[0].review_head_sha, r.entries[0].merge_commit_sha);
  assert.equal(calls.reviews, 2);
});
const bad = async (over, code, a = args()) => assert.rejects(world(over).read(a), new RegExp(code));
test('PR confusions and unproven provenance are refused', async () => {
  await bad({ pulls: () => [] }, 'CODEX_PR_AMBIGUOUS');
  await bad({ pulls: () => [{ number: 5 }, { number: 6 }] }, 'CODEX_PR_AMBIGUOUS');
  await bad({ pull: (n, p) => ({ ...p, merged: false }) }, 'CODEX_PR_UNCONFIRMED');
  await bad({ pull: (n, p) => ({ ...p, base: { ref: 'main', repo: { full_name: R } } }) }, 'CODEX_PR_UNCONFIRMED');
  await bad({ pull: (n, p) => ({ ...p, base: { ref: 'integration', repo: { full_name: 'x/y' } } }) }, 'CODEX_PR_UNCONFIRMED');
  await bad({ pull: (n, p) => ({ ...p, merge_commit_sha: sh('f') }) }, 'CODEX_PR_UNCONFIRMED');
  await bad({ commit: s => ({ sha: s, parents: [{ sha: sh('9') }] }) }, 'CODEX_MERGE_PROVENANCE_UNCONFIRMED'); // squash/rebase
});
test('scope gaps and excess are refused', async () => {
  await assert.rejects(world().read({ ...args(), manifest: { ...manifestOf([T1]), commits: [] } }), /CODEX_MERGE_NOT_IN_RELEASE/);
  await assert.rejects(world().read({ ...args(), manifest: manifestOf([]) }), /CODEX_NO_TASKS/);
  await assert.rejects(world().read({ ...args(), head: sh('c') }), /CODEX_MANIFEST_BINDING_INVALID/);
  await assert.rejects(world().read({ ...args(), repository: 'x/y' }), /CODEX_INPUT_INVALID/);
});
test('old, foreign, pending, dismissed, change-requested or empty reviews do not count', async () => {
  await bad({ reviews: n => [rev(sh('0'))] }, 'CODEX_REVIEW_MISSING_FOR_HEAD');                       // old head
  await bad({ reviews: n => [rev(n === 5 ? T1.head_sha : T2.head_sha, { user: { id: 5, login: 'x' } })] }, 'CODEX_REVIEW_MISSING_FOR_HEAD'); // foreign
  await bad({ reviews: n => [rev(n === 5 ? T1.head_sha : T2.head_sha, { state: 'DISMISSED' })] }, 'CODEX_REVIEW_MISSING_FOR_HEAD');
  await bad({ reviews: n => [rev(n === 5 ? T1.head_sha : T2.head_sha, { body: '' })] }, 'CODEX_REVIEW_MISSING_FOR_HEAD'); // bare COMMENTED
  await bad({ reviews: n => [rev(n === 5 ? T1.head_sha : T2.head_sha), rev(n === 5 ? T1.head_sha : T2.head_sha, { id: 8, state: 'CHANGES_REQUESTED' })] }, 'CODEX_REVIEW_STATE_BLOCKS');
  await bad({ reviews: n => [rev(n === 5 ? T1.head_sha : T2.head_sha), rev(n === 5 ? T1.head_sha : T2.head_sha, { id: 9, state: 'PENDING' })] }, 'CODEX_REVIEW_STATE_BLOCKS');
});
test('open findings are counted; unreadable data throws', async () => {
  const r = await world({ threads: () => [{ isResolved: false }, { isResolved: true }] }).read(args());
  assert.equal(r.open_findings, 2);
  await bad({ threads: () => null }, 'CODEX_DATA_INCOMPLETE');
});
test('reviewer id must be pinned', () => {
  assert.throws(() => createCodexEvidenceReader({ client: {}, repository: R, reviewerId: 1 }), /CODEX_CLIENT_INVALID/);
  const { } = world();
  assert.throws(() => createCodexEvidenceReader({ client: { readPullsForCommit() {}, readPull() {}, readCommit() {}, readReviews() {}, readReviewThreads() {} }, repository: R, reviewerId: 'x' }), /CODEX_CONFIG_INVALID/);
});

// GraphQL: only the fixed read-only query; pagination must be complete.
const gh = responses => {
  const sent = [];
  const fetch = async (url, o) => { sent.push({ url, method: o.method, body: o.body ? JSON.parse(o.body) : null });
    const text = JSON.stringify(responses.shift()); return { ok: true, status: 200, headers: new Map(), text: async () => text }; };
  return { sent, client: createGitHubClient({ fetch, token: 't', repository: R, sleep: async () => {} }) };
};
const page = (nodes, next) => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } } } } });
test('review threads: full pagination with the single fixed query', async () => {
  const { client, sent } = gh([page([{ isResolved: true }], 'c1'), page([{ isResolved: false }])]);
  const t = await client.readReviewThreads(5);
  assert.equal(t.length, 2);
  assert.ok(sent.every(x => x.url.endsWith('/graphql') && x.method === 'POST' && /^query\(/.test(x.body.query) && !/mutation/.test(x.body.query)));
  assert.equal(new Set(sent.map(x => x.body.query)).size, 1);
});
test('review threads: errors, loops and bad numbers are refused', async () => {
  await assert.rejects(gh([{ errors: [{ message: 'x' }] }]).client.readReviewThreads(5), /REVIEW_THREADS_INCOMPLETE/);
  await assert.rejects(gh([page([], 'c'), page([], 'c')]).client.readReviewThreads(5), /REVIEW_THREADS_CURSOR_LOOP/);
  await assert.rejects(gh([]).client.readReviewThreads('5; mutation'), /PR_NUMBER_INVALID/);
});
import { readFileSync } from 'node:fs';
test('github client defines readReviewThreads exactly once and the query keeps id + isResolved + isOutdated', async () => {
  const src = readFileSync(new URL('../../tools/agent-pipeline/lib/github.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/async readReviewThreads\(/g) ?? []).length, 1);
  const { client, sent } = gh([page([{ id: 'T', isResolved: true, isOutdated: false }])]);
  await client.readReviewThreads('5');
  assert.match(sent[0].body.query, /nodes\{id isResolved isOutdated\}/);
});
