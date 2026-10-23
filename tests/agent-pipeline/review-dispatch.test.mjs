import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { reviewDispatchDecision } from '../../tools/agent-pipeline/lib/review-dispatch.mjs';

test('paid review dispatch requires the enabled flag and the configured controller actor', () => {
  const allowed = reviewDispatchDecision({ actorId: '456', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '1' });
  assert.deepEqual(allowed, { ok: true, reason: 'controller' });

  const cases = [
    [{ actorId: '456', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '2' }, 'rerun_rejected'],
    [{ actorId: '456', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: 1 }, 'rerun_rejected'],
    [{ actorId: '456', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '' }, 'rerun_rejected'],
    [{ actorId: '456', pipelineEnabled: 'false', controllerActorId: 456, runAttempt: '1' }, 'pipeline_disabled'],
    [{ actorId: '456', pipelineEnabled: 'TRUE', controllerActorId: 456, runAttempt: '1' }, 'pipeline_disabled'],
    [{ actorId: '456', pipelineEnabled: true, controllerActorId: 456, runAttempt: '1' }, 'pipeline_disabled'],
    [{ actorId: '456', pipelineEnabled: 'true ', controllerActorId: 456, runAttempt: '1' }, 'pipeline_disabled'],
    [{ actorId: '456', pipelineEnabled: 'true', controllerActorId: null, runAttempt: '1' }, 'controller_actor_unconfigured'],
    [{ actorId: '456', pipelineEnabled: 'true', controllerActorId: 0, runAttempt: '1' }, 'controller_actor_unconfigured'],
    [{ actorId: '456', pipelineEnabled: 'true', controllerActorId: '456', runAttempt: '1' }, 'controller_actor_unconfigured'],
    [{ actorId: '457', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '1' }, 'actor_untrusted'],
    [{ actorId: '0456', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '1' }, 'actor_untrusted'],
    [{ actorId: '456abc', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '1' }, 'actor_untrusted'],
    [{ actorId: '', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '1' }, 'actor_untrusted'],
    [{ actorId: 456, pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '1' }, 'actor_untrusted'],
    [{ actorId: '9007199254740993', pipelineEnabled: 'true', controllerActorId: 456, runAttempt: '1' }, 'actor_untrusted'],
  ];
  for (const [input, reason] of cases) {
    assert.deepEqual(reviewDispatchDecision(input), { ok: false, reason }, reason);
  }
});

test('checked-in policy cannot authorize a paid review dispatch', () => {
  const policy = loadPolicy();
  assert.equal(policy.flags.AGENT_PIPELINE_ENABLED, false);
  assert.equal(policy.flags.AGENT_PIPELINE_MERGE_ENABLED, false);
  assert.equal(policy.controller_actor_id, 338844913);
  const ownerDispatch = reviewDispatchDecision({
    actorId: String(policy.owner.id),
    pipelineEnabled: 'true',
    controllerActorId: policy.controller_actor_id,
    runAttempt: '1',
  });
  const disabledDispatch = reviewDispatchDecision({
    actorId: String(policy.controller_actor_id),
    pipelineEnabled: 'false',
    controllerActorId: policy.controller_actor_id,
    runAttempt: '1',
  });
  assert.equal(policy.environments.agent_review.id, 23622706434);
  assert.deepEqual(ownerDispatch, { ok: false, reason: 'actor_untrusted' });
  assert.deepEqual(disabledDispatch, { ok: false, reason: 'pipeline_disabled' });
});
