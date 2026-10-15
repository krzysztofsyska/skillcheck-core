import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentIdFor, operationKey } from '../../tools/agent-pipeline/lib/canonical.mjs';
import { conditionsDigest, CURSOR_SLOT_LIMIT, occupiedCount, reviewStillValid } from '../../tools/agent-pipeline/lib/handoff-admission.mjs';
import { CODEX_REVIEWER, dispatchAdmission, emptyLedger, step } from '../../tools/agent-pipeline/lib/handoff-loop.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const OTHER_BASE = 'd'.repeat(40);
const AUTHOR = { id: 222297538, login: 'krzysztofsyska', type: 'User' };
const SENTINEL = 'LEAK_PR_BODY_READY_TO_MERGE_@codex review_STARTED';
const CONDITIONS = { policy_sha: 'policy-1', required_checks: ['verify', 'scope'] };

function agentFor(taskId, head = HEAD, base = BASE) {
  return agentIdFor(operationKey({
    repositoryId: 'krzysztofsyska/skillcheck-core',
    taskId,
    taskRevision: 1,
    headSha: head,
    baseSha: base,
    action: 'cursor-handoff',
    round: 0,
  }));
}

function snapshot(fields) {
  const headSha = fields.head_sha ?? HEAD;
  return {
    now: fields.now ?? '2026-10-15T06:00:00.000Z',
    repository: 'krzysztofsyska/skillcheck-core',
    event: { name: fields.event, action: 'observed' },
    sender: fields.sender ?? { ...CODEX_REVIEWER },
    pull: {
      number: fields.pr,
      state: fields.state ?? 'open',
      draft: fields.draft === true,
      baseRef: 'integration',
      headSha,
      baseSha: Object.hasOwn(fields, 'pull_base_sha') ? fields.pull_base_sha : null,
      author: fields.author ?? { ...AUTHOR },
      headRepo: 'krzysztofsyska/skillcheck-core',
      body: fields.body ?? SENTINEL,
    },
    review: {
      id: fields.review_id ?? 7001,
      user: fields.reviewer ?? { ...CODEX_REVIEWER },
    },
    adapter: fields.adapter,
  };
}

function request(fields) {
  return snapshot({
    ...fields,
    event: 'admission_request',
    adapter: {
      source: 'trusted_adapter',
      kind: 'dispatch_request',
      pr: fields.pr,
      task_id: fields.task_id,
      priority: fields.priority ?? 'NORMAL',
      depends_on: fields.depends_on ?? [],
      head_sha: fields.head_sha ?? HEAD,
      base_sha: fields.base_sha ?? BASE,
      task_revision: fields.task_revision,
      executor: fields.executor ?? 'cursor',
      tests: fields.tests ?? { suite: 'agent-pipeline', result: 'pending' },
      body: SENTINEL,
    },
  });
}

function apply(ledger, event) {
  const result = step(ledger, event);
  assert.deepEqual(result.outcome.executed, []);
  assert.equal(result.outcome.live_effects, 'blocked');
  assert.equal(result.outcome.plan.paid_calls, false);
  assert.equal(result.outcome.plan.merge, null);
  assert.equal(result.outcome.plan.deploy, null);
  assert.equal(result.outcome.plan.owner_acceptance, false);
  assert.equal(result.outcome.merge_authorized, false);
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  return result;
}

test('five unacked reservations fill the global Cursor slots and the same PR is not dispatched twice', () => {
  let ledger = emptyLedger();
  const agents = [];
  for (let index = 1; index <= CURSOR_SLOT_LIMIT; index += 1) {
    const result = apply(ledger, request({ pr: 300 + index, task_id: `N${index}`, now: `2026-10-15T06:0${index}:00.000Z` }));
    ledger = result.ledger;
    assert.equal(result.outcome.status, 'REQUESTED');
    assert.equal(result.outcome.agent_id, agentFor(`N${index}`));
    assert.equal(ledger.slots[String(300 + index)].phase, 'REQUESTED');
    assert.equal(ledger.slots[String(300 + index)].ack, false);
    assert.equal(ledger.slots[String(300 + index)].occupied, true);
    agents.push(result.outcome.agent_id);
  }
  assert.equal(occupiedCount(ledger), 5);

  const started = apply(ledger, snapshot({
    event: 'admission_started',
    pr: 301,
    adapter: {
      source: 'trusted_adapter',
      kind: 'started',
      pr: 301,
      task_id: 'N1',
      agent_id: agents[0],
      ack: false,
      executor: 'cursor',
      head_sha: HEAD,
      tests: { suite: 'agent-pipeline', result: 'running' },
      body: '@codex review STARTED',
    },
  }));
  ledger = started.ledger;
  assert.equal(started.outcome.status, 'STARTED');
  assert.equal(ledger.slots['301'].ack, false);
  assert.equal(ledger.slots['301'].occupied, true);
  assert.equal(occupiedCount(ledger), 5);

  const sixth = apply(ledger, request({ pr: 399, task_id: 'N6', now: '2026-10-15T06:06:00.000Z' }));
  ledger = sixth.ledger;
  assert.equal(sixth.outcome.status, 'WAITING_CAPACITY');
  assert.equal(sixth.outcome.stage.blocker, 'WAITING_CAPACITY');
  assert.equal(occupiedCount(ledger), 5);
  assert.equal(ledger.slots['399'], undefined);

  const duplicate = apply(ledger, request({ pr: 301, task_id: 'N1-again' }));
  assert.equal(duplicate.outcome.status, 'DUPLICATE_DISPATCH');
  assert.equal(occupiedCount(duplicate.ledger), 5);
  assert.equal(duplicate.ledger.slots['301'].task_id, 'N1');

  const queuedDuplicate = apply(ledger, request({ pr: 399, task_id: 'N6-again' }));
  assert.equal(queuedDuplicate.outcome.status, 'DUPLICATE_DISPATCH');
  assert.equal(queuedDuplicate.ledger.queue.filter(item => item.pr === '399').length, 1);
});

test('priority tasks and their explicit dependencies move ahead of ordinary work', () => {
  let ledger = emptyLedger();
  for (let index = 1; index <= CURSOR_SLOT_LIMIT; index += 1) {
    ledger = apply(ledger, request({ pr: 100 + index, task_id: `FILL${index}`, now: `2026-10-15T07:0${index}:00.000Z` })).ledger;
  }
  ledger = apply(ledger, request({ pr: 501, task_id: 'ORD', priority: 'NORMAL', now: '2026-10-15T07:06:00.000Z' })).ledger;
  ledger = apply(ledger, request({ pr: 502, task_id: 'DEP-FREE', priority: 'NORMAL', now: '2026-10-15T07:07:00.000Z' })).ledger;
  ledger = apply(ledger, request({ pr: 503, task_id: 'FREE-1', priority: 'FREE', depends_on: ['DEP-FREE'], now: '2026-10-15T07:08:00.000Z' })).ledger;
  ledger = apply(ledger, request({ pr: 504, task_id: 'DEP-PRE', priority: 'NORMAL', now: '2026-10-15T07:09:00.000Z' })).ledger;
  ledger = apply(ledger, request({ pr: 505, task_id: 'PRE-1', priority: 'PRESELEKCJA', depends_on: ['DEP-PRE'], now: '2026-10-15T07:10:00.000Z' })).ledger;
  ledger = apply(ledger, request({ pr: 506, task_id: 'DEP-005', priority: 'NORMAL', now: '2026-10-15T07:11:00.000Z' })).ledger;
  const queued = apply(ledger, request({ pr: 507, task_id: 'SC-1', priority: 'SC-005', depends_on: ['DEP-005'], now: '2026-10-15T07:12:00.000Z' }));
  ledger = queued.ledger;
  assert.equal(queued.outcome.status, 'WAITING_DEPENDENCY');
  assert.equal(occupiedCount(ledger), 5);

  const release = complete(ledger, 101, 'FILL1');
  ledger = release.ledger;
  assert.equal(release.outcome.status, 'COMPLETED');
  assert.equal(ledger.slots['502'].task_id, 'DEP-FREE');
  assert.equal(ledger.slots['502'].phase, 'REQUESTED');
  assert.equal(ledger.slots['502'].ack, false);
  assert.equal(ledger.slots['505'], undefined);
  assert.equal(ledger.queue.some(item => item.task_id === 'ORD'), true);
  assert.equal(ledger.queue.some(item => item.task_id === 'FREE-1'), true);

  ledger = complete(ledger, 502, 'DEP-FREE').ledger;
  assert.equal(ledger.slots['503'].task_id, 'FREE-1');
  assert.equal(ledger.slots['503'].occupied, true);
  assert.equal(ledger.slots['503'].ack, false);
  assert.equal(ledger.queue.some(item => item.task_id === 'ORD'), true);

  ledger = complete(ledger, 102, 'FILL2', 'e'.repeat(40)).ledger;
  assert.equal(ledger.slots['504'].task_id, 'DEP-PRE');
  ledger = complete(ledger, 504, 'DEP-PRE', 'f'.repeat(40)).ledger;
  assert.equal(ledger.slots['505'].task_id, 'PRE-1');
  ledger = complete(ledger, 103, 'FILL3', '1'.repeat(40)).ledger;
  assert.equal(ledger.slots['506'].task_id, 'DEP-005');
  ledger = complete(ledger, 506, 'DEP-005', '2'.repeat(40)).ledger;
  assert.equal(ledger.slots['507'].task_id, 'SC-1');
  assert.equal(ledger.queue.some(item => item.task_id === 'ORD'), true);
  assert.equal(occupiedCount(ledger), 5);
});

