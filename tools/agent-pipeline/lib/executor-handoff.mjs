// SC-436 item 3: hand a task over to the other subscription executor after a
// usage-limit or unavailability signal, and resume it without duplicating
// branches, PRs or commits.
//
// Pure functions only. Nothing here dispatches a workflow, calls a model,
// writes to GitHub or reads a secret. The caller persists the returned record
// (journal / #367 comment) and the controller decides later, under its own
// gates, whether anything is started. All three pipeline flags stay false.
//
// Rules:
// - Only the two subscription executors exist: Claude Code <-> ChatGPT/Codex.
//   Any other target (an API-key provider, Cursor, "auto") is refused: there
//   is no paid fallback and no fallback by guess.
// - A handoff is triggered by an explicit signal code, never by a forecast of
//   the remaining balance (there is no reliable token counter).
// - The handoff carries the exact base/head SHA, branch and PR, so the new
//   executor continues the same branch and PR instead of opening new ones.
// - The idempotency key binds task + head SHA + target; a repeated signal on
//   the same head is a duplicate, not a second handoff.
// - Independent review: the reviewer session must differ from every builder
//   session that pushed to the branch, the old one included.

const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;
const SESSION = /^[A-Za-z0-9._:\/-]{1,200}$/;
const TASK = /^[A-Za-z0-9#._:-]{1,120}$/;

export const SUBSCRIPTION_EXECUTORS = Object.freeze(['claude-code', 'codex']);

export const HANDOFF_SIGNALS = Object.freeze({
  USAGE_LIMIT: 'USAGE_LIMIT',
  OAUTH_EXPIRED: 'OAUTH_EXPIRED',
  EXECUTOR_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
});

const SIGNALS = new Set(Object.values(HANDOFF_SIGNALS));

const reject = reason => ({ ok: false, reason });

export function otherExecutor(executor) {
  if (!SUBSCRIPTION_EXECUTORS.includes(executor)) return null;
  return SUBSCRIPTION_EXECUTORS.find(candidate => candidate !== executor);
}

export function handoffKey({ task, headSha, to }) {
  return `handoff:${task}:${headSha}:${to}`;
}

// Classify a structured executor result. Free text is never parsed: a
// signal must arrive as one of the known codes, anything else is not a
// handoff trigger (the task stays with its builder and the caller reports it).
export function classifyExecutorSignal(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.status === 'success') return null;
  return SIGNALS.has(result.signal) ? result.signal : null;
}

export function planHandoff({ task, signal, from, to, availability, base, head, branch, pr, builderSessions, previous } = {}) {
  if (!TASK.test(task ?? '')) return reject('HANDOFF_TASK_INVALID');
  if (!SIGNALS.has(signal)) return reject('HANDOFF_SIGNAL_UNRECOGNIZED');
  if (!SUBSCRIPTION_EXECUTORS.includes(from)) return reject('HANDOFF_FROM_NOT_SUBSCRIPTION_EXECUTOR');
  const target = to ?? otherExecutor(from);
  // No paid API, no Cursor, no self-handoff.
  if (!SUBSCRIPTION_EXECUTORS.includes(target)) return reject('HANDOFF_TARGET_NOT_SUBSCRIPTION_EXECUTOR');
  if (target === from) return reject('HANDOFF_TARGET_IS_SOURCE');
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) return reject('HANDOFF_SHA_INVALID');
  if (!BRANCH.test(branch ?? '') || branch === 'main' || branch === 'integration') return reject('HANDOFF_BRANCH_INVALID');
  if (pr !== null && pr !== undefined && (!Number.isSafeInteger(pr) || pr <= 0)) return reject('HANDOFF_PR_INVALID');
  if (!Array.isArray(builderSessions) || builderSessions.length === 0
      || !builderSessions.every(session => SESSION.test(session ?? ''))) {
    return reject('HANDOFF_BUILDER_SESSIONS_UNKNOWN');
  }
  // Availability is an observation of the target only. Unknown counts as
  // unavailable: the task is parked, not handed to an executor nobody checked.
  if (availability?.[target] !== true) {
    return {
      ok: false,
      reason: 'HANDOFF_NO_EXECUTOR_AVAILABLE',
      parked: { task, from, signal, base, head, branch, pr: pr ?? null, next_action: 'WAIT_FOR_EXECUTOR' },
    };
  }

  const key = handoffKey({ task, headSha: head, to: target });
  if (Array.isArray(previous)) {
    const same = previous.filter(entry => entry?.key === key);
    if (same.length > 0) return { ok: true, duplicate: true, handoff: same[same.length - 1] };
    // A handoff of the same task to another head is fine (new work happened),
    // but two open handoffs of one task to different executors are not.
    const open = previous.filter(entry => entry?.task === task && entry?.state === 'OPEN');
    if (open.some(entry => entry.to !== target)) return reject('HANDOFF_CONFLICTING_OPEN_HANDOFF');
  } else if (previous !== undefined) {
    return reject('HANDOFF_HISTORY_INVALID');
  }

  return {
    ok: true,
    duplicate: false,
    handoff: Object.freeze({
      key,
      task,
      state: 'OPEN',
      signal,
      from,
      to: target,
      base_sha: base,
      head_sha: head,
      branch,
      pr: pr ?? null,
      // Resume on the same branch/PR; open a Draft PR only if none exists.
      next_action: pr ? 'RESUME_EXISTING_PR' : 'RESUME_BRANCH_OPEN_DRAFT_PR',
      reviewer_excluded_sessions: Object.freeze([...new Set(builderSessions)]),
      paid_api_fallback: false,
    }),
  };
}

// The new executor may only continue if the branch still points at the
// handed-over head. A head that moved means someone else pushed after the
// handoff was recorded: stop instead of overwriting or duplicating work.
export function verifyResume(handoff, { executor, currentHead } = {}) {
  if (!handoff || handoff.state !== 'OPEN') return reject('RESUME_HANDOFF_NOT_OPEN');
  if (executor !== handoff.to) return reject('RESUME_WRONG_EXECUTOR');
  if (!SHA.test(currentHead ?? '')) return reject('RESUME_HEAD_INVALID');
  if (currentHead !== handoff.head_sha) return reject('RESUME_HEAD_MOVED');
  return { ok: true, next_action: handoff.next_action };
}

// The reviewer must differ from every builder session: those recorded at
// handoff time and any session the new executor used afterwards.
export function verifyReviewerIndependence(handoff, reviewerSession, laterBuilderSessions = []) {
  if (!SESSION.test(reviewerSession ?? '')) return reject('REVIEWER_SESSION_INVALID');
  if (!Array.isArray(handoff?.reviewer_excluded_sessions) || !Array.isArray(laterBuilderSessions)) {
    return reject('REVIEWER_EXCLUSIONS_UNKNOWN');
  }
  const excluded = [...handoff.reviewer_excluded_sessions, ...laterBuilderSessions];
  if (excluded.includes(reviewerSession)) return reject('REVIEWER_IS_BUILDER');
  return { ok: true };
}
