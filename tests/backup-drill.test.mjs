// SC-AUTO-RELEASE (#369) point 5: pure parts of the nightly restore drill.
// (The full drill was run against two disposable local Postgres 17.6 containers; see PR.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyRestoreErrors, validateSourceUrl, parseCounts, compareCounts, pendingMigrations, EXCLUDED_SQL, SCHEMAS_SQL } from '../tools/release/backup-drill/drill.mjs';

test('source must be a remote TLS Postgres URL', () => {
  assert.equal(validateSourceUrl('postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require'), null);
  assert.equal(validateSourceUrl('postgresql://u:p@db.example.com/postgres'), 'SOURCE_URL_TLS_REQUIRED');
  assert.equal(validateSourceUrl('postgresql://u:p@db.example.com/postgres?sslmode=disable'), 'SOURCE_URL_TLS_REQUIRED');
  assert.equal(validateSourceUrl('postgresql://u:p@localhost/postgres?sslmode=require'), 'SOURCE_URL_LOCAL');
  assert.equal(validateSourceUrl('mysql://x'), 'SOURCE_URL_INVALID');
  assert.equal(validateSourceUrl(''), 'SOURCE_URL_INVALID');
});

test('completeness: missing tables and different row counts are reported; excluded data is skipped', () => {
  const src = parseCounts('public.a=10\npublic.b=5\nauth.users=3\nnoise\n');
  assert.deepEqual(src, { 'public.a': 10, 'public.b': 5, 'auth.users': 3 });
  assert.deepEqual(compareCounts(src, { 'public.a': 10, 'public.b': 5, 'auth.users': 0 }, ['auth.users']), { tables: 2, rows: 15, missing: [], mismatched: [] });
  assert.deepEqual(compareCounts(src, { 'public.a': 9 }, ['auth.users']), { tables: 2, rows: 15, missing: ['public.b'], mismatched: ['public.a:10->9'] });
});

test('pending migrations = repository files not in the production ledger, in order', () => {
  const files = ['20261116000000_b.sql', '20260930000100_a.sql', 'README.md', '20261117000000_c.sql'];
  assert.deepEqual(pendingMigrations(files, ['20260930000100', '20261116000000']), ['20261117000000_c.sql']);
});

test('secret-bearing tables and live auth sessions are excluded from the dump; internal schemas skipped', () => {
  for (const word of ['secret', 'token', 'password', 'sessions', 'refresh_tokens', 'pseudonym']) assert.match(EXCLUDED_SQL, new RegExp(word));
  for (const schema of ['vault', 'storage', 'pgsodium']) assert.match(SCHEMAS_SQL, new RegExp(`'${schema}'`));
});

test('workflow: nightly, no manual start, disposable database, no production-approval environment', () => {
  const wf = readFileSync(new URL('../.github/workflows/backup-restore-drill.yml', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.match(wf, /schedule:/);
  assert.doesNotMatch(wf, /workflow_dispatch/);
  assert.doesNotMatch(wf, /production-approval/);
  assert.doesNotMatch(wf, /PRODUCTION_DATABASE_URL|SUPABASE_ACCESS_TOKEN/);
  assert.doesNotMatch(wf, /upload-artifact/, 'the dump must never leave the runner');
  assert.match(wf, /BACKUP_DRILL_DATABASE_URL/);
});

test('C3: restore errors fail the drill unless expected (public schema, FK to excluded data)', () => {
  const fk = t => `pg_restore: error: could not execute query: ERROR:  insert or update on table "companies" violates foreign key constraint "c_fk"\nDETAIL:  Key (owner)=(x) is not present in table "${t}".\nCommand was: ALTER TABLE ...\n`;
  const pub = 'pg_restore: error: could not execute query: ERROR:  schema "public" already exists\nCommand was: CREATE SCHEMA public;\n';
  const other = 'pg_restore: error: could not execute query: ERROR:  function extensions.uuid_generate_v4() does not exist\n';
  assert.deepEqual(classifyRestoreErrors(pub + fk('users'), ['auth.users']), { expected: 2, unexpected: 0 });
  assert.deepEqual(classifyRestoreErrors(fk('companies'), ['auth.users']), { expected: 0, unexpected: 1 });
  assert.deepEqual(classifyRestoreErrors(other + 'pg_restore: warning: errors ignored on restore: 1\n', []), { expected: 0, unexpected: 1 });
  assert.deepEqual(classifyRestoreErrors('', []), { expected: 0, unexpected: 0 });
});
