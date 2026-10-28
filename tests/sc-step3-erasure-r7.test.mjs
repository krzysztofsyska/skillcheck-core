import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupExecutionLedger } from './helpers/erasure-execution-fixture.mjs';
import { retentionHarness } from './helpers/retention-scheduler-fixture.mjs';
import {
  applyMigration, assertR6, blockersOf, bootMigrationDatabase, catalogSnapshot,
  installSource, paymentUsers, seedSyntheticPolicy,
} from './helpers/sc19-migration-fixture.mjs';

// Real checked-in migrations on disposable native PostgreSQL; never a skip.
const step3 = ['20261026220100_sc_step3_evidence_extensions.sql', '20261026220200_sc_step3_evidence_worker.sql'];
const r7 = '20261028120000_sc_step3_erasure_inventory_r7.sql';
const r7Signature = {
  legacy: '4e14a55722abf0006758a2d439ac41209b41c9a9e4a85e0adebdaa526c7cf5d7',
  voice: 'f61669ada2303111a5d027a012c8c9d6b0cc0ece4ac52eaefb7a33a40e5942c3',
};
const sql = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
async function apply(db, name) {
  try { await db.query(await sql(name)); }
  catch (error) { await db.query('rollback'); throw error; }
}
const tableExists = async (db, name) => (await db.query('select to_regclass($1) v', [name])).rows[0].v !== null;

