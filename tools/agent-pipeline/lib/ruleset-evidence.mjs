import { sha256 } from './canonical.mjs';

// Only trusted, owner-reviewed policy may supply attestations. Never infer that
// a missing bypass_actors field means an empty list. GitHub hides it at read scope.
export function rulesetFingerprint(rule) {
  const { id, source, source_type, target, enforcement, conditions, rules, updated_at } = rule;
  return sha256({ id, source, source_type, target, enforcement, conditions, rules, updated_at });
}

export function withRulesetEvidence(rule, policy = {}, now = Date.now()) {
  if (Array.isArray(rule.bypass_actors)) return rule;
  const evidence = policy.ruleset_attestations?.filter(e => e.id === rule.id);
  if (evidence?.length !== 1) throw new Error('RULESET_ATTESTATION_REQUIRED');
  const e = evidence[0];
  const checked = Date.parse(e.checked_at), expires = Date.parse(e.expires_at);
  if (!Number.isSafeInteger(policy.owner?.id) || e.owner_id !== policy.owner.id
      || !Array.isArray(e.bypass_actors) || rule.source_type !== 'Repository'
      || rule.source !== policy.repository || !Number.isFinite(Date.parse(rule.updated_at))
      || e.fingerprint !== rulesetFingerprint(rule) || e.updated_at !== rule.updated_at
      || !Number.isFinite(checked) || !Number.isFinite(expires) || checked > now || expires <= now
      || checked < Date.parse(rule.updated_at) || expires - checked > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('RULESET_ATTESTATION_STALE');
  }
  return { ...rule, bypass_actors: e.bypass_actors };
}

export async function verifyStateBootstrap(github, policy) {
  const e = policy.feedback_state_bootstrap;
  if (!/^[a-f0-9]{40}$/.test(e?.sha ?? '') || e.owner_id !== policy.owner?.id
      || !Number.isSafeInteger(e.owner_id)) throw new Error('STATE_BOOTSTRAP_UNATTESTED');
  const root = `/repos/${policy.repository}`;
  const branch = await github.request(`${root}/branches/agent-feedback-state`);
  const head = branch.commit?.sha;
  if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('STATE_BOOTSTRAP_INVALID');
  // The attested initial commit must contain no feedback records, including a
  // feedback symlink. An unrelated prepared state commit cannot be substituted.
  const tree = await github.request(`${root}/git/trees/${e.sha}`);
  if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.some(x => x.path === 'feedback')) {
    throw new Error('STATE_BOOTSTRAP_NOT_EMPTY');
  }
  if (head !== e.sha) {
    const comparison = await github.request(`${root}/compare/${e.sha}...${head}?per_page=100`);
    if (comparison.status !== 'ahead' || comparison.base_commit?.sha !== e.sha
        || !Number.isSafeInteger(policy.controller_actor_id) || !comparison.total_commits
        || comparison.total_commits > 100 || comparison.commits?.length !== comparison.total_commits) {
      throw new Error('STATE_BOOTSTRAP_MISMATCH');
    }
    let parent = e.sha;
    for (const entry of comparison.commits) {
      const commit = await github.request(`${root}/commits/${entry.sha}`);
      if (commit.sha !== entry.sha || commit.parents?.length !== 1 || commit.parents[0].sha !== parent
          || commit.committer?.id !== policy.controller_actor_id || commit.committer?.type !== 'Bot'
          || commit.commit?.verification?.verified !== true || commit.commit.verification.reason !== 'valid') {
        throw new Error('STATE_WRITER_UNVERIFIED');
      }
      parent = commit.sha;
    }
    if (parent !== head) throw new Error('STATE_BOOTSTRAP_MISMATCH');
  }
}
