// #491 (owner's path B, 2026-11-17): applies the migrations of ONE automatic release to the
// production database, from the job `migrate` of `.github/workflows/auto-release.yml`
// (environment `auto-migrate`, secret AUTO_MIGRATE_DATABASE_URL).
//
// - Trusted code only: this file runs from the `main` checkout. The release commit is read as
//   data (SQL files of a detached worktree), never executed.
// - The release SHA must be the tip of the publisher's own branch `release/auto-pr-<N>`.
// - The migration list is computed HERE from that commit (files added under supabase/migrations/
//   since it left main), not taken from the request. Only new files; a changed or removed
//   migration file is refused.
// - DESTRUCTIVE_SQL is checked again with the publisher's own gate (defence in depth).
// - Applied one by one in order by tools/db-migrate/apply.mjs (same ledger: statements + sha256,
//   never `supabase db push`), stopping at the first error.
// - The connection string is never printed; only migration names, hashes and SQLSTATE codes.
//
// Outcome (job output `outcome`, read by the publisher's `finish` job):
//   { release_head, status: applied|failed|refused|unavailable|unknown, applied: [files], code }
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { apply, migrationName, sha256, tlsOptions, withoutTlsParameters } from '../../db-migrate/apply.mjs';
import { SHA, destructiveSql } from './policy.mjs';
import { createGit } from './git.mjs';

export const MIGRATIONS_DIR = 'supabase/migrations/';

