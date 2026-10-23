import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { composeSc19PaymentRuntime } from '../lib/sc19-payment-runtime.ts';
import { createSc19PaymentHttp } from '../lib/sc19-payment-http.ts';
const url=process.env.SC19_TEST_DATABASE_URL;
const creditPath='docs/prototypes/sc-019-mvp-credits.sql';
const dependencies=[
 {label:'final reviewed PR #92',sha:'5166f3ce354ecffb5c7d77b1573a185e83f0f476'},
 {label:'final reviewed PR #115',sha:'5701b16e3dcbfe4f79fb27a315c1db4614d93811'},
 // Exercise the SQL actually shipped by this checkout too: historical green
 // contracts must not hide a regression introduced by a later integration merge.
 {label:'current checked-out integration contract',source:await readFile(new URL('../'+creditPath,import.meta.url),'utf8')},
];
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={provider:'synthetic',account:'offline-fixture',mode:'test'};
const appOrigin='https://app.fixture.invalid';
const request=(company=id(1),requestId=randomUUID())=>({companyId:company,requestId,offerId:'fixture-offer',termsRevision:'fixture-terms'});
const schema=await readFile(new URL('../docs/prototypes/sc19-payment-storage.sql',import.meta.url),'utf8');
const fixture=`
 do $$ begin
 if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 end $$;
 create schema auth;create schema private;
 revoke all on schema private from public,anon,authenticated;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.companies(id uuid primary key,owner_id uuid not null);
 create table public.screening_analysis_versions(id uuid primary key,company_id uuid not null references public.companies(id),execution_status text not null default 'pending',stale_at timestamptz);
 create function private.is_company_owner(cid uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select from public.companies where id=cid and owner_id=(select auth.uid()))$$;
 create function private.has_company_access(cid uuid,write_access boolean default false) returns boolean language sql stable security definer set search_path='' as $$select private.is_company_owner(cid)$$;
 create function private.touch_updated_at() returns trigger language plpgsql set search_path='' as $$begin new.updated_at=now();return new;end$$;
`;
const untrustedRoles=['sc19_payment_global_untrusted','sc19_payment_schema_untrusted'];
const paymentTables=['sc19_payment_offers','sc19_payment_orders','sc19_payment_grants','sc19_payment_requests'];
const creditAcls=async pool=>(await pool.query(`
 select 'table' kind,c.oid::regclass::text name,c.relacl::text acl from pg_class c
 join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
 and c.relkind='r' and left(c.relname,5)='sc19_' and left(c.relname,13)<>'sc19_payment_'
 union all
 select 'function',p.oid::regprocedure::text,p.proacl::text from pg_proc p
 join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public')
 and left(p.proname,5)='sc19_' and left(p.proname,13)<>'sc19_payment_'
 order by kind,name`)).rows;
