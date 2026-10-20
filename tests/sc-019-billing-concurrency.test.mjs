import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { setupRankingDatabase, createRankingHarness } from './helpers/screening-ranking-fixture.mjs';
import { executionHarness, setupExecutionLedger } from './helpers/erasure-execution-fixture.mjs';
import { screeningAiContract } from '../lib/screening-ai.ts';
import { runScreeningAttempt } from '../lib/screening-worker.ts';

const urlText=process.env.SC19_TEST_DATABASE_URL;
const owner='00000000-0000-4000-8000-000000000001';
const company='00000000-0000-4000-8000-000000000011';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const assertion=(name,testFn)=> urlText ? test(name,testFn) : test(name,{skip:'Requires temporary PostgreSQL CI service'},()=>{});

async function waitForLock(db, client, locktype = 'transactionid') {
  for (let n = 0; n < 60; n++) {
    const locks = await db.query(
      'select 1 from pg_locks where pid = $1 and locktype = $2 and not granted',
      [client.processID, locktype],
    );
    if (locks.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Backend ${client.processID} did not wait for ${locktype}`);
}

async function screeningDatabase(t, options) {
  const url = new URL(urlText);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && url.pathname === '/postgres',
    'SC19_TEST_DATABASE_URL must point to disposable loopback postgres service; refusing remote databases');
  const database = 'sc19finalize_' + randomBytes(6).toString('hex');
  const root = new pg.Client({ connectionString: urlText });
  await root.connect();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.end()));
    await root.query(`drop database if exists "${database}" with (force)`).catch(() => {});
    await root.end();
  });
  await root.query(`create database "${database}"`);
  const connect = async () => {
    const isolatedUrl = new URL(urlText);
    isolatedUrl.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: isolatedUrl.toString() });
    await client.connect();
    clients.push(client);
    assert.equal((await client.query('select current_database() as name')).rows[0].name, database);
    await client.query("set deadlock_timeout = '100ms'; set statement_timeout = '5s'");
    return client;
  };
  const db = await connect();
  db.exec = sql => db.query(sql);
  const harness = await setupRankingDatabase(db, options);
  await harness.asAdmin();
  await db.query(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8'));
  return { db, harness, connect };
}

assertion('SC-019: real worker retains one provider result across a candidate wait longer than one second', async t => {
  const { db, harness, connect } = await screeningDatabase(t);
  const fixture = await harness.seed();
  await harness.asAdmin();
  await db.query('select private.sc19_grant_paid($1,$2)', [fixture.companyId, 'real-worker-candidate-wait']);
  const fingerprint = (await db.query(
    "select private.screening_material($1,false)->>'input_fingerprint' as value", [fixture.application.id],
  )).rows[0].value;
  await harness.asUser(fixture.owner);
  const contract = screeningAiContract;
  const started = (await db.query(
    'select * from public.start_screening_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9,false)',
    [fixture.application.id, fingerprint, contract.payload_schema_version, contract.result_schema_version,
      contract.prompt_version, contract.provider, contract.model, contract.model_revision, randomUUID()],
  )).rows[0];
  await harness.asAdmin();
  const worker = await connect();
  const holder = await connect();
  const blocker = await connect();
  const advisory = "select pg_advisory_xact_lock(hashtextextended('screening:' || $1::text, 0))";
  await blocker.query('begin');
  await blocker.query(advisory, [fixture.application.id]);
  const counters = { provider: 0, complete: 0, fail: 0 };
  const logs = [];
  let claimed;
  let holderWait;
  let completion;
  // Match the production worker store: a fresh transaction and worker role
  // per RPC, with the exact response metadata passed to completion.
  const rpc = async (sql, parameters) => {
    await worker.query('begin');
    try {
      await worker.query('set local role screening_worker');
      const result = await worker.query(sql, parameters);
      await worker.query('commit');
      return result.rows[0];
    } catch (error) {
      await worker.query('rollback');
      throw error;
    }
  };
  const runtime = {
    enabled: true,
    store: {
      claim: async attemptId => {
        claimed = await rpc('select * from public.claim_screening_attempt($1)', [attemptId]);
        return claimed ?? null;
      },
      complete: async input => {
        counters.complete += 1;
        completion = input;
        return (await rpc('select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,null,null) as id',
          [input.attemptId, input.leaseToken, input.inputFingerprint, input.analysisContractHash, JSON.stringify(input.findings),
            input.providerRequestId, input.providerResponseId, input.inputTokens, input.outputTokens, input.cachedInputTokens])).id;
      },
      fail: async input => {
        counters.fail += 1;
        return (await rpc('select public.fail_screening_attempt($1,$2,$3,$4,$5,$6,null,null,null,null,null,null) as id',
          [input.attemptId, input.leaseToken, input.inputFingerprint, input.analysisContractHash, input.errorCode, input.errorMessage])).id;
      },
    },
    callOpenAi: async () => {
      counters.provider += 1;
      await holder.query('begin');
      await holder.query('select id from public.candidates where id = $1 for update', [fixture.candidate.id]);
      holderWait = holder.query(advisory, [fixture.application.id]);
      return {
        id: 'resp_sc19_wait', status: 'completed',
        output_text: JSON.stringify({ criteria: claimed.criteria_snapshot.map(criterion => ({
          criterion_id: criterion.id, rating: 'meets', evidence_quotes: ['SQL'], explanation: 'Synthetic retained result.',
        })) }),
        usage: { input_tokens: 31, output_tokens: 17, input_tokens_details: { cached_tokens: 5 } },
      };
    },
    sleep: async () => assert.fail('A database lock must not retry the provider'),
    log: entry => logs.push(entry),
  };
  let settled = false;
  const execution = runScreeningAttempt(started.attempt_id, runtime).finally(() => { settled = true; });
  await waitForLock(db, holder, 'advisory');
  await waitForLock(db, worker);
  const waitStarted = Date.now();
  await db.query('select pg_sleep(1.2)');
  assert.ok(Date.now() - waitStarted >= 1100);
  assert.equal(settled, false);
  assert.deepEqual(counters, { provider: 1, complete: 1, fail: 0 });
  await db.query('begin');
  await db.query('select id from public.screening_analysis_versions where id = $1 for update nowait', [started.analysis_id]);
  await db.query('rollback');
  await blocker.query('commit');
  await holderWait;
  await holder.query('commit');
  assert.deepEqual(await execution, { status: 'completed', analysis_id: started.analysis_id });
  assert.deepEqual(counters, { provider: 1, complete: 1, fail: 0 });
  assert.equal(logs.at(-1).provider_response_id, 'resp_sc19_wait');
  const saved = (await db.query(`
    select a.execution_status, t.status, t.provider_request_id, t.provider_response_id,
      t.input_tokens, t.output_tokens, t.cached_input_tokens, t.lease_expires_at > clock_timestamp() as lease_current,
      s.state as credit_state, b.available
    from public.screening_analysis_versions a
    join public.screening_analysis_attempts t on t.id = $2
    join private.sc19_analysis_spend s on s.analysis_id = a.id
    join private.sc19_balances b on b.company_id = a.company_id where a.id = $1
  `, [started.analysis_id, started.attempt_id])).rows[0];
  assert.deepEqual(saved, { execution_status: 'completed', status: 'completed', provider_request_id: 'resp_sc19_wait',
    provider_response_id: 'resp_sc19_wait', input_tokens: 31, output_tokens: 17, cached_input_tokens: 5,
    lease_current: true, credit_state: 'reserved', available: 59 });
  const findings = (await db.query(
    'select criterion_id, rating, evidence, explanation from public.screening_criterion_results where analysis_id = $1 order by criterion_order',
    [started.analysis_id],
  )).rows;
  assert.deepEqual(findings, completion.findings);
  assert.deepEqual((await db.query(
    'select reason, delta from private.sc19_credit_journal where analysis_id = $1', [started.analysis_id],
  )).rows, [{ reason: 'analysis_reserve', delta: -1 }]);
  assert.deepEqual(await runScreeningAttempt(started.attempt_id, runtime), { status: 'duplicate' });
  assert.deepEqual(counters, { provider: 1, complete: 1, fail: 0 });
  // An idempotent completion remains valid after lease expiry.
  await db.query("update public.screening_analysis_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [started.attempt_id]);
  assert.equal(await runtime.store.complete(completion), started.analysis_id);
  assert.equal((await db.query('select count(*)::int as n from public.screening_criterion_results where analysis_id = $1', [started.analysis_id])).rows[0].n, findings.length);
});

assertion('SC-019: waiting finalizers recheck lease, binding and erasure after real stale mutations', async t => {
  const { db, harness, connect } = await screeningDatabase(t);
  const x = executionHarness(harness);
  const holder = await connect();
  holder.exec = sql => holder.query(sql);
  const holderHarness = createRankingHarness(holder);
  const holderErasure = executionHarness(holderHarness);
  const worker = await connect();
  await worker.query('set role screening_worker');
  for (const mode of ['complete', 'fail']) {
    for (const scenario of ['document', 'application', 'recruitment', 'position', 'freeze', 'restore_isolation', 'expired', 'reclaimed', 'wrong_token', 'wrong_binding', 'repeatable_read']) {
      await t.test(`${mode}: ${scenario} is authoritative after the wait`, async () => {
        const fixture = await x.ready();
        await harness.asAdmin();
        await db.query('select private.sc19_grant_paid($1,$2)', [fixture.companyId, `${mode}-${scenario}`]);
        const started = await harness.start(fixture);
        const claimed = await harness.claim(started);
        await harness.asAdmin();
        await holderHarness.asAdmin();
        await holder.query('begin');
        await holder.query('select id from public.candidates where id = $1 for update', [fixture.candidate.id]);
        const parameters = [started.attempt_id,
          scenario === 'wrong_token' ? 'f'.repeat(64) : claimed.lease_token,
          claimed.input_fingerprint,
          scenario === 'wrong_binding' ? 'f'.repeat(64) : claimed.analysis_contract_hash];
        if (scenario === 'repeatable_read') await worker.query('begin isolation level repeatable read');
        const finalizing = (mode === 'complete'
          ? worker.query('select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
            [...parameters, JSON.stringify(harness.findings(claimed, Array(claimed.criteria_snapshot.length).fill('meets')))])
          : worker.query("select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','synthetic failure')", parameters)
        ).then(value => ({ value }), error => ({ error }));
        await waitForLock(db, worker);
        await holderHarness.asUser(fixture.owner);
        if (scenario === 'document' || scenario === 'freeze') {
          await holder.query('update public.candidate_documents set redacted_text = $1 where id = $2', ['Changed reviewed CV text', fixture.document.id]);
        } else if (scenario === 'application') {
          await holder.query("update public.applications set status = 'withdrawn' where id = $1", [fixture.application.id]);
        } else if (scenario === 'recruitment') {
          await holder.query("update public.recruitments set name = 'Changed recruitment' where id = $1", [fixture.recruitment.id]);
        } else if (scenario === 'position') {
          await holder.query("update public.positions set title = 'Changed position' where id = $1", [fixture.position.id]);
        }
        if (scenario === 'freeze') {
          const preview = await holderErasure.ticket(fixture);
          await holderErasure.authorize(fixture, preview);
        } else if (scenario === 'restore_isolation') {
          await holderHarness.asAdmin();
          await holder.query('update private.erasure_execution_config set restore_isolated = true where singleton');
        } else if (scenario === 'expired' || scenario === 'reclaimed') {
          await holderHarness.asAdmin();
          await holder.query("update public.screening_analysis_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [started.attempt_id]);
          if (scenario === 'reclaimed') {
            await holderHarness.asWorker();
            const reclaimed = (await holder.query('select * from public.claim_screening_attempt($1)', [started.attempt_id])).rows[0];
            assert.notEqual(reclaimed.lease_token, claimed.lease_token);
          }
        }
        await holder.query('commit');
        const outcome = await finalizing;
        if (scenario === 'repeatable_read') await worker.query('rollback');
        const expectedCode = ['freeze', 'restore_isolation', 'wrong_binding', 'repeatable_read'].includes(scenario) ? 'PT409' : '42501';
        assert.equal(outcome.error?.code, expectedCode, outcome.error?.message);
        if (scenario === 'freeze') assert.equal(outcome.error.message, 'Candidate workflow frozen');
        if (scenario === 'restore_isolation') {
          assert.equal(outcome.error.message, 'Restore isolation required');
          await db.query('update private.erasure_execution_config set restore_isolated = false where singleton');
        }
        if (scenario === 'repeatable_read') assert.equal(outcome.error.message, 'Candidate workflow requires read committed');
        const cancelled = ['document', 'application', 'recruitment', 'position', 'freeze'].includes(scenario);
        const saved = (await db.query(`
          select a.execution_status, t.status, t.provider_request_id, s.state, b.available,
            (select count(*)::int from public.screening_criterion_results r where r.analysis_id = a.id) as findings,
            (select count(*)::int from private.sc19_credit_journal j where j.analysis_id = a.id and j.reason = 'analysis_release') as releases
          from public.screening_analysis_versions a
          join public.screening_analysis_attempts t on t.id = $2
          join private.sc19_analysis_spend s on s.analysis_id = a.id
          join private.sc19_balances b on b.company_id = a.company_id where a.id = $1
        `, [started.analysis_id, started.attempt_id])).rows[0];
        assert.deepEqual(saved, { execution_status: cancelled ? 'cancelled' : 'processing', status: cancelled ? 'abandoned' : 'processing',
          provider_request_id: null, state: cancelled ? 'released' : 'reserved', available: cancelled ? 60 : 59,
          findings: 0, releases: cancelled ? 1 : 0 });
      });
    }
  }
});

assertion('SC-019: both finalizers work on the real migration chain before SC-010', async t => {
  const { db, harness, connect } = await screeningDatabase(t, {
    throughMigration: '20261009141836_candidate_communication_verification.sql',
  });
  assert.equal((await db.query("select to_regprocedure('private.erasure_lock_candidate(uuid)') as guard")).rows[0].guard, null);
  assert.equal((await db.query("select to_regclass('private.erasure_candidate_lifecycle') as lifecycle")).rows[0].lifecycle, null);
  const worker = await connect();
  const marker = await connect();
  await worker.query('set role screening_worker');
  for (const mode of ['complete', 'fail']) {
    for (const stale of [false, true]) {
      const fixture = await harness.seed();
      await harness.asAdmin();
      await db.query('select private.sc19_grant_paid($1,$2)', [fixture.companyId, `before-sc010-${mode}-${stale}`]);
      const started = await harness.start(fixture);
      const claimed = await harness.claim(started);
      await harness.asAdmin();
      const finalize = () => mode === 'complete'
        ? worker.query('select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
          [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash,
            JSON.stringify(harness.findings(claimed, Array(claimed.criteria_snapshot.length).fill('meets')))])
        : worker.query("select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','synthetic failure')",
          [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash]);
      const outcomes = await Promise.allSettled([
        finalize(),
        stale ? marker.query('update public.candidate_documents set redacted_text = $1 where id = $2', ['Changed source CV', fixture.document.id]) : Promise.resolve(),
      ]);
      assert.equal(outcomes[1].status, 'fulfilled', outcomes[1].reason?.message);
      if (outcomes[0].status === 'rejected') {
        assert.equal(stale, true);
        assert.equal(outcomes[0].reason.code, '42501', outcomes[0].reason.message);
      }
      const saved = (await db.query(`
        select a.execution_status, t.status, s.state, b.available
        from public.screening_analysis_versions a
        join public.screening_analysis_attempts t on t.id = $2
        join private.sc19_analysis_spend s on s.analysis_id = a.id
        join private.sc19_balances b on b.company_id = a.company_id where a.id = $1
      `, [started.analysis_id, started.attempt_id])).rows[0];
      const completed = mode === 'complete' && outcomes[0].status === 'fulfilled';
      assert.equal(saved.execution_status, outcomes[0].status === 'rejected' ? 'cancelled' : completed ? 'completed' : 'failed');
      assert.equal(saved.status, outcomes[0].status === 'rejected' ? 'abandoned' : completed ? 'completed' : 'failed');
      assert.equal(saved.state, completed ? 'reserved' : 'released');
      assert.equal(saved.available, completed ? 59 : 60);
      if (!stale) {
        await db.query("update public.screening_analysis_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [started.attempt_id]);
        await finalize(); // Both successful and failed idempotent replays survive expiry.
        assert.equal((await db.query('select available from private.sc19_balances where company_id = $1', [fixture.companyId])).rows[0].available, saved.available);
      }
    }
  }
});

assertion('SC-019: an acknowledged purge can finish while finalizers wait without resurrecting results', async t => {
  const { db, harness, connect } = await screeningDatabase(t);
  const ledgerDb = new PGlite();
  t.after(() => ledgerDb.close());
  const x = await setupExecutionLedger(executionHarness(harness), ledgerDb);
  await x.configure();
  const holder = await connect();
  holder.exec = sql => holder.query(sql);
  const purger = executionHarness(createRankingHarness(holder));
  const worker = await connect();
  await worker.query('set role screening_worker');
  for (const mode of ['complete', 'fail']) {
    const fixture = await x.ready();
    await harness.asAdmin();
    await db.query('select private.sc19_grant_paid($1,$2)', [fixture.companyId, `purge-finalizer-${mode}`]);
    const started = await harness.start(fixture);
    const claimed = await harness.claim(started);
    const finalize = () => mode === 'complete'
      ? worker.query('select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash,
          JSON.stringify(harness.findings(claimed, Array(claimed.criteria_snapshot.length).fill('meets')))])
      : worker.query("select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','synthetic failure')",
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash]);
    await finalize();
    const frozen = await x.freeze(fixture);
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await holder.query('begin');
    const receipt = await purger.purge(frozen.request_id, 2);
    assert.ok(receipt.receipt_id);
    await harness.asAdmin();
    // The uncommitted purge owns candidate and child locks. A finalizer may
    // still locate the old rows, but must not prevent deletion from committing.
    const waiting = finalize().then(value => ({ value }), error => ({ error }));
    await waitForLock(db, worker);
    await holder.query('commit');
    const outcome = await waiting;
    assert.equal(outcome.error?.code, 'PT404', outcome.error?.message);
    assert.equal((await db.query('select count(*)::int as n from public.candidates where id = $1', [fixture.candidate.id])).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.screening_analysis_versions where id = $1', [started.analysis_id])).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.screening_analysis_attempts where id = $1', [started.attempt_id])).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.screening_criterion_results where analysis_id = $1', [started.analysis_id])).rows[0].n, 0);
    assert.equal((await db.query('select available from private.sc19_balances where company_id = $1', [fixture.companyId])).rows[0].available, mode === 'complete' ? 59 : 60);
  }
});

assertion('SC-019: actual PostgreSQL last-credit race and same-settlement idempotency', async t=>{
  const u=new URL(urlText);
  if (!['127.0.0.1','localhost','::1'].includes(u.hostname) || u.pathname!=='/postgres') {
    throw Error('SC19_TEST_DATABASE_URL must point to disposable loopback postgres service; refusing remote databases');
  }
  const database='sc19ci_'+randomBytes(6).toString('hex');
  const root=new pg.Client({connectionString:urlText});
  await root.connect();
  const clients=[];
  t.after(async()=>{
    await Promise.allSettled(clients.map(c=>c.end()));
    await root.query(`drop database if exists "${database}" with (force)`).catch(()=>{});
    await root.end();
  });
  await root.query(`create database "${database}"`);
  const connect=async()=>{
    // In node-postgres a connectionString overrides the separate database
    // option: always put the disposable DB name into the URL itself.
    const isolatedUrl=new URL(urlText);
    isolatedUrl.pathname=`/${database}`;
    const c=new pg.Client({connectionString:isolatedUrl.toString()});
    await c.connect();
    try {
      const actual=(await c.query('select current_database() as name')).rows[0].name;
      if(actual!==database) throw Error('SC-019 test connected to wrong database; refusing SQL');
    } catch(error) {
      await c.end();
      throw error;
    }
    clients.push(c);
    return c;
  };
  const db=await connect();
  await db.query(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth;create schema private;
    revoke all on schema private from public,anon,authenticated;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create table public.companies(id uuid primary key,owner_id uuid not null);
    create table public.screening_analysis_versions(
      id uuid primary key,company_id uuid not null references public.companies(id),
      execution_status text not null default 'pending',
      stale_at timestamptz
    );
    create function private.is_company_owner(cid uuid)
      returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.companies where id=cid and owner_id=(select auth.uid()))
    $$;
    create function private.has_company_access(cid uuid, write_access boolean default false)
      returns boolean language sql stable security definer set search_path='' as $$
      select private.is_company_owner(cid) and (not write_access or private.is_company_owner(cid))
    $$;
    create function private.touch_updated_at()
      returns trigger language plpgsql set search_path='' as $$
      begin
        new.updated_at := now();
        return new;
      end;
      $$;
    revoke all on function private.touch_updated_at() from public, anon, authenticated;
  `);
  await db.query('insert into public.companies values($1,$2)',[company,owner]);
  await db.query(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql',import.meta.url),'utf8'));
  await db.query('insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,$2,$3)',[company,'1234563218','verified-race-001']);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await db.query('select public.sc19_claim_trial($1,$2)',[company,'1234563218']);
  assert.equal(Number((await db.query('select available from public.sc19_get_balance($1)',[company])).rows[0].available),5);
  for(let n=1;n<=4;n++)await db.query('insert into public.screening_analysis_versions(id,company_id) values($1,$2)',[uuid(n),company]);
  const a=await connect(),b=await connect();
  const sql='insert into public.screening_analysis_versions(id,company_id) values($1,$2)';
  const simultaneous=await Promise.allSettled([
    a.query(sql,[uuid(101),company]),b.query(sql,[uuid(102),company]),
  ]);
  const raceOutcome=simultaneous.map(item=>item.status==='fulfilled'?'ok':`${item.reason.code}:${item.reason.message}`).sort();
  assert.deepEqual(raceOutcome,['PT402:sc19_quota_exhausted','ok']);
  assert.equal(Number((await db.query('select available from private.sc19_balances where company_id=$1',[company])).rows[0].available),0);
  assert.equal(Number((await db.query('select count(*)::int as n from private.sc19_analysis_spend where company_id=$1',[company])).rows[0].n),5);
  const paid=await Promise.allSettled([
    a.query('select private.sc19_grant_paid($1,$2)',[company,'bank-verification-unique-01']),
    b.query('select private.sc19_grant_paid($1,$2)',[company,'bank-verification-unique-01']),
  ]);
  assert.equal(paid.filter(x=>x.status==='fulfilled').length,2);
  assert.equal(Number((await db.query('select available from private.sc19_balances where company_id=$1',[company])).rows[0].available),60);
  assert.equal(Number((await db.query("select count(*)::int as n from private.sc19_credit_journal where reason='paid_grant' and company_id=$1",[company])).rows[0].n),1);
  for (const client of [db,a,b]) await client.query("set deadlock_timeout='100ms'");
  let available=60;
  for (let n=1;n<=12;n++) {
    const reserved=uuid(200+n);
    const fresh=uuid(300+n);
    await db.query('insert into public.screening_analysis_versions(id,company_id) values($1,$2)',[reserved,company]);
    available-=1;
    const mixed=await Promise.allSettled([
      a.query('insert into public.screening_analysis_versions(id,company_id) values($1,$2)',[fresh,company]),
      b.query('select private.sc19_grant_paid($1,$2)',[company,`mixed-settlement-${n}`]),
      db.query("update public.screening_analysis_versions set execution_status='failed' where id=$1",[reserved]),
    ]);
    assert.deepEqual(mixed.map(item=>item.status),['fulfilled','fulfilled','fulfilled']);
    available+=60;
    assert.equal(Number((await db.query('select available from private.sc19_balances where company_id=$1',[company])).rows[0].available),available);
  }
  assert.equal(Number((await db.query("select count(*)::int as n from private.sc19_credit_journal where reason='paid_grant' and company_id=$1",[company])).rows[0].n),13);
});

assertion('SC-019: stale cancellation does not deadlock a worker claim', async t => {
  const u = new URL(urlText);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname) || u.pathname !== '/postgres') {
    throw Error('SC19_TEST_DATABASE_URL must point to disposable loopback postgres service; refusing remote databases');
  }
  const database = 'sc19claim_' + randomBytes(6).toString('hex');
  const root = new pg.Client({ connectionString: urlText });
  await root.connect();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    await root.query(`drop database if exists "${database}" with (force)`).catch(() => {});
    await root.end();
  });
  await root.query(`create database "${database}"`);
  const connect = async () => {
    const isolatedUrl = new URL(urlText);
    isolatedUrl.pathname = `/${database}`;
    const c = new pg.Client({ connectionString: isolatedUrl.toString() });
    await c.connect();
    try {
      const actual = (await c.query('select current_database() as name')).rows[0].name;
      if (actual !== database) throw Error('SC-019 test connected to wrong database; refusing SQL');
    } catch (error) {
      await c.end();
      throw error;
    }
    clients.push(c);
    return c;
  };
  const db = await connect();
  db.exec = sql => db.query(sql);
  const harness = await setupRankingDatabase(db);
  await harness.asAdmin();
  await db.query(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8'));
  const fixture = await harness.seed();
  await harness.asAdmin();
  await db.query('select private.sc19_grant_paid($1,$2)', [fixture.companyId, 'claim-stale-race-01']);
  const worker = await connect();
  const marker = await connect();
  for (const client of [worker, marker]) {
    await client.query("set deadlock_timeout = '100ms'");
    await client.query("set statement_timeout = '5s'");
  }
  await worker.query('set role screening_worker');
  for (let n = 0; n < 8; n++) {
    const started = await harness.start(fixture);
    await harness.asAdmin();
    const raced = await Promise.allSettled([
      worker.query('select * from public.claim_screening_attempt($1)', [started.attempt_id]),
      marker.query(
        `update public.screening_analysis_versions
           set stale_at = clock_timestamp(), stale_reason = 'manual_invalidation'
         where id = $1`,
        [started.analysis_id],
      ),
    ]);
    for (const item of raced) {
      if (item.status === 'rejected') assert.notEqual(item.reason.code, '40P01');
    }
    assert.equal(raced[1].status, 'fulfilled');
    if (raced[0].status === 'rejected') assert.equal(raced[0].reason.code, '55000');
    const after = (await db.query(`
      select analysis.execution_status, attempt.status, attempt.finished_at, balance.available
      from public.screening_analysis_versions analysis
      join public.screening_analysis_attempts attempt on attempt.id = $2
      join private.sc19_balances balance on balance.company_id = analysis.company_id
      where analysis.id = $1
    `, [started.analysis_id, started.attempt_id])).rows[0];
    assert.equal(after.execution_status, 'cancelled');
    assert.equal(after.status, 'abandoned');
    assert.ok(after.finished_at);
    assert.equal(Number(after.available), 60);
  }
  await marker.query('set role screening_worker');
  for (const mode of ['complete', 'fail']) {
    for (let n = 0; n < 4; n++) {
      const subject = await harness.candidate(fixture);
      const started = await harness.start(subject);
      const claimed = await harness.claim(started);
      await harness.asAdmin();
      await db.query(
        `update public.screening_analysis_attempts
           set lease_expires_at = clock_timestamp() - interval '1 second'
         where id = $1`,
        [started.attempt_id],
      );
      const findings = JSON.stringify(harness.findings(claimed, Array(claimed.criteria_snapshot.length).fill('meets')));
      const raced = await Promise.allSettled([
        worker.query('select * from public.claim_screening_attempt($1)', [started.attempt_id]),
        mode === 'complete'
          ? marker.query(
            'select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
            [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, findings],
          )
          : marker.query(
            "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','race')",
            [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash],
          ),
      ]);
      for (const item of raced) {
        if (item.status === 'rejected') assert.notEqual(item.reason.code, '40P01', item.reason.message);
      }
      const claimWon = raced[0].status === 'fulfilled';
      const finalWon = raced[1].status === 'fulfilled';
      assert.equal(Number(claimWon) + Number(finalWon), 1, JSON.stringify(raced.map(item => item.status === 'fulfilled' ? 'ok' : `${item.reason.code}:${item.reason.message}`)));
      const after = (await db.query(`
        select analysis.execution_status, attempt.status, attempt.finished_at
        from public.screening_analysis_versions analysis
        join public.screening_analysis_attempts attempt on attempt.id = $2
        where analysis.id = $1
      `, [started.analysis_id, started.attempt_id])).rows[0];
      if (mode === 'complete' && finalWon) {
        assert.ok(['55000', 'PT409'].includes(raced[0].reason.code), raced[0].reason.message);
        assert.equal(after.execution_status, 'completed');
        assert.equal(after.status, 'completed');
      } else if (mode === 'fail' && finalWon) {
        assert.ok(['55000', 'PT409'].includes(raced[0].reason.code), raced[0].reason.message);
        assert.equal(after.execution_status, 'failed');
        assert.equal(after.status, 'failed');
        assert.ok(after.finished_at);
      } else {
        assert.ok(['42501', 'PT409'].includes(raced[1].reason.code), raced[1].reason.message);
        assert.equal(after.execution_status, 'processing');
        assert.equal(after.status, 'processing');
      }
    }
  }
  const held = Number((await db.query(
    `select count(*)::int as n from public.screening_analysis_versions
     where company_id = $1 and execution_status in ('pending','processing','completed')`,
    [fixture.companyId],
  )).rows[0].n);
  const available = Number((await db.query(
    'select available from private.sc19_balances where company_id = $1',
    [fixture.companyId],
  )).rows[0].available);
  assert.equal(available + held, 60);
});

