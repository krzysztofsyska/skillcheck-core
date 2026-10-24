import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRankingHarness } from './helpers/screening-ranking-fixture.mjs';
import { executionHarness, setupExecutionLedger } from './helpers/erasure-execution-fixture.mjs';
import { retentionHarness } from './helpers/retention-scheduler-fixture.mjs';
import { bootRetention, voiceTables } from './helpers/voice-retention-fixture.mjs';
import {
  accountingSnapshot, applyMigration, assertR6, blockersOf, bootMigrationDatabase,
  catalogSnapshot, installSource, maintenanceUrl, paymentHarness, paymentUsers, seedSyntheticPolicy,
} from './helpers/sc19-migration-fixture.mjs';

const rows = async (db, table) => (await db.query(`select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text collate "C"`)).rows;

function grantSyntheticQuota(h, defaultOwner) {
  const originalSeed = h.seed;
  h.seed = async (...args) => {
    if (args[0] === undefined && defaultOwner) args[0] = defaultOwner;
    const f = await originalSeed(...args); await h.asAdmin();
    await h.db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-retention-${f.companyId}`]);
    await h.asUser(f.owner); return f;
  };
}

async function ledgerFor(env) {
  // A different database, not a transaction-local mock: product dump/restore or
  // ROLLBACK cannot rewind the independently signed/encrypted recovery ledger.
  const ledgerDb = await env.connect(await env.createDatabase());
  return setupExecutionLedger(retentionHarness(env.h), ledgerDb);
}

async function purge(x, f) {
  const state = await x.freeze(f);
  await x.transition(state.request_id, 0, 'authorized');
  await x.transition(state.request_id, 1, 'erasing');
  await x.purge(state.request_id, 2);
  await x.transition(state.request_id, 2, 'active_data_erased');
  return state;
}

async function assertGone(h, f) {
  await h.asAdmin();
  for (const [table, column, id] of [
    ['public.candidates', 'id', f.candidate.id], ['public.candidate_documents', 'candidate_id', f.candidate.id],
    ['public.applications', 'candidate_id', f.candidate.id], ['public.screening_analysis_versions', 'application_id', f.application.id],
  ]) assert.equal((await h.db.query(`select count(*)::int n from ${table} where ${column}=$1`, [id])).rows[0].n, 0, table);
}

async function assertKnown(x, f) {
  await x.h.asUser(f.owner);
  assert.equal(blockersOf(await x.preview(f)).includes('schema_dependency_unknown'), false);
  assert.equal(blockersOf(await x.scheduleStatus(f)).includes('schema_dependency_unknown'), false);
}

async function assertRuntimeDriftDenied(x, survivor) {
  for (const ddl of [
    'create table public.unreviewed_candidate_copy(candidate_id uuid)',
    'create view public.unreviewed_candidate_view as select id from public.candidates',
    'alter table private.sc19_balances add column unreviewed_note text',
    'create schema incoming_fixture;create table incoming_fixture.unknown(candidate_id uuid references public.candidates(id))',
  ]) {
    await x.h.asAdmin(); await x.db.query('begin');
    try {
      await x.db.query(ddl); await x.h.asUser(survivor.owner);
      assert.ok(blockersOf(await x.preview(survivor)).includes('schema_dependency_unknown'), ddl);
      assert.ok(blockersOf(await x.scheduleStatus(survivor)).includes('schema_dependency_unknown'), ddl);
    } finally { await x.db.query('rollback'); await x.h.asAdmin(); }
  }
}

test('SC-019 v1 refuses real terminal signed R4 history and retains its recovery obligations', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy'), { db, h } = env;
  const x = await ledgerFor(env); await x.configure();
  const f = await x.ready({ rich: true }); await purge(x, f); await assertGone(h, f);
  const tables = ['private.erasure_executions', 'private.erasure_verified_ledger_events', 'private.erasure_receipts', 'private.retired_candidate_ids'];
  const before = {};
  for (const table of tables) { before[table] = await rows(db, table); assert.ok(before[table].length > 0, table); }
  const signedBefore = await rows(x.ledgerDb, 'erasure_ledger.events'), catalogBefore = await catalogSnapshot(db);
  await assert.rejects(applyMigration(db), error => error.code === '55000' && /sc19_signed_erasure_history_transition_required/.test(error.message));
  assert.deepEqual(await catalogSnapshot(db), catalogBefore);
  for (const table of tables) assert.deepEqual(await rows(db, table), before[table], table);
  assert.deepEqual(await rows(x.ledgerDb, 'erasure_ledger.events'), signedBefore);
  assert.equal((await db.query("select to_regclass('private.erasure_inventory_baseline_r6') value")).rows[0].value, null);
});

test('SC-019 R6 legacy purge and native dump/restore preserve accounting and re-erase candidates', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy'), { db, h } = env;
  await applyMigration(db); await assertR6(db); await seedSyntheticPolicy(db); grantSyntheticQuota(h, paymentUsers.owner);
  const x = await ledgerFor(env); await x.configure();
  const subject = await x.ready({ rich: true }), survivor = await x.ready({ owner: paymentUsers.otherOwner });
  const p = paymentHarness(env); await p.seed(subject, survivor);
  for (const f of [subject, survivor]) {
    const checkout = await p.runtime(f.owner).service.checkout(p.request(f.companyId));
    await p.notify(p.payment(checkout));
  }
  await assertKnown(x, subject); await assertKnown(x, survivor);
  await h.asAdmin();
  assert.deepEqual((await db.query('select adapter from private.erasure_purge_rows($1,$2) where adapter like $3',
    [subject.companyId, [subject.candidate.id], 'private.sc19%'])).rows, []);
  const before = await accountingSnapshot(db);
  const survivorBefore = (await db.query('select to_jsonb(c) row from public.candidates c where id=$1', [survivor.candidate.id])).rows[0];
  // Do not silently replace the required native dump with a SQL fixture or skip.
  for (const key of ['PG_DUMP_BIN', 'PG_RESTORE_BIN']) assert.ok(process.env[key], `${key} required for real dump/restore`);
  const clientVersions = [process.env.PG_DUMP_BIN, process.env.PG_RESTORE_BIN].map(binary => execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim());
  for (const version of clientVersions) {
    const major = Number(version.match(/PostgreSQL\)?\s+(\d+)/)?.[1]);
    assert.ok(major >= Number(process.env.SC19_TEST_PG_MAJOR) && major <= 17, `Unsupported PostgreSQL client: ${version}`);
    t.diagnostic(version);
  }
  const directory = await mkdtemp(join(tmpdir(), 'sc19-migration-dump-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dump = join(directory, 'before-purge.dump');
  execFileSync(process.env.PG_DUMP_BIN, ['--format=custom', '--file', dump, '--dbname', env.databaseUrl(env.name)],
    { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.ok((await stat(dump)).size > 10000);
  const state = await purge(x, subject); await assertGone(h, subject);
  assert.equal((await x.requestStatus(subject, state.request_id)).phase, 'active_data_erased');
  assert.deepEqual(await accountingSnapshot(db), before);
  assert.deepEqual((await db.query('select to_jsonb(c) row from public.candidates c where id=$1', [survivor.candidate.id])).rows[0], survivorBefore);
  await assertRuntimeDriftDenied(x, survivor);

  const restoredName = await env.createDatabase();
  execFileSync(process.env.PG_RESTORE_BIN, ['--exit-on-error', '--dbname', env.databaseUrl(restoredName), dump],
    { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const restored = await env.connect(restoredName), target = executionHarness(createRankingHarness(restored));
  await assertR6(restored); assert.deepEqual(await accountingSnapshot(restored), before);
  assert.equal((await restored.query('select count(*)::int n from public.candidates where id=$1', [subject.candidate.id])).rows[0].n, 1, 'Native restored snapshot really predates purge');
  await target.configure({ restore_isolated: true });
  assert.equal((await x.replay(target)).replayed, 1);
  await assertGone(target.h, subject);
  assert.deepEqual(await accountingSnapshot(restored), before, 'Verified replay cannot refund/resettle accounting');
  assert.deepEqual((await restored.query('select to_jsonb(c) row from public.candidates c where id=$1', [survivor.candidate.id])).rows[0], survivorBefore);
  await x.replay(target); await assertGone(target.h, subject);
  assert.deepEqual(await accountingSnapshot(restored), before, 'Replay is idempotent');
  await assertR6(restored);
});

test('SC-019 R6 voice retains adapter refusal, signed purge and independent-ledger restore', async t => {
  const maintenance = maintenanceUrl();
  assert.equal(new URL(process.env.SCREENING_TEST_DATABASE_URL ?? '').href, maintenance.href,
    'Voice migration fixture must use the same disposable local PostgreSQL service');
  const env = await bootRetention(t, { afterRetention: applyMigration }), { db, h, x } = env;
  assert.equal(Math.floor(Number((await db.query("select current_setting('server_version_num') value")).rows[0].value) / 10000), Number(process.env.SC19_TEST_PG_MAJOR));
  await assertR6(db, 'voice'); await seedSyntheticPolicy(db); grantSyntheticQuota(h);
  const subject = await env.ready(), survivor = await env.ready();
  await env.prepare(subject); await env.prepare(survivor);
  await assertKnown(x, subject.f); await assertKnown(x, survivor.f);
  await h.asAdmin(); await db.query('begin');
  try {
    await db.query('alter table private.voice_plan_request_keys disable trigger user');
    await db.query(`insert into private.voice_plan_request_keys values($1,$2,'generate',$3,$4,null,now(),'test',now()+interval '1 day')`,
      [subject.f.companyId, subject.f.owner, randomUUID(), 'a'.repeat(64)]);
    await db.query('alter table private.voice_plan_request_keys enable trigger user');
    await h.asUser(subject.f.owner);
    assert.ok(blockersOf(await x.preview(subject.f)).includes('voice_request_adapter_unknown'));
  } finally { await db.query('rollback'); await h.asAdmin(); }
  const before = await accountingSnapshot(db), quotaBefore = await env.quota(subject);
  await db.query('begin');
  try {
    const state = await env.erasing(subject);
    await x.purge(state.request_id, 2); await x.transition(state.request_id, 2, 'active_data_erased');
    await h.asAdmin();
    for (const table of voiceTables) assert.equal(await env.count(table, subject.f.companyId), 0, table);
    assert.equal(await env.count('private.sc010c_voice_preparations', survivor.f.companyId), 1);
    assert.deepEqual(await accountingSnapshot(db), before);
  } finally { await db.query('rollback'); await h.asAdmin(); }
  assert.equal(await env.count('private.sc010c_voice_preparations', subject.f.companyId), 1, 'Rollback restores the product snapshot, not the independent ledger');
  await x.configure({ restore_isolated: true });
  assert.equal((await x.replay()).replayed, 1);
  for (const table of voiceTables) assert.equal(await env.count(table, subject.f.companyId), 0, table);
  assert.equal(await env.count('private.sc010c_voice_preparations', survivor.f.companyId), 1);
  assert.deepEqual(await accountingSnapshot(db), before);
  const quotaAfter = await env.quota(subject);
  assert.equal(quotaAfter.total, quotaBefore.total);
  assert.equal(quotaAfter.used, quotaBefore.used);
  assert.equal(quotaAfter.reserved, quotaBefore.reserved - 1, 'Existing voice purge releases the one cancelled reservation');
  assert.equal(BigInt(quotaAfter.revision), BigInt(quotaBefore.revision) + 1n);
  await x.replay();
  assert.deepEqual(await env.quota(subject), quotaAfter, 'Repeated verified replay cannot release the reservation twice');
  await x.configure({ restore_isolated: false });
  await assertRuntimeDriftDenied(x, survivor.f); await assertR6(db, 'voice');
});
