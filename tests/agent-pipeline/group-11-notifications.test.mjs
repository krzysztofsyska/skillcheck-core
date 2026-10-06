import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification, reconcileOutbox } from '../../tools/agent-pipeline/lib/notifications.mjs';
import { fold } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { observation, taskRecord } from './helpers.mjs';

test('notification ids are stable and a delivery failure does not change the gate or the result', () => {
  const input = { taskId: 'SC-DEMO-001', stateRevision: 4, recipient: 'krzysztofsyska', kind: 'READY_FOR_OWNER', headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40), result: 'READY_FOR_OWNER', evidenceUrl: 'https://github.com/krzysztofsyska/skillcheck-core/pull/50', actionUrl: 'https://github.com/krzysztofsyska/skillcheck-core/actions/runs/1' };
  const first = buildNotification(input);
  const second = buildNotification(input);
  assert.equal(first.notification_id, second.notification_id);
  const foreign = reconcileOutbox({ pending: first, comments: [{ id: 9, author_id: 1, body: first.body }], authorId: 222297538 });
  assert.equal(foreign.delivered, false);
  const record = taskRecord({ state: 'READY_FOR_OWNER', approval_request_id: 'req-a', notification_id: first.notification_id });
  record.binding.approval = { gate: 'A', request_id: 'req-a' };
  const failed = fold(record, { type: 'notify', notification: first }, { ok: false, error: 'timeout' }, observation());
  assert.equal(failed.state, 'READY_FOR_OWNER');
  assert.equal(failed.approval_request_id, 'req-a');
  assert.equal(failed.binding.approval.gate, 'A');
  assert.equal(failed.binding.reports.at(-1).kind, 'NOTIFICATION_FAILED');
});
