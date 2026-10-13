import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import pg from 'pg';
import { setupRankingDatabase } from './helpers/screening-ranking-fixture.mjs';

const prototypeSql = await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8');
const blockersOf = value => Array.isArray(value?.blockers) ? value.blockers : JSON.parse(value.blockers);

async function assertBillingBaseline(db) {
  const state = (await db.query(`
    select schema_signature as expected, private.erasure_schema_signature() as actual
    from private.erasure_inventory_baseline_r5 where singleton
  `)).rows[0];
  assert.equal(state.actual, state.expected);
  const missing = (await db.query(`
    select namespace.nspname || '.' || relation.relname as name
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join private.erasure_inventory_baseline_r5 baseline
    where namespace.nspname in ('public','private')
      and relation.relkind in ('r','p','f')
      and not (namespace.nspname || '.' || relation.relname) = any (baseline.known_tables)
  `)).rows;
  assert.deepEqual(missing, []);
  const targets = (await db.query(`
    select c.confrelid::regclass::text as target
    from pg_constraint c
    where c.conrelid in ('private.sc19_analysis_spend'::regclass, 'private.sc19_credit_journal'::regclass)
      and c.contype = 'f'
  `)).rows.map(row => row.target);
  assert.ok(targets.length >= 2);
  assert.ok(targets.every(target => target === 'companies' || target.endsWith('.companies')));
  const staleBaseline = (await db.query(`
    select proname from pg_proc where prosrc like '%erasure_inventory_baseline_r4%' order by proname
  `)).rows;
  assert.deepEqual(staleBaseline, []);
  const retargeted = new Set((await db.query(`
    select proname from pg_proc where prosrc like '%erasure_inventory_baseline_r5%'
  `)).rows.map(row => row.proname));
  for (const name of ['preview_candidate_erasure', 'prepare_erasure_purge_manifest', 'authorize_retention_suggestion', 'get_retention_schedule']) {
    assert.ok(retargeted.has(name), name);
  }
}

async function exercise(db) {
  const harness = await setupRankingDatabase(db);
  await harness.asAdmin();
  const before = (await db.query(`
    select schema_signature = private.erasure_schema_signature() as ok
    from private.erasure_inventory_baseline_r4 where singleton
  `)).rows[0];
  assert.equal(before.ok, true);
  await db.exec(prototypeSql);
  await assertBillingBaseline(db);
  const fixture = await harness.seed();
  await harness.asUser(fixture.owner);
  const preview = (await db.query('select public.preview_candidate_erasure($1) as value', [fixture.candidate.id])).rows[0].value;
  assert.equal(blockersOf(preview).includes('schema_dependency_unknown'), false);
  const schedule = (await db.query('select public.get_retention_schedule($1) as value', [fixture.companyId])).rows[0].value;
  assert.equal(blockersOf(schedule).includes('schema_dependency_unknown'), false);
  await harness.asAdmin();
  const adapters = (await db.query(
    'select adapter from private.erasure_purge_rows($1,$2) where adapter like $3',
    [fixture.companyId, [fixture.candidate.id], 'private.sc19%'],
  )).rows;
  assert.deepEqual(adapters, []);
}

test('SC-019 prototype extends the SC-010 erasure baseline on PGlite', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  db.exec = db.exec.bind(db);
  await exercise(db);
});

const pgUrl = process.env.SC19_TEST_DATABASE_URL;
const pgTest = pgUrl
  ? test
  : (name, options, fn) => test(name, { ...options, skip: 'Requires temporary PostgreSQL CI service' }, fn ?? options);
pgTest('SC-019 prototype extends the SC-010 erasure baseline on PostgreSQL 16', async t => {
  const url = new URL(pgUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.pathname !== '/postgres') {
    throw new Error('SC19_TEST_DATABASE_URL must point to disposable loopback postgres service; refusing remote databases');
  }
  const database = 'sc19erasure_' + randomBytes(6).toString('hex');
  const root = new pg.Client({ connectionString: pgUrl });
  await root.connect();
  const client = new pg.Client({ connectionString: new URL(`/${database}`, pgUrl).toString() });
  t.after(async () => {
    await client.end().catch(() => {});
    await root.query(`drop database if exists "${database}" with (force)`).catch(() => {});
    await root.end();
  });
  await root.query(`create database "${database}"`);
  await client.connect();
  client.exec = sql => client.query(sql);
  await exercise(client);
});
