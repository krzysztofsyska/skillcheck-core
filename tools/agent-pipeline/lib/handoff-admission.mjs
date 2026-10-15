import { agentIdFor, operationKey, sha256 } from './canonical.mjs';
import { CODEX_REVIEWER, HANDOFF_ATTEMPT_LIMIT, REPOSITORY, claimRereview, cursorHandoffPlan, dedupKey, handoffIdFor, retireOpenReservations } from './handoff-loop.mjs';

export const CURSOR_SLOT_LIMIT = 5;
const PRIORITY_RANK = Object.freeze({ FREE: 0, PRESELEKCJA: 1, 'SC-005': 2 });
const ACTIVE_SEVERITIES = new Set(['P0', 'P1', 'P2']);
const OCCUPYING = new Set(['REQUESTED', 'STARTED', 'DISPATCH_UNKNOWN', 'CANCEL_PENDING']);

export function conditionsDigest(conditions) {
  return sha256({
    policy_sha: conditions?.policy_sha ?? null,
    required_checks: [...(conditions?.required_checks ?? [])].map(String).sort(),
  });
}

export function ensureAdmission(ledger) {
  ledger.slots ??= {};
  ledger.queue ??= [];
  ledger.bound_reviews ??= {};
  ledger.completed_tasks ??= {};
  return ledger;
}

export function occupiedCount(ledger) {
  return Object.values(ledger.slots ?? {}).filter(slot => slot.occupied).length;
}

export async function dispatchAdmission(ledger, snapshot) {
  ensureAdmission(ledger);
  if (snapshot?.error?.status === 403 || snapshot?.error?.code === 'BLOCKED_CONFIGURATION') {
    return { ledger, partial: blockedPartial(snapshot, 'BLOCKED_INTEGRATION', 403) };
  }
  return { ledger, partial: admit(ledger, snapshot) };
}

export function admit(ledger, snapshot) {
  ensureAdmission(ledger);
  if (snapshot?.error?.status === 403) return blockedPartial(snapshot, 'BLOCKED_INTEGRATION', 403);
  const adapter = trustedAdapter(snapshot);
  if (!adapter) return stagePartial(snapshot, null, { status: 'IGNORED_UNTRUSTED', next_stage: 'wait_for_adapter', blocker: 'IGNORED_UNTRUSTED' });
  const kind = adapter.kind;
  if (kind === 'comment') return stagePartial(snapshot, adapter, { status: 'COMMENT_ONLY', next_stage: 'wait_for_adapter', blocker: null });
  if (kind === 'merge') return stagePartial(snapshot, adapter, { status: 'BLOCKED_MERGE', next_stage: 'blocked', blocker: 'BLOCKED_MERGE' });
  if (kind === 'deploy') return stagePartial(snapshot, adapter, { status: 'BLOCKED_DEPLOY', next_stage: 'blocked', blocker: 'BLOCKED_DEPLOY' });
  if (kind === 'started') return guarded(snapshot, adapter, () => markStarted(ledger, snapshot, adapter));
  if (kind === 'completed') return guarded(snapshot, adapter, () => markCompleted(ledger, snapshot, adapter));
  if (kind === 'review') return bindReview(ledger, snapshot, adapter);
  if (kind === 'dispatch_unknown') return markUnknown(ledger, snapshot);
  if (kind === 'cancelled') return guarded(snapshot, adapter, () => markCancelled(ledger, snapshot, adapter));
  if (kind === 'dispatch_request') return guarded(snapshot, adapter, () => requestDispatch(ledger, snapshot, adapter), { base: true });
  return stagePartial(snapshot, adapter, { status: 'IGNORED_EVENT', next_stage: 'wait_for_adapter', blocker: 'IGNORED_EVENT' });
}

