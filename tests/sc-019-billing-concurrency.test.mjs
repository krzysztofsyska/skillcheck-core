import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { setupRankingDatabase } from './helpers/screening-ranking-fixture.mjs';

const urlText=process.env.SC19_TEST_DATABASE_URL;
const owner='00000000-0000-4000-8000-000000000001';
const company='00000000-0000-4000-8000-000000000011';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const assertion=(name,testFn)=> urlText ? test(name,testFn) : test(name,{skip:'Requires temporary PostgreSQL CI service'},()=>{});

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
    const blocked = mode === 'complete'
      ? worker.query(
        'select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, findings],
      )
      : worker.query(
        "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','race')",
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash],
      );
    await assert.rejects(blocked, error => error.code === 'PT409', mode);
    const stillWaiting = Number((await db.query(
      `select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory' and not granted`,
      [holder.processID],
    )).rows[0].n);
    assert.equal(stillWaiting, 1);
    await blocker.query('commit');
    await holderWait;
    await holder.query('commit');
    await worker.query('reset role');
    await worker.query("set statement_timeout = '5s'");
    await worker.query('set role screening_worker');
    if (mode === 'complete') {
      await worker.query(
        'select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, findings],
      );
    } else {
      await worker.query(
        "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','race')",
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash],
      );
    }
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
    await harness.asAdmin();
    const status = (await db.query(
      'select execution_status from public.screening_analysis_versions where id = $1',
      [started.analysis_id],
    )).rows[0].execution_status;
    if (status !== 'completed') {
      await harness.asWorker();
      await db.query(
        'select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',
        [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, findings],
      );
    }
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
    await harness.asAdmin();
    const retryStatus = (await db.query(
      'select execution_status from public.screening_analysis_versions where id = $1',
      [retryStarted.analysis_id],
    )).rows[0].execution_status;
    if (retryStatus === 'processing') {
      await harness.asWorker();
      await db.query(
        "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','race')",
        [retryStarted.attempt_id, retryClaimed.lease_token, retryClaimed.input_fingerprint, retryClaimed.analysis_contract_hash],
      );
    }
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
