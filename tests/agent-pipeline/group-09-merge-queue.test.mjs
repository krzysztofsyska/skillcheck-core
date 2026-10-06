import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMerge, reconcileMergeTimeout } from '../../tools/agent-pipeline/lib/merge.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { observation, taskRecord } from './helpers.mjs';

const protection = { exclusiveWritersConfirmed: true, scOps001Exception: false, mainProtected: true, integrationProtected: true, agentStateProtected: true, qualityGatesBypass: false, administrationWriteUsed: false, requiredChecksPinnedToApp: true };

test('the merge lock rejects a base change and a timeout is reconciled without a second merge', () => {
  const locked = decideMerge({ flags: { enabled: true, mergeEnabled: true }, protection, lock: { holder: 'other' }, holder: 'SC-DEMO-001', liveBaseSha: 'c'.repeat(40), expectedBaseSha: 'c'.repeat(40), liveHeadSha: 'a'.repeat(40), expectedHeadSha: 'a'.repeat(40), approval: { ok: true }, gate: 'A', runbook: true, owner: 'krzysztofsyska', repo: 'skillcheck-core', prNumber: 50 });
  assert.equal(locked.reason, 'MERGE_LOCKED');
  const moved = decideMerge({ flags: { enabled: true, mergeEnabled: true }, protection, lock: { holder: 'SC-DEMO-001' }, holder: 'SC-DEMO-001', liveBaseSha: 'e'.repeat(40), expectedBaseSha: 'c'.repeat(40), liveHeadSha: 'a'.repeat(40), expectedHeadSha: 'a'.repeat(40), approval: { ok: true }, gate: 'A', runbook: true, owner: 'krzysztofsyska', repo: 'skillcheck-core', prNumber: 50 });
  assert.equal(moved.reason, 'APPROVAL_STALE');

  const reconciled = reconcileMergeTimeout({ merged: true, mergeCommitSha: 'f'.repeat(40) });
  assert.equal(reconciled.retry, false);
  assert.equal(reconciled.state, 'MERGED_AWAITING_DEPLOYMENT');

  const record = taskRecord({ state: 'READY_FOR_OWNER' });
  record.binding.merge = { phase: 'awaiting_confirmation', expectedHeadSha: 'a'.repeat(40), gate: 'A' };
  const obs = observation();
  obs.github.pull = { merged: true, mergeCommitSha: 'f'.repeat(40), headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40) };
  const decision = plan(record, obs);
  assert.equal(decision.effects.some(effect => effect.type === 'github.merge'), false);
  assert.equal(decision.record.state, 'ACCEPTED');
  assert.equal(decision.record.binding.merge.retry, false);
});