function requestDispatch(ledger, snapshot, adapter) {
  const task = taskFrom(adapter, snapshot);
  if (!task.task_id) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  }
  if (ledger.slots[task.pr]?.occupied && ledger.slots[task.pr].phase === 'DISPATCH_UNKNOWN') {
    return stagePartial(snapshot, adapter, { status: 'RECONCILE_REQUIRED', next_stage: 'reconcile', blocker: 'RECONCILE_REQUIRED', agent_id: ledger.slots[task.pr].agent_id });
  }
  if (occupyingSlot(ledger, task.pr) || ledger.queue.some(item => item.pr === task.pr)) {
    return stagePartial(snapshot, adapter, { status: 'DUPLICATE_DISPATCH', next_stage: 'wait_for_slot', blocker: null, agent_id: occupyingSlot(ledger, task.pr)?.agent_id ?? null });
  }
  const graph = [...ledger.queue, ...Object.values(ledger.slots), task];
  if (cycleMembers(graph).has(task.task_id)) {
    for (const queued of [...ledger.queue]) {
      if (cycleMembers(graph).has(queued.task_id)) {
        ledger.queue = ledger.queue.filter(item => item.task_id !== queued.task_id);
      }
    }
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_DEPENDENCY_CYCLE', next_stage: 'blocked', blocker: 'BLOCKED_DEPENDENCY_CYCLE' });
  }
  ledger.queue.push(task);
  const promotion = promote(ledger);
  const slot = ledger.slots[task.pr];
  const plan = { cursor_handoff: promotion.cursor_handoff, admitted: promotion.admitted };
  if (slot?.occupied && promotion.admitted.some(item => item.task_id === task.task_id)) {
    return stagePartial(snapshot, adapter, { status: 'REQUESTED', next_stage: 'wait_for_ack', blocker: null, agent_id: slot.agent_id, ...plan });
  }
  if (!dependenciesMet(ledger, task)) {
    return stagePartial(snapshot, adapter, { status: 'WAITING_DEPENDENCY', next_stage: 'wait_for_dependency', blocker: 'WAITING_DEPENDENCY', ...plan });
  }
  return stagePartial(snapshot, adapter, { status: 'WAITING_CAPACITY', next_stage: 'wait_for_slot', blocker: 'WAITING_CAPACITY', ...plan });
}

function markStarted(ledger, snapshot, adapter) {
  const slot = occupyingSlot(ledger, String(adapter.pr));
  if (!slot || !sameRemoteTask(slot, adapter)) {
    return stagePartial(snapshot, adapter, { status: 'IGNORED_NO_RESERVATION', next_stage: 'wait_for_adapter', blocker: 'IGNORED_NO_RESERVATION' });
  }
  slot.phase = 'STARTED';
  slot.ack = adapter.ack === true;
  return stagePartial(snapshot, adapter, { status: 'STARTED', next_stage: 'wait_for_commit', blocker: null, agent_id: slot.agent_id });
}

function markCompleted(ledger, snapshot, adapter) {
  const slot = occupyingSlot(ledger, String(adapter.pr));
  if (!slot || !sameRemoteTask(slot, adapter)) {
    return stagePartial(snapshot, adapter, { status: 'IGNORED_NO_RESERVATION', next_stage: 'wait_for_adapter', blocker: 'IGNORED_NO_RESERVATION' });
  }
  if (adapter.ack !== true) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_NO_ACK', next_stage: 'wait_for_ack', blocker: 'BLOCKED_NO_ACK', agent_id: slot.agent_id });
  }
  if (!adapter.head_sha || adapter.head_sha === slot.head_sha) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_NO_COMMIT', next_stage: 'wait_for_commit', blocker: 'BLOCKED_NO_COMMIT', agent_id: slot.agent_id });
  }
  slot.phase = 'COMPLETED';
  slot.occupied = false;
  slot.ack = true;
  slot.completed_head_sha = adapter.head_sha;
  ledger.completed_tasks[slot.task_id] = { pr: slot.pr, task_id: slot.task_id, head_sha: adapter.head_sha, base_sha: slot.base_sha };
  const promotion = promote(ledger);
  return stagePartial(snapshot, adapter, {
    status: 'COMPLETED',
    next_stage: 'wait_for_review',
    blocker: null,
    agent_id: slot.agent_id,
    cursor_handoff: promotion.cursor_handoff,
    admitted: promotion.admitted,
    codex_rereview: claimRereview(ledger, slot.pr, adapter.head_sha),
  });
}

