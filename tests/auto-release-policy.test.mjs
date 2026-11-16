// SC-AUTO-RELEASE (#369) point 3: every gate refuses on its own, without a human.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  destructiveSql, classifyRelease, backupGate, reviewGate, codexGate, ciGate, evaluateCandidate, afterDeploy,
} from '../tools/release/auto/policy.mjs';

const H = 'a'.repeat(40);
const M = 'b'.repeat(40);
const pass = (over = {}) => ({
  author_association: 'OWNER', created_at: '2026-11-16T10:00:00Z',
  body: `PASS\n<!-- sc-review-verdict:v1 ${JSON.stringify({ verdict: 'PASS', head_sha: H, reviewer: 'session_REVIEWER01', builder: 'session_BUILDER001', ...over })} -->`,
});
const green = sha => ['verify', 'Agent contract / scope gate'].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success', started_at: '2026-11-16T09:00:00Z' }));
const base = () => ({
  pr: { number: 7, merged: true, head_sha: H, merge_commit_sha: M, base_ref: 'integration' },
  files: ['app/regulamin/page.tsx'], migrations: [], checkRuns: green(H), comments: [pass()],
  migrationExecutor: false, backups: null, now: new Date('2026-11-16T12:00:00Z'),
});
const reasons = mut => { const i = base(); mut(i); return evaluateCandidate(i).reasons; };

test('small reviewed change with green CI is allowed', () => {
  assert.deepEqual(evaluateCandidate(base()), { decision: 'ALLOW', reasons: [], migrations: [] });
});

test('destructive SQL is refused with an explicit code per kind', () => {
  const cases = {
    'drop table public.x;': 'DROP', 'DROP COLUMN': null, 'alter table x drop column y;': 'ALTER_DROP',
    'delete from public.candidates;': 'DELETE', 'TRUNCATE public.x;': 'TRUNCATE',
    'alter table x alter column y type bigint;': 'ALTER_TYPE', 'alter table x rename to y;': 'RENAME',
    'update public.x set y = 1;': 'UPDATE_ROWS', 'alter table x drop constraint c;': 'ALTER_DROP',
  };
  for (const [sql, code] of Object.entries(cases)) {
    if (code) assert.ok(destructiveSql(sql).includes(code), sql);
  }
  assert.deepEqual(destructiveSql('alter table public.x add column y text;'), []);
  assert.deepEqual(destructiveSql(''), ['UNREADABLE']);
  const r = reasons(i => { i.files = ['supabase/migrations/1_x.sql']; i.migrations = [{ path: 'supabase/migrations/1_x.sql', sql: 'DROP TABLE public.companies;' }]; });
  assert.ok(r.includes('DESTRUCTIVE_SQL:DROP:supabase/migrations/1_x.sql'));
  const hidden = reasons(i => { i.files = ['supabase/migrations/1_x.sql']; i.migrations = [{ path: 'supabase/migrations/1_x.sql', sql: '-- harmless\n/* */ delete from public.x;' }]; });
  assert.ok(hidden.includes('DESTRUCTIVE_SQL:DELETE:supabase/migrations/1_x.sql'));
  const unreadable = reasons(i => { i.files = ['supabase/migrations/1_x.sql']; });
  assert.ok(unreadable.includes('DESTRUCTIVE_SQL:UNREADABLE:supabase/migrations/1_x.sql'));
});

test('every migration needs a fresh completed backup and an unattended executor', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  assert.deepEqual(backupGate({ backups: null, now }), ['BACKUP_EVIDENCE_MISSING']);
  assert.deepEqual(backupGate({ backups: [{ status: 'FAILED', inserted_at: '2026-11-16T03:00:00Z' }], now }), ['BACKUP_NOT_COMPLETED']);
  assert.deepEqual(backupGate({ backups: [{ status: 'COMPLETED', inserted_at: '2026-11-14T03:00:00Z' }], now }), ['BACKUP_STALE']);
  assert.deepEqual(backupGate({ backups: [{ status: 'COMPLETED', inserted_at: '2026-11-17T03:00:00Z' }], now }), ['BACKUP_NOT_COMPLETED']);
  assert.deepEqual(backupGate({ backups: [{ status: 'COMPLETED', inserted_at: '2026-11-16T03:00:00Z' }], now }), []);
  assert.deepEqual(backupGate({ backups: [], now: 'x' }), ['BACKUP_CLOCK_INVALID']);
  const additive = i => { i.files = ['supabase/migrations/1_x.sql']; i.migrations = [{ path: 'supabase/migrations/1_x.sql', sql: 'alter table public.x add column y text;' }]; };
  const r = reasons(additive);
  assert.ok(r.includes('BACKUP_EVIDENCE_MISSING') && r.includes('MIGRATION_EXECUTOR_UNAVAILABLE'));
  const fresh = reasons(i => { additive(i); i.backups = [{ status: 'COMPLETED', inserted_at: '2026-11-16T03:00:00Z' }]; });
  assert.deepEqual(fresh, ['MIGRATION_EXECUTOR_UNAVAILABLE']);
});