test('a dependency cycle occupies no slot and a missing dependency waits', () => {
  let ledger = emptyLedger();
  const waiting = apply(ledger, request({ pr: 11, task_id: 'A', depends_on: ['B'] }));
  ledger = waiting.ledger;
  assert.equal(waiting.outcome.status, 'WAITING_DEPENDENCY');
  assert.equal(occupiedCount(ledger), 0);

  const cycle = apply(ledger, request({ pr: 12, task_id: 'B', depends_on: ['A'] }));
  ledger = cycle.ledger;
  assert.equal(cycle.outcome.status, 'BLOCKED_DEPENDENCY_CYCLE');
  assert.equal(cycle.outcome.stage.blocker, 'BLOCKED_DEPENDENCY_CYCLE');
  assert.deepEqual(ledger.queue, []);
  assert.equal(occupiedCount(ledger), 0);

  const self = apply(ledger, request({ pr: 13, task_id: 'C', depends_on: ['C'] }));
  assert.equal(self.outcome.status, 'BLOCKED_DEPENDENCY_CYCLE');
  assert.equal(occupiedCount(self.ledger), 0);

  ledger = emptyLedger();
  ledger = apply(ledger, request({ pr: 21, task_id: 'LEFT', depends_on: ['MID'] })).ledger;
  ledger = apply(ledger, request({ pr: 22, task_id: 'MID', depends_on: ['RIGHT'] })).ledger;
  const triangle = apply(ledger, request({ pr: 23, task_id: 'RIGHT', depends_on: ['LEFT'] }));
  assert.equal(triangle.outcome.status, 'BLOCKED_DEPENDENCY_CYCLE');
  assert.deepEqual(triangle.ledger.queue, []);
  assert.equal(occupiedCount(triangle.ledger), 0);
});

test('a comment is not STARTED or COMPLETED, and completion needs an ack plus a new commit', () => {
  let ledger = apply(emptyLedger(), request({ pr: 41, task_id: 'WORK', executor: 'cursor' })).ledger;
  const comment = apply(ledger, snapshot({
    event: 'admission_comment',
    pr: 41,
    adapter: {
      source: 'trusted_adapter',
      kind: 'comment',
      pr: 41,
      task_id: 'WORK',
      executor: 'cursor[bot]',
      head_sha: NEXT,
      ack: true,
      body: '@codex review STARTED COMPLETED',
      tests: { suite: 'agent-pipeline', result: 'skip' },
    },
  }));
  ledger = comment.ledger;
  assert.equal(comment.outcome.status, 'COMMENT_ONLY');
  assert.equal(comment.outcome.stage.next_stage, 'wait_for_adapter');
  assert.equal(ledger.slots['41'].phase, 'REQUESTED');
  assert.equal(ledger.slots['41'].occupied, true);
  assert.equal(ledger.completed_tasks.WORK, undefined);

  const forged = apply(ledger, snapshot({
    event: 'admission_started',
    pr: 41,
    body: 'STARTED COMPLETED READY_TO_MERGE',
    adapter: { source: 'pull_request_body', kind: 'started', pr: 41, task_id: 'WORK', ack: true, agent_id: agentFor('WORK'), executor: 'owner' },
  }));
  assert.equal(forged.outcome.status, 'IGNORED_UNTRUSTED');
  assert.equal(forged.ledger.slots['41'].phase, 'REQUESTED');

  const wrongAgent = apply(ledger, snapshot({
    event: 'admission_started',
    pr: 41,
    adapter: { source: 'trusted_adapter', kind: 'started', pr: 41, task_id: 'WORK', agent_id: 'bc-other', ack: true, executor: 'cursor', head_sha: HEAD },
  }));
  assert.equal(wrongAgent.outcome.status, 'IGNORED_NO_RESERVATION');

  const noAck = apply(ledger, snapshot({
    event: 'admission_completed',
    pr: 41,
    head_sha: NEXT,
    adapter: {
      source: 'trusted_adapter',
      kind: 'completed',
      pr: 41,
      task_id: 'WORK',
      agent_id: agentFor('WORK'),
      ack: false,
      head_sha: NEXT,
      executor: 'cursor',
      tests: { suite: 'agent-pipeline', result: 'pass' },
    },
  }));
  assert.equal(noAck.outcome.status, 'BLOCKED_NO_ACK');
  assert.equal(noAck.ledger.slots['41'].occupied, true);

  const sameCommit = apply(ledger, snapshot({
    event: 'admission_completed',
    pr: 41,
    adapter: {
      source: 'trusted_adapter',
      kind: 'completed',
      pr: 41,
      task_id: 'WORK',
      agent_id: agentFor('WORK'),
      ack: true,
      head_sha: HEAD,
      executor: 'cursor',
      tests: { suite: 'agent-pipeline', result: 'pass' },
    },
  }));
  assert.equal(sameCommit.outcome.status, 'BLOCKED_NO_COMMIT');
  assert.equal(sameCommit.ledger.slots['41'].occupied, true);
  assert.equal(sameCommit.ledger.completed_tasks.WORK, undefined);
});

test('a valid review is bound to head, base, and the control digest and is not repeated', () => {
  const first = apply(emptyLedger(), review({}));
  assert.equal(first.outcome.status, 'READY_TO_MERGE');
  assert.equal(first.outcome.stage.next_stage, 'owner_acceptance');
  assert.equal(first.outcome.stage.review, 'PASS');
  assert.equal(first.outcome.merge_authorized, false);
  assert.notEqual(first.outcome.status, 'READY_FOR_OWNER');
  assert.equal(Object.keys(first.ledger.bound_reviews).length, 1);

  const repeated = apply(first.ledger, review({ ci: null }));
  assert.equal(repeated.outcome.status, 'REVIEW_REUSED');
  assert.equal(repeated.outcome.stage.blocker, 'WAITING_CI');
  assert.equal(repeated.outcome.plan.codex_rereview, null);
  assert.equal(Object.keys(repeated.ledger.bound_reviews).length, 1);

  const sameConditions = apply(first.ledger, review({
    conditions: { policy_sha: 'policy-1', required_checks: ['scope', 'verify'] },
    ci: null,
  }));
  assert.equal(sameConditions.outcome.status, 'REVIEW_REUSED');
  assert.equal(conditionsDigest(CONDITIONS), conditionsDigest({ policy_sha: 'policy-1', required_checks: ['scope', 'verify'] }));

  const staleBase = apply(first.ledger, review({ base_sha: OTHER_BASE, reuse_binding: true, ci: { sha: HEAD, conclusion: 'success' } }));
  assert.equal(staleBase.outcome.status, 'STALE_REVIEW');
  assert.equal(Object.keys(staleBase.ledger.bound_reviews).length, 1);
  assert.notEqual(staleBase.outcome.status, 'READY_TO_MERGE');

  const staleHead = apply(first.ledger, review({ head_sha: NEXT, reuse_binding: true }));
  assert.equal(staleHead.outcome.status, 'STALE_REVIEW');

  const staleDigest = apply(first.ledger, review({
    conditions: { policy_sha: 'policy-2', required_checks: ['verify', 'scope'] },
    reuse_binding: true,
  }));
  assert.equal(staleDigest.outcome.status, 'STALE_REVIEW');
  assert.equal(Object.keys(staleDigest.ledger.bound_reviews).length, 1);
});