function bindReview(ledger, snapshot, adapter) {
  if (!isIndependentCodex(snapshot, adapter)) {
    return stagePartial(snapshot, adapter, { status: 'IGNORED_REVIEWER', next_stage: 'wait_for_review', blocker: 'IGNORED_REVIEWER' });
  }
  if (reviewEvidenceProblem(snapshot, adapter)) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  }
  const reviewId = snapshot.review.id;
  const digest = conditionsDigest(adapter.conditions);
  const pr = String(snapshot.pull.number);
  const key = bindingKey(pr, adapter.head_sha, adapter.base_sha, digest);
  if (isNegativeReview(snapshot, adapter)) {
    return revocationResult(ledger, snapshot, adapter, key, negativeVerdict(snapshot, adapter), reviewId, pr, 'READINESS_REVOKED', 'wait_for_review', adapter.submitted_at);
  }
  if (activeFindings(adapter).length > 0) {
    return revocationResult(ledger, snapshot, adapter, key, 'FINDINGS', reviewId, pr, 'BLOCKED_FINDINGS', 'blocked', adapter.submitted_at);
  }
  if (!isActor(adapter.fix_author)) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  }
  const stored = ledger.bound_reviews[key];
  if (revocationBlocks(stored, reviewId) || identityRevoked(ledger, pr, adapter.head_sha, adapter.base_sha, reviewId, adapter.submitted_at)) {
    return stagePartial(snapshot, adapter, { status: 'STALE_REVIEW', next_stage: 'wait_for_review', blocker: 'STALE_REVIEW' });
  }
  const current = reviewStillValid(ledger, adapter.head_sha, adapter.base_sha, digest, { pr, reviewId });
  if (adapter.reuse_binding === true && !current) {
    return stagePartial(snapshot, adapter, { status: 'STALE_REVIEW', next_stage: 'wait_for_review', blocker: 'STALE_REVIEW' });
  }
  if (current?.verdict === 'PASS' && adapter.verdict === 'PASS') {
    return mergeReadiness(ledger, snapshot, adapter, { status: 'REVIEW_REUSED', next_stage: 'owner_acceptance', blocker: null });
  }
  if (adapter.verdict !== 'PASS') {
    return stagePartial(snapshot, adapter, { status: 'REVIEW_NOT_PASS', next_stage: 'wait_for_review', blocker: 'REVIEW_NOT_PASS' });
  }
  const seen = reviewIdList(stored?.seen_review_ids, stored?.review_id, stored?.revoked_review_ids, reviewId);
  const noted = notePassIdentity(ledger, pr, adapter.head_sha, adapter.base_sha, reviewId, adapter.submitted_at);
  if (noted === 'unordered') return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  if (noted === 'stale') return stagePartial(snapshot, adapter, { status: 'STALE_REVIEW', next_stage: 'wait_for_review', blocker: 'STALE_REVIEW' });
  ledger.bound_reviews[key] = {
    pr,
    review_id: reviewId,
    head_sha: adapter.head_sha,
    base_sha: adapter.base_sha,
    digest,
    conditions: {
      policy_sha: adapter.conditions.policy_sha,
      required_checks: [...adapter.conditions.required_checks],
    },
    verdict: 'PASS',
    completed: true,
    revoked: false,
    task_id: adapter.task_id ?? null,
    seen_review_ids: seen,
    revoked_review_ids: reviewIdList(stored?.revoked_review_ids),
    submitted_at: adapter.submitted_at ?? null,
  };
  return mergeReadiness(ledger, snapshot, adapter, { status: 'REVIEW_BOUND', next_stage: 'owner_acceptance', blocker: null });
}

function mergeReadiness(ledger, snapshot, adapter, partial) {
  const digest = conditionsDigest(adapter.conditions);
  const valid = reviewStillValid(ledger, adapter.head_sha, adapter.base_sha, digest, {
    pr: snapshot.pull?.number,
    reviewId: snapshot.review?.id,
  });
  const active = activeFindings(adapter);
  const dependencies = dependencyContract(ledger, adapter);
  if (dependencies.mismatch) {
    return stagePartial(snapshot, adapter, { status: 'DEPENDENCY_MISMATCH', next_stage: 'wait_for_dependency', blocker: 'WAITING_DEPENDENCY' });
  }
  const dependenciesReady = dependencies.required.every(taskId => ledger.completed_tasks[taskId]);
  const ciReady = adapter.ci?.sha === snapshot.pull?.headSha && adapter.ci?.sha === adapter.head_sha && adapter.ci?.conclusion === 'success';
  if (valid?.verdict === 'PASS' && ciReady && dependenciesReady && active.length === 0) {
    if (!ownTaskReady(ledger, snapshot, adapter)) {
      return stagePartial(snapshot, adapter, { status: 'BLOCKED_NO_COMMIT', next_stage: 'wait_for_commit', blocker: 'BLOCKED_NO_COMMIT' });
    }
    return stagePartial(snapshot, adapter, { status: 'READY_TO_MERGE', next_stage: 'owner_acceptance', blocker: null });
  }
  if (active.length > 0) return stagePartial(snapshot, adapter, { status: 'BLOCKED_FINDINGS', next_stage: 'blocked', blocker: 'BLOCKED_FINDINGS' });
  if (!dependenciesReady) return stagePartial(snapshot, adapter, { status: partial.status, next_stage: 'wait_for_dependency', blocker: 'WAITING_DEPENDENCY' });
  if (!ciReady) return stagePartial(snapshot, adapter, { status: partial.status, next_stage: 'wait_for_ci', blocker: 'WAITING_CI' });
  return stagePartial(snapshot, adapter, partial);
}

export function bindingKey(pr, head, base, digest) {
  return sha256({ pr: pr == null ? null : String(pr), head, base, digest });
}

export function reviewStillValid(ledger, head, base, digest, identity = {}) {
  const pr = identity.pr == null ? null : String(identity.pr);
  const stored = ledger.bound_reviews?.[bindingKey(pr, head, base, digest)];
  if (!stored || stored.completed !== true || stored.revoked === true || stored.verdict !== 'PASS') return null;
  if (stored.pr !== pr || stored.head_sha !== head || stored.base_sha !== base || stored.digest !== digest) return null;
  if (!stored.review_id || !stored.conditions) return null;
  if (identity.reviewId != null && stored.review_id !== identity.reviewId) return null;
  if (identity.reviewId != null && identityRevoked(ledger, pr, head, base, identity.reviewId)) return null;
  return stored;
}

