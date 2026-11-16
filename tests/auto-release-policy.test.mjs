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
  patches: [{ path: 'app/regulamin/page.tsx', patch: '--- a/x\n+++ b/x\n-stary tekst\n+nowy tekst' }], unreleasedMigrations: [], provenance: [],
  reviewThreads: [], reviews: [], workerModules: ['supabase/functions/screening-worker/index.ts', 'lib/screening-hmac.ts'],
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
  assert.ok(classifyRelease(['tests/buy-preselekcja.test.mjs']).reasons.includes('PAYMENT_PATH_FREEZE:tests/buy-preselekcja.test.mjs'));
  // npm manifests are not the package catalog; a nested package.json still is refused (not an npm root manifest).
  assert.deepEqual(classifyRelease(['package.json', 'package-lock.json']).reasons, []);
  assert.ok(classifyRelease(['app/packages/package.json']).reasons.some(r => r.startsWith('PAYMENT_PATH_FREEZE')));
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

test('F1: every known payment/price file is frozen by path (repository-wide, cannot regress)', async () => {
  const { execSync } = await import('node:child_process');
  const files = execSync("git ls-files app lib components scripts", { encoding: 'utf8' }).split('\n').filter(Boolean);
  const { readFileSync } = await import('node:fs');
  // Files that mention payment identifiers in their content but are not payment code.
  const NOT_PAYMENT = {
    'lib/ai-ledger-writer.ts': 'only imports the shared TLS helper previewPoolTls from sc19-payment-preview-tls.ts',
    'lib/competency-broker-tls.ts': 'only imports the shared TLS helper previewPoolTls from sc19-payment-preview-tls.ts',
    'lib/tenant-domain-network.ts': 'only imports the shared TLS helper previewPoolTls from sc19-payment-preview-tls.ts',
  };
  const missed = [];
  for (const f of files) {
    let text = ''; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (!/przelewy24|sc19-payment|P24_|fakturownia/i.test(text) || NOT_PAYMENT[f]) continue;
    if (!classifyRelease([f]).reasons.some(r => /^(PAYMENTS|PAYMENT_PATH_FREEZE):/.test(r))) missed.push(f);
  }
  assert.deepEqual(missed, []);
  for (const f of ['lib/sc19-payments.ts', 'lib/sc19-przelewy24-provider.ts', 'lib/sc19-fakturownia-provider.ts', 'lib/sc19-payment-http.ts',
    'lib/sc19-p24-diagnostic.ts', 'app/components/marketing/content.ts', 'app/components/marketing/package-comparison.tsx', 'app/preselekcja/page.tsx']) {
    assert.ok(classifyRelease([f]).reasons.length, f);
  }
});

test('payment content in changed lines is frozen whatever the file is called', () => {
  const r = p => evaluateCandidate({ ...base(), patches: [{ path: 'app/regulamin/page.tsx', patch: p }] }).reasons;
  assert.ok(r('+const x = createPrzelewy24Order()').includes('PAYMENT_CONTENT_FREEZE:app/regulamin/page.tsx'));
  assert.ok(r('-  cena: "300 zł brutto"').includes('PAYMENT_CONTENT_FREEZE:app/regulamin/page.tsx'));
  for (const line of ['+PRESELEKCJA za 300 zł brutto', '-<b>615 zł</b>', '+  label: "1 499 zł",', '+cena 300 zł', '-300 zł']) {
    assert.ok(r(line).includes('PAYMENT_CONTENT_FREEZE:app/regulamin/page.tsx'), line);
  }
  assert.ok(r('+ status = orders_status').includes('PAYMENT_CONTENT_FREEZE:app/regulamin/page.tsx'));
  assert.deepEqual(r(' context line with 300 zł only\n+nowy akapit regulaminu'), []);
  assert.ok(evaluateCandidate({ ...base(), patches: null }).reasons.includes('PAYMENT_CONTENT_UNREADABLE'));
});

