import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyMigration, bootMigrationDatabase, catalogSnapshot, installSource, migrationManifest } from '../helpers/sc19-migration-fixture.mjs';

// Production stored 13 reviewed function bodies with CRLF line endings
// (inspection run 41021636267); M13 compares routine definitions byte for byte.
const sql = await readFile(new URL('../../supabase/migrations/20261021084500_normalize_function_line_endings.sql', import.meta.url), 'utf8');
const listed = [...sql.matchAll(/^\s+'((?:public|private)\.[a-z_]+\([^']*\))',?$/gm)].map(match => match[1]);

async function withCrlf(db, targets) {
  for (const target of targets) {
    const definition = (await db.query('select pg_get_functiondef($1::regprocedure) d', [target])).rows[0].d;
    await db.query(definition.replaceAll('\n', '\r\n'));
  }
}
const acl = async db => (await db.query(`select p.oid::regprocedure::text f, p.proowner::regrole::text o, p.proacl::text a
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by 1`)).rows;

test('CRLF bodies block M13; normalization restores the reviewed state and M13 then applies', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy');
  const { db } = env;
  assert.equal(listed.length, 13);
  const reviewed = await catalogSnapshot(db), reviewedAcl = await acl(db);

  await db.query(sql);
  assert.deepEqual(await catalogSnapshot(db), reviewed, 'No-op when no body has CR');

  await withCrlf(db, listed);
  const drifted = await catalogSnapshot(db);
  assert.notEqual(drifted.routines, reviewed.routines);
  assert.deepEqual({ ...drifted, routines: reviewed.routines }, reviewed, 'Only the routines fingerprint drifts');
  await assert.rejects(applyMigration(db), /sc19_source_schema_unreviewed/);

  await db.query(sql);
  assert.deepEqual(await catalogSnapshot(db), reviewed);
  assert.deepEqual(await acl(db), reviewedAcl, 'Owner and ACL unchanged');
  const expected = (await migrationManifest()).states.r4_legacy;
  assert.equal(reviewed.routines, expected.pg16.routines);
  await applyMigration(db);
  assert.ok((await db.query("select to_regclass('private.sc19_balances') v")).rows[0].v);
});

test('a bare carriage return is refused and rolls back', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy');
  const { db } = env;
  const reviewed = await catalogSnapshot(db);
  await withCrlf(db, ['public.create_company(text)']);
  const definition = (await db.query("select pg_get_functiondef('private.touch_updated_at()'::regprocedure) d")).rows[0].d;
  await db.query(definition.replace('begin\n', 'begin\r-- stray\n'));
  const before = await catalogSnapshot(db);
  await assert.rejects(db.query(sql), /Bare carriage return in private\.touch_updated_at\(\)/);
  await db.query('rollback');
  assert.deepEqual(await catalogSnapshot(db), before, 'Refusal rolls back every normalization');
  assert.notEqual(before.routines, reviewed.routines);
});
