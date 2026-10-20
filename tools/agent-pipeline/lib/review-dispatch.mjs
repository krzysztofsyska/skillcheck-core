export function reviewDispatchDecision({ actorId, pipelineEnabled, controllerActorId, runAttempt }) {
  if (runAttempt !== '1') return { ok: false, reason: 'rerun_rejected' };
  if (pipelineEnabled !== 'true') return { ok: false, reason: 'pipeline_disabled' };
  if (!Number.isInteger(controllerActorId) || !Number.isSafeInteger(controllerActorId) || controllerActorId <= 0) {
    return { ok: false, reason: 'controller_actor_unconfigured' };
  }
  if (typeof actorId !== 'string' || !/^[1-9]\d*$/.test(actorId)) return { ok: false, reason: 'actor_untrusted' };
  const actor = Number(actorId);
  if (!Number.isSafeInteger(actor) || actor !== controllerActorId) return { ok: false, reason: 'actor_untrusted' };
  return { ok: true, reason: 'controller' };
}
