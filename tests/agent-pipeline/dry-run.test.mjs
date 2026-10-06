import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCompleteCycle } from '../../tools/agent-pipeline/fixtures/complete-cycle.mjs';

test('dry-run completes one repair and stops at gates A and B', async () => {
  const result = await runCompleteCycle();
  assert.equal(result.network.length, 0);
  assert.equal(result.calls.includes('github.merge'), false);
  assert.equal(result.record.repair_round, 1);
  assert.equal(result.record.state, 'READY_FOR_OWNER');
  assert.equal(result.record.binding.approval.gate, 'A');
  assert.equal(result.promotion.state, 'READY_FOR_PROD');
  assert.equal(result.promotion.binding.approval.gate, 'B');
  assert.equal(result.flags.enabled, false);
  assert.equal(result.flags.mergeEnabled, false);
  assert.equal(result.ok, true);
});
