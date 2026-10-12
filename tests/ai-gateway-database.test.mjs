import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.AI_GATEWAY_TEST_DATABASE_URL;
const idA = '11111111-1111-4111-8111-111111111111';
const idB = '22222222-2222-4222-8222-222222222222';
const migration = readFileSync(new URL('../db/prototypes/sc021-ai-gateway-ledger.sql', import.meta.url), 'utf8');
const erasurePrototype = readFileSync(new URL('../db/prototypes/sc021-r5-anonymous-erasure.sql', import.meta.url), 'utf8');

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
    for (const role of ['authenticated','anon','screening_worker','erasure_purge_owner']) {
      await db.query('do $stmt$ begin if not exists (select 1 from pg_roles where rolname = ' +
        "'" + role + "'" + ') then create role ' + role + ' nologin noinherit; end if; end $stmt$');
    }
    await db.query('create table public.companies (id uuid primary key)');
    await db.query('create function private.has_company_access(target_company uuid) returns boolean language sql stable as $func$ select current_setting(' +
      "'sc021.actor_company'" + ', true) = target_company::text $func$');
    // Isolated SC-010 fake lifecycle contract: not an actual signed erasure service.
    await db.query('create table public.candidates (id uuid primary key, company_id uuid not null references public.companies(id), frozen boolean not null default false, unique(company_id,id))');
    await db.query("create table private.erasure_executions (request_id uuid primary key, company_id uuid not null, candidate_ids uuid[] not null, manifest_hash text not null default 'synthetic-r5-manifest', phase text not null default 'erasing', sequence bigint not null default 2, event_hash text not null default 'synthetic-verified-event', local_purged boolean not null default false)");
    await db.query("create table private.erasure_purge_context (txid bigint primary key, request_id uuid not null, company_id uuid not null, manifest_hash text not null default 'synthetic-r5-manifest', mode text not null check(mode in ('delete','cancel')))");
    await db.query("create table private.erasure_purge_context_rows (txid bigint not null, adapter text not null, row_key text not null, row_hash text not null, command text not null, primary key(txid,adapter,row_key))");
    await db.query("create table private.erasure_purge_manifest (request_id uuid not null, manifest_hash text not null, adapter text not null, row_key text not null, row_hash text not null, primary key(request_id,manifest_hash,adapter,row_key))");
    await db.query("create table private.erasure_verified_ledger_events (request_id uuid not null, sequence bigint not null, event_hash text not null, phase text not null, primary key(request_id,sequence))");
    await db.query("create function private.erasure_hash(input jsonb) returns text language sql immutable as $f$ select md5(input::text) $f$");
    await db.query("create function private.erasure_candidate_frozen(target uuid) returns boolean language sql stable security definer set search_path='' as $func$ select exists(select 1 from public.candidates where id=target and frozen) $func$");
    await db.query("create function private.erasure_lock_candidate(target uuid) returns void language plpgsql security definer set search_path='' as $func$ begin perform 1 from public.candidates where id=target for update; if not found then raise exception 'SC021_CANDIDATE_UNAVAILABLE'; end if; if private.erasure_candidate_frozen(target) then raise exception 'SC021_CANDIDATE_FROZEN'; end if; end $func$");
    await db.query(migration);
    await db.query(erasurePrototype);
    await db.query('insert into public.companies(id) values ($1),($2)', [idA,idB]);
    await db.query('insert into public.ai_gateway_limits(company_id,monthly_limit_micro_usd) values ($1,100),($2,100)', [idA,idB]);

    async function worker(sql, values = [], role = 'ai_meter_worker') {
      const client = new pg.Client({ connectionString: uri.toString() });
      await client.connect();
      try {
        await client.query('begin');
        if (!['ai_meter_worker','erasure_purge_owner'].includes(role)) throw Error('invalid test worker role');
        await client.query('set local role ' + role);
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

    // SC-021-B/R5: explicit per-subject mapping, worker-only access and
    // candidate freeze. No browser-provided pseudonym is used as identity.
    await db.query('update public.ai_gateway_limits set monthly_limit_micro_usd=1000 where company_id=$1',[idA]);
    const candidateA=randomUUID(), candidateB=randomUUID();
    await db.query('insert into public.candidates(id,company_id) values($1,$2),($3,$4)',
      [candidateA,idA,candidateB,idB]);
    const candidateReserve = 'select * from private.ai_gateway_reserve_candidate(' +
      '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,' +
      '$7::text,$8::text,$9::text,$10::text,$11::bigint)';
    const boundRequest=randomUUID();
    const boundArgs=[idA,candidateA,boundRequest,randomUUID(),null,'cv_screening',
      'openai','pinned-v1','policy-v1','price-v1',60];
    const bound=await worker(candidateReserve,boundArgs);
    assert.equal(bound[0].created,true);
    assert.equal((await worker(candidateReserve,boundArgs))[0].created,false);
    assert.equal((await db.query('select count(*)::int n from private.ai_gateway_candidate_links where candidate_id=$1',
      [candidateA])).rows[0].n,1);
    await assert.rejects(worker(candidateReserve,[idA,candidateB,randomUUID(),randomUUID(),
      null,'cv_screening','openai','pinned-v1','policy-v1','price-v1',10]),/SC021_CANDIDATE_UNAVAILABLE/);
    await assert.rejects(asTenant(idA,'select * from private.ai_gateway_candidate_links'),/permission denied/);
    assert.equal((await worker(settleQuery,[idA,boundRequest,70,111,0,22,'resp_private']))[0].settled,true);

    const purgeRequest=randomUUID();
    await db.query('insert into private.erasure_executions(request_id,company_id,candidate_ids) values ($1,$2,$3::uuid[])',
      [purgeRequest,idA,[candidateA]]);
    await db.query('update public.candidates set frozen=true where id=$1',[candidateA]);
    await db.query("insert into private.erasure_verified_ledger_events(request_id,sequence,event_hash,phase) values($1,2,'synthetic-verified-event','erasing')",[purgeRequest]);
    // Synthetic snapshots emulate a *prepared* immutable SC-010 manifest;
    // the actual signed-ledger/R5 extension is a separate release dependency.
    const manifestSql =
      "insert into private.erasure_purge_manifest(request_id,manifest_hash,adapter,row_key,row_hash) " +
      "select $1::uuid,'synthetic-r5-manifest',v.adapter,v.row_key,v.row_hash from (" +
      "select 'public.ai_gateway_usage'::text adapter,u.id::text row_key,private.erasure_hash(to_jsonb(u)) row_hash " +
      "from public.ai_gateway_usage u join private.ai_gateway_candidate_links l on l.usage_id=u.id and l.company_id=u.company_id " +
      "where l.company_id=$2 and l.candidate_id=$3 " +
      "union all select 'private.ai_gateway_candidate_links'::text,l.usage_id::text,private.erasure_hash(to_jsonb(l)) " +
      "from private.ai_gateway_candidate_links l where l.company_id=$2 and l.candidate_id=$3) v";
    await db.query(manifestSql,[purgeRequest,idA,candidateA]);

    async function startSignedSyntheticPurge(client,request,company) {
      await client.query('begin');
      await client.query("insert into private.erasure_purge_context(txid,request_id,company_id,manifest_hash,mode) values(txid_current(),$1,$2,'synthetic-r5-manifest','delete')",[request,company]);
      await client.query("insert into private.erasure_purge_context_rows(txid,adapter,row_key,row_hash,command) select txid_current(),adapter,row_key,row_hash,'delete' from private.erasure_purge_manifest where request_id=$1",[request]);
      await client.query('set local role erasure_purge_owner');
    }
    await assert.rejects(worker(candidateReserve,[idA,candidateA,randomUUID(),randomUUID(),
      null,'cv_screening','openai','pinned-v1','policy-v1','price-v1',1]),/SC021_CANDIDATE_FROZEN/);
    // A privileged role without a signed transaction context is still denied.
    await assert.rejects(worker(
      'select private.ai_gateway_detach_signed_purge($1::uuid)',
      [purgeRequest], 'erasure_purge_owner'),/SC021_ERASURE_NOT_AUTHORIZED/);

    const eraser = new pg.Client({connectionString:uri.toString()});
    await eraser.connect();
    try {
      // A forged/missing candidate link hash must stop deletion even when
      // role, request, frozen candidate and transaction context are present.
      await startSignedSyntheticPurge(eraser,purgeRequest,idA);
      await eraser.query("update private.erasure_purge_context_rows set row_hash='tampered' where adapter='public.ai_gateway_usage'");
      await assert.rejects(eraser.query('select private.ai_gateway_detach_signed_purge($1::uuid)',[purgeRequest]),/SC021_PURGE_MANIFEST_MISMATCH/);
      await eraser.query('rollback');
      await startSignedSyntheticPurge(eraser,purgeRequest,idA);
      assert.equal((await eraser.query('select private.ai_gateway_detach_signed_purge($1::uuid) detached',
        [purgeRequest])).rows[0].detached,'1');
      // Rollback proves the finance move and erasure are a single atomic unit.
      await eraser.query('rollback');
      assert.equal((await db.query('select count(*)::int n from public.ai_gateway_usage where request_key=$1',
        [boundRequest])).rows[0].n,1);

      await startSignedSyntheticPurge(eraser,purgeRequest,idA);
      assert.equal((await eraser.query('select private.ai_gateway_detach_signed_purge($1::uuid) detached',
        [purgeRequest])).rows[0].detached,'1');
      assert.equal((await eraser.query('select private.ai_gateway_detach_signed_purge($1::uuid) detached',
        [purgeRequest])).rows[0].detached,'0');
      await eraser.query('commit');
    } finally {
      await eraser.query('rollback').catch(()=>{});
      await eraser.end();
    }
    assert.equal((await db.query('select count(*)::int n from private.ai_gateway_candidate_links where candidate_id=$1',
      [candidateA])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from public.ai_gateway_usage where request_key=$1',
      [boundRequest])).rows[0].n,0);
    const aggregate=(await db.query('select cost_micro_usd::text amount,call_count::int calls from private.ai_gateway_anonymous_spend where company_id=$1',[idA])).rows;
    assert.deepEqual(aggregate,[{amount:'70',calls:1}]);
    await db.query('delete from public.candidates where id=$1',[candidateA]);
    // 110 previously settled + 70 anonymized. Expense is not refunded by erasure.
    await db.query('update public.ai_gateway_limits set monthly_limit_micro_usd=220 where company_id=$1',[idA]);
    await assert.rejects(worker(reserveQuery,reserveArgs(idA,randomUUID(),50)),/SC021_BUDGET_EXHAUSTED/);

    // A pending/unknown provider charge prevents detachment until reconciled.
    const pendingCandidate=randomUUID(),pendingRequest=randomUUID(),pendingPurge=randomUUID();
    await db.query('insert into public.candidates(id,company_id,frozen) values($1,$2,false)',[pendingCandidate,idA]);
    await db.query('update public.ai_gateway_limits set monthly_limit_micro_usd=1000 where company_id=$1',[idA]);
    await worker(candidateReserve,[idA,pendingCandidate,pendingRequest,randomUUID(),null,
      'cv_screening','openai','pinned-v1','policy-v1','price-v1',10]);
    await db.query('update public.candidates set frozen=true where id=$1',[pendingCandidate]);
    await db.query('insert into private.erasure_executions(request_id,company_id,candidate_ids) values($1,$2,$3::uuid[])',
      [pendingPurge,idA,[pendingCandidate]]);
    await db.query("insert into private.erasure_verified_ledger_events(request_id,sequence,event_hash,phase) values($1,2,'synthetic-verified-event','erasing')",[pendingPurge]);
    const pendingEraser=new pg.Client({connectionString:uri.toString()});
    await pendingEraser.connect();
    try {
      await pendingEraser.query('begin');
      await pendingEraser.query("insert into private.erasure_purge_context(txid,request_id,company_id,manifest_hash,mode) values(txid_current(),$1,$2,'synthetic-r5-manifest','delete')",[pendingPurge,idA]);
      await pendingEraser.query('set local role erasure_purge_owner');
      await assert.rejects(pendingEraser.query('select private.ai_gateway_detach_signed_purge($1::uuid)',
        [pendingPurge]),/SC021_UNRECONCILED_CANDIDATE_USAGE/);
      await pendingEraser.query('rollback');
    } finally {
      await pendingEraser.end();
    }
    assert.equal((await db.query('select count(*)::int n from private.ai_gateway_candidate_links where candidate_id=$1',
      [pendingCandidate])).rows[0].n,1);

    assert.equal((await db.query('select count(*)::int as count from public.ai_gateway_usage where company_id=$1', [idB])).rows[0].count, 1);

    // Codex P1: an in-flight settlement above its reservation locks tenant budget.
    // A new reservation must wait and then see the committed higher actual cost.
    await db.query('delete from public.ai_gateway_usage where company_id=$1', [idB]);
    const oldAttempt = randomUUID();
    await worker(reserveQuery, reserveArgs(idB, oldAttempt, 40));
    const settlementClient = new pg.Client({ connectionString: uri.toString() });
    const admissionClient = new pg.Client({ connectionString: uri.toString() });
    await settlementClient.connect();
    await admissionClient.connect();
    try {
      await settlementClient.query('begin');
      await settlementClient.query('set local role ai_meter_worker');
      const actual = await settlementClient.query(settleQuery, [idB, oldAttempt, 90, 100, 0, 10, 'resp_race']);
      assert.equal(actual.rows[0].settled, true);

      await admissionClient.query('begin');
      await admissionClient.query('set local role ai_meter_worker');
      // Register the rejection handler immediately: an early SQL rejection must
      // be asserted as a test result, not reported as a dangling unhandled rejection.
      const admission = admissionClient.query(reserveQuery, reserveArgs(idB, randomUUID(), 50))
        .then(() => ({ok:true}), error => ({ok:false,error}));
      let waiting = false;
      for (let i = 0; i < 40; i++) {
        const state = await db.query(
          "select count(*)::int as count from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'",
          [admissionClient.processID],
        );
        if (state.rows[0].count > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Waiters must observe the tenant budget lock even though they do not
      // access the same usage row as the operation settling above estimate.
      await settlementClient.query('commit');
      const admissionResult = await admission;
      assert.equal(admissionResult.ok,false);
      assert.match(admissionResult.error.message,/SC021_BUDGET_EXHAUSTED/);
      assert.equal(waiting, true, 'reservation must wait behind settlement tenant budget lock');
      await admissionClient.query('rollback');
    } finally {
      await settlementClient.query('rollback').catch(() => {});
      await admissionClient.query('rollback').catch(() => {});
      await settlementClient.end();
      await admissionClient.end();
    }

  } finally {
    if (db) await db.end();
    await admin.query('drop database if exists ' + dbName + ' with (force)');
    await admin.end();
  }
});
