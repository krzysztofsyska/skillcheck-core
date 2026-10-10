import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

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
    const c=new pg.Client({connectionString:urlText,database});
    await c.connect();clients.push(c);return c;
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
      execution_status text not null default 'pending'
    );
    create function private.is_company_owner(cid uuid)
      returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.companies where id=cid and owner_id=(select auth.uid()))
    $$;
    create function private.has_company_access(cid uuid)
      returns boolean language sql stable security definer set search_path='' as $$
      select private.is_company_owner(cid)
    $$;
  `);
  await db.query('insert into public.companies values($1,$2)',[company,owner]);
  await db.query(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql',import.meta.url),'utf8'));
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await db.query('select public.sc19_claim_trial($1,$2)',[company,'1234563218']);
  for(let n=1;n<=4;n++)await db.query('insert into public.screening_analysis_versions(id,company_id) values($1,$2)',[uuid(n),company]);
  const a=await connect(),b=await connect();
  const sql='insert into public.screening_analysis_versions(id,company_id) values($1,$2)';
  const simultaneous=await Promise.allSettled([
    a.query(sql,[uuid(101),company]),b.query(sql,[uuid(102),company]),
  ]);
  assert.equal(simultaneous.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(simultaneous.filter(x=>x.status==='rejected'&&x.reason.code==='PT402').length,1);
  assert.equal(Number((await db.query('select available from private.sc19_balances where company_id=$1',[company])).rows[0].available),0);
  assert.equal(Number((await db.query('select count(*)::int as n from private.sc19_analysis_spend where company_id=$1',[company])).rows[0].n),5);
  const paid=await Promise.allSettled([
    a.query('select private.sc19_grant_paid($1,$2)',[company,'bank-verification-unique-01']),
    b.query('select private.sc19_grant_paid($1,$2)',[company,'bank-verification-unique-01']),
  ]);
  assert.equal(paid.filter(x=>x.status==='fulfilled').length,2);
  assert.equal(Number((await db.query('select available from private.sc19_balances where company_id=$1',[company])).rows[0].available),60);
  assert.equal(Number((await db.query("select count(*)::int as n from private.sc19_credit_journal where reason='paid_grant' and company_id=$1",[company])).rows[0].n),1);
});
