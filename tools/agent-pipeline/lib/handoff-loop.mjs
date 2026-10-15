import { operationKey, sha256 } from './canonical.mjs';
import { validateCi } from './ci.mjs';
import { artifactFromRun, findRun } from './evidence.mjs';
import { admit, claimHandoffSlot, ensureAdmission, identityRevoked, markUnknown, notePassIdentity, releasePull, reviewInstant, revokeSharedReadiness } from './handoff-admission.mjs';
import { validatePair } from './live-effects.mjs';
import { loadPolicy } from './policy.mjs';
import { validateReview } from './review.mjs';
import { requiredReviewChecks } from './transitions.mjs';

/**
 * Inactive Codex review → Cursor handoff → CI → independent Codex review loop.
 *
 * PR #57 owns the live registered-PR feedback bridge and its state branch.
 * PR #124 owns automatic integration merge. This module plans neither live
 * dispatch nor merge. Live effects stay off until a separate activation change.
 */

export const HANDOFF_ATTEMPT_LIMIT = 3;
export const LIVE_EFFECTS_ENABLED = false;
export const REPOSITORY = 'krzysztofsyska/skillcheck-core';
export const INTEGRATION_BRANCH = 'integration';
export const CODEX_REVIEWER = Object.freeze({
  id: 199175422,
  login: 'chatgpt-codex-connector[bot]',
  type: 'Bot',
});
export const CURSOR_HANDOFF_TEMPLATE = 'Update the existing pull request on its current branch. Apply the linked review findings. Do not merge, deploy, or print secrets.';

const OPEN_STATUSES = new Set(['HANDOFF_PLANNED', 'WAITING_CI', 'WAITING_CURSOR', 'CI_FAILED', 'WAITING_REREVIEW']);
// Structural sc-agent-review severities are not GitHub review threads.
// blocker → P0, major → P1, minor → P2. info does not block, so a PASS that
// still carries a minor finding does not become READY_FOR_OWNER.
const STRUCTURAL_SEVERITY = Object.freeze({ blocker: 'P0', major: 'P1', minor: 'P2' });
const REVIEW_EVENTS = new Set(['pull_request_review', 'pull_request_review_comment']);
const ADMISSION_EVENTS = new Set(['admission_request', 'admission_started', 'admission_completed', 'admission_comment', 'admission_review', 'admission_merge', 'admission_deploy']);
const SAFE_PATH = /^[A-Za-z0-9_./@+-]+$/;

export function emptyLedger() {
  return { schema_version: 1, attempts: {}, reservations: {}, audits: [], slots: {}, queue: [], bound_reviews: {}, completed_tasks: {} };
}

export function dedupKey(pr, sha, reviewId) {
  return `${pr}:${sha}:${reviewId}`;
}

export function handoffIdFor(pr, sha, reviewId) {
  return `ho-${sha256(`${pr}\n${sha}\n${reviewId}`).slice(0, 24)}`;
}

export function cursorHandoffPlan(findingRefs) {
  return {
    mechanism: 'github_comment_at_cursor',
    existing_pr: true,
    template: CURSOR_HANDOFF_TEMPLATE,
    finding_refs: [...(findingRefs ?? [])],
  };
}

export function retireOpenReservations(ledger, pr) {
  for (const row of Object.values(ledger?.reservations ?? {})) {
    if (row.pr === String(pr) && OPEN_STATUSES.has(row.status)) row.status = 'CANCELLED';
  }
}

export async function deliverGithubReview(ledger, event, threads = [], github = null) {
  const snapshot = normalizeGithubEvent(event, threads);
  const read = await readSuccessorActor(github, snapshot.pull?.headSha);
  snapshot.fixAuthor = read.user;
  if (read.blocked) snapshot.error = { status: read.status ?? null, code: read.code ?? 'BLOCKED_EVIDENCE' };
  const decision = await readCodexDecision(github, snapshot.pull?.number, snapshot.pull?.headSha, snapshot.review?.id);
  if (decision.blocked) snapshot.error = { status: decision.status ?? null, code: decision.code ?? 'BLOCKED_EVIDENCE' };
  else if (decision.reason === 'unordered') snapshot.reviewDecision = 'unordered';
  else if (decision.reason === 'superseded') {
    const state = String(decision.review.state).toLowerCase();
    snapshot.review = {
      ...snapshot.review,
      id: decision.review.id,
      state,
      commitId: decision.review.commit_id,
      user: pickActor(decision.review.user),
      submittedAt: decision.review.submitted_at,
    };
    snapshot.verdict = null;
    snapshot.reviewSuperseded = true;
    snapshot.newerDecision = {
      id: decision.newer.id,
      state: decision.newer.state,
      submitted_at: decision.newer.submitted_at,
    };
    snapshot.reviewDecision = 'superseded';
  } else if (decision.review) {
    const state = String(decision.review.state).toLowerCase();
    snapshot.review = {
      ...snapshot.review,
      id: decision.review.id,
      state,
      commitId: decision.review.commit_id,
      user: pickActor(decision.review.user),
      submittedAt: decision.review.submitted_at,
    };
    snapshot.verdict = state === 'approved' ? 'PASS' : state === 'changes_requested' ? 'FAIL' : null;
    snapshot.reviewDecision = 'found';
  } else if (decision.checked) snapshot.reviewDecision = 'missing';
  return step(ledger, snapshot);
}

async function readSuccessorActor(github, sha) {
  if (!github || typeof github.readCommit !== 'function' || !isCommitSha(sha)) return { user: null, blocked: false };
  try {
    const commit = await github.readCommit(sha);
    if (!commit || commit.sha !== sha || !isActor(commit.author)) return { user: null, blocked: false };
    return { user: pickActor(commit.author), blocked: false };
  } catch (error) {
    const status = error?.status ?? error?.statusCode ?? null;
    const blocked = status === 401 || status === 403 || error?.code === 'BLOCKED_CONFIGURATION' || status == null;
    return { user: null, blocked, status, code: error?.code ?? null };
  }
}

async function readCodexDecision(github, pr, headSha, reviewId) {
  if (!github || typeof github.readPullReviews !== 'function' || !Number.isInteger(pr) || !isCommitSha(headSha)) {
    return { blocked: false, checked: false, review: null };
  }
  try {
    const reviews = await github.readPullReviews(pr);
    if (!Array.isArray(reviews)) return { blocked: false, checked: true, review: null };
    return { blocked: false, checked: true, ...selectCodexReview(reviews, headSha, reviewId) };
  } catch (error) {
    const status = error?.status ?? error?.statusCode ?? null;
    const blocked = status === 401 || status === 403 || error?.code === 'BLOCKED_CONFIGURATION' || status == null;
    return { blocked, checked: true, review: null, status, code: error?.code ?? null };
  }
}

