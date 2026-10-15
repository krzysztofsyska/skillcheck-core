import { sha256 } from './canonical.mjs';

// GitHub can conceal bypass actors at read scope. Never infer an empty list
// or trust a timestamp-based attestation of the concealed list.
export function rulesetFingerprint(rule) {
  const { id, source, source_type, target, enforcement, conditions, rules, updated_at } = rule;
  return sha256({ id, source, source_type, target, enforcement, conditions, rules, updated_at });
}

// Security boundary: read-scoped GitHub API hides bypass_actors. Its ruleset GET
// response has no monotonic version_id, while ruleset history/version endpoints
// require Administration:write. Matching updated_at (even with an owner-reviewed
// fingerprint) cannot distinguish edits made within the same timestamp tick.
// Therefore never hydrate a hidden bypass list from policy attestations.
// This deliberately blocks activation until an independently verified,
// explicitly approved version-aware evidence mechanism is available.
export function withRulesetEvidence(rule) {
  if (!rule || !Array.isArray(rule.bypass_actors)) {
    throw new Error('RULESET_BYPASS_UNVERIFIABLE');
  }
  return rule;
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
  let commits = 0;
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
    commits = comparison.total_commits;
  }
  return { commits };
}
