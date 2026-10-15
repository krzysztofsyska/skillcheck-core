import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { parseContract } from '../../tools/agent-pipeline/lib/contract.mjs';
import { createGitHubClient } from '../../tools/agent-pipeline/lib/github.mjs';
import { runHandoffCli } from '../../tools/agent-pipeline/handoff-cli.mjs';
import { agentIdFor, operationKey, sha256 } from '../../tools/agent-pipeline/lib/canonical.mjs';
import { buildCiEnvelope } from '../../tools/agent-pipeline/lib/ci.mjs';
import { occupiedCount, releasePull } from '../../tools/agent-pipeline/lib/handoff-admission.mjs';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { plan, requiredReviewChecks } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { contractBody, observation, taskRecord } from './helpers.mjs';
import {
  CODEX_REVIEWER,
  CURSOR_HANDOFF_TEMPLATE,
  HANDOFF_ATTEMPT_LIMIT,
  LIVE_EFFECTS_ENABLED,
  dedupKey,
  deliverGithubReview,
  emptyLedger,
  observeStructuralReview,
  handoffIdFor,
  normalizeGithubEvent,
  step,
} from '../../tools/agent-pipeline/lib/handoff-loop.mjs';

const SHA = {
  one: 'a'.repeat(40),
  two: 'b'.repeat(40),
  three: 'c'.repeat(40),
  four: 'd'.repeat(40),
  base: 'e'.repeat(40),
};
const CURSOR_ACTOR = { id: 7, login: 'cursor[bot]', type: 'Bot' };
const AUTHOR = { id: 222297538, login: 'krzysztofsyska', type: 'User' };
const SENTINEL = 'LEAK_$(reboot)_/etc/passwd';

function reviewSnapshot(overrides = {}) {
  const headSha = overrides.headSha ?? SHA.one;
  const reviewId = overrides.reviewId ?? 5445420558;
  return {
    now: overrides.now ?? '2026-10-14T07:30:00.000Z',
    repository: 'krzysztofsyska/skillcheck-core',
    event: { name: overrides.event ?? 'pull_request_review', action: 'submitted' },
    sender: overrides.sender ?? { ...CODEX_REVIEWER },
    pull: {
      number: overrides.pr ?? 126,
      state: overrides.state ?? 'open',
      draft: overrides.draft ?? false,
      baseRef: overrides.baseRef ?? 'integration',
      baseSha: overrides.baseSha ?? null,
      headSha,
      author: overrides.author ?? { ...AUTHOR },
      headRepo: overrides.headRepo ?? 'krzysztofsyska/skillcheck-core',
    },
    review: {
      id: reviewId,
      state: overrides.reviewState ?? 'changes_requested',
      commitId: overrides.commitId ?? headSha,
      user: overrides.reviewer ?? { ...CODEX_REVIEWER },
    },
    threads: overrides.threads ?? [thread(10, reviewId, headSha)],
    ci: overrides.ci ?? null,
    fixAuthor: overrides.fixAuthor ?? null,
    error: overrides.error ?? null,
    verdict: overrides.verdict ?? null,
    adapter: overrides.adapter,
  };
}

function completeSlot(ledger, pr, nextHead) {
  const slot = ledger.slots[String(pr)];
  return reviewSnapshot({
    event: 'admission_completed',
    pr,
    headSha: nextHead,
    threads: [],
    adapter: {
      source: 'trusted_adapter',
      kind: 'completed',
      pr,
      task_id: slot.task_id,
      agent_id: slot.agent_id,
      ack: true,
      executor: 'cursor',
      head_sha: nextHead,
    },
  });
}

function thread(commentId, reviewId, sha, extra = {}) {
  return {
    id: `thread-${commentId}`,
    isResolved: extra.isResolved ?? false,
    isOutdated: extra.isOutdated ?? false,
    comments: [
      {
        id: commentId,
        commitId: extra.commitId ?? sha,
        reviewId,
        inReplyToId: extra.inReplyToId ?? null,
        path: extra.path ?? 'docs/automation/codex-cursor-handoff-approval.md',
        line: extra.line ?? 12,
        body: SENTINEL,
      },
    ],
  };
}

function apply(ledger, snapshot) {
  const result = step(ledger, snapshot);
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

test('sandbox cycle hands off once, waits for CI, then accepts only an independent Codex pass', () => {
  let ledger = emptyLedger();
  const first = apply(ledger, reviewSnapshot());
  ledger = first.ledger;
  const secondComment = apply(ledger, reviewSnapshot({ event: 'pull_request_review_comment', threads: [thread(10, 5445420558, SHA.one), thread(11, 5445420558, SHA.one)] }));
  ledger = secondComment.ledger;
  assert.equal(first.outcome.status, 'HANDOFF');
  assert.equal(first.outcome.attempt, 1);
  assert.equal(first.outcome.handoff_id, handoffIdFor('126', SHA.one, 5445420558));
  assert.equal(first.outcome.plan.cursor_handoff.template, CURSOR_HANDOFF_TEMPLATE);
  assert.deepEqual(first.outcome.findings.map(finding => finding.comment_id), [10]);
  assert.equal(secondComment.outcome.status, 'HANDOFF_UPDATED');
  assert.deepEqual(secondComment.outcome.findings.map(finding => finding.comment_id), [10, 11]);
  assert.equal(secondComment.outcome.plan.cursor_handoff.finding_refs.length, 2);
  assert.equal(ledger.attempts['126'], 1);
  assert.equal(Object.keys(ledger.reservations).length, 1);

  const sameHead = apply(ledger, reviewSnapshot({ event: 'ci_completed', ci: { sha: SHA.one, conclusion: 'success' } }));
  ledger = sameHead.ledger;
  assert.equal(sameHead.outcome.status, 'WAITING_CURSOR');
  assert.equal(sameHead.outcome.plan.codex_rereview, null);

  const pending = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, reviewId: null, threads: [], ci: { sha: SHA.two, conclusion: 'pending' } }));
  ledger = pending.ledger;
  assert.equal(pending.outcome.status, 'WAITING_CI');
  const failed = apply(ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, reviewId: null, threads: [], ci: { sha: SHA.two, conclusion: 'failure' } }));
  ledger = failed.ledger;
  assert.equal(failed.outcome.status, 'CI_FAILED');
  assert.equal(failed.outcome.plan.codex_rereview, null);

  const earlyApproval = apply(ledger, reviewSnapshot({ headSha: SHA.two, reviewId: 600, reviewState: 'approved', threads: [], ci: { sha: SHA.two, conclusion: 'failure' } }));
  ledger = earlyApproval.ledger;
  assert.equal(earlyApproval.outcome.status, 'IGNORED_APPROVAL');
  assert.equal(ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'CI_FAILED');

  const requested = apply(ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, reviewId: null, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  ledger = requested.ledger;
  const requestedAgain = apply(ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, reviewId: null, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  ledger = requestedAgain.ledger;
  assert.equal(requested.outcome.status, 'WAITING_CURSOR');
  assert.equal(requested.outcome.plan.codex_rereview, null);
  assert.equal(requested.outcome.plan.cursor_handoff, null);
  assert.equal(requestedAgain.outcome.status, 'WAITING_CURSOR');
  assert.equal(requestedAgain.outcome.plan.codex_rereview, null);
  const done = apply(ledger, completeSlot(ledger, 126, SHA.two));
  ledger = done.ledger;
  assert.equal(done.outcome.status, 'COMPLETED');
  assert.equal(done.outcome.plan.codex_rereview.sha, SHA.two);
  assert.equal(done.outcome.plan.codex_rereview.author_approval_counts, false);
  assert.equal(done.outcome.plan.codex_rereview.paid_call, false);
  assert.equal(ledger.slots['126'].occupied, false);

  const selfApproval = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 601,
    reviewState: 'approved',
    threads: [],
    reviewer: { ...AUTHOR },
    sender: { ...AUTHOR },
    ci: { sha: SHA.two, conclusion: 'success' },
    fixAuthor: { id: 7, login: 'cursor[bot]', type: 'Bot' },
  }));
  ledger = selfApproval.ledger;
  assert.equal(selfApproval.outcome.status, 'IGNORED_REVIEWER');

  const committerApproval = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 602,
    reviewState: 'approved',
    threads: [],
    reviewer: { id: 7, login: 'cursor[bot]', type: 'Bot' },
    sender: { id: 7, login: 'cursor[bot]', type: 'Bot' },
    ci: { sha: SHA.two, conclusion: 'success' },
    fixAuthor: { id: 7, login: 'cursor[bot]', type: 'Bot' },
  }));
  ledger = committerApproval.ledger;
  assert.equal(committerApproval.outcome.status, 'IGNORED_REVIEWER');

  const ready = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 603,
    reviewState: 'approved',
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
    fixAuthor: { ...CURSOR_ACTOR },
    baseSha: SHA.base,
  }));
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  assert.equal(ready.outcome.plan.owner_acceptance, false);
  assert.equal(ready.outcome.plan.production_approval, false);
  assert.equal(ready.ledger.attempts['126'], 1);
});

test('three attempts are shared across heads and the fourth review is blocked', () => {
  let ledger = emptyLedger();
  const heads = [SHA.one, SHA.two, SHA.three];
  heads.forEach((headSha, index) => {
    const result = apply(ledger, reviewSnapshot({ headSha, reviewId: 1000 + index, threads: [thread(100 + index, 1000 + index, headSha)] }));
    ledger = result.ledger;
    assert.equal(result.outcome.status, 'HANDOFF');
    assert.equal(result.outcome.attempt, index + 1);
    assert.equal(result.outcome.plan.cursor_handoff.existing_pr, true);
    if (index >= heads.length - 1) return;
    const feedback = apply(ledger, reviewSnapshot({
      headSha,
      reviewId: 2000 + index,
      threads: [thread(200 + index, 2000 + index, headSha)],
    }));
    ledger = feedback.ledger;
    assert.equal(feedback.outcome.status, 'PENDING_FEEDBACK');
    assert.equal(feedback.outcome.plan.cursor_handoff, null);
    assert.equal(feedback.outcome.pending_feedback.update, true);
    assert.equal(feedback.outcome.agent_id, ledger.slots['126'].agent_id);
    assert.equal(ledger.attempts['126'], index + 1);
    const done = apply(ledger, completeSlot(ledger, 126, heads[index + 1]));
    ledger = done.ledger;
    assert.equal(done.outcome.status, 'COMPLETED');
    assert.equal(ledger.slots['126'].occupied, false);
  });
  const blocked = apply(ledger, reviewSnapshot({ headSha: SHA.four, reviewId: 1003, threads: [thread(103, 1003, SHA.four)] }));
  assert.equal(blocked.outcome.status, 'BLOCKED_LIMIT');
  assert.equal(blocked.ledger.attempts['126'], HANDOFF_ATTEMPT_LIMIT);
  assert.equal(blocked.outcome.plan.cursor_handoff, null);
  assert.equal(blocked.ledger.reservations[dedupKey('126', SHA.three, 1002)].status, 'SUPERSEDED');
  const replay = apply(blocked.ledger, reviewSnapshot({ reviewId: 1000, threads: [thread(100, 1000, SHA.one)] }));
  assert.equal(replay.outcome.status, 'DUPLICATE');
  const advanced = apply(blocked.ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.four, threads: [], ci: { sha: SHA.four, conclusion: 'success' } }));
  assert.equal(advanced.outcome.status, 'IGNORED_NO_RESERVATION');
  const latePass = apply(advanced.ledger, reviewSnapshot({ headSha: SHA.four, reviewId: 1004, reviewState: 'commented', threads: [], verdict: 'PASS', ci: { sha: SHA.four, conclusion: 'success' } }));
  assert.notEqual(latePass.outcome.status, 'READY_FOR_OWNER');
});

