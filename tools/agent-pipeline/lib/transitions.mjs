import { operationKey, sha256 } from './canonical.mjs';
import { approvalDigest, approvalStillCurrent, evaluateApproval, gateAPayload, gateBPayload } from './approval.mjs';
import { buildCreatePayload, buildFollowupPayload, createAgentId, reconcileListedRuns } from './cursor.mjs';
import { validateCi } from './ci.mjs';
import { branchName, parseContract } from './contract.mjs';
import { decideMerge, reconcileMergeTimeout } from './merge.mjs';
import { buildNotification } from './notifications.mjs';
import { block, newRecord, touch } from './record.mjs';
import { validateReview } from './review.mjs';
import { filesOutside } from './scope.mjs';

const ACTIVE_RUN = new Set(['CREATING', 'RUNNING']);
const TERMINAL_RUN = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

export function plan(record, obs) {
  if (obs.kind === 'promotion' || record?.binding?.lane === 'promotion') return planPromotion(record, obs);
  if (!record || record.state === 'BACKLOG') return openTask(obs);
  if (record.state === 'BLOCKED') return resumeOrHold(record, obs);
  if (contractDrift(record, obs)) return done(block(record, 'CONTRACT_EDITED', obs.now));
  const drifted = shaDrift(record, obs);
  if (drifted) return drifted;
  if (record.technical_state === 'DISPATCH_PENDING') return dispatchStep(record, obs);
  if (record.binding?.merge?.phase === 'awaiting_confirmation') return confirmMerge(record, obs);
  if (record.state === 'BUILDING' || (record.state === 'FIXING' && record.binding.dispatch?.phase === 'settled')) return buildingStep(record, obs);
  if (record.state === 'PR_REVIEW') return reviewStep(record, obs);
  if (record.state === 'READY_FOR_OWNER' || record.state === 'ACCEPTED') return approvalStep(record, obs);
  if (record.state === 'READY_FOR_PROD' || record.state === 'DEPLOYING' || record.state === 'MERGED_AWAITING_DEPLOYMENT' || record.state === 'DONE') {
    return productionStep(record, obs);
  }
  return done(record);
}

function planPromotion(record, obs) {
  if (!record || record.state === 'BACKLOG') return openPromotion(obs);
  if (record.state === 'BLOCKED') return done(record);
  const live = promotionLive(record, obs);
  if (record.binding.approval && !approvalStillCurrent(record.binding.approval, live)) {
    const next = touch(record, obs.now, { technical_state: 'APPROVAL_STALE', approval_request_id: null });
    next.binding.approval = null;
    next.blocked_reason = null;
    return effect(next, [{ type: 'report', kind: 'APPROVAL_STALE', external: false }]);
  }
  if (!record.binding.approval) return armGateB(record, obs);
  if (record.binding.approval.phase === 'intent') {
    const next = touch(record, obs.now);
    next.binding.approval.phase = 'armed';
    return {
      record: next,
      preEffectRecord: next,
      effects: [
        { type: 'github.dispatch', workflow: 'promote', external: true, requestId: next.approval_request_id, digest: next.binding.approval.digest, taskId: next.task_id, integrationSha: next.head_sha, mainSha: next.base_sha, manifestHash: next.binding.promotion?.manifest_hash ?? null },
        { type: 'notify', external: true, issueNumber: next.issue_number, notification: notificationFor(next, obs, 'READY_FOR_PROD') },
      ],
      journal: journalFor(next, 'request-approval-b'),
    };
  }
  return gateDecision(record, obs, 'B');
}

function openTask(obs) {
  const author = authorizeActor(obs);
  if (!author.ok) return { record: null, effects: [{ type: 'report', kind: 'IGNORED', reason: author.reason, external: false }], journal: null };
  const contract = parseContract(obs.issue.body);
  if (!contract.ready) return { record: null, effects: [], journal: null };
  const baseSha = obs.github.integrationSha;
  const key = operationKey({
    repositoryId: obs.github.repositoryId,
    taskId: contract.task_id,
    taskRevision: 1,
    headSha: null,
    baseSha,
    action: 'cursor.create',
    round: 0,
  });
  const record = newRecord({
    repositoryId: obs.github.repositoryId,
    taskId: contract.task_id,
    issueNumber: obs.issue.number,
    policySha: obs.policySha,
    now: obs.now,
  });
  record.state = 'READY';
  record.technical_state = 'DISPATCH_PENDING';
  record.contract_hash = contract.hash;
  record.base_sha = baseSha;
  record.cursor_agent_id = createAgentId(key);
  record.binding.branch = branchName(contract);
  record.binding.slug = contract.slug;
  record.binding.allowed_files = contract.allowed_files;
  record.binding.required_tests = contract.required_tests;
  record.binding.level = contract.level;
  record.binding.scope = contract.scope;
  record.binding.integration_sha = baseSha;
  record.binding.dispatch = { action: 'create', phase: 'intent', agentId: record.cursor_agent_id, operationKey: key };
  return done(record);
}

