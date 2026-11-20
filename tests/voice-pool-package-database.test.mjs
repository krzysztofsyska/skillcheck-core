// R6-2 (packages): a company with a package gets its voice interview pool
// automatically (20261121100000_r6_voice_package_pools.sql and
// lib/voice/package-pools.ts) on the full checked-in chain:
//  - FREE gives 1 interview, every paid package 10, an add-on gives nothing;
//  - FREE and an operator trial are the same single interview;
//  - a catalog settlement (order + journal row) is one package, not two;
//  - retries and parallel calls never grant twice;
//  - one company's packages never give or show a pool to another company.
// Native disposable PostgreSQL only; synthetic data; package data is only read;
// no provider, no network, nothing granted to API roles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase, seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';
import { ensurePackageVoicePool, PackageVoicePoolError } from '../lib/voice/package-pools.ts';

// Same full-chain signature as tests/voice-pool-grant-database.test.mjs: functions only.
const signature = '4dab3fae234c8233104d691381b62710570324bee0db8bd5df4be28f3d6702f7';
const syncFn = 'private.sc19_voice_sync_package_pools(uuid)';
const functions = [syncFn, 'private.sc19_voice_package_events(uuid)', 'private.sc19_voice_package_reference(uuid,text,text)'];
const migration = '20261121100000_r6_voice_package_pools.sql';