function selectCodexReview(reviews, headSha, reviewId) {
  const rows = reviews.filter(review => isCodex(review?.user)
    && review?.commit_id === headSha
    && Number.isInteger(review?.id)
    && typeof review?.submitted_at === 'string'
    && review.submitted_at.length > 0
    && !Number.isNaN(Date.parse(review.submitted_at)));
  const requested = rows.find(review => review.id === reviewId);
  if (!requested) return { review: null, reason: 'missing' };
  const structural = rows.filter(review => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(String(review.state ?? '').toUpperCase()));
  const requestedAt = Date.parse(requested.submitted_at);
  const others = structural.filter(review => review.id !== requested.id);
  if (others.some(review => Date.parse(review.submitted_at) === requestedAt)) {
    return { review: requested, reason: 'unordered' };
  }
  const newer = others.filter(review => Date.parse(review.submitted_at) > requestedAt)
    .sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at) || left.id - right.id)
    .at(-1) ?? null;
  if (newer) return { review: requested, reason: 'superseded', newer };
  return { review: requested, reason: 'current' };
}

export function normalizeGithubEvent(event, threads = []) {
  const name = event?.comment ? 'pull_request_review_comment' : (event?.review ? 'pull_request_review' : null);
  const pull = event?.pull_request ?? {};
  const reviewUser = event?.review?.user ?? event?.comment?.user ?? null;
  const state = String(event?.review?.state ?? (event?.comment ? 'commented' : '')).toLowerCase();
  return {
    repository: event?.repository?.full_name ?? null,
    event: { name, action: event?.action ?? null },
    sender: pickActor(event?.sender),
    pull: {
      number: pull.number ?? null,
      state: pull.state ?? null,
      draft: pull.draft === true,
      baseRef: pull.base?.ref ?? null,
      baseSha: isCommitSha(pull.base?.sha) ? pull.base.sha : null,
      headSha: pull.head?.sha ?? null,
      author: pickActor(pull.user),
      headRepo: pull.head?.repo?.full_name ?? null,
    },
    review: {
      id: event?.review?.id ?? event?.comment?.pull_request_review_id ?? null,
      state,
      commitId: event?.review?.commit_id ?? event?.comment?.commit_id ?? null,
      user: pickActor(reviewUser),
    },
    verdict: null,
    fixAuthor: null,
    threads: (Array.isArray(threads) ? threads : []).map(cleanThread),
  };
}

export async function dispatchAdmission(ledger, snapshot, operation) {
  // LIVE_EFFECTS_ENABLED stays false. The executor callback is not a planner
  // and must not run before context validation, nor in this offline PR.
  void operation;
  if (LIVE_EFFECTS_ENABLED === true) {
    return finish(structuredClone(ledger ?? emptyLedger()), snapshot, { status: 'BLOCKED_ACTIVATION' });
  }
  return step(ledger, snapshot);
}

export function step(ledger, snapshot) {
  const next = structuredClone(ledger ?? emptyLedger());
  if (!next.attempts || !next.reservations || !next.audits) return finish(emptyLedger(), snapshot ?? {}, { status: 'BLOCKED_INTEGRATION' });
  ensureAdmission(next);
  if (isUncertainSignal(snapshot)) {
    const context = validateContext(snapshot);
    if (context && context.status !== 'IGNORED_CLOSED' && context.status !== 'IGNORED_DRAFT') return finish(next, snapshot, context);
    if (!isVerifiedDispatchUncertainty(snapshot)) {
      return finish(next, snapshot, { status: 'BLOCKED_INTEGRATION', http_status: snapshot?.error?.status ?? null });
    }
    return finish(next, snapshot, markUnknown(next, snapshot));
  }
  if (snapshot?.error) {
    return finish(next, snapshot, { status: 'BLOCKED_INTEGRATION', http_status: snapshot.error.status ?? null });
  }
  const context = validateContext(snapshot);
  if (context) {
    if ((context.status === 'IGNORED_CLOSED' || context.status === 'IGNORED_DRAFT') && snapshot.pull?.number) {
      const release = releasePull(next, snapshot.pull.number);
      if (isTerminalProof(snapshot)) return finish(next, snapshot, admit(next, snapshot));
      if (release.held) {
        return finish(next, snapshot, {
          status: context.status,
          stage: { pr: snapshot.pull.number, sha: snapshot.pull.headSha, next_stage: 'reconcile', blocker: 'RECONCILE_REQUIRED' },
        });
      }
      return finish(next, snapshot, { ...context, cursor_handoff: release.cursor_handoff ?? null, admitted: release.admitted ?? null });
    }
    return finish(next, snapshot, context);
  }

  const eventName = snapshot.event?.name;
  if (ADMISSION_EVENTS.has(eventName)) return finish(next, snapshot, admit(next, snapshot));
  if (REVIEW_EVENTS.has(eventName)) return finish(next, snapshot, onReview(next, snapshot));
  if (eventName === 'head_advanced' || eventName === 'ci_completed') return finish(next, snapshot, observeCi(next, snapshot));
  return finish(next, snapshot, { status: 'IGNORED_EVENT' });
}

function onReview(ledger, snapshot) {
  if (!snapshot.review || snapshot.review.commitId !== snapshot.pull.headSha) return { status: 'IGNORED_SHA' };
  if (snapshot.review.state === 'dismissed') {
    const identity = validateCodex(snapshot);
    if (identity) return identity;
    return revokeGithubReadiness(ledger, snapshot) ?? { status: 'IGNORED_REVIEW_STATE' };
  }
  if (snapshot.review.state === 'pending' || snapshot.review.state === '') {
    return { status: 'IGNORED_REVIEW_STATE' };
  }
  if (snapshot.reviewDecision === 'unordered') return { status: 'BLOCKED_EVIDENCE' };
  if (snapshot.reviewSuperseded) return reconcileSupersededReview(ledger, snapshot);
  const findings = snapshot.review.id ? actionableFindings(snapshot) : [];
  const verdict = canonicalVerdict(snapshot.verdict ?? snapshot.review?.verdict);
  if (findings.length === 0 && isCleanPass(snapshot, verdict)) {
    const identity = validateCodex(snapshot);
    if (identity) return identity;
    return considerReady(ledger, snapshot);
  }
  const identity = validateCodex(snapshot);
  if (identity) return identity;
  if (findings.length === 0) {
    if (snapshot.reviewDecision === 'missing' && verdict !== 'FAIL' && verdict !== 'PASS_WITH_FIXES') {
      return { status: 'BLOCKED_EVIDENCE' };
    }
    if (snapshot.reviewDecision === 'found' && verdict == null && snapshot.review.state === 'commented') {
      return { status: 'BLOCKED_EVIDENCE' };
    }
    if (verdict === 'FAIL' || verdict === 'PASS_WITH_FIXES') {
      const revoked = revokeGithubReadiness(ledger, snapshot);
      if (revoked) return revoked;
    }
    return { status: 'IGNORED_NO_FINDINGS' };
  }
  const effect = revokeSharedReadiness(ledger, String(snapshot.pull.number), snapshot.pull.headSha, snapshot.pull.baseSha, snapshot.review.id, snapshot.review.submittedAt);
  if (effect === 'unordered') return { status: 'BLOCKED_EVIDENCE' };
  if (effect === 'bounded') return { status: 'STALE_REVIEW' };
  return reserveHandoff(ledger, snapshot, findings);
}