function openPromotion(obs) {
  const promo = obs.promotion;
  if (!promo?.manifest || !promo.runbook) {
    const record = newRecord({
      repositoryId: obs.github.repositoryId,
      taskId: promo?.taskId ?? 'promotion',
      issueNumber: promo?.prNumber ?? null,
      policySha: obs.policySha,
      now: obs.now,
    });
    record.binding.lane = 'promotion';
    return done(block(record, 'MISSING_RUNBOOK', obs.now));
  }
  const refs = obs.github.pull;
  if (!refs || refs.headRef !== 'integration' || refs.baseRef !== 'main' || refs.headRepositoryId !== obs.policy.repository_id || refs.baseRepositoryId !== obs.policy.repository_id) {
    const record = newRecord({
      repositoryId: obs.github.repositoryId,
      taskId: promo.taskId,
      issueNumber: refs?.number ?? null,
      policySha: obs.policySha,
      now: obs.now,
    });
    record.binding.lane = 'promotion';
    return done(block(record, refs ? 'PROMOTION_REF_REJECTED' : 'FORK_REJECTED', obs.now));
  }
  const record = newRecord({
    repositoryId: obs.github.repositoryId,
    taskId: promo.taskId,
    issueNumber: refs.number,
    policySha: obs.policySha,
    now: obs.now,
  });
  record.binding.lane = 'promotion';
  record.state = 'READY_FOR_PROD';
  record.pr_number = refs.number;
  record.head_sha = refs.headSha;
  record.base_sha = refs.baseSha;
  record.binding.promotion = {
    manifest_hash: sha256(promo.manifest),
    runbook_hash: sha256(promo.runbook),
    operations: promo.operations ?? [],
    tasks: promo.tasks ?? [],
    secret_names: promo.secretNames ?? [],
  };
  return armGateB(record, obs);
}

function armGateB(record, obs) {
  const canonical = gateBPayload({
    repositoryId: record.repository_id,
    promotionPr: record.pr_number,
    integrationSha: record.head_sha,
    mainSha: record.base_sha,
    policySha: record.policy_sha,
    tasks: record.binding.promotion?.tasks ?? [],
    manifestHash: record.binding.promotion?.manifest_hash,
    operations: record.binding.promotion?.operations ?? [],
    environments: ['production-approval'],
    evidence: [],
    rollback: obs.promotion?.rollback ?? null,
    smokeTests: obs.promotion?.smokeTests ?? [],
    secretNames: record.binding.promotion?.secret_names ?? [],
  });
  const next = touch(record, obs.now, { state: 'READY_FOR_PROD', technical_state: null, blocked_reason: null });
  next.approval_request_id = sha256({ gate: 'B', canonical });
  next.binding.approval = {
    gate: 'B',
    phase: 'intent',
    request_id: next.approval_request_id,
    digest: approvalDigest(canonical),
    canonical,
    workflow_id: obs.policy.workflow_ids.promote,
    workflow_path: obs.policy.workflows.promote,
    ref: 'refs/heads/main',
    run_id: null,
  };
  return done(next);
}

function resumeOrHold(record, obs) {
  if (!obs.resume?.approved) return done(record);
  const next = touch(record, obs.now, {
    state: 'READY',
    blocked_reason: null,
    technical_state: 'DISPATCH_PENDING',
    task_revision: record.task_revision + 1,
    repair_round: 0,
  });
  next.binding.substantive_reviews = 0;
  next.binding.finding_streak = 0;
  next.binding.dispatch = {
    action: 'create',
    phase: 'intent',
    agentId: record.cursor_agent_id,
    operationKey: operationKey({
      repositoryId: record.repository_id,
      taskId: record.task_id,
      taskRevision: next.task_revision,
      headSha: null,
      baseSha: record.base_sha,
      action: 'cursor.create',
      round: 0,
    }),
  };
  return done(next);
}

