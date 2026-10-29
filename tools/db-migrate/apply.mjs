// SC-OPS-DB-MIGRATE: applies an approved list of checked-in migrations to one
// database, one transaction per migration, in repository order. Used by
// .github/workflows/db-migrate-production.yml; never `supabase db push`.
//
// Each migration file must be framed as `begin; ... commit;`. The runner removes
// exactly that frame and runs the body inside its own transaction together with
// the history rows, so a migration and its record commit or fail together:
//   - supabase_migrations.schema_migrations(version, name, statements)
//   - supabase_migrations.skillcheck_migration_ledger (sha256, statements,
//     release SHA, workflow run) — statements are never NULL.
// A migration whose name is already recorded is refused before anything runs,
// as is any unrecorded earlier repository migration missing from the list.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const migrationName = /^(\d{14})_([a-z0-9_]+)\.sql$/;
export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

export function parseList(value) {
  const files = String(value ?? '').split(/[\s,]+/).filter(Boolean);
  if (!files.length) throw new Error('No migrations listed');
  for (const file of files) if (!migrationName.test(file)) throw new Error(`Invalid migration file name: ${file}`);
  if (new Set(files).size !== files.length) throw new Error('Duplicate migration in list');
  for (let i = 1; i < files.length; i++) {
    if (files[i] <= files[i - 1]) throw new Error(`Migrations must be listed in repository order: ${files[i - 1]} before ${files[i]}`);
  }
  return files;
}

// Returns the body between the single standalone `begin;` (first statement)
// and the single standalone `commit;` (last statement).
export function unframe(sql, file) {
  const lines = sql.split('\n');
  const begins = lines.flatMap((line, i) => line.trim() === 'begin;' ? [i] : []);
  const commits = lines.flatMap((line, i) => line.trim() === 'commit;' ? [i] : []);
  if (begins.length !== 1 || commits.length !== 1) throw new Error(`${file}: expected exactly one standalone begin; and commit;`);
  const meaningful = lines.map((line, i) => [line.trim(), i]).filter(([line]) => line && !line.startsWith('--'));
  if (meaningful[0][1] !== begins[0] || meaningful.at(-1)[1] !== commits[0]) {
    throw new Error(`${file}: begin; must be the first and commit; the last statement`);
  }
  return lines.slice(begins[0] + 1, commits[0]).join('\n');
}

export async function loadMigrations(dir, files) {
  const available = new Set((await readdir(dir)).filter(name => migrationName.test(name)));
  return Promise.all(files.map(async file => {
    if (!available.has(file)) throw new Error(`Migration not found in repository: ${file}`);
    const sql = await readFile(new URL(file, dir), 'utf8');
    const [, version, name] = file.match(migrationName);
    return { file, version, name, sql, hash: sha256(sql), body: unframe(sql, file) };
  }));
}

const ledgerDdl = `create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);
create table if not exists supabase_migrations.skillcheck_migration_ledger(
  name text primary key,
  version text not null,
  file text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  statements text not null,
  release_sha text not null check (release_sha ~ '^[0-9a-f]{40}$'),
  run_id text not null,
  applied_by text not null default current_user,
  applied_at timestamptz not null default now()
);
revoke all on supabase_migrations.skillcheck_migration_ledger from public;`;

// Repository migrations ordered before the last listed one that are neither
// recorded (by name; production versions differ) nor listed.
export function unappliedGaps(repositoryFiles, listedFiles, recordedNames) {
  const listed = new Set(listedFiles), last = listedFiles.at(-1);
  return repositoryFiles.filter(file => migrationName.test(file) && file < last && !listed.has(file)
    && !recordedNames.has(file.match(migrationName)[2])).sort();
}

export async function plan(client, dir, migrations) {
  const recorded = new Set((await client.query(`select name from supabase_migrations.schema_migrations where name is not null
    union select name from supabase_migrations.skillcheck_migration_ledger`)).rows.map(row => row.name));
  for (const m of migrations) if (recorded.has(m.name)) throw new Error(`Already applied, never re-run: ${m.file}`);
  const gaps = unappliedGaps(await readdir(dir), migrations.map(m => m.file), recorded);
  if (gaps.length) throw new Error(`Earlier repository migrations are neither applied nor listed: ${gaps.join(', ')}`);
}

export async function apply({ databaseUrl, dir, files, expectedHashes, releaseSha, runId, log = console.log, ssl }) {
  if (!/^[0-9a-f]{40}$/.test(releaseSha ?? '')) throw new Error('RELEASE_SHA must be a full commit SHA');
  if (!runId) throw new Error('RUN_ID required');
  const migrations = await loadMigrations(dir, parseList(files));
  if (expectedHashes) {
    const expected = JSON.parse(expectedHashes);
    for (const m of migrations) if (expected[m.file] !== m.hash) throw new Error(`File changed since the approved plan: ${m.file}`);
    if (Object.keys(expected).length !== migrations.length) throw new Error('Approved plan and migration list differ');
  }
  const client = new pg.Client({ connectionString: databaseUrl, ssl, application_name: 'skillcheck-db-migrate' });
  await client.connect();
  try {
    await client.query(ledgerDdl);
    await plan(client, dir, migrations);
    for (const m of migrations) {
      log(`applying ${m.file} sha256=${m.hash}`);
      await client.query("begin; set local lock_timeout='5s'; set local statement_timeout='15min'");
      try {
        await client.query(m.body);
        await client.query('reset role');
        await client.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,array[$3::text])',
          [m.version, m.name, m.sql]);
        await client.query(`insert into supabase_migrations.skillcheck_migration_ledger(name,version,file,sha256,statements,release_sha,run_id)
          values($1,$2,$3,$4,$5,$6,$7)`, [m.name, m.version, m.file, m.hash, m.sql, releaseSha, String(runId)]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw new Error(`${m.file} failed and was rolled back; later migrations were not run: ${error.message}`);
      }
      log(`applied ${m.file}`);
    }
    return migrations.map(({ file, hash }) => ({ file, hash }));
  } finally { await client.end(); }
}

// TLS is always on. With the project's CA certificate (secret DATABASE_CA_CERT)
// the server certificate is verified; without it the connection is encrypted
// but unverified, and the run says so.
export function tlsOptions(ca) {
  if (ca?.includes('BEGIN CERTIFICATE')) return { ca, rejectUnauthorized: true };
  console.log('::warning::DATABASE_CA_CERT not set: TLS without server certificate verification');
  return { rejectUnauthorized: false };
}

async function main() {
  const [command] = process.argv.slice(2);
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const migrations = await loadMigrations(dir, parseList(process.env.MIGRATIONS));
  if (command === 'plan') {
    const hashes = Object.fromEntries(migrations.map(m => [m.file, m.hash]));
    console.log(JSON.stringify(hashes));
    return;
  }
  if (command !== 'apply') throw new Error('Usage: apply.mjs plan|apply');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL secret missing in the production-approval environment');
  await apply({ databaseUrl: process.env.DATABASE_URL, dir, files: process.env.MIGRATIONS,
    expectedHashes: process.env.EXPECTED_HASHES, releaseSha: process.env.RELEASE_SHA, runId: process.env.RUN_ID,
    ssl: tlsOptions(process.env.DATABASE_CA_CERT) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`::error::${error.message}`); process.exit(1); });
}