test('a newer review on an active pull request updates the existing agent', () => {
  let ledger = emptyLedger();
  ledger = apply(ledger, reviewSnapshot({ reviewId: 1, threads: [thread(1, 1, SHA.one)] })).ledger;
  const agentId = ledger.slots['126'].agent_id;
  const second = apply(ledger, reviewSnapshot({ reviewId: 2, now: '2026-10-14T07:31:00.000Z', threads: [thread(2, 2, SHA.one)] }));
  ledger = second.ledger;
  assert.equal(second.outcome.status, 'PENDING_FEEDBACK');
  assert.equal(second.outcome.attempt, 1);
  assert.equal(second.outcome.plan.cursor_handoff, null);
  assert.equal(second.outcome.pending_feedback.update, true);
  assert.equal(second.outcome.pending_feedback.agent_id, agentId);
  assert.equal(second.outcome.agent_id, agentId);
  assert.deepEqual(second.outcome.pending_feedback.finding_refs.map(item => item.comment_id), [2]);
  assert.equal(ledger.reservations[dedupKey('126', SHA.one, 1)].status, 'HANDOFF_PLANNED');
  assert.equal(ledger.reservations[dedupKey('126', SHA.one, 2)], undefined);
  assert.equal(ledger.attempts['126'], 1);
  assert.equal(occupiedCount(ledger), 1);

  const requested = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  ledger = requested.ledger;
  const repeated = apply(ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(requested.outcome.status, 'WAITING_CURSOR');
  assert.equal(requested.outcome.plan.codex_rereview, null);
  assert.equal(repeated.outcome.status, 'WAITING_CURSOR');
  assert.equal(repeated.outcome.plan.codex_rereview, null);
  assert.equal(repeated.ledger.reservations[dedupKey('126', SHA.one, 1)].status, 'WAITING_CURSOR');
  const done = apply(repeated.ledger, completeSlot(repeated.ledger, 126, SHA.two));
  assert.equal(done.outcome.status, 'COMPLETED');
  assert.equal(done.outcome.plan.codex_rereview.sha, SHA.two);
  assert.equal(done.outcome.plan.codex_rereview.paid_call, false);
  const later = apply(done.ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(later.outcome.status, 'DUPLICATE');
  assert.equal(later.outcome.plan.codex_rereview, null);
  assert.equal(later.ledger.reservations[dedupKey('126', SHA.one, 1)].status, 'WAITING_REREVIEW');
});

test('a Codex PASS comment reaches ready from stored CI without a GitHub approval', () => {
  let ledger = emptyLedger();
  ledger = apply(ledger, reviewSnapshot()).ledger;
  const waiting = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  ledger = waiting.ledger;
  assert.equal(waiting.outcome.status, 'WAITING_CURSOR');
  assert.equal(waiting.outcome.plan.codex_rereview, null);
  assert.equal(ledger.reservations[dedupKey('126', SHA.one, 5445420558)].ci.conclusion, 'success');

  const beforeCompletion = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 804,
    reviewState: 'commented',
    threads: [],
    verdict: 'PASS',
    fixAuthor: { ...CURSOR_ACTOR },
    baseSha: SHA.base,
  }));
  assert.equal(beforeCompletion.outcome.status, 'IGNORED_UNREQUESTED_APPROVAL');
  assert.notEqual(beforeCompletion.outcome.status, 'READY_FOR_OWNER');
  assert.equal(beforeCompletion.ledger.slots['126'].occupied, true);

  const done = apply(ledger, completeSlot(ledger, 126, SHA.two));
  assert.equal(done.outcome.status, 'COMPLETED');
  assert.equal(done.outcome.plan.codex_rereview.sha, SHA.two);
  assert.equal(done.outcome.plan.codex_rereview.paid_call, false);
  assert.equal(done.ledger.slots['126'].occupied, false);
  ledger = done.ledger;

  const commented = apply(ledger, reviewSnapshot({ headSha: SHA.two, reviewId: 800, reviewState: 'commented', threads: [] }));
  assert.equal(commented.outcome.status, 'IGNORED_NO_FINDINGS');
  assert.equal(commented.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

  const fixes = apply(ledger, reviewSnapshot({ headSha: SHA.two, reviewId: 801, reviewState: 'approved', threads: [], verdict: 'PASS_WITH_FIXES' }));
  assert.equal(fixes.outcome.status, 'IGNORED_NO_FINDINGS');
  const failed = apply(ledger, reviewSnapshot({ headSha: SHA.two, reviewId: 802, reviewState: 'approved', threads: [], verdict: 'FAIL' }));
  assert.equal(failed.outcome.status, 'IGNORED_NO_FINDINGS');

  const authorPass = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 803,
    reviewState: 'commented',
    threads: [],
    verdict: 'PASS',
    reviewer: { ...AUTHOR },
    sender: { ...AUTHOR },
  }));
  assert.equal(authorPass.outcome.status, 'IGNORED_REVIEWER');
  assert.equal(authorPass.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

  const unproven = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 805,
    reviewState: 'commented',
    threads: [],
    verdict: 'PASS',
    baseSha: SHA.base,
  }));
  assert.equal(unproven.outcome.status, 'BLOCKED_EVIDENCE');
  const missingBase = apply(done.ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 806,
    reviewState: 'commented',
    threads: [],
    verdict: 'PASS',
    fixAuthor: { ...CURSOR_ACTOR },
  }));
  assert.equal(missingBase.outcome.status, 'BLOCKED_EVIDENCE');
  const ready = apply(done.ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 804,
    reviewState: 'commented',
    threads: [],
    verdict: 'PASS',
    fixAuthor: { ...CURSOR_ACTOR },
    baseSha: SHA.base,
  }));
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  assert.equal(ready.outcome.plan.owner_acceptance, false);
  assert.equal(ready.ledger.attempts['126'], 1);
  const after = apply(ready.ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(after.outcome.status, 'IGNORED_NO_RESERVATION');
});

test('a spoofed sender cannot accept a Codex PASS and the Codex actor cannot approve its own fix', () => {
  let ledger = emptyLedger();
  ledger = apply(ledger, reviewSnapshot()).ledger;
  const waiting = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(waiting.outcome.status, 'WAITING_CURSOR');
  assert.equal(waiting.outcome.plan.codex_rereview, null);
  const done = apply(waiting.ledger, completeSlot(waiting.ledger, 126, SHA.two));
  assert.equal(done.outcome.plan.codex_rereview.sha, SHA.two);
  ledger = done.ledger;
  const spoofed = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 900,
    reviewState: 'commented',
    threads: [],
    verdict: 'PASS',
    reviewer: { ...CODEX_REVIEWER },
    sender: { id: 1, login: 'not-codex', type: 'User' },
  }));
  assert.equal(spoofed.outcome.status, 'IGNORED_REVIEWER');
  assert.equal(spoofed.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

  const self = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 901,
    reviewState: 'commented',
    threads: [],
    verdict: 'PASS',
    author: { ...CODEX_REVIEWER },
    reviewer: { ...CODEX_REVIEWER },
    sender: { ...CODEX_REVIEWER },
    fixAuthor: { id: 7, login: 'cursor[bot]', type: 'Bot' },
  }));
  assert.equal(self.outcome.status, 'REJECTED_SELF_APPROVAL');
  assert.equal(self.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');
});

test('forks, wrong base, spoofed identity, stale threads, and integration errors do not reserve a handoff', () => {
  const cases = [
    ['IGNORED_FORK', reviewSnapshot({ headRepo: 'attacker/skillcheck-core' })],
    ['IGNORED_BASE', reviewSnapshot({ baseRef: 'main' })],
    ['IGNORED_CLOSED', reviewSnapshot({ state: 'closed' })],
    ['IGNORED_DRAFT', reviewSnapshot({ draft: true })],
    ['IGNORED_REVIEWER', reviewSnapshot({ sender: { id: CODEX_REVIEWER.id, login: CODEX_REVIEWER.login, type: 'User' } })],
    ['IGNORED_REVIEWER', reviewSnapshot({ reviewer: { id: 1, login: CODEX_REVIEWER.login, type: 'Bot' } })],
    ['IGNORED_SHA', reviewSnapshot({ commitId: SHA.two })],
    ['IGNORED_REVIEW_STATE', reviewSnapshot({ reviewState: 'dismissed' })],
    ['IGNORED_NO_FINDINGS', reviewSnapshot({ threads: [thread(10, 5445420558, SHA.one, { isResolved: true })] })],
    ['IGNORED_NO_FINDINGS', reviewSnapshot({ threads: [thread(10, 5445420558, SHA.one, { isOutdated: true })] })],
    ['IGNORED_NO_FINDINGS', reviewSnapshot({ threads: [thread(10, 5445420558, SHA.one, { inReplyToId: 9 })] })],
    ['IGNORED_NO_FINDINGS', reviewSnapshot({ threads: [thread(10, 5445420558, SHA.one, { path: '../secrets.env' })] })],
    ['BLOCKED_INTEGRATION', reviewSnapshot({ error: { status: 403 } })],
    ['BLOCKED_INTEGRATION', reviewSnapshot({ error: { status: 429 } })],
    ['BLOCKED_INTEGRATION', reviewSnapshot({ error: { status: 429, timeout: false } })],
    ['IGNORED_APPROVAL', reviewSnapshot({ reviewState: 'approved', threads: [] })],
  ];
  for (const [status, snapshot] of cases) {
    const result = apply(emptyLedger(), snapshot);
    assert.equal(result.outcome.status, status);
    assert.deepEqual(result.ledger.attempts, {});
    assert.deepEqual(result.ledger.reservations, {});
  }
});

test('a moved successor head blocks the old reservation without resetting the counter', () => {
  let ledger = emptyLedger();
  ledger = apply(ledger, reviewSnapshot()).ledger;
  ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: null })).ledger;
  const moved = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.three, threads: [], ci: { sha: SHA.three, conclusion: 'success' } }));
  assert.equal(moved.outcome.status, 'BLOCKED_HEAD');
  assert.equal(moved.ledger.attempts['126'], 1);
  assert.equal(moved.outcome.plan.codex_rereview, null);
});

test('separate pull requests keep separate attempt counters', () => {
  let ledger = emptyLedger();
  ledger = apply(ledger, reviewSnapshot({ pr: 126 })).ledger;
  const other = apply(ledger, reviewSnapshot({ pr: 127, reviewId: 9 }));
  assert.equal(other.outcome.status, 'HANDOFF');
  assert.equal(other.ledger.attempts['126'], 1);
  assert.equal(other.ledger.attempts['127'], 1);
});

