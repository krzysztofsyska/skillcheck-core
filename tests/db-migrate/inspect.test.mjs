import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from '../../tools/db-migrate/inspect.mjs';
import { applyMigration, bootMigrationDatabase, catalogSnapshot, installSource } from '../helpers/sc19-migration-fixture.mjs';

const quiet = () => {};

test('inspect matches the reviewed source state, changes nothing and reports history', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy');
  const { db } = env;
  await db.query(`create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);
    insert into supabase_migrations.schema_migrations values ('20261012031039', array['select 1'], 'retention_scheduler_inventory')`);
  const before = await catalogSnapshot(db);
  const report = await inspect({ databaseUrl: env.databaseUrl(env.name), log: quiet });
  assert.deepEqual(await catalogSnapshot(db), before, 'Read-only: catalog unchanged');
  assert.ok(Object.values(report.matches.r4_legacy).every(Boolean), 'Reviewed r4_legacy source state matches on every fingerprint');
  assert.equal(Object.values(report.matches.r4_voice).every(Boolean), false);
  assert.deepEqual(report.history, [{ version: '20261012031039', name: 'retention_scheduler_inventory', statements: ['select 1'] }]);
  assert.ok(report.catalog.routines.manifest.length > 0 && report.catalog.routines.object_count > 0);
  assert.equal(report.observed.sc010_signature, before.sc010_signature);

  await applyMigration(db);
  const after = await inspect({ databaseUrl: env.databaseUrl(env.name), log: quiet });
  assert.ok(after.baselines.includes('erasure_inventory_baseline_r6'));
  assert.equal(Object.values(after.matches.r4_legacy).every(Boolean), false, 'A changed schema no longer matches');
});

test('inspect runs in a read-only transaction', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../../tools/db-migrate/inspect.mjs', import.meta.url), 'utf8'));
  assert.match(source, /begin transaction isolation level repeatable read read only/);
  assert.doesNotMatch(source.replace(/^\/\/.*$/gm, ''), /\b(insert|update|delete|create|alter|drop|grant|revoke)\s+(into|table|function|schema|role|on)\b/i);
});
