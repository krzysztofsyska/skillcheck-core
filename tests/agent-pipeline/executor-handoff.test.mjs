import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_SIGNALS, SUBSCRIPTION_EXECUTORS, classifyExecutorSignal, handoffKey,
  otherExecutor, planHandoff, verifyResume, verifyReviewerIndependence,
} from '../../tools/agent-pipeline/lib/executor-handoff.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function input(overrides = {}) {
  return {
    task: 'SC-436',
    signal: HANDOFF_SIGNALS.USAGE_LIMIT,
    from: 'claude-code',
    availability: { codex: true },
    base: BASE,
    head: HEAD,
    branch: 'claude/sc-436-slice',
    pr: 460,
    builderSessions: ['session-claude-1'],
    ...overrides,
  };
}

test('only the two subscription executors exist and swap with each other', () => {
  assert.deepEqual([...SUBSCRIPTION_EXECUTORS], ['claude-code', 'codex']);
  assert.equal(otherExecutor('claude-code'), 'codex');
  assert.equal(otherExecutor('codex'), 'claude-code');
  for (const unknown of ['cursor', 'openai-api', 'anthropic-api', '', undefined]) assert.equal(otherExecutor(unknown), null);
});

test('signals come only from known structured codes, never free text or forecasts', () => {
  assert.equal(classifyExecutorSignal({ status: 'failed', signal: 'USAGE_LIMIT' }), 'USAGE_LIMIT');
  assert.equal(classifyExecutorSignal({ status: 'failed', signal: 'OAUTH_EXPIRED' }), 'OAUTH_EXPIRED');
  assert.equal(classifyExecutorSignal({ status: 'failed', signal: 'EXECUTOR_UNAVAILABLE' }), 'EXECUTOR_UNAVAILABLE');
  assert.equal(classifyExecutorSignal({ status: 'success', signal: 'USAGE_LIMIT' }), null);
  assert.equal(classifyExecutorSignal({ status: 'failed', message: 'You have hit your usage limit' }), null);
  assert.equal(classifyExecutorSignal({ status: 'failed', signal: 'LOW_BALANCE_FORECAST' }), null);
  assert.equal(classifyExecutorSignal(null), null);
});

test('a usage limit on Claude hands the same branch and PR to Codex', () => {
  const result = planHandoff(input());
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  const h = result.handoff;
  assert.equal(h.from, 'claude-code');
  assert.equal(h.to, 'codex');
  assert.equal(h.base_sha, BASE);
  assert.equal(h.head_sha, HEAD);
  assert.equal(h.branch, 'claude/sc-436-slice');
  assert.equal(h.pr, 460);
  assert.equal(h.next_action, 'RESUME_EXISTING_PR');
  assert.equal(h.paid_api_fallback, false);
  assert.equal(h.key, handoffKey({ task: 'SC-436', headSha: HEAD, to: 'codex' }));
  assert.ok(Object.isFrozen(h));
});

