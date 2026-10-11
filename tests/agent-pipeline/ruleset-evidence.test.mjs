import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesetFingerprint, withRulesetEvidence, verifyStateBootstrap } from '../../tools/agent-pipeline/lib/ruleset-evidence.mjs';

function fixture() {
  const rule = { id: 12, source: 'owner/repo', source_type: 'Repository', enforcement: 'active', target: 'branch',
    conditions: { ref_name: { include: ['refs/heads/agent-feedback-state'] } }, rules: [{ type: 'update' }],
    updated_at: '2026-10-11T10:00:00Z' };
  const evidence = { id: rule.id, updated_at: rule.updated_at, fingerprint: rulesetFingerprint(rule),
    owner_id: 123, checked_at: '2026-10-11T11:00:00Z', expires_at: '2026-10-12T11:00:00Z',
    bypass_actors: [{ actor_type: 'Integration', actor_id: 456, bypass_mode: 'always' }] };
  return { rule, evidence, policy: { repository: 'owner/repo', owner: { id: 123 }, ruleset_attestations: [evidence] }, now: Date.parse('2026-10-11T12:00:00Z') };
}
test('read-scope response is hydrated only from exact owner-reviewed version', () => {
  const f = fixture();
  assert.deepEqual(withRulesetEvidence(f.rule, f.policy, f.now).bypass_actors, f.evidence.bypass_actors);
  assert.throws(() => withRulesetEvidence(f.rule), /ATTESTATION_REQUIRED/);
});
for (const change of ['hidden_change', 'rules_changed', 'expired', 'wrong_owner', 'wrong_repo', 'duplicate', 'future', 'unbounded']) {
  test(`reject attestation ${change}`, () => {
    const f = fixture();
    if (change === 'hidden_change') f.rule.updated_at = '2026-10-11T11:30:00Z';
    if (change === 'rules_changed') f.rule.rules = [];
    if (change === 'expired') f.evidence.expires_at = '2026-10-11T11:01:00Z';
    if (change === 'wrong_owner') f.evidence.owner_id = 999;
    if (change === 'wrong_repo') f.policy.repository = 'other/repo';
    if (change === 'duplicate') f.policy.ruleset_attestations.push(f.evidence);
    if (change === 'future') f.evidence.checked_at = '2026-10-11T13:00:00Z';
    if (change === 'unbounded') f.evidence.expires_at = '2027-10-11T11:00:00Z';
    assert.throws(() => withRulesetEvidence(f.rule, f.policy, f.now), /ATTESTATION/);
  });
}
test('live disclosed bypass list takes precedence over attestation', () => {
  const f = fixture(); f.rule.bypass_actors = [];
  assert.deepEqual(withRulesetEvidence(f.rule, f.policy, f.now).bypass_actors, []);
});
test('bootstrap must be pinned, empty and have authenticated linear descendants', async () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const policy = { repository: 'owner/repo', owner: { id: 123 }, controller_actor_id: 456,
    feedback_state_bootstrap: { owner_id: 123, sha: a } };
  const tree = { truncated: false, tree: [] };
  const commit = { sha: b, parents: [{ sha: a }], committer: { id: 456, type: 'Bot' },
    commit: { verification: { verified: true, reason: 'valid' } } };
  const github = { request: async path => {
    if (path.includes('/branches/')) return { commit: { sha: b } };
    if (path.includes('/git/trees/')) return tree;
    if (path.includes('/compare/')) return { status: 'ahead', base_commit: { sha: a }, total_commits: 1, commits: [{ sha: b }] };
    return commit;
  } };
  await verifyStateBootstrap(github, policy);
  commit.committer.id = 999;
  await assert.rejects(verifyStateBootstrap(github, policy), /WRITER_UNVERIFIED/);
  tree.tree.push({ path: 'feedback', type: 'tree' });
  await assert.rejects(verifyStateBootstrap(github, policy), /NOT_EMPTY/);
  await assert.rejects(verifyStateBootstrap(github, {}), /UNATTESTED/);
});
