import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { assembleWork } from '../../tools/agent-pipeline/lib/snapshot.mjs';
import { reconcileFromEnv } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { createGitHubClient } from '../../tools/agent-pipeline/lib/github.mjs';
import { taskRecord, observation, contractBody, NEXT_HEAD, BASE } from './helpers.mjs';
import { httpWorld } from './http-world.mjs';

test('new head outside scope is blocked before review, including renamed source', async () => {
  const record = taskRecord({ state: 'READY_FOR_OWNER' });
  const obs = observation();
  obs.github.branch = { name: record.binding.branch, repositoryId: record.repository_id, sha: NEXT_HEAD, files: ['app/demo/page.tsx', 'lib/forbidden.ts'] };
  assert.equal(plan(record, obs).record.blocked_reason, 'SCOPE_VIOLATION');
  const github = createGitHubClient({ token: 'fixture', repository: 'o/r', fetch: async () => new Response(JSON.stringify({ files: [{ filename: 'app/demo/page.tsx', previous_filename: 'lib/forbidden.ts', status: 'renamed' }] })) });
  assert.deepEqual(await github.readChangedFiles(BASE, NEXT_HEAD), ['app/demo/page.tsx', 'lib/forbidden.ts']);
});

test('duplicate TASK in unauthorized Issue cannot shadow journal Issue', () => {
  const record = taskRecord({ state: 'PR_REVIEW' }), obs = observation();
  const fake = { number: 999, body: contractBody() + '\nmalicious edit', user: { id: 999 } };
  const real = { number: record.issue_number, body: contractBody(), user: { id: obs.policy.owner.id } };
  const work = assembleWork({ policy: obs.policy, policySha: obs.policySha, now: obs.now, secrets: {}, snapshot: { records: { [record.task_id]: record }, issues: [fake, real], pulls: [] } });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].observation.issue.number, record.issue_number);
  assert.equal(plan(record, { ...obs, issue: null }).record.blocked_reason, 'TASK_ISSUE_MISSING');
});

test('approval rerun allocates fresh request ID and cannot reuse prior run', async () => {
  const w = httpWorld(), previous = globalThis.fetch; globalThis.fetch = w.fetch;
  const advance = () => reconcileFromEnv(w.env, { policy: w.policy });
  const task = () => Object.values(w.projection()).find(r => r.task_id === 'SC-DEMO-001');
  try {
    for (let i = 0; i < 70 && !task()?.binding.approval?.run_id; i++) await advance();
    const original = task().binding.approval;
    w.runs.find(r => r.id === original.run_id).run_attempt = 2;
    for (let i = 0; i < 8 && (!task().binding.approval?.run_id || task().binding.approval.request_id === original.request_id); i++) await advance();
    assert.notEqual(task().binding.approval.request_id, original.request_id);
    assert.notEqual(task().binding.approval.run_id, original.run_id);
    assert.equal(w.mergeCount, 0);
  } finally { globalThis.fetch = previous; }
});

test('malformed completed review terminates BLOCKED rather than endless PR_REVIEW', async () => {
  const w = httpWorld(), previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await w.fetch(url, options);
    for (const artifact of Object.values(w.artifacts)) if (artifact.payload) artifact.payload.extra = 'invalid';
    return response;
  };
  try {
    let record;
    for (let i = 0; i < 35 && record?.state !== 'BLOCKED'; i++) {
      await reconcileFromEnv(w.env, { policy: w.policy }); record = Object.values(w.projection())[0];
    }
    assert.equal(record.blocked_reason, 'EVIDENCE_REJECTED');
    assert.equal(w.mergeCount, 0);
  } finally { globalThis.fetch = previous; }
});

test('lost promotion PR response is adopted once before CI/review dispatch', async () => {
  const w = httpWorld(), previous = globalThis.fetch;
  let lost = false;
  globalThis.fetch = async (url, options = {}) => {
    const response = await w.fetch(url, options);
    if (!lost && options.method === 'POST' && new URL(url).pathname.endsWith('/pulls') && JSON.parse(options.body).base === 'main') { lost = true; throw new Error('lost accepted PR response'); }
    return response;
  };
  w.approveA = true; w.env.AGENT_PIPELINE_MERGE_ENABLED = 'true';
  try {
    let promotion;
    for (let i = 0; i < 100 && !promotion?.binding.approval?.run_id; i++) {
      await reconcileFromEnv(w.env, { policy: w.policy }); promotion = Object.values(w.projection()).find(r => r.binding.lane === 'promotion');
    }
    assert.equal(lost, true);
    assert.equal(promotion.state, 'READY_FOR_PROD');
    assert.equal(promotion.pr_number, 51);
    assert.equal(w.pulls.filter(p => p.base.ref === 'main').length, 1);
    assert.equal(w.mergeCount, 1);
  } finally { globalThis.fetch = previous; }
});