test('expired OAuth on Codex hands over to Claude; without a PR the next step is one Draft PR', () => {
  const result = planHandoff(input({
    signal: HANDOFF_SIGNALS.OAUTH_EXPIRED, from: 'codex', availability: { 'claude-code': true }, pr: null,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.handoff.to, 'claude-code');
  assert.equal(result.handoff.next_action, 'RESUME_BRANCH_OPEN_DRAFT_PR');
});

test('no paid API, Cursor or self-handoff as a target', () => {
  for (const to of ['openai-api', 'anthropic-api', 'cursor', 'auto']) {
    assert.equal(planHandoff(input({ to })).reason, 'HANDOFF_TARGET_NOT_SUBSCRIPTION_EXECUTOR', to);
  }
  assert.equal(planHandoff(input({ to: 'claude-code' })).reason, 'HANDOFF_TARGET_IS_SOURCE');
  assert.equal(planHandoff(input({ from: 'cursor' })).reason, 'HANDOFF_FROM_NOT_SUBSCRIPTION_EXECUTOR');
});

test('target unavailable or unknown parks the task with its state, it is not dispatched', () => {
  for (const availability of [{ codex: false }, {}, undefined, { codex: 'yes' }]) {
    const result = planHandoff(input({ availability }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HANDOFF_NO_EXECUTOR_AVAILABLE');
    assert.deepEqual(result.parked, {
      task: 'SC-436', from: 'claude-code', signal: 'USAGE_LIMIT', base: BASE, head: HEAD,
      branch: 'claude/sc-436-slice', pr: 460, next_action: 'WAIT_FOR_EXECUTOR',
    });
  }
});

test('invalid inputs fail closed', () => {
  assert.equal(planHandoff(input({ signal: 'SOMETHING' })).reason, 'HANDOFF_SIGNAL_UNRECOGNIZED');
  assert.equal(planHandoff(input({ task: '' })).reason, 'HANDOFF_TASK_INVALID');
  assert.equal(planHandoff(input({ head: 'b'.repeat(39) })).reason, 'HANDOFF_SHA_INVALID');
  assert.equal(planHandoff(input({ base: 'B'.repeat(40) })).reason, 'HANDOFF_SHA_INVALID');
  for (const branch of ['main', 'integration', '', 'a b']) {
    assert.equal(planHandoff(input({ branch })).reason, 'HANDOFF_BRANCH_INVALID', branch);
  }
  for (const pr of [0, -1, 1.5, '460']) assert.equal(planHandoff(input({ pr })).reason, 'HANDOFF_PR_INVALID');
  for (const builderSessions of [undefined, [], [''], ['ok', null]]) {
    assert.equal(planHandoff(input({ builderSessions })).reason, 'HANDOFF_BUILDER_SESSIONS_UNKNOWN');
  }
  assert.equal(planHandoff(input({ previous: 'x' })).reason, 'HANDOFF_HISTORY_INVALID');
  assert.equal(planHandoff().reason, 'HANDOFF_TASK_INVALID');
});

test('a repeated signal on the same head is a duplicate, not a second handoff', () => {
  const first = planHandoff(input()).handoff;
  const again = planHandoff(input({ previous: [first] }));
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.handoff, first);
});

test('a new head after real work allows a fresh handoff; two open handoffs to different executors do not', () => {
  const first = planHandoff(input()).handoff;
  const next = planHandoff(input({ head: OTHER, previous: [first] }));
  assert.equal(next.ok, true);
  assert.equal(next.duplicate, false);
  const back = planHandoff(input({
    from: 'codex', availability: { 'claude-code': true }, head: OTHER, previous: [first],
  }));
  assert.equal(back.reason, 'HANDOFF_CONFLICTING_OPEN_HANDOFF');
  const closed = { ...first, state: 'ACCEPTED' };
  assert.equal(planHandoff(input({
    from: 'codex', availability: { 'claude-code': true }, head: OTHER, previous: [closed],
  })).ok, true);
});

test('resume only by the target executor on the exact handed-over head', () => {
  const h = planHandoff(input()).handoff;
  assert.deepEqual(verifyResume(h, { executor: 'codex', currentHead: HEAD }), { ok: true, next_action: 'RESUME_EXISTING_PR' });
  assert.equal(verifyResume(h, { executor: 'claude-code', currentHead: HEAD }).reason, 'RESUME_WRONG_EXECUTOR');
  assert.equal(verifyResume(h, { executor: 'codex', currentHead: OTHER }).reason, 'RESUME_HEAD_MOVED');
  assert.equal(verifyResume(h, { executor: 'codex', currentHead: 'nope' }).reason, 'RESUME_HEAD_INVALID');
  assert.equal(verifyResume({ ...h, state: 'ACCEPTED' }, { executor: 'codex', currentHead: HEAD }).reason, 'RESUME_HANDOFF_NOT_OPEN');
  assert.equal(verifyResume(null, {}).reason, 'RESUME_HANDOFF_NOT_OPEN');
});

test('the reviewer differs from every builder session, before and after the handoff', () => {
  const h = planHandoff(input({ builderSessions: ['session-claude-1', 'session-claude-1', 'session-claude-2'] })).handoff;
  assert.deepEqual([...h.reviewer_excluded_sessions], ['session-claude-1', 'session-claude-2']);
  assert.equal(verifyReviewerIndependence(h, 'session-claude-2').reason, 'REVIEWER_IS_BUILDER');
  assert.equal(verifyReviewerIndependence(h, 'session-codex-7', ['session-codex-7']).reason, 'REVIEWER_IS_BUILDER');
  assert.deepEqual(verifyReviewerIndependence(h, 'session-reviewer-9', ['session-codex-7']), { ok: true });
  assert.equal(verifyReviewerIndependence(h, '').reason, 'REVIEWER_SESSION_INVALID');
  assert.equal(verifyReviewerIndependence({}, 'session-reviewer-9').reason, 'REVIEWER_EXCLUSIONS_UNKNOWN');
  assert.equal(verifyReviewerIndependence(h, 'session-reviewer-9', null).reason, 'REVIEWER_EXCLUSIONS_UNKNOWN');
});

test('the module has no side-effect imports (no network, process or filesystem)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../tools/agent-pipeline/lib/executor-handoff.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /process\.env|fetch\(|API_KEY/);
});