function guarded(snapshot, adapter, proceed, options = {}) {
  if (identityProblem(snapshot, adapter)) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  }
  if (options.base === true && !adapter.base_sha) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  }
  if (snapshot.pull?.baseSha && adapter.base_sha && adapter.base_sha !== snapshot.pull.baseSha) {
    return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  }
  return proceed();
}

function identityProblem(snapshot, adapter) {
  const pull = snapshot?.pull;
  if (!pull?.number || adapter?.pr == null || String(adapter.pr) !== String(pull.number)) return true;
  if (!pull.headSha || !adapter?.head_sha || adapter.head_sha !== pull.headSha) return true;
  return false;
}

function reviewEvidenceProblem(snapshot, adapter) {
  if (identityProblem(snapshot, adapter) || !isCommitSha(adapter.base_sha) || !isCommitSha(snapshot.pull?.baseSha)) return true;
  if (adapter.base_sha !== snapshot.pull.baseSha) return true;
  const reviewId = snapshot.review?.id;
  if (!Number.isInteger(reviewId) || reviewId <= 0) return true;
  if (adapter.review_id != null && adapter.review_id !== reviewId) return true;
  const conditions = adapter.conditions;
  if (!conditions || typeof conditions.policy_sha !== 'string' || conditions.policy_sha.length === 0) return true;
  if (!Array.isArray(conditions.required_checks)) return true;
  return false;
}

function isNegativeReview(snapshot, adapter) {
  if (adapter?.verdict === 'FAIL' || adapter?.verdict === 'PASS_WITH_FIXES') return true;
  return String(snapshot?.review?.state ?? '').toLowerCase() === 'dismissed';
}

function negativeVerdict(snapshot, adapter) {
  if (adapter?.verdict === 'FAIL' || adapter?.verdict === 'PASS_WITH_FIXES') return adapter.verdict;
  return 'DISMISSED';
}

function promote(ledger) {
  const admitted = [];
  let cursorHandoff = null;
  const ranked = [...ledger.queue].sort((left, right) => {
    const rank = priorityRank(left, ledger) - priorityRank(right, ledger);
    if (rank !== 0) return rank;
    return String(left.created_at).localeCompare(String(right.created_at));
  });
  for (const task of ranked) {
    if (occupiedCount(ledger) >= CURSOR_SLOT_LIMIT) break;
    if (!dependenciesMet(ledger, task) || occupyingSlot(ledger, task.pr)) continue;
    if (task.handoff === true && (ledger.attempts?.[task.pr] ?? 0) >= HANDOFF_ATTEMPT_LIMIT) continue;
    occupy(ledger, task);
    const slot = ledger.slots[task.pr];
    const plan = dispatchPlan(task, slot);
    if (!plan) {
      delete ledger.slots[task.pr];
      continue;
    }
    ledger.queue = ledger.queue.filter(item => item.task_id !== task.task_id);
    admitted.push(plan);
    if (task.handoff === true && cursorHandoff == null) {
      const reservation = recordQueuedHandoff(ledger, task);
      if (reservation) cursorHandoff = cursorHandoffPlan(reservation.finding_refs);
    }
  }
  return { admitted, cursor_handoff: cursorHandoff };
}

function dispatchPlan(task, slot) {
  if (!slot?.agent_id || task?.task_id == null || task.pr == null || !task.head_sha) return null;
  return {
    task_id: String(task.task_id),
    agent_id: slot.agent_id,
    pr: String(task.pr),
    sha: task.head_sha,
  };
}

function recordQueuedHandoff(ledger, task) {
  ledger.attempts ??= {};
  ledger.reservations ??= {};
  const pr = String(task.pr);
  const reviewId = task.review_id;
  if (reviewId == null) return null;
  const key = dedupKey(pr, task.head_sha, reviewId);
  if (ledger.reservations[key]) return null;
  const used = ledger.attempts[pr] ?? 0;
  ledger.attempts[pr] = used + 1;
  ledger.reservations[key] = {
    handoff_id: handoffIdFor(pr, task.head_sha, reviewId),
    pr,
    sha: task.head_sha,
    review_id: reviewId,
    status: 'HANDOFF_PLANNED',
    finding_refs: [...(task.findings ?? [])],
    successor_sha: null,
    review_requested_for: null,
    created_at: task.created_at ?? null,
  };
  return ledger.reservations[key];
}

