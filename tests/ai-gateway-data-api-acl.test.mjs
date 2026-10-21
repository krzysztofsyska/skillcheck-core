import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const sql = await readFile(new URL('../db/prototypes/sc021-ai-gateway-ledger.sql', import.meta.url), 'utf8');
const tables = ['ai_gateway_limits', 'ai_gateway_usage'];
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const reserveSql = `select * from public.ai_gateway_reserve($1,$2,$3,null,null,
  'cv_screening','openai','synthetic-model','revision-v1','policy-v1','price-v1',20)`;

for (const legacy of [false, true]) {
  test(`SC-021 explicit table ACL / legacy=${legacy}`, async t => {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create role screening_worker nologin; create role service_role nologin bypassrls;
      create schema private; grant usage on schema private to authenticated;
      create table public.companies(id uuid primary key);
      create function private.has_company_access(target_company uuid) returns boolean language sql stable
        as $$select current_setting('sc021.actor_company',true)=target_company::text$$;`);
    if (legacy) {
      await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role');
    }
    const defaultsBefore = (await db.query('select defaclacl::text from pg_default_acl order by oid')).rows;
    await db.exec(sql);
    assert.deepEqual((await db.query('select defaclacl::text from pg_default_acl order by oid')).rows, defaultsBefore);
    await db.query('insert into public.companies values($1),($2)', [companyA, companyB]);
    await db.query('insert into public.ai_gateway_limits(company_id,monthly_limit_micro_usd) values($1,100),($2,100)', [companyA, companyB]);

    for (const table of tables) {
      assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass', [`public.${table}`])).rows[0].relrowsecurity, true);
      for (const role of ['anon', 'authenticated', 'service_role', 'ai_meter_worker', 'screening_worker']) {
        for (const privilege of privileges) {
          const result = (await db.query('select has_table_privilege($1,$2,$3) as allowed', [role, `public.${table}`, privilege])).rows[0];
          assert.equal(result.allowed, role === 'authenticated' && privilege === 'SELECT', `${role}/${table}/${privilege}`);
        }
      }
    }

    async function asRole(role, query, values = []) {
      // Role names are fixed test constants, never application input.
      await db.exec(`set role ${role}`);
      try { return await db.query(query, values); }
      finally { await db.exec('reset role'); }
    }

    // Exercise the real SECURITY DEFINER RPCs; no provider or network call.
    for (const [role, company] of [['ai_meter_worker', companyA], ['screening_worker', companyB]]) {
      const request = randomUUID(), operation = randomUUID();
      assert.equal((await asRole(role, reserveSql, [company, request, operation])).rows[0].created, true);
      assert.equal((await asRole(role, reserveSql, [company, request, operation])).rows[0].created, false);
      assert.equal((await asRole(role, 'select public.ai_gateway_mark_unknown($1,$2) as changed', [company, request])).rows[0].changed, true);
      await assert.rejects(asRole(role, 'select public.ai_gateway_release($1,$2)', [company, request]), /SC021_NOT_RELEASABLE/);
      const settleSql = 'select public.ai_gateway_settle($1,$2,10,5,0,5,$3) as changed';
      assert.equal((await asRole(role, settleSql, [company, request, 'synthetic-request'])).rows[0].changed, true);
      assert.equal((await asRole(role, settleSql, [company, request, 'synthetic-request'])).rows[0].changed, false);
      const releasable = randomUUID();
      await asRole(role, reserveSql, [company, releasable, randomUUID()]);
      assert.equal((await asRole(role, 'select public.ai_gateway_release($1,$2) as changed', [company, releasable])).rows[0].changed, true);
    }

    for (const company of [companyA, companyB]) {
      await db.query("select set_config('sc021.actor_company',$1,false)", [company]);
      for (const table of tables) {
        assert.deepEqual((await asRole('authenticated', `select distinct company_id from public.${table}`)).rows, [{ company_id: company }]);
        await assert.rejects(asRole('authenticated', `delete from public.${table}`), e => e.code === '42501');
      }
      await assert.rejects(asRole('authenticated', 'update public.ai_gateway_limits set monthly_limit_micro_usd=1000'), e => e.code === '42501');
      await assert.rejects(asRole('authenticated', reserveSql, [company, randomUUID(), randomUUID()]), e => e.code === '42501');
      await assert.rejects(asRole('authenticated', 'select public.ai_gateway_release($1,$2)', [company, randomUUID()]), e => e.code === '42501');
    }
    await db.query("select set_config('sc021.actor_company',$1,false)", [randomUUID()]);
    for (const table of tables) {
      assert.deepEqual((await asRole('authenticated', `select * from public.${table}`)).rows, []);
      for (const role of ['anon', 'service_role', 'ai_meter_worker', 'screening_worker']) {
        await assert.rejects(asRole(role, `select * from public.${table}`), e => e.code === '42501');
      }
    }
  });
}
