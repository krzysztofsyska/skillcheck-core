export function evaluatePreflight(protection) {
  if (!protection) return { ok: false, reason: 'PROTECTION_UNCONFIRMED' };
  if (protection.administrationWriteUsed) return { ok: false, reason: 'ADMINISTRATION_WRITE_FORBIDDEN' };
  if (protection.scOps001Exception) return { ok: false, reason: 'SC_OPS_001_REJECTED' };
  if (!protection.exclusiveWritersConfirmed) return { ok: false, reason: 'EXCLUSIVE_WRITERS_UNCONFIRMED' };
  if (protection.qualityGatesBypass) return { ok: false, reason: 'QUALITY_GATE_BYPASS' };
  if (!protection.mainProtected || !protection.integrationProtected || !protection.agentStateProtected) {
    return { ok: false, reason: 'PROTECTION_UNCONFIRMED' };
  }
  if (!protection.requiredChecksPinnedToApp) return { ok: false, reason: 'CHECK_SOURCE_UNPINNED' };
  return { ok: true };
}

export function decideMerge(input) {
  if (!input.flags?.mergeEnabled) return { ok: false, reason: 'MERGE_DISABLED' };
  if (!input.flags?.enabled && !input.simulation) return { ok: false, reason: 'PIPELINE_DISABLED' };
  const preflight = evaluatePreflight(input.protection);
  if (!preflight.ok) return preflight;
  if (input.lock && input.lock.holder && input.lock.holder !== input.holder) return { ok: false, reason: 'MERGE_LOCKED' };
  if (input.liveBaseSha !== input.expectedBaseSha || input.liveHeadSha !== input.expectedHeadSha) {
    return { ok: false, reason: 'APPROVAL_STALE' };
  }
  if (!input.approval?.ok) return { ok: false, reason: 'APPROVAL_DENIED' };
  if (input.gate === 'B' && !input.runbook) return { ok: false, reason: 'MISSING_RUNBOOK' };
  return {
    ok: true,
    request: {
      method: 'PUT',
      path: `/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/merge`,
      body: { sha: input.expectedHeadSha, merge_method: 'merge' },
    },
  };
}

export function reconcileMergeTimeout({ merged, mergeCommitSha }) {
  if (merged === true && mergeCommitSha) return { state: 'MERGED_AWAITING_DEPLOYMENT', mergeCommitSha, retry: false };
  if (merged === false) return { state: 'READY_FOR_OWNER', mergeCommitSha: null, retry: false, reason: 'MERGE_UNCONFIRMED' };
  return { state: 'BLOCKED', reason: 'MERGE_UNKNOWN', retry: false };
}