function occupy(ledger, task) {
  const agentId = agentIdFor(operationKey({
    repositoryId: REPOSITORY,
    taskId: task.task_id,
    taskRevision: 1,
    headSha: task.head_sha,
    baseSha: task.base_sha,
    action: 'cursor-handoff',
    round: 0,
  }));
  const slot = {
    pr: task.pr,
    task_id: task.task_id,
    priority: task.priority,
    depends_on: task.depends_on,
    phase: 'REQUESTED',
    ack: false,
    occupied: true,
    agent_id: agentId,
    head_sha: task.head_sha,
    base_sha: task.base_sha,
    executor: task.executor,
    created_at: task.created_at,
  };
  if (task.review_contract && typeof task.review_contract === 'object') slot.review_contract = structuredClone(task.review_contract);
  ledger.slots[task.pr] = slot;
}

export function claimHandoffSlot(ledger, snapshot, findings = []) {
  ensureAdmission(ledger);
  const pr = String(snapshot.pull.number);
  if (ledger.slots[pr]?.occupied && ledger.slots[pr].phase === 'DISPATCH_UNKNOWN') return { status: 'RECONCILE_REQUIRED' };
  if (occupyingSlot(ledger, pr)) return { status: 'REUSED', agent_id: ledger.slots[pr].agent_id };
  const queued = ledger.queue.find(item => item.pr === pr);
  if (queued) {
    if (queued.handoff === true) {
      const before = queued.findings?.length ?? 0;
      mergeFindingRefs(queued, findings);
      noteReview(queued, snapshot.review?.id);
      return { status: queued.findings.length > before ? 'PENDING_FEEDBACK' : 'DUPLICATE_DISPATCH', queued: true };
    }
    return { status: 'DUPLICATE_DISPATCH' };
  }
  const task = handoffTask(snapshot, findings);
  const carried = ledger.slots[pr]?.review_contract;
  if (carried && typeof carried === 'object') task.review_contract = structuredClone(carried);
  if (occupiedCount(ledger) >= CURSOR_SLOT_LIMIT) {
    ledger.queue.push(task);
    return { status: 'WAITING_CAPACITY' };
  }
  occupy(ledger, task);
  return { status: 'REQUESTED', agent_id: ledger.slots[pr].agent_id };
}

function handoffTask(snapshot, findings) {
  const pr = String(snapshot.pull.number);
  return {
    pr,
    task_id: `review-${pr}`,
    priority: 'NORMAL',
    depends_on: [],
    head_sha: snapshot.pull.headSha,
    base_sha: snapshot.pull.baseSha ?? snapshot.pull.baseRef ?? null,
    executor: 'cursor',
    created_at: snapshot.now ?? null,
    handoff: true,
    review_id: snapshot.review?.id ?? null,
    findings: [...findings],
    feedback_reviews: snapshot.review?.id == null ? [] : [snapshot.review.id],
  };
}

export function releasePull(ledger, pr) {
  ensureAdmission(ledger);
  const key = String(pr ?? '');
  if (!key) return { released: false, held: false };
  const slot = ledger.slots[key];
  if (slot?.occupied && (slot.phase === 'DISPATCH_UNKNOWN' || slot.phase === 'CANCEL_PENDING')) {
    return { released: false, held: true };
  }
  if (slot?.occupied && (slot.phase === 'STARTED' || slot.ack === true)) {
    slot.phase = 'CANCEL_PENDING';
    slot.occupied = true;
    return { released: false, held: true };
  }
  let released = false;
  if (slot?.occupied && slot.phase === 'REQUESTED' && slot.ack !== true) {
    slot.occupied = false;
    slot.phase = 'CANCELLED';
    slot.ack = false;
    retireOpenReservations(ledger, key);
    released = true;
  }
  const queued = ledger.queue.length;
  ledger.queue = ledger.queue.filter(item => item.pr !== key);
  if (ledger.queue.length !== queued) released = true;
  const promotion = released ? promote(ledger) : null;
  return { released, held: false, cursor_handoff: promotion?.cursor_handoff ?? null, admitted: promotion?.admitted ?? null };
}

export function markUnknown(ledger, snapshot) {
  ensureAdmission(ledger);
  const adapter = snapshot?.adapter;
  const pr = String(adapter?.pr ?? '');
  const existing = ledger.slots[pr];
  if (!existing?.occupied || !sameRemoteTask(existing, adapter)) {
    return { status: 'BLOCKED_INTEGRATION', stage: { pr: pr || null, sha: adapter?.head_sha ?? null, next_stage: 'blocked', blocker: 'BLOCKED_INTEGRATION' } };
  }
  if (existing.phase !== 'DISPATCH_UNKNOWN') {
    existing.phase = 'DISPATCH_UNKNOWN';
    existing.occupied = true;
  }
  return unknownPartial(existing);
}

function unknownPartial(slot) {
  return {
    status: 'RECONCILE_REQUIRED',
    agent_id: slot.agent_id,
    stage: {
      pr: slot.pr,
      executor: slot.executor,
      task: slot.task_id,
      sha: slot.head_sha,
      next_stage: 'reconcile',
      blocker: 'RECONCILE_REQUIRED',
      agent_id: slot.agent_id,
    },
  };
}