test('payment-path freeze and other owner-consent areas stay refused', () => {
  for (const [file, code] of [
    ['app/kup/page.tsx', 'PAYMENT_PATH_FREEZE'], ['lib/sc19-catalog-orders.ts', 'PAYMENT_PATH_FREEZE'],
    ['lib/sc19-package-sizes.ts', 'PAYMENT_PATH_FREEZE'], ['app/cennik/page.tsx', 'PAYMENT_PATH_FREEZE'],
    ['lib/stripe/client.ts', 'PAYMENT_PATH_FREEZE'], ['lib/p24/sign.ts', 'PAYMENTS'], ['app/operator/billing/page.tsx', 'PAYMENTS'],
    ['lib/sales-leads.ts', 'OUTBOUND_SENDS'], ['lib/email/send.ts', 'OUTBOUND_SENDS'],
    ['.github/workflows/x.yml', 'SECRETS_OR_PIPELINE'], ['tools/release/auto/policy.mjs', 'SECRETS_OR_PIPELINE'],
    ['tools/agent-pipeline/x.mjs', 'SECRETS_OR_PIPELINE'], ['vercel.json', 'SECRETS_OR_PIPELINE'],
  ]) {
    assert.ok(classifyRelease([file]).reasons.includes(`${code}:${file}`), file);
  }
  assert.deepEqual(classifyRelease([]).reasons, ['INVALID_OR_EMPTY_FILE_LIST']);
  assert.deepEqual(classifyRelease(['app/regulamin/page.tsx', 'docs/x.md']).reasons, []);
});

test('CI must be green on the exact SHA; missing, pending, failed or other-SHA runs refuse', () => {
  assert.deepEqual(ciGate(green(H), H), []);
  assert.deepEqual(ciGate(green(M), H), ['CI_MISSING:verify', 'CI_MISSING:Agent contract / scope gate']);
  const failed = green(H); failed[0].conclusion = 'failure';
  assert.deepEqual(ciGate(failed, H), ['CI_FAILED:verify']);
  const pending = green(H); pending[1].status = 'in_progress';
  assert.deepEqual(ciGate(pending, H), ['CI_PENDING:Agent contract / scope gate']);
  const rerun = [...green(H), { name: 'verify', head_sha: H, status: 'completed', conclusion: 'failure', started_at: '2026-11-16T11:00:00Z' }];
  assert.deepEqual(ciGate(rerun, H), ['CI_FAILED:verify']);
  assert.deepEqual(ciGate(undefined, 'x'), ['CI_HEAD_INVALID']);
});

test('independent PASS on the exact SHA is required; builder self-review and later FAIL refuse', () => {
  assert.deepEqual(reviewGate([pass()], H), []);
  assert.deepEqual(reviewGate([], H), ['REVIEW_PASS_MISSING']);
  assert.deepEqual(reviewGate([pass({ head_sha: M })], H), ['REVIEW_PASS_MISSING']);
  assert.deepEqual(reviewGate([pass({ reviewer: 'session_BUILDER001' })], H), ['REVIEW_NOT_INDEPENDENT']);
  assert.deepEqual(reviewGate([pass({ reviewer: 'me' })], H), ['REVIEW_IDENTITY_INVALID']);
  assert.deepEqual(reviewGate([pass(), pass({ verdict: 'FAIL' })], H), ['REVIEW_NOT_PASS:FAIL']);
  assert.deepEqual(reviewGate([pass({ verdict: 'PASS WITH FIXES' })], H), ['REVIEW_NOT_PASS:PASS WITH FIXES']);
  assert.deepEqual(reviewGate([{ ...pass(), author_association: 'NONE' }], H), ['REVIEW_PASS_MISSING']);
  assert.deepEqual(reviewGate([{ author_association: 'OWNER', body: '<!-- sc-review-verdict:v1 {bad json} -->' }], H), ['REVIEW_PASS_MISSING']);
  // Free-text "PASS" without the machine marker never counts.
  assert.deepEqual(reviewGate([{ author_association: 'OWNER', body: `PASS ${H}` }], H), ['REVIEW_PASS_MISSING']);
});