function reconcileSupersededReview(ledger, snapshot) {
  const newer = snapshot.newerDecision ?? {};
  const state = String(newer.state ?? '').toUpperCase();
  if (state === 'CHANGES_REQUESTED' || state === 'DISMISSED') {
    const effect = revokeSharedReadiness(
      ledger,
      String(snapshot.pull.number),
      snapshot.pull.headSha,
      snapshot.pull?.baseSha,
      newer.id,
      newer.submitted_at,
    );
    if (effect === 'unordered') return { status: 'BLOCKED_EVIDENCE' };
    const revoked = Object.values(ledger.reservations ?? {}).find(row => row.pr === String(snapshot.pull.number) && row.revoked_review_id === newer.id);
    if (revoked) return { status: 'READINESS_REVOKED', handoff_id: revoked.handoff_id };
  }
  return { status: 'STALE_REVIEW' };
}

function reserveHandoff(ledger, snapshot, findings) {
  const pr = String(snapshot.pull.number);
  const key = dedupKey(pr, snapshot.pull.headSha, snapshot.review.id);
  const existing = ledger.reservations[key];
  if (existing) return mergeDuplicateFindings(existing, findings, ledger.attempts[pr] ?? 0);
  const used = ledger.attempts[pr] ?? 0;
  if (used >= HANDOFF_ATTEMPT_LIMIT) {
    supersedeOpenReservations(ledger, pr);
    return { status: 'BLOCKED_LIMIT', attempt: used };
  }
  const claim = claimHandoffSlot(ledger, snapshot, findings);
  if (claim.status === 'REUSED' || claim.status === 'PENDING_FEEDBACK') {
    return pendingFeedback(ledger, snapshot, findings, used);
  }
  if (claim.status === 'WAITING_CAPACITY' || claim.status === 'DUPLICATE_DISPATCH' || claim.status === 'RECONCILE_REQUIRED') {
    if (claim.status === 'WAITING_CAPACITY') supersedeOpenReservations(ledger, pr);
    return { status: claim.status, attempt: used, cursor_handoff: null };
  }
  supersedeOpenReservations(ledger, pr);
  const handoffId = handoffIdFor(pr, snapshot.pull.headSha, snapshot.review.id);
  ledger.attempts[pr] = used + 1;
  ledger.reservations[key] = {
    handoff_id: handoffId,
    pr,
    sha: snapshot.pull.headSha,
    review_id: snapshot.review.id,
    status: 'HANDOFF_PLANNED',
    finding_refs: findings,
    successor_sha: null,
    review_requested_for: null,
    created_at: snapshot.now ?? null,
  };
  return {
    status: 'HANDOFF',
    handoff_id: handoffId,
    attempt: used + 1,
    findings,
    cursor_handoff: cursorHandoffPlan(findings),
  };
}

function observeCi(ledger, snapshot) {
  const headSha = snapshot.pull.headSha;
  const reservation = activeReservation(ledger, snapshot.pull.number);
  if (!reservation) return observeReadyCi(ledger, snapshot, headSha);
  if (reservation.sha === headSha) return { status: 'WAITING_CURSOR', handoff_id: reservation.handoff_id };
  if (reservation.successor_sha && reservation.successor_sha !== headSha) {
    reservation.status = 'BLOCKED_HEAD';
    return { status: 'BLOCKED_HEAD', handoff_id: reservation.handoff_id };
  }
  reservation.successor_sha = headSha;
  if (isCommitSha(snapshot.pull?.baseSha)) reservation.base_sha = snapshot.pull.baseSha;
  const ci = snapshot.ci;
  if (!ci || ci.sha !== headSha || ci.conclusion == null || ci.conclusion === 'pending') {
    reservation.status = 'WAITING_CI';
    return { status: 'WAITING_CI', handoff_id: reservation.handoff_id };
  }
  reservation.ci = { sha: headSha, conclusion: ci.conclusion };
  if (ci.conclusion !== 'success') {
    reservation.status = 'CI_FAILED';
    return { status: 'CI_FAILED', handoff_id: reservation.handoff_id };
  }
  if (!executorCompleted(ledger, snapshot.pull.number, headSha)) {
    reservation.status = 'WAITING_CURSOR';
    return { status: 'WAITING_CURSOR', handoff_id: reservation.handoff_id, codex_rereview: null };
  }
  const request = claimRereview(ledger, snapshot.pull.number, headSha);
  if (!request) return { status: 'DUPLICATE', handoff_id: reservation.handoff_id };
  return { status: 'REVIEW_REQUESTED', handoff_id: reservation.handoff_id, codex_rereview: request };
}

