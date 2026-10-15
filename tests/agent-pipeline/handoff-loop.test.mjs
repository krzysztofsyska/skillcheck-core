import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { createGitHubClient } from '../../tools/agent-pipeline/lib/github.mjs';
import { runHandoffCli } from '../../tools/agent-pipeline/handoff-cli.mjs';
import { agentIdFor, operationKey } from '../../tools/agent-pipeline/lib/canonical.mjs';
import { occupiedCount } from '../../tools/agent-pipeline/lib/handoff-admission.mjs';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
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

const MAIN = 'f'.repeat(40);

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

function configuredReviewPolicy() {
  const policy = loadPolicy();
  return { ...policy, controller_actor_id: 456, workflow_ids: { ...policy.workflow_ids, review: 88001 } };
}

function structuralLedger(order) {
  let ledger = apply(emptyLedger(), reviewSnapshot({ baseSha: SHA.base })).ledger;
  if (order === 'ci-first') {
    ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, baseSha: SHA.base, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
    const done = apply(ledger, completeSlot(ledger, 126, SHA.two));
    ledger = done.ledger;
  } else {
    ledger = apply(ledger, completeSlot(ledger, 126, SHA.two)).ledger;
    ledger = apply(ledger, reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, baseSha: SHA.base, threads: [], ci: { sha: SHA.two, conclusion: 'success' } })).ledger;
  }
  const expected = ledger.reservations[dedupKey('126', SHA.one, 5445420558)].structural_review;
  assert.ok(expected?.request_id);
  assert.equal(expected.head_sha, SHA.two);
  assert.equal(expected.base_sha, SHA.base);
  return { ledger, expected };
}

function passEnvelope(expected, policy) {
  return envelopeFor(expected, policy, { verdict: 'PASS', findings: [structuralFinding('note', 'info')] });
}

function structuralFinding(id, severity) {
  return {
    id,
    severity,
    path: 'docs/automation/codex-cursor-handoff-approval.md',
    line: 12,
    description: 'structural finding',
    required_fix: 'apply the structural finding',
  };
}

function envelopeFor(expected, policy, patch) {
  return {
    workflow_id: policy.workflow_ids.review,
    workflow_path: policy.workflows.review,
    run_id: 900,
    run_attempt: 1,
    policy_sha: MAIN,
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
    head_sha: MAIN,
    actor: { id: policy.controller_actor_id, login: 'skillcheck-controller[bot]', type: 'Bot' },
    display_title: `sc-agent:${expected.request_id}`,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-10-15T13:00:00Z',
    ...patch,
  };
}

function structuralWorld({ expected, policy, envelope, runs = null, pullHead = SHA.two, pullBase = SHA.base, author = CURSOR_ACTOR, fail = null }) {
  const listed = runs ?? [reviewRun(expected, policy)];
  const calls = [];
  const github = createGitHubClient({
    token: 'fixture',
    repository: 'krzysztofsyska/skillcheck-core',
    fetch: async (url, options) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? 'GET' });
      if (fail && href.includes(fail)) return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 });
      if (href.includes('/pulls/') && href.includes('/reviews')) {
        return new Response(JSON.stringify([githubReview({ id: 100, sha: SHA.two, state: 'COMMENTED', at: '2026-10-15T12:00:00Z' })]), { status: 200 });
      }
      if (href.includes('/actions/workflows/') && href.includes('/runs')) {
        return new Response(JSON.stringify({ workflow_runs: listed }), { status: 200 });
      }
      if (href.includes('/artifacts/') && href.endsWith('/zip') || href.includes('/artifacts/') && href.includes('/zip')) {
        return new Response(zipStored('review-envelope.json', JSON.stringify(envelope)), { status: 200 });
      }
      if (href.includes('/actions/runs/') && href.includes('/artifacts')) {
        return new Response(JSON.stringify({ artifacts: [{ id: 50, name: 'sc-agent-review', expired: false, workflow_run: { id: listed[0].id } }] }), { status: 200 });
      }
      if (href.includes('/pulls/126')) {
        return new Response(JSON.stringify({
          number: 126,
          state: 'open',
          draft: false,
          user: { ...AUTHOR },
          base: { ref: 'integration', sha: pullBase, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
          head: { sha: pullHead, repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
        }), { status: 200 });
      }
      if (href.includes('/branches/main')) return new Response(JSON.stringify({ name: 'main', commit: { sha: MAIN } }), { status: 200 });
      if (href.includes(`/commits/${encodeURIComponent(SHA.two)}`) || href.includes(`/commits/${SHA.two}`)) {
        return new Response(JSON.stringify({
          sha: SHA.two,
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