test('N1: product code waits while integration has migrations not yet on production; docs may ship', () => {
  const pending = ['supabase/migrations/20261112100000_sc_method_profile.sql'];
  assert.ok(evaluateCandidate({ ...base(), unreleasedMigrations: pending }).reasons.includes('UNRELEASED_MIGRATIONS_PRECEDE'));
  assert.deepEqual(evaluateCandidate({ ...base(), files: ['README.md'], patches: [{ path: 'README.md', patch: '+x' }], unreleasedMigrations: pending }).reasons, []);
  assert.ok(evaluateCandidate({ ...base(), unreleasedMigrations: null }).reasons.includes('UNRELEASED_MIGRATIONS_UNKNOWN'));
});

test('F1b: every price line in the product (repository-wide) trips the content freeze when changed', async () => {
  const { execSync } = await import('node:child_process');
  const { paymentContentFindings } = await import('../tools/release/auto/policy.mjs');
  const lines = execSync("git grep -hE '[0-9][[:space:]]*zł' -- app lib components || true", { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'the product shows prices somewhere');
  const missed = lines.filter(l => !paymentContentFindings([{ path: 'x.tsx', patch: `+${l}` }]).length);
  assert.deepEqual(missed, []);
});

test('C2: every file that really sends mail/voice is refused by path (repository-wide); sending lines are refused anywhere', async () => {
  const { execSync } = await import('node:child_process');
  const { paymentContentFindings } = await import('../tools/release/auto/policy.mjs');
  const files = execSync("git grep -liE 'api\\.resend\\.com|RESEND_API_KEY|retell' -- app lib components scripts || true", { encoding: 'utf8' }).split('\n').filter(Boolean);
  const NOT_SENDER = { 'app/prywatnosc/page.tsx': 'privacy policy text names Resend as a processor; it sends nothing' };
  const missed = files.filter(f => !NOT_SENDER[f] && !classifyRelease([f]).reasons.some(r => r.startsWith('OUTBOUND_SENDS:')));
  assert.deepEqual(missed, []);
  for (const f of ['lib/sales-mail.ts', 'lib/sales-mail-server.ts', 'lib/sales-mail-template.ts', 'app/api/internal/sales-mail/route.ts', 'lib/cv-bulk.ts', 'app/api/internal/daily-digest/route.ts']) {
    assert.ok(classifyRelease([f]).reasons.some(r => r.startsWith('OUTBOUND_SENDS:')), f);
  }
  assert.deepEqual(paymentContentFindings([{ path: 'lib/x.ts', patch: "+await fetch('https://api.resend.com/emails')" }]), ['OUTBOUND_CONTENT:lib/x.ts']);
});

test('merge provenance: unknown or failed provenance refuses', () => {
  assert.ok(evaluateCandidate({ ...base(), provenance: null }).reasons.includes('MERGE_PROVENANCE_UNKNOWN'));
  assert.ok(evaluateCandidate({ ...base(), provenance: ['MERGE_NOT_CLEAN'] }).reasons.includes('MERGE_NOT_CLEAN'));
});

// C9 (#369): an unresolved review conversation blocks on its own. The `codex-review-state`
// marker codexGate looks for is published by nothing, so it can never be the only source.
test('C9: unresolved review threads and standing change requests refuse; missing evidence refuses', async () => {
  const { reviewThreadsGate, reviewStatesGate } = await import('../tools/release/auto/policy.mjs');
  assert.deepEqual(reviewThreadsGate([]), []);
  assert.deepEqual(reviewThreadsGate([{ resolved: true }, { resolved: true }]), []);
  assert.deepEqual(reviewThreadsGate(null), ['REVIEW_THREADS_UNKNOWN']);
  assert.deepEqual(reviewThreadsGate('x'), ['REVIEW_THREADS_UNKNOWN']);
  // outdated is not answered: the line moved, the finding did not go away
  assert.ok(reviewThreadsGate([{ resolved: false, outdated: true, path: 'lib/a.ts' }])[0].startsWith('REVIEW_THREADS_UNRESOLVED:1:'));
  assert.ok(reviewThreadsGate([{ resolved: undefined }])[0].startsWith('REVIEW_THREADS_UNRESOLVED:'));
  assert.ok(reviewThreadsGate([null])[0].startsWith('REVIEW_THREADS_UNRESOLVED:'));

  const rev = (state, at, extra = {}) => ({ user: { login: 'b' }, state, commit_id: H, submitted_at: at, ...extra });
  assert.deepEqual(reviewStatesGate([], H), []);
  assert.deepEqual(reviewStatesGate(null, H), ['REVIEW_STATES_UNKNOWN']);
  assert.deepEqual(reviewStatesGate([rev('CHANGES_REQUESTED', '2026-01-01T00:00:00Z')], H), ['REVIEW_CHANGES_REQUESTED:b']);
  // A COMMENTED review is not a decision and must NOT cancel a change request: GitHub records a
  // reply in a thread as one, and agent sessions write with the owner's identity (AGENTS.md
  // rule 5), so allowing it would let an agent clear the owner's objection.
  assert.deepEqual(reviewStatesGate([
    rev('CHANGES_REQUESTED', '2026-01-01T00:00:00Z'), rev('COMMENTED', '2026-01-02T00:00:00Z'),
  ], H), ['REVIEW_CHANGES_REQUESTED:b']);
  // only the author's own later APPROVED / DISMISSED clears it
  for (const state of ['APPROVED', 'DISMISSED']) {
    assert.deepEqual(reviewStatesGate([
      rev('CHANGES_REQUESTED', '2026-01-01T00:00:00Z'), rev(state, '2026-01-02T00:00:00Z'),
    ], H), [], state);
  }
  // …and an older APPROVED does not clear a newer change request
  assert.deepEqual(reviewStatesGate([
    rev('APPROVED', '2026-01-01T00:00:00Z'), rev('CHANGES_REQUESTED', '2026-01-02T00:00:00Z'),
  ], H), ['REVIEW_CHANGES_REQUESTED:b']);
  // equal timestamps must not decide in favour of releasing, whatever the array order
  assert.deepEqual(reviewStatesGate([rev('CHANGES_REQUESTED', '2026-01-01T00:00:00Z'), rev('APPROVED', '2026-01-01T00:00:00Z')], H), ['REVIEW_CHANGES_REQUESTED:b']);
  assert.deepEqual(reviewStatesGate([rev('APPROVED', '2026-01-01T00:00:00Z'), rev('CHANGES_REQUESTED', '2026-01-01T00:00:00Z')], H), ['REVIEW_CHANGES_REQUESTED:b']);
  // a change request on an earlier commit still stands: a new push does not answer an objection
  assert.deepEqual(reviewStatesGate([rev('CHANGES_REQUESTED', '2026-01-01T00:00:00Z', { commit_id: 'b'.repeat(40) })], H), ['REVIEW_CHANGES_REQUESTED:b']);
  // an unsubmitted review on the exact head blocks; unknown state or unparsable time refuse
  assert.deepEqual(reviewStatesGate([rev('PENDING', null)], H), ['REVIEW_PENDING_SUBMISSION:b']);
  assert.deepEqual(reviewStatesGate([rev('WAT', '2026-01-01T00:00:00Z')], H), ['REVIEW_STATE_UNREADABLE']);
  assert.deepEqual(reviewStatesGate([rev('APPROVED', 'nie-data')], H), ['REVIEW_STATE_UNREADABLE']);
  assert.deepEqual(reviewStatesGate([{ state: 'APPROVED' }], H), ['REVIEW_STATE_UNREADABLE']);

  // and the whole decision refuses when either is missing or open
  assert.ok(reasons(i => { i.reviewThreads = null; }).includes('REVIEW_THREADS_UNKNOWN'));
  assert.ok(reasons(i => { i.reviews = null; }).includes('REVIEW_STATES_UNKNOWN'));
  assert.ok(reasons(i => { i.reviewThreads = [{ resolved: false, path: 'lib/a.ts' }]; }).some(r => r.startsWith('REVIEW_THREADS_UNRESOLVED:')));
});

// C10 (#369): the screening worker is deployed by hand, so a change to it or to a module it
// shares with the app must not ship alone — the app would use a contract the worker does not.
test('C10: worker and its shared modules are held; the real closure covers the dispatch contract', async () => {
  const { workerGate } = await import('../tools/release/auto/policy.mjs');
  const { workerClosure, DISPATCH_COUNTERPARTS } = await import('../tools/release/auto/publisher.mjs');
  const { createGit } = await import('../tools/release/auto/git.mjs');
  const closure = ['supabase/functions/screening-worker/index.ts', 'lib/screening-hmac.ts'];
  assert.deepEqual(workerGate(['app/regulamin/page.tsx'], closure), []);
  assert.ok(workerGate(['lib/screening-hmac.ts'], closure)[0].startsWith('WORKER_DEPLOY_REQUIRED:'));
  assert.ok(workerGate(['supabase/functions/anything/index.ts'], [])[0].startsWith('WORKER_DEPLOY_REQUIRED:'));
  assert.deepEqual(workerGate(['app/x.tsx'], null), ['WORKER_SCOPE_UNKNOWN']);
  assert.deepEqual(workerGate(['app/x.tsx'], [1]), ['WORKER_SCOPE_UNKNOWN']);
  assert.deepEqual(workerGate(null, closure), ['WORKER_SCOPE_UNKNOWN']);
  assert.ok(reasons(i => { i.files = ['lib/screening-hmac.ts']; }).some(r => r.startsWith('WORKER_DEPLOY_REQUIRED:')));
  assert.ok(reasons(i => { i.workerModules = null; }).includes('WORKER_SCOPE_UNKNOWN'));

  // The closure is computed from this repository, not from a hand-kept list: it must contain
  // the worker entry, the shared signing module and the app-side sender of the same contract.
  const real = workerClosure({ git: createGit(process.cwd()) }, 'HEAD');
  assert.ok(real.includes('supabase/functions/screening-worker/index.ts'), 'worker entry');
  assert.ok(real.includes('lib/screening-hmac.ts'), 'shared dispatch signature module');
  for (const f of DISPATCH_COUNTERPARTS) assert.ok(real.includes(f), f);
  // Precision matters: holding unrelated UI files would take automation away for no reason.
  assert.deepEqual(real.filter(f => f.startsWith('app/')), []);
});

// C10b (#460 review): the closure must contain only real files. A specifier written without an
// extension used to enter it verbatim, which silently dropped that file and everything it imports
// — so a change to it would not be held. Checked against this repository, not a fixture.
test('C10b: the worker closure holds real files only, and covers extensionless imports', async () => {
  const { workerClosure } = await import('../tools/release/auto/publisher.mjs');
  const { createGit } = await import('../tools/release/auto/git.mjs');
  const git = createGit(process.cwd());
  const closure = workerClosure({ git }, 'HEAD');
  const ghosts = closure.filter(f => !git.ok('cat-file', '-e', `HEAD:${f}`));
  assert.deepEqual(ghosts, [], 'every entry of the closure exists in the tree');
  // lib/screening.ts imports './supabase/database.types' without an extension; the real file
  // must be in the closure under its true name.
  assert.ok(closure.includes('lib/screening.ts'), 'lib/screening.ts');
  assert.ok(closure.includes('lib/supabase/database.types.ts'), 'extensionless import resolved to the real file');
  assert.ok(closure.every(f => /\.(ts|tsx|mts|js|mjs)$/.test(f)), 'no bare specifiers');
});
