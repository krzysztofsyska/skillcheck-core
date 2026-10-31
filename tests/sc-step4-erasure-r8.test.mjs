import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupExecutionLedger } from './helpers/erasure-execution-fixture.mjs';
import { retentionHarness } from './helpers/retention-scheduler-fixture.mjs';
import {
  applyMigration, blockersOf, bootMigrationDatabase, catalogSnapshot,
  installSource, paymentUsers, seedSyntheticPolicy,
} from './helpers/sc19-migration-fixture.mjs';

// Real checked-in migrations on disposable native PostgreSQL; never a skip.
const chain = [
  '20261026220100_sc_step3_evidence_extensions.sql', '20261026220200_sc_step3_evidence_worker.sql',
  '20261028120000_sc_step3_erasure_inventory_r7.sql', '20261029100000_sc019_operator_fulfillment.sql',
  '20261030120000_sc_step3_matrix_change_invalidates_approval.sql',
];
const step4 = '20261030160000_sc_step4_interview_decision.sql';
const r8 = '20261030160100_sc_step4_erasure_inventory_r8.sql';
const step4Tables = ['public.application_decision_events', 'public.application_stage_events', 'public.candidate_assessment_note_revisions'];
const sourceSignature = {
  legacy: '81388d40db8145b5638749b2652e229b55b73901e9905c9de16ddf495825d074',
  voice: '641650aea54f6e013326c76c883766fc303645e6f5f4c19b51676da9ed2e12a6',
};
const r8Signature = {
  legacy: 'd87bccd9dcf7834aeed6bd361cb117b1b11f221f2bc0280d852843d29996bdaf',
  voice: 'f057e8bce49280b3ec6dfff5259bb9b27174829ba068b1f429b003b8cb61cda9',
};
const migration = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const rollback = name => readFile(new URL(`../supabase/rollbacks/${name}`, import.meta.url), 'utf8');
async function run(db, sql) {
  try { await db.query(sql); }
  catch (error) { await db.query('rollback'); throw error; }
}
const tableExists = async (db, name) => (await db.query('select to_regclass($1) v', [name])).rows[0].v !== null;

async function install(t, variant = 'legacy', { withR8 = true } = {}) {
  const env = await installSource(await bootMigrationDatabase(t), `r4_${variant}`);
  await applyMigration(env.db);
  for (const name of chain) await run(env.db, await migration(name));
  await run(env.db, await migration(step4));
  if (withR8) await run(env.db, await migration(r8));
  return env;
}

