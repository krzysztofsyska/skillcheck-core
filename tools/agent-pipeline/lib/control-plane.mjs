const SHA = /^[a-f0-9]{40}$/;
export const OPERATIONAL_BRANCH = 'agent-control-runtime';

// This descriptor comes from the protected controller checkout, never a task
// packet. Operational mode has no production capability, even for old records.
export function controlPlane(policy = {}) {
  const configured = policy.control_plane;
  if (configured === undefined) return { branch: 'main', mode: 'full' };
  if (!configured || Object.keys(configured).some(k => !['branch', 'mode'].includes(k))) {
    throw new Error('CONTROL_PLANE_INVALID');
  }
  if (configured.branch === 'main' && configured.mode === 'full') return configured;
  if (configured.branch === OPERATIONAL_BRANCH && configured.mode === 'integration-only') return configured;
  throw new Error('CONTROL_PLANE_INVALID');
}

export function integrationOnly(policy) {
  return controlPlane(policy).mode === 'integration-only';
}

export function workflowRef(policy, kind) {
  return ['accept', 'promote'].includes(kind) ? 'main' : controlPlane(policy).branch;
}

export async function assertPolicyExecution({ policy, github, env, policySha = env.GITHUB_SHA }) {
  const branch = controlPlane(policy).branch;
  if (env.GITHUB_REPOSITORY !== policy.repository || env.GITHUB_REF !== `refs/heads/${branch}`
      || !SHA.test(policySha ?? '') || policySha !== env.GITHUB_SHA) {
    throw new Error('CONTROL_SOURCE_UNTRUSTED');
  }
  await assertCurrentControlRevision({ policy, github, policySha });
  return policySha;
}

// policySha is the executing checkout's immutable revision, not a task record:
// a current controller must still be able to report a stale task as blocked.
export async function assertCurrentControlRevision({ policy, github, policySha }) {
  if (!SHA.test(policySha ?? '')) throw new Error('POLICY_COMMIT_MISSING');
  const current = await github.readBranch(controlPlane(policy).branch);
  if (current?.commit?.sha !== policySha) throw new Error('POLICY_STALE');
}

export function isProductionRecord(record) {
  return record?.binding?.lane === 'promotion' || record?.binding?.approval?.gate === 'B'
    || record?.binding?.merge?.gate === 'B';
}

export function assertControlEffect(policy, effect) {
  if (effect.type === 'cursor.create' && (effect.branch === OPERATIONAL_BRANCH
      || effect.payload?.repos?.some(repo => repo.startingRef === OPERATIONAL_BRANCH))) {
    throw new Error('REF_FORBIDDEN');
  }
  if (!integrationOnly(policy)) return;
  if ((effect.type === 'github.createPr' && effect.base !== 'integration')
      || (effect.type === 'github.dispatch' && !['verify', 'review'].includes(effect.workflow))
      || (effect.type === 'github.merge' && (effect.gate !== 'A' || isProductionRecord(effect.record)))) {
    throw new Error('PRODUCTION_DISABLED_FOR_CONTROL_PLANE');
  }
}
