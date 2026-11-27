// R6-2: the recruiter's voice interview order check
// (20261121170000_r6_voice_order_check.sql) on the full checked-in chain.
// public.voice_interview_order_check gives the company owner or a recruiter only
// the interviews left in the company's pool (after the idempotent package pool
// sync) and whether the monthly voice cost cap blocks new calls; a viewer, an
// outsider, anon and another company's application get 42501; a withdrawn
// application 55000. It reserves nothing and writes no charge.
// Native disposable PostgreSQL only; synthetic data; no provider, nothing sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase, seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';
import { parseVoiceOrderCheck } from '../lib/voice/order-check.ts';

// Same full-chain signature as tests/voice-pool-package-database.test.mjs: a function only.
const signature = 'bc5fe11ba2c0cd33015c00b2283403532f338630f3e9661b91847d6979726235';
const fn = 'public.voice_interview_order_check(uuid,uuid,uuid)';
const migration = '20261121170000_r6_voice_order_check.sql';
const code = (...codes) => e => codes.includes(e.code);

test('R6-2: voice order check is tenant-scoped, minimal, reserves nothing', async t => {
  const { db } = await bootMigrationDatabase(t);
  const h = await setupRankingDatabase(db, { throughMigration: null });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const a = await h.seed(users.owner);
  const b = await h.seed(users.otherOwner);
  await h.asAdmin();
  await seedSyntheticPolicy(db);
  for (const [user, role] of [[users.recruiter, 'recruiter'], [users.viewer, 'viewer']])
    await db.query('insert into public.company_members(company_id,user_id,role) values($1,$2,$3)', [a.companyId, user, role]);
  const check = async (actor, f, target = f) => {
    await h.asUser(actor);
    const { rows } = await db.query(`select * from ${fn.replace(/\(.*$/, '')}($1,$2,$3)`,
      [f.companyId, target.recruitment.id, target.application.id]);
    await h.asAdmin();
    return rows;
  };
  const freeTrial = company => db.query(`insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values($1,'trial',5,$2)`, [company, `trial:${randomUUID()}`]);
  const ledger = async () => ({
    charges: await one('select count(*)::int as v from voice_budget.charges'),
    reserved: await one('select coalesce(sum(reserved),0)::int as v from private.sc19_voice_entitlements'),
    preparations: await one('select count(*)::int as v from private.sc010c_voice_preparations'),
  });

  await t.test('function only: signature unchanged, hardened, execute for authenticated only', async () => {
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true);
    assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""');
    assert.equal(await one('select has_function_privilege($1,$2,$3) as v', ['authenticated', fn, 'execute']), true);
    for (const role of ['anon', 'service_role', 'screening_worker']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, role);
    }
    assert.equal(await one(`select count(*)::int as v from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=$1::regprocedure and a.grantee=0`, [fn]), 0, 'not executable by PUBLIC');
    for (const closed of ['private.sc19_voice_interview_balance(uuid)', 'private.sc19_voice_sync_package_pools(uuid)'])
      assert.equal(await one('select has_function_privilege($1,$2,$3) as v', ['authenticated', closed, 'execute']), false, closed);
    assert.equal(await one(`select has_schema_privilege('authenticated','voice_budget','usage') as v`), false);
    const source = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
    const sql = source.replace(/--[^\n]*/g, '').toLowerCase();
    for (const word of ['insert into', 'update ', 'delete from', 'reserve_dispatch', 'reserve_at', 'retell', 'http'])
      assert.ok(!sql.includes(word), `migration code mentions ${word}`);
  });

  await t.test('no package: the pool is empty; FREE gives exactly one interview', async () => {
    assert.deepEqual(await check(a.owner, a), [{ available: 0, cost_cap_blocked: false }]);
    await freeTrial(a.companyId);
    assert.deepEqual(await check(a.owner, a), [{ available: 1, cost_cap_blocked: false }]);
    assert.deepEqual(await check(a.owner, a), [{ available: 1, cost_cap_blocked: false }], 'sync is idempotent');
    assert.deepEqual(await check(users.recruiter, a), [{ available: 1, cost_cap_blocked: false }], 'recruiter');
    assert.deepEqual(parseVoiceOrderCheck(await check(users.recruiter, a), null), { state: 'ready', available: 1 });
    assert.deepEqual(await check(b.owner, b), [{ available: 0, cost_cap_blocked: false }], 'another company gets nothing from a');
    assert.deepEqual(await ledger(), { charges: 0, reserved: 0, preparations: 0 }, 'nothing reserved or charged');
  });

  await t.test('viewer, outsider, anon, another company and a foreign application: 42501', async () => {
    await assert.rejects(check(users.viewer, a), code('42501'), 'viewer');
    await assert.rejects(check(users.outsider, a), code('42501'), 'outsider');
    await assert.rejects(check(b.owner, a), code('42501'), 'other owner');
    await assert.rejects(check(a.owner, a, b), code('42501'), 'application of another company under a\'s id');
    await assert.rejects(check(a.owner, { ...a, application: { id: randomUUID() } }), code('42501'), 'unknown application');
    await h.asUser(null, 'anon');
    await assert.rejects(db.query(`select * from public.voice_interview_order_check($1,$2,$3)`,
      [a.companyId, a.recruitment.id, a.application.id]), code('42501'));
    await h.asAdmin();
  });

  await t.test('used-up pool: available 0 and the recruiter message says so', async () => {
    await db.query('update private.sc19_voice_entitlements set reserved=reserved+1 where company_id=$1', [a.companyId]);
    const rows = await check(a.owner, a);
    assert.deepEqual(rows, [{ available: 0, cost_cap_blocked: false }]);
    assert.equal(parseVoiceOrderCheck(rows, null).state, 'pool_empty');
    await db.query('update private.sc19_voice_entitlements set reserved=reserved-1 where company_id=$1', [a.companyId]);
  });

  await t.test('monthly cost cap without room for one more call blocks new calls, no amounts leave', async () => {
    const month = await one('select voice_budget.month_of(clock_timestamp())::text as v');
    for (let i = 0; i < 3; i++)
      await db.query('insert into voice_budget.charges(preparation_id,company_id,month,reserved_grosze) values($1,$2,$3,1500)',
        [randomUUID(), b.companyId, month]);
    const rows = await check(a.owner, a);
    assert.deepEqual(rows, [{ available: 1, cost_cap_blocked: true }], 'the cap is SkillCheck-wide: b\'s calls count');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['available', 'cost_cap_blocked']);
    assert.equal(parseVoiceOrderCheck(rows, null).state, 'cost_cap');
  });

  await t.test('withdrawn application: 55000', async () => {
    // Synthetic shortcut past the controlled competency withdrawal trigger (superuser, test database only).
    await db.query("set session_replication_role=replica");
    await db.query("update public.applications set status='withdrawn' where id=$1", [a.application.id]);
    await db.query("set session_replication_role=origin");
    await assert.rejects(check(a.owner, a), code('55000'));
  });
});