test('READY_TO_MERGE requires an independent pass, green CI, finished dependencies, and no active findings', () => {
  for (const severity of ['P0', 'p1', 'P2']) {
    const blocked = apply(emptyLedger(), review({ findings: [{ severity, active: severity === 'P0' ? undefined : true }] }));
    assert.equal(blocked.outcome.status, 'BLOCKED_FINDINGS');
    assert.equal(blocked.outcome.merge_authorized, false);
  }

  const inactive = apply(emptyLedger(), review({ findings: [{ severity: 'P2', active: false }] }));
  assert.equal(inactive.outcome.status, 'READY_TO_MERGE');

  const waitingCi = apply(emptyLedger(), review({ ci: { sha: HEAD, conclusion: 'failure' } }));
  assert.equal(waitingCi.outcome.status, 'REVIEW_BOUND');
  assert.equal(waitingCi.outcome.stage.blocker, 'WAITING_CI');

  const unmet = apply(emptyLedger(), review({ depends_on: ['DEP-REVIEW'] }));
  assert.equal(unmet.outcome.stage.blocker, 'WAITING_DEPENDENCY');
  assert.notEqual(unmet.outcome.status, 'READY_TO_MERGE');

  let ledger = apply(emptyLedger(), request({ pr: 61, task_id: 'DEP-REVIEW', executor: 'cursor' })).ledger;
  ledger = complete(ledger, 61, 'DEP-REVIEW').ledger;
  const ready = apply(ledger, review({ pr: 62, task_id: 'AFTER', depends_on: ['DEP-REVIEW'], executor: 'cursor' }));
  assert.equal(ready.outcome.status, 'READY_TO_MERGE');
  assert.equal(ready.ledger.completed_tasks['DEP-REVIEW'].head_sha, NEXT);

  const merge = apply(ready.ledger, snapshot({
    event: 'admission_merge',
    pr: 62,
    adapter: {
      source: 'trusted_adapter',
      kind: 'merge',
      pr: 62,
      task_id: 'AFTER',
      executor: 'cursor',
      head_sha: HEAD,
      verdict: 'PASS',
      merge_authorized: true,
    },
  }));
  assert.equal(merge.outcome.status, 'BLOCKED_MERGE');
  assert.equal(merge.outcome.stage.blocker, 'BLOCKED_MERGE');
  assert.equal(merge.outcome.merge_authorized, false);

  const deploy = apply(ready.ledger, snapshot({
    event: 'admission_deploy',
    pr: 62,
    adapter: { source: 'trusted_adapter', kind: 'deploy', pr: 62, task_id: 'AFTER', executor: 'cursor', head_sha: HEAD },
  }));
  assert.equal(deploy.outcome.status, 'BLOCKED_DEPLOY');
  assert.equal(deploy.outcome.plan.deploy, null);
});

test('stage audit comes from the trusted adapter and a 403 opens no slot', async () => {
  const recorded = apply(emptyLedger(), request({
    pr: 71,
    task_id: 'AUDIT-1',
    executor: 'cursor',
    tests: { suite: 'agent-pipeline', result: 'pending' },
  }));
  const audit = recorded.ledger.audits.at(-1);
  assert.equal(audit.pr, 71);
  assert.equal(audit.executor, 'cursor');
  assert.equal(audit.task, 'AUDIT-1');
  assert.equal(audit.sha, HEAD);
  assert.deepEqual(audit.tests, { suite: 'agent-pipeline', result: 'pending' });
  assert.equal(audit.review, null);
  assert.equal(audit.next_stage, 'wait_for_ack');
  assert.equal(audit.blocker, null);
  assert.equal(audit.agent_id, agentFor('AUDIT-1'));
  assert.equal(recorded.outcome.stage.executor, 'cursor');

  const integration = apply(emptyLedger(), { ...request({ pr: 72, task_id: 'BLOCKED' }), error: { status: 403 } });
  assert.equal(integration.outcome.status, 'BLOCKED_INTEGRATION');
  assert.equal(integration.outcome.http_status, 403);
  assert.deepEqual(integration.ledger.slots, {});
  assert.deepEqual(integration.ledger.queue, []);

  let calls = 0;
  const transported = await dispatchAdmission(emptyLedger(), request({ pr: 73, task_id: 'HTTP' }), async () => {
    calls += 1;
    const error = new Error('forbidden');
    error.status = 403;
    throw error;
  });
  assert.equal(calls, 0);
  assert.equal(transported.outcome.status, 'REQUESTED');
  assert.equal(transported.ledger.slots['73'].occupied, true);
  assert.equal(transported.outcome.merge_authorized, false);
  assert.equal(transported.outcome.plan.merge, null);
  assert.equal(transported.outcome.plan.deploy, null);
  assert.equal(transported.outcome.live_effects, 'blocked');
});

test('an offline dispatch never starts the executor callback', async () => {
  let calls = 0;
  const operation = async () => {
    calls += 1;
  };
  let ledger = emptyLedger();
  for (let index = 1; index <= 6; index += 1) {
    const result = await dispatchAdmission(ledger, request({ pr: 800 + index, task_id: `C${index}`, now: `2026-10-15T08:0${index}:00.000Z` }), operation);
    ledger = result.ledger;
    assert.equal(result.outcome.status, index < 6 ? 'REQUESTED' : 'WAITING_CAPACITY');
    assert.deepEqual(result.outcome.executed, []);
    assert.equal(result.outcome.live_effects, 'blocked');
    assert.equal(result.outcome.merge_authorized, false);
  }
  const duplicate = await dispatchAdmission(ledger, request({ pr: 801, task_id: 'C1-again' }), operation);
  assert.equal(duplicate.outcome.status, 'DUPLICATE_DISPATCH');
  assert.deepEqual(duplicate.outcome.executed, []);
  assert.equal(duplicate.outcome.live_effects, 'blocked');
  assert.equal(calls, 0);
  assert.equal(occupiedCount(duplicate.ledger), 5);
});

test('a newer FAIL, PASS_WITH_FIXES, or dismissal revokes a stored PASS', () => {
  const digest = conditionsDigest(CONDITIONS);
  const failed = apply(apply(emptyLedger(), review({ review_id: 8101 })).ledger, review({ review_id: 8101, verdict: 'FAIL', findings: [] }));
  assert.notEqual(failed.outcome.status, 'READY_TO_MERGE');
  assert.equal(failed.outcome.merge_authorized, false);
  assert.equal(reviewStillValid(failed.ledger, HEAD, BASE, digest, { pr: 81, reviewId: 8101 }), null);

  const fixes = apply(apply(emptyLedger(), review({ review_id: 8102 })).ledger, review({ review_id: 8102, verdict: 'PASS_WITH_FIXES', findings: [] }));
  assert.notEqual(fixes.outcome.status, 'READY_TO_MERGE');
  assert.equal(reviewStillValid(fixes.ledger, HEAD, BASE, digest, { pr: 81, reviewId: 8102 }), null);

  const dismissedEvent = review({ review_id: 8103, verdict: 'PASS' });
  dismissedEvent.review.state = 'dismissed';
  const dismissed = apply(apply(emptyLedger(), review({ review_id: 8103 })).ledger, dismissedEvent);
  assert.notEqual(dismissed.outcome.status, 'READY_TO_MERGE');
  assert.equal(reviewStillValid(dismissed.ledger, HEAD, BASE, digest, { pr: 81, reviewId: 8103 }), null);
});

