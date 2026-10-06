import { notificationId, sha256 } from './canonical.mjs';

export const NOTIFICATION_KINDS = new Set(['READY_FOR_OWNER', 'READY_FOR_PROD', 'BLOCKED', 'DONE']);

export function buildNotification({ taskId, stateRevision, recipient, kind, headSha, baseSha, result, evidenceUrl, actionUrl }) {
  if (!NOTIFICATION_KINDS.has(kind)) {
    const error = new Error('UNKNOWN_NOTIFICATION');
    error.code = 'UNKNOWN_NOTIFICATION';
    throw error;
  }
  if (!recipient) {
    const error = new Error('RECIPIENT_NOT_CONFIGURED');
    error.code = 'RECIPIENT_NOT_CONFIGURED';
    throw error;
  }
  const id = notificationId({ taskId, stateRevision, recipient, kind });
  return {
    notification_id: id,
    marker: `skillcheck-notification:${id}`,
    task_id: taskId,
    kind,
    recipient,
    head_sha: headSha ?? null,
    base_sha: baseSha ?? null,
    result: result ?? null,
    evidence_url: evidenceUrl ?? null,
    action_url: actionUrl ?? null,
    body: [
      `skillcheck-notification:${id}`,
      `task: ${taskId}`,
      `kind: ${kind}`,
      `result: ${result ?? ''}`,
      `head: ${headSha ?? ''}`,
      `base: ${baseSha ?? ''}`,
      `evidence: ${evidenceUrl ?? ''}`,
      `action: ${actionUrl ?? ''}`,
    ].join('\n'),
  };
}

export function reconcileOutbox({ pending, comments, authorId }) {
  const matched = (comments ?? []).filter(comment => comment.author_id === authorId && typeof comment.body === 'string' && comment.body.includes(pending.marker));
  if (matched.length === 1) return { delivered: true, commentId: matched[0].id, duplicate: false };
  if (matched.length > 1) return { delivered: true, commentId: matched[0].id, duplicate: true };
  return { delivered: false };
}

export function reportDigest(report) {
  return sha256(report);
}
