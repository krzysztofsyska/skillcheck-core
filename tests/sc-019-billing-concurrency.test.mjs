import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
        assert.equal(raced[0].reason.code, '55000');
        assert.equal(after.execution_status, 'completed');
        assert.equal(after.status, 'completed');
      } else if (mode === 'fail' && finalWon) {
        assert.equal(raced[0].reason.code, '55000');
        assert.equal(after.execution_status, 'failed');
        assert.equal(after.status, 'failed');
        assert.ok(after.finished_at);
      } else {
        assert.equal(raced[1].reason.code, '42501');
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