function observeReadyCi(ledger, snapshot, headSha) {
  const ready = Object.values(ledger.reservations ?? {}).find(row => String(row.pr) === String(snapshot.pull.number) && row.status === 'READY_FOR_OWNER' && row.review_requested_for != null);
  if (!ready) return { status: 'IGNORED_NO_RESERVATION' };
  const base = snapshot.pull?.baseSha;
  const issuedBase = ready.structural_review?.base_sha ?? ready.base_sha;
  const headMoved = ready.successor_sha !== headSha || ready.review_requested_for !== headSha;
  const baseMoved = Boolean(isCommitSha(base) && isCommitSha(issuedBase) && base !== issuedBase);
  const frozen = frozenReviewContract(ledger.slots?.[String(snapshot.pull.number)]);
  const controlsMoved = Boolean(ready.structural_review && frozen && !sameControl(ready.structural_review, frozen));
  const conclusion = snapshot.ci?.sha === headSha ? snapshot.ci.conclusion : null;
  if (headMoved || baseMoved || controlsMoved) {
    ready.structural_review = null;
    ready.review_requested_for = null;
    ready.successor_sha = headSha;
    if (isCommitSha(base)) ready.base_sha = base;
    ready.ci = conclusion == null ? null : { sha: headSha, conclusion };
    if (conclusion == null || conclusion === 'pending') {
      ready.status = 'WAITING_CI';
      return { status: 'WAITING_CI', handoff_id: ready.handoff_id };
    }
    if (conclusion !== 'success') {
      ready.status = 'CI_FAILED';
      return { status: 'CI_FAILED', handoff_id: ready.handoff_id };
    }
    if (!executorCompleted(ledger, snapshot.pull.number, headSha)) {
      ready.status = 'WAITING_CURSOR';
      return { status: 'WAITING_CURSOR', handoff_id: ready.handoff_id, codex_rereview: null };
    }
    const request = claimRereview(ledger, snapshot.pull.number, headSha, { controlsMoved: controlsMoved && !baseMoved && !headMoved });
    if (!request) return { status: 'BLOCKED_EVIDENCE', handoff_id: ready.handoff_id };
    return { status: 'REVIEW_REQUESTED', handoff_id: ready.handoff_id, codex_rereview: request };
  }
  if (conclusion == null) return { status: 'IGNORED_NO_RESERVATION' };
  if (conclusion === 'pending') {
    ready.ci = { sha: headSha, conclusion: 'pending' };
    ready.status = 'WAITING_REREVIEW';
    return { status: 'WAITING_CI', handoff_id: ready.handoff_id };
  }
  if (conclusion === 'success') return { status: 'IGNORED_NO_RESERVATION' };
  ready.ci = { sha: headSha, conclusion };
  ready.status = 'WAITING_REREVIEW';
  return { status: 'CI_FAILED', handoff_id: ready.handoff_id };
}

export function claimRereview(ledger, pr, headSha, options = {}) {
  const reservation = Object.values(ledger?.reservations ?? {}).find(row => String(row.pr) === String(pr) && row.successor_sha === headSha);
  if (!reservation?.ci || reservation.ci.sha !== headSha || reservation.ci.conclusion !== 'success') return null;
  if (!executorCompleted(ledger, pr, headSha)) return null;
  const nextBase = isCommitSha(reservation.base_sha) ? reservation.base_sha : null;
  const issued = reservation.structural_review;
  const issuedBase = isCommitSha(issued?.base_sha) ? issued.base_sha : null;
  const frozen = frozenReviewContract(ledger.slots?.[String(pr)]);
  const baseMoved = Boolean(nextBase && issuedBase && nextBase !== issuedBase);
  const controlsMoved = options.controlsMoved === true || Boolean(issued && frozen && !sameControl(issued, frozen));
  if (reservation.review_requested_for === headSha) {
    if (!baseMoved && !controlsMoved) return null;
    reservation.review_requested_for = null;
    reservation.structural_review = null;
  }
  if (controlsMoved && !baseMoved && frozen?.head_sha === headSha && frozen?.base_sha === nextBase) bumpReviewRound(ledger, pr);
  reservation.review_requested_for = headSha;
  reservation.status = 'WAITING_REREVIEW';
  reservation.structural_review = structuralExpectation(ledger, pr, headSha, reservation.base_sha, { controlsMoved: controlsMoved && !baseMoved });
  return {
    mechanism: 'independent_codex_review',
    sha: headSha,
    reviewer: CODEX_REVIEWER.login,
    author_approval_counts: false,
    paid_call: false,
  };
}

function frozenReviewContract(slot) {
  const frozen = slot?.review_contract;
  if (!frozen || typeof frozen !== 'object') return null;
  const fromRecord = Boolean(frozen.binding) && typeof frozen.review_request_id === 'string';
  const requestId = fromRecord ? frozen.review_request_id : frozen.request_id;
  const required = fromRecord ? requiredReviewChecks(frozen) : frozen.required_checks;
  const round = fromRecord ? frozen.binding.substantive_reviews : frozen.round;
  if (!Number.isInteger(frozen.repository_id)) return null;
  if (typeof frozen.task_id !== 'string' || frozen.task_id.trim() === '') return null;
  if (!Number.isInteger(frozen.task_revision) || frozen.task_revision < 1) return null;
  if (!Number.isInteger(round) || round < 0) return null;
  if (typeof requestId !== 'string' || requestId.trim() === '') return null;
  if (typeof frozen.contract_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(frozen.contract_hash)) return null;
  if (!isCommitSha(frozen.policy_sha) || !isCommitSha(frozen.head_sha) || !isCommitSha(frozen.base_sha)) return null;
  if (!Array.isArray(required) || required.length === 0) return null;
  if (required.some(id => typeof id !== 'string' || id.trim() === '')) return null;
  return {
    repository_id: frozen.repository_id,
    task_id: frozen.task_id,
    task_revision: frozen.task_revision,
    round,
    request_id: requestId,
    contract_hash: frozen.contract_hash,
    policy_sha: frozen.policy_sha,
    head_sha: frozen.head_sha,
    base_sha: frozen.base_sha,
    required_checks: required.map(id => String(id)),
  };
}

function sameControl(issued, frozen) {
  if (issued.policy_sha !== frozen.policy_sha || issued.contract_hash !== frozen.contract_hash) return false;
  const list = value => [...(value ?? [])].map(String).sort().join('\n');
  return list(issued.required_checks) === list(frozen.required_checks);
}

function bumpReviewRound(ledger, pr) {
  const live = ledger.slots?.[String(pr)]?.review_contract;
  if (!live?.binding || !Number.isInteger(live.binding.substantive_reviews)) return;
  live.binding.substantive_reviews += 1;
}

function structuralExpectation(ledger, pr, headSha, baseSha, options = {}) {
  const frozen = frozenReviewContract(ledger.slots?.[String(pr)]);
  const policy = loadPolicy();
  if (!frozen || !isCommitSha(headSha) || !isCommitSha(baseSha) || frozen.repository_id !== policy.repository_id) return null;
  const samePlace = frozen.head_sha === headSha && frozen.base_sha === baseSha;
  const requestId = samePlace && !options.controlsMoved
    ? frozen.request_id
    : sha256(operationKey({
      repositoryId: frozen.repository_id,
      taskId: frozen.task_id,
      taskRevision: frozen.task_revision,
      headSha,
      baseSha,
      action: 'review',
      round: frozen.round,
    }));
  return {
    request_id: requestId,
    repository_id: frozen.repository_id,
    pr: Number(pr),
    task_id: frozen.task_id,
    head_sha: headSha,
    base_sha: baseSha,
    required_checks: [...frozen.required_checks],
    contract_hash: frozen.contract_hash,
    policy_sha: frozen.policy_sha,
  };
}

function structuralPolicyReady(policy) {
  return Number.isInteger(policy?.controller_actor_id)
    && Number.isInteger(policy?.workflow_ids?.review)
    && Number.isInteger(policy?.workflow_ids?.verify);
}

