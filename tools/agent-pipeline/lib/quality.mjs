const fail = reason => ({ ok: false, reason });

// Inputs are read from GitHub by the controller, never from the PR description.
export function evaluateChecks({ head, checks, statuses, required, controllerAppId, generated = [] }) {
  if (!/^[a-f0-9]{40}$/.test(head) || !Array.isArray(checks) || !Array.isArray(statuses)
      || !Array.isArray(required) || !required.length) return fail('CHECKS_UNCONFIRMED');
  const latest = new Map();
  for (const check of checks) {
    if (check.head_sha !== head || !Number.isSafeInteger(check.id) || !check.name || !Number.isSafeInteger(check.app?.id)) return fail('CHECK_PROVENANCE_UNKNOWN');
    const key = `${check.app.id}:${check.name}`;
    if (!latest.has(key) || latest.get(key).id < check.id) latest.set(key, check);
  }
  const deferred = item => generated.includes(item.context) && item.integration_id === controllerAppId;
  for (const requirement of required) {
    if (!requirement.context || !Number.isSafeInteger(requirement.integration_id) || requirement.integration_id <= 0) return fail('CHECK_SOURCE_UNPINNED');
    if (deferred(requirement)) continue; // validated evidence is published by guardedMerge
    const check = latest.get(`${requirement.integration_id}:${requirement.context}`);
    if (!check) return fail('REQUIRED_CHECK_MISSING');
    if (check.status !== 'completed' || check.conclusion !== 'success') return fail('REQUIRED_CHECK_NOT_SUCCESS');
  }
  for (const check of latest.values()) {
    if (check.app.id === controllerAppId && generated.includes(check.name)) continue;
    if (check.status !== 'completed' || check.conclusion !== 'success') return fail('CHECK_NOT_SUCCESS');
  }
  const recent = new Map();
  for (const status of statuses) {
    if (!status.context || !Number.isSafeInteger(status.id)) return fail('STATUS_UNCONFIRMED');
    if (!recent.has(status.context) || recent.get(status.context).id < status.id) recent.set(status.context, status);
  }
  if ([...recent.values()].some(s => s.state !== 'success')) return fail('STATUS_NOT_SUCCESS');
  return { ok: true };
}

export function evaluateDiscussion(threads, reviews) {
  if (!Array.isArray(threads) || !Array.isArray(reviews)) return fail('REVIEW_DISCUSSION_UNCONFIRMED');
  if (threads.some(thread => thread.isResolved !== true)) return fail('UNRESOLVED_REVIEW_THREAD');
  const latest = new Map();
  for (const review of reviews) {
    if (!Number.isSafeInteger(review.id) || !Number.isSafeInteger(review.user?.id)) return fail('REVIEW_IDENTITY_UNKNOWN');
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
        && (!latest.has(review.user.id) || latest.get(review.user.id).id < review.id)) latest.set(review.user.id, review);
  }
  return [...latest.values()].some(r => r.state === 'CHANGES_REQUESTED') ? fail('CHANGES_REQUESTED') : { ok: true };
}
