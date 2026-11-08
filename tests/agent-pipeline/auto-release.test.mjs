import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutoRelease, classifyReleaseFiles } from '../../tools/agent-pipeline/lib/auto-release.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';

const I = 'a'.repeat(40), M = 'b'.repeat(40);
const APP = 42;
const policy = { controller_app_id: APP, owner: { id: 7 }, required_checks: { main: ['verify'], integration: ['verify'] },
  environments: {} };
const ruleset = (branch, bypass) => ({ enforcement: 'active', target: 'branch', name: `w-${branch}`,
  conditions: { ref_name: { include: [`refs/heads/${branch}`] } }, bypass_actors: bypass, rules: [{ type: 'update' }] });
const quality = branch => ({ enforcement: 'active', target: 'branch', name: `q-${branch}`,
  conditions: { ref_name: { include: [`refs/heads/${branch}`] } }, bypass_actors: [],
  rules: [{ type: 'pull_request' }, { type: 'deletion' }, { type: 'non_fast_forward' },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'verify', integration_id: APP }] } }] });
const state = { enforcement: 'active', target: 'branch', name: 's', conditions: { ref_name: { include: ['refs/heads/agent-state'] } },
  bypass_actors: [], rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] };
const w = (b, mode) => ruleset(b, [{ actor_type: 'Integration', actor_id: APP, bypass_mode: mode }]);
const rulesets = [w('main', 'pull_request'), w('integration', 'pull_request'), w('agent-state', 'always'), quality('main'), quality('integration'), state];
const mainOnly = id => ({ id, deployment_branch_policy: { custom_branch_policies: true }, branch_policies: [{ name: 'main', type: 'branch' }],
  protection_rules: [{ type: 'branch_policy' }] });
const reviewerEnv = id => ({ ...mainOnly(id), can_admins_bypass: false,
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 7 } }] }] });
policy.environments = { owner_acceptance: { name: 'oa', id: 1 }, production_approval: { name: 'pa', id: 2 }, agent_review: { name: 'ar', id: 3 } };
const environments = { oa: reviewerEnv(1), pa: reviewerEnv(2), ar: mainOnly(3) };

const task = { task_id: 'T1', integration_source: 'verified_ci_review' };
const good = () => ({
  trusted: { p24Hold: false },
  current: { repository: 'r/r', integrationSha: I, mainSha: M },
  promotion: { blockedReason: null, manifest: { integration_sha: I, main_sha: M, tasks: [task], files: ['app/page.tsx'] },
    runbook: { id: 'x' }, smokeTests: ['smoke'], rollback: 'redeploy previous' },
  rulesets, policy, environments,
  ci: { completed: true, conclusion: 'success', head_sha: I },
  review: { completed: true, conclusion: 'success', head_sha: I, verdict: 'PASS' },
  codex: { completed: true, head_sha: I, open_findings: 0 },
  migrations: [], lock: { held: false, inflight: 0 }, released: [],
});
const deny = (mut, code) => {
  const i = good(); mut(i);
  const r = evaluateAutoRelease(i);
  assert.equal(r.decision, 'DENY'); assert.ok(r.reasons.some(x => x.startsWith(code)), `${code} in ${r.reasons}`);
};