function selectStructuralReservation(ledger, pr, pull) {
  const head = pull?.head?.sha ?? null;
  const base = pull?.base?.sha ?? null;
  const taskId = ledger.slots?.[String(pr)]?.review_contract?.task_id ?? null;
  const rows = Object.values(ledger.reservations ?? {}).filter(row => {
    const expected = row.structural_review;
    if (String(row.pr) !== String(pr) || !expected?.request_id) return false;
    if (row.status !== 'WAITING_REREVIEW' && row.status !== 'READY_FOR_OWNER') return false;
    if (expected.head_sha !== head || expected.base_sha !== base) return false;
    if (taskId && expected.task_id !== taskId) return false;
    return true;
  });
  return rows.find(row => row.status === 'WAITING_REREVIEW') ?? rows.find(row => row.status === 'READY_FOR_OWNER') ?? null;
}

export async function observeStructuralReview(ledger, pr, github, policy = loadPolicy()) {
  const next = structuredClone(ledger ?? emptyLedger());
  const known = Object.values(next.reservations ?? {}).some(row => String(row.pr) === String(pr) && row.structural_review?.request_id);
  if (!known) return finish(next, { pull: { number: pr } }, { status: 'BLOCKED_EVIDENCE' });
  if (!structuralPolicyReady(policy)) return finish(next, { pull: { number: pr } }, { status: 'BLOCKED_CONFIGURATION' });
  if (!github) return finish(next, { pull: { number: pr } }, { status: 'BLOCKED_INTEGRATION' });
  let pull;
  try {
    pull = await github.readPull(Number(pr));
  } catch (error) {
    return blockedRead(next, pr, error);
  }
  const reservation = selectStructuralReservation(next, pr, pull);
  const expected = reservation?.structural_review ?? null;
  if (!reservation || !expected?.request_id || !isCommitSha(expected.policy_sha)) {
    return finish(next, { pull: { number: pr } }, { status: 'BLOCKED_EVIDENCE' });
  }
  if (pull?.state !== 'open' || pull?.draft === true || pull?.base?.ref !== INTEGRATION_BRANCH) {
    return finish(next, { pull: { number: pr } }, { status: 'BLOCKED_EVIDENCE' });
  }
  if (pull?.head?.repo?.full_name !== REPOSITORY || pull?.base?.repo?.full_name !== REPOSITORY) {
    return finish(next, { pull: { number: pr } }, { status: 'BLOCKED_EVIDENCE' });
  }
  let author;
  let run;
  let envelope;
  try {
    author = await github.readCommit(expected.head_sha);
    run = await findRun(github, policy, 'review', expected.request_id, null);
    if (!run || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== expected.policy_sha) {
      return unfinishedRead(next, pr, reservation);
    }
    if (!run.updated_at || reviewInstant(run.updated_at) == null) {
      return unfinishedRead(next, pr, reservation);
    }
    envelope = await artifactFromRun(github, run, 'sc-agent-review');
  } catch (error) {
    return blockedRead(next, pr, error);
  }
  if (!author || author.sha !== expected.head_sha || !isActor(author.author)) {
    return unfinishedRead(next, pr, reservation);
  }
  if (!envelope || envelope.run_id !== run.id || envelope.run_attempt !== run.run_attempt || envelope.policy_sha !== run.head_sha
      || envelope.policy_sha !== expected.policy_sha || envelope.workflow_id !== run.workflow_id || envelope.workflow_path !== run.path) {
    return unfinishedRead(next, pr, reservation);
  }
  const validated = validateReview(envelope, {
    workflowId: policy.workflow_ids.review,
    workflowPath: policy.workflows.review,
    runId: run.id,
    runAttempt: 1,
    policySha: expected.policy_sha,
    requestId: expected.request_id,
    repositoryId: expected.repository_id,
    prNumber: expected.pr,
    headSha: expected.head_sha,
    baseSha: expected.base_sha,
    contractHash: expected.contract_hash,
    requiredChecks: expected.required_checks,
  });
  if (!validated.ok) return unfinishedRead(next, pr, reservation);
  const findings = structuralFindings(validated.payload.findings, expected);
  if (findings.some(item => !structuralFindingShape(item))) {
    return unfinishedRead(next, pr, reservation);
  }
  const active = findings.filter(item => item.severity !== 'info');
  if (validated.payload.verdict !== 'PASS' || active.length > 0) {
    const snapshot = structuralSnapshot({ pull, expected, run, author: author.author, policy, ciConclusion: null });
    const effect = revokeSharedReadiness(next, String(pr), expected.head_sha, expected.base_sha, run.id, run.updated_at);
    if (effect === 'unordered') {
      suspendReady(reservation, expected.head_sha, null);
      return finish(next, snapshot, { status: 'BLOCKED_EVIDENCE', handoff_id: reservation.handoff_id });
    }
    if (effect === 'bounded') return finish(next, snapshot, { status: 'STALE_REVIEW', handoff_id: reservation.handoff_id });
    if (active.length === 0) {
      const revoked = Object.values(next.reservations ?? {}).some(row => row.revoked_review_id === run.id && row.status === 'READINESS_REVOKED');
      return finish(next, snapshot, { status: revoked ? 'READINESS_REVOKED' : 'BLOCKED_EVIDENCE', handoff_id: reservation.handoff_id });
    }
    return finish(next, snapshot, reserveHandoff(next, snapshot, active));
  }
  let verified;
  try {
    verified = await readStructuralCi(github, policy, expected);
  } catch (error) {
    return blockedRead(next, pr, error);
  }
  if (verified.status !== 'success') {
    if (verified.conclusion && verified.conclusion !== 'success' && verified.conclusion !== 'pending') {
      reservation.ci = { sha: expected.head_sha, conclusion: verified.conclusion };
    }
    suspendReady(reservation, expected.head_sha, verified.conclusion);
    const snapshot = structuralSnapshot({ pull, expected, run, author: author.author, policy, ciConclusion: verified.conclusion ?? 'failure' });
    return finish(next, snapshot, { status: verified.status, handoff_id: reservation.handoff_id });
  }
  const pair = validatePair(structuralRecord(expected, run, verified.run), { ci: verified.ci, review: envelope }, policy);
  if (!pair.ci?.pass || !pair.review?.pass) {
    suspendReady(reservation, expected.head_sha, null);
    return finish(next, { pull: { number: pr } }, { status: 'BLOCKED_EVIDENCE', handoff_id: reservation.handoff_id });
  }
  reservation.ci = { sha: expected.head_sha, conclusion: 'success' };
  const snapshot = structuralSnapshot({ pull, expected, run, author: author.author, policy, ciConclusion: 'success' });
  const slot = next.slots?.[String(pr)];
  if ((slot?.depends_on ?? []).some(id => !next.completed_tasks?.[id])) {
    return finish(next, snapshot, { status: 'WAITING_DEPENDENCY', handoff_id: reservation.handoff_id });
  }
  const ready = considerReady(next, snapshot, { structural: true, controllerActorId: policy.controller_actor_id });
  return finish(next, snapshot, ready);
}

