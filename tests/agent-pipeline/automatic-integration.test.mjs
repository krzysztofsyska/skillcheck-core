import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { validateReview } from '../../tools/agent-pipeline/lib/review.mjs';
import { preparePromotion } from '../../tools/agent-pipeline/lib/promotion.mjs';
import { drainOutbox } from '../../tools/agent-pipeline/lib/live-effects.mjs';
import { createMemoryJournal } from '../../tools/agent-pipeline/lib/controller.mjs';
import { buildNotification } from '../../tools/agent-pipeline/lib/notifications.mjs';
import { assembleWork } from '../../tools/agent-pipeline/lib/snapshot.mjs';
import { MAIN_STATES } from '../../tools/agent-pipeline/lib/record.mjs';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';
import { evaluatePreflight } from '../../tools/agent-pipeline/lib/merge.mjs';
import { configuredPolicy, protectionFixtures } from './http-world.mjs';
import { observation, taskRecord } from './helpers.mjs';

function verifiedTask() {
  const record = taskRecord({
    state: 'READY_FOR_OWNER', review_run_id: 31, review_run_attempt: 1,
    ci_run_id: 41, ci_run_attempt: 1, review_request_id: 'review-31',
  });
  const obs = observation();
  const payload = {
    schema_version: 1,
    request_id: record.review_request_id,
    repository_id: record.repository_id,
    pr_number: record.pr_number,
    head_sha: record.head_sha,
    base_sha: record.base_sha,
    contract_hash: record.contract_hash,
    verdict: 'PASS',
    acceptance_checks: record.binding.required_tests.map(id => ({ id, status: 'PASS', required: true })),
    findings: [],
    limitations: [],
  };
  const envelope = {
    workflow_id: obs.policy.workflow_ids.review,
    workflow_path: obs.policy.workflows.review,
    run_id: 31,
    run_attempt: 1,
    policy_sha: record.policy_sha,
    payload,
  };
  const review = validateReview(envelope, {
    workflowId: envelope.workflow_id,
    workflowPath: envelope.workflow_path,
    runId: 31,
    runAttempt: 1,
    policySha: record.policy_sha,
    requestId: record.review_request_id,
    repositoryId: record.repository_id,
    prNumber: record.pr_number,
    headSha: record.head_sha,
    baseSha: record.base_sha,
    contractHash: record.contract_hash,
    requiredChecks: record.binding.required_tests,
  });
  if (!review.pass) throw new Error(`fixture review rejected: ${review.reason}`);
  record.binding.evidence = { ci: { ok: true, pass: true }, review };
  obs.simulation = false;
  obs.flags = { enabled: true, mergeEnabled: true };
  obs.policy = { ...obs.policy, integration_merge_policy: 'verified_ci_review' };
  obs.preflight = { ok: true };
  obs.lockHolder = 'only-merge-writer';
  obs.mergeLock = { holder: 'only-merge-writer' };
  obs.github.branch = {
    name: record.binding.branch, sha: record.head_sha,
    repositoryId: obs.policy.repository_id, files: ['app/demo/page.tsx'],
  };
  obs.github.pull = {
    number: record.pr_number, headSha: record.head_sha, baseSha: record.base_sha,
    headRef: record.binding.branch, baseRef: 'integration',
    headRepositoryId: record.repository_id, baseRepositoryId: record.repository_id,
    merged: false,
  };
  obs.github.protection = {
    exclusiveWritersConfirmed: true, scOps001Exception: false, mainProtected: true,
    integrationProtected: true, agentStateProtected: true, qualityGatesBypass: false,
    administrationWriteUsed: false, environmentsConfirmed: true, requiredChecksPinnedToApp: true,
  };
  obs.github.ci = { run_id: 41, run_attempt: 1, payload: { verified: true } };
  obs.github.review = envelope;
  return { record, obs };
}

test('current CI + independent review schedules integration merge without owner approval', () => {
  const { record, obs } = verifiedTask();
  const result = plan(record, obs);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].type, 'github.merge');
  assert.equal(result.effects[0].gate, 'A');
  assert.equal(result.record.binding.approval, null);
  assert.equal(result.record.binding.auto_integration.source, 'verified_ci_review');
  assert.equal(result.record.binding.auto_integration.head_sha, record.head_sha);
  assert.equal(result.record.binding.merge.phase, 'awaiting_confirmation');
});

