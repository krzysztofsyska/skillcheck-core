import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ownerA=id(1),ownerB=id(2),companyA=id(11),companyB=id(12);
function nip(prefix) {
  const weights=[6,5,7,2,3,4,5,6,7];
  const check=[...prefix].reduce((v,d,i)=>v+Number(d)*weights[i],0)%11;
  if (prefix.length!==9 || !/^\d{9}$/.test(prefix) || check===10) throw Error('bad test prefix');
  return prefix+check;
}
async function setup() {
  const db=new PGlite({extensions:{pgcrypto}});
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create schema private;
    revoke all on schema private from public,anon,authenticated;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    create table public.companies (id uuid primary key,owner_id uuid not null);
    create table public.screening_analysis_versions (
      id uuid primary key,company_id uuid not null references public.companies(id),
      execution_status text not null default 'pending'
    );
    create function private.is_company_owner(cid uuid)
      returns boolean language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.companies
          where id=cid and owner_id=(select auth.uid()))
      $$;
    create function private.has_company_access(cid uuid)
      returns boolean language sql stable security definer set search_path='' as $$
        select private.is_company_owner(cid)
      $$;
    insert into public.companies(id,owner_id) values
      ('${companyA}','${ownerA}'),('${companyB}','${ownerB}');
  `);
  await db.exec(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql',import.meta.url),'utf8'));
  const as=(user,role='authenticated')=> db.exec(`reset role; set role ${role}; select set_config('request.jwt.claim.sub','${user??''}',false)`);
  const admin=()=>db.exec("reset role; select set_config('request.jwt.claim.sub','',false)");
  const balance=async company=> (await db.query('select * from public.sc19_get_balance($1)',[company])).rows[0];
  return {db,as,admin,balance};
}

test('SC-019 prototype: FREE NIP identity, RLS-like RPC checks and zero anonymous grants',async t=>{
  const h=await setup();t.after(()=>h.db.close());
  const tax=nip('123456321');
  await h.as(ownerA);
  await assert.rejects(h.db.query('select public.sc19_claim_trial($1,$2)',[companyA,tax]),e=>e.code==='42501');
  await assert.rejects(h.db.query('select public.sc19_claim_trial($1,$2)',[companyA,'this-is-not-a-nip']),e=>e.code==='22023');
  await h.admin();
  await h.db.query('insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,$2,$3)',[companyA,tax,'verified-test-a']);
  await h.as(ownerA);
  assert.equal((await h.db.query('select public.sc19_claim_trial($1,$2) as credits',[companyA,tax])).rows[0].credits,5);
  assert.deepEqual(await h.balance(companyA),{plan:'FREE',available:5,free_claimed:true});
  assert.equal((await h.db.query('select public.sc19_claim_trial($1,$2) as credits',[companyA,tax])).rows[0].credits,5);
  await assert.rejects(h.db.query('select public.sc19_claim_trial($1,$2)',[companyA,'1234563210']),e=>e.code==='22023');
  await assert.rejects(h.db.query('select public.sc19_claim_trial($1,$2)',[companyB,tax]),e=>e.code==='42501');
  await assert.rejects(h.db.query('select * from private.sc19_balances'),e=>e.code==='42501');
  await assert.rejects(h.db.query('select private.sc19_grant_paid($1,$2)',[companyA,'settlement-123']),e=>e.code==='42501');
  await h.as(ownerB);
  await assert.rejects(h.db.query('select public.sc19_claim_trial($1,$2)',[companyB,tax]),e=>e.code==='42501');
  await assert.rejects(h.db.query('select * from public.sc19_get_balance($1)',[companyA]),e=>e.code==='42501');
  await h.as(null,'anon');
  await assert.rejects(h.db.query('select public.sc19_claim_trial($1,$2)',[companyA,tax]),e=>e.code==='42501');
});

test('SC-019 prototype: atomic spend, last-credit denial, refund and retry',async t=>{
  const h=await setup();t.after(()=>h.db.close());
  await h.admin();
  await h.db.query('insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,$2,$3)',[companyA,nip('123456321'),'verified-test-consume']);
  await h.as(ownerA);
  await h.db.query('select public.sc19_claim_trial($1,$2)',[companyA,nip('123456321')]);
  await h.admin();
  for(let n=1;n<=5;n++) {
    await h.db.query('insert into public.screening_analysis_versions (id,company_id) values($1,$2)',[id(100+n),companyA]);
  }
  await h.as(ownerA);assert.equal((await h.balance(companyA)).available,0);
  await h.admin();
  await assert.rejects(h.db.query('insert into public.screening_analysis_versions(id,company_id) values($1,$2)',[id(106),companyA]),e=>e.code==='PT402');
  assert.equal((await h.db.query('select count(*)::int as count from public.screening_analysis_versions')).rows[0].count,5);
  await h.db.query("update public.screening_analysis_versions set execution_status='failed' where id=$1",[id(101)]);
  await h.as(ownerA);assert.equal((await h.balance(companyA)).available,1);
  await h.admin();
  await h.db.query("update public.screening_analysis_versions set execution_status='pending' where id=$1",[id(101)]);
  await h.as(ownerA);assert.equal((await h.balance(companyA)).available,0);
  await h.admin();
  await h.db.query("update public.screening_analysis_versions set execution_status='cancelled' where id=$1",[id(101)]);
  await h.db.query("update public.screening_analysis_versions set execution_status='cancelled' where id=$1",[id(101)]);
  await h.as(ownerA);assert.equal((await h.balance(companyA)).available,1);
  await h.admin();
  const journal=(await h.db.query('select reason,delta from private.sc19_credit_journal where analysis_id=$1 order by created_at,id',[id(101)])).rows;
  assert.equal(journal.filter(x=>x.reason==='analysis_release').length,2);
  assert.equal(journal.reduce((sum,x)=>sum+x.delta,0),0);
});

test('SC-019 prototype: paid grant 60 once per settlement and tenant',async t=>{
  const h=await setup();t.after(()=>h.db.close());
  await h.admin();
  const one=await h.db.query('select private.sc19_grant_paid($1,$2) as left',[companyB,'bank-confirmed-001']);
  assert.equal(one.rows[0].left,60);
  const two=await h.db.query('select private.sc19_grant_paid($1,$2) as left',[companyB,'bank-confirmed-001']);
  assert.equal(two.rows[0].left,60);
  await assert.rejects(h.db.query('select private.sc19_grant_paid($1,$2)',[companyA,'bank-confirmed-001']),e=>e.code==='23505');
  await h.as(ownerB);assert.deepEqual(await h.balance(companyB),{plan:'PRESELEKCJA',available:60,free_claimed:false});
  await h.as(ownerA);await assert.rejects(h.db.query('select * from public.sc19_get_balance($1)',[companyB]),e=>e.code==='42501');
});