function suspendReady(reservation, headSha, conclusion) {
  if (!reservation || reservation.status !== 'READY_FOR_OWNER') return;
  reservation.status = 'WAITING_REREVIEW';
  reservation.ci = { sha: headSha, conclusion: conclusion && conclusion !== 'success' && conclusion !== 'pending' ? conclusion : 'pending' };
}

function structuralRecord(expected, reviewRun, ciRun) {
  return {
    policy_sha: expected.policy_sha,
    head_sha: expected.head_sha,
    base_sha: expected.base_sha,
    review_request_id: expected.request_id,
    review_run_id: reviewRun.id,
    ci_run_id: ciRun.id,
    repository_id: expected.repository_id,
    pr_number: expected.pr,
    contract_hash: expected.contract_hash,
    binding: {
      required_tests: [],
      contract: { acceptance_criteria: [...expected.required_checks], security_checks: [] },
    },
  };
}

async function readStructuralCi(github, policy, expected) {
  const run = await findRun(github, policy, 'verify', expected.request_id, null);
  if (!run || run.run_attempt !== 1 || run.status !== 'completed' || run.head_sha !== expected.policy_sha) {
    return { status: 'BLOCKED_EVIDENCE' };
  }
  const body = await artifactFromRun(github, run, 'sc-agent-ci');
  if (!body || body.run_id !== run.id || body.run_attempt !== run.run_attempt || body.policy_sha !== run.head_sha
      || body.workflow_id !== run.workflow_id || body.workflow_path !== run.path
      || body.head_sha !== expected.head_sha || body.base_sha !== expected.base_sha) {
    return { status: 'BLOCKED_EVIDENCE' };
  }
  const jobs = await github.readJobs(run.id);
  const ci = validateCi({
    ...body,
    conclusion: run.conclusion,
    jobs: (jobs ?? []).map(job => ({ name: job.name, conclusion: job.conclusion })),
  }, {
    workflowId: policy.workflow_ids.verify,
    workflowPath: policy.workflows.verify,
    policySha: expected.policy_sha,
    headSha: expected.head_sha,
    baseSha: expected.base_sha,
    requiredCommands: policy.required_ci_commands,
    runAttempt: 1,
    runId: run.id,
  });
  const evidence = {
    ...body,
    conclusion: run.conclusion,
    jobs: (jobs ?? []).map(job => ({ name: job.name, conclusion: job.conclusion })),
  };
  if (ci.ok) return { status: 'success', conclusion: 'success', ci: evidence, run };
  if (String(ci.reason).startsWith('conclusion_') || ci.reason === 'job_not_success') {
    return { status: 'CI_FAILED', conclusion: run.conclusion };
  }
  return { status: 'BLOCKED_EVIDENCE' };
}

function structuralFindingShape(item) {
  if (!item?.comment_id || typeof item.comment_id !== 'string') return false;
  if (item.path != null && (!SAFE_PATH.test(item.path) || item.path.split('/').includes('..') || item.path.startsWith('/'))) return false;
  if (item.line != null && (!Number.isInteger(item.line) || item.line < 1)) return false;
  if (item.severity !== 'info' && (typeof item.required_fix !== 'string' || item.required_fix.trim() === '')) return false;
  return true;
}

function structuralFindings(findings, expected) {
  return (findings ?? []).map(finding => {
    const fix = typeof finding.required_fix === 'string' ? finding.required_fix.trim() : '';
    const description = typeof finding.description === 'string' ? finding.description.trim() : '';
    return {
      thread_id: finding.id,
      comment_id: finding.id,
      path: finding.path,
      line: finding.line,
      severity: STRUCTURAL_SEVERITY[finding.severity] ?? 'info',
      required_fix: fix || description,
      description: description || null,
      head_sha: expected.head_sha,
    };
  });
}

function structuralSnapshot({ pull, expected, run, author, policy, ciConclusion }) {
  return {
    repository: REPOSITORY,
    pull: {
      number: expected.pr,
      state: 'open',
      draft: false,
      baseRef: INTEGRATION_BRANCH,
      baseSha: expected.base_sha,
      headSha: expected.head_sha,
      author: pickActor(pull.user),
      headRepo: REPOSITORY,
    },
    review: {
      id: run.id,
      state: 'approved',
      commitId: expected.head_sha,
      user: { id: policy.controller_actor_id, login: run.actor?.login ?? 'github-actions[bot]', type: 'Bot' },
      submittedAt: run.updated_at,
    },
    sender: { id: policy.controller_actor_id, login: run.actor?.login ?? 'github-actions[bot]', type: 'Bot' },
    fixAuthor: pickActor(author),
    ci: { sha: expected.head_sha, conclusion: ciConclusion },
    threads: [],
    verdict: null,
  };
}

function unfinishedRead(ledger, pr, reservation) {
  suspendReady(reservation, reservation?.structural_review?.head_sha ?? reservation?.successor_sha, null);
  return finish(ledger, { pull: { number: pr } }, { status: 'BLOCKED_EVIDENCE', handoff_id: reservation?.handoff_id ?? null });
}

function blockedRead(ledger, pr, error) {
  for (const row of Object.values(ledger.reservations ?? {})) {
    if (String(row.pr) === String(pr)) suspendReady(row, row.structural_review?.head_sha ?? row.successor_sha, null);
  }
  const status = error?.status ?? error?.statusCode ?? null;
  if (status === 401 || status === 403 || error?.code === 'BLOCKED_CONFIGURATION' || status == null) {
    return finish(ledger, { pull: { number: pr } }, { status: 'BLOCKED_INTEGRATION', http_status: status });
  }
  return finish(ledger, { pull: { number: pr } }, { status: 'BLOCKED_EVIDENCE', http_status: status });
}

function executorCompleted(ledger, pr, headSha) {
  const slot = ledger?.slots?.[String(pr)];
  return Boolean(slot && slot.occupied === false && slot.phase === 'COMPLETED' && slot.completed_head_sha === headSha);
}