test('disabled LIVE flags, unconfirmed protection, or missing evidence cannot merge', () => {
  const cases = [
    o => { o.flags.mergeEnabled = false; },
    o => { o.flags.enabled = false; },
    o => { o.preflight.ok = false; },
    o => { o.github.protection.integrationProtected = false; },
    o => { o.github.protection.environmentsConfirmed = false; },
    o => { o.github.review = null; },
    o => { o.github.ci = null; },
    o => { o.github.pull.baseSha = 'f'.repeat(40); },
  ];
  for (const change of cases) {
    const { record, obs } = verifiedTask();
    change(obs);
    const result = plan(record, obs);
    assert.equal(result.effects.some(e => e.type === 'github.merge'), false);
  }
});

test('a production approval record never enters automatic integration', () => {
  const { record, obs } = verifiedTask();
  record.binding.approval = { gate: 'B' };
  const result = plan(record, obs);
  assert.equal(result.effects.some(e => e.type === 'github.merge'), false);
  assert.equal(result.record.blocked_reason, 'GATE_MISMATCH');
});

test('legacy offline fixtures still use explicit owner gate A for backward compatibility', () => {
  const { record, obs } = verifiedTask();
  obs.simulation = true;
  const result = plan(record, obs);
  assert.equal(result.effects.some(e => e.type === 'github.merge'), false);
  assert.equal(result.record.binding.approval?.gate, 'A');
  assert.match(result.record.binding.approval.canonical.review_digest, /^[a-f0-9]{64}$/);
});

test('documented controller states are states the implementation recognizes', () => {
  const doc = readFileSync('docs/AGENT_PIPELINE.md', 'utf8');
  const line = doc.split('\n').find(item => item.includes('BACKLOG -> READY ->'));
  const names = [...line.matchAll(/[A-Z][A-Z0-9_]+/g)].map(match => match[0]);
  assert.deepEqual(names, ['BACKLOG', 'READY', 'BUILDING', 'PR_REVIEW', 'FIXING', 'READY_FOR_OWNER', 'ACCEPTED', 'READY_FOR_PROD', 'DEPLOYING', 'DONE']);
  for (const name of names) assert.ok(MAIN_STATES.includes(name), name);
});

test('automatic integration evidence remains a promotion candidate and does not open gate B', async () => {
  const auto = acceptedRecord();
  const production = acceptedRecord();
  production.task_id = 'SC-PROMOTE';
  production.binding.approval = { gate: 'B', digest: 'prod', run_id: 9 };
  production.binding.auto_integration = null;
  production.binding.merge = { mergeCommitSha: 'f'.repeat(40), gate: 'B' };
  const incomplete = acceptedRecord();
  incomplete.task_id = 'SC-PARTIAL';
  incomplete.binding.auto_integration = { ...incomplete.binding.auto_integration, review_digest: '' };
  incomplete.binding.merge = { mergeCommitSha: '1'.repeat(40), gate: 'A' };
  const github = {
    async readComparison(base, head) {
      const commits = head === 'e'.repeat(40)
        ? ['b'.repeat(40), 'e'.repeat(40), 'f'.repeat(40)]
        : head === 'b'.repeat(40) ? ['b'.repeat(40)] : [head];
      return { status: base === head ? 'identical' : 'ahead', commits: commits.map(sha => ({ sha })), files: [{ filename: 'app/demo/page.tsx' }] };
    },
    async readReleasePlan() { return null; },
  };
  const result = await preparePromotion(github, observation().policy, {
    'SC-X': auto, 'SC-PROMOTE': production, 'SC-PARTIAL': incomplete,
  }, 'e'.repeat(40), 'd'.repeat(40));
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].task_id, 'SC-X');
  assert.equal(result.tasks[0].integration_source, 'verified_ci_review');
  assert.equal(result.tasks[0].review_digest, 'review-digest');
  assert.equal(result.tasks[0].approval_run_id, undefined);
  assert.equal(result.blockedReason, 'PROMOTION_SCOPE_UNACCOUNTED');
  assert.equal(result.runbook, null);
  assert.equal(await preparePromotion(github, observation().policy, { 'SC-PARTIAL': incomplete }, '1'.repeat(40), 'd'.repeat(40)), null);
});