function dispatchStep(record, obs) {
  const dispatch = record.binding.dispatch;
  if (!dispatch) return done(block(record, 'DISPATCH_UNKNOWN', obs.now, 'DISPATCH_UNKNOWN'));
  if (dispatch.phase === 'intent') {
    const next = touch(record, obs.now);
    next.binding.dispatch = { ...dispatch, phase: 'armed' };
    return done(next);
  }
  if (dispatch.phase === 'awaiting_confirmation') {
    const effect = dispatch.action === 'create'
      ? { type: 'cursor.get', agentId: record.cursor_agent_id, external: true }
      : { type: 'cursor.listRuns', agentId: record.cursor_agent_id, knownRunIds: [...record.binding.known_run_ids], marker: dispatch.marker, external: true };
    return { record, preEffectRecord: record, effects: [effect], journal: journalFor(record, 'confirm-dispatch') };
  }
  if (dispatch.action === 'followup' && cursorBusy(obs)) {
    const next = touch(record, obs.now);
    next.binding.dispatch = { ...dispatch, busy: true };
    return done(next);
  }
  if (!obs.simulation && !obs.flags?.enabled) {
    if (record.binding.suppressed.some(item => item.action === dispatch.action && item.reason === 'PIPELINE_DISABLED')) return done(record);
    const next = touch(record, obs.now);
    next.binding.suppressed.push({ at: obs.now, action: dispatch.action, reason: 'PIPELINE_DISABLED' });
    return done(next);
  }
  if (!obs.simulation && !obs.secrets?.cursor) return done(block(record, 'BLOCKED_CONFIGURATION', obs.now));
  let effect;
  try {
    effect = dispatch.action === 'create' ? cursorCreateEffect(record, obs) : cursorFollowupEffect(record, obs);
  } catch (error) {
    return done(block(record, error.code || 'REF_FORBIDDEN', obs.now));
  }
  const pre = touch(record, obs.now);
  pre.binding.dispatch = { ...dispatch, phase: 'awaiting_confirmation', started_at: obs.now };
  return { record: pre, preEffectRecord: pre, effects: [effect], journal: journalFor(pre, 'dispatch') };
}

function buildingStep(record, obs) {
  const run = currentRun(obs, record);
  if (!run) return done(record);
  if (ACTIVE_RUN.has(run.status)) {
    const started = Date.parse(run.createdAt || record.binding.dispatch?.started_at || obs.now);
    if (Date.parse(obs.now) - started >= obs.policy.timeouts.build_ms) return done(block(record, 'BUILD_TIMEOUT', obs.now));
    return done(record);
  }
  if (run.status === 'ERROR' || run.status === 'CANCELLED' || run.status === 'EXPIRED') {
    return done(block(record, run.status === 'EXPIRED' ? 'SESSION_EXPIRED' : 'CURSOR_RUN_FAILED', obs.now));
  }
  if (!TERMINAL_RUN.has(run.status) || run.status !== 'FINISHED') return done(record);
  if (record.cursor_run_id && obs.cursor?.agent?.latestRunId && obs.cursor.agent.latestRunId !== record.cursor_run_id) {
    return done(record);
  }
  const branch = obs.github.branch;
  if (!branch) return done(record);
  if (obs.github.fork || branch.repositoryId !== record.repository_id || branch.name !== record.binding.branch) return done(block(record, 'REF_FORBIDDEN', obs.now));
  const outside = filesOutside(branch.files ?? [], record.binding.allowed_files);
  if (outside.length > 0) return done(block(record, 'SCOPE_VIOLATION', obs.now));
  const adopted = findTaskPull(obs, record);
  if (!record.pr_number && adopted) {
    const next = touch(record, obs.now, { state: 'PR_REVIEW', technical_state: 'WAITING_CI', pr_number: adopted.number, head_sha: branch.sha, base_sha: obs.github.integrationSha });
    return done(next);
  }
  if (!record.pr_number && record.binding.pr_requested) return done(block(record, 'DISPATCH_UNKNOWN', obs.now, 'DISPATCH_UNKNOWN'));
  if (!record.pr_number) {
    const pre = touch(record, obs.now, { head_sha: branch.sha, base_sha: obs.github.integrationSha });
    pre.binding.pr_requested = true;
    return {
      record: pre,
      preEffectRecord: pre,
      effects: [{
        type: 'github.createPr',
        external: true,
        marker: `skillcheck-task:${record.task_id}`,
        head: record.binding.branch,
        base: 'integration',
        repositoryId: record.repository_id,
        taskId: record.task_id,
      }],
      journal: journalFor(pre, 'create-pr'),
    };
  }
  if (record.state === 'FIXING') {
    const next = touch(record, obs.now, { state: 'PR_REVIEW', technical_state: 'REVIEW_STALE', head_sha: branch.sha });
    next.review_request_id = null;
    next.review_run_id = null;
    next.review_run_attempt = null;
    next.ci_run_id = null;
    next.ci_run_attempt = null;
    next.binding.evidence = { ci: null, review: null };
    return done(next);
  }
  const next = touch(record, obs.now, { state: 'PR_REVIEW', technical_state: 'WAITING_CI', head_sha: branch.sha });
  return done(next);
}

