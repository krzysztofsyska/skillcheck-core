import test from 'node:test';
import assert from 'node:assert/strict';
import { controlPlane, assertPolicyExecution, assertControlEffect, workflowRef } from '../../tools/agent-pipeline/lib/control-plane.mjs';
import { findRun } from '../../tools/agent-pipeline/lib/evidence.mjs';
import { createGitHubClient } from '../../tools/agent-pipeline/lib/github.mjs';
import { loadWorkFromClients, reconcileFromEnv, defaultPorts } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { guardedMerge, publishEvidence, drainOutbox, cancelStaleApprovals } from '../../tools/agent-pipeline/lib/live-effects.mjs';
import { createMemoryJournal } from '../../tools/agent-pipeline/lib/controller.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';
import { evaluatePreflight, decideMerge } from '../../tools/agent-pipeline/lib/merge.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { guardEffects } from '../../tools/agent-pipeline/lib/controller.mjs';
import { buildCreatePayload } from '../../tools/agent-pipeline/lib/cursor.mjs';
import { observation, taskRecord, contractBody } from './helpers.mjs';
import { httpWorld, CONTROL, MAIN, BASE } from './http-world.mjs';

const operational = () => ({ ...observation().policy, control_plane: { branch: 'agent-control-runtime', mode: 'integration-only' } });

test('control source accepts only the two explicit branch/mode combinations', () => {
  assert.deepEqual(controlPlane({}), { branch: 'main', mode: 'full' });
  assert.equal(controlPlane(operational()).branch, 'agent-control-runtime');
  for (const descriptor of [null, {}, { branch: 'integration', mode: 'integration-only' },
    { branch: 'agent-control-runtime', mode: 'full' }, { branch: 'main', mode: 'integration-only' },
    { branch: 'agent-control-runtime', mode: 'integration-only', extra: true }]) {
    assert.throws(() => controlPlane({ control_plane: descriptor }), /CONTROL_PLANE_INVALID/);
  }
  assert.equal(workflowRef(operational(), 'review'), 'agent-control-runtime');
  assert.equal(workflowRef(operational(), 'promote'), 'main');
});

test('workflow authorization binds repository, ref, workflow SHA and the current control head', async () => {
  const policy = operational();
  const env = { GITHUB_REPOSITORY: policy.repository, GITHUB_REF: 'refs/heads/agent-control-runtime', GITHUB_SHA: CONTROL };
  const github = { async readBranch(branch) { assert.equal(branch, 'agent-control-runtime'); return { commit: { sha: CONTROL } }; } };
  assert.equal(await assertPolicyExecution({ policy, github, env, policySha: CONTROL }), CONTROL);
  for (const change of [e => { e.GITHUB_REF = 'refs/heads/main'; }, e => { e.GITHUB_REF = 'refs/heads/integration'; },
    e => { e.GITHUB_REF = 'refs/heads/task'; }, e => { e.GITHUB_REPOSITORY = 'other/repo'; }, e => { e.GITHUB_SHA = MAIN; }]) {
    const altered = { ...env }; change(altered);
    await assert.rejects(assertPolicyExecution({ policy, github, env: altered, policySha: CONTROL }), /CONTROL_SOURCE_UNTRUSTED/);
  }
  await assert.rejects(assertPolicyExecution({ policy, github, env, policySha: MAIN }), /CONTROL_SOURCE_UNTRUSTED/);
  await assert.rejects(assertPolicyExecution({ policy, env, policySha: CONTROL,
    github: { async readBranch() { return { commit: { sha: MAIN } }; } } }), /POLICY_STALE/);
});

test('work observation keeps production SHA distinct from the control policy revision', async () => {
  const policy = operational();
  const github = {
    async readBranch(branch) { return { commit: { sha: { main: MAIN, integration: BASE, 'agent-control-runtime': CONTROL }[branch] } }; },
    async readIssues() { return [{ number: 21, user: { id: policy.owner.id }, body: contractBody() }]; },
    async readPulls() { return []; }, async readProjection() { return { tasks: {} }; },
    async readProtection() { return null; }, async readRepository() { return { id: policy.repository_id }; },
    async readComparison() { throw new Error('production comparison must not run'); },
  };
  const work = await loadWorkFromClients({ github, policy, policyCommit: CONTROL, now: '2026-11-09T00:00:00Z', secrets: {} });
  assert.equal(work.mainSha, MAIN);
  assert.equal(work.items[0].observation.policySha, CONTROL);
  await assert.rejects(loadWorkFromClients({ github, policy, policyCommit: MAIN }), /POLICY_STALE/);
});

