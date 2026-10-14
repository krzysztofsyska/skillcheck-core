import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { runHandoffCli } from '../../tools/agent-pipeline/handoff-cli.mjs';
import {
  CODEX_REVIEWER,
  CURSOR_HANDOFF_TEMPLATE,
  HANDOFF_ATTEMPT_LIMIT,
  LIVE_EFFECTS_ENABLED,
  dedupKey,
  emptyLedger,
  handoffIdFor,
  normalizeGithubEvent,
  step,
} from '../../tools/agent-pipeline/lib/handoff-loop.mjs';

const SHA = {
  one: 'a'.repeat(40),
  two: 'b'.repeat(40),
  three: 'c'.repeat(40),
  four: 'd'.repeat(40),
};
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
  };
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
  assert.equal(secondComment.outcome.status, 'DUPLICATE');
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
  assert.equal(requested.outcome.status, 'REVIEW_REQUESTED');
  assert.equal(requested.outcome.plan.codex_rereview.author_approval_counts, false);
  assert.equal(requested.outcome.plan.codex_rereview.paid_call, false);
  assert.equal(requested.outcome.plan.cursor_handoff, null);
  assert.equal(requestedAgain.outcome.status, 'DUPLICATE');

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
  assert.equal(selfApproval.outcome.status, 'REJECTED_SELF_APPROVAL');

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
  assert.equal(committerApproval.outcome.status, 'REJECTED_SELF_APPROVAL');

  const ready = apply(ledger, reviewSnapshot({
    headSha: SHA.two,
    reviewId: 603,
    reviewState: 'approved',
    threads: [],
    ci: { sha: SHA.two, conclusion: 'success' },
    fixAuthor: { id: 7, login: 'cursor[bot]', type: 'Bot' },
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
  });
  const blocked = apply(ledger, reviewSnapshot({ headSha: SHA.four, reviewId: 1003, threads: [thread(103, 1003, SHA.four)] }));
  assert.equal(blocked.outcome.status, 'BLOCKED_LIMIT');
  assert.equal(blocked.ledger.attempts['126'], HANDOFF_ATTEMPT_LIMIT);
  assert.equal(blocked.outcome.plan.cursor_handoff, null);
  const replay = apply(blocked.ledger, reviewSnapshot({ reviewId: 1000, threads: [thread(100, 1000, SHA.one)] }));
  assert.equal(replay.outcome.status, 'DUPLICATE');
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
    comments: [{ id: 15, commit_id: SHA.one, pull_request_review_id: 11, path: 'README.md', line: 2, body: SENTINEL }],
  }]);
  assert.equal(JSON.stringify(normalized).includes(SENTINEL), false);
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
  assert.equal(readFileSync('tools/agent-pipeline/handoff-cli.mjs', 'utf8').includes('fetch('), false);
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
  writeFileSync(fixture, JSON.stringify([
    reviewSnapshot(),
    reviewSnapshot({ event: 'pull_request_review_comment' }),
    reviewSnapshot({ event: 'head_advanced', headSha: SHA.two, threads: [], ci: { sha: SHA.two, conclusion: 'success' } }),
    reviewSnapshot({ headSha: SHA.two, reviewId: 700, reviewState: 'approved', threads: [], ci: { sha: SHA.two, conclusion: 'success' } }),
  ]));
  const sandboxLogs = [];
  const code = runHandoffCli(['--sandbox', fixture], {}, { log: line => sandboxLogs.push(line), error: line => errors.push(line) });
  assert.equal(code, 0, errors.join('\n'));
  const report = JSON.parse(sandboxLogs.at(-1));
  assert.deepEqual(report.statuses, ['HANDOFF', 'DUPLICATE', 'REVIEW_REQUESTED', 'READY_FOR_OWNER']);
  assert.equal(report.executed, 0);
  assert.equal(report.live_effects, false);
  assert.equal(report.attempts['126'], 1);
  assert.equal(runHandoffCli(['--sandbox', join(process.cwd(), 'package.json')], {}, { log: () => {}, error: line => errors.push(line) }), 1);
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