test('readiness is refused when adapter evidence disagrees with the current pull', () => {
  const mismatched = review({ review_id: 8201 });
  mismatched.pull.headSha = 'c'.repeat(40);
  const result = apply(emptyLedger(), mismatched);
  assert.notEqual(result.outcome.status, 'READY_TO_MERGE');
  assert.equal(result.outcome.merge_authorized, false);
  assert.deepEqual(result.ledger.bound_reviews, {});

  const wrongPr = review({ review_id: 8202 });
  wrongPr.adapter.pr = 999;
  assert.notEqual(apply(emptyLedger(), wrongPr).outcome.status, 'READY_TO_MERGE');
  assert.deepEqual(apply(emptyLedger(), wrongPr).ledger.bound_reviews, {});

  const missingBase = review({ review_id: 8203 });
  delete missingBase.adapter.base_sha;
  assert.notEqual(apply(emptyLedger(), missingBase).outcome.status, 'READY_TO_MERGE');
  const omittedPullBase = review({ review_id: 8206, pull_base_sha: null });
  assert.equal(omittedPullBase.adapter.base_sha, BASE);
  assert.equal(omittedPullBase.pull.baseSha, null);
  const hiddenBase = apply(emptyLedger(), omittedPullBase);
  assert.equal(hiddenBase.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(hiddenBase.outcome.status, 'READY_TO_MERGE');
  assert.deepEqual(hiddenBase.ledger.bound_reviews, {});

  const missingReview = review({ review_id: 8204 });
  missingReview.review.id = null;
  assert.notEqual(apply(emptyLedger(), missingReview).outcome.status, 'READY_TO_MERGE');

  const bound = apply(emptyLedger(), review({ review_id: 8205 }));
  assert.equal(bound.outcome.status, 'READY_TO_MERGE');
  const stored = Object.values(bound.ledger.bound_reviews)[0];
  assert.equal(stored.pr, '81');
  assert.equal(stored.review_id, 8205);
  assert.equal(stored.head_sha, HEAD);
  assert.equal(stored.base_sha, BASE);
  assert.deepEqual(stored.conditions, CONDITIONS);
});

test('active findings revoke a stored PASS and a later reuse cannot restore it', () => {
  const digest = conditionsDigest(CONDITIONS);
  const ready = apply(emptyLedger(), review({ review_id: 8301 }));
  assert.equal(ready.outcome.status, 'READY_TO_MERGE');
  const blocked = apply(ready.ledger, review({ review_id: 8301, findings: [{ severity: 'P1', active: true }] }));
  assert.equal(blocked.outcome.status, 'BLOCKED_FINDINGS');
  assert.equal(reviewStillValid(blocked.ledger, HEAD, BASE, digest, { pr: 81, reviewId: 8301 }), null);
  const reused = apply(blocked.ledger, review({ review_id: 8301, reuse_binding: true }));
  assert.equal(reused.outcome.status, 'STALE_REVIEW');
  assert.notEqual(reused.outcome.status, 'READY_TO_MERGE');
  const replay = apply(blocked.ledger, review({ review_id: 8301 }));
  assert.equal(replay.outcome.status, 'STALE_REVIEW');
  assert.notEqual(replay.outcome.status, 'READY_TO_MERGE');
  assert.equal(Object.values(replay.ledger.bound_reviews)[0].revoked, true);
  const fresh = apply(blocked.ledger, review({ review_id: 8302 }));
  assert.equal(fresh.outcome.status, 'READY_TO_MERGE');
});

test('an earlier pass cannot restore readiness after a newer negative review', () => {
  let ledger = emptyLedger();
  const pass100 = apply(ledger, review({ review_id: 100 }));
  assert.equal(pass100.outcome.status, 'READY_TO_MERGE');
  ledger = pass100.ledger;
  const pass200 = apply(ledger, review({ review_id: 200 }));
  assert.equal(pass200.outcome.status, 'READY_TO_MERGE');
  ledger = pass200.ledger;
  const failed = apply(ledger, review({ review_id: 300, verdict: 'FAIL' }));
  assert.equal(failed.outcome.status, 'READINESS_REVOKED');
  ledger = failed.ledger;
  const floor = Object.values(ledger.bound_reviews)[0].revoked_review_ids;
  assert.deepEqual(floor, [100, 200, 300]);
  const replay100 = apply(ledger, review({ review_id: 100 }));
  assert.equal(replay100.outcome.status, 'STALE_REVIEW');
  assert.notEqual(replay100.outcome.status, 'READY_TO_MERGE');
  const replay200 = apply(ledger, review({ review_id: 200 }));
  assert.equal(replay200.outcome.status, 'STALE_REVIEW');
  assert.notEqual(replay200.outcome.status, 'READY_TO_MERGE');
  assert.equal(Object.values(replay200.ledger.bound_reviews)[0].revoked, true);
  const pass400 = apply(ledger, review({ review_id: 400 }));
  assert.equal(pass400.outcome.status, 'READY_TO_MERGE');
  const repeated400 = apply(pass400.ledger, review({ review_id: 400, ci: null }));
  assert.equal(repeated400.outcome.status, 'REVIEW_REUSED');
  assert.equal(Object.keys(repeated400.ledger.bound_reviews).length, 1);
  const late100 = apply(pass400.ledger, review({ review_id: 100 }));
  assert.equal(late100.outcome.status, 'STALE_REVIEW');
  assert.notEqual(late100.outcome.status, 'READY_TO_MERGE');
  assert.equal(Object.values(late100.ledger.bound_reviews)[0].review_id, 400);
  assert.equal(Object.values(late100.ledger.bound_reviews)[0].revoked, false);
  const replayFail = apply(pass400.ledger, review({ review_id: 300, verdict: 'FAIL' }));
  assert.equal(replayFail.outcome.status, 'STALE_REVIEW');
  assert.equal(Object.values(replayFail.ledger.bound_reviews)[0].review_id, 400);
  assert.equal(Object.values(replayFail.ledger.bound_reviews)[0].revoked, false);
});

test('a pass stays blocked while the matching cursor task is still occupied', () => {
  let ledger = apply(emptyLedger(), request({ pr: 81, task_id: 'REVIEW-1' })).ledger;
  assert.equal(ledger.slots['81'].phase, 'REQUESTED');
  assert.equal(ledger.slots['81'].occupied, true);
  const early = apply(ledger, review({ review_id: 8601 }));
  assert.equal(early.outcome.status, 'BLOCKED_NO_COMMIT');
  assert.notEqual(early.outcome.status, 'READY_TO_MERGE');
  const started = apply(early.ledger, snapshot({
    event: 'admission_started',
    pr: 81,
    head_sha: HEAD,
    pull_base_sha: BASE,
    adapter: {
      source: 'trusted_adapter',
      kind: 'started',
      pr: 81,
      task_id: 'REVIEW-1',
      agent_id: early.ledger.slots['81'].agent_id,
      ack: true,
      executor: 'cursor',
      head_sha: HEAD,
      base_sha: BASE,
    },
  }));
  assert.equal(started.outcome.status, 'STARTED');
  const stillEarly = apply(started.ledger, review({ review_id: 8601 }));
  assert.equal(stillEarly.outcome.status, 'BLOCKED_NO_COMMIT');
  const completed = complete(stillEarly.ledger, 81, 'REVIEW-1');
  assert.equal(completed.outcome.status, 'COMPLETED');
  const ready = apply(completed.ledger, review({ review_id: 8602, head_sha: NEXT }));
  assert.equal(ready.outcome.status, 'READY_TO_MERGE');
  const oldHead = apply(completed.ledger, review({ review_id: 8601 }));
  assert.notEqual(oldHead.outcome.status, 'READY_TO_MERGE');
});

test('a review cannot drop dependencies captured when the task was queued', () => {
  let ledger = apply(emptyLedger(), request({ pr: 91, task_id: 'WAIT', depends_on: ['DEP-WAIT'], priority: 'FREE' })).ledger;
  assert.equal(ledger.queue.some(item => item.task_id === 'WAIT'), true);
  const dropped = apply(ledger, review({ pr: 91, task_id: 'WAIT', review_id: 8401, depends_on: [] }));
  assert.equal(dropped.outcome.status, 'DEPENDENCY_MISMATCH');
  assert.notEqual(dropped.outcome.status, 'READY_TO_MERGE');
  assert.equal(dropped.ledger.queue.some(item => item.task_id === 'WAIT'), true);

  ledger = apply(dropped.ledger, request({ pr: 92, task_id: 'DEP-WAIT' })).ledger;
  ledger = complete(ledger, 92, 'DEP-WAIT').ledger;
  assert.equal(ledger.slots['91'].occupied, true);
  const occupied = apply(ledger, review({ pr: 91, task_id: 'WAIT', review_id: 8401, depends_on: ['DEP-WAIT'] }));
  assert.equal(occupied.outcome.status, 'BLOCKED_NO_COMMIT');
  assert.notEqual(occupied.outcome.status, 'READY_TO_MERGE');
  const finished = complete(occupied.ledger, 91, 'WAIT');
  assert.equal(finished.outcome.status, 'COMPLETED');
  const matched = apply(finished.ledger, review({ pr: 91, task_id: 'WAIT', review_id: 8402, head_sha: NEXT, depends_on: ['DEP-WAIT'] }));
  assert.equal(matched.outcome.status, 'READY_TO_MERGE');
});

test('closing or drafting a pull request releases its slot for the next task', () => {
  let ledger = emptyLedger();
  for (let index = 1; index <= CURSOR_SLOT_LIMIT; index += 1) {
    ledger = apply(ledger, request({ pr: 900 + index, task_id: `HOLD${index}`, now: `2026-10-15T09:0${index}:00.000Z` })).ledger;
  }
  ledger = apply(ledger, request({ pr: 906, task_id: 'HOLD6', now: '2026-10-15T09:06:00.000Z' })).ledger;
  assert.equal(occupiedCount(ledger), 5);
  const closed = apply(ledger, snapshot({ event: 'admission_completed', pr: 901, state: 'closed', head_sha: HEAD }));
  ledger = closed.ledger;
  assert.equal(closed.outcome.status, 'IGNORED_CLOSED');
  assert.equal(ledger.slots['901'].occupied, false);
  assert.equal(ledger.slots['901'].phase, 'CANCELLED');
  assert.equal(ledger.slots['906'].task_id, 'HOLD6');
  assert.equal(ledger.slots['906'].occupied, true);

  const drafted = apply(ledger, snapshot({ event: 'admission_started', pr: 902, draft: true, head_sha: HEAD }));
  assert.equal(drafted.outcome.status, 'IGNORED_DRAFT');
  assert.equal(drafted.ledger.slots['902'].occupied, false);
  assert.equal(drafted.ledger.slots['902'].phase, 'CANCELLED');
});

test('a Codex finding waits for a Cursor slot and an omitted head cannot look ready', () => {
  let ledger = emptyLedger();
  for (let index = 1; index <= CURSOR_SLOT_LIMIT; index += 1) {
    ledger = apply(ledger, request({ pr: 700 + index, task_id: `FULL${index}` })).ledger;
  }
  const finding = apply(ledger, {
    now: '2026-10-15T10:00:00.000Z',
    repository: 'krzysztofsyska/skillcheck-core',
    event: { name: 'pull_request_review', action: 'submitted' },
    sender: { ...CODEX_REVIEWER },
    pull: {
      number: 126,
      state: 'open',
      draft: false,
      baseRef: 'integration',
      headSha: HEAD,
      author: { ...AUTHOR },
      headRepo: 'krzysztofsyska/skillcheck-core',
    },
    review: {
      id: 8801,
      state: 'changes_requested',
      commitId: HEAD,
      user: { ...CODEX_REVIEWER },
    },
    threads: [{
      id: 'thread-88',
      isResolved: false,
      isOutdated: false,
      comments: [{ id: 88, commitId: HEAD, reviewId: 8801, inReplyToId: null, path: 'docs/automation/codex-cursor-handoff-approval.md', line: 4 }],
    }],
  });
  assert.equal(finding.outcome.status, 'WAITING_CAPACITY');
  assert.equal(finding.outcome.plan.cursor_handoff, null);
  assert.equal(finding.ledger.attempts['126'], undefined);
  assert.equal(occupiedCount(finding.ledger), 5);

  const omitted = review({ review_id: 8802 });
  delete omitted.adapter.head_sha;
  omitted.adapter.ci = { conclusion: 'success' };
  const hidden = apply(emptyLedger(), omitted);
  assert.equal(hidden.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(hidden.outcome.stage.sha, null);
  assert.equal(hidden.ledger.audits.at(-1).sha, null);
  assert.deepEqual(hidden.ledger.bound_reviews, {});
});

test('a started remote task stays reserved until cancellation evidence frees the queue', () => {
  let ledger = emptyLedger();
  for (let index = 1; index <= CURSOR_SLOT_LIMIT; index += 1) {
    ledger = apply(ledger, request({ pr: 400 + index, task_id: `S${index}`, now: `2026-10-15T12:0${index}:00.000Z` })).ledger;
  }
  const agentId = ledger.slots['401'].agent_id;
  ledger = apply(ledger, snapshot({
    event: 'admission_started',
    pr: 401,
    adapter: { source: 'trusted_adapter', kind: 'started', pr: 401, task_id: 'S1', agent_id: agentId, ack: true, executor: 'cursor', head_sha: HEAD },
  })).ledger;
  ledger = apply(ledger, request({ pr: 406, task_id: 'S6', now: '2026-10-15T12:06:00.000Z' })).ledger;
  const closed = apply(ledger, snapshot({ event: 'admission_completed', pr: 401, state: 'closed', head_sha: HEAD }));
  assert.equal(closed.outcome.status, 'IGNORED_CLOSED');
  assert.notEqual(closed.outcome.status, 'CANCELLED');
  assert.equal(closed.outcome.stage.blocker, 'RECONCILE_REQUIRED');
  assert.equal(closed.ledger.slots['401'].occupied, true);
  assert.equal(closed.ledger.slots['401'].phase, 'CANCEL_PENDING');
  assert.equal(closed.ledger.slots['406'], undefined);
  assert.equal(occupiedCount(closed.ledger), 5);

  const mismatch = apply(closed.ledger, snapshot({
    event: 'admission_completed',
    pr: 401,
    state: 'closed',
    head_sha: HEAD,
    adapter: { source: 'trusted_adapter', kind: 'cancelled', pr: 401, task_id: 'OTHER', agent_id: agentId, cancelled: true, executor: 'cursor', head_sha: HEAD },
  }));
  assert.equal(mismatch.ledger.slots['401'].occupied, true);
  assert.equal(mismatch.ledger.slots['401'].phase, 'CANCEL_PENDING');
  assert.equal(mismatch.ledger.slots['406'], undefined);

  const cancelled = apply(mismatch.ledger, snapshot({
    event: 'admission_completed',
    pr: 401,
    state: 'closed',
    head_sha: HEAD,
    adapter: { source: 'trusted_adapter', kind: 'cancelled', pr: 401, task_id: 'S1', agent_id: agentId, cancelled: true, executor: 'cursor', head_sha: HEAD },
  }));
  assert.equal(cancelled.outcome.status, 'CANCELLED');
  assert.equal(cancelled.ledger.slots['401'].occupied, false);
  assert.equal(cancelled.ledger.slots['406'].task_id, 'S6');
  assert.equal(cancelled.ledger.slots['406'].occupied, true);
});

test('submitted review time orders a delayed pass and a delayed failure', () => {
  const at = minute => `2026-10-15T12:${String(minute).padStart(2, '0')}:00Z`;
  const failedFirst = apply(emptyLedger(), review({ review_id: 200, verdict: 'FAIL', submitted_at: at(20) }));
  assert.equal(failedFirst.outcome.status, 'READINESS_REVOKED');
  const unseenPass = apply(failedFirst.ledger, review({ review_id: 100, submitted_at: at(10) }));
  assert.equal(unseenPass.outcome.status, 'STALE_REVIEW');
  assert.notEqual(unseenPass.outcome.status, 'READY_TO_MERGE');

  const pass400 = apply(emptyLedger(), review({ review_id: 400, submitted_at: at(40) }));
  assert.equal(pass400.outcome.status, 'READY_TO_MERGE');
  const delayedFail = apply(pass400.ledger, review({ review_id: 300, verdict: 'FAIL', submitted_at: at(30) }));
  assert.equal(delayedFail.outcome.status, 'STALE_REVIEW');
  assert.equal(Object.values(delayedFail.ledger.bound_reviews)[0].review_id, 400);
  assert.equal(Object.values(delayedFail.ledger.bound_reviews)[0].revoked, false);
  const sameSecond = apply(pass400.ledger, review({ review_id: 500, verdict: 'FAIL', submitted_at: at(40) }));
  assert.equal(sameSecond.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(sameSecond.outcome.plan.cursor_handoff, null);
  assert.equal(Object.values(sameSecond.ledger.bound_reviews)[0].revoked, true);
  const replaySame = apply(sameSecond.ledger, review({ review_id: 400, submitted_at: at(40) }));
  assert.equal(replaySame.outcome.status, 'STALE_REVIEW');
  assert.notEqual(replaySame.outcome.status, 'READY_TO_MERGE');
  assert.equal(Object.values(replaySame.ledger.bound_reviews)[0].revoked, true);
  const later = apply(sameSecond.ledger, review({ review_id: 600, submitted_at: at(50) }));
  assert.equal(later.outcome.status, 'READY_TO_MERGE');
  const unordered = apply(pass400.ledger, review({ review_id: 501, verdict: 'FAIL' }));
  assert.equal(unordered.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(unordered.outcome.plan.cursor_handoff, null);
  assert.equal(Object.values(unordered.ledger.bound_reviews)[0].revoked, true);
  const replayUntimed = apply(unordered.ledger, review({ review_id: 400, submitted_at: at(40) }));
  assert.notEqual(replayUntimed.outcome.status, 'READY_TO_MERGE');
  assert.equal(Object.values(replayUntimed.ledger.bound_reviews)[0].revoked, true);
});

test('completing a dependency returns every admitted task once', () => {
  let ledger = apply(emptyLedger(), request({ pr: 1, task_id: 'DEP' })).ledger;
  for (let index = 1; index <= 6; index += 1) {
    ledger = apply(ledger, request({ pr: 10 + index, task_id: `TASK-${index}`, depends_on: ['DEP'], now: `2026-10-15T13:0${index}:00.000Z` })).ledger;
    assert.equal(ledger.slots[String(10 + index)], undefined);
  }
  const done = complete(ledger, 1, 'DEP');
  assert.equal(done.outcome.status, 'COMPLETED');
  assert.equal(done.outcome.plan.admitted.length, 5);
  assert.equal(new Set(done.outcome.plan.admitted.map(item => item.task_id)).size, 5);
  for (const plan of done.outcome.plan.admitted) {
    assert.equal(typeof plan.agent_id, 'string');
    assert.equal(plan.agent_id.length > 0, true);
    assert.equal(plan.pr, plan.task_id.replace('TASK-', '1'));
    assert.equal(plan.sha, HEAD);
    assert.equal(done.ledger.slots[plan.pr].occupied, true);
    assert.equal(done.ledger.slots[plan.pr].agent_id, plan.agent_id);
  }
  assert.equal(done.ledger.queue.map(item => item.task_id).join(','), 'TASK-6');
  assert.equal(occupiedCount(done.ledger), 5);
  const repeated = complete(done.ledger, 1, 'DEP');
  assert.equal(repeated.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.equal(repeated.outcome.plan.admitted, null);
  assert.equal(repeated.ledger.queue.map(item => item.task_id).join(','), 'TASK-6');
  const first = done.outcome.plan.admitted[0];
  const next = complete(done.ledger, Number(first.pr), first.task_id);
  assert.equal(next.outcome.plan.admitted.length, 1);
  assert.equal(next.outcome.plan.admitted[0].task_id, 'TASK-6');
  assert.equal(next.ledger.queue.length, 0);
});

test('an uncertain transport keeps its reservation and never calls the executor', async () => {
  let calls = 0;
  const operation = async () => {
    calls += 1;
  };
  const first = await dispatchAdmission(emptyLedger(), request({ pr: 51, task_id: 'UNK' }), operation);
  assert.equal(calls, 0);
  assert.equal(first.ledger.slots['51'].phase, 'REQUESTED');
  const uncertain = await dispatchAdmission(first.ledger, {
    ...request({ pr: 51, task_id: 'UNK' }),
    error: { timeout: true },
    transport: { outcome: 'unknown' },
    adapter: { ...request({ pr: 51, task_id: 'UNK' }).adapter, agent_id: first.ledger.slots['51'].agent_id },
  }, operation);
  assert.equal(calls, 0);
  assert.equal(uncertain.outcome.status, 'RECONCILE_REQUIRED');
  assert.equal(uncertain.ledger.slots['51'].phase, 'DISPATCH_UNKNOWN');
  assert.equal(uncertain.ledger.slots['51'].occupied, true);
  const retry = await dispatchAdmission(uncertain.ledger, request({ pr: 51, task_id: 'UNK-2' }), operation);
  assert.equal(calls, 0);
  assert.equal(retry.outcome.status, 'RECONCILE_REQUIRED');
  assert.equal(occupiedCount(retry.ledger), 1);
  assert.equal(retry.outcome.live_effects, 'blocked');
  assert.deepEqual(retry.outcome.executed, []);
  const drafted = apply(retry.ledger, snapshot({ event: 'admission_completed', pr: 51, draft: true, head_sha: HEAD }));
  assert.equal(drafted.outcome.status, 'IGNORED_DRAFT');
  assert.equal(drafted.ledger.slots['51'].phase, 'DISPATCH_UNKNOWN');
  assert.equal(drafted.ledger.slots['51'].occupied, true);
  assert.notEqual(drafted.ledger.slots['51'].phase, 'CANCELLED');

  const readTimeout = await dispatchAdmission(emptyLedger(), {
    ...request({ pr: 52, task_id: 'READ' }),
    event: { name: 'ci_completed', action: 'observed' },
    error: { timeout: true },
    adapter: undefined,
  }, operation);
  assert.equal(calls, 0);
  assert.equal(readTimeout.outcome.status, 'BLOCKED_INTEGRATION');
  assert.equal(occupiedCount(readTimeout.ledger), 0);
  const invented = await dispatchAdmission(emptyLedger(), {
    ...request({ pr: 53, task_id: 'GHOST' }),
    error: { timeout: true },
    adapter: { ...request({ pr: 53, task_id: 'GHOST' }).adapter, kind: 'dispatch_unknown', agent_id: 'bc-nobody' },
  }, operation);
  assert.equal(calls, 0);
  assert.equal(invented.outcome.status, 'BLOCKED_INTEGRATION');
  assert.equal(invented.ledger.slots['53'], undefined);
});

test('a dispatch without a task id occupies no slot', () => {
  let ledger = emptyLedger();
  for (const taskId of [undefined, null, '', '   ']) {
    const blocked = apply(ledger, request({ pr: 70, task_id: taskId }));
    assert.equal(blocked.outcome.status, 'BLOCKED_EVIDENCE');
    assert.equal(blocked.outcome.plan.admitted, null);
    assert.equal(occupiedCount(blocked.ledger), 0);
    assert.equal(blocked.ledger.queue.length, 0);
    assert.equal(blocked.ledger.slots['70'], undefined);
    ledger = blocked.ledger;
  }
  assert.equal(Object.values(ledger.slots).some(slot => slot.task_id === 'undefined' || slot.task_id === 'null'), false);
  const admitted = apply(ledger, request({ pr: 71, task_id: 'REAL-71' }));
  assert.equal(admitted.outcome.status, 'REQUESTED');
  assert.equal(admitted.ledger.slots['71'].task_id, 'REAL-71');
  assert.equal(occupiedCount(admitted.ledger), 1);
});

test('a new revision of a completed task does not unlock its dependents', () => {
  const nextHead = 'f'.repeat(40);
  let ledger = apply(emptyLedger(), request({ pr: 1, task_id: 'A', task_revision: 1 })).ledger;
  const rev1Agent = ledger.slots['1'].agent_id;
  assert.equal(ledger.slots['1'].task_revision, 1);
  ledger = apply(ledger, snapshot({
    event: 'admission_started',
    pr: 1,
    adapter: { source: 'trusted_adapter', kind: 'started', pr: 1, task_id: 'A', task_revision: 1, agent_id: rev1Agent, ack: true, executor: 'cursor', head_sha: HEAD },
  })).ledger;
  const done = complete(ledger, 1, 'A', NEXT);
  assert.equal(done.outcome.status, 'COMPLETED');
  assert.equal(done.ledger.completed_tasks.A.task_revision, 1);
  assert.equal(done.ledger.completed_tasks.A.head_sha, NEXT);
  ledger = done.ledger;

  const rev2 = apply(ledger, request({ pr: 3, task_id: 'A', task_revision: 2, head_sha: NEXT, now: '2026-10-15T13:00:00.000Z' }));
  assert.equal(rev2.outcome.status, 'REQUESTED');
  assert.equal(rev2.ledger.completed_tasks.A.task_revision, 1);
  assert.equal(rev2.ledger.completed_tasks.A.head_sha, NEXT);
  assert.equal(rev2.ledger.completed_tasks.A.current, false);
  const rev2Agent = rev2.ledger.slots['3'].agent_id;
  assert.notEqual(rev2Agent, rev1Agent);
  ledger = apply(rev2.ledger, snapshot({
    event: 'admission_started',
    pr: 3,
    head_sha: NEXT,
    adapter: { source: 'trusted_adapter', kind: 'started', pr: 3, task_id: 'A', task_revision: 2, agent_id: rev2Agent, ack: true, executor: 'cursor', head_sha: NEXT },
  })).ledger;
  assert.equal(ledger.slots['3'].phase, 'STARTED');

  const waiting = apply(ledger, request({ pr: 4, task_id: 'B', depends_on: ['A'], now: '2026-10-15T13:01:00.000Z' }));
  assert.equal(waiting.outcome.status, 'WAITING_DEPENDENCY');
  assert.equal(waiting.ledger.slots['4'], undefined);
  ledger = waiting.ledger;

  const replay = apply(ledger, snapshot({
    event: 'admission_completed',
    pr: 3,
    head_sha: nextHead,
    adapter: { source: 'trusted_adapter', kind: 'completed', pr: 3, task_id: 'A', task_revision: 1, agent_id: rev1Agent, ack: true, executor: 'cursor', head_sha: nextHead },
  }));
  assert.equal(replay.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.equal(replay.ledger.slots['4'], undefined);
  assert.equal(replay.ledger.completed_tasks.A.task_revision, 1);
  assert.equal(replay.ledger.completed_tasks.A.head_sha, NEXT);
  assert.equal(replay.ledger.completed_tasks.A.current, false);
  const wrongAgent = apply(replay.ledger, snapshot({
    event: 'admission_completed',
    pr: 3,
    head_sha: nextHead,
    adapter: { source: 'trusted_adapter', kind: 'completed', pr: 3, task_id: 'A', task_revision: 2, agent_id: 'bc-other', ack: true, executor: 'cursor', head_sha: nextHead },
  }));
  assert.equal(wrongAgent.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.equal(wrongAgent.ledger.slots['4'], undefined);

  ledger = wrongAgent.ledger;
  for (let index = 1; index <= 4; index += 1) {
    ledger = apply(ledger, request({ pr: 30 + index, task_id: `FILL${index}`, now: `2026-10-15T13:0${index + 1}:00.000Z` })).ledger;
  }
  assert.equal(occupiedCount(ledger), 5);
  const finished = apply(ledger, snapshot({
    event: 'admission_completed',
    pr: 3,
    head_sha: nextHead,
    adapter: { source: 'trusted_adapter', kind: 'completed', pr: 3, task_id: 'A', task_revision: 2, agent_id: rev2Agent, ack: true, executor: 'cursor', head_sha: nextHead },
  }));
  assert.equal(finished.outcome.status, 'COMPLETED');
  assert.equal(finished.ledger.completed_tasks.A.task_revision, 2);
  assert.equal(finished.ledger.completed_tasks.A.head_sha, nextHead);
  assert.equal(finished.ledger.slots['4'].task_id, 'B');
  assert.equal(finished.ledger.slots['4'].occupied, true);
  assert.equal(finished.outcome.plan.admitted.filter(item => item.task_id === 'B').length, 1);
  assert.equal(occupiedCount(finished.ledger) <= CURSOR_SLOT_LIMIT, true);
  const again = apply(finished.ledger, snapshot({
    event: 'admission_completed',
    pr: 3,
    head_sha: nextHead,
    adapter: { source: 'trusted_adapter', kind: 'completed', pr: 3, task_id: 'A', task_revision: 2, agent_id: rev2Agent, ack: true, executor: 'cursor', head_sha: nextHead },
  }));
  assert.equal(again.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.equal(again.ledger.slots['4'].occupied, true);
});

test('an identical dispatch after completion is a duplicate and an older generation cannot reset the newest proof', () => {
  let ledger = apply(emptyLedger(), request({ pr: 1, task_id: 'A', task_revision: 1 })).ledger;
  const rev1Agent = ledger.slots['1'].agent_id;
  ledger = apply(ledger, snapshot({
    event: 'admission_started',
    pr: 1,
    adapter: { source: 'trusted_adapter', kind: 'started', pr: 1, task_id: 'A', task_revision: 1, agent_id: rev1Agent, ack: true, executor: 'cursor', head_sha: HEAD },
  })).ledger;
  const done = complete(ledger, 1, 'A', NEXT);
  assert.equal(done.outcome.status, 'COMPLETED');
  const proof = done.ledger.completed_tasks.A;
  assert.equal(proof.task_id, 'A');
  assert.equal(proof.task_revision, 1);
  assert.equal(proof.requested_head_sha, HEAD);
  assert.equal(proof.requested_base_sha, BASE);
  assert.equal(proof.head_sha, NEXT);
  assert.equal(proof.base_sha, BASE);
  assert.equal(proof.agent_id, rev1Agent);
  assert.equal(proof.current, true);
  ledger = done.ledger;

  const duplicate = apply(ledger, request({ pr: 1, task_id: 'A', task_revision: 1 }));
  assert.equal(duplicate.outcome.status, 'DUPLICATE_DISPATCH');
  assert.equal(duplicate.outcome.plan.cursor_handoff, null);
  assert.equal(duplicate.outcome.plan.admitted, null);
  assert.equal(duplicate.outcome.agent_id, rev1Agent);
  assert.equal(duplicate.ledger.queue.length, 0);
  assert.equal(duplicate.ledger.slots['1'].phase, 'COMPLETED');
  assert.equal(duplicate.ledger.slots['1'].occupied, false);
  assert.equal(duplicate.ledger.slots['1'].agent_id, rev1Agent);
  assert.deepEqual(duplicate.ledger.completed_tasks.A, proof);
  ledger = duplicate.ledger;

  const replay = apply(ledger, snapshot({
    event: 'admission_completed',
    pr: 1,
    head_sha: NEXT,
    adapter: { source: 'trusted_adapter', kind: 'completed', pr: 1, task_id: 'A', task_revision: 1, agent_id: rev1Agent, ack: true, executor: 'cursor', head_sha: NEXT },
  }));
  assert.equal(replay.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.equal(replay.outcome.plan.cursor_handoff, null);
  assert.equal(replay.outcome.plan.admitted, null);
  assert.deepEqual(replay.ledger.completed_tasks.A, proof);
  assert.equal(replay.ledger.slots['1'].phase, 'COMPLETED');
  assert.equal(replay.ledger.queue.length, 0);
  ledger = replay.ledger;

  const nextHead = 'f'.repeat(40);
  const rev2 = apply(ledger, request({ pr: 3, task_id: 'A', task_revision: 2, head_sha: NEXT, now: '2026-10-15T13:00:00.000Z' }));
  assert.equal(rev2.outcome.status, 'REQUESTED');
  const rev2Agent = rev2.ledger.slots['3'].agent_id;
  assert.notEqual(rev2Agent, rev1Agent);
  assert.equal(rev2.ledger.completed_tasks.A.current, false);
  assert.equal(rev2.ledger.completed_tasks.A.task_revision, 1);
  assert.equal(rev2.ledger.completed_tasks.A.head_sha, NEXT);
  assert.equal(rev2.ledger.completed_tasks.A.agent_id, rev1Agent);
  ledger = apply(rev2.ledger, snapshot({
    event: 'admission_started',
    pr: 3,
    head_sha: NEXT,
    adapter: { source: 'trusted_adapter', kind: 'started', pr: 3, task_id: 'A', task_revision: 2, agent_id: rev2Agent, ack: true, executor: 'cursor', head_sha: NEXT },
  })).ledger;
  assert.equal(ledger.slots['3'].phase, 'STARTED');

  const waiting = apply(ledger, request({ pr: 4, task_id: 'B', depends_on: ['A'], now: '2026-10-15T13:01:00.000Z' }));
  assert.equal(waiting.outcome.status, 'WAITING_DEPENDENCY');
  assert.equal(waiting.ledger.slots['4'], undefined);
  ledger = waiting.ledger;
  const oldWhileOpen = apply(ledger, request({ pr: 1, task_id: 'A', task_revision: 1, now: '2026-10-15T13:02:00.000Z' }));
  assert.equal(oldWhileOpen.outcome.status, 'DUPLICATE_DISPATCH');
  assert.equal(oldWhileOpen.outcome.plan.cursor_handoff, null);
  assert.equal(oldWhileOpen.outcome.plan.admitted, null);
  assert.equal(oldWhileOpen.ledger.completed_tasks.A.task_revision, 1);
  assert.equal(oldWhileOpen.ledger.completed_tasks.A.current, false);
  assert.equal(oldWhileOpen.ledger.slots['3'].phase, 'STARTED');
  assert.equal(oldWhileOpen.ledger.slots['4'], undefined);
  ledger = oldWhileOpen.ledger;
  for (let index = 1; index <= 4; index += 1) {
    ledger = apply(ledger, request({ pr: 40 + index, task_id: `HOLD${index}`, now: `2026-10-15T13:0${index + 2}:00.000Z` })).ledger;
  }
  assert.equal(occupiedCount(ledger), 5);
  const finished = apply(ledger, snapshot({
    event: 'admission_completed',
    pr: 3,
    head_sha: nextHead,
    adapter: { source: 'trusted_adapter', kind: 'completed', pr: 3, task_id: 'A', task_revision: 2, agent_id: rev2Agent, ack: true, executor: 'cursor', head_sha: nextHead },
  }));
  assert.equal(finished.outcome.status, 'COMPLETED');
  assert.equal(finished.ledger.completed_tasks.A.task_revision, 2);
  assert.equal(finished.ledger.completed_tasks.A.requested_head_sha, NEXT);
  assert.equal(finished.ledger.completed_tasks.A.requested_base_sha, BASE);
  assert.equal(finished.ledger.completed_tasks.A.head_sha, nextHead);
  assert.equal(finished.ledger.completed_tasks.A.agent_id, rev2Agent);
  assert.equal(finished.ledger.completed_tasks.A.current, true);
  assert.equal(finished.ledger.slots['4'].task_id, 'B');
  assert.equal(finished.ledger.slots['4'].occupied, true);
  assert.equal(occupiedCount(finished.ledger) <= CURSOR_SLOT_LIMIT, true);
  const newest = finished.ledger.completed_tasks.A;

  const oldRequest = apply(finished.ledger, request({ pr: 8, task_id: 'A', task_revision: 1, now: '2026-10-15T13:08:00.000Z' }));
  assert.equal(oldRequest.outcome.status, 'DUPLICATE_DISPATCH');
  assert.equal(oldRequest.outcome.plan.cursor_handoff, null);
  assert.equal(oldRequest.outcome.plan.admitted, null);
  assert.equal(oldRequest.ledger.slots['8'], undefined);
  assert.deepEqual(oldRequest.ledger.completed_tasks.A, newest);
  assert.equal(oldRequest.ledger.slots['4'].occupied, true);
  const oldComplete = apply(oldRequest.ledger, snapshot({
    event: 'admission_completed',
    pr: 3,
    head_sha: NEXT,
    adapter: { source: 'trusted_adapter', kind: 'completed', pr: 3, task_id: 'A', task_revision: 1, agent_id: rev1Agent, ack: true, executor: 'cursor', head_sha: NEXT },
  }));
  assert.equal(oldComplete.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.equal(oldComplete.outcome.plan.cursor_handoff, null);
  assert.equal(oldComplete.outcome.plan.admitted, null);
  assert.deepEqual(oldComplete.ledger.completed_tasks.A, newest);
  assert.equal(oldComplete.ledger.slots['4'].occupied, true);
  assert.equal(oldComplete.ledger.slots['3'].phase, 'COMPLETED');
  assert.equal(occupiedCount(oldComplete.ledger) <= CURSOR_SLOT_LIMIT, true);
});

function complete(ledger, pr, taskId, head = NEXT) {
  return apply(ledger, snapshot({
    event: 'admission_completed',
    pr,
    head_sha: head,
    adapter: {
      source: 'trusted_adapter',
      kind: 'completed',
      pr,
      task_id: taskId,
      agent_id: agentFor(taskId),
      ack: true,
      head_sha: head,
      executor: 'cursor',
      tests: { suite: 'agent-pipeline', result: 'pass' },
    },
  }));
}

function review(fields) {
  const head = fields.head_sha ?? HEAD;
  const base = fields.base_sha ?? BASE;
  return snapshot({
    event: 'admission_review',
    pr: fields.pr ?? 81,
    head_sha: head,
    pull_base_sha: Object.hasOwn(fields, 'pull_base_sha') ? fields.pull_base_sha : base,
    review_id: fields.review_id,
    sender: fields.sender ?? { ...CODEX_REVIEWER },
    reviewer: fields.reviewer ?? { ...CODEX_REVIEWER },
    author: fields.author ?? { ...AUTHOR },
    adapter: {
      source: 'trusted_adapter',
      kind: 'review',
      pr: fields.pr ?? 81,
      task_id: fields.task_id ?? 'REVIEW-1',
      executor: fields.executor ?? 'codex',
      head_sha: head,
      base_sha: base,
      conditions: fields.conditions ?? CONDITIONS,
      verdict: fields.verdict ?? 'PASS',
      reuse_binding: fields.reuse_binding === true,
      depends_on: fields.depends_on ?? [],
      findings: fields.findings ?? [],
      ci: fields.ci === undefined ? { sha: head, conclusion: 'success' } : fields.ci,
      tests: fields.tests ?? { suite: 'agent-pipeline', result: 'pass' },
      fix_author: fields.fix_author ?? { id: 7, login: 'cursor[bot]', type: 'Bot' },
      submitted_at: fields.submitted_at ?? null,
    },
  });
}