export async function runMigrate({ request, git, databaseUrl, applyImpl = apply, readLedger, runId, ssl, log = () => {} }) {
  const head = SHA.test(request?.release_head ?? '') ? request.release_head : null;
  const out = (status, code, applied = []) => ({ release_head: head, status, applied, code: String(code).slice(0, 160) });
  // No secret: exactly today's behaviour, nothing is touched.
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) return out('unavailable', 'MIGRATION_EXECUTOR_UNAVAILABLE');
  if (!head || !Number.isInteger(request?.release_pr) || request.release_pr < 1) return out('refused', 'MIGRATION_REQUEST_INVALID');
  if (!runId) return out('refused', 'MIGRATION_RUN_ID_MISSING');

  let tip = null;
  try { tip = git('rev-parse', '--verify', `origin/release/auto-pr-${request.release_pr}^{commit}`).trim(); } catch { /* refused below */ }
  if (tip !== head) return out('refused', 'MIGRATION_REQUEST_NOT_RELEASE_HEAD');
  let base;
  try { base = git('merge-base', 'origin/main', head).trim(); } catch { return out('refused', 'MIGRATION_BASE_UNKNOWN'); }

  const changes = git('diff', '--name-status', '--no-renames', base, head, '--', MIGRATIONS_DIR)
    .split('\n').filter(Boolean).map(line => line.split('\t'));
  if (!changes.length) return out('refused', 'MIGRATION_LIST_EMPTY');
  const notNew = changes.find(([status]) => status !== 'A');
  if (notNew) return out('refused', `MIGRATION_FILE_NOT_NEW:${notNew[1]}`);
  const files = changes.map(([, path]) => path.slice(MIGRATIONS_DIR.length)).sort();
  if (files.some(f => !migrationName.test(f))) return out('refused', 'MIGRATION_NAME_INVALID');
  const sql = Object.fromEntries(files.map(f => [f, git('show', `${head}:${MIGRATIONS_DIR}${f}`)]));
  for (const f of files) {
    const kinds = destructiveSql(sql[f]);
    if (kinds.length) return out('refused', `DESTRUCTIVE_SQL:${kinds[0]}:${MIGRATIONS_DIR}${f}`);
  }

  // What production already holds. A run cut off after applying would otherwise retry and fail
  // on "already applied"; a half-applied batch must be reported as changed data.
  let ledger;
  try { ledger = await readLedger(); } catch { return out('refused', 'MIGRATION_LEDGER_UNREADABLE'); }
  const nameOf = f => f.match(migrationName)[2];
  const recorded = files.filter(f => ledger.names.has(nameOf(f)));
  if (recorded.length) {
    const sameHash = recorded.every(f => ledger.hashes.get(nameOf(f)) === sha256(sql[f]));
    if (sameHash && recorded.length === files.length) return out('applied', 'MIGRATIONS_ALREADY_APPLIED', files);
    return out('failed', sameHash ? 'MIGRATION_PARTIAL_STATE' : 'MIGRATION_LEDGER_MISMATCH', recorded);
  }

  const dir = mkdtempSync(join(tmpdir(), 'auto-migrate-'));
  const applied = [];
  try {
    if (!git.ok('worktree', 'add', '--detach', dir, head)) return out('refused', 'MIGRATION_CHECKOUT_FAILED');
    if (git('-C', dir, 'rev-parse', 'HEAD').trim() !== head) return out('refused', 'MIGRATION_CHECKOUT_MISMATCH');
    try {
      await applyImpl({
        databaseUrl, dir: pathToFileURL(join(dir, MIGRATIONS_DIR, '/')), files: files.join(','),
        expectedHashes: JSON.stringify(Object.fromEntries(files.map(f => [f, sha256(sql[f])]))),
        releaseSha: head, runId: String(runId), ssl, log, onApplied: f => applied.push(f),
      });
    } catch (error) {
      const at = error?.file ?? (applied.length ? files[applied.length] : 'NONE_STARTED');
      const code = `MIGRATION_FAILED:${at}:${typeof error?.sqlstate === 'string' ? error.sqlstate : 'ERR'}`;
      log(code);
      return out('failed', code, applied);
    }
    if (applied.join(',') !== files.join(',')) return out('failed', 'MIGRATION_SET_MISMATCH', applied);
    return out('applied', 'MIGRATIONS_APPLIED', applied);
  } finally {
    git.ok('worktree', 'remove', '--force', dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reads only migration names and file hashes (no secret columns), in a read-only transaction.
export function createLedgerReader({ databaseUrl, ssl }) {
  return async () => {
    const client = new pg.Client({ connectionString: ssl ? withoutTlsParameters(databaseUrl) : databaseUrl, ssl, application_name: 'skillcheck-auto-migrate' });
    await client.connect();
    try {
      await client.query('begin read only');
      const exists = (await client.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as m,
        to_regclass('supabase_migrations.skillcheck_migration_ledger') is not null as l`)).rows[0];
      const names = new Set(); const hashes = new Map();
      if (exists.m) for (const r of (await client.query('select name from supabase_migrations.schema_migrations where name is not null')).rows) names.add(r.name);
      if (exists.l) for (const r of (await client.query('select name, sha256 from supabase_migrations.skillcheck_migration_ledger')).rows) { names.add(r.name); hashes.set(r.name, r.sha256); }
      await client.query('rollback');
      return { names, hashes };
    } finally { await client.end(); }
  };
}

async function main() {
  let request = null;
  try { request = JSON.parse(process.env.MIGRATION_REQUEST ?? ''); } catch { /* refused as invalid */ }
  const databaseUrl = process.env.AUTO_MIGRATE_DATABASE_URL ?? '';
  let outcome;
  try {
    const ssl = databaseUrl.trim() ? tlsOptions(process.env.AUTO_MIGRATE_DATABASE_CA_CERT) : undefined;
    outcome = await runMigrate({
      request, git: createGit(), databaseUrl, ssl, runId: process.env.GITHUB_RUN_ID,
      readLedger: createLedgerReader({ databaseUrl, ssl }), log: line => console.log(line),
    });
  } catch {
    // Something threw outside the apply step; what reached the database is not known.
    outcome = { release_head: SHA.test(request?.release_head ?? '') ? request.release_head : null, status: 'unknown', applied: null, code: 'MIGRATION_RUNNER_ERROR' };
  }
  const json = JSON.stringify(outcome);
  console.log(json);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${json}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Auto-migrate: ${outcome.status}\n\n\`\`\`json\n${JSON.stringify(outcome, null, 2)}\n\`\`\`\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
