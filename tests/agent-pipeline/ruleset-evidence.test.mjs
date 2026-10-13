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
test('read-scoped hidden bypass fails closed even with matching owner attestation', () => {
  const f = fixture();
  assert.equal(f.evidence.fingerprint, rulesetFingerprint(f.rule));
  assert.throws(() => withRulesetEvidence(f.rule, f.policy, f.now), /RULESET_BYPASS_UNVERIFIABLE/);
});

test('same-second ruleset bypass change never inherits a prior hidden attestation', () => {
  const f = fixture();
  const priorTimestamp = f.rule.updated_at;
  // GitHub GET hides the changed actor list and its timestamp can be unchanged.
  f.evidence.bypass_actors = [];
  f.rule.updated_at = priorTimestamp;
  assert.throws(() => withRulesetEvidence(f.rule, f.policy, f.now), /RULESET_BYPASS_UNVERIFIABLE/);
});

test('expired, renewed and spoofed policy attestations cannot authorize hidden bypass', () => {
  const f = fixture();
  for (const policy of [
    f.policy,
    { ...f.policy, ruleset_attestations: [] },
    { ...f.policy, ruleset_attestations: [{ ...f.evidence, expires_at: '2099-01-01T00:00:00Z' }] },
  ]) {
    assert.throws(() => withRulesetEvidence(f.rule, policy, f.now), /RULESET_BYPASS_UNVERIFIABLE/);
  }
});

test('only directly disclosed bypass list can pass through without synthetic actors', () => {
  const f = fixture();
  const actors = [{ actor_type: 'Integration', actor_id: 456, bypass_mode: 'always' }];
  f.rule.bypass_actors = actors;
  assert.equal(withRulesetEvidence(f.rule, f.policy, f.now), f.rule);
  assert.deepEqual(withRulesetEvidence(f.rule).bypass_actors, actors);
  f.rule.bypass_actors = [];
  assert.deepEqual(withRulesetEvidence(f.rule).bypass_actors, []);
  delete f.rule.bypass_actors;
  assert.throws(() => withRulesetEvidence(f.rule), /RULESET_BYPASS_UNVERIFIABLE/);
  assert.throws(() => withRulesetEvidence(null), /RULESET_BYPASS_UNVERIFIABLE/);
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
