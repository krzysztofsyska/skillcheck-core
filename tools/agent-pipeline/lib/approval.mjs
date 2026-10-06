import { canonicalJson, sha256 } from './canonical.mjs';

export function approvalDigest(payload) {
  return sha256(canonicalJson(payload));
}

export function gateAPayload(input) {
  return {
    gate: 'A',
    repository_id: input.repositoryId,
    task_id: input.taskId,
    pr_number: input.prNumber,
    target: 'integration',
    head_sha: input.headSha,
    base_sha: input.baseSha,
    contract_hash: input.contractHash,
    policy_sha: input.policySha,
    review_run_id: input.reviewRunId,
    review_run_attempt: input.reviewRunAttempt,
    review_digest: input.reviewDigest,
    ci_run_id: input.ciRunId,
    ci_run_attempt: input.ciRunAttempt,
    ci_digest: input.ciDigest,
    files: input.files ?? [],
    operation: 'merge',
  };
}

export function gateBPayload(input) {
  return {
    gate: 'B',
    repository_id: input.repositoryId,
    promotion_pr: input.promotionPr,
    target: 'main',
    integration_sha: input.integrationSha,
    main_sha: input.mainSha,
    policy_sha: input.policySha,
    tasks: input.tasks ?? [],
    manifest_hash: input.manifestHash,
    operations: input.operations ?? [],
    environments: input.environments ?? [],
    ci_review_evidence: input.evidence ?? [],
    rollback: input.rollback ?? null,
    smoke_tests: input.smokeTests ?? [],
    secret_names: input.secretNames ?? [],
  };
}

export function evaluateApproval({ request, run, payload, expectedUser, expectedEnvironment }) {
  if (!request?.request_id || !request.digest || !request.gate) return deny('missing_request');
  if (!run || run.run_attempt !== 1) return deny('attempt_not_first');
  if (run.workflow_id !== request.workflow_id || run.workflow_path !== request.workflow_path) return deny('workflow_mismatch');
  if (run.ref !== request.ref) return deny('ref_mismatch');
  if (run.run_id !== request.run_id) return deny('run_mismatch');
  if (run.environment?.name !== expectedEnvironment.name) return deny('environment_mismatch');
  if (expectedEnvironment.id != null && run.environment?.id !== expectedEnvironment.id) return deny('environment_mismatch');
  const entries = Array.isArray(payload) ? payload : null;
  if (!entries || entries.length === 0) return deny('missing_approval');
  if (entries.some(entry => entry?.state === 'rejected')) return deny('rejected');
  const approved = entries.filter(entry => entry?.state === 'approved');
  if (approved.length !== 1) return deny(approved.length === 0 ? 'not_approved' : 'ambiguous_approval');
  const entry = approved[0];
  const environments = entry.environments ?? [];
  const environment = environments.find(item => item?.name === expectedEnvironment.name && (expectedEnvironment.id == null || item.id === expectedEnvironment.id));
  if (!environment) return deny('environment_mismatch');
  if (entry.user?.id !== expectedUser.id || entry.user?.type !== 'User') return deny('reviewer_mismatch');
  if (entry.comment) {
    // Comment text is descriptive only and never an authorization source.
  }
  if (request.digest !== approvalDigest(request.canonical)) return deny('digest_mismatch');
  if (request.gate === 'B' && request.canonical?.gate !== 'B') return deny('gate_mismatch');
  if (request.gate === 'A' && request.canonical?.gate !== 'A') return deny('gate_mismatch');
  return { ok: true, userId: entry.user.id, environment: environment.name };
}

function deny(reason) {
  return { ok: false, reason };
}

export function approvalStillCurrent(request, live) {
  if (!request?.canonical) return false;
  const canonical = request.canonical;
  if (canonical.gate === 'A') {
    return canonical.head_sha === live.headSha
      && canonical.base_sha === live.baseSha
      && canonical.contract_hash === live.contractHash
      && canonical.policy_sha === live.policySha
      && canonical.review_run_id === live.reviewRunId
      && canonical.ci_run_id === live.ciRunId;
  }
  return canonical.integration_sha === live.integrationSha
    && canonical.main_sha === live.mainSha
    && canonical.policy_sha === live.policySha
    && canonical.manifest_hash === live.manifestHash;
}
