import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const yml = readFileSync(new URL('../.github/workflows/preview-db-migrate.yml', import.meta.url), 'utf8');
const list = readFileSync(new URL('../supabase/preview-migrations.txt', import.meta.url), 'utf8');

test('preview migrations run only against skillcheck-preview, never production', () => {
  assert.match(yml, /PREVIEW_REF: orbyscrupgnupifzlqxp/);
  assert.match(yml, /PRODUCTION_REF: wsvjawuikxfzjyivxgsu/);
  assert.match(yml, /\*"\$PRODUCTION_REF"\*\) echo "::error::Refusing/);
  assert.match(yml, /\*"\$PREVIEW_REF"\*\) ;; \*\) echo "::error::Refusing/);
  assert.match(yml, /^\s+environment: preview-db$/m);
  assert.doesNotMatch(yml, /production-approval|db push|supabase link|secrets set/);
  assert.equal(yml.match(/secrets\./g).length, 1);
  assert.doesNotMatch(yml, /echo[^\n]*DATABASE_URL\b(?!:-}|" in| is not set)/);
});

test('trigger is limited to integration and preview-db/** pushes with read-only token', () => {
  const triggers = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.match(triggers, /- integration\n\s+- 'preview-db\/\*\*'/);
  assert.doesNotMatch(triggers, /pull_request|schedule|workflow_run|repository_dispatch|main/);
  assert.match(yml, /^permissions: \{\}$/m);
  assert.doesNotMatch(yml, /: write/);
  assert.match(yml, /persist-credentials: false/);
  for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
});

test('every listed migration exists and is a checked-in file name', () => {
  const entries = list.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry, /^[0-9]{14}_[a-z0-9_]+\.sql$/);
    assert.ok(existsSync(new URL(`../supabase/migrations/${entry}`, import.meta.url)), entry);
  }
  assert.deepEqual([...entries].sort(), entries, 'listed in migration order');
});

test('a listed migration edited after reaching preview fails unless its resync is acknowledged', () => {
  assert.match(yml, /ledger_sha" = "\$body_sha" \]; then echo "skip/);
  assert.match(yml, /grep -qxF "\$body_sha  \$file  \$ledger_sha" supabase\/preview-resynced\.txt/);
  assert.match(yml, /::error::\$file changed after it was applied to preview/);
  const acks = readFileSync(new URL('../supabase/preview-resynced.txt', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#'));
  for (const line of acks) {
    assert.match(line, /^[0-9a-f]{64} {2}[0-9]{14}_[a-z0-9_]+\.sql {2}[0-9a-f]{64}$/);
    const [sha, file] = line.split('  ');
    // Same text the job hashes: the file without trailing newlines ($(cat file)).
    const text = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').replace(/\n+$/, '');
    assert.equal(createHash('sha256').update(text).digest('hex'), sha, `${file}: acknowledged hash must match the file`);
  }
  assert.match(yml, /where version = \(select max\(version\)/, 'resync rewrites only the newest ledger row');
});

test('each migration and its ledger row are applied in one transaction', () => {
  const step = yml.slice(yml.indexOf('echo "apply  $file"'), yml.indexOf('applied=$((applied+1))'));
  assert.match(step, /insert into supabase_migrations\.schema_migrations/);
  assert.equal(step.match(/\| psql /g)?.length, 1, 'migration body and ledger insert go through a single psql call');
  assert.doesNotMatch(step, /psql "\$DATABASE_URL"[^|\n]*-f "\$path"/, 'no separate psql run of the migration file');
  assert.match(step, /must open exactly one top-level begin;/);
  assert.match(step, /must end with its only top-level commit;/);
  // Every preview-listed migration fits the shape the workflow requires.
  for (const entry of list.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)) {
    const lines = readFileSync(new URL(`../supabase/migrations/${entry}`, import.meta.url), 'utf8').split('\n');
    assert.equal(lines.filter(l => /^begin;\s*$/.test(l)).length, 1, entry);
    const commits = lines.flatMap((l, i) => /^commit;\s*$/.test(l) ? [i] : []);
    const last = lines.findLastIndex(l => l.trim() !== '');
    assert.deepEqual(commits, [last], `${entry}: single top-level commit; as the last statement`);
  }
});

// Runs the real workflow step against a scratch PostgreSQL when one is provided (CI: SC19_TEST_DATABASE_URL).
const pgUrl = process.env.PREVIEW_MIGRATE_TEST_DATABASE_URL;
test('apply step: a failing migration leaves no ledger row; a good one is recorded once', { skip: !pgUrl && 'PREVIEW_MIGRATE_TEST_DATABASE_URL not set' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const admin = sql => execFileSync('psql', [pgUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
  // Own scratch database, so the shared CI database (and its real supabase_migrations, if any) is untouched.
  const database = `preview_migrate_wf_${process.pid}`;
  admin(`drop database if exists ${database}`);
  admin(`create database ${database}`);
  const url = new URL(pgUrl); url.pathname = `/${database}`;
  const dbUrl = url.toString();
  const psql = sql => execFileSync('psql', [dbUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
  const schema = 'wf_app';
  psql(`create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);`);
  const dir = mkdtempSync(join(tmpdir(), 'preview-migrate-'));
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
  writeFileSync(join(dir, 'supabase/migrations/20990101000000_good.sql'), `-- comment\nbegin;\ncreate schema ${schema};\ncreate table ${schema}.t(x int);\ncommit;\n`);
  writeFileSync(join(dir, 'supabase/migrations/20990101000100_bad.sql'), `begin;\ncreate table ${schema}.u(x int);\nselect 1/0;\ncommit;\n`);
  writeFileSync(join(dir, 'supabase/preview-migrations.txt'), '20990101000000_good.sql\n20990101000100_bad.sql\n');
  const script = yml.slice(yml.indexOf('applied=0'), yml.indexOf('done < supabase/preview-migrations.txt') + 'done < supabase/preview-migrations.txt'.length)
    .split('\n').map(l => l.replace(/^ {10}/, '')).join('\n');
  const run = () => { try { execFileSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: dir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' }); return 0; } catch { return 1; } };
  assert.equal(run(), 1, 'bad migration fails the job');
  assert.equal(psql(`select string_agg(name, ',' order by name) from supabase_migrations.schema_migrations`), 'good');
  assert.equal(psql(`select count(*) from pg_tables where schemaname = '${schema}'`), '1', 'bad migration fully rolled back');
  assert.match(psql(`select statements[1] from supabase_migrations.schema_migrations where name = 'good'`), /create table/);
  writeFileSync(join(dir, 'supabase/preview-migrations.txt'), '20990101000000_good.sql\n');
  assert.equal(run(), 0, 'already applied migration is skipped');
  assert.equal(psql(`select count(*) from supabase_migrations.schema_migrations`), '1');
  admin(`drop database ${database}`);
});