function markCancelled(ledger, snapshot, adapter) {
  const slot = occupyingSlot(ledger, String(adapter.pr));
  if (!slot || adapter.cancelled !== true || !sameRemoteTask(slot, adapter)) {
    return stagePartial(snapshot, adapter, { status: 'IGNORED_NO_RESERVATION', next_stage: 'reconcile', blocker: 'RECONCILE_REQUIRED' });
  }
  slot.occupied = false;
  slot.phase = 'CANCELLED';
  const promotion = promote(ledger);
  return stagePartial(snapshot, adapter, { status: 'CANCELLED', next_stage: 'wait_for_slot', blocker: null, agent_id: slot.agent_id, cursor_handoff: promotion.cursor_handoff, admitted: promotion.admitted });
}

function revocationResult(ledger, snapshot, adapter, key, verdict, reviewId, pr, status, nextStage, submittedAt) {
  const effect = revokeBinding(ledger, key, verdict, reviewId, pr, adapter.head_sha, adapter.base_sha, submittedAt);
  if (effect === 'unordered') return stagePartial(snapshot, adapter, { status: 'BLOCKED_EVIDENCE', next_stage: 'blocked', blocker: 'BLOCKED_EVIDENCE' });
  if (effect === 'bounded' && ledger.bound_reviews[key]?.revoked !== true) {
    return stagePartial(snapshot, adapter, { status: 'STALE_REVIEW', next_stage: 'wait_for_review', blocker: 'STALE_REVIEW' });
  }
  return stagePartial(snapshot, adapter, { status, next_stage: nextStage, blocker: status });
}

function revokeBinding(ledger, key, verdict, reviewId, pr, head, base, submittedAt) {
  const shared = revokeSharedReadiness(ledger, pr, head, base, reviewId, submittedAt);
  if (shared === 'unordered') return 'unordered';
  const stored = ledger.bound_reviews[key];
  if (!stored) return shared === 'bounded' ? 'bounded' : 'revoked';
  if (shared === 'bounded' || reviewIdList(stored.revoked_review_ids).includes(reviewId)) return 'bounded';
  const passAt = reviewInstant(stored.submitted_at);
  const at = reviewInstant(submittedAt);
  if (passAt != null && at != null && passAt > at) return 'bounded';
  const seen = reviewIdList(stored.seen_review_ids, stored.review_id, reviewId);
  stored.seen_review_ids = seen;
  stored.revoked_review_ids = reviewIdList(stored.revoked_review_ids, seen);
  stored.completed = false;
  stored.revoked = true;
  stored.verdict = verdict;
  return 'revoked';
}

function watermarkKey(pr, head, base) {
  return `${String(pr)}\n${head}\n${base}`;
}

function watermark(ledger, pr, head, base) {
  ensureAdmission(ledger);
  ledger.review_watermarks ??= {};
  const key = watermarkKey(pr, head, base);
  ledger.review_watermarks[key] ??= { seen_review_ids: [], revoked_review_ids: [], events: [], floor_at: null };
  return ledger.review_watermarks[key];
}

