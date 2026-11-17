// #491 (owner's path B, 2026-11-17): the migrate job of the automatic publisher, offline.
// Real git (temporary repositories); the database side (apply.mjs, ledger) is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGit } from '../tools/release/auto/git.mjs';
import { runMigrate } from '../tools/release/auto/migrate.mjs';
import { readBackups } from '../tools/release/auto/backups.mjs';
import { sha256 } from '../tools/db-migrate/apply.mjs';
import { evaluateCandidate } from '../tools/release/auto/policy.mjs';

Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const write = (dir, file, text) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };

const BASE = '20261101000000_base.sql';
const A = '20261117000100_add_notes.sql';
const B = '20261117000200_add_notes_index.sql';
const SQL = {
  [A]: 'begin;\ncreate table public.notes(id int);\ncommit;\n',
  [B]: 'begin;\ncreate index notes_id on public.notes(id);\ncommit;\n',
};
const URL_SECRET = 'postgresql://user:VerySecretPassword@db.example.invalid:5432/postgres';

// origin with main (one applied migration) and the publisher's release branch adding `files`.
function fixture(files = SQL, { modifyBase = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'auto-migrate-'));
  const origin = join(root, 'origin.git'); const work = join(root, 'work');
  createGit(root)('init', '--bare', '-b', 'main', origin);
  createGit(root)('clone', origin, work);
  const g = createGit(work);
  write(work, `supabase/migrations/${BASE}`, 'begin;\ncreate table public.base(id int);\ncommit;\n');
  g('add', '.'); g('commit', '-m', 'init'); g('push', 'origin', 'main');
  g('checkout', '-b', 'release/auto-pr-900');
  // Written in reverse order on purpose: the runner must apply in repository order.
  for (const [f, t] of Object.entries(files).reverse()) write(work, `supabase/migrations/${f}`, t);
  if (modifyBase) write(work, `supabase/migrations/${BASE}`, 'begin;\ncreate table public.base2(id int);\ncommit;\n');
  g('add', '.'); g('commit', '-m', 'release'); g('push', 'origin', 'release/auto-pr-900');
  const head = g('rev-parse', 'HEAD').trim();
  const runner = join(root, 'runner');
  createGit(root)('clone', origin, runner); // like actions/checkout with fetch-depth 0: every branch
  return { git: createGit(runner), head };
}

const emptyLedger = async () => ({ names: new Set(['base']), hashes: new Map() });
function fakeApply(behaviour = 'ok') {
  const calls = [];
  const fn = async args => {
    calls.push(args);
    const files = args.files.split(',');
    // the runner hands apply.mjs the full migrations folder of the release commit
    assert.deepEqual(readdirSync(fileURLToPath(args.dir)).sort(), [BASE, ...files].sort());
    for (const [i, f] of files.entries()) {
      if (behaviour === 'fail-second' && i === 1) throw Object.assign(new Error(`${f} failed and was rolled back`), { file: f, sqlstate: '42P01' });
      args.onApplied(f);
    }
    return files.map(file => ({ file }));
  };
  return { fn, calls };
}
const run = (fx, over = {}) => runMigrate({
  request: { release_pr: 900, release_head: fx.head, source_pr: 100 }, git: fx.git, databaseUrl: URL_SECRET,
  readLedger: emptyLedger, runId: '42', ssl: { rejectUnauthorized: false }, ...over,
});

test('#491: no secret -> unavailable, exactly as today; nothing is read or applied', async () => {
  const fx = fixture();
  const apply = fakeApply();
  let ledgerRead = false;
  for (const databaseUrl of [undefined, '', '   ']) {
    const r = await run(fx, { databaseUrl, applyImpl: apply.fn, readLedger: async () => { ledgerRead = true; return emptyLedger(); } });
    assert.deepEqual(r, { release_head: fx.head, status: 'unavailable', applied: [], code: 'MIGRATION_EXECUTOR_UNAVAILABLE' });
  }
  assert.equal(apply.calls.length, 0); assert.equal(ledgerRead, false);
});

test('#491: success applies every new migration once, in repository order, bound to the release SHA and file hashes', async () => {
  const fx = fixture();
  const apply = fakeApply();
  const lines = [];
  const r = await run(fx, { applyImpl: apply.fn, log: l => lines.push(l) });
  assert.deepEqual(r, { release_head: fx.head, status: 'applied', applied: [A, B], code: 'MIGRATIONS_APPLIED' });
  assert.equal(apply.calls.length, 1);
  const c = apply.calls[0];
  assert.equal(c.files, `${A},${B}`);
  assert.equal(c.releaseSha, fx.head); assert.equal(c.runId, '42');
  assert.deepEqual(JSON.parse(c.expectedHashes), { [A]: sha256(SQL[A]), [B]: sha256(SQL[B]) });
  assert.equal(fx.git('worktree', 'list').trim().split('\n').length, 1, 'worktree removed');
  assert.ok(lines.every(l => !l.includes('VerySecretPassword')));
});