assertion('SC-019: install waits for an open analysis insert and then refuses it', async t => {
  const u = new URL(urlText);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname) || u.pathname !== '/postgres') {
    throw Error('SC19_TEST_DATABASE_URL must point to disposable loopback postgres service; refusing remote databases');
  }
  const database = 'sc19install_' + randomBytes(6).toString('hex');
  const root = new pg.Client({ connectionString: urlText });
  await root.connect();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    await root.query(`drop database if exists "${database}" with (force)`).catch(() => {});
    await root.end();
  });
  await root.query(`create database "${database}"`);
  const connect = async () => {
    const isolatedUrl = new URL(urlText);
    isolatedUrl.pathname = `/${database}`;
    const c = new pg.Client({ connectionString: isolatedUrl.toString() });
    await c.connect();
    clients.push(c);
    return c;
  };
  const db = await connect();
  const writer = await connect();
  const installer = await connect();
  await db.query(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth;
    create schema private;
    revoke all on schema private from public, anon, authenticated;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table public.companies(id uuid primary key, owner_id uuid not null);
    create table public.screening_analysis_versions(
      id uuid primary key,
      company_id uuid not null references public.companies(id),
      execution_status text not null default 'pending',
      stale_at timestamptz
    );
    create function private.is_company_owner(cid uuid)
      returns boolean language sql stable security definer set search_path='' as $$
      select false $$;
    create function private.has_company_access(cid uuid, write_access boolean default false)
      returns boolean language sql stable security definer set search_path='' as $$
      select false $$;
  `);
  await db.query('insert into public.companies values($1,$2)', [company, owner]);
  await writer.query('begin');
  await writer.query(
    'insert into public.screening_analysis_versions(id, company_id, execution_status) values($1,$2,$3)',
    [uuid(501), company, 'pending'],
  );
  const prototype = await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8');
  const install = installer.query(prototype);
  let waiting = false;
  for (let n = 0; n < 50; n++) {
    const locks = await db.query(`
      select count(*)::int as n
      from pg_locks
      where relation = 'public.screening_analysis_versions'::regclass
        and mode = 'ShareRowExclusiveLock'
        and not granted
    `);
    if (locks.rows[0].n > 0) {
      waiting = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(waiting, true);
  await writer.query('commit');
  await assert.rejects(install, error => error.code === '55000' && error.message.includes('sc19_preexisting_unbilled_analysis'));
  const left = (await db.query(`
    select to_regclass('private.sc19_balances') as balances,
           count(*)::int as analyses
    from public.screening_analysis_versions
  `)).rows[0];
  assert.equal(left.balances, null);
  assert.equal(left.analyses, 1);
});

assertion('SC-019: finalizers lock the candidate before the advisory lock', async t => {
  const database = 'sc19order_' + randomBytes(6).toString('hex');
  const root = new pg.Client({ connectionString: urlText });
  await root.connect();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    await root.query(`drop database if exists "${database}" with (force)`).catch(() => {});
    await root.end();
  });
  await root.query(`create database "${database}"`);
  const connect = async () => {
    const isolatedUrl = new URL(urlText);
    isolatedUrl.pathname = `/${database}`;
    const c = new pg.Client({ connectionString: isolatedUrl.toString() });
    await c.connect();
    clients.push(c);
    return c;
  };
  const db = await connect();
  db.exec = sql => db.query(sql);
  const harness = await setupRankingDatabase(db);
  await harness.asAdmin();
  await db.query(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8'));
  const fixture = await harness.seed();
  await harness.asAdmin();
  await db.query('select private.sc19_grant_paid($1,$2)', [fixture.companyId, 'candidate-before-advisory']);
  const worker = await connect();
  const starter = await connect();
  for (const client of [worker, starter]) {
    await client.query("set deadlock_timeout = '100ms'");
    await client.query("set statement_timeout = '5s'");
  }
  const advisory = `select pg_advisory_xact_lock(hashtextextended('screening:' || $1::text, 0))`;
  for (const mode of ['complete', 'fail']) {
    const subject = await harness.candidate(fixture);
    const started = await harness.start(subject);
    const claimed = await harness.claim(started);
    await harness.asAdmin();
    const before = Number((await db.query(
      'select available from private.sc19_balances where company_id = $1',
      [fixture.companyId],
    )).rows[0].available);
    const blocker = await connect();
    const holder = await connect();
    await blocker.query('begin');
    await blocker.query(advisory, [subject.application.id]);
    await holder.query('begin');
    await holder.query('select id from public.candidates where id = $1 for update', [subject.candidate.id]);
    const holderWait = holder.query(advisory, [subject.application.id]);
    let waiting = false;
    for (let n = 0; n < 50; n++) {
      const locks = await db.query(
        `select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory' and not granted`,
        [holder.processID],
      );
      if (locks.rows[0].n > 0) {
        waiting = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(waiting, true);
    await worker.query("set statement_timeout = '3s'");
    await worker.query('reset role');
    await worker.query('set role screening_worker');
    const findings = JSON.stringify(harness.findings(claimed, Array(claimed.criteria_snapshot.length).fill('meets')));
    const blocked = (mode === 'complete'
      ? worker.query(
        'select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, findings],
      )
      : worker.query(
        "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','race')",
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash],
      )).then(value => ({ value }), error => ({ error }));
    await waitForLock(db, worker);
    // Waiting on candidate must not hold analysis: the candidate holder may
    // still need that row for a start, retry or stale cancellation.
    await db.query('begin');
    await db.query('select id from public.screening_analysis_versions where id = $1 for update nowait', [started.analysis_id]);
    await db.query('rollback');
    const stillWaiting = Number((await db.query(
      `select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory' and not granted`,
      [holder.processID],
    )).rows[0].n);
    assert.equal(stillWaiting, 1);
    await blocker.query('commit');
    await holderWait;
    await holder.query('commit');
    const finalized = await blocked;
    assert.equal(finalized.error, undefined, `${mode}: ${finalized.error?.code}:${finalized.error?.message}`);
    await worker.query('reset role');
    await worker.query("set statement_timeout = '5s'");
    await worker.query('set role screening_worker');
    const after = (await db.query(
      `select analysis.execution_status, balance.available
       from public.screening_analysis_versions analysis
       join private.sc19_balances balance on balance.company_id = analysis.company_id
       where analysis.id = $1`,
      [started.analysis_id],
    )).rows[0];
    if (mode === 'complete') {
      assert.equal(after.execution_status, 'completed');
      assert.equal(Number(after.available), before);
    } else {
      assert.equal(after.execution_status, 'failed');
      assert.equal(Number(after.available), before + 1);
    }
  }
  await worker.query('reset role');
  await starter.query('reset role');
  for (let n = 0; n < 4; n++) {
    const subject = await harness.candidate(fixture);
    const started = await harness.start(subject);
    const claimed = await harness.claim(started);
    const findings = JSON.stringify(harness.findings(claimed, Array(claimed.criteria_snapshot.length).fill('meets')));
    await starter.query('reset role');
    await starter.query("select set_config('request.jwt.claim.sub', $1, false)", [subject.owner]);
    await starter.query('set role authenticated');
    await worker.query('reset role');
    await worker.query('set role screening_worker');
    const raced = await Promise.allSettled([
      starter.query(
        "select * from public.start_screening_analysis($1,$2,1,1,'screening-v1','openai','ranking-test-model',null,$3,false)",
        [subject.application.id, claimed.input_fingerprint, randomUUID()],
      ),
      worker.query(
        'select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, findings],
      ),
    ]);
    for (const item of raced) {
      if (item.status === 'rejected') assert.notEqual(item.reason.code, '40P01', item.reason.message);
    }
    assert.equal(raced[1].status, 'fulfilled', raced[1].reason?.message);
    await harness.asAdmin();
    const status = (await db.query(
      'select execution_status from public.screening_analysis_versions where id = $1',
      [started.analysis_id],
    )).rows[0].execution_status;
    assert.equal(status, 'completed');
    const retrySubject = await harness.candidate(fixture);
    const retryStarted = await harness.start(retrySubject);
    const retryClaimed = await harness.claim(retryStarted);
    await starter.query('reset role');
    await starter.query("select set_config('request.jwt.claim.sub', $1, false)", [retrySubject.owner]);
    await starter.query('set role authenticated');
    await worker.query('reset role');
    await worker.query('set role screening_worker');
    const retryRace = await Promise.allSettled([
      starter.query('select * from public.retry_screening_analysis($1,$2)', [retryStarted.analysis_id, randomUUID()]),
      worker.query(
        "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','race')",
        [retryStarted.attempt_id, retryClaimed.lease_token, retryClaimed.input_fingerprint, retryClaimed.analysis_contract_hash],
      ),
    ]);
    for (const item of retryRace) {
      if (item.status === 'rejected') assert.notEqual(item.reason.code, '40P01', item.reason.message);
    }
    assert.equal(retryRace[1].status, 'fulfilled', retryRace[1].reason?.message);
    await harness.asAdmin();
    const retryStatus = (await db.query(
      'select execution_status from public.screening_analysis_versions where id = $1',
      [retryStarted.analysis_id],
    )).rows[0].execution_status;
    assert.ok(['failed', 'pending'].includes(retryStatus), retryStatus);
  }
  await harness.asAdmin();
  const held = Number((await db.query(
    `select count(*)::int as n from public.screening_analysis_versions
     where company_id = $1 and execution_status in ('pending','processing','completed')`,
    [fixture.companyId],
  )).rows[0].n);
  const available = Number((await db.query(
    'select available from private.sc19_balances where company_id = $1',
    [fixture.companyId],
  )).rows[0].available);
  assert.equal(available + held, 60);
});