test('409 create recovery GET verifies immutable agent target before adoption', async () => {
  const w = httpWorld(), previous = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const response = await w.fetch(url, options);
    if (url === 'https://api.cursor.com/v1/agents' && options.method === 'POST') {
      posts++; w.cursor.repos[0].startingRef = 'main';
      return new Response(JSON.stringify({ code: 'exists', agent: w.cursor }), { status: 409 });
    }
    return response;
  };
  try {
    let record;
    for (let i = 0; i < 8 && record?.state !== 'BLOCKED'; i++) { await reconcileFromEnv(w.env, { policy: w.policy }); record = Object.values(w.projection())[0]; }
    assert.equal(record.state, 'BLOCKED');
    assert.equal(record.blocked_reason, 'DISPATCH_UNKNOWN');
    assert.equal(posts, 1);
    assert.equal(w.mergeCount, 0);
  } finally { globalThis.fetch = previous; }
});

test('failed promotion review never opens gate B or dispatches Cursor', async () => {
  for (const verdict of ['FAIL', 'PASS_WITH_FIXES', 'CI_FAILURE']) {
    const w = httpWorld(), previous = globalThis.fetch;
    w.approveA = true; w.env.AGENT_PIPELINE_MERGE_ENABLED = 'true';
    globalThis.fetch = async (url, options = {}) => {
      const response = await w.fetch(url, options);
      if (w.pulls.some(p => p.base.ref === 'main')) {
        for (const run of w.runs) {
          const artifact = w.artifacts[run.id];
          if (artifact?.payload?.pr_number === 51 && verdict !== 'CI_FAILURE') artifact.payload.verdict = verdict;
          if (artifact?.head_sha === w.branches.integration && run.path.includes('verify') && verdict === 'CI_FAILURE') run.conclusion = 'failure';
        }
      }
      return response;
    };
    try {
      let promotion;
      for (let i = 0; i < 100 && promotion?.state !== 'BLOCKED'; i++) { await reconcileFromEnv(w.env, { policy: w.policy }); promotion = Object.values(w.projection()).find(r => r.binding.lane === 'promotion'); }
      assert.equal(promotion.blocked_reason, 'PROMOTION_REVIEW_FAILED', verdict);
      assert.equal(w.runs.some(r => r.workflow_id === w.policy.workflow_ids.promote), false);
      assert.equal(w.mergeCount, 1);
      assert.equal(w.repair, 1);
    } finally { globalThis.fetch = previous; }
  }
});

test('changed head invalidates and cancels the old pending approval', async () => {
  const w = httpWorld(), previous = globalThis.fetch; globalThis.fetch = w.fetch;
  const advance = () => reconcileFromEnv(w.env, { policy: w.policy });
  const task = () => Object.values(w.projection()).find(r => r.task_id === 'SC-DEMO-001');
  try {
    for (let i = 0; i < 70 && !task()?.binding.approval?.run_id; i++) await advance();
    const runId = task().binding.approval.run_id;
    w.branches[w.branch] = 'f'.repeat(40); w.pulls[0].head.sha = w.branches[w.branch];
    await advance();
    assert.equal(task().binding.approval, null);
    assert.equal(w.runs.find(r => r.id === runId).conclusion, 'cancelled');
    assert.equal(w.calls.filter(c => c.url.endsWith(`/runs/${runId}/cancel`) && c.method === 'POST').length, 1);
    assert.equal(w.mergeCount, 0);
  } finally { globalThis.fetch = previous; }
});

test('BLOCKED supersedes undelivered READY notification before approval run adoption', async () => {
  const w = httpWorld(), previous = globalThis.fetch;
  let outOfScope = false;
  globalThis.fetch = async (url, options = {}) => {
    if (outOfScope && new URL(url).pathname.includes('/compare/')) return new Response(JSON.stringify({ files: [{ filename: 'lib/forbidden.ts' }] }));
    return w.fetch(url, options);
  };
  const task = () => Object.values(w.projection()).find(r => r.task_id === 'SC-DEMO-001');
  try {
    for (let i = 0; i < 70 && task()?.state !== 'READY_FOR_OWNER'; i++) await reconcileFromEnv(w.env, { policy: w.policy });
    assert.equal(task().binding.approval.run_id, null);
    assert.equal(task().binding.pending_notification.kind, 'READY_FOR_OWNER');
    outOfScope = true;
    await reconcileFromEnv(w.env, { policy: w.policy });
    assert.equal(task().state, 'BLOCKED');
    assert.equal(task().binding.last_notified_state, 'BLOCKED');
    assert.equal(task().binding.pending_notification, null);
    assert.equal(w.comments.length, 1);
    assert.match(w.comments[0].body, /BLOCKED/);
    assert.match(w.comments[0].body, /SCOPE_VIOLATION/);
    assert.doesNotMatch(w.comments[0].body, /action: https.*actions\/runs/);
  } finally { globalThis.fetch = previous; }
});
