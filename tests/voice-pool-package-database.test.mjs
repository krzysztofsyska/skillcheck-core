// R6-2 (packages): a company with a package gets its voice interview pool
// automatically (20261121130000_r6_voice_package_pools.sql and
// lib/voice/package-pools.ts) on the full checked-in chain:
//  - FREE gives 1 interview; PRESELEKCJA, WERYFIKACJA and ASSESSMENT CENTER 10
//    each (owner 20.11.2026); an unknown package, an add-on, a pending or a
//    cancelled order give nothing;
//  - CV analyses, balances, orders and the package catalog are never changed;
//  - the prepared top-up entry point grants once per purchase, only to a
//    company that has a package, and is not callable by any API role;
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
const topupFn = 'private.sc19_voice_grant_topup(uuid,uuid,integer,timestamptz)';
const functions = [syncFn, topupFn, 'private.sc19_voice_package_events(uuid)', 'private.sc19_voice_package_reference(uuid,text,text)',
  'private.sc19_voice_package_allowance(text)', 'private.sc19_voice_package_window()'];
const migration = '20261121130000_r6_voice_package_pools.sql';

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
  const catalogOrder = async (company, kind = 'package', packageCode = 'PRESELEKCJA', status = 'paid') => {
    const reference = `synthetic-order-${randomUUID()}`;
    const order = await one(`insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,
      quantity,gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text)
      values($1,$2,$3,$4,$5,$6,$7,1,100,$8,$9,$10,'catalog-orders-v1','synthetic') returning id as v`,
    [company, users.owner, randomUUID(), version, kind, kind === 'package' ? packageCode : 'skill_test', packageCode,
      kind === 'package' ? 60 : 0, kind === 'package' ? null : 'skill_test', kind === 'package' ? 0 : 3]);
    if (status === 'paid') {
      if (kind === 'package') await db.query(`insert into private.sc19_credit_journal(company_id,reason,delta,reference)
        values($1,'paid_grant',60,$2)`, [company, `settlement:${reference}`]);
      await db.query(`update sc19_commerce.orders set status='paid',settlement_reference=$2,settled_by=$3,settled_at=now() where id=$1`,
        [order, reference, users.owner]);
    } else if (status === 'cancelled') await db.query("update sc19_commerce.orders set status='cancelled' where id=$1", [order]);
    return order;
  };
  // A new company with its own synthetic owner (one company per owner).
  const fresh = async () => {
    const owner = randomUUID();
    await h.asAdmin();
    await db.query('insert into auth.users(id) values($1)', [owner]);
    const f = await h.seed(owner);
    await h.asAdmin();
    return f;
  };
  // Everything a CV analysis or a sale depends on, as one digest.
  const salesState = () => one(`select md5(concat_ws('|',
    (select string_agg(j::text,',' order by j.id) from private.sc19_credit_journal j),
    (select string_agg(b::text,',' order by b.company_id) from private.sc19_balances b),
    (select string_agg(o::text,',' order by o.id) from sc19_commerce.orders o),
    (select string_agg(e::text,',' order by e.company_id,e.code) from sc19_commerce.entitlements e),
    (select string_agg(p::text,',' order by p.plan) from private.sc19_package_policy p))) as v`);

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

  await t.test('each package gets its own number of interviews; unknown, pending and cancelled give nothing', async () => {
    const allowance = async code => one('select private.sc19_voice_package_allowance($1) as v', [code]);
    assert.equal(await allowance('FREE'), 1);
    for (const code of ['PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER']) assert.equal(await allowance(code), 10, code);
    for (const code of [null, '', 'free', 'Preselekcja', 'skill_test', 'ADDON', 'ASSESSMENT CENTER']) assert.equal(await allowance(code), 0, String(code));
    const before = await salesState();
    const w = await fresh();
    await catalogOrder(w.companyId, 'package', 'WERYFIKACJA');
    assert.deepEqual(await sync(w.companyId), { package_pools: 1, created: 1 }, 'WERYFIKACJA = one package (order + journal row)');
    const ac = await fresh();
    await catalogOrder(ac.companyId, 'package', 'ASSESSMENT_CENTER');
    assert.deepEqual(await sync(ac.companyId), { package_pools: 1, created: 1 });
    assert.deepEqual((await pools(w.companyId)).map(p => p.total), [10]);
    assert.deepEqual((await pools(ac.companyId)).map(p => p.total), [10]);
    // An order that is not paid gives nothing, and its later payment gives exactly one pool.
    const q = await fresh();
    await catalogOrder(q.companyId, 'package', 'WERYFIKACJA', 'cancelled');
    const pending = await catalogOrder(q.companyId, 'package', 'ASSESSMENT_CENTER', 'pending');
    assert.deepEqual(await sync(q.companyId), { package_pools: 0, created: 0 });
    assert.equal((await pools(q.companyId)).length, 0);
    const reference = `synthetic-order-${randomUUID()}`;
    await db.query(`insert into private.sc19_credit_journal(company_id,reason,delta,reference) values($1,'paid_grant',60,$2)`,
      [q.companyId, `settlement:${reference}`]);
    await db.query(`update sc19_commerce.orders set status='paid',settlement_reference=$2,settled_by=$3,settled_at=now() where id=$1`,
      [pending, reference, users.owner]);
    const afterPayment = await salesState();
    assert.deepEqual(await sync(q.companyId), { package_pools: 1, created: 1 });
    assert.deepEqual((await pools(q.companyId)).map(p => p.total), [10]);
    // A WERYFIKACJA order's CV journal row is the order, never an extra PRESELEKCJA.
    assert.deepEqual((await db.query('select package_code from private.sc19_voice_package_events($1)', [w.companyId])).rows,
      [{ package_code: 'WERYFIKACJA' }]);
    // Syncing never changes CV analyses, balances, orders, sales entitlements or the package policy.
    assert.equal(await salesState(), afterPayment, 'sync wrote nothing to the sales/CV data');
    assert.notEqual(before, afterPayment, 'the synthetic sales above did change it (the digest is live)');
    for (const company of [a.companyId, b.companyId]) await sync(company);
    assert.equal(await salesState(), afterPayment);
  });

  await t.test('a catalog order settled by the real settlement function is one package with its own code', async () => {
    const operator = users.owner;
    await db.query('insert into public.platform_operators(user_id) values($1) on conflict do nothing', [operator]);
    const settle = async (order, gross = 100) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [operator]);
      try { await db.query("select public.sc19_settle_catalog_order($1,$2,$3,'PLN')", [order, `synthetic-real-${randomUUID()}`, gross]); }
      finally { await db.query("select set_config('request.jwt.claim.sub','',false)"); }
    };
    // With CV credits (journal row + order) and without (order only): one pool each, with the order's own code.
    const withCv = await fresh();
    await settle(await catalogOrder(withCv.companyId, 'package', 'PRESELEKCJA', 'pending'));
    const noCv = await fresh();
    const order = await one(`insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,
      quantity,gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text)
      values($1,$2,$3,$4,'package','ASSESSMENT_CENTER','ASSESSMENT_CENTER',1,100,0,null,0,'catalog-orders-v1','synthetic') returning id as v`,
    [noCv.companyId, users.owner, randomUUID(), version]);
    await settle(order);
    assert.equal(await one("select count(*)::int as v from private.sc19_credit_journal where company_id=$1 and reason='paid_grant'", [withCv.companyId]), 1,
      'the real settlement wrote a CV journal row');
    for (const [f, code] of [[withCv, 'PRESELEKCJA'], [noCv, 'ASSESSMENT_CENTER']]) {
      assert.deepEqual((await db.query('select package_code from private.sc19_voice_package_events($1)', [f.companyId])).rows, [{ package_code: code }]);
      assert.deepEqual(await sync(f.companyId), { package_pools: 1, created: 1 });
      assert.deepEqual(await sync(f.companyId), { package_pools: 1, created: 0 });
      assert.deepEqual((await pools(f.companyId)).map(p => p.total), [10]);
    }
  });

  await t.test('prepared top-up: once per purchase, only with a package, never callable by API roles', async () => {
    const topup = (company, purchase, n = 5, days = 90) => db.query(
      `select * from private.sc19_voice_grant_topup($1,$2,$3,clock_timestamp()+make_interval(days=>$4))`, [company, purchase, n, days]);
    const none = await fresh();
    await rejects(topup(none.companyId, randomUUID()), 'PT422', 'voice_topup_package_required');
    assert.equal((await pools(none.companyId)).length, 0);
    const buyer = await fresh();
    await trial(buyer.companyId);
    const purchase = randomUUID();
    const first = (await topup(buyer.companyId, purchase, 5, 90)).rows[0];
    assert.equal(first.replayed, false);
    // The same purchase again: the same pool; changed terms: refused.
    const again = (await db.query(`select * from private.sc19_voice_grant_topup($1,$2,5,(select expires_at from private.sc19_voice_entitlements where id=$3))`,
      [buyer.companyId, purchase, first.entitlement_id])).rows[0];
    assert.deepEqual(again, { entitlement_id: first.entitlement_id, replayed: true });
    await assert.rejects(topup(buyer.companyId, purchase, 6, 90));
    // One purchase is one pool: the same purchase reference for another company is refused.
    await trial(none.companyId);
    await rejects(topup(none.companyId, purchase, 5, 90), '23505', 'voice_grant_reference_conflict');
    assert.equal((await pools(none.companyId)).length, 0);
    // A retry with a recomputed expiry is a different term and is refused (the caller persists what it sold).
    await rejects(topup(buyer.companyId, purchase, 5, 91), '23505');
    // A company whose only package is past its window cannot top up.
    const stale = await fresh();
    await trial(stale.companyId, new Date(Date.now() - 800 * 86400000).toISOString());
    await rejects(topup(stale.companyId, randomUUID()), 'PT422', 'voice_topup_package_required');
    for (const bad of [[null, purchase], [buyer.companyId, null]]) await rejects(topup(bad[0], bad[1]), '22023');
    await rejects(topup(buyer.companyId, randomUUID(), 0), '22023');
    await rejects(topup(buyer.companyId, randomUUID(), 1001), '22023');
    await rejects(topup(randomUUID(), randomUUID()), 'PT404');
    // A top-up never changes the package pool and the package pool never absorbs it.
    assert.deepEqual(await sync(buyer.companyId), { package_pools: 1, created: 1 });
    assert.deepEqual((await pools(buyer.companyId)).map(p => p.total).sort((x, y) => x - y), [1, 5]);
    assert.deepEqual(await balance(buyer.companyId), { granted: 6, used: 0, reserved: 0, available: 6 });
    await h.asUser(users.owner);
    await rejects(topup(a.companyId, randomUUID()), '42501');
    await h.asAdmin();
  });

  await t.test('a package pool is valid 3 months (owner 20.11.2026); an older package gives no pool', async () => {
    assert.equal(await one("select private.sc19_voice_package_window()=interval '3 months' as v"), true);
    const d = await h.seed(users.viewer);
    await h.asAdmin();
    await trial(d.companyId, new Date(Date.now() - 100 * 86400000).toISOString());
    assert.deepEqual(await sync(d.companyId), { package_pools: 0, created: 0 });
    assert.equal((await pools(d.companyId)).length, 0);
    // A package bought 2 months ago still gives a pool, ending 3 months after the package.
    const recent = await fresh();
    const boughtAt = await one("select date_trunc('second',clock_timestamp()-interval '2 months') as v");
    await trial(recent.companyId, boughtAt.toISOString());
    assert.deepEqual(await sync(recent.companyId), { package_pools: 1, created: 1 });
    assert.equal(await one(`select expires_at=date_trunc('second',$2::timestamptz)+interval '3 months' as v
      from private.sc19_voice_entitlements where company_id=$1`, [recent.companyId, boughtAt]), true);
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
    // Company A: the FREE pool (ends 3 months after the trial) is picked before later packages.
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
    await db.query(await readFile(new URL('../supabase/rollbacks/20261121130000_r6_voice_package_pools_down.sql', import.meta.url), 'utf8'));
    for (const fn of functions) assert.equal(await one('select to_regprocedure($1) is null as v', [fn]), true, fn);
    assert.equal(await one('select to_regprocedure($1) is not null as v',
      ['private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)']), true, 'operator grant stays');
    assert.equal(await one('select count(*)::int as v from private.sc19_voice_entitlements'), rows);
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
  });
});