function reviewStep(record, obs) {
  if (!record.review_request_id) {
    if (record.binding.substantive_reviews >= obs.policy.limits.substantive_reviews) return done(block(record, 'REVIEW_LIMIT', obs.now));
    const requestId = sha256(operationKey({
      repositoryId: record.repository_id,
      taskId: record.task_id,
      taskRevision: record.task_revision,
      headSha: record.head_sha,
      baseSha: record.base_sha,
      action: 'review',
      round: record.binding.substantive_reviews,
    }));
    const pre = touch(record, obs.now, { review_request_id: requestId, technical_state: 'WAITING_CI' });
    return {
      record: pre,
      preEffectRecord: pre,
      effects: [
        { type: 'github.dispatch', workflow: 'verify', external: true, requestId, headSha: record.head_sha, baseSha: record.base_sha, policySha: record.policy_sha, taskId: record.task_id },
        { type: 'github.dispatch', workflow: 'review', external: true, requestId, headSha: record.head_sha, baseSha: record.base_sha, policySha: record.policy_sha, repositoryId: record.repository_id, prNumber: record.pr_number },
      ],
      journal: journalFor(pre, 'dispatch-evidence'),
    };
  }
  if (!obs.github.ci || !obs.github.review) {
    const started = Date.parse(record.last_transition_at);
    if (Date.parse(obs.now) - started >= obs.policy.timeouts.ci_review_ms) return done(block(record, 'CI_REVIEW_TIMEOUT', obs.now));
    return done(record);
  }
  const ci = validateCi(obs.github.ci, {
    workflowId: obs.policy.workflow_ids.verify,
    workflowPath: obs.policy.workflows.verify,
    policySha: record.policy_sha,
    headSha: record.head_sha,
    baseSha: record.base_sha,
    requiredCommands: obs.policy.required_ci_commands,
    runAttempt: obs.github.ci.run_attempt,
  });
  const review = validateReview(obs.github.review, {
    workflowId: obs.policy.workflow_ids.review,
    workflowPath: obs.policy.workflows.review,
    runId: obs.github.review.run_id,
    runAttempt: obs.github.review.run_attempt,
    policySha: record.policy_sha,
    requestId: record.review_request_id,
    repositoryId: record.repository_id,
    prNumber: record.pr_number,
    headSha: record.head_sha,
    baseSha: record.base_sha,
    contractHash: record.contract_hash,
    requiredChecks: record.binding.required_tests,
  });
  const signature = sha256({ ci: obs.github.ci, review: obs.github.review, request: record.review_request_id });
  if (record.binding.last_evidence_signature === signature) return done(record);
  const untrusted = !review.ok || (!ci.ok && !String(ci.reason).startsWith('conclusion_') && ci.reason !== 'job_not_success' && ci.reason !== 'missing_job');
  if (untrusted || !(ci.pass && review.pass)) {
    if (!review.ok || (!ci.ok && !ci.pass && !String(ci.reason).startsWith('conclusion_') && ci.reason !== 'job_not_success')) {
      const rejected = touch(record, obs.now);
      rejected.binding.evidence = { ci, review };
      rejected.binding.last_evidence_signature = signature;
      rejected.binding.reports.push({ kind: 'EVIDENCE_REJECTED', ci: ci.reason ?? null, review: review.reason ?? null, at: obs.now });
      rejected.state = 'PR_REVIEW';
      return done(rejected);
    }
  }
  const next = touch(record, obs.now);
  next.binding.evidence = { ci, review };
  next.binding.last_evidence_signature = signature;
  if (review.ok) {
    next.binding.substantive_reviews += 1;
    next.review_run_id = obs.github.review.run_id;
    next.review_run_attempt = obs.github.review.run_attempt;
  }
  if (ci.ok) {
    next.ci_run_id = obs.github.ci.run_id;
    next.ci_run_attempt = obs.github.ci.run_attempt;
  }
  if (ci.pass && review.pass) {
    next.state = 'READY_FOR_OWNER';
    next.technical_state = null;
    return armGateA(next, obs);
  }
  const repairable = review.ok && (review.fixes || review.fail || !ci.pass);
  if (!repairable) return done(next);
  return beginRepair(next, obs, review.payload.findings ?? []);
}

function beginRepair(record, obs, findings) {
  const findingHash = sha256((findings ?? []).map(finding => finding.id).sort());
  if (findingHash === record.binding.last_finding_hash) record.binding.finding_streak += 1;
  else record.binding.finding_streak = findings?.length ? 1 : 0;
  record.binding.last_finding_hash = findingHash;
  if (record.binding.finding_streak >= 2) return done(block(record, 'IDENTICAL_FINDINGS', obs.now));
  if (record.repair_round >= obs.policy.limits.repair_rounds) return done(block(record, 'REPAIR_LIMIT', obs.now));
  if (record.binding.substantive_reviews >= obs.policy.limits.substantive_reviews) return done(block(record, 'REVIEW_LIMIT', obs.now));
  const marker = operationKey({
    repositoryId: record.repository_id,
    taskId: record.task_id,
    taskRevision: record.task_revision,
    headSha: record.head_sha,
    baseSha: record.base_sha,
    action: 'cursor.followup',
    round: record.repair_round + 1,
  });
  record.state = 'FIXING';
  record.technical_state = 'DISPATCH_PENDING';
  record.binding.dispatch = {
    action: 'followup',
    phase: 'intent',
    marker,
    findings,
    operationKey: marker,
  };
  return done(record);
}

