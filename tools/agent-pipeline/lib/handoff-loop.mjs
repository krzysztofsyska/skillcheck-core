import { sha256 } from './canonical.mjs';

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

const OPEN_STATUSES = new Set(['HANDOFF_PLANNED', 'WAITING_CI', 'CI_FAILED', 'WAITING_REREVIEW']);
const REVIEW_EVENTS = new Set(['pull_request_review', 'pull_request_review_comment']);
const SAFE_PATH = /^[A-Za-z0-9_./@+-]+$/;

export function emptyLedger() {
  return { schema_version: 1, attempts: {}, reservations: {}, audits: [] };
}

export function dedupKey(pr, sha, reviewId) {
  return `${pr}:${sha}:${reviewId}`;
}

export function handoffIdFor(pr, sha, reviewId) {
  return `ho-${sha256(`${pr}\n${sha}\n${reviewId}`).slice(0, 24)}`;
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
    verdict: canonicalVerdict(event?.verdict ?? event?.review?.verdict),
    threads: (Array.isArray(threads) ? threads : []).map(cleanThread),
  };
}

export function step(ledger, snapshot) {
  const next = structuredClone(ledger ?? emptyLedger());
  if (!next.attempts || !next.reservations || !next.audits) return finish(emptyLedger(), snapshot ?? {}, { status: 'BLOCKED_INTEGRATION' });
  if (snapshot?.error) {
    return finish(next, snapshot, { status: 'BLOCKED_INTEGRATION', http_status: snapshot.error.status ?? null });
  }
  const context = validateContext(snapshot);
  if (context) return finish(next, snapshot, context);

  const eventName = snapshot.event?.name;
  if (REVIEW_EVENTS.has(eventName)) return finish(next, snapshot, onReview(next, snapshot));
  if (eventName === 'head_advanced' || eventName === 'ci_completed') return finish(next, snapshot, observeCi(next, snapshot));
  return finish(next, snapshot, { status: 'IGNORED_EVENT' });
}

function onReview(ledger, snapshot) {
  if (!snapshot.review || snapshot.review.commitId !== snapshot.pull.headSha) return { status: 'IGNORED_SHA' };
  if (snapshot.review.state === 'dismissed' || snapshot.review.state === 'pending' || snapshot.review.state === '') {
    return { status: 'IGNORED_REVIEW_STATE' };
  }
  const findings = snapshot.review.id ? actionableFindings(snapshot) : [];
  const verdict = canonicalVerdict(snapshot.verdict ?? snapshot.review?.verdict);
  if (findings.length === 0 && isCleanPass(snapshot, verdict)) return considerReady(ledger, snapshot);
  const identity = validateCodex(snapshot);
  if (identity) return identity;
  if (findings.length === 0) return { status: 'IGNORED_NO_FINDINGS' };
  return reserveHandoff(ledger, snapshot, findings);
}

function reserveHandoff(ledger, snapshot, findings) {
  const pr = String(snapshot.pull.number);
  const key = dedupKey(pr, snapshot.pull.headSha, snapshot.review.id);
  const existing = ledger.reservations[key];
  if (existing) return { status: 'DUPLICATE', handoff_id: existing.handoff_id, attempt: ledger.attempts[pr] ?? 0, findings: existing.finding_refs };
  const used = ledger.attempts[pr] ?? 0;
  if (used >= HANDOFF_ATTEMPT_LIMIT) return { status: 'BLOCKED_LIMIT', attempt: used };
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
    cursor_handoff: {
      mechanism: 'github_comment_at_cursor',
      existing_pr: true,
      template: CURSOR_HANDOFF_TEMPLATE,
      finding_refs: findings,
    },
  };
}

function observeCi(ledger, snapshot) {
  const reservation = activeReservation(ledger, snapshot.pull.number);
  if (!reservation) return { status: 'IGNORED_NO_RESERVATION' };
  const headSha = snapshot.pull.headSha;
  if (reservation.sha === headSha) return { status: 'WAITING_CURSOR', handoff_id: reservation.handoff_id };
  if (reservation.successor_sha && reservation.successor_sha !== headSha) {
    reservation.status = 'BLOCKED_HEAD';
    return { status: 'BLOCKED_HEAD', handoff_id: reservation.handoff_id };
  }
  reservation.successor_sha = headSha;
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
  if (reservation.review_requested_for === headSha) {
    reservation.status = 'WAITING_REREVIEW';
    return { status: 'DUPLICATE', handoff_id: reservation.handoff_id };
  }
  reservation.review_requested_for = headSha;
  reservation.status = 'WAITING_REREVIEW';
  return {
    status: 'REVIEW_REQUESTED',
    handoff_id: reservation.handoff_id,
    codex_rereview: {
      mechanism: 'independent_codex_review',
      sha: headSha,
      reviewer: CODEX_REVIEWER.login,
      author_approval_counts: false,
      paid_call: false,
    },
  };
}

function considerReady(ledger, snapshot) {
  const reservation = activeReservation(ledger, snapshot.pull.number);
  if (!reservation || reservation.status !== 'WAITING_REREVIEW' || reservation.successor_sha !== snapshot.pull.headSha) {
    return { status: 'IGNORED_APPROVAL' };
  }
  if (reservation.review_requested_for !== snapshot.pull.headSha) return { status: 'IGNORED_UNREQUESTED_APPROVAL' };
  const ci = snapshot.ci ?? reservation.ci ?? null;
  if (!ci || ci.sha !== snapshot.pull.headSha || ci.conclusion !== 'success') return { status: 'WAITING_CI', handoff_id: reservation.handoff_id };
  const reviewer = snapshot.review.user;
  if (sameActor(reviewer, snapshot.pull.author) || sameActor(reviewer, snapshot.fixAuthor)) {
    return { status: 'REJECTED_SELF_APPROVAL', handoff_id: reservation.handoff_id };
  }
  if (!isCodex(reviewer)) return { status: 'IGNORED_REVIEWER', handoff_id: reservation.handoff_id };
  reservation.status = 'READY_FOR_OWNER';
  return { status: 'READY_FOR_OWNER', handoff_id: reservation.handoff_id };
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
      merge: null,
      deploy: null,
      paid_calls: false,
      owner_acceptance: false,
      production_approval: false,
    },
    executed: [],
    live_effects: 'blocked',
  };
  const entry = {
    status: outcome.status,
    pr: snapshot?.pull?.number ?? null,
    sha: snapshot?.pull?.headSha ?? null,
    review_id: snapshot?.review?.id ?? null,
    comment_ids: outcome.findings.map(finding => finding.comment_id),
    ci: snapshot?.ci ? { sha: snapshot.ci.sha, conclusion: snapshot.ci.conclusion } : null,
    handoff_id: outcome.handoff_id,
    http_status: outcome.http_status,
  };
  const key = sha256(entry);
  if (!ledger.audits.some(row => row.key === key)) {
    ledger.audits.push({ key, at: snapshot?.now ?? null, ...entry });
  }
  return { ledger, outcome };
}