test('review provenance requires the control branch, actor, workflow and exact attempt', async () => {
  const policy = operational();
  const run = { id: 30, workflow_id: policy.workflow_ids.review, path: policy.workflows.review,
    event: 'workflow_dispatch', head_branch: 'agent-control-runtime', head_sha: CONTROL,
    actor: { id: policy.controller_actor_id }, display_title: 'sc-agent:request', run_attempt: 1 };
  const github = { async readRun() { return run; } };
  assert.equal((await findRun(github, policy, 'review', 'request', 30)).id, 30);
  for (const change of [r => { r.head_branch = 'main'; }, r => { r.head_branch = 'integration'; },
    r => { r.actor = { id: policy.owner.id }; }, r => { r.workflow_id++; }, r => { r.path = 'other.yml'; }]) {
    const altered = structuredClone(run); change(altered);
    assert.equal(await findRun({ async readRun() { return altered; } }, policy, 'review', 'request', 30), null);
  }
  assert.equal(await findRun({ async readRun() { throw new Error('must not read approval'); } }, policy, 'promote', 'request', 30), null);
});

test('operational state and effect boundaries refuse production including inherited records', async () => {
  const policy = operational();
  const obs = { ...observation(), policy, simulation: true, kind: 'promotion' };
  assert.deepEqual(plan(null, obs).effects, []);
  for (const mutate of [r => { r.binding.lane = 'promotion'; }, r => { r.binding.approval = { gate: 'B' }; },
    r => { r.binding.merge = { gate: 'B', phase: 'awaiting_confirmation' }; }]) {
    const record = taskRecord(); mutate(record);
    const result = plan(record, { ...obs, kind: 'task' });
    assert.equal(result.record.blocked_reason, 'PRODUCTION_DISABLED_FOR_CONTROL_PLANE');
    assert.deepEqual(result.effects, []);
  }
  const forbidden = [
    { type: 'github.createPr', base: 'main' },
    { type: 'github.dispatch', workflow: 'promote' },
    { type: 'github.dispatch', workflow: 'accept' },
    { type: 'github.merge', gate: 'B', record: taskRecord() },
    { type: 'github.merge', gate: 'A', record: { binding: { lane: 'promotion' } } },
  ];
  for (const effect of forbidden) {
    assert.throws(() => assertControlEffect(policy, effect), /PRODUCTION_DISABLED/);
    assert.equal(guardEffects([{ ...effect, external: true }], obs).allowed.length, 0);
  }
  await assert.rejects(guardedMerge({ policy, effect: forbidden[3], flags: { enabled: true, mergeEnabled: true },
    journal: { async assertOwned() { throw new Error('must not reach journal'); } } }), /PRODUCTION_DISABLED/);
  assert.equal(decideMerge({ protection: { controlPlaneMode: 'integration-only' }, gate: 'B' }).reason, 'PRODUCTION_DISABLED_FOR_CONTROL_PLANE');
});

test('low-level GitHub adapter cannot create, dispatch or merge a production operation', async () => {
  const policy = operational(); const writes = [];
  const github = createGitHubClient({ token: 'synthetic', repository: policy.repository, policy,
    async fetch(url, options = {}) {
      if ((options.method ?? 'GET') !== 'GET') writes.push(url);
      return new Response(JSON.stringify({ base: { ref: 'main', repo: { id: policy.repository_id } } }), { status: 200 });
    } });
  await assert.rejects(github.createPull({ head: 'integration', base: 'main' }), /PRODUCTION_DISABLED/);
  await assert.rejects(github.dispatch({ workflow: 'agent-promote.yml', inputs: {}, ref: 'main' }), /PRODUCTION_DISABLED/);
  await assert.rejects(github.dispatch({ workflow: 'agent-review.yml', inputs: {}, ref: 'integration' }), /PRODUCTION_DISABLED/);
  await assert.rejects(github.merge({ prNumber: 266, sha: MAIN }), /PRODUCTION_DISABLED/);
  assert.deepEqual(writes, []);
});

