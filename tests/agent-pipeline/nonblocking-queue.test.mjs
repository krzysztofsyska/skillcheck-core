import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleWork } from '../../tools/agent-pipeline/lib/snapshot.mjs';
import { contractBody, loadedPolicy, taskRecord } from './helpers.mjs';

const NOW = '2026-10-06T12:05:00.000Z';
const MERGE = 'f'.repeat(40);

function readyIssue(number, id, dependsOn = 'NONE') {
  return {
    number,
    user: { id: loadedPolicy().policy.owner.id, login: 'krzysztofsyska' },
    body: contractBody()
      .replace('TASK: SC-DEMO-001', `TASK: ${id}`)
      .replace('DEPENDS_ON: NONE', `DEPENDS_ON: ${dependsOn}`),
  };
}

function work(records, issues, postMergeCi = {}, now = NOW, flags = {}) {
  const { policy, policySha } = loadedPolicy();
  return assembleWork({
    policy, policySha, now, flags, secrets: { cursor: false, openai: false, githubApp: false },
    snapshot: {
      records, issues, pulls: [], postMergeCi,
      integrationSha: 'c'.repeat(40), mainSha: 'd'.repeat(40),
    },
  });
}

function blockedPostMerge() {
  const record = taskRecord({ state: 'BLOCKED', technical_state: 'WAITING_POST_MERGE_CI' });
  record.task_id = 'SC-ROOT';
  record.blocked_reason = 'POST_MERGE_CI_TIMEOUT';
  record.binding.post_merge_ci = { blocked: true, pending: true };
  record.binding.merge = { mergeCommitSha: MERGE, confirmed_at: '2026-10-06T12:00:00.000Z' };
  return record;
}

test('a blocked post-merge check parks the task, not unrelated work', () => {
  const blocked = blockedPostMerge();
  const result = work({ [blocked.task_id]: blocked }, [
    readyIssue(21, 'SC-UNRELATED'),
    readyIssue(22, 'SC-DEPENDS', 'SC-ROOT'),
  ], { 'SC-ROOT': { pending: true } });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].record, null);
  assert.equal(result.items[0].observation.issue.number, 21);
});

test('a dependent task stays parked until post-merge CI is verified', () => {
  const parent = blockedPostMerge();
  parent.state = 'ACCEPTED';
  parent.binding.post_merge_ci.blocked = false;
  const result = work({ [parent.task_id]: parent }, [
    readyIssue(21, 'SC-UNRELATED'),
    readyIssue(22, 'SC-DEPENDS', 'SC-ROOT'),
  ], { 'SC-ROOT': { pending: true } });
  assert.equal(result.items[0].observation.issue.number, 21);
  assert.equal(result.items.some(item => item.observation.issue?.number === 22), false);
});

test('verified recovery of failed post-merge CI has priority over fresh work', () => {
  const blocked = blockedPostMerge();
  const result = work({ [blocked.task_id]: blocked },
    [readyIssue(21, 'SC-UNRELATED')],
    { 'SC-ROOT': { ok: true, headSha: MERGE, pending: false } });
  assert.equal(result.items[0].record?.task_id, 'SC-ROOT');
});

test('waiting for review does not hold an independent READY task', () => {
  const inReview = taskRecord({ state: 'PR_REVIEW', technical_state: 'WAITING_CI' });
  inReview.task_id = 'SC-REVIEWING';
  inReview.review_request_id = 'review-request';
  inReview.binding.review_dispatched = true;
  const result = work({ [inReview.task_id]: inReview }, [readyIssue(21, 'SC-UNRELATED')]);
  assert.equal(result.items[0].observation.issue.number, 21);

  // A real timeout must still get a controller turn, rather than being skipped.
  const timedOut = work({ [inReview.task_id]: inReview },
    [readyIssue(21, 'SC-UNRELATED')], {}, '2026-10-06T13:00:00.000Z');
  assert.equal(timedOut.items[0].record?.task_id, inReview.task_id);
});

test('two unfinished tasks preserve the WIP limit and do not create a third', () => {
  const first = taskRecord({ state: 'PR_REVIEW', technical_state: 'WAITING_CI' });
  first.task_id = 'SC-FIRST';
  first.review_request_id = 'review-request';
  first.binding.review_dispatched = true;
  const second = taskRecord({ state: 'BUILDING' });
  second.task_id = 'SC-SECOND';
  second.cursor_run_id = 'run-10';
  const result = work({
    [first.task_id]: first, [second.task_id]: second,
  }, [readyIssue(21, 'SC-THIRD')]);
  assert.notEqual(result.items[0].observation.issue?.number, 21);
});

test('a merge-disabled READY_FOR_OWNER task yields to unrelated work; enabling merge restores priority', () => {
  const approved = taskRecord({ state: 'READY_FOR_OWNER' });
  approved.task_id = 'SC-MERGE-PENDING';
  const records = { [approved.task_id]: approved };
  const issues = [readyIssue(21, 'SC-UNRELATED')];
  const disabled = work(records, issues, {}, NOW, { enabled: true, mergeEnabled: false });
  assert.equal(disabled.items[0].observation.issue.number, 21);
  const enabled = work(records, issues, {}, NOW, { enabled: true, mergeEnabled: true });
  assert.equal(enabled.items[0].record?.task_id, approved.task_id);
});

test('production promotion never overtakes an unverified post-merge check', () => {
  const blocked = blockedPostMerge();
  const { policy, policySha } = loadedPolicy();
  const result = assembleWork({
    policy, policySha, now: NOW, secrets: {},
    flags: { enabled: true, mergeEnabled: true },
    snapshot: {
      records: { [blocked.task_id]: blocked },
      issues: [readyIssue(21, 'SC-UNRELATED')], pulls: [],
      postMergeCi: { 'SC-ROOT': { pending: true } },
      promotion: { taskId: 'SC-PROMOTION', manifest: { tasks: [] }, runbook: { id: 'test' } },
      integrationSha: 'c'.repeat(40), mainSha: 'd'.repeat(40),
    },
  });
  assert.equal(result.items[0].observation.issue.number, 21);
  assert.equal(result.items[0].observation.kind, 'task');
});
