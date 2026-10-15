import { agentIdFor, operationKey, sha256 } from './canonical.mjs';
import { CODEX_REVIEWER, REPOSITORY } from './handoff-loop.mjs';

export const CURSOR_SLOT_LIMIT = 5;
const PRIORITY_RANK = Object.freeze({ FREE: 0, PRESELEKCJA: 1, 'SC-005': 2 });
const ACTIVE_SEVERITIES = new Set(['P0', 'P1', 'P2']);
const OCCUPYING = new Set(['REQUESTED', 'STARTED']);

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
  if (kind === 'dispatch_request') return guarded(snapshot, adapter, () => requestDispatch(ledger, snapshot, adapter), { base: true });
  return stagePartial(snapshot, adapter, { status: 'IGNORED_EVENT', next_stage: 'wait_for_adapter', blocker: 'IGNORED_EVENT' });
}

function requestDispatch(ledger, snapshot, adapter) {
  const task = taskFrom(adapter, snapshot);
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
  const admitted = promote(ledger);
  const slot = ledger.slots[task.pr];
  if (slot?.occupied && admitted.includes(task.task_id)) {
    return stagePartial(snapshot, adapter, { status: 'REQUESTED', next_stage: 'wait_for_ack', blocker: null, agent_id: slot.agent_id });
  }
  if (!dependenciesMet(ledger, task)) {
    return stagePartial(snapshot, adapter, { status: 'WAITING_DEPENDENCY', next_stage: 'wait_for_dependency', blocker: 'WAITING_DEPENDENCY' });
  }
  return stagePartial(snapshot, adapter, { status: 'WAITING_CAPACITY', next_stage: 'wait_for_slot', blocker: 'WAITING_CAPACITY' });
}

function markStarted(ledger, snapshot, adapter) {
  const slot = occupyingSlot(ledger, String(adapter.pr));
  if (!slot || adapter.agent_id !== slot.agent_id) {
    return stagePartial(snapshot, adapter, { status: 'IGNORED_NO_RESERVATION', next_stage: 'wait_for_adapter', blocker: 'IGNORED_NO_RESERVATION' });
  }
  slot.phase = 'STARTED';
  slot.ack = adapter.ack === true;
  return stagePartial(snapshot, adapter, { status: 'STARTED', next_stage: 'wait_for_commit', blocker: null, agent_id: slot.agent_id });
}

function markCompleted(ledger, snapshot, adapter) {
  const slot = occupyingSlot(ledger, String(adapter.pr));
  if (!slot || adapter.agent_id !== slot.agent_id) {
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
  promote(ledger);
  return stagePartial(snapshot, adapter, { status: 'COMPLETED', next_stage: 'wait_for_review', blocker: null, agent_id: slot.agent_id });
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
    const stored = ledger.bound_reviews[key];
    if (stored) {
      stored.completed = false;
      stored.revoked = true;
      stored.verdict = negativeVerdict(snapshot, adapter);
    }
    return stagePartial(snapshot, adapter, { status: 'READINESS_REVOKED', next_stage: 'wait_for_review', blocker: 'READINESS_REVOKED' });
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
  const dependenciesReady = (adapter.depends_on ?? []).every(taskId => ledger.completed_tasks[taskId]);
  const ciReady = adapter.ci?.sha === snapshot.pull?.headSha && adapter.ci?.sha === adapter.head_sha && adapter.ci?.conclusion === 'success';
  if (valid?.verdict === 'PASS' && ciReady && dependenciesReady && active.length === 0) {
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
  if (identityProblem(snapshot, adapter) || !adapter.base_sha) return true;
  if (snapshot.pull?.baseSha && adapter.base_sha !== snapshot.pull.baseSha) return true;
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
  const ranked = [...ledger.queue].sort((left, right) => {
    const rank = priorityRank(left, ledger) - priorityRank(right, ledger);
    if (rank !== 0) return rank;
    return String(left.created_at).localeCompare(String(right.created_at));
  });
  for (const task of ranked) {
    if (occupiedCount(ledger) >= CURSOR_SLOT_LIMIT) break;
    if (!dependenciesMet(ledger, task) || occupyingSlot(ledger, task.pr)) continue;
    occupy(ledger, task);
    ledger.queue = ledger.queue.filter(item => item.task_id !== task.task_id);
    admitted.push(task.task_id);
  }
  return admitted;
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
  ledger.slots[task.pr] = {
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

function taskFrom(adapter, snapshot) {
  return {
    pr: String(adapter.pr),
    task_id: String(adapter.task_id),
    priority: adapter.priority ?? 'NORMAL',
    depends_on: [...(adapter.depends_on ?? [])].map(String),
    head_sha: adapter.head_sha,
    base_sha: adapter.base_sha,
    executor: adapter.executor ?? null,
    created_at: snapshot.now ?? null,
  };
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

function stagePartial(snapshot, adapter, fields) {
  return {
    status: fields.status,
    http_status: fields.http_status ?? null,
    agent_id: fields.agent_id ?? null,
    stage: {
      pr: adapter?.pr ?? snapshot?.pull?.number ?? null,
      executor: adapter?.executor ?? null,
      task: adapter?.task_id ?? null,
      sha: adapter?.head_sha ?? snapshot?.pull?.headSha ?? null,
      tests: adapter?.tests ?? null,
      review: adapter?.verdict ?? null,
      next_stage: fields.next_stage ?? null,
      blocker: fields.blocker ?? null,
      agent_id: fields.agent_id ?? null,
    },
  };
}