test('operational preflight requires exact runtime protections and isolated environments', () => {
  const w = httpWorld({ operational: true });
  const assess = () => protectionFromRulesets(w.protection.rules, w.policy, w.protection.environments);
  assert.equal(evaluatePreflight(assess()).ok, true);
  for (const name of ['agent-control', 'agent-review']) {
    const e = w.protection.environments[name]; const saved = structuredClone(e);
    for (const change of [x => { x.branch_policies[0].name = 'main'; },
      x => { x.branch_policies.push({ name: 'integration', type: 'branch' }); }, x => { x.id++; }]) {
      change(e); assert.equal(evaluatePreflight(assess()).ok, false); Object.assign(e, structuredClone(saved));
    }
  }
  const rule = w.protection.rules.find(r => r.name === 'quality-gates' && r.conditions.ref_name.include.includes('refs/heads/agent-control-runtime'));
  rule.bypass_actors = [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }];
  assert.equal(evaluatePreflight(assess()).ok, false);
  delete rule.bypass_actors;
  assert.equal(evaluatePreflight(assess()).ok, false, 'hidden bypass is never inferred empty');
});

test('a control branch move before an effect prevents dispatch', async () => {
  const w = httpWorld({ operational: true }); const original = globalThis.fetch;
  globalThis.fetch = w.fetch;
  try {
    const ports = await defaultPorts(w.env, w.policy, { ok: true }, { enabled: true });
    w.branches['agent-control-runtime'] = MAIN;
    const before = w.calls.length;
    await assert.rejects(ports.execute({ type: 'github.dispatch', workflow: 'review', requestId: 'r' }), /POLICY_STALE/);
    assert.equal(w.calls.slice(before).some(c => c.method !== 'GET'), false);
  } finally { globalThis.fetch = original; }
});

test('a control move after loadWork blocks post-tick checks even when no effect is planned', async () => {
  const w = httpWorld({ operational: true }); const original = globalThis.fetch;
  globalThis.fetch = w.fetch;
  const task = () => Object.values(w.projection()).find(r => r.task_id === 'SC-DEMO-001');
  const completedReview = () => w.runs.find(r => r.path === w.policy.workflows.review
    && w.artifacts[r.id]?.payload?.request_id === task()?.review_request_id
    && w.artifacts[r.id]?.payload?.verdict === 'PASS');
  try {
    for (let i = 0; i < 60 && !completedReview(); i++) await reconcileFromEnv(w.env, { policy: w.policy });
    assert.ok(completedReview(), 'repair and fresh review completed');
    assert.equal(task().review_run_id, null, 'next tick adopts the review without a dispatch');
    const before = w.checks.length;
    let moved = false;
    globalThis.fetch = async (url, options) => {
      const response = await w.fetch(url, options);
      if (!moved && new URL(url).pathname.endsWith('/branches/agent-control-runtime')) {
        moved = true; w.branches['agent-control-runtime'] = MAIN;
      }
      return response;
    };
    await assert.rejects(reconcileFromEnv(w.env, { policy: w.policy }), /POLICY_STALE/);
    assert.equal(moved, true);
    assert.equal(w.checks.length, before, 'no stale CI/review publication');
    assert.equal(w.mergeCount, 0);
  } finally { globalThis.fetch = original; }
});

test('source revision is checked before each check, not once per publication batch', async () => {
  let live = CONTROL;
  const checks = [];
  const github = {
    async readBranch() { return { commit: { sha: live } }; },
    async publishCheck(check) { checks.push(check); live = MAIN; },
  };
  const record = taskRecord({ review_request_id: 'r' });
  await assert.rejects(publishEvidence(github, operational(), record, { ci: {}, review: {} }, CONTROL), /POLICY_STALE/);
  assert.equal(checks.length, 1, 'the second check must not be published by the retired source');
});

test('outbox rechecks executing SHA after reads and never sends from a retired source', async () => {
  for (const existingComment of [false, true]) {
    let live = CONTROL;
    const sent = [];
    const record = taskRecord({ state: 'BLOCKED', issue_number: 7, policy_sha: MAIN });
    const github = {
      async readBranch() { return { commit: { sha: live } }; },
      async readComments() {
        live = MAIN;
        return existingComment ? [{ id: 1, user: { id: operational().controller_actor_id }, body: `skillcheck-report:${record.task_id}` }] : [];
      },
      async comment(value) { sent.push(value); },
      async updateComment(...value) { sent.push(value); },
    };
    await assert.rejects(drainOutbox({ github, journal: createMemoryJournal(), policy: operational(),
      policySha: CONTROL, record, now: '2026-11-09T00:00:00Z' }), /POLICY_STALE/);
    assert.deepEqual(sent, []);
  }
});