function armGateA(record, obs) {
  const canonical = gateAPayload({
    repositoryId: record.repository_id,
    taskId: record.task_id,
    prNumber: record.pr_number,
    headSha: record.head_sha,
    baseSha: record.base_sha,
    contractHash: record.contract_hash,
    policySha: record.policy_sha,
    reviewRunId: record.review_run_id,
    reviewRunAttempt: record.review_run_attempt,
    reviewDigest: sha256(record.binding.evidence.review.payload),
    ciRunId: record.ci_run_id,
    ciRunAttempt: record.ci_run_attempt,
    ciDigest: sha256(obs.github.ci),
    files: obs.github.branch?.files ?? [],
  });
  const next = touch(record, obs.now, { state: 'READY_FOR_OWNER' });
  next.approval_request_id = sha256({ gate: 'A', canonical });
  next.binding.approval = {
    gate: 'A',
    phase: 'intent',
    request_id: next.approval_request_id,
    digest: approvalDigest(canonical),
    canonical,
    workflow_id: obs.policy.workflow_ids.accept,
    workflow_path: obs.policy.workflows.accept,
    ref: 'refs/heads/main',
    run_id: null,
  };
  const notification = notificationFor(next, obs, 'READY_FOR_OWNER');
  next.notification_id = notification.notification_id;
  next.binding.pending_notification = notification;
  return done(next);
}

function approvalStep(record, obs) {
  if (record.state === 'ACCEPTED') return done(record);
  if (!record.binding.approval) return armGateA(record, obs);
  if (record.binding.approval.phase === 'intent') {
    const next = touch(record, obs.now);
    next.binding.approval.phase = 'armed';
    const notification = next.binding.pending_notification;
    return {
      record: next,
      preEffectRecord: next,
      effects: [
        { type: 'github.dispatch', workflow: 'accept', external: true, requestId: next.approval_request_id, digest: next.binding.approval.digest, taskId: next.task_id, headSha: next.head_sha, baseSha: next.base_sha },
        { type: 'notify', external: true, issueNumber: next.issue_number, notification },
      ],
      journal: journalFor(next, 'request-approval-a'),
    };
  }
  return gateDecision(record, obs, 'A');
}

function gateDecision(record, obs, gate) {
  const request = record.binding.approval;
  if (request.run_id == null && obs.approval?.request_id && obs.approval.request_id === request.request_id && obs.approval.run_id) {
    const next = touch(record, obs.now);
    next.binding.approval = { ...request, run_id: obs.approval.run_id, armed_at: request.armed_at ?? obs.now };
    return done(next);
  }
  const started = Date.parse(request.armed_at || record.last_transition_at);
  if (!obs.approval && Date.parse(obs.now) - started >= obs.policy.timeouts.approval_ms) {
    return done(block(record, 'APPROVAL_TIMEOUT', obs.now));
  }
  if (!obs.approval) return done(record);
  if (obs.approval.run_attempt && obs.approval.run_attempt !== 1) {
    const next = touch(record, obs.now, { technical_state: 'APPROVAL_STALE', approval_request_id: null });
    next.binding.approval = null;
    next.blocked_reason = 'APPROVAL_RERUN';
    next.state = gate === 'B' ? 'READY_FOR_PROD' : 'READY_FOR_OWNER';
    return done(next);
  }
  const decision = evaluateApproval({
    request: { ...request, run_id: request.run_id ?? obs.approval.run_id },
    run: obs.approval,
    payload: obs.approval.payload,
    expectedUser: { id: obs.policy.owner.id },
    expectedEnvironment: gate === 'A' ? obs.policy.environments.owner_acceptance : obs.policy.environments.production_approval,
  });
  if (!decision.ok) {
    const next = touch(record, obs.now);
    next.binding.reports.push({ kind: 'APPROVAL_DENIED', reason: decision.reason, at: obs.now });
    if (decision.reason === 'not_approved' || decision.reason === 'missing_approval') return done(next);
    if (decision.reason === 'rejected') return done(block(next, 'APPROVAL_DENIED', obs.now));
    return done(block(next, 'APPROVAL_DENIED', obs.now));
  }
  if (gate === 'A' && request.gate !== 'A') return done(block(record, 'GATE_MISMATCH', obs.now));
  if (gate === 'B' && request.gate !== 'A' && request.canonical?.gate !== 'B') return done(block(record, 'GATE_MISMATCH', obs.now));
  const merge = decideMerge({
    flags: obs.flags,
    simulation: obs.simulation,
    protection: obs.github.protection,
    lock: obs.mergeLock ?? null,
    holder: record.task_id,
    liveBaseSha: gate === 'B' ? obs.github.pull?.baseSha : obs.github.pull?.baseSha,
    expectedBaseSha: request.canonical.gate === 'B' ? request.canonical.main_sha : request.canonical.base_sha,
    liveHeadSha: obs.github.pull?.headSha,
    expectedHeadSha: request.canonical.gate === 'B' ? request.canonical.integration_sha : request.canonical.head_sha,
    approval: decision,
    gate,
    runbook: gate === 'B' ? obs.promotion?.runbook ?? record.binding.promotion : true,
    owner: obs.policy.repository.split('/')[0],
    repo: obs.policy.repository.split('/')[1],
    prNumber: record.pr_number,
  });
  if (!merge.ok) {
    const next = touch(record, obs.now);
    next.binding.reports.push({ kind: merge.reason, at: obs.now, gate });
    if (merge.reason === 'MERGE_DISABLED' || merge.reason === 'PIPELINE_DISABLED') return done(next);
    if (merge.reason === 'APPROVAL_STALE') {
      next.technical_state = 'APPROVAL_STALE';
      next.approval_request_id = null;
      next.binding.approval = null;
      return done(next);
    }
    return done(block(next, merge.reason, obs.now));
  }
  const pre = touch(record, obs.now);
  pre.binding.merge = { phase: 'awaiting_confirmation', expectedHeadSha: merge.request.body.sha, gate };
  return {
    record: pre,
    preEffectRecord: pre,
    effects: [{ type: 'github.merge', external: true, request: merge.request, gate }],
    journal: journalFor(pre, 'merge'),
  };
}