test('readiness is delivered while merge is disabled and production still waits for its run', async () => {
  const policy = structuredClone(observation().policy);
  policy.controller_actor_id = 456;
  const comments = [];
  const github = {
    async readComments() { return comments; },
    async comment({ body }) {
      const item = { id: comments.length + 1, body, user: { id: policy.controller_actor_id } };
      comments.push(item);
      return item;
    },
    async updateComment(id, body) { comments.find(item => item.id === id).body = body; },
  };
  const ready = taskRecord({ state: 'READY_FOR_OWNER', issue_number: 7, pr_number: 50 });
  ready.binding.approval = null;
  const delivered = await drainOutbox({ github, journal: createMemoryJournal(), policy, record: ready, now: '2026-10-13T12:00:00.000Z' });
  assert.equal(delivered.binding.pending_notification, null);
  assert.equal(delivered.binding.last_notified_state, 'READY_FOR_OWNER');
  assert.equal(delivered.binding.approval, null);
  assert.match(comments[0].body, /kind: READY_FOR_OWNER/);
  assert.doesNotMatch(comments[0].body, /actions\/runs\/\d+/);

  const accepted = taskRecord({ state: 'ACCEPTED', issue_number: 7, pr_number: 50 });
  accepted.binding.approval = null;
  accepted.binding.auto_integration = { source: 'verified_ci_review', review_digest: 'review-digest', head_sha: accepted.head_sha };
  accepted.binding.pending_notification = buildNotification({
    taskId: accepted.task_id, stateRevision: accepted.state_revision, recipient: policy.notification_recipient,
    kind: 'READY_FOR_OWNER', headSha: accepted.head_sha, baseSha: accepted.base_sha, result: 'READY_FOR_OWNER',
    evidenceUrl: `${policy.repository_url}/pull/50`, actionUrl: null,
  });
  const cleaned = await drainOutbox({ github, journal: createMemoryJournal(), policy, record: accepted, now: '2026-10-13T12:00:00.000Z' });
  assert.equal(cleaned.state, 'ACCEPTED');
  assert.equal(cleaned.binding.pending_notification, null);
  assert.equal(cleaned.binding.last_notified_state, 'READY_FOR_OWNER');

  const production = taskRecord({ state: 'READY_FOR_PROD', issue_number: 8, pr_number: 51 });
  production.binding.lane = 'promotion';
  production.binding.approval = { gate: 'B', request_id: 'req-b', digest: 'prod', run_id: null };
  production.binding.pending_notification = buildNotification({
    taskId: production.task_id, stateRevision: production.state_revision, recipient: policy.notification_recipient,
    kind: 'READY_FOR_PROD', headSha: production.head_sha, baseSha: production.base_sha, result: 'READY_FOR_PROD',
    evidenceUrl: `${policy.repository_url}/pull/51`, actionUrl: null,
  });
  const held = await drainOutbox({ github, journal: createMemoryJournal(), policy, record: production, now: '2026-10-13T12:00:00.000Z' });
  assert.equal(held.binding.pending_notification.kind, 'READY_FOR_PROD');
  assert.equal(comments.filter(item => item.body.includes('READY_FOR_PROD')).length, 0);

  const { policy: workPolicy, policySha } = { policy, policySha: 'd'.repeat(40) };
  const stuck = taskRecord({ state: 'ACCEPTED' });
  stuck.binding.pending_notification = { kind: 'READY_FOR_OWNER' };
  stuck.binding.approval = null;
  const work = assembleWork({
    policy: workPolicy, policySha, now: '2026-10-13T12:00:00.000Z', secrets: {},
    snapshot: {
      records: { [stuck.task_id]: stuck },
      promotion: { taskId: 'SC-PROMOTE-1', manifest: { tasks: [] }, runbook: { id: 'r' } },
      issues: [], pulls: [],
    },
  });
  assert.equal(work.items[0].record.state, 'ACCEPTED');
  assert.equal(work.items[0].record.binding.pending_notification.kind, 'READY_FOR_OWNER');
});