test('fixture protection is really accepted (guards the fixture)', () => {
  const p = protectionFromRulesets(rulesets, policy, environments);
  assert.equal(p.environmentsConfirmed && p.mainProtected && p.exclusiveWritersConfirmed, true);
});
test('compliant low-risk release with full evidence is qualified and bound', () => {
  const r = evaluateAutoRelease(good());
  assert.equal(r.decision, 'ALLOW'); assert.match(r.binding, /^[0-9a-f]{64}$/);
});
test('additive migration with recovery plan is qualified', () => {
  const i = good(); i.promotion.manifest.files.push('supabase/migrations/20261108_x.sql');
  i.migrations = [{ path: 'supabase/migrations/20261108_x.sql', sql: 'alter table t add column c text; -- drop table x' }];
  i.promotion.runbook = { id: 'x', backup: 'pitr', rollback_db_compatible: true };
  assert.equal(evaluateAutoRelease(i).decision, 'ALLOW');
});
test('P24 hold denies; anything but literal false keeps hold', () => {
  deny(i => { i.trusted = { p24Hold: true }; }, 'P24_HOLD');
  deny(i => { i.trusted = {}; }, 'P24_HOLD');
  deny(i => { i.trusted = { p24Hold: 'false' }; }, 'P24_HOLD');
  deny(i => { i.trusted = undefined; }, 'P24_HOLD');
});
test('destructive / access DB changes deny', () => {
  for (const sql of ['drop table t;', 'truncate t;', 'delete from t;', 'alter table t drop column c;', 'update t set a=1;', 'grant all on t to anon;', 'create policy p on t using (true);']) {
    deny(i => { i.promotion.manifest.files.push('supabase/migrations/m.sql'); i.migrations = [{ path: 'supabase/migrations/m.sql', sql }];
      i.promotion.runbook = { id: 'x', backup: 'b', rollback_db_compatible: true }; }, sql.startsWith('grant') || sql.startsWith('create') ? 'ACCESS_CHANGE_DB' : 'DESTRUCTIVE_DB');
  }
});
test('unreadable migration denies', () => deny(i => { i.promotion.manifest.files.push('supabase/migrations/m.sql'); }, 'MIGRATION_UNREADABLE'));
test('payments, sends, pipeline/secrets paths need owner consent', () => {
  for (const [f, c] of [['lib/billing/x.ts', 'PAYMENTS'], ['lib/p24/client.ts', 'PAYMENTS'], ['lib/mail/send.ts', 'OUTBOUND_SENDS'], ['.github/workflows/a.yml', 'SECRETS_OR_PIPELINE'], ['tools/agent-pipeline/lib/x.mjs', 'SECRETS_OR_PIPELINE']])
    deny(i => { i.promotion.manifest.files.push(f); }, c);
  assert.deepEqual(classifyReleaseFiles(['app/page.tsx']).reasons, []);
});
test('missing, stale or failing CI/review/auto-review deny', () => {
  deny(i => { i.ci = undefined; }, 'CI_MISSING_OR_STALE');
  deny(i => { i.ci.head_sha = 'c'.repeat(40); }, 'CI_MISSING_OR_STALE');
  deny(i => { i.ci.conclusion = 'failure'; }, 'CI_MISSING_OR_STALE');
  deny(i => { i.review = undefined; }, 'REVIEW_MISSING_OR_STALE');
  deny(i => { i.review.verdict = 'PASS WITH FIXES'; }, 'REVIEW_MISSING_OR_STALE');
  deny(i => { i.codex.completed = false; }, 'AUTO_REVIEW_PENDING');
  deny(i => { i.codex.open_findings = 1; }, 'AUTO_REVIEW_PENDING');
  deny(i => { i.codex = undefined; }, 'AUTO_REVIEW_PENDING');
});
test('changed head/base SHA or unknown state denies', () => {
  deny(i => { i.current.integrationSha = 'c'.repeat(40); i.ci.head_sha = i.review.head_sha = i.codex.head_sha = 'c'.repeat(40); }, 'SHA_CHANGED');
  deny(i => { i.current.mainSha = 'c'.repeat(40); }, 'SHA_CHANGED');
  deny(i => { i.current = undefined; }, 'CURRENT_STATE_UNKNOWN');
});
test('mixed / unaccounted scope and owner-gated or unverified tasks deny', () => {
  deny(i => { i.promotion.blockedReason = 'PROMOTION_SCOPE_UNACCOUNTED'; }, 'MANIFEST_');
  deny(i => { i.promotion.manifest.tasks = [{ task_id: 'T2', approval_request_id: 'x' }]; }, 'UNVERIFIED_TASK');
  deny(i => { i.promotion = null; }, 'NO_PROMOTION_MANIFEST');
});
test('unreadable or weak protection denies', () => {
  deny(i => { i.rulesets = undefined; i.environments = undefined; }, 'PROTECTION_');
  deny(i => { i.rulesets = rulesets.map(r => ({ ...r, bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }] })); }, 'PROTECTION_WEAK');
  deny(i => { i.rulesets = []; }, 'PROTECTION_WEAK');
  deny(i => { i.environments = { ...environments, ar: reviewerEnv(3) }; }, 'PROTECTION_WEAK');
});
test('parallel or duplicate release and incompatible rollback deny', () => {
  deny(i => { i.lock = { held: true, inflight: 1 }; }, 'RELEASE_NOT_SERIALIZED');
  deny(i => { i.lock = undefined; }, 'RELEASE_NOT_SERIALIZED');
  deny(i => { i.released = [I]; }, 'DUPLICATE_OR_UNKNOWN');
  deny(i => { i.released = undefined; }, 'DUPLICATE_OR_UNKNOWN');
  deny(i => { i.promotion.manifest.files.push('supabase/migrations/m.sql'); i.migrations = [{ path: 'supabase/migrations/m.sql', sql: 'create table t(a int);' }];
    i.promotion.runbook = { id: 'x', backup: 'b', rollback_db_compatible: false }; }, 'MIGRATION_RECOVERY');
  deny(i => { i.promotion.smokeTests = []; }, 'MISSING_SMOKE_OR_ROLLBACK');
});