assertion('SC-019: worker lock rewrite is installed without SC-010', async t => {
  const database = 'sc19nos010_' + randomBytes(6).toString('hex');
  const root = new pg.Client({ connectionString: urlText });
  await root.connect();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    await root.query(`drop database if exists "${database}" with (force)`).catch(() => {});
    await root.end();
  });
  await root.query(`create database "${database}"`);
  const connect = async () => {
    const isolatedUrl = new URL(urlText);
    isolatedUrl.pathname = `/${database}`;
    const c = new pg.Client({ connectionString: isolatedUrl.toString() });
    await c.connect();
    clients.push(c);
    return c;
  };
  const db = await connect();
  db.exec = sql => db.query(sql);
  const harness = await setupRankingDatabase(db);
  const fixture = await harness.seed();
  await harness.asAdmin();
  await db.query('alter function private.erasure_lock_candidate(uuid) rename to erasure_lock_candidate_sc010');
  await db.query(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8'));
  await db.query(`
    alter table public.screening_analysis_versions disable trigger aa_erasure_guard;
    alter table public.screening_analysis_attempts disable trigger aa_erasure_guard;
  `);
  const definition = (await db.query(
    `select pg_get_functiondef('public.claim_screening_attempt(uuid)'::regprocedure) as body,
            to_regprocedure('private.erasure_lock_candidate(uuid)') as present`,
  )).rows[0];
  assert.equal(definition.present, null);
  const candidateAt = definition.body.indexOf('perform private.erasure_lock_candidate(target_candidate)');
  const locks = [...definition.body.matchAll(/for update/g)].map(match => match.index);
  assert.ok(locks.length >= 2 && locks[0] < candidateAt && candidateAt < locks[1]);
  await db.query('select private.sc19_grant_paid($1,$2)', [fixture.companyId, 'no-sc010-lock-order']);
  const worker = await connect();
  const marker = await connect();
  for (const client of [worker, marker]) {
    await client.query("set deadlock_timeout = '100ms'");
    await client.query("set statement_timeout = '5s'");
  }
  await worker.query('set role screening_worker');
  const fingerprint = 'a'.repeat(64);
  const contract = 'b'.repeat(64);
  const documentVersion = (await db.query(
    'select version from public.candidate_documents where id = $1',
    [fixture.document.id],
  )).rows[0].version;
  for (let n = 0; n < 4; n++) {
    const inserted = (await db.query(
      `insert into public.screening_analysis_versions(
         company_id, recruitment_id, application_id, position_id, candidate_document_id,
         candidate_document_version, analysis_version, input_fingerprint, analysis_contract_hash,
         payload_schema_version, result_schema_version, prompt_version, provider, model,
         input_cv_text_snapshot, criteria_snapshot, binding_snapshot, created_by
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,'screening-v1','openai','ranking-test-model',
         'SQL expertise in reports.','[]'::jsonb,'{}'::jsonb,$10
       ) returning id`,
      [
        fixture.companyId, fixture.recruitment.id, fixture.application.id, fixture.position.id,
        fixture.document.id, documentVersion, n + 1, fingerprint, contract, fixture.owner,
      ],
    )).rows[0];
    const attempt = (await db.query(
      `insert into public.screening_analysis_attempts(company_id, analysis_id, attempt_no, idempotency_key)
       values ($1,$2,1,$3) returning id`,
      [fixture.companyId, inserted.id, randomUUID()],
    )).rows[0];
    const raced = await Promise.allSettled([
      worker.query('select * from public.claim_screening_attempt($1)', [attempt.id]),
      marker.query(
        `update public.screening_analysis_versions
           set stale_at = clock_timestamp(), stale_reason = 'manual_invalidation'
         where id = $1`,
        [inserted.id],
      ),
    ]);
    for (const item of raced) {
      if (item.status === 'rejected') assert.notEqual(item.reason.code, '40P01', item.reason.message);
    }
    assert.equal(raced[1].status, 'fulfilled', raced[1].reason?.message);
    const after = (await db.query(
      `select analysis.execution_status, attempt.status
       from public.screening_analysis_versions analysis
       join public.screening_analysis_attempts attempt on attempt.id = $2
       where analysis.id = $1`,
      [inserted.id, attempt.id],
    )).rows[0];
    assert.equal(after.execution_status, 'cancelled');
    assert.equal(after.status, 'abandoned');
  }
  const available = Number((await db.query(
    'select available from private.sc19_balances where company_id = $1',
    [fixture.companyId],
  )).rows[0].available);
  assert.equal(available, 60);
});