test('operative setup requires integration-ready and rejects an owner-acceptance ruleset', () => {
  const policy = loadPolicy();
  const runbook = readFileSync('docs/sc-ops-002c-bootstrap-runbook.md', 'utf8');
  const spec = readFileSync('docs/sc-ops-002a-agent-orchestration.md', 'utf8');
  const checksIn = text => [...text.matchAll(/sc-agent\/[a-z0-9-]+/g)].map(match => match[0]);
  const runbookLine = runbook.split('\n').find(line => line.includes('quality-gates'));
  const specLine = spec.split('\n').find(line => line.includes('Wymagane checks:'));
  assert.deepEqual(checksIn(runbookLine.split('dla `main`')[0]), policy.required_checks.integration);
  assert.deepEqual(checksIn(runbookLine.split('dla `main`')[1]), policy.required_checks.main);
  assert.deepEqual(checksIn(specLine.split(' dla integration')[0]), policy.required_checks.integration);
  assert.deepEqual(checksIn(specLine.split(' dla integration')[1].split(' dla main')[0]), policy.required_checks.main);

  const live = configuredPolicy();
  const fixtures = protectionFixtures(live);
  const rules = structuredClone(fixtures.rules);
  const integration = rules.find(rule => rule.name === 'quality-gates' && rule.conditions.ref_name.include.includes('refs/heads/integration'));
  const required = integration.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks;
  const ready = required.find(check => check.context === 'sc-agent/integration-ready');
  ready.context = 'sc-agent/owner-acceptance';
  const stale = protectionFromRulesets(rules, live, fixtures.environments);
  assert.equal(stale.integrationProtected, false);
  assert.equal(evaluatePreflight(stale).ok, false);
  assert.equal(evaluatePreflight(protectionFromRulesets(fixtures.rules, live, fixtures.environments)).ok, true);
});

test('unconfirmed readiness delivery stops blocking the next task', async () => {
  const policy = structuredClone(observation().policy);
  policy.controller_actor_id = 456;
  const record = taskRecord({ state: 'ACCEPTED', issue_number: 7, pr_number: 50 });
  record.binding.approval = null;
  record.binding.pending_notification = buildNotification({
    taskId: record.task_id, stateRevision: record.state_revision, recipient: policy.notification_recipient,
    kind: 'READY_FOR_OWNER', headSha: record.head_sha, baseSha: record.base_sha, result: 'READY_FOR_OWNER',
    evidenceUrl: `${policy.repository_url}/pull/50`, actionUrl: null,
  });
  record.binding.pending_notification.delivery_phase = 'unknown';
  const github = {
    async readComments() { return []; },
    async comment() { throw Object.assign(new Error('transport'), { status: 500 }); },
    async updateComment() { throw Object.assign(new Error('transport'), { status: 500 }); },
  };
  let current = record;
  for (let i = 0; i < policy.limits.transport_attempts; i++) {
    current = await drainOutbox({ github, journal: createMemoryJournal(), policy, record: current, now: '2026-10-14T08:00:00.000Z' });
  }
  assert.equal(current.binding.pending_notification.unknown_attempts, policy.limits.transport_attempts);
  assert.equal(current.binding.pending_notification.delivery_phase, 'unknown');
  assert.equal(current.binding.reports.at(-1).kind, 'NOTIFICATION_UNCONFIRMED');
  const again = await drainOutbox({ github, journal: createMemoryJournal(), policy, record: current, now: '2026-10-14T08:00:00.000Z' });
  assert.equal(again.binding.pending_notification.unknown_attempts, policy.limits.transport_attempts);
  const work = assembleWork({
    policy, policySha: 'd'.repeat(40), now: '2026-10-14T08:00:00.000Z', secrets: {},
    snapshot: {
      records: { [current.task_id]: current },
      promotion: { taskId: 'SC-PROMOTE-QUEUE', manifest: { tasks: [] }, runbook: { id: 'r' } },
      issues: [], pulls: [],
    },
  });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].record, null);
  assert.equal(work.items[0].observation.kind, 'promotion');
});

function acceptedRecord() {
  const record = taskRecord({
    task_id: 'SC-X', state: 'ACCEPTED', issue_number: 7,
    base_sha: 'c'.repeat(40), head_sha: 'b'.repeat(40), policy_sha: 'd'.repeat(40),
    contract_hash: 'a'.repeat(64), ci_run_id: 41, review_run_id: 31, approval_request_id: null,
  });
  record.binding.approval = null;
  record.binding.merge = { mergeCommitSha: 'e'.repeat(40), gate: 'A' };
  record.binding.auto_integration = {
    source: 'verified_ci_review', head_sha: record.head_sha, base_sha: record.base_sha,
    policy_sha: record.policy_sha, contract_hash: record.contract_hash,
    ci_run_id: 41, review_run_id: 31, ci_digest: 'ci-digest', review_digest: 'review-digest',
  };
  return record;
}
