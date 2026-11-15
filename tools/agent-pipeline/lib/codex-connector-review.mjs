// SC-436: read-only evidence from the existing GitHub Codex integration.
// The identity is pinned to the observed GitHub App bot, not a PR-supplied name.
// This extractor does not authorize a merge or replace the controller's review gate.
const SHA = /^[a-f0-9]{40}$/;
const SUMMARY = '<!-- codex-pull-request-review-summary -->';
const STATE = /<!-- codex-review-state:v1 ([^\r\n]+?) -->/g;
export const CODEX_CONNECTOR_BOT = Object.freeze({
  id: 199175422,
  login: 'chatgpt-codex-connector[bot]',
});
const reject = reason => ({ ok: false, reason });

export function verifyCodexConnectorReview({ comments, threads, headSha, builderActorId } = {}) {
  if (!SHA.test(headSha ?? '')) return reject('CODEX_HEAD_INVALID');
  if (!Array.isArray(comments) || !Array.isArray(threads)) return reject('CODEX_GITHUB_DATA_INCOMPLETE');
  if (!Number.isSafeInteger(builderActorId) || builderActorId <= 0) return reject('CODEX_BUILDER_IDENTITY_UNKNOWN');
  if (builderActorId === CODEX_CONNECTOR_BOT.id) return reject('CODEX_SELF_REVIEW');
  if (threads.some(thread => thread?.isResolved !== true)) return reject('CODEX_REVIEW_THREAD_OPEN');

  // GitHub-authenticated issue comments are required. Neither a copied marker
  // by another account nor a comment inside a PR body constitutes evidence.
  const trusted = comments.filter(comment =>
    comment?.user?.id === CODEX_CONNECTOR_BOT.id &&
    comment?.user?.login === CODEX_CONNECTOR_BOT.login &&
    typeof comment?.body === 'string' && comment.body.startsWith(SUMMARY));
  if (trusted.length !== 1) return reject('CODEX_SUMMARY_MISSING_OR_AMBIGUOUS');
  const [comment] = trusted;
  if (!Number.isSafeInteger(comment.id) || comment.id <= 0 || comment.body.length > 200_000) {
    return reject('CODEX_SUMMARY_INVALID');
  }
  const markers = [...comment.body.matchAll(STATE)];
  if (markers.length !== 1) return reject('CODEX_STATE_MISSING_OR_AMBIGUOUS');
  let state;
  try { state = JSON.parse(markers[0][1]); } catch { return reject('CODEX_STATE_INVALID_JSON'); }
  const review = state?.code_review;
  if (!review || typeof review !== 'object') return reject('CODEX_REVIEW_MISSING');
  if (review.commit_sha !== headSha) return reject('CODEX_REVIEW_STALE_HEAD');
  if (review.status !== 'completed') return reject('CODEX_REVIEW_PENDING');
  if (review.has_any_findings !== false || review.has_unresolved_findings !== false) {
    return reject('CODEX_REVIEW_FINDINGS_OR_UNKNOWN');
  }
  const security = state.security_review;
  if (!security || typeof security !== 'object' || Array.isArray(security)) {
    return reject('CODEX_SECURITY_REVIEW_UNCONFIRMED');
  }
  // Explicit all-null fields are the only legitimate "not requested" state.
  // Missing fields, partial findings and contradictory states must fail closed.
  const notRequested = security.status === null && security.commit_sha === null &&
    security.has_any_findings === null && security.has_unresolved_findings === null;
  const completed = security.status === 'completed' && security.commit_sha === headSha &&
    security.has_any_findings === false && security.has_unresolved_findings === false;
  if (!notRequested && !completed) return reject('CODEX_SECURITY_REVIEW_UNCONFIRMED');
  return { ok: true, source: 'github_codex_connector', headSha,
    reviewerId: CODEX_CONNECTOR_BOT.id, commentId: comment.id,
    codeReview: 'completed', securityReview: completed ? 'completed' : 'not_requested' };
}