function confirmMerge(record, obs) {
  const pull = obs.github.pull;
  const reconciled = reconcileMergeTimeout({ merged: pull?.merged, mergeCommitSha: pull?.mergeCommitSha });
  if (reconciled.reason === 'MERGE_UNKNOWN') return done(block(record, 'MERGE_UNKNOWN', obs.now));
  const next = touch(record, obs.now, { technical_state: reconciled.state === 'MERGED_AWAITING_DEPLOYMENT' ? 'MERGED_AWAITING_DEPLOYMENT' : record.technical_state });
  next.binding.merge = { ...record.binding.merge, phase: 'settled', mergeCommitSha: reconciled.mergeCommitSha, retry: false };
  if (reconciled.state === 'MERGED_AWAITING_DEPLOYMENT') {
    next.state = record.binding.approval?.gate === 'B' ? 'MERGED_AWAITING_DEPLOYMENT' : 'ACCEPTED';
    if (record.binding.lane === 'promotion' || record.binding.approval?.gate === 'B') next.state = 'MERGED_AWAITING_DEPLOYMENT';
  }
  return done(next);
}

function productionStep(record, obs) {
  if (record.state === 'MERGED_AWAITING_DEPLOYMENT') {
    if (!obs.deployment?.runbook) return done(block(record, 'MISSING_RUNBOOK', obs.now));
    if (obs.deployment.confirmed === true && obs.deployment.smokePassed === true && obs.deployment.manifestHash === record.binding.promotion?.manifest_hash) {
      const next = touch(record, obs.now, { state: 'DONE', technical_state: null });
      const notification = notificationFor(next, obs, 'DONE');
      next.notification_id = notification.notification_id;
      return effect(next, [{ type: 'notify', external: true, issueNumber: next.issue_number, notification }]);
    }
    return done(record);
  }
  return done(record);
}

export function fold(record, effect, result, obs) {
  const now = obs.now;
  if (effect.type === 'cursor.create' || effect.type === 'cursor.get') return foldCursorCreate(record, effect, result, now);
  if (effect.type === 'cursor.followup') return foldFollowup(record, result, now);
  if (effect.type === 'cursor.listRuns') return foldListedRuns(record, result, now);
  if (effect.type === 'github.createPr') {
    if (result?.lost || result?.timeout) return record;
    if (!result?.number) return block(record, 'DISPATCH_UNKNOWN', now, 'DISPATCH_UNKNOWN');
    const next = touch(record, now, { pr_number: result.number, state: 'PR_REVIEW', technical_state: 'WAITING_CI' });
    return next;
  }
  if (effect.type === 'github.dispatch') {
    const next = touch(record, now);
    if (effect.workflow === 'verify' && result?.run_id) next.ci_run_id = result.run_id;
    if (effect.workflow === 'review' && result?.run_id) next.review_run_id = result.run_id;
    if ((effect.workflow === 'accept' || effect.workflow === 'promote') && result?.run_id) {
      next.binding.approval.run_id = result.run_id;
      next.binding.approval.armed_at = now;
    }
    return next;
  }
  if (effect.type === 'notify') {
    const next = touch(record, now);
    if (!result?.ok) next.binding.reports.push({ kind: 'NOTIFICATION_FAILED', at: now, notification_id: effect.notification.notification_id });
    else next.binding.pending_notification = null;
    return next;
  }
  if (effect.type === 'github.merge') {
    if (result?.lost || result?.timeout) return record;
    if (result?.merged && result.mergeCommitSha) {
      const next = touch(record, now);
      next.binding.merge = { ...record.binding.merge, phase: 'settled', mergeCommitSha: result.mergeCommitSha, retry: false };
      next.state = effect.gate === 'B' ? 'MERGED_AWAITING_DEPLOYMENT' : 'ACCEPTED';
      next.technical_state = effect.gate === 'B' ? 'MERGED_AWAITING_DEPLOYMENT' : null;
      return next;
    }
    return block(record, 'MERGE_UNKNOWN', now);
  }
  return record;
}

