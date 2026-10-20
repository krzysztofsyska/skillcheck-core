import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import pg from 'pg';
import { bootRetention, voiceTables } from './helpers/voice-retention-fixture.mjs';
import { setupRankingDatabase } from './helpers/screening-ranking-fixture.mjs';

const prototypeSql = await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8');
const blockersOf = value => Array.isArray(value?.blockers) ? value.blockers : JSON.parse(value.blockers);

async function assertBillingBaseline(db) {
  const state = (await db.query(`
    select schema_signature as expected, private.erasure_schema_signature() as actual
    from private.erasure_inventory_baseline_r5 where singleton
  `)).rows[0];
  assert.equal(state.expected, '10358458d8802b1ed59a298b305752a89ce110d1019a11cde937f2a2311f79bc');
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
  const granted = (await db.query(
    'select private.sc19_grant_paid($1,$2) as available',
    [fixture.companyId, 'attempt-stale-settlement-01'],
  )).rows[0];
  assert.equal(granted.available, 60);
  const started = await harness.start(fixture);
  const claimed = await harness.claim(started);
  assert.equal(claimed.attempt_id, started.attempt_id);
  await harness.asAdmin();
  assert.equal((await db.query(
    'select status from public.screening_analysis_attempts where id=$1',
    [started.attempt_id],
  )).rows[0].status, 'processing');
  await db.query(
    `update public.screening_analysis_versions
       set stale_at=clock_timestamp(), stale_reason='manual_invalidation'
     where id=$1`,
    [started.analysis_id],
  );
  const after = (await db.query(`
    select analysis.execution_status, attempt.status as attempt_status, attempt.finished_at, balance.available
    from public.screening_analysis_versions analysis
    join public.screening_analysis_attempts attempt on attempt.id=$2
    join private.sc19_balances balance on balance.company_id=analysis.company_id
    where analysis.id=$1
  `, [started.analysis_id, started.attempt_id])).rows[0];
  assert.equal(after.execution_status, 'cancelled');
  assert.equal(after.attempt_status, 'abandoned');
  assert.ok(after.finished_at);
  assert.equal(after.available, 60);
  await assert.rejects(
    () => harness.finishClaim(started, claimed, Array(claimed.criteria_snapshot.length).fill('meets')),
    error => error.code === '42501',
  );
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


async function exerciseVoiceBilling(t, embedded) {
  const env=await bootRetention(t,{embedded}), {db,h,x}=env;
  await h.asAdmin();
  await db.exec(`alter default privileges grant all on tables to contact_verifier;
    alter default privileges grant execute on functions to contact_verifier;`);
  await db.exec(prototypeSql);
  for (const table of ['sc19_package_policy','sc19_balances','sc19_trial_nips','sc19_trial_approvals',
    'sc19_analysis_spend','sc19_credit_journal','erasure_inventory_baseline_r5']) {
    assert.equal((await db.query("select has_table_privilege('contact_verifier',$1,'TRUNCATE') allowed",
      ['private.'+table])).rows[0].allowed,false,table);
  }
  assert.equal((await db.query("select has_function_privilege('contact_verifier','private.sc19_grant_paid(uuid,text)','execute') allowed")).rows[0].allowed,false);
  const baseline=(await db.query('select schema_signature expected,private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r5 where singleton')).rows[0];
  assert.equal(baseline.expected,'c989b84b9eec51fc48c361b8ad9e7404b4044268d56d106b6788fe56f3f1857d');
  assert.equal(baseline.actual,baseline.expected);
  const originalSeed=h.seed;
  h.seed=async (...args)=>{
    const f=await originalSeed(...args);await h.asAdmin();
    await db.query('select private.sc19_grant_paid($1,$2)',[f.companyId,'composed-'+f.companyId]);
    await h.asUser(f.owner);return f;
  };
  const subject=await env.ready(),survivor=await env.ready();
  await env.prepare(subject);await env.prepare(survivor);
  await h.asUser(subject.f.owner);
  assert.equal(blockersOf(await x.preview(subject.f)).includes('schema_dependency_unknown'),false);
  assert.equal(blockersOf(await x.scheduleStatus(subject.f)).includes('schema_dependency_unknown'),false);
  await h.asAdmin();
  await db.exec('begin');
  await db.exec('alter table private.voice_plan_request_keys disable trigger user');
  await db.query(`insert into private.voice_plan_request_keys values($1,$2,'generate',$3,$4,null,now(),'test',now()+interval '1 day')`,
    [subject.f.companyId,subject.f.owner,randomUUID(),'a'.repeat(64)]);
  await db.exec('alter table private.voice_plan_request_keys enable trigger user');
  await h.asUser(subject.f.owner);
  assert.ok(blockersOf(await x.preview(subject.f)).includes('voice_request_adapter_unknown'));
  await db.exec('rollback');await h.asAdmin();
  const billingBefore=(await db.query('select to_jsonb(j) value from private.sc19_credit_journal j order by id')).rows;
  await db.exec('begin');
  const state=await env.erasing(subject);
  await x.purge(state.request_id,2);await x.transition(state.request_id,2,'active_data_erased');
  await h.asAdmin();
  for (const table of voiceTables) assert.equal(await env.count(table,subject.f.companyId),0,table);
  assert.equal(await env.count('private.sc010c_voice_preparations',survivor.f.companyId),1);
  assert.deepEqual((await db.query('select to_jsonb(j) value from private.sc19_credit_journal j order by id')).rows,billingBefore);
  await db.exec('rollback');
  // The independent signed ledger survives rollback; restoring the product
  // snapshot must re-erase voice data and must not refund another reservation.
  await x.configure({restore_isolated:true});
  assert.equal((await x.replay()).replayed,1);
  assert.equal(await env.count('private.sc010c_voice_preparations',subject.f.companyId),0);
  assert.equal(await env.count('private.sc010c_voice_preparations',survivor.f.companyId),1);
  await h.asAdmin();
  assert.deepEqual((await db.query('select to_jsonb(j) value from private.sc19_credit_journal j order by id')).rows,billingBefore);
  await x.configure({restore_isolated:false});
  for (const ddl of ['create table public.unreviewed_billing_copy(candidate_id uuid)',
    'alter table private.sc19_balances add column unreviewed_note text',
    'alter table private.sc19_package_policy add column unreviewed_note text']) {
    await h.asAdmin();await db.exec('begin');
    try {
      await db.exec(ddl);await h.asUser(survivor.f.owner);
      assert.ok(blockersOf(await x.preview(survivor.f)).includes('schema_dependency_unknown'));
      assert.ok(blockersOf(await x.scheduleStatus(survivor.f)).includes('schema_dependency_unknown'));
    } finally {await db.exec('rollback');}
  }
}

test('SC-019 composes with R4 voice: preview, signed purge, restore and drift denial on PGlite', t=>exerciseVoiceBilling(t,true));
pgTest('SC-019 composes with R4 voice: preview, signed purge, restore and drift denial on PostgreSQL 16', t=>exerciseVoiceBilling(t,false));