function grantSyntheticQuota(h, defaultOwner) {
  const originalSeed = h.seed;
  h.seed = async (...args) => {
    if (args[0] === undefined && defaultOwner) args[0] = defaultOwner;
    const f = await originalSeed(...args); await h.asAdmin();
    await h.db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-r7-${f.companyId}`]);
    await h.asUser(f.owner); return f;
  };
}

async function ready(env) {
  const { db, h } = env;
  await seedSyntheticPolicy(db); grantSyntheticQuota(h, paymentUsers.owner);
  const ledgerDb = await env.connect(await env.createDatabase());
  const x = await setupExecutionLedger(retentionHarness(h), ledgerDb); await x.configure();
  const subject = await x.ready({ rich: true }), survivor = await x.ready({ owner: paymentUsers.otherOwner });
  return { x, subject, survivor };
}

async function assertR7(db, variant = 'legacy') {
  await db.query('reset role');
  const row = (await db.query(`select schema_signature,known_tables,private.erasure_schema_signature() actual
    from private.erasure_inventory_baseline_r7 where singleton`)).rows[0];
  assert.equal(row.schema_signature, r7Signature[variant]);
  assert.equal(row.actual, r7Signature[variant]);
  const r6 = (await db.query('select known_tables from private.erasure_inventory_baseline_r6 where singleton')).rows[0];
  assert.deepEqual([...row.known_tables].sort(), [...r6.known_tables, 'private.erasure_inventory_baseline_r7'].sort(), 'Step 3 adds columns, not tables');
  for (const name of ['preview_candidate_erasure', 'prepare_erasure_purge_manifest', 'authorize_retention_suggestion', 'get_retention_schedule']) {
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname=$1 and prosrc like '%erasure_inventory_baseline_r7%'", [name])).rows[0].n, 1, name);
  }
  assert.deepEqual((await db.query(`select proname from pg_proc where prosrc ~ 'erasure_inventory_baseline_r[456]'
    and pronamespace in ('public'::regnamespace,'private'::regnamespace)`)).rows, []);
  await assert.rejects(db.query("update private.erasure_inventory_baseline_r7 set schema_signature=repeat('a',64)"), /immutable/i);
}

async function personalData(db, f) {
  await db.query('reset role');
  const { rows } = await db.query(`update public.screening_criterion_results r
    set human_note='synthetic reviewer note', human_evidence='[{"start":0,"end":1,"quote":"x"}]'::jsonb,
      missing_info='synthetic missing info', human_status='edited'
    where r.analysis_id in (select v.id from public.screening_analysis_versions v where v.application_id=$1)
    returning r.id`, [f.application.id]);
  assert.ok(rows.length > 0, 'Rich fixture has criterion results with Step 3 personal data');
  return rows.map(row => row.id);
}

async function purge(x, f) {
  const state = await x.freeze(f);
  await x.transition(state.request_id, 0, 'authorized');
  await x.transition(state.request_id, 1, 'erasing');
  await x.purge(state.request_id, 2);
  await x.transition(state.request_id, 2, 'active_data_erased');
  return state;
}

for (const variant of ['legacy', 'voice']) test(`R7 ${variant}: M13 -> Step 3 -> R7 installs the reviewed inventory`, async t => {
  const env = await installSource(await bootMigrationDatabase(t), `r4_${variant}`);
  await applyMigration(env.db); await assertR6(env.db, variant);
  for (const name of step3) await apply(env.db, name);
  await apply(env.db, r7);
  await assertR7(env.db, variant);
});

test('R7: preview and execution erase Step 3 columns without schema_dependency_unknown', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy'), { db, h } = env;
  await applyMigration(db);
  for (const name of step3) await apply(db, name);
  await apply(db, r7); await assertR7(db);
  const { x, subject, survivor } = await ready(env);
  const before = await h.asUser(subject.owner).then(() => x.preview(subject));
  const ids = await personalData(db, subject);
  await h.asUser(subject.owner);
  const preview = await x.preview(subject);
  assert.equal(blockersOf(preview).includes('schema_dependency_unknown'), false);
  assert.equal(blockersOf(await x.scheduleStatus(subject)).includes('schema_dependency_unknown'), false);
  assert.notEqual(preview.manifest_hash, before.manifest_hash, 'New columns are part of the inventory row digest');
  const survivorBefore = (await db.query('select to_jsonb(r) row from public.screening_criterion_results r join public.screening_analysis_versions v on v.id=r.analysis_id where v.application_id=$1 order by r.id', [survivor.application.id])).rows;
  const state = await purge(x, subject);
  assert.equal((await x.requestStatus(subject, state.request_id)).phase, 'active_data_erased');
  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int n from public.screening_criterion_results where id=any($1)', [ids])).rows[0].n, 0,
    'human_note, human_evidence and missing_info are erased with their rows');
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1', [subject.candidate.id])).rows[0].n, 0);
  assert.deepEqual((await db.query('select to_jsonb(r) row from public.screening_criterion_results r join public.screening_analysis_versions v on v.id=r.analysis_id where v.application_id=$1 order by r.id', [survivor.application.id])).rows, survivorBefore);
});

test('Step 3 without R7 fails closed: preview and schedule blocked, erasure freeze refused', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy'), { db, h } = env;
  await applyMigration(db);
  for (const name of step3) await apply(db, name);
  const { x, subject } = await ready(env);
  await h.asUser(subject.owner);
  assert.ok(blockersOf(await x.preview(subject)).includes('schema_dependency_unknown'));
  assert.ok(blockersOf(await x.scheduleStatus(subject)).includes('schema_dependency_unknown'));
  await h.asAdmin();
  const before = (await db.query('select count(*)::int n from public.candidates')).rows[0].n;
  // Freezing requires a blocker-free preview, so no purge manifest can be prepared.
  await assert.rejects(x.freeze(subject), /Preview has blockers/);
  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int n from public.candidates')).rows[0].n, before, 'Nothing is purged');
});

test('Reverse order is refused atomically: Step 3 before M13, R7 before M13, R7 before Step 3', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy'), { db } = env;
  // R7 without R6.
  let snapshot = await catalogSnapshot(db);
  await assert.rejects(apply(db, r7), error => error.code === '55000' && /sc_r7_requires_r6_inventory/.test(error.message));
  assert.deepEqual(await catalogSnapshot(db), snapshot);
  // Step 3 before M13: M13 then refuses the unreviewed source schema.
  await db.query('begin');
  for (const name of step3) await db.query((await sql(name)).replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
  snapshot = await catalogSnapshot(db);
  await db.query('savepoint before_m13');
  await assert.rejects(db.query(await (await sql('20261021084732_sc019_credits_payments_inventory.sql')).replace(/^begin;$/m, '').replace(/^commit;$/m, '')),
    /sc19_source_schema_unreviewed/);
  await db.query('rollback to savepoint before_m13');
  assert.deepEqual(await catalogSnapshot(db), snapshot, 'M13 refusal is catalog-atomic');
  assert.equal(await tableExists(db, 'private.erasure_inventory_baseline_r6'), false);
  await db.query('rollback');
  // R7 after M13 but before Step 3: source schema is the R6 one, not the reviewed Step 3 schema.
  await applyMigration(db);
  snapshot = await catalogSnapshot(db);
  await assert.rejects(apply(db, r7), error => error.code === '55000' && /sc_r7_source_schema_unreviewed/.test(error.message));
  assert.deepEqual(await catalogSnapshot(db), snapshot);
  assert.equal(await tableExists(db, 'private.erasure_inventory_baseline_r7'), false);
  await assertR6(db);
});

test('R7 refuses unreviewed drift on top of Step 3 and cannot be installed twice', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy'), { db } = env;
  await applyMigration(db);
  for (const name of step3) await apply(db, name);
  for (const ddl of [
    'alter table public.screening_criterion_results add column unreviewed_note text',
    'create table public.unreviewed_candidate_copy(candidate_id uuid)',
  ]) {
    await db.query(ddl);
    await assert.rejects(apply(db, r7), /sc_r7_source_schema_unreviewed/);
    assert.equal(await tableExists(db, 'private.erasure_inventory_baseline_r7'), false);
    await db.query(ddl.startsWith('alter') ? 'alter table public.screening_criterion_results drop column unreviewed_note' : 'drop table public.unreviewed_candidate_copy');
  }
  await apply(db, r7); await assertR7(db);
  await assert.rejects(apply(db, r7), /sc_r7_already_installed/);
});