for(const dependency of dependencies) test(`PostgreSQL16 payment adapter against ${dependency.label}`,{skip:!url && 'SC19_TEST_DATABASE_URL required'},async t=>{
 const u=new URL(url);
 if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!='/postgres')throw Error('Disposable loopback /postgres required');
 const root=new pg.Client({connectionString:u.href});await root.connect();
 const dbName='sc19pay_'+randomBytes(6).toString('hex');
 await root.query(`create database "${dbName}"`);u.pathname='/'+dbName;
 const pool=new pg.Pool({connectionString:u.href,max:12});
 t.after(async()=>{
   await pool.end();
   // pg.Pool.end resolves before every backend has observed the socket close.
   // Wait for real disconnects instead of FORCE-killing sockets during teardown.
   for(let i=0;i<100;i++) {
     const remaining=Number((await root.query('select count(*) n from pg_stat_activity where datname=$1',[dbName])).rows[0].n);
     if(remaining===0)break;
     if(i===99)throw Error('Test connections did not close');
     await new Promise(resolve=>setTimeout(resolve,20));
   }
   await root.query(`drop database "${dbName}"`);await root.end();
 });
 assert.equal((await pool.query('select current_database() name')).rows[0].name,dbName);
 assert.match((await pool.query('select version() v')).rows[0].v,/PostgreSQL 16/);
 await pool.query(fixture);
 // Reuse exact upstream SQL, do not fork a second quota implementation into #129.
 const source=dependency.source??execFileSync('git',['show',`${dependency.sha}:${creditPath}`],{encoding:'utf8'});
 await pool.query(source);
 await pool.query(`do $$ begin
   if not exists(select from pg_roles where rolname='sc19_payment_global_untrusted') then create role sc19_payment_global_untrusted nologin; end if;
   if not exists(select from pg_roles where rolname='sc19_payment_schema_untrusted') then create role sc19_payment_schema_untrusted nologin; end if;
 end $$;
 grant usage on schema private to sc19_payment_global_untrusted,sc19_payment_schema_untrusted;
 create schema sc19_payment_acl_fixture;
 grant usage,create on schema sc19_payment_acl_fixture to sc19_payment_global_untrusted,sc19_payment_schema_untrusted;
 -- Intentional pre-existing credit ACL: payment cleanup must preserve it.
 grant select on private.sc19_balances to sc19_payment_global_untrusted;
 alter default privileges grant all on tables to sc19_payment_global_untrusted with grant option;
 alter default privileges grant execute on functions to sc19_payment_global_untrusted with grant option;
 alter default privileges in schema private grant all on tables to sc19_payment_schema_untrusted with grant option;
 alter default privileges in schema private grant execute on functions to sc19_payment_schema_untrusted with grant option;`);
 const existingAcls=await creditAcls(pool);
 await pool.query(schema);
 assert.deepEqual(await creditAcls(pool),existingAcls,'payment cleanup must preserve existing credit ACLs');
 await pool.query('insert into public.companies values($1,$2),($3,$4),($5,$6)',[id(1),id(11),id(2),id(12),id(3),id(13)]);
 await pool.query(`insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,'1234563218','proof-fixture-one'),($2,'1111111111','proof-fixture-two')`,[id(1),id(2)]);
 await pool.query(`insert into private.sc19_payment_offers(id,revision,plan,active,approved,amount_minor,currency,credits,terms_revision,terms_text,valid_until_ms)
 values('fixture-offer','fixture-revision','PRESELEKCJA',true,true,12345,'PLN',12,'fixture-terms','SYNTHETIC TEST TERMS ONLY',$1)`,[Date.now()+3600000]);
 const sessions=new Map(); let loseResponse=false;
 const provider={
   async createCheckout(o,key){let s=sessions.get(key);if(!s){s={orderId:o.id,sessionId:'cs-'+o.id,url:'https://pay.fixture.invalid/'+o.id,scope,amountMinor:o.amountMinor,currency:'PLN',paymentKind:'one_time'};sessions.set(key,s);}if(loseResponse)throw Error('lost response');return s;},
   async lookupCheckout(o,key){return sessions.get(key)??null;},
   async verifyAndRetrieve(bytes,sig){if(sig!=='signed-fixture')throw Error('invalid signature');return JSON.parse(new TextDecoder().decode(bytes));}
 };
 const runtime=(uid=id(11),extra={})=>composeSc19PaymentRuntime({pool,provider,scope,authenticate:async()=>uid?{userId:uid}:null,
   enabled:true,liveApproved:false,checkoutOrigins:['https://pay.fixture.invalid'],appOrigin,signatureHeader:'fixture-signature',...extra});
 const service=runtime().service;
 const payment=(hosted,extra={})=>({eventId:'event-one',orderId:hosted.orderId,sessionId:hosted.sessionId,paymentId:'pay-'+hosted.orderId,scope,amountMinor:12345,currency:'PLN',status:'paid',...extra});
 const notify=(p,s=service)=>s.notification(new TextEncoder().encode(JSON.stringify(p)),'signed-fixture');
 const balance=async c=>Number((await pool.query('select available from private.sc19_balances where company_id=$1',[c])).rows[0]?.available??0);
 const count=async table=>Number((await pool.query(`select count(*) n from private.${table}`)).rows[0].n);
 await t.test('two independent PostgreSQL connections are available',async()=>{
   const a=await pool.connect(),b=await pool.connect();try{assert.notEqual((await a.query('select pg_backend_pid() id')).rows[0].id,(await b.query('select pg_backend_pid() id')).rows[0].id);}finally{a.release();b.release();}
 });
 await t.test('global and schema default grants cannot read, mutate or truncate payment storage',async()=>{
   for(const role of untrustedRoles) {
     for(const table of paymentTables) {
       for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
         assert.equal((await pool.query('select has_table_privilege($1,$2,$3) allowed',[role,'private.'+table,privilege])).rows[0].allowed,false,role+table+privilege);
       }
     }
     assert.equal((await pool.query("select has_function_privilege($1,'private.sc19_payment_immutable()','EXECUTE') allowed",[role])).rows[0].allowed,false);
     const c=await pool.connect();
     try {
       await c.query(`set role ${role}`);
       for(const table of paymentTables) {
         const key=table==='sc19_payment_grants'?'payment_key':table==='sc19_payment_requests'?'request_id':'id';
         const reference=table==='sc19_payment_requests'
           ? `create table sc19_payment_acl_fixture.forbidden_reference(company_id uuid,request_id uuid,foreign key(company_id,request_id) references private.${table}(company_id,request_id))`
           : `create table sc19_payment_acl_fixture.forbidden_reference(id ${table==='sc19_payment_orders'?'uuid':'text'} references private.${table}(${key}))`;
         for(const sql of [`select * from private.${table}`,`insert into private.${table} default values`,
           `update private.${table} set ${key}=${key}`,`delete from private.${table}`,
           `truncate private.${table} cascade`,
           reference,
           `create trigger forbidden_trigger before insert on private.${table} for each row execute function private.sc19_payment_immutable()`]) {
           await assert.rejects(c.query(sql),e=>e.code==='42501',role+': '+sql);
         }
       }
       await assert.rejects(c.query('select private.sc19_payment_immutable()'),e=>e.code==='42501');
     } finally {await c.query('reset role');c.release();}
   }
   assert.equal(await count('sc19_payment_offers'),1,'denied TRUNCATE CASCADE preserves the offer');
   assert.deepEqual(await creditAcls(pool),existingAcls);
 });
 let hosted;const attempts=Array.from({length:8},()=>request());
 await t.test('parallel checkout with distinct request IDs returns one durable order and stable provider key',async()=>{
   const results=await Promise.all(attempts.map(input=>runtime().service.checkout(input)));
   assert.equal(new Set(results.map(x=>x.orderId)).size,1);assert.equal(sessions.size,1);
   assert.equal(await count('sc19_payment_orders'),1);hosted=results[0];
   assert.equal(await count('sc19_payment_requests'),8);
 });
 await t.test('database invariant denies direct second pending order and aliases cannot cross companies or mutate',async()=>{
   await assert.rejects(pool.query(`insert into private.sc19_payment_orders
     (id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms)
     select $1,company_id,buyer_id,$2,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms
     from private.sc19_payment_orders where id=$3`,[randomUUID(),randomUUID(),hosted.orderId]),
     e=>e.code==='23505'&&e.constraint==='sc19_payment_one_unresolved');
   await assert.rejects(pool.query('insert into private.sc19_payment_requests values($1,$2,$3,now())',[id(2),randomUUID(),hosted.orderId]),e=>e.code==='23503');
   await assert.rejects(pool.query('update private.sc19_payment_requests set request_id=$1',[randomUUID()]),/immutable/);
   await assert.rejects(pool.query('delete from private.sc19_payment_requests'),/immutable/);
 });
 await t.test('parallel webhooks and new event IDs grant once; restart replays safely',async()=>{
   const p=payment(hosted);const result=await Promise.all(Array.from({length:8},(_,i)=>notify({...p,eventId:'evt-'+i},runtime().service)));
   assert.equal(result.filter(x=>x.state==='applied').length,1);assert.equal(await balance(id(1)),12);
   assert.equal((await notify(p,runtime().service)).state,'already_applied');
   assert.equal(await count('sc19_payment_grants'),1);assert.equal(await count('sc19_credit_journal'),1);
   for(const input of attempts)assert.deepEqual(await runtime().service.checkout(input),{orderId:hosted.orderId,paid:true});
   assert.equal(await count('sc19_payment_orders'),1,'alias retry after settlement must not create another order');
 });
 await t.test('paid fulfillment preserves the credit contract prohibition on late FREE claims',async()=>{
   const c=await pool.connect();
   try {
     await c.query("select set_config('request.jwt.claim.sub',$1,false)",[id(11)]);
     await assert.rejects(c.query("select public.sc19_claim_trial($1,'1234563218')",[id(1)]),/sc19_trial_after_payment/);
     assert.equal(await balance(id(1)),12);
     assert.equal(await count('sc19_trial_nips'),0);
   } finally {await c.query("select set_config('request.jwt.claim.sub','',false)");c.release();}
 });
 await t.test('tenant isolation, role denial, no browser table privileges',async()=>{
   for(const uid of [null,id(12),id(88),id(89)])await assert.rejects(runtime(uid).service.checkout(request()),/FORBIDDEN/);
   await assert.rejects(runtime(id(13)).service.checkout(request(id(3))),/FORBIDDEN/);
   assert.equal(await runtime(id(12)).readOrder(id(2),id(12),hosted.orderId),null);
   await assert.rejects(runtime(id(12)).readOrder(id(1),id(12),hosted.orderId),/FORBIDDEN/);
   const other=await runtime(id(12)).service.checkout(request(id(2),attempts[0].requestId));
   assert.notEqual(other.orderId,hosted.orderId,'request IDs are scoped to company');
   for(const role of ['anon','authenticated']){
     const c=await pool.connect();try{await c.query(`set role ${role}`);
     for(const table of [...paymentTables,'sc19_balances','sc19_credit_journal'])
         await assert.rejects(c.query(`select * from private.${table}`),e=>e.code==='42501');
     }finally{await c.query('reset role');c.release();}
   }
 });
 await t.test('immutable order/offer economics and current-policy changes preserve purchase',async()=>{
   await assert.rejects(pool.query("update private.sc19_payment_offers set credits=99 where id='fixture-offer'"),/immutable/);
   await assert.rejects(pool.query("update private.sc19_payment_grants set payment_key='changed'"),/immutable/);
   await assert.rejects(pool.query('delete from private.sc19_payment_grants'),/immutable/);
   await assert.rejects(pool.query('update private.sc19_payment_orders set amount_minor=1 where id=$1',[hosted.orderId]),/immutable/);
   await assert.rejects(pool.query("update private.sc19_payment_orders set status='awaiting_payment',payment_id=null where id=$1",[hosted.orderId]),/immutable/);
   const next=await service.checkout(request());
   assert.notEqual(next.orderId,hosted.orderId,'a fresh deliberate request after paid may buy again');
   if((await pool.query("select to_regclass('private.sc19_package_policy') name")).rows[0].name) {
     await pool.query("update private.sc19_package_policy set credits=99 where plan='PRESELEKCJA'");
     assert.equal((await pool.query("select credits from private.sc19_package_policy where plan='PRESELEKCJA'")).rows[0].credits,99);
   }
   await notify(payment(next));assert.equal(await balance(id(1)),24);
   assert.equal((await runtime().readOrder(id(1),id(11),next.orderId)).credits,12);
 });
 await t.test('failure after balance increment rolls back grant, journal and paid marker',async()=>{
   const h=await service.checkout(request());const before=[await balance(id(1)),await count('sc19_payment_grants'),await count('sc19_credit_journal')];
   await pool.query(`create function private.fixture_fail_paid() returns trigger language plpgsql as $$begin if new.status='paid' then raise exception 'fixture failure';end if;return new;end$$;
     create trigger fixture_fail_paid before update on private.sc19_payment_orders for each row execute function private.fixture_fail_paid()`);
   await assert.rejects(notify(payment(h)),/fixture failure/);
   assert.deepEqual([await balance(id(1)),await count('sc19_payment_grants'),await count('sc19_credit_journal')],before);
   assert.equal((await runtime().readOrder(id(1),id(11),h.orderId)).status,'awaiting_payment');
   await pool.query('drop trigger fixture_fail_paid on private.sc19_payment_orders');
   await notify(payment(h));assert.equal(await balance(id(1)),before[0]+12);
 });
 await t.test('same payment cannot fund two orders across companies',async()=>{
   const other=await runtime(id(12)).service.checkout(request(id(2)));
   await assert.rejects(notify(payment(other,{paymentId:payment(hosted).paymentId})),/REUSED/);
   assert.equal(await balance(id(2)),0);
 });
 await t.test('lost checkout response reconciles read-only and drains with checkout disabled',async()=>{
   const input=request();loseResponse=true;await assert.rejects(service.checkout(input),/lost response/);loseResponse=false;
   const row=(await pool.query('select id from private.sc19_payment_orders where request_id=$1',[input.requestId])).rows[0];
   const before=sessions.size;
   const retry=await runtime().service.checkout(request());
   assert.equal(retry.orderId,row.id);assert.equal(sessions.size,before,'new device/request cannot allocate another session');
   const h=sessions.get('sc19:'+row.id);await notify(payment(h),runtime(id(11),{enabled:false}).service);
   assert.equal((await runtime().readOrder(id(1),id(11),row.id)).status,'paid');
 });
 await t.test('paid fulfillment races real quota spend/refund with no deadlock/lost update',async()=>{
   const before=await balance(id(1)),analysis=randomUUID();
   await pool.query('insert into public.screening_analysis_versions(id,company_id) values($1,$2)',[analysis,id(1)]);
   const h=await service.checkout(request());
   await Promise.all([notify(payment(h)),pool.query("update public.screening_analysis_versions set execution_status='failed' where id=$1",[analysis]),
     pool.query('insert into public.screening_analysis_versions(id,company_id) values($1,$2)',[randomUUID(),id(1)])]);
   assert.equal(await balance(id(1)),before+11);
 });
 await t.test('HTTP composition persists checkout then acknowledges only committed settlement',async()=>{
   const http=createSc19PaymentHttp(runtime()),input=request();
   const r=await http.checkout(new Request(appOrigin+'/api/billing/checkout',{method:'POST',headers:{origin:appOrigin,'content-type':'application/json'},body:JSON.stringify(input)}));
   assert.equal(r.status,200);const created=await r.json();const h=sessions.get('sc19:'+created.orderId);
   const p=payment(h);
   const spoof=await http.webhook(new Request(appOrigin+'/api/billing/webhook',{method:'POST',body:JSON.stringify(p)}));
   assert.notEqual(spoof.status,200);
   const paid=await http.webhook(new Request(appOrigin+'/api/billing/webhook',{method:'POST',headers:{'fixture-signature':'signed-fixture'},body:JSON.stringify(p)}));
   assert.equal(paid.status,200);
   const status=await http.order(new Request(appOrigin+'/status?companyId='+id(1)),created.orderId);
   const data=await status.json();assert.equal(data.status,'paid');assert.equal(data.credits,12);assert.equal(data.paymentId,undefined);
 });
 await t.test('owner or KYB revoked during provider round-trip cannot bind checkout',async()=>{
   for(const kind of ['owner','kyb']) {
     let release,entered;
     const started=new Promise(r=>{entered=r;}),waiting=new Promise(r=>{release=r;});
     const delayed={...provider,async createCheckout(o,key){const h=await provider.createCheckout(o,key);entered();await waiting;return h;}};
     const input=request();const pending=runtime(id(11),{provider:delayed}).service.checkout(input);
     await started;
     if(kind==='owner')await pool.query('update public.companies set owner_id=$2 where id=$1',[id(1),id(99)]);
     else await pool.query('delete from private.sc19_trial_approvals where company_id=$1',[id(1)]);
     release();await assert.rejects(pending,/FORBIDDEN/);
     assert.equal((await pool.query('select session_id from private.sc19_payment_orders where request_id=$1',[input.requestId])).rows[0].session_id,null);
     if(kind==='owner')await pool.query('update public.companies set owner_id=$2 where id=$1',[id(1),id(11)]);
     else await pool.query("insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,'1234563218','proof-fixture-one')",[id(1)]);
     const original=(await pool.query('select id from private.sc19_payment_orders where request_id=$1',[input.requestId])).rows[0];
     await notify(payment(sessions.get('sc19:'+original.id)));
   }
 });
 await t.test('SC-010 guard refuses schema changes without a reviewed inventory revision',async()=>{
   await pool.query('create function private.erasure_schema_signature() returns text language sql as $$select \'fixture\'::text$$');
   const c=await pool.connect();try{await assert.rejects(c.query(schema),/sc19_payment_erasure_revision_required/);await c.query('rollback');}finally{c.release();}
 });
});