export function reviewInstant(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function orderConflict(mark, at, kind) {
  const events = mark.events ?? [];
  const hasTimed = events.some(event => event.at != null);
  const hasUntimed = events.some(event => event.at == null);
  if (at == null && hasTimed) return 'unordered';
  if (at != null && hasUntimed) return 'unordered';
  if (at != null && events.some(event => event.at === at && event.id !== undefined && event.kind !== kind)) return 'unordered';
  return null;
}

export function notePassIdentity(ledger, pr, head, base, reviewId, submittedAt) {
  if (!isCommitSha(head) || !isCommitSha(base) || reviewId == null) return 'missing';
  const mark = watermark(ledger, pr, head, base);
  const at = reviewInstant(submittedAt);
  if (mark.revoked_review_ids.includes(reviewId)) return 'stale';
  const conflict = orderConflict(mark, at, 'pass');
  if (conflict) return conflict;
  if (at != null && mark.floor_at != null && at <= mark.floor_at) return 'stale';
  mark.events ??= [];
  if (!mark.events.some(event => event.id === reviewId && event.kind === 'pass')) {
    mark.events.push({ id: reviewId, at, kind: 'pass' });
  }
  mark.seen_review_ids = reviewIdList(mark.seen_review_ids, reviewId);
  return 'pass';
}

export function identityRevoked(ledger, pr, head, base, reviewId, submittedAt) {
  const at = reviewInstant(submittedAt);
  const marks = ledger?.review_watermarks ?? {};
  for (const [key, mark] of Object.entries(marks)) {
    const [markPr, markHead, markBase] = key.split('\n');
    if (markPr !== String(pr) || markHead !== head) continue;
    if (isCommitSha(base) && markBase !== base) continue;
    if (mark.revoked_review_ids?.includes(reviewId)) return true;
    if (at != null && mark.floor_at != null && at <= mark.floor_at) return true;
  }
  return false;
}

export function revokeSharedReadiness(ledger, pr, head, base, reviewId, submittedAt) {
  ensureAdmission(ledger);
  const at = reviewInstant(submittedAt);
  const bases = new Set();
  if (isCommitSha(base)) bases.add(base);
  else {
    for (const key of Object.keys(ledger.review_watermarks ?? {})) {
      const [markPr, markHead, markBase] = key.split('\n');
      if (markPr === String(pr) && markHead === head && isCommitSha(markBase)) bases.add(markBase);
    }
  }
  if (bases.size === 0) return 'missing';
  for (const item of bases) {
    const conflict = orderConflict(watermark(ledger, pr, head, item), at, 'negative');
    if (conflict) return conflict;
  }
  let effect = 'missing';
  for (const item of bases) {
    const mark = watermark(ledger, pr, head, item);
    if ((mark.events ?? []).some(event => event.id === reviewId && event.kind === 'negative') || (at == null && mark.revoked_review_ids.includes(reviewId))) {
      effect = 'bounded';
      continue;
    }
    mark.events ??= [];
    if (at == null) {
      mark.seen_review_ids = reviewIdList(mark.seen_review_ids, reviewId);
      mark.revoked_review_ids = reviewIdList(mark.revoked_review_ids, mark.seen_review_ids);
      mark.events.push({ id: reviewId, at: null, kind: 'negative' });
      effect = 'revoked';
      continue;
    }
    mark.events.push({ id: reviewId, at, kind: 'negative' });
    mark.floor_at = mark.floor_at == null ? at : Math.max(mark.floor_at, at);
    const revoked = new Set(mark.revoked_review_ids);
    revoked.add(reviewId);
    for (const event of mark.events) {
      if (event.kind === 'pass' && event.at != null && event.at <= mark.floor_at) revoked.add(event.id);
    }
    mark.revoked_review_ids = [...revoked];
    mark.seen_review_ids = reviewIdList(mark.seen_review_ids, reviewId);
    effect = 'revoked';
  }
  if (effect === 'bounded') return 'bounded';
  let flipped = false;
  for (const row of Object.values(ledger.reservations ?? {})) {
    if (String(row.pr) !== String(pr) || row.successor_sha !== head || row.status !== 'READY_FOR_OWNER') continue;
    if (row.ready_at != null && at != null && row.ready_at > at) continue;
    row.status = 'READINESS_REVOKED';
    row.revoked_review_id = reviewId;
    flipped = true;
  }
  if (!flipped && at != null) {
    const protectedReady = Object.values(ledger.reservations ?? {}).some(row => String(row.pr) === String(pr) && row.successor_sha === head && row.status === 'READY_FOR_OWNER' && row.ready_at != null && row.ready_at > at);
    if (protectedReady) return 'bounded';
  }
  return effect;
}

function revocationBlocks(stored, reviewId) {
  return Boolean(stored?.revoked_review_ids?.includes(reviewId));
}

function reviewIdList(...groups) {
  const ids = [];
  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      if (value == null || ids.includes(value)) continue;
      ids.push(value);
    }
  }
  return ids;
}

function dependencyContract(ledger, adapter) {
  const pr = String(adapter.pr ?? '');
  const taskId = adapter.task_id == null ? null : String(adapter.task_id);
  const related = [...ledger.queue, ...Object.values(ledger.slots)].filter(item => item && (item.pr === pr || (taskId && item.task_id === taskId)));
  const stored = [...new Set(related.flatMap(item => (item.depends_on ?? []).map(String)))].sort();
  const declared = [...new Set((adapter.depends_on ?? []).map(String))].sort();
  return {
    stored,
    declared,
    mismatch: stored.length > 0 && stored.join('\0') !== declared.join('\0'),
    required: stored.length > 0 ? stored : declared,
  };
}

function priorityRank(task, ledger) {
  if (Object.hasOwn(PRIORITY_RANK, task.priority)) return PRIORITY_RANK[task.priority];
  const boosted = [...ledger.queue, ...Object.values(ledger.slots)].some(other =>
    Object.hasOwn(PRIORITY_RANK, other.priority) && (other.depends_on ?? []).includes(task.task_id));
  return boosted ? 3 : 4;
}

function dependenciesMet(ledger, task) {
  return (task.depends_on ?? []).every(taskId => ledger.completed_tasks[taskId]);
}

function occupyingSlot(ledger, pr) {
  const slot = ledger.slots[String(pr)];
  if (!slot || !slot.occupied || !OCCUPYING.has(slot.phase)) return null;
  return slot;
}

