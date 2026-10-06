export const SCHEMA_VERSION = 1;

export const MAIN_STATES = [
  'BACKLOG',
  'READY',
  'BUILDING',
  'PR_REVIEW',
  'FIXING',
  'READY_FOR_OWNER',
  'ACCEPTED',
  'READY_FOR_PROD',
  'DEPLOYING',
  'DONE',
  'BLOCKED',
];

export const TECHNICAL_STATES = [
  'DISPATCH_PENDING',
  'DISPATCH_UNKNOWN',
  'REVIEW_STALE',
  'WAITING_CI',
  'APPROVAL_STALE',
  'MERGED_AWAITING_DEPLOYMENT',
];

export function emptyBinding() {
  return {
    lane: 'task',
    branch: null,
    slug: null,
    allowed_files: [],
    required_tests: [],
    level: null,
    scope: null,
    known_run_ids: [],
    dispatch: null,
    approval: null,
    evidence: { ci: null, review: null },
    substantive_reviews: 0,
    finding_streak: 0,
    last_finding_hash: null,
    integration_sha: null,
    promotion: null,
    pending_notification: null,
    reports: [],
    suppressed: [],
  };
}

export function newRecord({ repositoryId, taskId, issueNumber, policySha, now }) {
  return {
    schema_version: SCHEMA_VERSION,
    repository_id: repositoryId,
    task_id: taskId,
    issue_number: issueNumber ?? null,
    task_revision: 1,
    contract_hash: null,
    state_revision: 0,
    base_sha: null,
    head_sha: null,
    policy_sha: policySha ?? null,
    state: 'BACKLOG',
    cursor_agent_id: null,
    cursor_run_id: null,
    pr_number: null,
    review_request_id: null,
    review_run_id: null,
    review_run_attempt: null,
    ci_run_id: null,
    ci_run_attempt: null,
    repair_round: 0,
    approval_request_id: null,
    notification_id: null,
    last_transition_at: now ?? null,
    blocked_reason: null,
    technical_state: null,
    binding: emptyBinding(),
  };
}

export function touch(record, now, patch = {}) {
  const next = structuredClone(record);
  next.state_revision += 1;
  next.last_transition_at = now;
  return Object.assign(next, patch);
}

export function block(record, reason, now, technical = null) {
  return touch(record, now, {
    state: 'BLOCKED',
    blocked_reason: reason,
    technical_state: technical,
  });
}