function foldCursorCreate(record, effect, result, now) {
  if (result?.lost || result?.timeout) {
    const next = touch(record, now);
    next.binding.dispatch = { ...record.binding.dispatch, phase: 'awaiting_confirmation' };
    next.technical_state = 'DISPATCH_PENDING';
    return next;
  }
  const status = result?.error?.status ?? result?.status ?? null;
  if (status === 401 || status === 403) return block(record, 'BLOCKED_CONFIGURATION', now);
  if (status === 409 || result?.conflict) {
    const agent = result.agent ?? result.error?.payload?.agent ?? null;
    if (agent?.id === record.cursor_agent_id) return settleCreate(record, { agent, run: result.run ?? { id: agent.latestRunId } }, now);
    return block(record, 'DISPATCH_UNKNOWN', now, 'DISPATCH_UNKNOWN');
  }
  if (effect.type === 'cursor.get' && (result?.notFound || status === 404)) {
    const next = touch(record, now);
    next.binding.dispatch = { ...record.binding.dispatch, phase: 'armed' };
    return next;
  }
  if (result?.error) return block(record, 'DISPATCH_UNKNOWN', now, 'DISPATCH_UNKNOWN');
  return settleCreate(record, result, now);
}

function settleCreate(record, result, now) {
  const next = touch(record, now, {
    state: 'BUILDING',
    technical_state: null,
    cursor_agent_id: record.cursor_agent_id,
    cursor_run_id: result.run?.id ?? null,
  });
  next.binding.dispatch = { phase: 'settled', action: 'create', started_at: now };
  if (result.run?.id) next.binding.known_run_ids = [...new Set([...record.binding.known_run_ids, result.run.id])];
  return next;
}

function foldFollowup(record, result, now) {
  const status = result?.error?.status ?? result?.status ?? null;
  if (status === 409 || result?.error?.code === 'agent_busy') {
    const next = touch(record, now);
    next.binding.dispatch = { ...record.binding.dispatch, phase: 'armed', busy: true };
    next.state = 'FIXING';
    next.technical_state = 'DISPATCH_PENDING';
    return next;
  }
  if (status === 401 || status === 403) return block(record, 'BLOCKED_CONFIGURATION', now);
  if (result?.lost || result?.timeout) {
    const next = touch(record, now);
    next.binding.dispatch = { ...record.binding.dispatch, phase: 'awaiting_confirmation' };
    return next;
  }
  if (!result?.run?.id) return block(record, 'DISPATCH_UNKNOWN', now, 'DISPATCH_UNKNOWN');
  const next = touch(record, now, { state: 'FIXING', technical_state: null, cursor_run_id: result.run.id, repair_round: record.repair_round + 1 });
  next.binding.known_run_ids = [...new Set([...record.binding.known_run_ids, result.run.id])];
  next.binding.dispatch = { phase: 'settled', action: 'followup' };
  return next;
}

function foldListedRuns(record, result, now) {
  const reconciled = reconcileListedRuns({ knownRunIds: record.binding.known_run_ids, runs: result?.runs ?? result?.items ?? [] });
  if (!reconciled.ok) return block(record, 'DISPATCH_UNKNOWN', now, 'DISPATCH_UNKNOWN');
  return foldFollowup(record, { run: reconciled.run }, now);
}

function cursorCreateEffect(record, obs) {
  const payload = buildCreatePayload({
    repoUrl: obs.policy.repository_url,
    startingRef: record.binding.branch,
    prompt: obs.prompts?.build ?? `Implement ${record.task_id}`,
    agentId: record.cursor_agent_id,
    repositoryId: obs.github.repositoryId,
    expectedRepositoryId: obs.policy.repository_id,
    fork: obs.github.fork,
    allowedRepoUrls: obs.policy.allowed_repo_urls,
  });
  if (Object.prototype.hasOwnProperty.call(payload, 'envVars')) {
    const error = new Error('ENV_VARS_FORBIDDEN');
    error.code = 'ENV_VARS_FORBIDDEN';
    throw error;
  }
  return { type: 'cursor.create', external: true, agentId: record.cursor_agent_id, payload };
}