function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function isActor(actor) {
  return Boolean(actor && actor.id != null && typeof actor.login === 'string' && actor.login.length > 0);
}

function sameRemoteTask(slot, adapter) {
  if (!slot || !adapter) return false;
  if (adapter.agent_id !== slot.agent_id) return false;
  if (adapter.task_id == null || String(adapter.task_id) !== String(slot.task_id)) return false;
  if (adapter.pr == null || String(adapter.pr) !== String(slot.pr)) return false;
  return true;
}

function mergeFindingRefs(target, findings) {
  target.findings ??= [];
  const known = new Set(target.findings.map(item => item.comment_id));
  for (const finding of findings) {
    if (known.has(finding.comment_id)) continue;
    target.findings.push(finding);
    known.add(finding.comment_id);
  }
}

function noteReview(target, reviewId) {
  if (reviewId == null) return;
  target.feedback_reviews ??= [];
  if (!target.feedback_reviews.includes(reviewId)) target.feedback_reviews.push(reviewId);
}

function cycleMembers(tasks) {
  const byId = new Map(tasks.filter(task => task?.task_id).map(task => [task.task_id, task]));
  const members = new Set();
  const state = new Map();
  const stack = [];
  function visit(id) {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start)) members.add(member);
      return;
    }
    const task = byId.get(id);
    if (!task) return;
    state.set(id, 'open');
    stack.push(id);
    for (const dependency of task.depends_on ?? []) visit(dependency);
    stack.pop();
    state.set(id, 'done');
  }
  for (const id of byId.keys()) visit(id);
  return members;
}

function taskIdentifier(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function taskFrom(adapter, snapshot) {
  const task = {
    pr: String(adapter.pr),
    task_id: taskIdentifier(adapter.task_id),
    priority: adapter.priority ?? 'NORMAL',
    depends_on: [...(adapter.depends_on ?? [])].map(String),
    head_sha: adapter.head_sha,
    base_sha: adapter.base_sha,
    executor: adapter.executor ?? null,
    created_at: snapshot.now ?? null,
  };
  if (adapter.review_contract && typeof adapter.review_contract === 'object') task.review_contract = structuredClone(adapter.review_contract);
  return task;
}

function trustedAdapter(snapshot) {
  const adapter = snapshot?.adapter;
  if (!adapter || adapter.source !== 'trusted_adapter') return null;
  return adapter;
}

function isIndependentCodex(snapshot, adapter) {
  const sender = snapshot.sender;
  const reviewer = snapshot.review?.user;
  const codex = actor => actor && actor.id === CODEX_REVIEWER.id && actor.login === CODEX_REVIEWER.login && actor.type === CODEX_REVIEWER.type;
  if (!codex(sender) || !codex(reviewer)) return false;
  const author = snapshot.pull?.author;
  if (author && (author.id === reviewer.id || author.login === reviewer.login)) return false;
  if (adapter.fix_author && (adapter.fix_author.id === reviewer.id || adapter.fix_author.login === reviewer.login)) return false;
  return true;
}

function activeFindings(adapter) {
  return (adapter.findings ?? []).filter(finding => finding && finding.active !== false && ACTIVE_SEVERITIES.has(String(finding.severity ?? '').toUpperCase()));
}

function blockedPartial(snapshot, status, httpStatus) {
  return stagePartial(snapshot, trustedAdapter(snapshot), { status, http_status: httpStatus, next_stage: 'blocked', blocker: status });
}

function ownTaskReady(ledger, snapshot, adapter) {
  const pr = String(snapshot.pull?.number ?? '');
  const taskId = adapter?.task_id == null ? null : String(adapter.task_id);
  const related = task => task && (task.pr === pr || (taskId != null && task.task_id === taskId));
  if ((ledger.queue ?? []).some(related)) return false;
  const slot = ledger.slots?.[pr] ?? Object.values(ledger.slots ?? {}).find(related);
  if (!slot) return true;
  if (slot.occupied) return false;
  if (slot.phase === 'COMPLETED') return slot.completed_head_sha === adapter.head_sha;
  return true;
}

function stagePartial(snapshot, adapter, fields) {
  return {
    status: fields.status,
    http_status: fields.http_status ?? null,
    agent_id: fields.agent_id ?? null,
    cursor_handoff: fields.cursor_handoff ?? null,
    codex_rereview: fields.codex_rereview ?? null,
    admitted: fields.admitted ?? null,
    stage: {
      pr: adapter?.pr ?? snapshot?.pull?.number ?? null,
      executor: adapter?.executor ?? null,
      task: adapter?.task_id ?? null,
      sha: adapter?.head_sha ?? null,
      tests: adapter?.tests ?? null,
      review: adapter?.verdict ?? null,
      next_stage: fields.next_stage ?? null,
      blocker: fields.blocker ?? null,
      agent_id: fields.agent_id ?? null,
    },
  };
}
