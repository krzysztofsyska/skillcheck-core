const VERDICTS = new Set(['PASS', 'PASS_WITH_FIXES', 'FAIL']);
const CHECK_STATUSES = new Set(['PASS', 'FAIL', 'NOT_RUN', 'SKIPPED']);
const SEVERITIES = new Set(['info', 'minor', 'major', 'blocker']);

const REQUIRED = [
  'schema_version',
  'request_id',
  'repository_id',
  'pr_number',
  'head_sha',
  'base_sha',
  'contract_hash',
  'verdict',
  'acceptance_checks',
  'findings',
  'limitations',
];

export function validateReview(envelope, expected) {
  if (!envelope || typeof envelope !== 'object') return reject('missing_envelope');
  if (envelope.workflow_id !== expected.workflowId) return reject('workflow_mismatch');
  if (envelope.workflow_path !== expected.workflowPath) return reject('workflow_mismatch');
  if (envelope.run_id !== expected.runId) return reject('run_mismatch');
  if (envelope.run_attempt !== expected.runAttempt) return reject('attempt_mismatch');
  if (envelope.policy_sha !== expected.policySha) return reject('policy_mismatch');
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reject('payload_not_object');
  for (const field of REQUIRED) {
    if (payload[field] === undefined || payload[field] === null) return reject(`missing_${field}`);
  }
  if (payload.schema_version !== 1) return reject('schema_version');
  if (payload.request_id !== expected.requestId) return reject('request_mismatch');
  if (payload.repository_id !== expected.repositoryId) return reject('repository_mismatch');
  if (payload.pr_number !== expected.prNumber) return reject('pr_mismatch');
  if (payload.head_sha !== expected.headSha) return reject('head_mismatch');
  if (payload.base_sha !== expected.baseSha) return reject('base_mismatch');
  if (payload.contract_hash !== expected.contractHash) return reject('contract_mismatch');
  if (!VERDICTS.has(payload.verdict)) return reject('verdict_enum');
  if (!Array.isArray(payload.acceptance_checks) || !Array.isArray(payload.findings) || !Array.isArray(payload.limitations)) {
    return reject('collections');
  }
  for (const check of payload.acceptance_checks) {
    if (!check || typeof check.id !== 'string' || !CHECK_STATUSES.has(check.status) || typeof check.required !== 'boolean') {
      return reject('acceptance_check_shape');
    }
  }
  for (const finding of payload.findings) {
    if (!finding || typeof finding.id !== 'string' || !SEVERITIES.has(finding.severity) || typeof finding.path !== 'string' || !Number.isInteger(finding.line) || typeof finding.description !== 'string' || typeof finding.required_fix !== 'string') {
      return reject('finding_shape');
    }
  }
  for (const item of payload.limitations) {
    if (typeof item !== 'string') return reject('limitation_shape');
  }
  const requiredIds = new Set(expected.requiredChecks ?? []);
  const seen = new Set(payload.acceptance_checks.map(check => check.id));
  for (const id of requiredIds) {
    if (!seen.has(id)) return reject('required_check_missing');
  }
  const unfinished = payload.acceptance_checks.filter(check => check.required && check.status !== 'PASS');
  if (payload.verdict === 'PASS' && unfinished.length > 0) return reject('required_check_blocks_pass');
  if (payload.verdict === 'PASS' && payload.limitations.some(item => /not run|brak dowodu|evidence gap/i.test(item))) {
    return reject('evidence_gap_blocks_pass');
  }
  return { ok: true, payload, pass: payload.verdict === 'PASS', fixes: payload.verdict === 'PASS_WITH_FIXES', fail: payload.verdict === 'FAIL' };
}

function reject(reason) {
  return { ok: false, reason, pass: false };
}

export function buildReviewEnvelope({ policy, policySha, runId, runAttempt, payload }) {
  return {
    workflow_id: policy.workflow_ids.review,
    workflow_path: policy.workflows.review,
    run_id: Number(runId),
    run_attempt: Number(runAttempt),
    policy_sha: policySha,
    payload,
  };
}

export function proseIsNotReview(text) {
  return { ok: false, reason: 'prose_not_pass', pass: false, text: String(text ?? '') };
}