test('raw review payload drops comment text before planning', () => {
  const normalized = normalizeGithubEvent({
    action: 'submitted',
    repository: { full_name: 'krzysztofsyska/skillcheck-core' },
    sender: { ...CODEX_REVIEWER },
    review: { id: 11, state: 'CHANGES_REQUESTED', commit_id: SHA.one, user: { ...CODEX_REVIEWER }, body: SENTINEL },
    pull_request: {
      number: 126,
      state: 'open',
      draft: false,
      user: { ...AUTHOR },
      base: { ref: 'integration' },
      head: { sha: SHA.one, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
    },
  }, [{
    id: 't',
    isResolved: false,
    isOutdated: false,
    comments: [{ id: 15, commit_id: SHA.one, pull_request_review_id: 11, path: 'README.md', line: 2, body: `PASS ${SENTINEL}` }],
  }]);
  assert.equal(JSON.stringify(normalized).includes(SENTINEL), false);
  assert.equal(normalized.verdict, null);
  const withVerdict = normalizeGithubEvent({
    action: 'submitted',
    verdict: 'PASS',
    repository: { full_name: 'krzysztofsyska/skillcheck-core' },
    sender: { ...CODEX_REVIEWER },
    review: { id: 12, state: 'commented', commit_id: SHA.one, user: { ...CODEX_REVIEWER }, body: SENTINEL },
    pull_request: {
      number: 126,
      state: 'open',
      draft: false,
      user: { ...AUTHOR },
      base: { ref: 'integration' },
      head: { sha: SHA.one, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
    },
  });
  assert.equal(withVerdict.verdict, null);
  assert.equal(JSON.stringify(withVerdict).includes(SENTINEL), false);
  assert.equal(normalized.pull.baseSha, null);
  assert.equal(normalized.fixAuthor, null);
  const attributed = normalizeGithubEvent({
    action: 'submitted',
    repository: { full_name: 'krzysztofsyska/skillcheck-core' },
    sender: { ...CODEX_REVIEWER },
    head_commit: { author: { ...CURSOR_ACTOR }, message: `fix ${SENTINEL}` },
    fix_author: { id: 1, login: 'from-comment', type: 'User' },
    review: { id: 13, state: 'commented', commit_id: SHA.one, user: { ...CODEX_REVIEWER }, body: `${SENTINEL} cursor[bot]` },
    pull_request: {
      number: 126,
      state: 'open',
      draft: false,
      user: { ...AUTHOR },
      base: { ref: 'integration', sha: SHA.base },
      head: { sha: SHA.one, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
    },
  });
  assert.equal(attributed.pull.baseSha, SHA.base);
  assert.equal(attributed.fixAuthor, null);
  const emailOnly = normalizeGithubEvent({
    action: 'submitted',
    repository: { full_name: 'krzysztofsyska/skillcheck-core' },
    sender: { ...CODEX_REVIEWER },
    head_commit: { author: { name: 'Codex', email: 'codex@example.com' } },
    review: { id: 14, state: 'commented', commit_id: SHA.one, user: { ...CODEX_REVIEWER }, body: SENTINEL },
    pull_request: {
      number: 126,
      state: 'open',
      user: { ...AUTHOR },
      base: { ref: 'integration' },
      head: { sha: SHA.one, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
    },
  });
  assert.equal(emailOnly.pull.baseSha, null);
  assert.equal(emailOnly.fixAuthor, null);
  const result = apply(emptyLedger(), { ...normalized, now: '2026-10-14T07:40:00.000Z' });
  assert.equal(result.outcome.status, 'HANDOFF');
  assert.equal(result.outcome.findings[0].url.endsWith('#discussion_r15'), true);
});

test('the workflow and CLI stay fail-closed with no secrets or paid actions', () => {
  assert.equal(LIVE_EFFECTS_ENABLED, false);
  const workflow = readFileSync('.github/workflows/agent-handoff.yml', 'utf8');
  const parsed = spawnSync('python3', ['-c', 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))', '.github/workflows/agent-handoff.yml'], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(workflow.includes('pull_request_target'), false);
  assert.equal(workflow.includes('secrets.'), false);
  assert.equal(workflow.includes('github.event.review.body'), false);
  assert.equal(workflow.includes('github.event.comment.body'), false);
  assert.equal(workflow.includes('codex-action'), false);
  assert.equal(workflow.includes('CURSOR_API_KEY'), false);
  assert.equal(workflow.includes('OPENAI_API_KEY'), false);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /CODEX_CURSOR_HANDOFF_ENABLED == 'true'/);
  assert.match(workflow, /AGENT_FEEDBACK_ENABLED != 'true'/);
  assert.equal(/^\s*pull_request_review:/m.test(workflow), false);
  assert.equal(/^\s*pull_request_review_comment:/m.test(workflow), false);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.equal(workflow.includes('\n  group: codex-cursor-handoff\n'), false);
  assert.match(workflow, /group: codex-cursor-handoff-inactive-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  const cli = readFileSync('tools/agent-pipeline/handoff-cli.mjs', 'utf8');
  assert.equal(cli.includes('fetch('), false);
  assert.equal(cli.includes('deliverGithubReview'), false);
  assert.equal(cli.includes('readCommit'), false);
  assert.equal(workflow.includes('deliverGithubReview'), false);
  assert.equal(workflow.includes('readCommit'), false);
  assert.equal(readFileSync('tools/agent-pipeline/lib/handoff-loop.mjs', 'utf8').includes('fetch('), false);
  assert.equal(readFileSync('.github/agent-pipeline/policy.json', 'utf8').includes('"AGENT_PIPELINE_ENABLED": false'), true);
  assert.equal(readFileSync('.github/agent-pipeline/policy.json', 'utf8').includes('"AGENT_PIPELINE_MERGE_ENABLED": false'), true);

  const secret = 'sk-test-handoff-secret';
  const logs = [];
  const errors = [];
  const inactive = runHandoffCli([], { OPENAI_API_KEY: secret, CURSOR_API_KEY: secret }, { log: line => logs.push(line), error: line => errors.push(line) });
  assert.equal(inactive, 0);
  assert.deepEqual(logs, ['STATUS: INACTIVE']);
  const blocked = runHandoffCli([], { CODEX_CURSOR_HANDOFF_ENABLED: 'true', OPENAI_API_KEY: secret }, { log: line => logs.push(line), error: line => errors.push(line) });
  assert.equal(blocked, 2);
  assert.equal(errors.includes('STATUS: BLOCKED_ACTIVATION'), true);
  assert.equal([...logs, ...errors].join('\n').includes(secret), false);

  const directory = mkdtempSync(join(tmpdir(), 'handoff-sandbox-'));
  const fixture = join(directory, 'cycle.json');
  const sandboxAgent = agentIdFor(operationKey({
    repositoryId: 'krzysztofsyska/skillcheck-core',
    taskId: 'review-126',
    taskRevision: 1,
    headSha: SHA.one,
    baseSha: 'integration',
    action: 'cursor-handoff',
    round: 0,
  }));
  writeFileSync(fixture, JSON.stringify([
    reviewSnapshot(),
    reviewSnapshot({ event: 'pull_request_review_comment' }),
    reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }),
    reviewSnapshot({
      event: 'admission_completed',
      headSha: SHA.two,
      threads: [],
      adapter: {
        source: 'trusted_adapter',
        kind: 'completed',
        pr: 126,
        task_id: 'review-126',
        agent_id: sandboxAgent,
        ack: true,
        executor: 'cursor',
        head_sha: SHA.two,
      },
    }),
    reviewSnapshot({
      headSha: SHA.two,
      reviewId: 700,
      reviewState: 'approved',
      threads: [],
      ci: { sha: SHA.two, conclusion: 'success' },
      fixAuthor: { ...CURSOR_ACTOR },
      baseSha: SHA.base,
    }),
  ]));
  const sandboxLogs = [];
  const code = runHandoffCli(['--sandbox', fixture], {}, { log: line => sandboxLogs.push(line), error: line => errors.push(line) });
  assert.equal(code, 0, errors.join('\n'));
  const report = JSON.parse(sandboxLogs.at(-1));
  assert.deepEqual(report.statuses, ['HANDOFF', 'DUPLICATE', 'WAITING_CURSOR', 'COMPLETED', 'READY_FOR_OWNER']);
  assert.equal(report.executed, 0);
  assert.equal(report.live_effects, false);
  assert.equal(report.attempts['126'], 1);
  assert.equal(runHandoffCli(['--sandbox', join(process.cwd(), 'package.json')], {}, { log: () => {}, error: line => errors.push(line) }), 1);
});

function workflowAdmission(pr, taskId) {
  return {
    now: '2026-10-15T11:00:00.000Z',
    repository: 'krzysztofsyska/skillcheck-core',
    event: { name: 'admission_request', action: 'observed' },
    sender: { ...CODEX_REVIEWER },
    pull: {
      number: pr,
      state: 'open',
      draft: false,
      baseRef: 'integration',
      headSha: SHA.one,
      author: { ...AUTHOR },
      headRepo: 'krzysztofsyska/skillcheck-core',
    },
    review: { id: 1, user: { ...CODEX_REVIEWER } },
    adapter: {
      source: 'trusted_adapter',
      kind: 'dispatch_request',
      pr,
      task_id: taskId,
      priority: 'NORMAL',
      depends_on: [],
      head_sha: SHA.one,
      base_sha: SHA.two,
      executor: 'cursor',
    },
  };
}

test('workflow review events keep one slot per pull request and the existing review dedup', () => {
  let ledger = emptyLedger();
  for (let index = 1; index <= 5; index += 1) {
    const reserved = apply(ledger, workflowAdmission(300 + index, `W${index}`));
    ledger = reserved.ledger;
    assert.equal(reserved.outcome.status, 'REQUESTED');
  }
  const sixth = apply(ledger, reviewSnapshot({ pr: 880, reviewId: 9100 }));
  assert.equal(sixth.outcome.status, 'WAITING_CAPACITY');
  assert.equal(sixth.outcome.plan.cursor_handoff, null);
  assert.equal(sixth.ledger.attempts['880'], undefined);
  assert.equal(sixth.ledger.queue.some(item => item.pr === '880' && item.review_id === 9100), true);
  assert.equal(occupiedCount(sixth.ledger), 5);
  const freed = apply(sixth.ledger, reviewSnapshot({ pr: 301, state: 'closed', reviewId: 1, threads: [] }));
  assert.equal(freed.outcome.status, 'IGNORED_CLOSED');
  assert.equal(freed.ledger.slots['301'].occupied, false);
  assert.equal(freed.ledger.slots['880'].occupied, true);
  assert.equal(freed.ledger.slots['880'].phase, 'REQUESTED');
  assert.equal(freed.ledger.reservations[dedupKey('880', SHA.one, 9100)].status, 'HANDOFF_PLANNED');
  assert.equal(freed.ledger.attempts['880'], 1);
  assert.equal(freed.ledger.queue.some(item => item.pr === '880'), false);
  assert.equal(freed.outcome.live_effects, 'blocked');
  assert.equal(freed.outcome.plan.cursor_handoff.template, CURSOR_HANDOFF_TEMPLATE);
  assert.equal(freed.outcome.plan.cursor_handoff.existing_pr, true);
  assert.deepEqual(freed.outcome.plan.cursor_handoff.finding_refs.map(item => item.comment_id), [10]);
  const replayQueued = apply(freed.ledger, reviewSnapshot({ pr: 880, reviewId: 9100 }));
  assert.equal(replayQueued.outcome.status, 'DUPLICATE');
  assert.equal(replayQueued.outcome.plan.cursor_handoff, null);
  assert.equal(replayQueued.ledger.attempts['880'], 1);

  ledger = apply(emptyLedger(), reviewSnapshot()).ledger;
  assert.equal(occupiedCount(ledger), 1);
  const duplicate = apply(ledger, reviewSnapshot({ event: 'pull_request_review_comment' }));
  ledger = duplicate.ledger;
  assert.equal(duplicate.outcome.status, 'DUPLICATE');
  assert.equal(ledger.attempts['126'], 1);
  assert.equal(occupiedCount(ledger), 1);
  const replacement = apply(ledger, reviewSnapshot({ reviewId: 77, threads: [thread(77, 77, SHA.one)] }));
  assert.equal(replacement.outcome.status, 'PENDING_FEEDBACK');
  assert.equal(replacement.outcome.plan.cursor_handoff, null);
  assert.equal(replacement.outcome.pending_feedback.update, true);
  assert.equal(replacement.outcome.pending_feedback.agent_id, ledger.slots['126'].agent_id);
  assert.equal(replacement.ledger.attempts['126'], 1);
  assert.equal(occupiedCount(replacement.ledger), 1);
  assert.equal(replacement.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'HANDOFF_PLANNED');
});

test('closing a started review keeps its slot until matching terminal proof admits the queued review', () => {
  let ledger = emptyLedger();
  for (let index = 1; index <= 5; index += 1) {
    const pr = 500 + index;
    const opened = apply(ledger, reviewSnapshot({
      pr,
      reviewId: 5000 + index,
      threads: [thread(5000 + index, 5000 + index, SHA.one)],
    }));
    ledger = opened.ledger;
    assert.equal(opened.outcome.status, 'HANDOFF');
    const slot = ledger.slots[String(pr)];
    const started = apply(ledger, reviewSnapshot({
      event: 'admission_started',
      pr,
      threads: [],
      adapter: {
        source: 'trusted_adapter',
        kind: 'started',
        pr,
        task_id: slot.task_id,
        agent_id: slot.agent_id,
        ack: true,
        executor: 'cursor',
        head_sha: SHA.one,
      },
    }));
    ledger = started.ledger;
    assert.equal(started.outcome.status, 'STARTED');
  }

  const closed = apply(ledger, reviewSnapshot({ pr: 501, state: 'closed', reviewId: 1, threads: [] }));
  ledger = closed.ledger;
  assert.equal(closed.outcome.status, 'IGNORED_CLOSED');
  assert.equal(ledger.slots['501'].occupied, true);
  assert.equal(ledger.slots['501'].phase, 'CANCEL_PENDING');
  assert.equal(ledger.slots['501'].ack, true);
  const drafted = apply(ledger, reviewSnapshot({ pr: 502, draft: true, reviewId: 1, threads: [] }));
  ledger = drafted.ledger;
  assert.equal(drafted.outcome.status, 'IGNORED_DRAFT');
  assert.equal(ledger.slots['502'].phase, 'CANCEL_PENDING');
  assert.equal(ledger.slots['502'].occupied, true);
  assert.equal(occupiedCount(ledger), 5);

  const sixth = apply(ledger, reviewSnapshot({ pr: 506, reviewId: 5906, threads: [thread(5906, 5906, SHA.one)] }));
  ledger = sixth.ledger;
  assert.equal(sixth.outcome.status, 'WAITING_CAPACITY');
  assert.equal(sixth.outcome.plan.cursor_handoff, null);
  assert.equal(ledger.queue.some(item => item.pr === '506' && item.review_id === 5906), true);
  assert.equal(ledger.slots['506'], undefined);

  const mismatch = apply(ledger, reviewSnapshot({
    event: 'admission_completed',
    pr: 501,
    state: 'closed',
    threads: [],
    adapter: {
      source: 'trusted_adapter',
      kind: 'cancelled',
      pr: 501,
      task_id: 'other-task',
      agent_id: ledger.slots['501'].agent_id,
      cancelled: true,
      executor: 'cursor',
      head_sha: SHA.one,
    },
  }));
  ledger = mismatch.ledger;
  assert.notEqual(mismatch.outcome.status, 'CANCELLED');
  assert.equal(ledger.slots['501'].occupied, true);
  assert.equal(ledger.slots['501'].phase, 'CANCEL_PENDING');
  assert.equal(ledger.slots['506'], undefined);

  const proved = apply(ledger, reviewSnapshot({
    event: 'admission_completed',
    pr: 501,
    state: 'closed',
    threads: [],
    adapter: {
      source: 'trusted_adapter',
      kind: 'cancelled',
      pr: 501,
      task_id: ledger.slots['501'].task_id,
      agent_id: ledger.slots['501'].agent_id,
      cancelled: true,
      executor: 'cursor',
      head_sha: SHA.one,
    },
  }));
  assert.equal(proved.outcome.status, 'CANCELLED');
  assert.equal(proved.ledger.slots['501'].occupied, false);
  assert.equal(proved.ledger.reservations[dedupKey('501', SHA.one, 5001)].status, 'CANCELLED');
  assert.equal(proved.ledger.slots['506'].occupied, true);
  assert.equal(proved.ledger.slots['506'].phase, 'REQUESTED');
  assert.equal(proved.ledger.reservations[dedupKey('506', SHA.one, 5906)].status, 'HANDOFF_PLANNED');
  assert.equal(proved.ledger.attempts['506'], 1);
  assert.equal(proved.ledger.queue.some(item => item.pr === '506'), false);
  assert.equal(proved.ledger.slots['502'].phase, 'CANCEL_PENDING');
  assert.equal(proved.ledger.slots['502'].occupied, true);
  assert.equal(occupiedCount(proved.ledger), 5);
  assert.equal(proved.outcome.live_effects, 'blocked');
  assert.equal(proved.outcome.plan.cursor_handoff.template, CURSOR_HANDOFF_TEMPLATE);
  assert.deepEqual(proved.outcome.plan.cursor_handoff.finding_refs.map(item => item.comment_id), [5906]);
  const replayPromoted = apply(proved.ledger, reviewSnapshot({ pr: 506, reviewId: 5906, threads: [thread(5906, 5906, SHA.one)] }));
  assert.equal(replayPromoted.outcome.status, 'DUPLICATE');
  assert.equal(replayPromoted.outcome.plan.cursor_handoff, null);
  assert.equal(replayPromoted.ledger.attempts['506'], 1);
});

test('closing an unstarted handoff retires its reservation', () => {
  const opened = apply(emptyLedger(), reviewSnapshot({ pr: 77, reviewId: 7700, threads: [thread(7700, 7700, SHA.one)] }));
  assert.equal(opened.ledger.slots['77'].phase, 'REQUESTED');
  assert.equal(opened.ledger.slots['77'].ack, false);
  const closed = apply(opened.ledger, reviewSnapshot({ pr: 77, state: 'closed', reviewId: 1, threads: [] }));
  assert.equal(closed.outcome.status, 'IGNORED_CLOSED');
  assert.equal(closed.ledger.slots['77'].occupied, false);
  assert.equal(closed.ledger.slots['77'].phase, 'CANCELLED');
  assert.equal(closed.ledger.reservations[dedupKey('77', SHA.one, 7700)].status, 'CANCELLED');
  const reopened = apply(closed.ledger, reviewSnapshot({
    pr: 77,
    event: 'head_advanced',
    headSha: SHA.two,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(reopened.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.notEqual(reopened.outcome.status, 'REVIEW_REQUESTED');
});

test('a later negative verdict revokes owner readiness', () => {
  for (const verdict of ['FAIL', 'PASS_WITH_FIXES']) {
    let ledger = apply(emptyLedger(), reviewSnapshot()).ledger;
    ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
    ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
    const ready = apply(ledger, reviewSnapshot({
      headSha: SHA.two,
      reviewId: 910,
      reviewState: 'commented',
      threads: [],
      verdict: 'PASS',
      fixAuthor: { ...CURSOR_ACTOR },
      baseSha: SHA.base,
    }));
    assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
    const negative = apply(ready.ledger, reviewSnapshot({
      headSha: SHA.two,
      reviewId: 911,
      reviewState: 'commented',
      threads: [],
      verdict,
    }));
    assert.equal(negative.outcome.status, 'READINESS_REVOKED');
    assert.equal(negative.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'READINESS_REVOKED');
    const replay = apply(negative.ledger, reviewSnapshot({
      headSha: SHA.two,
      reviewId: 910,
      reviewState: 'commented',
      threads: [],
      verdict: 'PASS',
      fixAuthor: { ...CURSOR_ACTOR },
      baseSha: SHA.base,
    }));
    assert.notEqual(replay.outcome.status, 'READY_FOR_OWNER');
  }
});

test('github delivery emits a plan, reads the successor author, and shares the revocation floor', async () => {
  const calls = [];
  let authorMode = 'missing';
  let reviewsMode = 'published';
  let published = [githubReview({ id: 50, sha: SHA.one, state: 'CHANGES_REQUESTED', at: '2026-10-15T10:00:00Z' })];
  const github = createGitHubClient({
    token: 'fixture',
    repository: 'krzysztofsyska/skillcheck-core',
    fetch: async (url, options) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? 'GET' });
      if (href.includes('/pulls/') && href.includes('/reviews')) {
        if (reviewsMode === 'race') throw new Error('lost');
        if (reviewsMode === 'forbidden') return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 });
        if (reviewsMode === 'limited') return new Response(JSON.stringify({ message: 'rate limit' }), { status: 429 });
        if (reviewsMode === 'missing') return new Response(JSON.stringify([]), { status: 200 });
        if (reviewsMode === 'foreign') return new Response(JSON.stringify([githubReview({ id: 100, sha: SHA.three, state: 'APPROVED', at: '2026-10-15T12:00:00Z' })]), { status: 200 });
        if (reviewsMode === 'stranger') return new Response(JSON.stringify([githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:00:00Z', user: AUTHOR })]), { status: 200 });
        if (reviewsMode === 'pending') return new Response(JSON.stringify([{ id: 100, user: { ...CODEX_REVIEWER }, state: 'PENDING', commit_id: SHA.two, body: 'PASS' }]), { status: 200 });
        if (reviewsMode === 'commented') return new Response(JSON.stringify([githubReview({ id: 100, sha: SHA.two, state: 'COMMENTED', at: '2026-10-15T12:00:00Z' })]), { status: 200 });
        return new Response(JSON.stringify(published), { status: 200 });
      }
      const sha = decodeURIComponent(href.split('/commits/').at(-1) ?? '');
      if (sha === SHA.two && authorMode === 'race') throw new Error('lost');
      if (sha === SHA.two && authorMode === 'forbidden') {
        return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 });
      }
      if (sha === SHA.two && authorMode === 'foreign') {
        return new Response(JSON.stringify({
          sha: SHA.three,
          commit: { author: { name: 'Cursor Name', email: 'cursor@example.com' }, message: SENTINEL },
          author: { ...CURSOR_ACTOR },
        }), { status: 200 });
      }
      if (sha === SHA.two && authorMode === 'named') {
        return new Response(JSON.stringify({
          sha,
          commit: { author: { name: AUTHOR.login, email: 'person@example.com' }, message: SENTINEL },
          author: null,
        }), { status: 200 });
      }
      if (sha === SHA.two && (authorMode === 'reviewer' || authorMode === 'linked')) {
        return new Response(JSON.stringify({
          sha,
          commit: { author: { name: 'Cursor Name', email: 'cursor@example.com' }, message: SENTINEL },
          author: authorMode === 'reviewer' ? { ...CODEX_REVIEWER } : { ...CURSOR_ACTOR },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'missing' }), { status: 404 });
    },
  });

  const opened = await deliverGithubReview(emptyLedger(), githubEvent({ reviewId: 50, sha: SHA.one }), findingThread(50, SHA.one), github);
  assert.equal(opened.outcome.status, 'HANDOFF');
  assert.equal(opened.outcome.plan.cursor_handoff.template, CURSOR_HANDOFF_TEMPLATE);
  assert.equal(opened.outcome.plan.cursor_handoff.existing_pr, true);
  assert.deepEqual(opened.outcome.plan.cursor_handoff.finding_refs.map(item => item.comment_id), [50]);
  assert.equal(opened.outcome.plan.cursor_handoff == null, false);
  assert.equal(opened.outcome.live_effects, 'blocked');
  assert.equal(LIVE_EFFECTS_ENABLED, false);
  assert.deepEqual(opened.outcome.executed, []);
  assert.equal(calls.every(call => call.method === 'GET'), true);

  let ledger = opened.ledger;
  const started = apply(ledger, reviewSnapshot({
    event: 'admission_started',
    pr: 126,
    threads: [],
    adapter: {
      source: 'trusted_adapter',
      kind: 'started',
      pr: 126,
      task_id: ledger.slots['126'].task_id,
      agent_id: ledger.slots['126'].agent_id,
      ack: true,
      executor: 'cursor',
      head_sha: SHA.one,
    },
  }));
  assert.equal(started.outcome.status, 'STARTED');
  ledger = apply(started.ledger, completeSlot(started.ledger, 126, SHA.two)).ledger;
  assert.equal(ledger.slots['126'].phase, 'COMPLETED');
  assert.equal(ledger.slots['126'].completed_head_sha, SHA.two);
  const ci = apply(ledger, reviewSnapshot({
    event: 'head_advanced',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(ci.outcome.status, 'REVIEW_REQUESTED');
  ledger = ci.ledger;

  const reservationKey = dedupKey('126', SHA.one, 50);
  const commented = { reviewId: 100, sha: SHA.two, state: 'commented', spoof: { ...CURSOR_ACTOR } };
  authorMode = 'linked';
  for (const mode of ['missing', 'foreign', 'stranger', 'pending', 'commented']) {
    reviewsMode = mode;
    const blocked = await deliverGithubReview(ledger, githubEvent(commented), [], github);
    assert.equal(blocked.outcome.status, 'BLOCKED_EVIDENCE');
    assert.notEqual(blocked.outcome.status, 'READY_FOR_OWNER');
    assert.equal(blocked.ledger.reservations[reservationKey].status, 'WAITING_REREVIEW');
    ledger = blocked.ledger;
  }
  reviewsMode = 'forbidden';
  const forbidden = await deliverGithubReview(ledger, githubEvent(commented), [], github);
  assert.equal(forbidden.outcome.status, 'BLOCKED_INTEGRATION');
  assert.equal(forbidden.outcome.http_status, 403);
  assert.equal(forbidden.ledger.reservations[reservationKey].status, 'WAITING_REREVIEW');
  ledger = forbidden.ledger;
  reviewsMode = 'race';
  const lost = await deliverGithubReview(ledger, githubEvent(commented), [], github);
  assert.equal(lost.outcome.status, 'BLOCKED_INTEGRATION');
  assert.equal(lost.outcome.http_status, null);
  assert.equal(lost.ledger.reservations[reservationKey].status, 'WAITING_REREVIEW');
  ledger = lost.ledger;
  reviewsMode = 'published';
  authorMode = 'named';
  published = [githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:00:00Z' })];
  const unnamed = await deliverGithubReview(ledger, githubEvent(commented), [], github);
  assert.equal(unnamed.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(unnamed.outcome.status, 'READY_FOR_OWNER');
  ledger = unnamed.ledger;
  authorMode = 'reviewer';
  const fetchedSelf = await deliverGithubReview(ledger, githubEvent(commented), [], github);
  assert.equal(fetchedSelf.outcome.status, 'REJECTED_SELF_APPROVAL');
  assert.notEqual(fetchedSelf.outcome.status, 'READY_FOR_OWNER');
  ledger = fetchedSelf.ledger;

  authorMode = 'linked';
  const clean = githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' });
  assert.equal(Object.hasOwn(clean, 'head_commit'), false);
  assert.equal(Object.hasOwn(clean, 'fix_author'), false);
  assert.equal(Object.hasOwn(clean, 'user'), false);
  assert.equal(Object.hasOwn(clean, 'verdict'), false);
  assert.equal(Object.hasOwn(clean.review, 'verdict'), false);
  const pass100 = await deliverGithubReview(ledger, clean, [], github);
  assert.equal(pass100.outcome.status, 'READY_FOR_OWNER');
  assert.equal(pass100.outcome.plan.merge, null);
  assert.equal(calls.some(call => call.method === 'GET' && call.url.endsWith(`/commits/${SHA.two}`)), true);
  ledger = pass100.ledger;
  published = [
    githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:00:00Z' }),
    githubReview({ id: 200, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:01:00Z' }),
  ];
  const pass200 = await deliverGithubReview(ledger, githubEvent({ reviewId: 200, sha: SHA.two, state: 'commented', spoof: { ...CODEX_REVIEWER } }), [], github);
  assert.equal(pass200.outcome.status, 'REVIEW_REUSED');
  assert.notEqual(pass200.outcome.status, 'REJECTED_SELF_APPROVAL');
  assert.equal(pass200.outcome.plan.cursor_handoff, null);
  ledger = pass200.ledger;

  published = [
    ...published,
    githubReview({ id: 301, sha: SHA.two, state: 'DISMISSED', at: '2026-10-15T12:02:00Z' }),
  ];
  const dismissed = await deliverGithubReview(ledger, githubEvent({ reviewId: 301, sha: SHA.two, state: 'dismissed' }), [], github);
  assert.equal(dismissed.outcome.status, 'READINESS_REVOKED');
  assert.equal(dismissed.ledger.reservations[dedupKey('126', SHA.one, 50)].status, 'READINESS_REVOKED');
  ledger = dismissed.ledger;
  const failed = apply(ledger, admissionPass({ reviewId: 300, verdict: 'FAIL', submitted_at: '2026-10-15T12:03:00Z' }));
  assert.equal(failed.outcome.status, 'READINESS_REVOKED');
  ledger = failed.ledger;

  published = published.filter(review => review.id !== 301);
  const replay100 = await deliverGithubReview(ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(replay100.outcome.status, 'STALE_REVIEW');
  assert.notEqual(replay100.outcome.status, 'READY_FOR_OWNER');
  const replay200 = apply(ledger, admissionPass({ reviewId: 200, submitted_at: '2026-10-15T12:01:00Z' }));
  assert.equal(replay200.outcome.status, 'STALE_REVIEW');
  assert.notEqual(replay200.outcome.status, 'READY_TO_MERGE');
  published = [...published, githubReview({ id: 400, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:04:00Z' })];
  const pass400 = await deliverGithubReview(ledger, githubEvent({ reviewId: 400, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(pass400.outcome.status, 'READY_FOR_OWNER');
  const late100 = apply(pass400.ledger, admissionPass({ reviewId: 100, submitted_at: '2026-10-15T12:00:00Z' }));
  assert.equal(late100.outcome.status, 'STALE_REVIEW');
  assert.equal(late100.ledger.reservations[dedupKey('126', SHA.one, 50)].status, 'READY_FOR_OWNER');
  assert.equal(calls.every(call => call.method === 'GET'), true);

  const queued = await deliverGithubReview(emptyLedger(), githubEvent({ pr: 77, reviewId: 77, sha: SHA.one }), findingThread(77, SHA.one), github);
  assert.equal(queued.outcome.status, 'HANDOFF');
  assert.equal(queued.outcome.plan.cursor_handoff == null, false);
  const closed = apply(queued.ledger, reviewSnapshot({ pr: 77, state: 'closed', reviewId: 1, threads: [] }));
  assert.equal(closed.outcome.status, 'IGNORED_CLOSED');
  assert.equal(closed.ledger.slots['77'].phase, 'CANCELLED');
  assert.equal(closed.ledger.reservations[dedupKey('77', SHA.one, 77)].status, 'CANCELLED');
  const reopened = apply(closed.ledger, reviewSnapshot({
    pr: 77,
    event: 'head_advanced',
    headSha: SHA.two,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(reopened.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.notEqual(reopened.outcome.status, 'REVIEW_REQUESTED');
});

test('a delayed approval cannot pass while a newer Codex decision is already listed', async () => {
  let published = [
    githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:00:00Z' }),
    githubReview({ id: 200, sha: SHA.two, state: 'CHANGES_REQUESTED', at: '2026-10-15T12:01:00Z' }),
  ];
  const github = createGitHubClient({
    token: 'fixture',
    repository: 'krzysztofsyska/skillcheck-core',
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('/pulls/') && href.includes('/reviews')) return new Response(JSON.stringify(published), { status: 200 });
      const sha = decodeURIComponent(href.split('/commits/').at(-1) ?? '');
      if (sha === SHA.two) {
        return new Response(JSON.stringify({
          sha,
          commit: { author: { name: 'Cursor Name', email: 'cursor@example.com' }, message: 'fix' },
          author: { ...CURSOR_ACTOR },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'missing' }), { status: 404 });
    },
  });
  let ledger = apply(emptyLedger(), reviewSnapshot()).ledger;
  ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
  ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, baseSha: SHA.base, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
  published = [githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:00:00Z' })];
  const ready = await deliverGithubReview(ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  ledger = ready.ledger;
  published = [
    githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:00:00Z' }),
    githubReview({ id: 200, sha: SHA.two, state: 'CHANGES_REQUESTED', at: '2026-10-15T12:01:00Z' }),
  ];
  const delayed = await deliverGithubReview(ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(delayed.outcome.status, 'READINESS_REVOKED');
  assert.notEqual(delayed.outcome.status, 'READY_FOR_OWNER');
  assert.equal(delayed.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'READINESS_REVOKED');
  const absent = await deliverGithubReview(delayed.ledger, githubEvent({ reviewId: 300, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(absent.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(absent.outcome.status, 'READY_FOR_OWNER');
  assert.equal(absent.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'READINESS_REVOKED');
  const prose = await deliverGithubReview(absent.ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.notEqual(prose.outcome.status, 'READY_FOR_OWNER');
});

test('an unordered GitHub decision withdraws readiness until a later pass', async () => {
  let published = [githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T13:00:00Z' })];
  const github = createGitHubClient({
    token: 'fixture',
    repository: 'krzysztofsyska/skillcheck-core',
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('/pulls/') && href.includes('/reviews')) return new Response(JSON.stringify(published), { status: 200 });
      const sha = decodeURIComponent(href.split('/commits/').at(-1) ?? '');
      if (sha === SHA.two) {
        return new Response(JSON.stringify({
          sha,
          commit: { author: { name: 'Cursor Name', email: 'cursor@example.com' }, message: 'fix' },
          author: { ...CURSOR_ACTOR },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'missing' }), { status: 404 });
    },
  });
  let ledger = apply(emptyLedger(), reviewSnapshot()).ledger;
  ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
  ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, baseSha: SHA.base, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
  const key = dedupKey('126', SHA.one, 5445420558);
  const ready = await deliverGithubReview(ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  published = [
    githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T13:00:00Z' }),
    githubReview({ id: 101, sha: SHA.two, state: 'CHANGES_REQUESTED', at: '2026-10-15T13:00:00Z' }),
  ];
  const unordered = await deliverGithubReview(ready.ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(unordered.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(unordered.outcome.plan.cursor_handoff, null);
  assert.notEqual(unordered.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const replay = await deliverGithubReview(unordered.ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.notEqual(replay.outcome.status, 'READY_FOR_OWNER');
  assert.notEqual(replay.ledger.reservations[key].status, 'READY_FOR_OWNER');
  published = [githubReview({ id: 400, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T13:02:00Z' })];
  const later = await deliverGithubReview(unordered.ledger, githubEvent({ reviewId: 400, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(later.outcome.status, 'READY_FOR_OWNER');
  assert.equal(later.ledger.reservations[key].status, 'READY_FOR_OWNER');
});

test('a failed GitHub read withdraws READY_FOR_OWNER and a later authentic pass restores it', async () => {
  const ready = await reachOwnerReady();
  const key = dedupKey('126', SHA.one, 50);
  assert.equal(ready.reservations[key].status, 'READY_FOR_OWNER');
  const cases = [
    { reviews: 'forbidden', author: 'linked', status: 403 },
    { reviews: 'limited', author: 'linked', status: 429 },
    { reviews: 'published', author: 'timeout', status: null },
  ];
  for (const mode of cases) {
    const blocked = await deliverGithubReview(
      structuredClone(ready),
      githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }),
      [],
      reviewReadClient(mode),
    );
    assert.equal(blocked.outcome.status, 'BLOCKED_INTEGRATION');
    assert.notEqual(blocked.outcome.status, 'BLOCKED_EVIDENCE');
    assert.equal(blocked.outcome.http_status, mode.status);
    assert.equal(blocked.outcome.plan.cursor_handoff, null);
    assert.deepEqual(blocked.outcome.executed, []);
    assert.equal(blocked.ledger.reservations[key].status, 'WAITING_REREVIEW');
    assert.notEqual(blocked.ledger.reservations[key].status, 'READINESS_REVOKED');
    assert.equal(blocked.ledger.reservations[key].status === 'READY_FOR_OWNER', false);
  }
  const withdrawn = await deliverGithubReview(
    structuredClone(ready),
    githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }),
    [],
    reviewReadClient({ reviews: 'forbidden', author: 'linked' }),
  );
  assert.equal(withdrawn.ledger.reservations[key].status, 'WAITING_REREVIEW');
  const restored = await deliverGithubReview(
    withdrawn.ledger,
    githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }),
    [],
    reviewReadClient({ reviews: 'published', author: 'linked' }),
  );
  assert.equal(restored.outcome.status, 'READY_FOR_OWNER');
  assert.equal(restored.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(restored.outcome.plan.cursor_handoff, null);
  assert.deepEqual(restored.outcome.executed, []);
});

function reviewReadClient({ reviews, author }) {
  const published = [githubReview({ id: 100, sha: SHA.two, state: 'APPROVED', at: '2026-10-15T12:00:00Z' })];
  return createGitHubClient({
    token: 'fixture',
    repository: 'krzysztofsyska/skillcheck-core',
    sleep: async () => {},
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('/pulls/') && href.includes('/reviews')) {
        if (reviews === 'forbidden') return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 });
        if (reviews === 'limited') return new Response(JSON.stringify({ message: 'rate limit' }), { status: 429 });
        return new Response(JSON.stringify(published), { status: 200 });
      }
      const sha = decodeURIComponent(href.split('/commits/').at(-1) ?? '');
      if (sha === SHA.two && author === 'timeout') {
        const error = new Error('timeout');
        error.timeout = true;
        throw error;
      }
      if (sha === SHA.two && author === 'linked') {
        return new Response(JSON.stringify({
          sha,
          commit: { author: { name: 'Cursor Name', email: 'cursor@example.com' }, message: 'fix' },
          author: { ...CURSOR_ACTOR },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'missing' }), { status: 404 });
    },
  });
}

async function reachOwnerReady() {
  const github = reviewReadClient({ reviews: 'published', author: 'linked' });
  const opened = await deliverGithubReview(emptyLedger(), githubEvent({ reviewId: 50, sha: SHA.one }), findingThread(50, SHA.one), github);
  assert.equal(opened.outcome.status, 'HANDOFF');
  const started = apply(opened.ledger, reviewSnapshot({
    event: 'admission_started',
    pr: 126,
    threads: [],
    adapter: {
      source: 'trusted_adapter',
      kind: 'started',
      pr: 126,
      task_id: opened.ledger.slots['126'].task_id,
      agent_id: opened.ledger.slots['126'].agent_id,
      ack: true,
      executor: 'cursor',
      head_sha: SHA.one,
    },
  }));
  const completed = apply(started.ledger, completeSlot(started.ledger, 126, SHA.two));
  const ci = apply(completed.ledger, reviewSnapshot({
    event: 'head_advanced',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(ci.outcome.status, 'REVIEW_REQUESTED');
  const pass = await deliverGithubReview(ci.ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], github);
  assert.equal(pass.outcome.status, 'READY_FOR_OWNER');
  return pass.ledger;
}

function githubEvent({ pr = 126, reviewId, sha, state = 'changes_requested', verdict = null, baseSha = SHA.base, spoof = null }) {
  const event = {
    action: 'submitted',
    repository: { full_name: 'krzysztofsyska/skillcheck-core' },
    sender: { ...CODEX_REVIEWER },
    review: {
      id: reviewId,
      state,
      commit_id: sha,
      user: { ...CODEX_REVIEWER },
      body: SENTINEL,
    },
    pull_request: {
      number: pr,
      state: 'open',
      draft: false,
      user: { ...AUTHOR },
      base: { ref: 'integration', sha: baseSha },
      head: { sha, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
    },
  };
  if (verdict != null) event.verdict = verdict;
  if (spoof) {
    event.head_commit = { author: { ...spoof, name: 'Spoof Name', email: 'spoof@example.com' } };
    event.fix_author = { ...spoof };
    event.user = { ...spoof };
  }
  return event;
}

function findingThread(reviewId, sha) {
  return [{
    id: `thread-${reviewId}`,
    isResolved: false,
    isOutdated: false,
    comments: [{
      id: reviewId,
      commit_id: sha,
      pull_request_review_id: reviewId,
      path: 'docs/automation/codex-cursor-handoff-approval.md',
      line: 12,
      body: SENTINEL,
    }],
  }];
}

function githubReview({ id, sha, state, at, user = CODEX_REVIEWER }) {
  return {
    id,
    user: { ...user },
    state,
    commit_id: sha,
    submitted_at: at,
    body: 'PASS',
  };
}

function admissionPass({ reviewId, verdict = 'PASS', submitted_at = null }) {
  return {
    now: '2026-10-15T12:00:00.000Z',
    repository: 'krzysztofsyska/skillcheck-core',
    event: { name: 'admission_review', action: 'observed' },
    sender: { ...CODEX_REVIEWER },
    pull: {
      number: 126,
      state: 'open',
      draft: false,
      baseRef: 'integration',
      headSha: SHA.two,
      baseSha: SHA.base,
      author: { ...AUTHOR },
      headRepo: 'krzysztofsyska/skillcheck-core',
    },
    review: { id: reviewId, state: 'commented', user: { ...CODEX_REVIEWER }, submittedAt: submitted_at },
    adapter: {
      source: 'trusted_adapter',
      kind: 'review',
      pr: 126,
      task_id: 'review-126',
      executor: 'codex',
      head_sha: SHA.two,
      base_sha: SHA.base,
      submitted_at,
      conditions: { policy_sha: 'policy-1', required_checks: ['verify'] },
      verdict,
      findings: [],
      ci: { sha: SHA.two, conclusion: 'success' },
      fix_author: { ...CURSOR_ACTOR },
    },
  };
}

test('successor CI waits for completion and either order requests review once', () => {
  let ledger = apply(emptyLedger(), reviewSnapshot()).ledger;
  const waiting = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(waiting.outcome.status, 'WAITING_CURSOR');
  assert.equal(waiting.outcome.plan.codex_rereview, null);
  assert.equal(waiting.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].ci.conclusion, 'success');
  const repeated = apply(waiting.ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(repeated.outcome.plan.codex_rereview, null);
  const done = apply(repeated.ledger, completeSlot(repeated.ledger, 126, SHA.two));
  assert.equal(done.outcome.status, 'COMPLETED');
  assert.equal(done.outcome.plan.codex_rereview.sha, SHA.two);
  assert.equal(done.outcome.plan.codex_rereview.paid_call, false);
  const after = apply(done.ledger, reviewSnapshot({ event: 'ci_completed', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(after.outcome.status, 'DUPLICATE');
  assert.equal(after.outcome.plan.codex_rereview, null);

  let reverse = apply(emptyLedger(), reviewSnapshot({ pr: 127, reviewId: 9 })).ledger;
  const completed = apply(reverse, completeSlot(reverse, 127, SHA.two));
  assert.equal(completed.outcome.status, 'COMPLETED');
  assert.equal(completed.outcome.plan.codex_rereview, null);
  const requested = apply(completed.ledger, reviewSnapshot({ pr: 127, event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(requested.outcome.status, 'REVIEW_REQUESTED');
  assert.equal(requested.outcome.plan.codex_rereview.sha, SHA.two);
  const second = apply(requested.ledger, reviewSnapshot({ pr: 127, event: 'ci_completed', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }));
  assert.equal(second.outcome.status, 'DUPLICATE');
  assert.equal(second.outcome.plan.codex_rereview, null);
});

test('new findings revoke owner readiness before reserving the next handoff', () => {
  let ledger = apply(emptyLedger(), reviewSnapshot()).ledger;
  ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
  ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
  const ready = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 100,
    reviewState: 'approved',
    threads: [],
    fixAuthor: { ...CURSOR_ACTOR },
    baseSha: SHA.base,
  }));
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  const findings = apply(ready.ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 500,
    threads: [thread(500, 500, SHA.two)],
    baseSha: SHA.base,
  }));
  assert.equal(findings.outcome.status, 'HANDOFF');
  assert.equal(findings.outcome.plan.cursor_handoff == null, false);
  assert.equal(findings.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'READINESS_REVOKED');
  const replay = apply(findings.ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 100,
    reviewState: 'approved',
    threads: [],
    fixAuthor: { ...CURSOR_ACTOR },
    baseSha: SHA.base,
  }));
  assert.equal(replay.outcome.status, 'STALE_REVIEW');
  assert.notEqual(replay.outcome.status, 'READY_FOR_OWNER');
  assert.notEqual(replay.outcome.status, 'REVIEW_REUSED');
});

test('five finished handoff cycles release their slots before the next review', () => {
  let ledger = emptyLedger();
  for (let index = 1; index <= 5; index += 1) {
    const pr = 600 + index;
    ledger = apply(ledger, reviewSnapshot({
      pr,
      reviewId: 6000 + index,
      threads: [thread(6000 + index, 6000 + index, SHA.one)],
    })).ledger;
    ledger = apply(ledger, reviewSnapshot({
      event: 'head_advanced',
      pr,
      headSha: SHA.two,
      threads: [],
      ci: { sha: SHA.two, conclusion: 'success' },
    })).ledger;
    const done = apply(ledger, completeSlot(ledger, pr, SHA.two));
    assert.equal(done.outcome.status, 'COMPLETED');
    assert.equal(done.ledger.slots[String(pr)].occupied, false);
    ledger = done.ledger;
    const ready = apply(ledger, reviewSnapshot({
      pr,
      headSha: SHA.two,
      reviewId: 6100 + index,
      reviewState: 'approved',
      threads: [],
      ci: { sha: SHA.two, conclusion: 'success' },
      fixAuthor: { ...CURSOR_ACTOR },
      baseSha: SHA.base,
    }));
    assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
    ledger = ready.ledger;
    assert.equal(ledger.slots[String(pr)].occupied, false);
  }
  assert.equal(occupiedCount(ledger), 0);
  const sixth = apply(ledger, reviewSnapshot({ pr: 606, reviewId: 6606, threads: [thread(6606, 6606, SHA.one)] }));
  assert.equal(sixth.outcome.status, 'HANDOFF');
  assert.equal(sixth.outcome.plan.cursor_handoff == null, false);
  assert.equal(occupiedCount(sixth.ledger), 1);
});

test('automation documents and the handoff workflow classify as L3 operations', () => {
  const body = 'TASK: SC-OPS-HANDOFF\nSCOPE: OPERATIONS\nLEVEL: L3\nOWNER_APPROVAL: PENDING\nPRODUCTION_APPROVAL: NO\nREVIEW_VERDICT: PENDING\nPROMOTION: NO\n';
  const accepted = classify({
    files: [
      'docs/automation/codex-cursor-handoff-approval.md',
      '.github/workflows/agent-handoff.yml',
      'tools/agent-pipeline/lib/handoff-loop.mjs',
      'tools/agent-pipeline/handoff-cli.mjs',
      'tests/agent-pipeline/handoff-loop.test.mjs',
    ],
    body,
    base: 'integration',
    headRef: 'task/codex-cursor-handoff-approval-20261014',
  });
  assert.equal(accepted.ok, true);
  const low = classify({
    files: ['docs/automation/codex-cursor-handoff-approval.md'],
    body: body.replace('LEVEL: L3', 'LEVEL: L1'),
    base: 'integration',
    headRef: 'task/codex-cursor-handoff-approval-20261014',
  });
  assert.equal(low.ok, false);
});

test('structural review uses the authenticated artifact and ignores a connector comment', async () => {
  const policy = configuredReviewPolicy();
  const early = await observeStructuralReview(emptyLedger(), 126, null);
  assert.equal(early.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(early.outcome.status, 'READY_FOR_OWNER');

  for (const order of ['ci-after', 'ci-first']) {
    const { ledger, expected } = structuralLedger(order);
    const untouched = await observeStructuralReview(ledger, 126, { readPull() { throw new Error('unread'); } });
    assert.equal(untouched.outcome.status, 'BLOCKED_CONFIGURATION');
    assert.equal(untouched.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

    const pass = envelopeFor(expected, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')] });
    const world = structuralWorld({ expected, policy, envelope: pass });
    const commented = await deliverGithubReview(ledger, githubEvent({ reviewId: 100, sha: SHA.two, state: 'commented' }), [], world.github);
    assert.equal(commented.outcome.status, 'BLOCKED_EVIDENCE');
    assert.notEqual(commented.outcome.status, 'READY_FOR_OWNER');

    const ready = await observeStructuralReview(ledger, 126, world.github, policy);
    assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
    assert.equal(ready.outcome.plan.merge, null);
    assert.equal(ready.ledger.slots['126'].occupied, false);
    assert.equal(world.calls.every(call => call.method === 'GET'), true);
    const replay = await observeStructuralReview(ready.ledger, 126, world.github, policy);
    assert.equal(replay.outcome.status, 'REVIEW_REUSED');
    assert.equal(replay.ledger.slots['126'].occupied, false);
  }

  const { ledger, expected } = structuralLedger('ci-after');
  const minor = envelopeFor(expected, policy, { verdict: 'PASS', findings: [structuralFinding('copy', 'minor')] });
  const minorWorld = structuralWorld({ expected, policy, envelope: minor });
  const handed = await observeStructuralReview(ledger, 126, minorWorld.github, policy);
  assert.equal(handed.outcome.status, 'HANDOFF');
  assert.notEqual(handed.outcome.status, 'READY_FOR_OWNER');
  assert.equal(handed.outcome.plan.cursor_handoff.finding_refs[0].severity, 'P2');
  assert.equal(handed.outcome.plan.cursor_handoff.finding_refs[0].path, 'docs/automation/codex-cursor-handoff-approval.md');

  const blankFix = envelopeFor(expected, policy, {
    verdict: 'PASS',
    findings: [structuralFinding('guard', 'minor', { required_fix: '   ', description: 'keep the guard on the same ledger' })],
  });
  const described = await observeStructuralReview(structuralLedger('ci-after').ledger, 126, structuralWorld({ expected, policy, envelope: blankFix }).github, policy);
  assert.equal(described.outcome.status, 'HANDOFF');
  assert.equal(described.outcome.plan.cursor_handoff.finding_refs[0].required_fix, 'keep the guard on the same ledger');
  assert.notEqual(described.outcome.status, 'READY_FOR_OWNER');

  const emptyFix = envelopeFor(expected, policy, {
    verdict: 'FAIL',
    findings: [structuralFinding('empty', 'major', { required_fix: ' ', description: '  ' })],
  });
  const beforeAttempts = structuralLedger('ci-after');
  const blockedFix = await observeStructuralReview(beforeAttempts.ledger, 126, structuralWorld({ expected, policy, envelope: emptyFix }).github, policy);
  assert.equal(blockedFix.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(blockedFix.ledger.attempts['126'], beforeAttempts.ledger.attempts['126']);
  assert.equal(blockedFix.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

  const failed = envelopeFor(expected, policy, { verdict: 'FAIL', findings: [structuralFinding('break', 'blocker')] });
  const failedWorld = structuralWorld({ expected, policy, envelope: failed });
  const fixes = await observeStructuralReview(structuralLedger('ci-after').ledger, 126, failedWorld.github, policy);
  assert.equal(fixes.outcome.status, 'HANDOFF');
  assert.equal(fixes.outcome.plan.cursor_handoff.finding_refs[0].severity, 'P0');
  assert.notEqual(fixes.outcome.status, 'READY_FOR_OWNER');

  const full = structuralLedger('ci-after');
  for (let index = 0; index < 5; index += 1) {
    full.ledger = apply(full.ledger, reviewSnapshot({ pr: 201 + index, reviewId: 8000 + index, threads: [thread(8000 + index, 8000 + index, SHA.one)] })).ledger;
  }
  assert.equal(occupiedCount(full.ledger), 5);
  const waiting = await observeStructuralReview(full.ledger, 126, structuralWorld({ expected: full.expected, policy, envelope: failed }).github, policy);
  assert.equal(waiting.outcome.status, 'WAITING_CAPACITY');
  assert.equal(occupiedCount(waiting.ledger), 5);
  assert.equal(waiting.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'SUPERSEDED');
  assert.equal(waiting.ledger.queue.some(item => item.pr === '126'), true);
  assert.notEqual(waiting.outcome.status, 'READY_FOR_OWNER');

  const dependent = structuralLedger('ci-after');
  dependent.ledger.slots['126'].depends_on = ['UNFINISHED'];
  const held = await observeStructuralReview(dependent.ledger, 126, structuralWorld({ expected: dependent.expected, policy, envelope: passEnvelope(dependent.expected, policy) }).github, policy);
  assert.equal(held.outcome.status, 'WAITING_DEPENDENCY');
  assert.notEqual(held.outcome.status, 'READY_FOR_OWNER');

  const mismatched = structuralLedger('ci-after');
  const wrongHead = envelopeFor(mismatched.expected, policy, { verdict: 'PASS', head_sha: SHA.three });
  const wrong = await observeStructuralReview(mismatched.ledger, 126, structuralWorld({ expected: mismatched.expected, policy, envelope: wrongHead }).github, policy);
  assert.equal(wrong.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(wrong.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

  const moved = structuralLedger('ci-after');
  const movedResult = await observeStructuralReview(moved.ledger, 126, structuralWorld({ expected: moved.expected, policy, envelope: passEnvelope(moved.expected, policy), pullHead: SHA.three }).github, policy);
  assert.equal(movedResult.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(movedResult.outcome.status, 'READY_FOR_OWNER');

  const forbidden = structuralLedger('ci-after');
  const blockedRead = await observeStructuralReview(forbidden.ledger, 126, structuralWorld({ expected: forbidden.expected, policy, envelope: passEnvelope(forbidden.expected, policy), fail: '/actions/workflows/' }).github, policy);
  assert.equal(blockedRead.outcome.status, 'BLOCKED_INTEGRATION');
  assert.equal(blockedRead.outcome.http_status, 403);
  assert.equal(blockedRead.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

  const duplicate = structuralLedger('ci-after');
  const first = reviewRun(duplicate.expected, policy);
  const duplicated = await observeStructuralReview(duplicate.ledger, 126, structuralWorld({ expected: duplicate.expected, policy, envelope: passEnvelope(duplicate.expected, policy), runs: [first, { ...first, id: 901 }] }).github, policy);
  assert.equal(duplicated.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(duplicated.outcome.status, 'READY_FOR_OWNER');

  const pending = structuralLedger('ci-after');
  const unfinished = await observeStructuralReview(pending.ledger, 126, structuralWorld({
    expected: pending.expected,
    policy,
    envelope: passEnvelope(pending.expected, policy),
    runs: [reviewRun(pending.expected, policy, { status: 'in_progress', conclusion: null })],
  }).github, policy);
  assert.equal(unfinished.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(unfinished.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');

  const owned = structuralLedger('ci-after');
  const self = await observeStructuralReview(owned.ledger, 126, structuralWorld({
    expected: owned.expected,
    policy,
    envelope: passEnvelope(owned.expected, policy),
    author: { id: policy.controller_actor_id, login: 'skillcheck-controller[bot]', type: 'Bot' },
  }).github, policy);
  assert.equal(self.outcome.status, 'REJECTED_SELF_APPROVAL');
  assert.notEqual(self.outcome.status, 'READY_FOR_OWNER');
});

test('structural review reads the verify artifact and keeps the dispatch policy SHA', async () => {
  const policy = configuredReviewPolicy();
  const { ledger, expected } = structuralLedger('ci-after');
  const pass = passEnvelope(expected, policy);
  const failed = await observeStructuralReview(ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: pass,
    ciRuns: [ciRun(expected, policy, { conclusion: 'failure' })],
  }).github, policy);
  assert.equal(failed.outcome.status, 'CI_FAILED');
  assert.notEqual(failed.outcome.status, 'READY_FOR_OWNER');
  assert.equal(failed.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'WAITING_REREVIEW');
  assert.equal(failed.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].ci.conclusion, 'failure');

  const recovered = await observeStructuralReview(failed.ledger, 126, structuralWorld({ expected, policy, envelope: pass }).github, policy);
  assert.equal(recovered.outcome.status, 'READY_FOR_OWNER');

  const stalePolicy = structuralLedger('ci-after');
  const advanced = reviewRun(stalePolicy.expected, policy, { head_sha: '9'.repeat(40) });
  const rejected = await observeStructuralReview(stalePolicy.ledger, 126, structuralWorld({
    expected: stalePolicy.expected,
    policy,
    envelope: passEnvelope(stalePolicy.expected, policy),
    runs: [advanced],
  }).github, policy);
  assert.equal(rejected.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(rejected.outcome.status, 'READY_FOR_OWNER');
});

test('a base change reissues the structural review tuple', () => {
  const { ledger, expected } = structuralLedger('ci-after');
  const key = dedupKey('126', SHA.one, 5445420558);
  const moved = apply(ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.four,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(moved.outcome.status, 'REVIEW_REQUESTED');
  assert.equal(moved.outcome.plan.codex_rereview == null, false);
  assert.equal(moved.outcome.plan.codex_rereview.verify_dispatch.workflow, 'verify');
  assert.equal(moved.outcome.plan.codex_rereview.verify_dispatch.type, 'github.dispatch');
  assert.equal(moved.outcome.plan.codex_rereview.verify_dispatch.headSha, SHA.two);
  assert.equal(moved.outcome.plan.codex_rereview.verify_dispatch.baseSha, SHA.four);
  assert.equal(moved.outcome.plan.codex_rereview.paid_call, false);
  assert.deepEqual(moved.outcome.executed, []);
  assert.equal(moved.ledger.reservations[key].verify_dispatch.workflow, 'verify');
  assert.equal(moved.ledger.reservations[key].verify_dispatch.headSha, SHA.two);
  assert.equal(moved.ledger.reservations[key].structural_review.base_sha, SHA.four);
  assert.notEqual(moved.ledger.reservations[key].structural_review.request_id, expected.request_id);
  assert.equal(moved.ledger.reservations[key].structural_review.request_id, producerReview(SHA.two, SHA.four).record.review_request_id);
  assert.equal(moved.ledger.slots['126'].review_contract.base_sha, SHA.four);
  assert.equal(moved.ledger.slots['126'].review_contract.head_sha, SHA.two);
  assert.equal(moved.ledger.slots['126'].review_contract.review_request_id, moved.ledger.reservations[key].structural_review.request_id);
  assert.equal(moved.ledger.slots['126'].review_contract.review_run_id, null);
  assert.equal(moved.ledger.slots['126'].review_contract.ci_run_id, null);
  assert.equal(moved.ledger.reservations[key].structural_review.contract_hash, expected.contract_hash);
  assert.equal(moved.ledger.reservations[key].structural_review.policy_sha, expected.policy_sha);
  assert.deepEqual(moved.ledger.reservations[key].structural_review.required_checks, expected.required_checks);
  const again = apply(moved.ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.four,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(again.outcome.status, 'DUPLICATE');
});

test('an old structural result does not unlock readiness after the tuple changes', async () => {
  const policy = configuredReviewPolicy();
  const { ledger, expected } = structuralLedger('ci-after');
  const key = dedupKey('126', SHA.one, 5445420558);
  const moved = apply(ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.four,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  const stale = await observeStructuralReview(moved.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
    pullBase: SHA.four,
  }).github, policy);
  assert.notEqual(stale.outcome.status, 'READY_FOR_OWNER');
  assert.notEqual(stale.outcome.status, 'REVIEW_REUSED');
  assert.equal(stale.ledger.reservations[key].status, 'WAITING_REREVIEW');
  const successor = moved.ledger.reservations[key].structural_review;
  const ready = await observeStructuralReview(moved.ledger, 126, structuralWorld({
    expected: successor,
    policy,
    envelope: passEnvelope(successor, policy),
    pullBase: SHA.four,
  }).github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');

  const controls = structuralLedger('ci-after');
  controls.ledger.slots['126'].review_contract.binding.contract.acceptance_criteria.push('sc-agent/extra-control');
  const reissued = apply(controls.ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(reissued.outcome.status, 'REVIEW_REQUESTED');
  assert.equal(reissued.ledger.reservations[key].status, 'WAITING_REREVIEW');
  const successorControls = reissued.ledger.reservations[key].structural_review;
  assert.equal(successorControls.required_checks.includes('sc-agent/extra-control'), true);
  assert.equal(successorControls.policy_sha, expected.policy_sha);
  assert.notEqual(successorControls.request_id, controls.expected.request_id);
  const producedRound = producerReview(SHA.two, SHA.base).record;
  assert.equal(successorControls.request_id, sha256(operationKey({
    repositoryId: producedRound.repository_id,
    taskId: producedRound.task_id,
    taskRevision: producedRound.task_revision,
    headSha: SHA.two,
    baseSha: SHA.base,
    action: 'review',
    round: producedRound.binding.substantive_reviews + 1,
  })));
  const advanced = reissued.ledger.slots['126'].review_contract;
  assert.equal(advanced.review_request_id, successorControls.request_id);
  assert.equal(advanced.head_sha, SHA.two);
  assert.equal(advanced.base_sha, SHA.base);
  assert.equal(advanced.review_run_id, null);
  assert.equal(advanced.ci_run_id, null);
  assert.equal(advanced.binding.review_dispatched, false);
  const packet = reviewDispatchPacket(advanced);
  assert.equal(packet == null, false);
  assert.equal(packet.request_id, advanced.review_request_id);
  assert.equal(packet.required_checks.includes('sc-agent/extra-control'), true);
  assert.notEqual(packet.request_id, controls.expected.request_id);
  const accepted = await observeStructuralReview(reissued.ledger, 126, structuralWorld({
    expected: successorControls,
    policy,
    envelope: envelopeFor(successorControls, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')], run_id: 901 }),
    runs: [reviewRun(controls.expected, policy, { id: 900 }), reviewRun(successorControls, policy, { id: 901 })],
    ciRuns: [ciRun(controls.expected, policy, { id: 911 }), ciRun(successorControls, policy, { id: 910 })],
  }).github, policy);
  assert.equal(accepted.outcome.status, 'READY_FOR_OWNER');
  assert.equal(accepted.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const repeated = apply(reissued.ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(repeated.outcome.status, 'DUPLICATE');
  const previous = await observeStructuralReview(reissued.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
  }).github, policy);
  assert.notEqual(previous.outcome.status, 'READY_FOR_OWNER');
  assert.equal(previous.ledger.reservations[key].status, 'WAITING_REREVIEW');
});

test('the structural consumer accepts the reviewStep packet without a second contract', async () => {
  const policy = configuredReviewPolicy();
  const produced = producerReview(SHA.two, SHA.base);
  assert.equal(produced.packet == null, false);
  assert.equal(produced.packet.request_id, produced.record.review_request_id);
  assert.equal(produced.packet.contract_hash, produced.record.contract_hash);
  assert.deepEqual(produced.packet.required_checks, requiredReviewChecks(produced.record));
  let ledger = apply(emptyLedger(), reviewSnapshot({ baseSha: SHA.base })).ledger;
  ledger.slots['126'].review_contract = produced.record;
  ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
  const requested = apply(ledger, reviewSnapshot({
    event: 'head_advanced',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(requested.outcome.status, 'REVIEW_REQUESTED');
  const key = dedupKey('126', SHA.one, 5445420558);
  const stored = requested.ledger.reservations[key].structural_review;
  assert.equal(stored.request_id, produced.packet.request_id);
  assert.equal(stored.contract_hash, produced.packet.contract_hash);
  assert.equal(stored.policy_sha, produced.packet.policy_sha);
  assert.deepEqual(stored.required_checks, produced.packet.required_checks);
  const packetView = {
    request_id: produced.packet.request_id,
    policy_sha: produced.packet.policy_sha,
    head_sha: produced.packet.head_sha,
    base_sha: produced.packet.base_sha,
    contract_hash: produced.packet.contract_hash,
    required_checks: produced.packet.required_checks,
    repository_id: produced.packet.repository_id,
    pr: produced.packet.pr_number,
  };
  const ready = await observeStructuralReview(requested.ledger, 126, structuralWorld({
    expected: packetView,
    policy,
    envelope: envelopeFor(packetView, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')] }),
  }).github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  assert.equal(ready.ledger.reservations[key].status, 'READY_FOR_OWNER');
});

test('structural review does not invent a contract hash', async () => {
  let ledger = apply(emptyLedger(), reviewSnapshot({ baseSha: SHA.base })).ledger;
  ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
  const requested = apply(ledger, reviewSnapshot({
    event: 'head_advanced',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(requested.outcome.status, 'REVIEW_REQUESTED');
  assert.equal(requested.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].structural_review, null);
  const observed = await observeStructuralReview(requested.ledger, 126, null);
  assert.equal(observed.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(observed.outcome.status, 'READY_FOR_OWNER');
});

test('a queued structural fix is observed on the successor head', async () => {
  const policy = configuredReviewPolicy();
  const full = structuralLedger('ci-after');
  for (let index = 0; index < 5; index += 1) {
    full.ledger = apply(full.ledger, reviewSnapshot({ pr: 201 + index, reviewId: 8100 + index, threads: [thread(8100 + index, 8100 + index, SHA.one)] })).ledger;
  }
  const failed = envelopeFor(full.expected, policy, { verdict: 'FAIL', findings: [structuralFinding('break', 'blocker')] });
  const waiting = await observeStructuralReview(full.ledger, 126, structuralWorld({ expected: full.expected, policy, envelope: failed }).github, policy);
  assert.equal(waiting.outcome.status, 'WAITING_CAPACITY');
  releasePull(waiting.ledger, 201);
  assert.equal(waiting.ledger.slots['126'].occupied, true);
  assert.equal(waiting.ledger.slots['126'].review_contract.task_id, 'SC-DEMO-001');
  const done = apply(waiting.ledger, completeSlot(waiting.ledger, 126, SHA.three));
  assert.equal(done.outcome.status, 'COMPLETED');
  const requested = apply(done.ledger, reviewSnapshot({
    event: 'head_advanced',
    headSha: SHA.three,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.three, conclusion: 'success' },
  }));
  assert.equal(requested.outcome.status, 'REVIEW_REQUESTED');
  const successor = requested.ledger.reservations[dedupKey('126', SHA.two, 900)].structural_review;
  assert.equal(successor.head_sha, SHA.three);
  assert.equal(successor.task_id, 'SC-DEMO-001');
  assert.equal(requested.ledger.reservations[dedupKey('126', SHA.one, 5445420558)].status, 'SUPERSEDED');
  const ready = await observeStructuralReview(requested.ledger, 126, structuralWorld({
    expected: successor,
    policy,
    envelope: passEnvelope(successor, policy),
    pullHead: SHA.three,
  }).github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
});

test('a later CI failure withdraws structural readiness', async () => {
  const policy = configuredReviewPolicy();
  const { ledger, expected } = structuralLedger('ci-after');
  const key = dedupKey('126', SHA.one, 5445420558);
  const world = structuralWorld({ expected, policy, envelope: passEnvelope(expected, policy) });
  const ready = await observeStructuralReview(ledger, 126, world.github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  const failed = apply(ready.ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'failure' },
  }));
  assert.equal(failed.outcome.status, 'CI_FAILED');
  assert.notEqual(failed.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.equal(failed.ledger.reservations[key].status, 'WAITING_REREVIEW');
  assert.notEqual(failed.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const stillFailed = await observeStructuralReview(failed.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
    ciRuns: [ciRun(expected, policy, { conclusion: 'failure' })],
  }).github, policy);
  assert.equal(stillFailed.outcome.status, 'CI_FAILED');
  assert.equal(stillFailed.ledger.reservations[key].status, 'WAITING_REREVIEW');
  const restored = await observeStructuralReview(stillFailed.ledger, 126, world.github, policy);
  assert.equal(restored.outcome.status, 'READY_FOR_OWNER');
  assert.equal(restored.ledger.reservations[key].status, 'READY_FOR_OWNER');

  const artifact = structuralLedger('ci-after');
  const passed = await observeStructuralReview(artifact.ledger, 126, structuralWorld({
    expected: artifact.expected,
    policy,
    envelope: passEnvelope(artifact.expected, policy),
  }).github, policy);
  assert.equal(passed.outcome.status, 'READY_FOR_OWNER');
  const reread = await observeStructuralReview(passed.ledger, 126, structuralWorld({
    expected: artifact.expected,
    policy,
    envelope: passEnvelope(artifact.expected, policy),
    ciRuns: [ciRun(artifact.expected, policy, { conclusion: 'failure' })],
  }).github, policy);
  assert.equal(reread.outcome.status, 'CI_FAILED');
  assert.notEqual(reread.outcome.status, 'REVIEW_REUSED');
  assert.equal(reread.ledger.reservations[key].status, 'WAITING_REREVIEW');
  assert.notEqual(reread.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const recovered = await observeStructuralReview(reread.ledger, 126, structuralWorld({
    expected: artifact.expected,
    policy,
    envelope: passEnvelope(artifact.expected, policy),
  }).github, policy);
  assert.equal(recovered.outcome.status, 'READY_FOR_OWNER');
  assert.equal(recovered.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const missing = structuralLedger('ci-after');
  const held = await observeStructuralReview(missing.ledger, 126, structuralWorld({
    expected: missing.expected,
    policy,
    envelope: passEnvelope(missing.expected, policy),
  }).github, policy);
  const unavailable = await observeStructuralReview(held.ledger, 126, structuralWorld({
    expected: missing.expected,
    policy,
    envelope: passEnvelope(missing.expected, policy),
    ciRuns: [ciRun(missing.expected, policy, { status: 'in_progress', conclusion: null })],
  }).github, policy);
  assert.equal(unavailable.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(unavailable.outcome.status, 'REVIEW_REUSED');
  assert.equal(unavailable.ledger.reservations[key].status, 'WAITING_REREVIEW');
  const available = await observeStructuralReview(unavailable.ledger, 126, structuralWorld({
    expected: missing.expected,
    policy,
    envelope: passEnvelope(missing.expected, policy),
  }).github, policy);
  assert.equal(available.outcome.status, 'READY_FOR_OWNER');
  assert.equal(available.ledger.reservations[key].status, 'READY_FOR_OWNER');
});

test('a later structural FAIL without findings withdraws readiness and does not start a fix', async () => {
  const policy = configuredReviewPolicy();
  const { ledger, expected } = structuralLedger('ci-after');
  const key = dedupKey('126', SHA.one, 5445420558);
  const ready = await observeStructuralReview(ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
  }).github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  const attempts = ready.ledger.attempts['126'];
  const fail = envelopeFor(expected, policy, { verdict: 'FAIL', findings: [], run_id: 901 });
  const revoked = await observeStructuralReview(ready.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: fail,
    runs: [reviewRun(expected, policy, { id: 901, updated_at: '2026-10-15T14:00:00Z' })],
  }).github, policy);
  assert.equal(revoked.outcome.status, 'READINESS_REVOKED');
  assert.notEqual(revoked.outcome.status, 'HANDOFF');
  assert.equal(revoked.outcome.plan.cursor_handoff, null);
  assert.equal(revoked.ledger.reservations[key].status, 'READINESS_REVOKED');
  assert.equal(revoked.ledger.attempts['126'], attempts);

  const fresh = await observeStructuralReview(structuralLedger('ci-after').ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
  }).github, policy);
  const unordered = await observeStructuralReview(fresh.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: envelopeFor(expected, policy, {
      verdict: 'FAIL',
      findings: [structuralFinding('late', 'minor')],
      run_id: 902,
    }),
    runs: [reviewRun(expected, policy, { id: 902, updated_at: '2026-10-15T13:00:00Z' })],
  }).github, policy);
  assert.equal(unordered.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(unordered.outcome.status, 'HANDOFF');
  assert.equal(unordered.outcome.plan.cursor_handoff, null);
  assert.equal(unordered.outcome.plan.codex_rereview, null);
  assert.notEqual(unordered.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(unordered.ledger.attempts['126'], fresh.ledger.attempts['126']);

  const sameSecond = await observeStructuralReview(structuralLedger('ci-after').ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
  }).github, policy);
  const ambiguous = await observeStructuralReview(sameSecond.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: envelopeFor(expected, policy, { verdict: 'FAIL', findings: [], run_id: 901 }),
    runs: [reviewRun(expected, policy, { id: 901, updated_at: '2026-10-15T13:00:00Z' })],
  }).github, policy);
  assert.equal(ambiguous.outcome.status, 'BLOCKED_EVIDENCE');
  assert.equal(ambiguous.outcome.plan.cursor_handoff, null);
  assert.equal(ambiguous.outcome.plan.codex_rereview, null);
  assert.notEqual(ambiguous.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(ambiguous.ledger.attempts['126'], sameSecond.ledger.attempts['126']);
  const replayedPass = await observeStructuralReview(ambiguous.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
  }).github, policy);
  assert.notEqual(replayedPass.outcome.status, 'READY_FOR_OWNER');
  assert.notEqual(replayedPass.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const restored = await observeStructuralReview(ambiguous.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: envelopeFor(expected, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')], run_id: 904 }),
    runs: [reviewRun(expected, policy, { id: 904, updated_at: '2026-10-15T14:00:00Z' })],
  }).github, policy);
  assert.equal(restored.outcome.status, 'READY_FOR_OWNER');
  assert.equal(restored.ledger.reservations[key].status, 'READY_FOR_OWNER');

  const current = await observeStructuralReview(structuralLedger('ci-after').ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: passEnvelope(expected, policy),
  }).github, policy);
  const older = await observeStructuralReview(current.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: envelopeFor(expected, policy, { verdict: 'FAIL', findings: [], run_id: 903 }),
    runs: [reviewRun(expected, policy, { id: 903, updated_at: '2026-10-15T12:00:00Z' })],
  }).github, policy);
  assert.equal(older.outcome.status, 'STALE_REVIEW');
  assert.notEqual(older.outcome.status, 'HANDOFF');
  assert.equal(older.outcome.plan.cursor_handoff, null);
  assert.equal(older.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(older.ledger.attempts['126'], current.ledger.attempts['126']);
});

test('readiness revoked by an empty structural FAIL can accept a later complete pair and still rejects the old pass', async () => {
  const policy = configuredReviewPolicy();
  const { ledger, expected } = structuralLedger('ci-after');
  const key = dedupKey('126', SHA.one, 5445420558);
  const pass = passEnvelope(expected, policy);
  const original = reviewRun(expected, policy, { id: 900, updated_at: '2026-10-15T13:00:00Z' });
  const ready = await observeStructuralReview(ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: pass,
    runs: [original],
  }).github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  const attempts = ready.ledger.attempts['126'];
  const requestId = ready.ledger.reservations[key].structural_review.request_id;
  assert.equal(requestId, ready.ledger.slots['126'].review_contract.review_request_id);
  const floorKey = `126\n${SHA.two}\n${SHA.base}`;

  const fail = envelopeFor(expected, policy, { verdict: 'FAIL', findings: [], run_id: 901 });
  const failedRun = reviewRun(expected, policy, { id: 901, updated_at: '2026-10-15T14:00:00Z' });
  const revoked = await observeStructuralReview(ready.ledger, 126, structuralWorld({
    expected,
    policy,
    envelopes: { 900: pass, 901: fail },
    runs: [original, failedRun],
  }).github, policy);
  assert.equal(revoked.outcome.status, 'READINESS_REVOKED');
  assert.equal(revoked.outcome.plan.cursor_handoff, null);
  assert.equal(revoked.outcome.plan.codex_rereview, null);
  assert.equal(revoked.ledger.reservations[key].status, 'READINESS_REVOKED');
  assert.equal(revoked.ledger.reservations[key].structural_review.request_id, requestId);
  assert.equal(revoked.ledger.attempts['126'], attempts);
  const floor = revoked.ledger.review_watermarks[floorKey].floor_at;
  assert.equal(floor, Date.parse('2026-10-15T14:00:00Z') / 1000);
  assert.equal(revoked.ledger.review_watermarks[floorKey].revoked_review_ids.includes(900), true);

  const replayed = await observeStructuralReview(revoked.ledger, 126, structuralWorld({
    expected,
    policy,
    envelopes: { 900: pass, 901: fail },
    runs: [original, failedRun],
  }).github, policy);
  assert.equal(replayed.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(replayed.outcome.status, 'READY_FOR_OWNER');
  assert.equal(replayed.outcome.plan.cursor_handoff, null);
  assert.equal(replayed.outcome.plan.codex_rereview, null);
  assert.equal(replayed.ledger.reservations[key].status, 'READINESS_REVOKED');
  assert.equal(replayed.ledger.review_watermarks[floorKey].floor_at, floor);
  assert.equal(replayed.ledger.attempts['126'], attempts);

  const oldOnly = await observeStructuralReview(revoked.ledger, 126, structuralWorld({
    expected,
    policy,
    envelope: pass,
    runs: [original],
  }).github, policy);
  assert.equal(oldOnly.outcome.status, 'STALE_REVIEW');
  assert.notEqual(oldOnly.outcome.status, 'READY_FOR_OWNER');
  assert.equal(oldOnly.ledger.reservations[key].status, 'READINESS_REVOKED');
  assert.equal(oldOnly.ledger.review_watermarks[floorKey].floor_at, floor);
  assert.equal(oldOnly.outcome.plan.cursor_handoff, null);

  const laterPass = envelopeFor(expected, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')], run_id: 904 });
  const laterRun = reviewRun(expected, policy, { id: 904, updated_at: '2026-10-15T15:00:00Z' });
  const restored = await observeStructuralReview(revoked.ledger, 126, structuralWorld({
    expected,
    policy,
    envelopes: { 900: pass, 901: fail, 904: laterPass },
    runs: [original, failedRun, laterRun],
  }).github, policy);
  assert.equal(restored.outcome.status, 'READY_FOR_OWNER');
  assert.equal(restored.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(restored.ledger.reservations[key].structural_review.request_id, requestId);
  assert.equal(restored.ledger.slots['126'].review_contract.review_request_id, requestId);
  assert.equal(restored.ledger.reservations[key].ready_review_id, 904);
  assert.equal(restored.ledger.review_watermarks[floorKey].floor_at, floor);
  assert.equal(restored.ledger.review_watermarks[floorKey].revoked_review_ids.includes(900), true);
  assert.equal(restored.ledger.attempts['126'], attempts);
  assert.equal(restored.outcome.plan.cursor_handoff, null);
  assert.equal(restored.outcome.plan.codex_rereview, null);
});

test('ready structural state loses durability on pending CI, a denied read, a moved base, and a Codex author', async () => {
  const policy = configuredReviewPolicy();
  const key = dedupKey('126', SHA.one, 5445420558);
  const prepared = structuralLedger('ci-after');
  const ready = await observeStructuralReview(prepared.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
  }).github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  const pending = apply(ready.ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.base,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'pending' },
  }));
  assert.equal(pending.outcome.status, 'WAITING_CI');
  assert.notEqual(pending.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.notEqual(pending.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const pendingRestored = await observeStructuralReview(pending.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
  }).github, policy);
  assert.equal(pendingRestored.outcome.status, 'READY_FOR_OWNER');

  const denied = await observeStructuralReview(pendingRestored.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
    fail: '/jobs',
  }).github, policy);
  assert.equal(denied.outcome.status, 'BLOCKED_INTEGRATION');
  assert.equal(denied.outcome.http_status, 403);
  assert.notEqual(denied.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const readRestored = await observeStructuralReview(denied.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
  }).github, policy);
  assert.equal(readRestored.outcome.status, 'READY_FOR_OWNER');
  assert.equal(readRestored.ledger.reservations[key].status, 'READY_FOR_OWNER');

  const moved = apply(readRestored.ledger, reviewSnapshot({
    event: 'ci_completed',
    headSha: SHA.two,
    baseSha: SHA.four,
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
  }));
  assert.equal(moved.outcome.status, 'REVIEW_REQUESTED');
  assert.notEqual(moved.outcome.status, 'IGNORED_NO_RESERVATION');
  assert.notEqual(moved.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(moved.outcome.plan.codex_rereview.verify_dispatch.workflow, 'verify');
  assert.equal(moved.outcome.plan.codex_rereview.paid_call, false);
  assert.deepEqual(moved.outcome.executed, []);
  assert.equal(moved.ledger.reservations[key].verify_dispatch.workflow, 'verify');
  assert.equal(moved.ledger.reservations[key].structural_review.base_sha, SHA.four);
  assert.notEqual(moved.ledger.reservations[key].structural_review.request_id, prepared.expected.request_id);
  const stale = await observeStructuralReview(moved.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
    pullBase: SHA.four,
  }).github, policy);
  assert.notEqual(stale.outcome.status, 'READY_FOR_OWNER');
  assert.equal(stale.ledger.reservations[key].status, 'WAITING_REREVIEW');

  const codex = structuralLedger('ci-after');
  const self = await observeStructuralReview(codex.ledger, 126, structuralWorld({
    expected: codex.expected,
    policy,
    envelope: passEnvelope(codex.expected, policy),
    author: CODEX_REVIEWER,
  }).github, policy);
  assert.equal(self.outcome.status, 'REJECTED_SELF_APPROVAL');
  assert.notEqual(self.outcome.status, 'READY_FOR_OWNER');
  assert.notEqual(self.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(self.outcome.plan.cursor_handoff, null);
});

test('a fresh pull read withdraws readiness when base, head, or pull context changes', async () => {
  const policy = configuredReviewPolicy();
  const key = dedupKey('126', SHA.one, 5445420558);
  const prepared = structuralLedger('ci-after');
  const ready = await observeStructuralReview(prepared.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
  }).github, policy);
  assert.equal(ready.outcome.status, 'READY_FOR_OWNER');
  const shifted = await observeStructuralReview(ready.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
    pullBase: SHA.four,
  }).github, policy);
  assert.equal(shifted.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(shifted.ledger.reservations[key].status, 'READY_FOR_OWNER');
  assert.equal(shifted.ledger.slots['126'].review_contract.base_sha, SHA.four);
  assert.notEqual(shifted.ledger.slots['126'].review_contract.review_request_id, prepared.expected.request_id);
  const issued = shifted.ledger.reservations[key].structural_review;
  assert.equal(issued.base_sha, SHA.four);
  assert.equal(issued.request_id, shifted.ledger.slots['126'].review_contract.review_request_id);
  const stale = await observeStructuralReview(shifted.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
    pullBase: SHA.four,
  }).github, policy);
  assert.notEqual(stale.outcome.status, 'READY_FOR_OWNER');
  assert.notEqual(stale.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const current = await observeStructuralReview(shifted.ledger, 126, structuralWorld({
    expected: issued,
    policy,
    envelope: envelopeFor(issued, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')], run_id: 901 }),
    pullBase: SHA.four,
    runs: [reviewRun(prepared.expected, policy, { id: 900 }), reviewRun(issued, policy, { id: 901 })],
    ciRuns: [ciRun(prepared.expected, policy, { id: 911 }), ciRun(issued, policy, { id: 910 })],
  }).github, policy);
  assert.equal(current.outcome.status, 'READY_FOR_OWNER');
  const closed = await observeStructuralReview(ready.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
    pullState: 'closed',
  }).github, policy);
  assert.equal(closed.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(closed.ledger.reservations[key].status, 'READY_FOR_OWNER');
  const drafted = await observeStructuralReview(ready.ledger, 126, structuralWorld({
    expected: prepared.expected,
    policy,
    envelope: passEnvelope(prepared.expected, policy),
    pullDraft: true,
  }).github, policy);
  assert.equal(drafted.outcome.status, 'BLOCKED_EVIDENCE');
  assert.notEqual(drafted.ledger.reservations[key].status, 'READY_FOR_OWNER');
});

function reviewDispatchPacket(record) {
  const policy = loadPolicy();
  const ci = {
    workflow_id: policy.workflow_ids.verify,
    workflow_path: policy.workflows.verify,
    run_id: 910,
    run_attempt: 1,
    policy_sha: record.policy_sha,
    head_sha: record.head_sha,
    base_sha: record.base_sha,
    conclusion: 'failure',
    jobs: [{ name: 'verify', conclusion: 'failure' }],
    commands_executed: [],
  };
  const obs = observation();
  obs.github = { ...obs.github, ci };
  const seen = plan(structuredClone(record), obs);
  const dispatched = plan(seen.record, obs);
  return dispatched.effects.find(effect => effect.workflow === 'review')?.packet ?? null;
}

function configuredReviewPolicy() {
  const policy = loadPolicy();
  return { ...policy, controller_actor_id: 456, workflow_ids: { ...policy.workflow_ids, review: 88001, verify: 88002 } };
}

function producerReview(headSha, baseSha, pr = 126) {
  const contract = parseContract(contractBody());
  const record = taskRecord({
    state: 'PR_REVIEW',
    head_sha: headSha,
    base_sha: baseSha,
    pr_number: pr,
    contract_hash: contract.hash,
  });
  record.binding.contract = contract;
  record.binding.required_tests = contract.required_tests;
  const opened = plan(record, observation());
  const policy = loadPolicy();
  const ci = {
    workflow_id: policy.workflow_ids.verify,
    workflow_path: policy.workflows.verify,
    run_id: 910,
    run_attempt: 1,
    policy_sha: opened.record.policy_sha,
    head_sha: headSha,
    base_sha: baseSha,
    conclusion: 'failure',
    jobs: [{ name: 'verify', conclusion: 'failure' }],
    commands_executed: [],
  };
  const obs = observation();
  obs.github = { ...obs.github, ci };
  const seen = plan(opened.record, obs);
  const dispatched = plan(seen.record, obs);
  const packet = dispatched.effects.find(effect => effect.workflow === 'review')?.packet;
  return { record: dispatched.record, packet };
}

function installFrozenContract(ledger) {
  const produced = producerReview(SHA.two, SHA.base);
  ledger.slots['126'].review_contract = produced.record;
  return produced;
}

function structuralLedger(order) {
  let ledger = apply(emptyLedger(), reviewSnapshot({ baseSha: SHA.base })).ledger;
  installFrozenContract(ledger);
  if (order === 'ci-first') {
    ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, baseSha: SHA.base, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
    const done = apply(ledger, completeSlot(ledger, 126, SHA.two));
    ledger = done.ledger;
  } else {
    ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
    ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, baseSha: SHA.base, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
  }
  const expected = ledger.reservations[dedupKey('126', SHA.one, 5445420558)].structural_review;
  const frozen = ledger.slots['126'].review_contract;
  const produced = producerReview(SHA.two, SHA.base);
  assert.equal(expected.request_id, produced.record.review_request_id);
  assert.equal(expected.contract_hash, produced.packet.contract_hash);
  assert.equal(expected.contract_hash, produced.record.contract_hash);
  assert.deepEqual(expected.required_checks, produced.packet.required_checks);
  assert.deepEqual(expected.required_checks, requiredReviewChecks(produced.record));
  assert.equal(expected.policy_sha, produced.packet.policy_sha);
  assert.equal(expected.required_checks.includes('sc-agent/owner-acceptance'), false);
  assert.equal(expected.head_sha, SHA.two);
  assert.equal(expected.base_sha, SHA.base);
  assert.equal(frozen.review_request_id, produced.record.review_request_id);
  return { ledger, expected };
}

function passEnvelope(expected, policy) {
  return envelopeFor(expected, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')] });
}

function structuralFinding(id, severity, extra = {}) {
  return {
    id,
    severity,
    path: 'docs/automation/codex-cursor-handoff-approval.md',
    line: 12,
    description: 'structural finding',
    required_fix: 'apply the structural finding',
    ...extra,
  };
}

function envelopeFor(expected, policy, patch) {
  return {
    workflow_id: policy.workflow_ids.review,
    workflow_path: policy.workflows.review,
    run_id: patch.run_id ?? 900,
    run_attempt: 1,
    policy_sha: expected.policy_sha,
    payload: {
      schema_version: 1,
      request_id: expected.request_id,
      repository_id: expected.repository_id,
      pr_number: expected.pr,
      head_sha: patch.head_sha ?? expected.head_sha,
      base_sha: expected.base_sha,
      contract_hash: expected.contract_hash,
      verdict: patch.verdict,
      acceptance_checks: expected.required_checks.map(id => ({ id, status: 'PASS', required: true })),
      findings: patch.findings ?? [],
      limitations: [],
    },
  };
}

function reviewRun(expected, policy, patch = {}) {
  return {
    id: 900,
    workflow_id: policy.workflow_ids.review,
    path: policy.workflows.review,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: expected.policy_sha,
    actor: { id: policy.controller_actor_id, login: 'skillcheck-controller[bot]', type: 'Bot' },
    display_title: `sc-agent:${expected.request_id}`,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-10-15T13:00:00Z',
    ...patch,
  };
}

function ciRun(expected, policy, patch = {}) {
  return {
    id: 910,
    workflow_id: policy.workflow_ids.verify,
    path: policy.workflows.verify,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: expected.policy_sha,
    actor: { id: policy.controller_actor_id, login: 'skillcheck-controller[bot]', type: 'Bot' },
    display_title: `sc-agent:${expected.request_id}`,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-10-15T13:05:00Z',
    ...patch,
  };
}

function ciEnvelope(expected, policy, conclusion = 'success') {
  return buildCiEnvelope({
    policy,
    policySha: expected.policy_sha,
    headSha: expected.head_sha,
    baseSha: expected.base_sha,
    runId: 910,
    runAttempt: 1,
    commandsExecuted: policy.required_ci_commands,
    conclusion,
  });
}

function structuralWorld({ expected, policy, envelope, envelopes = null, runs = null, ciRuns = null, pullHead = SHA.two, pullBase = SHA.base, pullState = 'open', pullDraft = false, author = CURSOR_ACTOR, fail = null, jobs = null }) {
  const listed = runs ?? [reviewRun(expected, policy)];
  const verifyRuns = ciRuns ?? [ciRun(expected, policy)];
  const reviewEnvelope = runId => envelopes?.[runId] ?? envelope;
  const ciBody = ciEnvelope(expected, policy, verifyRuns[0]?.conclusion === 'failure' ? 'failure' : 'success');
  const jobRows = jobs ?? [{ id: 1, name: 'verify', conclusion: verifyRuns[0]?.conclusion === 'success' ? 'success' : 'failure' }];
  const calls = [];
  const github = createGitHubClient({
    token: 'fixture',
    repository: 'krzysztofsyska/skillcheck-core',
    fetch: async (url, options) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? 'GET' });
      if (fail && href.includes(fail)) return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 });
      if (href.includes('/pulls/') && href.includes('/reviews')) {
        return new Response(JSON.stringify([githubReview({ id: 100, sha: pullHead, state: 'COMMENTED', at: '2026-10-15T12:00:00Z' })]), { status: 200 });
      }
      if (href.includes('/actions/workflows/') && href.includes('/runs')) {
        const batch = href.includes('agent-verify.yml') ? verifyRuns : listed;
        return new Response(JSON.stringify({ workflow_runs: batch }), { status: 200 });
      }
      if (href.includes('/actions/runs/') && href.includes('/jobs')) {
        return new Response(JSON.stringify({ jobs: jobRows }), { status: 200 });
      }
      if (href.includes('/artifacts/') && (href.endsWith('/zip') || href.includes('/zip'))) {
        const artifactId = Number(href.match(/\/artifacts\/(\d+)/)?.[1]);
        const verifyArtifact = artifactId === 51;
        const body = verifyArtifact ? ciBody : reviewEnvelope(artifactId - 800000);
        const name = verifyArtifact ? 'ci-result.json' : 'review-envelope.json';
        return new Response(zipStored(name, JSON.stringify(body)), { status: 200 });
      }
      if (href.includes('/actions/runs/') && href.includes('/artifacts')) {
        const runId = Number(href.match(/\/runs\/(\d+)/)?.[1]);
        const verify = verifyRuns.some(run => run.id === runId);
        return new Response(JSON.stringify({
          artifacts: [{
            id: verify ? 51 : 800000 + runId,
            name: verify ? 'sc-agent-ci' : 'sc-agent-review',
            expired: false,
            workflow_run: { id: runId },
          }],
        }), { status: 200 });
      }
      if (href.includes('/pulls/126')) {
        return new Response(JSON.stringify({
          number: 126,
          state: pullState,
          draft: pullDraft,
          user: { ...AUTHOR },
          base: { ref: 'integration', sha: pullBase, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
          head: { sha: pullHead, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
        }), { status: 200 });
      }
      if (href.includes('/branches/main')) return new Response(JSON.stringify({ name: 'main', commit: { sha: '9'.repeat(40) } }), { status: 200 });
      if (href.includes(`/commits/${encodeURIComponent(expected.head_sha)}`) || href.includes(`/commits/${expected.head_sha}`)) {
        return new Response(JSON.stringify({
          sha: expected.head_sha,
          commit: { author: { name: 'Cursor Name', email: 'cursor@example.com' }, message: 'fix' },
          author: { ...author },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'missing' }), { status: 404 });
    },
  });
  return { github, calls };
}

function zipStored(name, text) {
  const file = Buffer.from(text);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(file.length, 18);
  local.writeUInt32LE(file.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(file.length, 20);
  central.writeUInt32LE(file.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBuf.length, 12);
  end.writeUInt32LE(30 + nameBuf.length + file.length, 16);
  return Buffer.concat([local, nameBuf, file, central, nameBuf, end]);
}