function cursorFollowupEffect(record, obs) {
  const payload = buildFollowupPayload({
    prompt: obs.prompts?.fix ?? `Repair ${record.task_id}`,
    marker: record.binding.dispatch.marker,
    reviewRequestId: record.review_request_id,
    headSha: record.head_sha,
    baseSha: record.base_sha,
    allowedFiles: record.binding.allowed_files,
    findings: record.binding.dispatch.findings ?? [],
    ci: record.binding.evidence?.ci ?? null,
  });
  return { type: 'cursor.followup', external: true, agentId: record.cursor_agent_id, payload, knownRunIds: [...record.binding.known_run_ids] };
}

function notificationFor(record, obs, kind) {
  return buildNotification({
    taskId: record.task_id,
    stateRevision: record.state_revision,
    recipient: obs.policy.notification_recipient,
    kind,
    headSha: record.head_sha,
    baseSha: record.base_sha,
    result: record.state,
    evidenceUrl: record.pr_number ? `${obs.policy.repository_url}/pull/${record.pr_number}` : null,
    actionUrl: kind === 'READY_FOR_OWNER' || kind === 'READY_FOR_PROD' ? obs.approval?.html_url ?? null : null,
  });
}

function authorizeActor(obs) {
  const authorId = obs.issue?.authorId;
  const allowed = new Set([obs.policy.owner.id, ...(obs.policy.orchestrators ?? []).map(actor => actor.id)]);
  if (!authorId || !allowed.has(authorId)) return { ok: false, reason: 'AUTHOR_NOT_ALLOWED' };
  return { ok: true };
}

function contractDrift(record, obs) {
  if (!obs.issue?.body || !record.contract_hash) return false;
  return parseContract(obs.issue.body).hash !== record.contract_hash;
}

function shaDrift(record, obs) {
  if (!record.head_sha) return null;
  const liveHead = obs.github?.pull?.headSha || obs.github?.branch?.sha || null;
  const liveBase = obs.github?.pull?.baseSha || null;
  const policyChanged = obs.policySha && record.policy_sha && obs.policySha !== record.policy_sha;
  const headChanged = liveHead && liveHead !== record.head_sha;
  const baseChanged = liveBase && record.base_sha && liveBase !== record.base_sha && record.pr_number;
  if (!policyChanged && !headChanged && !baseChanged) return null;
  if (['BUILDING', 'READY', 'BACKLOG'].includes(record.state) && !record.pr_number) return null;
  const next = touch(record, obs.now);
  next.review_request_id = null;
  next.review_run_id = null;
  next.review_run_attempt = null;
  next.ci_run_id = null;
  next.ci_run_attempt = null;
  next.approval_request_id = null;
  next.binding.evidence = { ci: null, review: null };
  next.binding.approval = null;
  next.head_sha = liveHead ?? record.head_sha;
  next.base_sha = liveBase ?? record.base_sha;
  next.policy_sha = obs.policySha ?? record.policy_sha;
  next.state = 'PR_REVIEW';
  next.technical_state = record.binding.approval || record.state === 'READY_FOR_OWNER' ? 'APPROVAL_STALE' : 'REVIEW_STALE';
  if (record.binding.lane === 'promotion') {
    next.state = 'READY_FOR_PROD';
    next.technical_state = 'APPROVAL_STALE';
  }
  return done(next);
}

function currentRun(obs, record) {
  const runs = obs.cursor?.runs ?? [];
  if (record.cursor_run_id) return runs.find(run => run.id === record.cursor_run_id) ?? null;
  return runs[0] ?? null;
}

function cursorBusy(obs) {
  return (obs.cursor?.runs ?? []).some(run => ACTIVE_RUN.has(run.status));
}

function findTaskPull(obs, record) {
  const pulls = obs.github.pulls ?? (obs.github.pull ? [obs.github.pull] : []);
  return pulls.find(pull => pull.headRef === record.binding.branch && pull.baseRef === 'integration' && pull.headRepositoryId === record.repository_id && String(pull.body ?? '').includes(`skillcheck-task:${record.task_id}`)) ?? null;
}

function promotionLive(record, obs) {
  return {
    integrationSha: obs.github?.pull?.headSha,
    mainSha: obs.github?.pull?.baseSha,
    policySha: obs.policySha,
    manifestHash: record.binding.promotion?.manifest_hash,
  };
}

function done(record) {
  return { record, effects: [], journal: record ? journalFor(record, 'transition') : null };
}

function effect(record, effects) {
  return { record, preEffectRecord: record, effects, journal: journalFor(record, effects[0]?.type ?? 'effect') };
}

function journalFor(record, action) {
  return {
    action,
    before: record.state,
    after: record.state,
    operation_key: record.binding?.dispatch?.operationKey ?? operationKey({
      repositoryId: record.repository_id,
      taskId: record.task_id,
      taskRevision: record.task_revision,
      headSha: record.head_sha,
      baseSha: record.base_sha,
      action,
      round: record.repair_round,
    }),
  };
}