test('a current executor can report stale task records without trusting their policy SHA', async () => {
  const comments = [];
  const github = {
    async readBranch() { return { commit: { sha: CONTROL } }; },
    async readComments() { return []; },
    async comment(value) { comments.push(value); },
  };
  const record = taskRecord({ state: 'BLOCKED', issue_number: 7, policy_sha: MAIN });
  const result = await drainOutbox({ github, journal: createMemoryJournal(), policy: operational(),
    policySha: CONTROL, record, now: '2026-11-09T00:00:00Z' });
  assert.equal(comments.length, 1);
  assert.equal(result.binding.last_notified_state, 'BLOCKED');
  await assert.rejects(drainOutbox({ github, journal: createMemoryJournal(), policy: operational(),
    record, now: '2026-11-09T00:00:00Z' }), /POLICY_COMMIT_MISSING/);
});

test('stale approval cleanup rejects a source move before cancellation', async () => {
  const policy = observation().policy;
  let live = MAIN; const cancelled = [];
  const record = taskRecord();
  record.binding.stale_approvals = [{ gate: 'A', request_id: 'old', run_id: 30, policy_sha: BASE, cancel_attempts: 0 }];
  const github = {
    async readBranch() { return { commit: { sha: live } }; },
    async readRun() {
      live = CONTROL;
      return { id: 30, workflow_id: policy.workflow_ids.accept, path: policy.workflows.accept,
        event: 'workflow_dispatch', head_branch: 'main', head_sha: BASE,
        actor: { id: policy.controller_actor_id }, display_title: 'sc-agent:old', run_attempt: 1, status: 'waiting' };
    },
    async cancelRun(id) { cancelled.push(id); },
  };
  await assert.rejects(cancelStaleApprovals({ github, journal: createMemoryJournal(), policy,
    policySha: MAIN, record, now: '2026-11-09T00:00:00Z' }), /POLICY_STALE/);
  assert.deepEqual(cancelled, []);
});

test('operational HTTP cycle builds, repairs, reviews, merges integration and advances without touching main', async () => {
  const w = httpWorld({ operational: true }); const original = globalThis.fetch;
  w.env.AGENT_PIPELINE_MERGE_ENABLED = 'true';
  globalThis.fetch = w.fetch;
  const task = () => Object.values(w.projection()).find(r => r.task_id === 'SC-DEMO-001');
  try {
    for (let i = 0; i < 100 && task()?.state !== 'ACCEPTED'; i++) await reconcileFromEnv(w.env, { policy: w.policy });
    assert.equal(task()?.state, 'ACCEPTED', JSON.stringify(task()));
    assert.equal(task().policy_sha, CONTROL);
    assert.equal(w.mergeCount, 1);
    assert.equal(w.branches.main, MAIN);
    assert.equal(w.branches['agent-control-runtime'], CONTROL);
    assert.ok(w.repair > 0, 'a failing review was repaired');
    const dispatched = w.runs.filter(r => r.event === 'workflow_dispatch');
    assert.ok(dispatched.length >= 4);
    assert.ok(dispatched.every(r => r.head_branch === 'agent-control-runtime' && r.head_sha === CONTROL));
    assert.equal(dispatched.some(r => [w.policy.workflow_ids.accept, w.policy.workflow_ids.promote].includes(r.workflow_id)), false);
    w.extraIssues.push({ number: 22, user: { id: w.policy.owner.id }, body: contractBody().replaceAll('SC-DEMO-001', 'SC-DEMO-002').replace('BRANCH_SLUG: demo', 'BRANCH_SLUG: next') });
    for (let i = 0; i < 10 && !Object.values(w.projection()).some(r => r.task_id === 'SC-DEMO-002'); i++) await reconcileFromEnv(w.env, { policy: w.policy });
    assert.ok(Object.values(w.projection()).some(r => r.task_id === 'SC-DEMO-002'));
    assert.equal(w.pulls.some(p => p.base.ref === 'main'), false);
  } finally { globalThis.fetch = original; }
});


test('task contracts, stored branches and provider payloads cannot target the control branch', () => {
  const policy = operational();
  assert.throws(() => buildCreatePayload({ repoUrl: policy.repository_url, startingRef: 'agent-control-runtime',
    repositoryId: policy.repository_id, expectedRepositoryId: policy.repository_id, fork: false,
    allowedRepoUrls: policy.allowed_repo_urls }), /REF_FORBIDDEN/);
  const record = taskRecord(); record.binding.branch = 'agent-control-runtime';
  assert.equal(plan(record, { ...observation(), policy }).record.blocked_reason, 'REF_FORBIDDEN');
  for (const effect of [{ type: 'cursor.create', branch: 'agent-control-runtime' },
    { type: 'cursor.create', branch: 'feat/sc-demo-task', payload: { repos: [{ startingRef: 'agent-control-runtime' }] } }]) {
    assert.throws(() => assertControlEffect(policy, effect), /REF_FORBIDDEN/);
  }
});