test('Codex unresolved findings on the exact SHA refuse; other SHA or other author ignored', () => {
  const codex = (sha, unresolved, id = 199175422) => ({ user: { id }, body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_unresolved_findings: unresolved } })} -->` });
  assert.deepEqual(codexGate([codex(H, true)], H), ['CODEX_UNRESOLVED_FINDINGS:code_review']);
  assert.deepEqual(codexGate([codex(M, true)], H), []);
  assert.deepEqual(codexGate([codex(H, true, 1)], H), []);
  assert.deepEqual(codexGate([codex(H, false)], H), []);
});

test('unmerged, foreign-base or malformed candidates refuse instead of throwing', () => {
  assert.ok(reasons(i => { i.pr.merged = false; }).includes('PR_NOT_MERGED_INTO_INTEGRATION'));
  assert.ok(reasons(i => { i.pr.base_ref = 'main'; }).includes('PR_NOT_MERGED_INTO_INTEGRATION'));
  assert.ok(reasons(i => { i.pr.head_sha = 'x'; }).includes('PR_SHA_INVALID'));
  assert.deepEqual(evaluateCandidate(null).reasons, ['INVALID_INPUT']);
  assert.equal(evaluateCandidate({ pr: 5 }).decision, 'DENY');
});

test('after deploy: smoke or deployment failure means rollback + freeze; data changes are flagged', () => {
  assert.deepEqual(afterDeploy({ deployed: true, smokeOk: true, migrationsApplied: [] }), { action: 'DONE', freeze: false, codes: [] });
  assert.deepEqual(afterDeploy({ deployed: true, smokeOk: false, migrationsApplied: [] }), { action: 'ROLLBACK', freeze: true, codes: ['SMOKE_FAILED'] });
  assert.deepEqual(afterDeploy({ deployed: false, smokeOk: false }), { action: 'ROLLBACK', freeze: true, codes: ['DEPLOYMENT_NOT_CONFIRMED'] });
  assert.deepEqual(afterDeploy({ deployed: true, smokeOk: false, migrationsApplied: ['supabase/migrations/1.sql'] }).codes,
    ['SMOKE_FAILED', 'ROLLBACK_INSUFFICIENT_DATA_CHANGED']);
});

test('publisher workflow: no manual start, trusted main code, no production-approval environment', async () => {
  const { readFileSync } = await import('node:fs');
  const wf = readFileSync(new URL('../.github/workflows/auto-release.yml', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(wf, /workflow_dispatch|pull_request/);
  assert.match(wf, /schedule:/); assert.match(wf, /workflow_run:/);
  assert.doesNotMatch(wf, /production-approval|PRODUCTION_DATABASE_URL|SUPABASE_ACCESS_TOKEN/);
  assert.match(wf, /ref: main/);
  assert.match(wf, /github\.ref == 'refs\/heads\/main'/);
  assert.match(wf, /cancel-in-progress: false/);
});

test('scope gate: main accepts integration and release/auto-* promotions only', async () => {
  const { classify } = await import('../tools/agent-pipeline/classify-pr.mjs');
  const body = ['TASK: x', 'SCOPE: FRONTEND', 'LEVEL: L3', 'OWNER_APPROVAL: x', 'PRODUCTION_APPROVAL: x', 'REVIEW_VERDICT: x', 'PROMOTION: YES'].join('\n');
  const run = headRef => classify({ files: ['app/regulamin/page.tsx'], body, base: 'main', headRef }).ok;
  assert.equal(run('integration'), true);
  assert.equal(run('release/auto-pr-456'), true);
  assert.equal(run('release/auto-revert-pr-456'), true);
  assert.equal(run('claude/feature'), false);
  assert.equal(run('release/other'), false);
  assert.equal(classify({ files: ['app/x.tsx'], body: body.replace('PROMOTION: YES', 'PROMOTION: NO'), base: 'main', headRef: 'release/auto-pr-1' }).ok, false);
});
