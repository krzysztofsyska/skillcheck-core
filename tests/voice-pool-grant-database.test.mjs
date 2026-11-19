// R6-2 (freeze-independent part): operator grant of voice interviews and the
// remaining-interview check (20261119150000_r6_voice_pool_operator_grant.sql) on
// the full checked-in chain. Native disposable PostgreSQL only; synthetic data;
// no package, price, order or provider; nothing granted to API roles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

// Full current chain: R21 since R6-1c part 5 (voice settlement) builds on this step.
const signature = '680f3eaa808e7280b545ad9aaabaa0d4144aafdf8c26f40d174d7670d4da7189';
const grantFn = 'private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)';
const functions = [grantFn, 'private.sc19_voice_interview_balance(uuid)', 'private.sc19_voice_trial_reference(uuid)'];
const migration = '20261119150000_r6_voice_pool_operator_grant.sql';

test('R6-2: operator voice interview grant is owner-only, trial is single and once, balance is exact', async t => {
  const { db } = await bootMigrationDatabase(t);
  const h = await setupRankingDatabase(db, { throughMigration: null });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const a = await h.seed(users.owner);
  const b = await h.seed(users.otherOwner);
  await h.asAdmin();
  const grant = (company, kind, n, reference = null, days = 30) => db.query(
    `select * from ${grantFn.replace(/\(.*$/, '')}($1,$2,$3,$4,clock_timestamp()+make_interval(days=>$5),$6,clock_timestamp()+interval '30 days')`,
    [company, kind, n, reference, days, randomUUID()]).then(r => r.rows[0]);
  const balance = async company => (await db.query('select * from private.sc19_voice_interview_balance($1)', [company])).rows[0];
  const rejects = (promise, code, message) => assert.rejects(promise, e => e.code === code && (!message || e.message === message));

  await t.test('functions only: schema signature and table shape unchanged, nothing seeded', async () => {
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one('select count(*)::int as v from private.sc19_voice_entitlements'), 0);
    for (const fn of functions) {
      assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
      assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""', fn);
      assert.equal(await one(`select count(*)::int as v from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=$1::regprocedure and a.grantee<>p.proowner`, [fn]), 0, `${fn} has no grantee besides its owner`);
    }
    const source = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
    const code = source.replace(/--[^\n]*/g, '');
    for (const word of ['pricing_catalog', 'sc19_orders', 'package', 'price', 'PRESELEKCJA', 'FREE', 'stripe', 'p24'])
      assert.ok(!code.toLowerCase().includes(word.toLowerCase()), `migration code mentions ${word}`);
  });

  await t.test('API roles and tenants cannot execute any grant or balance function', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'screening_worker', 'voice_permission_verifier']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      for (const fn of functions) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, `${role} ${fn}`);
    }
    await h.asUser(users.owner);
    await rejects(db.query(`select * from private.sc19_voice_grant_interviews($1,'trial_single',1,null,clock_timestamp()+interval '1 day',$2,clock_timestamp()+interval '1 day')`,
      [a.companyId, randomUUID()]), '42501');
    await rejects(db.query('select * from private.sc19_voice_interview_balance($1)', [a.companyId]), '42501');
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.sc19_voice_entitlements'), 0);
  });

  let trialId;
  await t.test('trial_single is exactly one interview, once per company, idempotent', async () => {
    assert.deepEqual(await balance(a.companyId), { granted: 0, used: 0, reserved: 0, available: 0 });
    await rejects(grant(a.companyId, 'trial_single', 2), '22023', 'voice_grant_trial_is_single');
    await rejects(grant(a.companyId, 'trial_single', 1, randomUUID()), '22023', 'voice_grant_trial_reference_derived');
    const first = await grant(a.companyId, 'trial_single', 1);
    assert.equal(first.replayed, false);
    trialId = first.entitlement_id;
    const row = (await db.query('select * from private.sc19_voice_entitlements where id=$1', [trialId])).rows[0];
    assert.equal(row.total, 1);
    assert.equal(row.grant_reference, await one('select private.sc19_voice_trial_reference($1) as v', [a.companyId]));
    assert.equal(row.active && row.grant_verified && row.company_verified, true);
    assert.equal(await one('select private.sc19_voice_entitlement_eligible(e) as v from private.sc19_voice_entitlements e where id=$1', [trialId]), true);
    const again = await grant(a.companyId, 'trial_single', 1, null, 90);
    assert.deepEqual(again, { entitlement_id: trialId, replayed: true }, 'a second trial never adds a unit');
    assert.deepEqual(await balance(a.companyId), { granted: 1, used: 0, reserved: 0, available: 1 });
    // Once ever: after the unit is used up, or the grant is revoked, the trial is not restarted.
    await db.query('update private.sc19_voice_entitlements set reserved=reserved+1 where id=$1', [trialId]);
    assert.deepEqual(await balance(a.companyId), { granted: 1, used: 0, reserved: 1, available: 0 });
    await db.query('update private.sc19_voice_entitlements set used=used+1,reserved=reserved-1 where id=$1', [trialId]);
    assert.deepEqual(await balance(a.companyId), { granted: 1, used: 1, reserved: 0, available: 0 });
    await rejects(db.query('update private.sc19_voice_entitlements set reserved=reserved+1 where id=$1', [trialId]), 'PT402');
    await db.query('update private.sc19_voice_entitlements set revoked_at=clock_timestamp() where id=$1', [trialId]);
    assert.deepEqual(await grant(a.companyId, 'trial_single', 1), { entitlement_id: trialId, replayed: true });
    assert.equal(await one('select count(*)::int as v from private.sc19_voice_entitlements where company_id=$1', [a.companyId]), 1);
    assert.deepEqual(await balance(a.companyId), { granted: 0, used: 0, reserved: 0, available: 0 }, 'revoked grant is not counted');
  });

  await t.test('operator_manual is idempotent by reference and never collides with a trial', async () => {
    const reference = randomUUID();
    await rejects(grant(b.companyId, 'operator_manual', 3), '22023', 'voice_grant_reference_required');
    await rejects(grant(b.companyId, 'operator_manual', 0, reference), '22023', 'voice_grant_interviews_invalid');
    await rejects(grant(b.companyId, 'operator_manual', 1001, reference), '22023', 'voice_grant_interviews_invalid');
    await rejects(grant(b.companyId, 'other', 1, reference), '22023', 'voice_grant_kind_invalid');
    const bTrialReference = await one('select private.sc19_voice_trial_reference($1) as v', [b.companyId]);
    await rejects(grant(b.companyId, 'operator_manual', 1, bTrialReference), '22023', 'voice_grant_reference_reserved');
    // A replay names exactly the same terms (whole-second window from the operator record).
    const expires = new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 86400000).toISOString();
    const exact = () => db.query(`select * from ${grantFn.replace(/\(.*$/, '')}($1,'operator_manual',3,$2,$3::timestamptz,$4,clock_timestamp()+interval '1 day')`,
      [b.companyId, reference, expires, randomUUID()]).then(r => r.rows[0]);
    const created = await exact();
    assert.equal(created.replayed, false);
    const replay = await exact();
    assert.deepEqual(replay, { entitlement_id: created.entitlement_id, replayed: true });
    await rejects(grant(b.companyId, 'operator_manual', 4, reference), '23505', 'voice_grant_reference_conflict');
    await rejects(grant(a.companyId, 'operator_manual', 3, reference), '23505', 'voice_grant_reference_conflict');
    // The trial of company B stays available after a manual grant, and it is still once.
    const bTrial = await grant(b.companyId, 'trial_single', 1);
    assert.equal(bTrial.replayed, false);
    assert.deepEqual(await balance(b.companyId), { granted: 4, used: 0, reserved: 0, available: 4 });
    // A manual top-up for company A is allowed after its trial and only counts its own units.
    await grant(a.companyId, 'operator_manual', 2, randomUUID());
    assert.deepEqual(await balance(a.companyId), { granted: 2, used: 0, reserved: 0, available: 2 });
  });

  await t.test('invalid windows, unknown company and missing evidence are refused', async () => {
    await rejects(grant(b.companyId, 'operator_manual', 1, randomUUID(), 0), '22023', 'voice_grant_window_invalid');
    await rejects(grant(b.companyId, 'operator_manual', 1, randomUUID(), 400), '22023', 'voice_grant_window_invalid');
    await rejects(grant(randomUUID(), 'operator_manual', 1, randomUUID()), 'PT404', 'voice_grant_company_unknown');
    await rejects(db.query(`select * from private.sc19_voice_grant_interviews($1,'operator_manual',1,$2,clock_timestamp()+interval '1 day',null,null)`,
      [b.companyId, randomUUID()]), '22023', 'voice_grant_invalid');
    await rejects(db.query(`select * from private.sc19_voice_grant_interviews($1,'operator_manual',1,$2,clock_timestamp()+interval '1 day',$3,clock_timestamp()-interval '1 second')`,
      [b.companyId, randomUUID(), randomUUID()]), '22023', 'voice_grant_window_invalid');
  });

  await t.test('rollback removes only the functions; rows and signature stay', async () => {
    const rows = await one('select count(*)::int as v from private.sc19_voice_entitlements');
    await db.query(await readFile(new URL('../supabase/rollbacks/20261119150000_r6_voice_pool_operator_grant_down.sql', import.meta.url), 'utf8'));
    for (const fn of functions) assert.equal(await one('select to_regprocedure($1) is null as v', [fn]), true, fn);
    assert.equal(await one('select count(*)::int as v from private.sc19_voice_entitlements'), rows);
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
  });
});
