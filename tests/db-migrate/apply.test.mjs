import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply, parseList, sha256, unappliedGaps, unframe } from '../../tools/db-migrate/apply.mjs';
import { bootMigrationDatabase } from '../helpers/sc19-migration-fixture.mjs';

const repoDir = new URL('../../supabase/migrations/', import.meta.url);
const releaseSha = 'a'.repeat(40);
const quiet = () => {};

async function syntheticDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'db-migrate-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return pathToFileURL(`${dir}/`);
}
const m1 = '20990101000100_first.sql', m2 = '20990101000200_second.sql', m3 = '20990101000300_third.sql';
const ok = {
  [m1]: '-- first\nbegin;\ncreate table public.dbm_first(id int);\ncommit;\n',
  [m2]: 'begin;\ninsert into public.dbm_first values (1);\ncommit;\n',
  [m3]: 'begin;\ncreate table public.dbm_third(id int);\nselect 1/0;\ncommit;\n',
};

test('list must be valid file names in strictly increasing repository order', () => {
  assert.deepEqual(parseList(` ${m1}, ${m2}\n`), [m1, m2]);
  for (const bad of ['', `${m2},${m1}`, `${m1},${m1}`, 'x.sql', '20990101000100_First.sql', '../20990101000100_a.sql']) {
    assert.throws(() => parseList(bad));
  }
});

test('every repository migration has the begin/commit frame the runner removes', async () => {
  for (const file of (await readdir(repoDir)).filter(name => name.endsWith('.sql'))) {
    const sql = await readFile(new URL(file, repoDir), 'utf8');
    const body = unframe(sql, file);
    assert.doesNotMatch(body, /^\s*(begin|commit);\s*$/m, file);
  }
  assert.throws(() => unframe('create table x(id int);\n', 'x'), /exactly one/);
  assert.throws(() => unframe('begin;\nselect 1;\ncommit;\nselect 2;\n', 'x'), /last statement/);
  assert.throws(() => unframe('begin;\nbegin;\ncommit;\n', 'x'), /exactly one/);
});

test('observed production history: the full pending chain has no gaps, skipping M13 is refused', async () => {
  const history = JSON.parse(await readFile(new URL('../fixtures/sc19-production-history.json', import.meta.url), 'utf8')).history;
  const recorded = new Set(history.map(entry => entry.name));
  const files = (await readdir(repoDir)).filter(name => name.endsWith('.sql')).sort();
  const pending = files.filter(file => !recorded.has(file.replace(/^\d+_/, '').replace(/\.sql$/, '')));
  assert.ok(pending.includes('20261021084732_sc019_credits_payments_inventory.sql'));
  assert.deepEqual(unappliedGaps(files, pending, recorded), []);
  const withoutM13 = pending.filter(file => !file.startsWith('20261021084732'));
  assert.deepEqual(unappliedGaps(files, withoutM13, recorded), ['20261021084732_sc019_credits_payments_inventory.sql']);
});

test('applies in order with history and ledger, refuses re-runs, rolls back a failing migration', async t => {
  const env = await bootMigrationDatabase(t);
  const databaseUrl = env.databaseUrl(env.name);
  const dir = await syntheticDir(ok);
  await assert.rejects(apply({ databaseUrl, dir, files: m1, releaseSha: 'main', runId: '1', log: quiet }), /full commit SHA/);
  await assert.rejects(apply({ databaseUrl, dir, files: `${m1},${m2}`, expectedHashes: JSON.stringify({ [m1]: sha256(ok[m1]), [m2]: '0'.repeat(64) }), releaseSha, runId: '1', log: quiet }), /changed since the approved plan/);
  await assert.rejects(apply({ databaseUrl, dir, files: m2, releaseSha, runId: '1', log: quiet }), /neither applied nor listed: 20990101000100_first.sql/);

  const applied = await apply({ databaseUrl, dir, files: `${m1},${m2}`, expectedHashes: JSON.stringify({ [m1]: sha256(ok[m1]), [m2]: sha256(ok[m2]) }), releaseSha, runId: '42', log: quiet });
  assert.deepEqual(applied.map(m => m.file), [m1, m2]);
  const { db } = env;
  await db.query('reset role');
  assert.equal((await db.query('select count(*)::int n from public.dbm_first')).rows[0].n, 1);
  assert.deepEqual((await db.query('select version,name,statements from supabase_migrations.schema_migrations order by version')).rows,
    [{ version: '20990101000100', name: 'first', statements: [ok[m1]] }, { version: '20990101000200', name: 'second', statements: [ok[m2]] }]);
  const ledger = (await db.query('select name,file,sha256,statements,release_sha,run_id from supabase_migrations.skillcheck_migration_ledger order by name')).rows;
  assert.deepEqual(ledger, [
    { name: 'first', file: m1, sha256: sha256(ok[m1]), statements: ok[m1], release_sha: releaseSha, run_id: '42' },
    { name: 'second', file: m2, sha256: sha256(ok[m2]), statements: ok[m2], release_sha: releaseSha, run_id: '42' },
  ]);

  await assert.rejects(apply({ databaseUrl, dir, files: m2, releaseSha, runId: '43', log: quiet }), /Already applied, never re-run: 20990101000200_second.sql/);
  await assert.rejects(apply({ databaseUrl, dir, files: m3, releaseSha, runId: '44', log: quiet }), /20990101000300_third.sql failed and was rolled back/);
  assert.equal((await db.query("select to_regclass('public.dbm_third') v")).rows[0].v, null);
  assert.equal((await db.query("select count(*)::int n from supabase_migrations.schema_migrations where name='third'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from supabase_migrations.skillcheck_migration_ledger where name='third'")).rows[0].n, 0);
});

test('stops at the first failure; later migrations in the same run are not applied', async t => {
  const env = await bootMigrationDatabase(t);
  const m4 = '20990101000400_fourth.sql';
  const dir = await syntheticDir({ ...ok, [m4]: 'begin;\ncreate table public.dbm_fourth(id int);\ncommit;\n' });
  await assert.rejects(apply({ databaseUrl: env.databaseUrl(env.name), dir, files: `${m1},${m2},${m3},${m4}`, releaseSha, runId: '7', log: quiet }), /third/);
  await env.db.query('reset role');
  assert.deepEqual((await env.db.query('select name from supabase_migrations.skillcheck_migration_ledger order by name')).rows.map(r => r.name), ['first', 'second']);
  assert.equal((await env.db.query("select to_regclass('public.dbm_fourth') v")).rows[0].v, null);
});

test('runner applies the whole checked-in chain on a fresh database and leaves the reviewed inventory', async t => {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  await db.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const files = (await readdir(repoDir)).filter(name => name.endsWith('.sql')).sort();
  await apply({ databaseUrl: env.databaseUrl(env.name), dir: repoDir, files: files.join(','), releaseSha, runId: 'chain', log: quiet });
  const { assertCurrentInventory } = await import('../helpers/sc19-migration-fixture.mjs');
  await assertCurrentInventory(db);
  assert.equal((await db.query('select count(*)::int n from supabase_migrations.skillcheck_migration_ledger where statements is null or sha256 is null')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n, files.length);
  assert.equal((await db.query('select count(*)::int n from private.sc19_package_policy')).rows[0].n, 0, 'No commercial data seeded');
});
