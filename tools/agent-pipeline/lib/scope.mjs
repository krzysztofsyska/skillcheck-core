const FORBIDDEN_REFS = new Set(['main', 'integration', 'agent-state']);

export function matchAllowed(file, patterns) {
  return patterns.some(pattern => globMatch(file, pattern));
}

export function filesOutside(files, patterns) {
  return (files ?? []).filter(file => !matchAllowed(file, patterns));
}

export function assertCursorTarget({ startingRef, repositoryId, fork, expectedRepositoryId, repoUrl, allowedRepoUrls }) {
  if (fork) return { ok: false, reason: 'FORK_REJECTED' };
  if (repositoryId !== expectedRepositoryId) return { ok: false, reason: 'REPOSITORY_MISMATCH' };
  if (!startingRef || FORBIDDEN_REFS.has(startingRef)) return { ok: false, reason: 'REF_FORBIDDEN' };
  if (allowedRepoUrls && repoUrl && !allowedRepoUrls.includes(repoUrl)) return { ok: false, reason: 'REPOSITORY_MISMATCH' };
  return { ok: true };
}

export function globMatch(file, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE::/g, '.*');
  return new RegExp(`^${escaped}$`).test(file);
}

export function promotionRefs({ headRef, baseRef, headRepositoryId, baseRepositoryId, expectedRepositoryId }) {
  if (headRepositoryId !== expectedRepositoryId || baseRepositoryId !== expectedRepositoryId) {
    return { ok: false, reason: 'FORK_REJECTED' };
  }
  if (headRef !== 'integration' || baseRef !== 'main') return { ok: false, reason: 'PROMOTION_REF_REJECTED' };
  return { ok: true };
}
