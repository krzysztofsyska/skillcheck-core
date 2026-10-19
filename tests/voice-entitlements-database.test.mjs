import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

const sql = await readFile(new URL('../db/isolated/sc019-voice-entitlements.sql', import.meta.url), 'utf8');
const errorCode = (...codes) => error => codes.includes(error.code);

test('isolated SC-019 voice entitlements preserve grant history and enforce current allowance', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  const h = await setupRankingDatabase(db);
  const source = await h.seed();
  await h.asAdmin();
  const baseline = async () => (await db.query(`
    select schema_signature = private.erasure_schema_signature() as matches
    from private.erasure_inventory_baseline_r4 where singleton
  `)).rows[0].matches;
  assert.equal(await baseline(), true);
  await db.exec(sql);

  const company = async (owner = users.owner) => {
    await h.asUser(owner);
    const id = (await db.query('select public.create_company($1) as id', [`Synthetic voice ${randomUUID()}`])).rows[0].id;
    await h.asAdmin();
    return id;
  };
  const issue = async (companyId, overrides = {}, { approved = true } = {}) => {
    await h.asAdmin();
    const clocks = (await db.query(`select
      clock_timestamp() - interval '1 minute' as valid_from,
      clock_timestamp() + interval '1 day' as expires_at,
      clock_timestamp() + interval '1 hour' as verification_expires_at
    `)).rows[0];
    const grant = {
      company_id: companyId,
      package: 'FREE', total: 1, grant_reference: randomUUID(),
      valid_from: clocks.valid_from, expires_at: clocks.expires_at,
      ...(approved ? {
        active: true, company_verified: true,
        company_verification_reference: randomUUID(),
        company_verification_expires_at: clocks.verification_expires_at,
        free_trial_approved: (overrides.package ?? 'FREE') === 'FREE',
        paid_settlement_verified: overrides.package === 'PRESELEKCJA',
      } : {}),
      ...overrides,
    };
    const columns = Object.keys(grant);
    assert.ok(columns.every(name => /^[a-z_]+$/.test(name)));
    return (await db.query(`insert into private.sc19_voice_entitlements(${columns.join(',')})
      values(${columns.map((_, index) => `$${index + 1}`).join(',')}) returning *`, Object.values(grant))).rows[0];
  };
  const read = async id => (await db.query('select * from private.sc19_voice_entitlements where id=$1', [id])).rows[0];
  const eligible = async id => (await db.query(`select private.sc19_voice_entitlement_eligible(e) as ok
    from private.sc19_voice_entitlements e where id=$1`, [id])).rows[0].ok;
  const reserve = async id => db.query(`update private.sc19_voice_entitlements
    set reserved=reserved+1 where id=$1 returning *`, [id]);

  await t.test('no default authority, no browser CRUD/helper access, RLS still denies accidental grants', async () => {
    const tenant = await company();
    const empty = await issue(tenant, {}, { approved: false });
    assert.equal(empty.active, false);
    assert.equal(empty.company_verified, false);
    assert.equal(empty.free_trial_approved, false);
    assert.equal(empty.paid_settlement_verified, false);
    assert.equal(await eligible(empty.id), false);
    await assert.rejects(reserve(empty.id), errorCode('PT402'));
    assert.equal((await db.query(`select private.sc19_voice_entitlement_eligible(null) as ok`)).rows[0].ok, false);
    const table = (await db.query(`select relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where oid='private.sc19_voice_entitlements'::regclass`)).rows[0];
    assert.deepEqual(table, { rls: true, forced: true });
    for (const role of ['anon', 'authenticated', 'screening_worker', 'contact_verifier']) {
      const grants = (await db.query(`select
        has_table_privilege($1,'private.sc19_voice_entitlements','SELECT') as read,
        has_table_privilege($1,'private.sc19_voice_entitlements','INSERT,UPDATE,DELETE,TRUNCATE') as write,
        has_function_privilege($1,'private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)','EXECUTE') as helper
      `, [role])).rows[0];
      assert.deepEqual(grants, { read: false, write: false, helper: false }, role);
    }
    for (const [actor, role] of [[users.owner, 'authenticated'], [users.otherOwner, 'authenticated'], [users.recruiter, 'authenticated'], [users.viewer, 'authenticated'], [users.outsider, 'authenticated'], [null, 'anon']]) {
      await h.asUser(actor, role);
      await assert.rejects(read(empty.id), errorCode('42501'));
      await assert.rejects(reserve(empty.id), errorCode('42501'));
      await assert.rejects(db.query('insert into private.sc19_voice_entitlements default values'), errorCode('42501'));
      await assert.rejects(db.query('delete from private.sc19_voice_entitlements where id=$1', [empty.id]), errorCode('42501'));
      await assert.rejects(db.query('select private.sc19_voice_entitlement_eligible(null)'), errorCode('42501'));
    }
    await h.asAdmin();
    await db.exec('grant select,insert,update,delete on private.sc19_voice_entitlements to authenticated');
    await h.asUser(users.owner);
    assert.deepEqual((await db.query('select * from private.sc19_voice_entitlements')).rows, []);
    assert.equal((await reserve(empty.id)).rows.length, 0);
    await assert.rejects(db.query(`insert into private.sc19_voice_entitlements(company_id,package,total,grant_reference,expires_at)
      values($1,'FREE',1,$2,clock_timestamp()+interval '1 day')`, [tenant, randomUUID()]), errorCode('42501'));
    await h.asAdmin();
    await db.exec('revoke all on private.sc19_voice_entitlements from authenticated');
  });

  await t.test('FREE allows one lifetime grant per company; consumption cannot be reset or reissued', async () => {
    const tenant = await company();
    await assert.rejects(issue(tenant, { total: 2 }), errorCode('23514'));
    const free = await issue(tenant);
    assert.equal(await eligible(free.id), true);
    assert.equal((await reserve(free.id)).rows[0].reserved, 1);
    assert.equal(await eligible(free.id), true, 'trust eligibility is independent of held headroom for replay');
    await assert.rejects(reserve(free.id), errorCode('PT402'));
    await db.query('update private.sc19_voice_entitlements set used=used+1,reserved=reserved-1 where id=$1', [free.id]);
    assert.deepEqual((( { used, reserved, revision }) => ({ used, reserved, revision }))(await read(free.id)), { used: 1, reserved: 0, revision: 3 });
    await assert.rejects(db.query('update private.sc19_voice_entitlements set used=0 where id=$1', [free.id]), errorCode('55000'));
    await db.query('update private.sc19_voice_entitlements set active=false where id=$1', [free.id]);
    await assert.rejects(issue(tenant), errorCode('23505'));
    await assert.rejects(db.query('delete from private.sc19_voice_entitlements where id=$1', [free.id]), errorCode('42501'));
    await assert.rejects(db.query('truncate private.sc19_voice_entitlements'), errorCode('42501'));
    await db.query('update private.sc19_voice_entitlements set active=true where id=$1', [free.id]);
    assert.equal(await eligible(free.id), true, 'a spent quota keeps its trust facts; new reserve still fails');
    await assert.rejects(reserve(free.id), errorCode('PT402'));
    assert.equal((await read(free.id)).used, 1);
  });

  await t.test('PRESELEKCJA uses separate immutable grants and globally unique settlement references', async () => {
    const tenant = await company();
    const paid = await issue(tenant, { package: 'PRESELEKCJA', total: 3 });
    await reserve(paid.id);
    await db.query('update private.sc19_voice_entitlements set used=used+1,reserved=reserved-1 where id=$1', [paid.id]);
    await reserve(paid.id);
    const before = await read(paid.id);
    await assert.rejects(issue(tenant, { package: 'PRESELEKCJA', total: 3, grant_reference: paid.grant_reference }), errorCode('23505'));
    await assert.rejects(issue(await company(users.otherOwner), { package: 'PRESELEKCJA', total: 3, grant_reference: paid.grant_reference }), errorCode('23505'));
    const topup = await issue(tenant, { package: 'PRESELEKCJA', total: 7 });
    assert.equal(topup.used, 0);
    assert.equal(topup.reserved, 0);
    assert.equal(topup.total, 7);
    assert.deepEqual(await read(paid.id), before);
    // The first paid grant's pending operation remains held after a top-up.
    await reserve(paid.id);
    await assert.rejects(reserve(paid.id), errorCode('PT402'));
    assert.equal((await read(paid.id)).reserved, 2);
  });

  await t.test('grant economics, identity and revision cannot be overwritten', async () => {
    const paid = await issue(await company(), { package: 'PRESELEKCJA', total: 4 });
    const other = await company(users.otherOwner);
    for (const [field, value] of [
      ['total', 99], ['id', randomUUID()], ['company_id', other], ['resource', 'cv_analysis'],
      ['package', 'FREE'], ['grant_reference', randomUUID()],
      ['valid_from', '2000-01-01T00:00:00.000Z'], ['expires_at', '2099-01-01T00:00:00.000Z'],
      ['created_at', '2000-01-01T00:00:00.000Z'], ['revision', 900],
    ]) {
      await assert.rejects(db.query(`update private.sc19_voice_entitlements set ${field}=$1 where id=$2`, [value, paid.id]), errorCode('55000'), field);
    }
    await assert.rejects(issue(await company(), { used: 1 }), errorCode('22023'));
    await assert.rejects(issue(await company(), { reserved: 1 }), errorCode('22023'));
    await assert.rejects(issue(await company(), { revision: 2 }), errorCode('22023'));
    await db.query(`update private.sc19_voice_entitlements
      set reserved=reserved+1,revision=revision+1,updated_at='2000-01-01' where id=$1`, [paid.id]);
    const reserved = await read(paid.id);
    assert.equal(reserved.revision, 2);
    assert.ok(new Date(reserved.updated_at).getUTCFullYear() > 2000);
    assert.equal((await db.query(`update private.sc19_voice_entitlements set reserved=reserved+1
      where id=$1 and revision=$2 returning id`, [paid.id, paid.revision])).rows.length, 0);
  });

  await t.test('every missing, disabled, expired or revoked trust fact blocks new reservations', async () => {
    for (const [name, overrides] of [
      ['disabled', { active: false }],
      ['unverified company', { company_verified: false }],
      ['unapproved FREE', { free_trial_approved: false }],
      ['unsettled paid grant', { package: 'PRESELEKCJA', total: 2, paid_settlement_verified: false }],
      ['expired company evidence', { company_verification_expires_at: '2000-01-01T00:00:00.000Z' }],
      ['future grant', { valid_from: '2098-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' }],
      ['expired grant', { valid_from: '1999-01-01T00:00:00.000Z', expires_at: '2000-01-01T00:00:00.000Z' }],
      ['revoked grant', { revoked_at: '2000-01-01T00:00:00.000Z' }],
    ]) {
      const grant = await issue(await company(), overrides);
      assert.equal(await eligible(grant.id), false, name);
      await assert.rejects(reserve(grant.id), errorCode('PT402'), name);
      assert.equal((await read(grant.id)).reserved, 0, name);
      if (name === 'expired grant') await assert.rejects(issue(grant.company_id), errorCode('23505'));
    }
    await assert.rejects(issue(await company(), { company_verification_reference: null }), errorCode('23514'));
  });

  await t.test('revocation is final and held units survive trust changes until explicit reconciliation', async () => {
    const paid = await issue(await company(), { package: 'PRESELEKCJA', total: 4 });
    await reserve(paid.id);
    await reserve(paid.id);
    await db.query('update private.sc19_voice_entitlements set company_verified=false where id=$1', [paid.id]);
    assert.equal((await read(paid.id)).reserved, 2);
    await assert.rejects(reserve(paid.id), errorCode('PT402'));
    await db.query(`update private.sc19_voice_entitlements set company_verified=true,
      company_verification_reference=$2,company_verification_expires_at=clock_timestamp()+interval '1 day'
      where id=$1`, [paid.id, randomUUID()]);
    assert.equal((await read(paid.id)).reserved, 2);
    await db.query(`update private.sc19_voice_entitlements set revoked_at='2000-01-01' where id=$1`, [paid.id]);
    const revoked = await read(paid.id);
    assert.equal(revoked.active, false);
    assert.equal(revoked.reserved, 2);
    assert.ok(new Date(revoked.revoked_at).getUTCFullYear() > 2000);
    await assert.rejects(db.query('update private.sc19_voice_entitlements set revoked_at=null,active=true where id=$1', [paid.id]), errorCode('55000'));
    await assert.rejects(db.query('update private.sc19_voice_entitlements set active=true where id=$1', [paid.id]), errorCode('55000'));
    await assert.rejects(reserve(paid.id), errorCode('PT402'));
    // Reconciliation may consume or safely release already-held units even after
    // revocation. It cannot invent a refund of used units or a new allowance.
    await db.query('update private.sc19_voice_entitlements set used=used+1,reserved=reserved-1 where id=$1', [paid.id]);
    await db.query('update private.sc19_voice_entitlements set reserved=reserved-1 where id=$1', [paid.id]);
    assert.deepEqual((( { used, reserved }) => ({ used, reserved }))(await read(paid.id)), { used: 1, reserved: 0 });
    await assert.rejects(db.query('update private.sc19_voice_entitlements set reserved=reserved-1 where id=$1', [paid.id]), errorCode('23514'));
    await assert.rejects(db.query('update private.sc19_voice_entitlements set used=0 where id=$1', [paid.id]), errorCode('55000'));
  });

  await t.test('counter transitions are single-unit and cannot mix grant administration with accounting', async () => {
    const grant = await issue(await company(), { package: 'PRESELEKCJA', total: 10 });
    await assert.rejects(db.query('update private.sc19_voice_entitlements set reserved=reserved+2 where id=$1', [grant.id]), errorCode('55000'));
    await assert.rejects(db.query('update private.sc19_voice_entitlements set used=used+1 where id=$1', [grant.id]), errorCode('55000'));
    await assert.rejects(db.query('update private.sc19_voice_entitlements set reserved=reserved+1,active=false where id=$1', [grant.id]), errorCode('55000'));
    assert.equal((await read(grant.id)).reserved, 0);
    await reserve(grant.id);
    await db.query('update private.sc19_voice_entitlements set reserved=reserved-1 where id=$1', [grant.id]);
    assert.equal(await eligible(grant.id), true);
  });

  await t.test('the isolated module leaves screening accounting absent and SC-010 inventory fail-closed', async () => {
    assert.equal((await db.query("select to_regclass('private.sc19_balances') as cv_balance")).rows[0].cv_balance, null);
    assert.equal((await db.query(`select count(*)::integer as count from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'sc19_%'`)).rows[0].count, 0);
    assert.equal(await baseline(), false);
    await h.asUser(source.owner);
    const preview = (await db.query('select public.preview_candidate_erasure($1) as value', [source.candidate.id])).rows[0].value;
    assert.ok(preview.blockers.includes('schema_dependency_unknown'));
    const schedule = (await db.query('select public.get_retention_schedule($1) as value', [source.companyId])).rows[0].value;
    assert.ok(schedule.blockers.includes('schema_dependency_unknown'));
    await h.asAdmin();
  });
});
