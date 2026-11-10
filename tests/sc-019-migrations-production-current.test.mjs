import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRankingHarness, users } from './helpers/screening-ranking-fixture.mjs';
import { bootHostedRehearsal, replayObservedHistory, CURRENT_HISTORY } from './helpers/sc19-hosted-rehearsal.mjs';
import { assertCurrentInventory } from './helpers/sc19-migration-fixture.mjs';

// Release rehearsal from the CURRENT production state: the 49 migrations recorded in
// supabase_migrations.schema_migrations of wsvjawuikxfzjyivxgsu (read 2026-11-10), replayed under
// their production version numbers, then every migration the repository still has beyond that,
// one by one in repository order, as db-migrate-production would apply them.
// The older 19-entry state is kept in tests/sc-019-migrations-production-history.test.mjs.
const dir = new URL('../supabase/migrations/', import.meta.url);

test('CURRENT production history (49 migrations) + every pending migration applies cleanly over existing synthetic data', async t => {
  const url = new URL(process.env.SC19_CURRENT_REHEARSAL_DATABASE_URL);
  assert.equal(url.port, '55434');
  assert.equal(url.pathname, '/sc19_production_current');
  assert.ok(['16', '17'].includes(process.env.SC19_TEST_PG_MAJOR));
  const { platform, db } = await bootHostedRehearsal(t, url);
  const history = await replayObservedHistory(t, db, CURRENT_HISTORY);
  assert.equal((await db.query("select count(*)::int n from pg_extension where extname='pg_cron'")).rows[0].n, 1);
  assert.equal((await platform.query('select count(*)::int n from cron.job')).rows[0].n, 0);

  // Existing synthetic data at the production state: it must survive the whole pending chain.
  for (const id of Object.values(users)) await db.query('insert into auth.users values($1)', [id]);
  // Production already has the billing gate (M13), so no screening analysis can be started here;
  // the seed (companies, members, positions, candidates, applications) is what must survive.
  await createRankingHarness(db).seed();
  await db.query('reset role');
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r => r.tablename);
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async name =>
    [name, (await db.query(`select to_jsonb(t) value from public."${name}" t order by to_jsonb(t)::text collate "C"`)).rows])));
  const before = await snapshot();
  assert.ok(Object.values(before).some(rows => rows.length > 0), 'Synthetic data was seeded');

  const recorded = new Set(history.map(e => e.name));
  const lastRecorded = history.map(e => e.version).sort().at(-1);
  const pending = (await readdir(dir)).filter(name => name.endsWith('.sql') && !recorded.has(name.replace(/^\d+_/, '').replace(/\.sql$/, ''))).sort();
  for (const name of pending) {
    assert.ok(name.slice(0, 14) > lastRecorded, `${name} is pending but numbered before the newest recorded production migration ${lastRecorded}`);
    await db.query(await readFile(new URL(name, dir), 'utf8'));
    t.diagnostic(`applied pending ${name}`);
  }
  t.diagnostic(`pending migrations applied: ${pending.length}`);

  // Pending migrations may only add columns: every existing value is unchanged.
  const canonical = (rows, keys) => rows.map(row => JSON.stringify(keys.map(k => [k, row.value[k]]))).sort();
  const after = await snapshot();
  for (const [table, rows] of Object.entries(before)) {
    const keys = Object.keys(rows[0]?.value ?? {}).sort();
    assert.deepEqual(canonical(after[table], keys), canonical(rows, keys), `${table} existing rows and values preserved`);
  }
  await assertCurrentInventory(db);
  assert.equal((await platform.query('select count(*)::int n from cron.job')).rows[0].n, 0, 'No migration schedules a job');
});