test('#491: error mid-batch stops there and reports exactly what already committed', async () => {
  const fx = fixture();
  const apply = fakeApply('fail-second');
  const lines = [];
  const r = await run(fx, { applyImpl: apply.fn, log: l => lines.push(l) });
  assert.deepEqual(r, { release_head: fx.head, status: 'failed', applied: [A], code: `MIGRATION_FAILED:${B}:42P01` });
  assert.ok(lines.every(l => !l.includes('VerySecretPassword')), 'connection string never logged');
  // A failure before anything committed reports an empty list (no data changed).
  const early = await run(fx, { applyImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.deepEqual(early, { release_head: fx.head, status: 'failed', applied: [], code: 'MIGRATION_FAILED:NONE_STARTED:ERR' });
});

test('#491: destructive SQL is refused again in the migrate job before anything runs', async () => {
  const fx = fixture({ [A]: SQL[A], '20261117000300_cleanup.sql': 'begin;\ndelete from public.notes;\ncommit;\n' });
  const apply = fakeApply();
  const r = await run(fx, { applyImpl: apply.fn });
  assert.equal(r.status, 'refused'); assert.equal(r.code, 'DESTRUCTIVE_SQL:DELETE:supabase/migrations/20261117000300_cleanup.sql');
  assert.equal(apply.calls.length, 0);
});

test('#491: only the head of the publisher\'s own release branch, only new migration files', async () => {
  const fx = fixture();
  const apply = fakeApply();
  const other = await run(fx, { applyImpl: apply.fn, request: { release_pr: 900, release_head: 'f'.repeat(40) } });
  assert.equal(other.code, 'MIGRATION_REQUEST_NOT_RELEASE_HEAD');
  const wrongPr = await run(fx, { applyImpl: apply.fn, request: { release_pr: 901, release_head: fx.head } });
  assert.equal(wrongPr.code, 'MIGRATION_REQUEST_NOT_RELEASE_HEAD');
  for (const request of [null, {}, { release_pr: '900', release_head: fx.head }, { release_pr: 900, release_head: 'main' }]) {
    assert.equal((await run(fx, { applyImpl: apply.fn, request })).code, 'MIGRATION_REQUEST_INVALID');
  }
  const changed = fixture(SQL, { modifyBase: true });
  const r = await run(changed, { applyImpl: apply.fn });
  assert.deepEqual([r.status, r.code], ['refused', `MIGRATION_FILE_NOT_NEW:supabase/migrations/${BASE}`]);
  assert.equal(apply.calls.length, 0);
});

test('#491: ledger: all already applied with the same hash is success; partial or different is changed data', async () => {
  const fx = fixture();
  const apply = fakeApply();
  const ledger = (names, hashes) => async () => ({ names: new Set(['base', ...names]), hashes: new Map(hashes) });
  const all = await run(fx, { applyImpl: apply.fn, readLedger: ledger(['add_notes', 'add_notes_index'], [['add_notes', sha256(SQL[A])], ['add_notes_index', sha256(SQL[B])]]) });
  assert.deepEqual(all, { release_head: fx.head, status: 'applied', applied: [A, B], code: 'MIGRATIONS_ALREADY_APPLIED' });
  const part = await run(fx, { applyImpl: apply.fn, readLedger: ledger(['add_notes'], [['add_notes', sha256(SQL[A])]]) });
  assert.deepEqual(part, { release_head: fx.head, status: 'failed', applied: [A], code: 'MIGRATION_PARTIAL_STATE' });
  const diff = await run(fx, { applyImpl: apply.fn, readLedger: ledger(['add_notes', 'add_notes_index'], [['add_notes', 'x'], ['add_notes_index', sha256(SQL[B])]]) });
  assert.equal(diff.code, 'MIGRATION_LEDGER_MISMATCH');
  const unreadable = await run(fx, { applyImpl: apply.fn, readLedger: async () => { throw new Error('down'); } });
  assert.deepEqual([unreadable.status, unreadable.code, unreadable.applied], ['refused', 'MIGRATION_LEDGER_UNREADABLE', []]);
  assert.equal(apply.calls.length, 0);
});

test('#491: policy: executor + fresh backup + additive migration is allowed; each missing condition refuses on its own', () => {
  const H = 'a'.repeat(40); const M = 'b'.repeat(40);
  const input = over => ({
    pr: { number: 7, merged: true, head_sha: H, merge_commit_sha: M, base_ref: 'integration' },
    files: [`supabase/migrations/${A}`], migrations: [{ path: `supabase/migrations/${A}`, sql: SQL[A] }],
    checkRuns: ['verify', 'Agent contract / scope gate'].map(name => ({ name, head_sha: H, status: 'completed', conclusion: 'success', started_at: 'x' })),
    comments: [{ author_association: 'OWNER', created_at: 'x', body: `<!-- sc-review-verdict:v1 ${JSON.stringify({ verdict: 'PASS', head_sha: H, reviewer: 'session_REVIEWER01', builder: 'session_BUILDER001' })} -->` }],
    migrationExecutor: true, backups: [{ status: 'COMPLETED', inserted_at: '2026-11-17T03:00:00Z' }], now: new Date('2026-11-17T12:00:00Z'),
    patches: [], unreleasedMigrations: [], provenance: [], reviewThreads: [], reviews: [], workerModules: [], ...over,
  });
  assert.deepEqual(evaluateCandidate(input({})), { decision: 'ALLOW', reasons: [], migrations: [`supabase/migrations/${A}`] });
  assert.deepEqual(evaluateCandidate(input({ migrationExecutor: false })).reasons, ['MIGRATION_EXECUTOR_UNAVAILABLE']);
  assert.deepEqual(evaluateCandidate(input({ backups: null })).reasons, ['BACKUP_EVIDENCE_MISSING']);
  assert.deepEqual(evaluateCandidate(input({ backups: [{ status: 'FAILED', inserted_at: '2026-11-17T03:00:00Z' }] })).reasons, ['BACKUP_NOT_COMPLETED']);
  assert.deepEqual(evaluateCandidate(input({ backups: [{ status: 'COMPLETED', inserted_at: '2026-11-16T11:59:00Z' }] })).reasons, ['BACKUP_STALE']);
  assert.deepEqual(evaluateCandidate(input({ migrations: [{ path: `supabase/migrations/${A}`, sql: 'begin;\ntruncate public.notes;\ncommit;\n' }] })).reasons,
    [`DESTRUCTIVE_SQL:TRUNCATE:supabase/migrations/${A}`]);
});

test('#491: backup evidence reader: GET only, fail closed, keeps status and time only', async () => {
  const seen = [];
  const ok = async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => ({ backups: [{ status: 'COMPLETED', inserted_at: '2026-11-17T03:00:00Z', is_physical_backup: true }] }) }; };
  assert.equal(await readBackups({ token: '', fetchImpl: ok }), null);
  assert.equal(await readBackups({ fetchImpl: ok }), null);
  assert.equal(seen.length, 0, 'no token, no call');
  assert.deepEqual(await readBackups({ token: 'tok', fetchImpl: ok }), [{ status: 'COMPLETED', inserted_at: '2026-11-17T03:00:00Z' }]);
  assert.equal(seen[0].url, 'https://api.supabase.com/v1/projects/wsvjawuikxfzjyivxgsu/database/backups');
  assert.equal(seen[0].init.method, 'GET'); assert.ok(!seen[0].url.includes('tok'));
  assert.equal(await readBackups({ token: 'tok', fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), null);
  assert.equal(await readBackups({ token: 'tok', fetchImpl: async () => ({ ok: true, json: async () => ({ backups: 'x' }) }) }), null);
  assert.equal(await readBackups({ token: 'tok', fetchImpl: async () => { throw new Error('net'); } }), null);
});

test('#491: workflow: secret only in the auto-migrate jobs, App keys never there, no production-approval', () => {
  const wf = readFileSync(new URL('../.github/workflows/auto-release.yml', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const jobs = Object.fromEntries(wf.slice(wf.indexOf('\njobs:\n')).split(/\n(?=  [a-z]+:\n)/).slice(1).map(b => [b.match(/^ {2}([a-z]+):/)[1], b]));
  assert.deepEqual(Object.keys(jobs), ['executor', 'publish', 'migrate', 'finish']);
  for (const name of ['executor', 'migrate']) {
    assert.match(jobs[name], /environment: auto-migrate\n/);
    assert.doesNotMatch(jobs[name], /AGENT_PIPELINE_APP|SUPABASE_ACCESS_TOKEN/);
  }
  for (const name of ['publish', 'finish']) {
    assert.match(jobs[name], /environment: agent-control\n/);
    assert.doesNotMatch(jobs[name], /AUTO_MIGRATE_DATABASE/);
  }
  assert.match(jobs.executor, /permissions: \{\}/);
  assert.match(jobs.executor, /if \[ -n "\$AUTO_MIGRATE_DATABASE_URL" \]/); // presence only
  assert.match(jobs.migrate, /AUTO_MIGRATE_DATABASE_URL: \$\{\{ secrets\.AUTO_MIGRATE_DATABASE_URL \}\}/);
  assert.match(jobs.migrate, /run: node tools\/release\/auto\/migrate\.mjs/);
  assert.match(jobs.migrate, /ref: main/);
  assert.match(jobs.publish, /AUTO_MIGRATE_EXECUTOR: \$\{\{ needs\.executor\.outputs\.ready == 'true' && 'true' \|\| 'false' \}\}/);
  assert.match(jobs.finish, /MIGRATION_OUTCOME: \$\{\{ needs\.migrate\.outputs\.outcome \}\}/);
  // The deployment check matches /production/i: no job environment may carry that word.
  assert.deepEqual([...wf.matchAll(/environment: (\S+)/g)].map(m => m[1]).filter(e => /production/i.test(e)), []);
  assert.doesNotMatch(wf, /production-approval|PRODUCTION_DATABASE_URL|supabase db push|workflow_dispatch/);
});