function considerReady(ledger, snapshot, options = {}) {
  const head = snapshot.pull.headSha;
  const pr = String(snapshot.pull.number);
  const open = activeReservation(ledger, pr);
  const held = Object.values(ledger.reservations ?? {}).find(row => row.pr === pr && row.successor_sha === head && (row.status === 'READY_FOR_OWNER' || row.status === 'READINESS_REVOKED'));
  const waiting = open && open.successor_sha === head && (open.status === 'WAITING_REREVIEW' || open.status === 'WAITING_CURSOR');
  const reservation = waiting ? open : held;
  if (!reservation) return { status: 'IGNORED_APPROVAL' };
  if (reservation.review_requested_for !== head) return { status: 'IGNORED_UNREQUESTED_APPROVAL', handoff_id: reservation.handoff_id };
  if (isCommitSha(snapshot.pull?.baseSha) && identityRevoked(ledger, pr, head, snapshot.pull.baseSha, snapshot.review.id, snapshot.review?.submittedAt)) {
    return { status: 'STALE_REVIEW', handoff_id: reservation.handoff_id };
  }
  const ci = snapshot.ci ?? reservation.ci ?? null;
  if (!ci || ci.sha !== head || ci.conclusion !== 'success') return { status: 'WAITING_CI', handoff_id: reservation.handoff_id };
  const reviewer = snapshot.review.user;
  if (sameActor(reviewer, snapshot.pull.author) || (isActor(snapshot.fixAuthor) && sameActor(reviewer, snapshot.fixAuthor))) {
    return { status: 'REJECTED_SELF_APPROVAL', handoff_id: reservation.handoff_id };
  }
  if (options.structural === true) {
    if (isCodex(snapshot.fixAuthor)) return { status: 'REJECTED_SELF_APPROVAL', handoff_id: reservation.handoff_id };
    if (reviewer?.id !== options.controllerActorId) return { status: 'BLOCKED_EVIDENCE', handoff_id: reservation.handoff_id };
  } else if (!isCodex(reviewer)) return { status: 'IGNORED_REVIEWER', handoff_id: reservation.handoff_id };
  if (!isActor(snapshot.fixAuthor) || !isCommitSha(snapshot.pull?.baseSha)) {
    return { status: 'BLOCKED_EVIDENCE', handoff_id: reservation.handoff_id };
  }
  const slot = ledger.slots?.[pr];
  if (!slot || slot.occupied !== false || slot.phase !== 'COMPLETED' || slot.completed_head_sha !== head) {
    return { status: 'BLOCKED_NO_COMMIT', handoff_id: reservation.handoff_id };
  }
  const noted = notePassIdentity(ledger, pr, head, snapshot.pull.baseSha, snapshot.review.id, snapshot.review?.submittedAt);
  if (noted === 'unordered') return { status: 'BLOCKED_EVIDENCE', handoff_id: reservation.handoff_id };
  if (noted === 'stale') return { status: 'STALE_REVIEW', handoff_id: reservation.handoff_id };
  if (reservation.status === 'READY_FOR_OWNER') {
    return { status: 'REVIEW_REUSED', handoff_id: reservation.handoff_id };
  }
  reservation.status = 'READY_FOR_OWNER';
  reservation.ready_review_id = snapshot.review.id;
  reservation.ready_at = reviewInstant(snapshot.review?.submittedAt);
  return { status: 'READY_FOR_OWNER', handoff_id: reservation.handoff_id };
}

function revokeGithubReadiness(ledger, snapshot) {
  const pr = String(snapshot.pull.number);
  const head = snapshot.pull.headSha;
  const ready = Object.values(ledger.reservations ?? {}).find(row => row.pr === pr && row.status === 'READY_FOR_OWNER' && row.successor_sha === head);
  const effect = revokeSharedReadiness(ledger, pr, head, snapshot.pull?.baseSha, snapshot.review.id, snapshot.review?.submittedAt);
  if (effect === 'unordered') return { status: 'BLOCKED_EVIDENCE', handoff_id: ready?.handoff_id ?? null };
  if (effect === 'bounded' && !ready) return null;
  if (effect === 'bounded') return { status: 'STALE_REVIEW', handoff_id: ready.handoff_id };
  if (!ready) return null;
  return { status: 'READINESS_REVOKED', handoff_id: ready.handoff_id };
}

function pendingFeedback(ledger, snapshot, findings, attempt) {
  const pr = String(snapshot.pull.number);
  const slot = ledger.slots[pr];
  if (slot?.occupied) {
    const reserved = Object.values(ledger.reservations ?? {})
      .filter(row => row.pr === pr)
      .flatMap(row => row.finding_refs ?? []);
    const known = new Set([...(slot.pending_feedback ?? []), ...reserved].map(item => item.comment_id));
    const added = findings.filter(item => !known.has(item.comment_id));
    slot.pending_feedback = [...(slot.pending_feedback ?? []), ...added];
    slot.feedback_reviews ??= [];
    const seen = slot.feedback_reviews.includes(snapshot.review.id);
    if (!seen) slot.feedback_reviews.push(snapshot.review.id);
    const status = added.length > 0 || !seen ? 'PENDING_FEEDBACK' : 'DUPLICATE';
    return {
      status,
      attempt,
      agent_id: slot.agent_id,
      findings: slot.pending_feedback,
      cursor_handoff: null,
      pending_feedback: feedbackNote(slot, snapshot, slot.pending_feedback),
    };
  }
  const queued = ledger.queue.find(item => item.pr === pr);
  return {
    status: 'PENDING_FEEDBACK',
    attempt,
    findings: queued?.findings ?? findings,
    cursor_handoff: null,
    pending_feedback: feedbackNote(queued, snapshot, queued?.findings ?? findings),
  };
}

function feedbackNote(target, snapshot, findingRefs) {
  return {
    agent_id: target?.agent_id ?? null,
    pr: String(snapshot.pull.number),
    task_id: target?.task_id ?? null,
    review_id: snapshot.review.id,
    finding_refs: findingRefs,
    update: true,
  };
}

function isTerminalProof(snapshot) {
  const adapter = snapshot?.adapter;
  return adapter?.source === 'trusted_adapter' && (adapter.kind === 'cancelled' || adapter.kind === 'completed');
}

function isUncertainSignal(snapshot) {
  if (snapshot?.error?.timeout === true || snapshot?.transport?.outcome === 'unknown') return true;
  return snapshot?.adapter?.source === 'trusted_adapter' && snapshot?.adapter?.kind === 'dispatch_unknown';
}

function isVerifiedDispatchUncertainty(snapshot) {
  if (!isUncertainSignal(snapshot)) return false;
  const adapter = snapshot?.adapter;
  if (adapter?.source !== 'trusted_adapter') return false;
  if (!['dispatch_unknown', 'dispatch_request', 'started'].includes(adapter.kind)) return false;
  return adapter.pr != null && adapter.task_id != null && adapter.agent_id != null;
}

function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function isActor(actor) {
  return Boolean(actor && actor.id != null && typeof actor.login === 'string' && actor.login.length > 0);
}