function grantSyntheticQuota(h, defaultOwner) {
  const originalSeed = h.seed;
  h.seed = async (...args) => {
    if (args[0] === undefined && defaultOwner) args[0] = defaultOwner;
    const f = await originalSeed(...args); await h.asAdmin();
    await h.db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-r8-${f.companyId}`]);
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

// Step 4 personal data through the explicit recruiter actions only.
async function step4Data(h, db, f) {
  await h.asUser(f.owner);
  let stage = (await db.query('select id from public.assessment_stages where recruitment_id=$1 order by sequence limit 1', [f.recruitment.id])).rows[0];
  stage ??= await h.insert('assessment_stages', { company_id: f.companyId, recruitment_id: f.recruitment.id, name: 'Synthetic stage', sequence: 1 });
  await h.asUser(f.owner);
  await db.query('select public.move_application_stage($1,$2,$3,$4)', [f.companyId, f.recruitment.id, f.application.id, stage.id]);
  await db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)',
    [f.companyId, f.recruitment.id, f.application.id, 'on_hold', 'PRIVATE synthetic decision reason']);
  const assessment = (await db.query('select id from public.candidate_assessments where application_id=$1 limit 1', [f.application.id])).rows[0];
  if (assessment) await db.query("update public.candidate_assessments set notes='PRIVATE second note version' where id=$1", [assessment.id]);
  else await h.insert('candidate_assessments', { company_id: f.companyId, recruitment_id: f.recruitment.id, application_id: f.application.id, stage_id: stage.id, notes: 'PRIVATE note' });
}

async function step4Rows(db, applicationId) {
  await db.query('reset role');
  const rows = {};
  for (const table of step4Tables) {
    rows[table] = (await db.query(`select to_jsonb(t) row from ${table} t where application_id=$1 order by id`, [applicationId])).rows.map(r => r.row);
  }
  return rows;
}

async function purge(x, f) {
  const state = await x.freeze(f);
  await x.transition(state.request_id, 0, 'authorized');
  await x.transition(state.request_id, 1, 'erasing');
  await x.purge(state.request_id, 2);
  await x.transition(state.request_id, 2, 'active_data_erased');
  return state;
}

async function assertR8(db, variant) {
  await db.query('reset role');
  const row = (await db.query(`select schema_signature,known_tables,private.erasure_schema_signature() actual
    from private.erasure_inventory_baseline_r8 where singleton`)).rows[0];
  assert.equal(row.schema_signature, r8Signature[variant]);
  assert.equal(row.actual, r8Signature[variant]);
  const r7 = (await db.query('select known_tables from private.erasure_inventory_baseline_r7 where singleton')).rows[0];
  assert.deepEqual([...row.known_tables].sort(), [...r7.known_tables, ...step4Tables, 'private.erasure_inventory_baseline_r8'].sort());
  for (const name of ['preview_candidate_erasure', 'prepare_erasure_purge_manifest', 'authorize_retention_suggestion', 'get_retention_schedule']) {
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname=$1 and prosrc like '%erasure_inventory_baseline_r8%'", [name])).rows[0].n, 1, name);
  }
  assert.deepEqual((await db.query(`select proname from pg_proc where prosrc ~ 'erasure_inventory_baseline_r[4567]([^0-9]|$)'
    and pronamespace in ('public'::regnamespace,'private'::regnamespace)`)).rows, []);
  await assert.rejects(db.query("update private.erasure_inventory_baseline_r8 set schema_signature=repeat('a',64)"), /immutable/i);
  // Wrappers keep the reviewed variant bodies callable, with the same owner and ACL.
  for (const [wrapper, base] of [['private.erasure_inventory_rows(uuid,uuid[])', 'private.erasure_inventory_rows_r7(uuid,uuid[])'],
    ['private.erasure_row_candidates(text,jsonb)', 'private.erasure_row_candidates_r7(text,jsonb)']]) {
    const [w, b] = await Promise.all([wrapper, base].map(async name => (await db.query(
      'select pg_get_userbyid(proowner) owner,proacl::text acl,prosecdef from pg_proc where oid=$1::regprocedure', [name])).rows[0]));
    assert.deepEqual(w, b, wrapper);
    assert.equal(w.prosecdef, true);
  }
}

for (const variant of ['legacy', 'voice']) test(`R8 ${variant}: R7 -> Step 4 -> R8 installs the reviewed inventory`, async t => {
  const env = await install(t, variant);
  await assertR8(env.db, variant);
});

test('R8: preview lists Step 4 rows, purge erases them and leaves the other tenant intact', async t => {
  const env = await install(t), { db, h } = env;
  const { x, subject, survivor } = await ready(env);
  await h.asUser(subject.owner);
  const before = await x.preview(subject);
  await step4Data(h, db, subject); await step4Data(h, db, survivor);
  const subjectRows = await step4Rows(db, subject.application.id);
  for (const table of step4Tables) assert.ok(subjectRows[table].length > 0, `fixture has ${table}`);
  const survivorBefore = await step4Rows(db, survivor.application.id);
  await h.asUser(subject.owner);
  const preview = await x.preview(subject);
  assert.equal(blockersOf(preview).includes('schema_dependency_unknown'), false);
  assert.equal(blockersOf(await x.scheduleStatus(subject)).includes('schema_dependency_unknown'), false);
  assert.notEqual(preview.manifest_hash, before.manifest_hash, 'Step 4 rows are part of the inventory row digest');
  const counts = typeof preview.counts === 'string' ? JSON.parse(preview.counts) : preview.counts;
  for (const table of step4Tables) assert.equal(Number(counts[table]), subjectRows[table].length, `preview counts ${table}`);
  const state = await purge(x, subject);
  assert.equal((await x.requestStatus(subject, state.request_id)).phase, 'active_data_erased');
  const after = await step4Rows(db, subject.application.id);
  for (const table of step4Tables) assert.deepEqual(after[table], [], `${table} erased`);
  for (const table of step4Tables) {
    const ids = subjectRows[table].map(r => r.id);
    assert.equal((await db.query(`select count(*)::int n from ${table} where id=any($1)`, [ids])).rows[0].n, 0);
  }
  assert.deepEqual(await step4Rows(db, survivor.application.id), survivorBefore);
});

test('R8: inside a purge transaction a Step 4 row outside the manifest cannot be deleted', async t => {
  const env = await install(t), { db, h } = env;
  const { survivor } = await ready(env);
  await step4Data(h, db, survivor);
  await db.query('reset role');
  await db.query('begin');
  await db.query(`insert into private.erasure_purge_context values(txid_current(),gen_random_uuid(),$1,'synthetic','delete')`, [survivor.companyId]);
  await assert.rejects(db.query('delete from public.application_decision_events where application_id=$1', [survivor.application.id]),
    error => error.code === '42501' && /Purge manifest boundary/.test(error.message));
  await db.query('rollback');
  assert.ok((await step4Rows(db, survivor.application.id))['public.application_decision_events'].length > 0);
});

test('Step 4 without R8 fails closed: preview and schedule blocked, erasure freeze refused', async t => {
  const env = await install(t, 'legacy', { withR8: false }), { db, h } = env;
  const { x, subject } = await ready(env);
  await h.asUser(subject.owner);
  assert.ok(blockersOf(await x.preview(subject)).includes('schema_dependency_unknown'));
  assert.ok(blockersOf(await x.scheduleStatus(subject)).includes('schema_dependency_unknown'));
  await assert.rejects(x.freeze(subject), /Preview has blockers/);
  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1', [subject.candidate.id])).rows[0].n, 1);
});

test('R8 is refused atomically before Step 4 and when installed twice', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy'), { db } = env;
  await applyMigration(db);
  for (const name of chain) await run(db, await migration(name));
  let snapshot = await catalogSnapshot(db);
  await assert.rejects(run(db, await migration(r8)), error => error.code === '55000' && /sc_r8_requires_step4/.test(error.message));
  assert.deepEqual(await catalogSnapshot(db), snapshot);
  assert.equal(await tableExists(db, 'private.erasure_inventory_baseline_r8'), false);
  await run(db, await migration(step4));
  await run(db, await migration(r8));
  snapshot = await catalogSnapshot(db);
  await assert.rejects(run(db, await migration(r8)), error => error.code === '55000' && /sc_r8_already_installed/.test(error.message));
  assert.deepEqual(await catalogSnapshot(db), snapshot);
});

for (const variant of ['legacy', 'voice']) test(`R8 ${variant} rollback restores the Step 4 source state; Step 4 rollback waits for it`, async t => {
  const env = await install(t, variant), { db } = env;
  await assert.rejects(run(db, await rollback('20261030160000_sc_step4_interview_decision_down.sql')),
    error => error.code === '55000' && /sc_step4_down_requires_r8_down_first/.test(error.message));
  await run(db, await rollback('20261030160100_sc_step4_erasure_inventory_r8_down.sql'));
  assert.equal(await tableExists(db, 'private.erasure_inventory_baseline_r8'), false);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, sourceSignature[variant]);
  assert.equal((await db.query("select to_regprocedure('private.erasure_inventory_rows_r7(uuid,uuid[])') v")).rows[0].v, null);
  assert.equal((await db.query("select count(*)::int n from pg_proc where prosrc like '%erasure_inventory_baseline_r7%'")).rows[0].n, 4);
  // R8 can be reinstalled on the restored source state.
  await run(db, await migration(r8));
  await assertR8(db, variant);
});