test('R6-2 packages: FREE 1, paid 10, idempotent, tenant-isolated, owner-only', async t => {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const a = await h.seed(users.owner);
  const b = await h.seed(users.otherOwner);
  await h.asAdmin();
  await seedSyntheticPolicy(db);
  const sync = async (company, client = db) =>
    (await client.query(`select * from ${syncFn.replace(/\(.*$/, '')}($1)`, [company])).rows[0];
  const pools = async company => (await db.query(
    'select total,used,reserved,grant_reference from private.sc19_voice_entitlements where company_id=$1 order by created_at,id',
    [company])).rows;
  const balance = async company => (await db.query('select * from private.sc19_voice_interview_balance($1)', [company])).rows[0];
  const rejects = (promise, code, message) => assert.rejects(promise, e => e.code === code && (!message || e.message === message));
  const trial = (company, at = null) => db.query(
    `insert into private.sc19_credit_journal(company_id,reason,delta,reference,created_at)
     values($1,'trial',5,$2,coalesce($3::timestamptz,now()))`, [company, `trial:${randomUUID()}`, at]);
  const paid = company => db.query('select private.sc19_grant_paid($1,$2)', [company, `synthetic-voice-${randomUUID()}`]);
  const version = await one("insert into pricing.catalog_versions(vat_basis_points) values(2300) returning id as v");
  // A catalog order settled the way sc19_settle_catalog_order does it: CV journal
  // row and the paid order under the same settlement reference.
  const catalogOrder = async (company, kind = 'package') => {
    const reference = `synthetic-order-${randomUUID()}`;
    const order = await one(`insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,
      quantity,gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text)
      values($1,$2,$3,$4,$5,$6,'PRESELEKCJA',1,100,$7,$8,$9,'catalog-orders-v1','synthetic') returning id as v`,
    [company, users.owner, randomUUID(), version, kind, kind === 'package' ? 'PRESELEKCJA' : 'skill_test',
      kind === 'package' ? 60 : 0, kind === 'package' ? null : 'skill_test', kind === 'package' ? 0 : 3]);
    if (kind === 'package') await db.query(`insert into private.sc19_credit_journal(company_id,reason,delta,reference)
      values($1,'paid_grant',60,$2)`, [company, `settlement:${reference}`]);
    await db.query(`update sc19_commerce.orders set status='paid',settlement_reference=$2,settled_by=$3,settled_at=now() where id=$1`,
      [order, reference, users.owner]);
  };

  await t.test('functions only, owner-only, nothing granted, package data untouched', async () => {
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    for (const fn of functions) {
      assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
      assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""', fn);
      assert.equal(await one(`select count(*)::int as v from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=$1::regprocedure and a.grantee<>p.proowner`, [fn]), 0, `${fn} has no grantee besides its owner`);
    }
    for (const role of ['anon', 'authenticated', 'service_role', 'screening_worker', 'voice_permission_verifier']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      for (const fn of functions) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, `${role} ${fn}`);
    }
    await h.asUser(users.owner);
    await rejects(sync(a.companyId), '42501');
    await h.asAdmin();
    const source = (await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').toLowerCase();
    for (const write of ['insert into private.sc19_credit_journal', 'update private.sc19_credit_journal', 'sc19_commerce.entitlements',
      'update sc19_commerce', 'insert into sc19_commerce', 'private.sc19_balances', 'pricing.', 'create table', 'alter table',
      'create trigger', 'grant execute', 'stripe', 'p24', 'retell'])
      assert.ok(!source.includes(write), `migration code mentions ${write}`);
  });

  await t.test('no package: no pool and nothing to pick', async () => {
    assert.deepEqual(await sync(a.companyId), { package_pools: 0, created: 0 });
    assert.deepEqual(await ensurePackageVoicePool(db, a.companyId), { packagePools: 0, created: 0, entitlementId: null, available: 0 });
    assert.equal(await one('select count(*)::int as v from private.sc19_voice_entitlements'), 0);
  });

  await t.test('FREE gives exactly 1 interview, once, and is the same unit as an operator trial', async () => {
    await trial(a.companyId);
    assert.deepEqual(await sync(a.companyId), { package_pools: 1, created: 1 });
    assert.deepEqual(await sync(a.companyId), { package_pools: 1, created: 0 }, 'a retry grants nothing');
    const [row] = await pools(a.companyId);
    assert.equal(row.total, 1);
    assert.equal(row.grant_reference, await one('select private.sc19_voice_trial_reference($1) as v', [a.companyId]));
    // An operator trial after FREE is the same single unit.
    const replay = (await db.query(`select * from private.sc19_voice_grant_interviews($1,'trial_single',1,null,
      clock_timestamp()+interval '30 days',$2,clock_timestamp()+interval '30 days')`, [a.companyId, randomUUID()])).rows[0];
    assert.equal(replay.replayed, true);
    assert.deepEqual(await balance(a.companyId), { granted: 1, used: 0, reserved: 0, available: 1 });
    // Operator trial first (company B), FREE afterwards: still one interview.
    await db.query(`select * from private.sc19_voice_grant_interviews($1,'trial_single',1,null,
      clock_timestamp()+interval '30 days',$2,clock_timestamp()+interval '30 days')`, [b.companyId, randomUUID()]);
    await trial(b.companyId);
    assert.deepEqual(await sync(b.companyId), { package_pools: 1, created: 0 });
    assert.equal((await pools(b.companyId)).length, 1);
  });

  await t.test('every paid package gives 10; a catalog settlement counts once; an add-on gives nothing', async () => {
    await paid(a.companyId);
    assert.deepEqual(await sync(a.companyId), { package_pools: 2, created: 1 });
    await catalogOrder(a.companyId);
    await catalogOrder(a.companyId, 'addon');
    assert.deepEqual(await sync(a.companyId), { package_pools: 3, created: 1 }, 'order + journal row are one package; add-on none');
    await paid(a.companyId);
    assert.deepEqual(await sync(a.companyId), { package_pools: 4, created: 1 });
    assert.deepEqual(await sync(a.companyId), { package_pools: 4, created: 0 });
    assert.deepEqual((await pools(a.companyId)).map(p => p.total), [1, 10, 10, 10]);
    assert.deepEqual(await balance(a.companyId), { granted: 31, used: 0, reserved: 0, available: 31 });
    // Every pool has its own reference.
    const refs = (await pools(a.companyId)).map(p => p.grant_reference);
    assert.equal(new Set(refs).size, refs.length);
    // Company B never gains anything from A's packages.
    assert.deepEqual(await balance(b.companyId), { granted: 1, used: 0, reserved: 0, available: 1 });
  });

  await t.test('a used pool stays used: syncing again never refills it', async () => {
    const [first] = (await db.query('select id from private.sc19_voice_entitlements where company_id=$1 and total=10 order by created_at,id limit 1', [a.companyId])).rows;
    await db.query('update private.sc19_voice_entitlements set reserved=reserved+1 where id=$1', [first.id]);
    await db.query('update private.sc19_voice_entitlements set used=used+1,reserved=reserved-1 where id=$1', [first.id]);
    assert.deepEqual(await sync(a.companyId), { package_pools: 4, created: 0 });
    assert.deepEqual(await balance(a.companyId), { granted: 31, used: 1, reserved: 0, available: 30 });
  });

  await t.test('parallel calls for a new package grant it exactly once', async () => {
    const c = await h.seed(users.recruiter);
    await h.asAdmin();
    await paid(c.companyId);
    await trial(c.companyId);
    const clients = await Promise.all(Array.from({ length: 6 }, () => env.connect()));
    const results = await Promise.all(clients.map(client => sync(c.companyId, client)));
    assert.equal(results.reduce((sum, r) => sum + r.created, 0), 2);
    assert.ok(results.every(r => r.package_pools === 2));
    assert.deepEqual((await pools(c.companyId)).map(p => p.total).sort((x, y) => x - y), [1, 10]);
  });

  await t.test('a package older than its 365-day window gives no pool', async () => {
    const d = await h.seed(users.viewer);
    await h.asAdmin();
    await trial(d.companyId, new Date(Date.now() - 366 * 86400000).toISOString());
    assert.deepEqual(await sync(d.companyId), { package_pools: 0, created: 0 });
    assert.equal((await pools(d.companyId)).length, 0);
  });

  await t.test('trusted server helper: syncs, picks the pool that ends first, refuses anything else', async () => {
    const e = await h.seed(users.outsider);
    await h.asAdmin();
    await paid(e.companyId);
    const picked = await ensurePackageVoicePool(db, e.companyId);
    assert.equal(picked.created, 1);
    assert.equal(picked.packagePools, 1);
    assert.equal(picked.available, 10);
    assert.equal(picked.entitlementId, await one('select id as v from private.sc19_voice_entitlements where company_id=$1', [e.companyId]));
    const again = await ensurePackageVoicePool(db, e.companyId);
    assert.deepEqual(again, { ...picked, created: 0 });
    // Company A: the FREE pool (ends 365 days after the trial) is picked before later packages.
    const forA = await ensurePackageVoicePool(db, a.companyId);
    assert.equal(forA.available, 30);
    assert.equal(forA.entitlementId, await one(`select id as v from private.sc19_voice_entitlements
      where company_id=$1 and used+reserved<total order by expires_at,id limit 1`, [a.companyId]));
    assert.notEqual(forA.entitlementId, picked.entitlementId);
    for (const bad of ['', 'not-a-uuid', randomUUID().toUpperCase()])
      await assert.rejects(ensurePackageVoicePool(db, bad), e2 => e2 instanceof PackageVoicePoolError && e2.message === 'VOICE_PACKAGE_POOL_UNAVAILABLE');
    await assert.rejects(ensurePackageVoicePool(db, randomUUID()), e2 => e2 instanceof PackageVoicePoolError);
    // A tenant session (not the trusted server) cannot use it.
    await h.asUser(users.owner);
    await assert.rejects(ensurePackageVoicePool(db, a.companyId), e2 => e2 instanceof PackageVoicePoolError);
    await h.asAdmin();
  });

  await t.test('rollback removes only the functions; pools and signature stay', async () => {
    const rows = await one('select count(*)::int as v from private.sc19_voice_entitlements');
    await db.query(await readFile(new URL('../supabase/rollbacks/20261121100000_r6_voice_package_pools_down.sql', import.meta.url), 'utf8'));
    for (const fn of functions) assert.equal(await one('select to_regprocedure($1) is null as v', [fn]), true, fn);
    assert.equal(await one('select to_regprocedure($1) is not null as v',
      ['private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)']), true, 'operator grant stays');
    assert.equal(await one('select count(*)::int as v from private.sc19_voice_entitlements'), rows);
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
  });
});