function validateContext(snapshot) {
  if (!snapshot?.pull || snapshot.repository !== REPOSITORY) return { status: 'BLOCKED_INTEGRATION' };
  if (!snapshot.pull.headRepo || snapshot.pull.headRepo !== REPOSITORY) return { status: 'IGNORED_FORK' };
  if (snapshot.pull.baseRef !== INTEGRATION_BRANCH) return { status: 'IGNORED_BASE' };
  if (snapshot.pull.state !== 'open') return { status: 'IGNORED_CLOSED' };
  if (snapshot.pull.draft === true) return { status: 'IGNORED_DRAFT' };
  if (!snapshot.pull.number || !snapshot.pull.headSha) return { status: 'BLOCKED_INTEGRATION' };
  return null;
}

function validateCodex(snapshot) {
  if (!isCodex(snapshot.sender) || !isCodex(snapshot.review?.user)) return { status: 'IGNORED_REVIEWER' };
  if (!snapshot.review?.id) return { status: 'BLOCKED_INTEGRATION' };
  return null;
}

function actionableFindings(snapshot) {
  const reviewId = snapshot.review.id;
  const head = snapshot.pull.headSha;
  const findings = [];
  for (const thread of snapshot.threads ?? []) {
    if (!thread || thread.isResolved === true || thread.isOutdated === true) continue;
    const root = (thread.comments ?? []).find(comment => comment && (comment.inReplyToId == null));
    if (!root || root.reviewId !== reviewId || root.commitId !== head) continue;
    if (!Number.isInteger(root.id)) continue;
    if (root.path != null && (!SAFE_PATH.test(root.path) || root.path.split('/').includes('..') || root.path.startsWith('/'))) continue;
    if (root.line != null && (!Number.isInteger(root.line) || root.line < 1)) continue;
    findings.push({
      thread_id: thread.id,
      comment_id: root.id,
      path: root.path ?? null,
      line: root.line ?? null,
      url: `https://github.com/${REPOSITORY}/pull/${snapshot.pull.number}#discussion_r${root.id}`,
    });
  }
  return findings;
}

function mergeDuplicateFindings(existing, findings, attempt) {
  const known = new Set((existing.finding_refs ?? []).map(finding => finding.comment_id));
  const added = findings.filter(finding => !known.has(finding.comment_id));
  if (existing.status !== 'HANDOFF_PLANNED' || added.length === 0) {
    return { status: 'DUPLICATE', handoff_id: existing.handoff_id, attempt, findings: existing.finding_refs };
  }
  existing.finding_refs = [...existing.finding_refs, ...added];
  return {
    status: 'HANDOFF_UPDATED',
    handoff_id: existing.handoff_id,
    attempt,
    findings: existing.finding_refs,
    cursor_handoff: cursorHandoffPlan(existing.finding_refs),
  };
}

function supersedeOpenReservations(ledger, pr) {
  for (const row of Object.values(ledger.reservations)) {
    if (row.pr === pr && OPEN_STATUSES.has(row.status)) row.status = 'SUPERSEDED';
  }
}

function isCleanPass(snapshot, verdict) {
  if (verdict === 'PASS_WITH_FIXES' || verdict === 'FAIL') return false;
  if (verdict === 'PASS') return true;
  return snapshot.review.state === 'approved';
}

function canonicalVerdict(value) {
  const text = String(value ?? '').trim().toUpperCase().replaceAll(' ', '_');
  if (text === 'PASS' || text === 'PASS_WITH_FIXES' || text === 'FAIL') return text;
  return null;
}

function activeReservation(ledger, pr) {
  const rows = Object.values(ledger.reservations)
    .filter(row => row.pr === String(pr) && OPEN_STATUSES.has(row.status));
  rows.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  return rows.at(-1) ?? null;
}

function isCodex(actor) {
  return Boolean(actor)
    && actor.id === CODEX_REVIEWER.id
    && actor.login === CODEX_REVIEWER.login
    && actor.type === CODEX_REVIEWER.type;
}

function sameActor(left, right) {
  if (!left || !right) return false;
  if (left.id != null && right.id != null && left.id === right.id) return true;
  return Boolean(left.login) && left.login === right.login;
}

function pickActor(actor) {
  if (!actor) return null;
  return { id: actor.id ?? null, login: actor.login ?? null, type: actor.type ?? null };
}

function cleanThread(thread) {
  return {
    id: thread?.id ?? null,
    isResolved: thread?.isResolved === true,
    isOutdated: thread?.isOutdated === true,
    comments: (thread?.comments ?? []).map(comment => ({
      id: comment?.id ?? null,
      commitId: comment?.commit_id ?? comment?.commitId ?? null,
      reviewId: comment?.pull_request_review_id ?? comment?.reviewId ?? null,
      inReplyToId: comment?.in_reply_to_id ?? comment?.inReplyToId ?? null,
      path: comment?.path ?? null,
      line: comment?.line ?? null,
    })),
  };
}

function finish(ledger, snapshot, partial) {
  const outcome = {
    status: partial.status,
    handoff_id: partial.handoff_id ?? null,
    attempt: partial.attempt ?? null,
    findings: partial.findings ?? [],
    http_status: partial.http_status ?? null,
    plan: {
      cursor_handoff: partial.cursor_handoff ?? null,
      codex_rereview: partial.codex_rereview ?? null,
      admitted: partial.admitted ?? null,
      merge: null,
      deploy: null,
      paid_calls: false,
      owner_acceptance: false,
      production_approval: false,
    },
    executed: [],
    live_effects: 'blocked',
    merge_authorized: false,
    pending_feedback: partial.pending_feedback ?? null,
    agent_id: partial.agent_id ?? partial.stage?.agent_id ?? null,
    stage: partial.stage ?? null,
  };
  const entry = {
    status: outcome.status,
    pr: partial.stage?.pr ?? snapshot?.pull?.number ?? null,
    sha: partial.stage ? partial.stage.sha ?? null : snapshot?.pull?.headSha ?? null,
    review_id: snapshot?.review?.id ?? null,
    comment_ids: outcome.findings.map(finding => finding.comment_id),
    ci: snapshot?.ci ? { sha: snapshot.ci.sha, conclusion: snapshot.ci.conclusion } : null,
    handoff_id: outcome.handoff_id,
    http_status: outcome.http_status,
    executor: partial.stage?.executor ?? null,
    task: partial.stage?.task ?? null,
    tests: partial.stage?.tests ?? null,
    review: partial.stage?.review ?? null,
    next_stage: partial.stage?.next_stage ?? null,
    blocker: partial.stage?.blocker ?? null,
    agent_id: outcome.agent_id,
  };
  const key = sha256(entry);
  if (!ledger.audits.some(row => row.key === key)) {
    ledger.audits.push({ key, at: snapshot?.now ?? null, ...entry });
  }
  return { ledger, outcome };
}
