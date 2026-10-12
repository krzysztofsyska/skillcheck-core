import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.AI_GATEWAY_TEST_DATABASE_URL;
const idA = '11111111-1111-4111-8111-111111111111';
const idB = '22222222-2222-4222-8222-222222222222';
const migration = readFileSync(new URL('../db/prototypes/sc021-ai-gateway-ledger.sql', import.meta.url), 'utf8');

test('SC-021 database: worker-only permissions, tenant RLS, serialized budgets, idempotent settlement', {
  skip: !url && 'Requires AI_GATEWAY_TEST_DATABASE_URL (isolated Postgres test database)',
}, async () => {
  const dbName = 'sc021_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const uri = new URL(url);
  uri.pathname = '/' + dbName;
  let db;
  try {
    await admin.query('create database ' + dbName);
    db = new pg.Client({ connectionString: uri.toString() });
    await db.connect();
    await db.query('create schema private');
    for (const role of ['authenticated','anon','screening_worker']) {
      await db.query('do $stmt$ begin if not exists (select 1 from pg_roles where rolname = ' +
        "'" + role + "'" + ') then create role ' + role + ' nologin noinherit; end if; end $stmt$');
    }
    await db.query('create table public.companies (id uuid primary key)');
    await db.query('create function private.has_company_access(target_company uuid) returns boolean language sql stable as $func$ select current_setting(' +
      "'sc021.actor_company'" + ', true) = target_company::text $func$');
    await db.query(migration);
    await db.query('insert into public.companies(id) values ($1),($2)', [idA,idB]);
    await db.query('insert into public.ai_gateway_limits(company_id,monthly_limit_micro_usd) values ($1,100),($2,100)', [idA,idB]);

    async function worker(sql, values = []) {
      const client = new pg.Client({ connectionString: uri.toString() });
      await client.connect();
      try {
        await client.query('begin');
        await client.query('set local role ai_meter_worker');
        const result = await client.query(sql, values);
        await client.query('commit');
        return result.rows;
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        await client.end();
      }
    }
    const reserveQuery = 'select * from public.ai_gateway_reserve(' +
      '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,' +
      '$7::text,$8::text,$9::text,$10::text,$11::bigint)';
    const request1 = randomUUID(), operation = randomUUID();
    const reserveArgs = (companyId, requestId, cost = 100) => [
      companyId, requestId, operation, null, 'anon:123', 'cv_screening',
      'openai', 'pinned-v1', 'policy-v1', 'price-v1', cost,
    ];
    const r1 = await worker(reserveQuery, reserveArgs(idA, request1));
    assert.equal(r1[0].created, true);
    assert.equal(r1[0].warning, true);
    assert.equal((await worker(reserveQuery, reserveArgs(idA, request1)))[0].created, false);
    await assert.rejects(worker(reserveQuery, reserveArgs(idA, randomUUID())), /SC021_BUDGET_EXHAUSTED/);
    await assert.rejects(worker(reserveQuery, reserveArgs(idA, request1, 99)), /SC021_IDEMPOTENCY_CONFLICT/);
    assert.equal((await worker(reserveQuery, reserveArgs(idB, randomUUID())))[0].created, true);

    const settleQuery = 'select public.ai_gateway_settle(' +
      '$1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::bigint,$6::bigint,$7::text) as settled';
    const settled = [idA,request1,110,1000,100,50,'resp_001'];
    assert.equal((await worker(settleQuery, settled))[0].settled, true);
    assert.equal((await worker(settleQuery, settled))[0].settled, false);
    await assert.rejects(worker(settleQuery, [idA,request1,50,1000,100,50,'resp_001']), /SC021_SETTLEMENT_CONFLICT/);
    await assert.rejects(worker(settleQuery, [idB,request1,50,1000,100,50,'resp_001']), /SC021_UNKNOWN_RESERVATION/);

    const gateParams = [idB, randomUUID(), operation, null, null, 'cv_screening','openai','pinned-v1','policy-v1','price-v1', 1];
    await assert.rejects(worker(reserveQuery, gateParams), /SC021_BUDGET_EXHAUSTED/);
    await db.query('update public.ai_gateway_limits set operator_override = true where company_id = $1', [idB]);
    const allowed = await worker(reserveQuery, gateParams);
    assert.equal(allowed[0].created, true);
    const unknown = await worker('select public.ai_gateway_mark_unknown($1::uuid,$2::uuid) as marked',
      [idB, gateParams[1]]);
    assert.equal(unknown[0].marked, true);
    assert.equal((await db.query('select status from public.ai_gateway_usage where request_key=$1', [gateParams[1]])).rows[0].status, 'unknown');

    async function asTenant(tenant, sql, values = []) {
      await db.query('begin');
      try {
        await db.query('select set_config($1,$2,true)', ['sc021.actor_company', tenant]);
        await db.query('set local role authenticated');
        const result = await db.query(sql, values);
        await db.query('rollback');
        return result.rows;
      } catch (e) { await db.query('rollback'); throw e; }
    }
    const tenantA = await asTenant(idA, 'select company_id from public.ai_gateway_usage');
    assert.equal(tenantA.length, 1);
    assert.equal(tenantA[0].company_id, idA);
    const tenantB = await asTenant(idB, 'select company_id from public.ai_gateway_usage');
    assert.equal(tenantB.length, 2);
    assert.ok(tenantB.every(row => row.company_id === idB));
    await assert.rejects(asTenant(idA, reserveQuery, reserveArgs(idB, randomUUID())), /permission denied/);
    await assert.rejects(asTenant(idA, 'update public.ai_gateway_limits set operator_override=true where company_id=$1', [idA]), /permission denied/);

    // Three concurrent reservations for the last single budget slot: exactly one commits.
    await db.query('update public.ai_gateway_limits set monthly_limit_micro_usd=100, operator_override=false where company_id=$1', [idB]);
    await db.query('delete from public.ai_gateway_usage where company_id=$1', [idB]);
    const race = await Promise.allSettled([
      worker(reserveQuery, reserveArgs(idB, randomUUID())),
      worker(reserveQuery, reserveArgs(idB, randomUUID())),
      worker(reserveQuery, reserveArgs(idB, randomUUID())),
    ]);
    assert.equal(race.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(race.filter(x => x.status === 'rejected').length, 2);
    assert.equal((await db.query('select count(*)::int as count from public.ai_gateway_usage where company_id=$1', [idB])).rows[0].count, 1);
  } finally {
    if (db) await db.end();
    await admin.query('drop database if exists ' + dbName + ' with (force)');
    await admin.end();
  }
});
