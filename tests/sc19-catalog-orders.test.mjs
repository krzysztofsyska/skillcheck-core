import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activeBoot,users } from './helpers/competency-active-fixture.mjs';
import { lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';

test('catalog orders: real SQL authorization, snapshots, settlement, service consumption',async t=>{
 const e=await activeBoot(t,{fullChain:true});const {db,h}=e;
 const call=async(name,args=[],client=db)=>{
  assert.match(name,/^public\.sc19_[a-z_]+$/);
  return (await client.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
 };
 const a=await e.seed(),b=await e.seed({owner:users.otherOwner});
 await h.asAdmin();
 await db.query('insert into public.platform_operators(user_id) values($1)',[users.outsider]);
 await db.query("insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,'1234563218','synthetic-commerce-a'),($2,'8567346215','synthetic-commerce-b')",[a.companyId,b.companyId]);
 const version=(await db.query("select id from pricing.catalog_versions where status='PUBLISHED'")).rows[0].id;
 const opts=async f=>{await h.asUser(f.owner);return call('public.sc19_catalog_order_options',[f.companyId]);};
 const make=async(f,quote,key=randomUUID())=>{await h.asUser(f.owner);return call('public.sc19_create_catalog_order',[f.companyId,key,JSON.stringify(quote),true]);};
 const settle=async(id,amount,ref)=>{await h.asUser(users.outsider);return call('public.sc19_settle_catalog_order',[id,ref,amount,'PLN']);};
 const balance=async cid=>{await h.asAdmin();return (await db.query('select available from private.sc19_balances where company_id=$1',[cid])).rows[0].available;};
 const no=(code)=>err=>err.code===code;
 await t.test('default off, no unpriced addon or unimplemented AC can sell',async()=>{
  assert.deepEqual(await opts(a),[]);
  await h.asAdmin();
  await db.exec("update sc19_commerce.settings set enabled=true");
  await db.query(`insert into sc19_commerce.product_rules(version_id,kind,code,package_code,runtime_ready,auto_purchase)
   values($1,'package','PRESELEKCJA','PRESELEKCJA',true,true),($1,'package','ASSESSMENT_CENTER','ASSESSMENT_CENTER',true,true)`,[version]);
  await db.query(`insert into sc19_commerce.product_rules(version_id,kind,code,package_code,runtime_ready,auto_purchase,service_code,max_quantity)
   values($1,'addon','skill_test','PRESELEKCJA',true,true,'skill_test',10)`,[version]);
  assert.deepEqual((await opts(a)).map(q=>q.code),['PRESELEKCJA']);
 });
 await t.test('owner only, stale/tampered quote fails, retry and one pending purchase',async()=>{
  const quote=(await opts(a))[0];const key=randomUUID();
  await assert.rejects(make(a,{...quote,grossMinor:1}),no('22023'));
  await h.asUser(users.viewer);
  await assert.rejects(call('public.sc19_create_catalog_order',[a.companyId,key,JSON.stringify(quote),true]),no('42501'));
  await h.asUser(users.otherOwner);
  await assert.rejects(call('public.sc19_catalog_orders',[a.companyId]),no('42501'));
  const before=await balance(a.companyId),id=await make(a,quote,key);
  assert.equal(await make(a,quote,key),id);
  await assert.rejects(make(a,quote),no('23505'));
  await h.asUser(a.owner);await assert.rejects(call('public.sc19_settle_catalog_order',[id,'synthetic-settle-1',quote.grossMinor,'PLN']),no('42501'));
  await assert.rejects(settle(id,quote.grossMinor-1,'synthetic-settle-1'),no('22023'));
  await settle(id,quote.grossMinor,'synthetic-settle-1');await settle(id,quote.grossMinor,'synthetic-settle-1');
  assert.equal(await balance(a.companyId),before+quote.cvCredits);
  await h.asAdmin();await assert.rejects(db.query('select private.sc19_grant_paid($1,$2)',[a.companyId,'synthetic-settle-1']),no('23505'));
  const other=await make(b,(await opts(b))[0]);await assert.rejects(settle(other,quote.grossMinor,'synthetic-settle-1'),no('23505'));
  await h.asUser(b.owner);await call('public.sc19_cancel_catalog_order',[b.companyId,other]);
  await assert.rejects(settle(other,quote.grossMinor,'synthetic-cancelled'),no('22023'));
 });
 await t.test('service-only grant has no CV journal debit/credit; metering, compatibility and one-time consumption',async()=>{
  await h.asAdmin();
  await db.exec("update pricing.addon_options set gross_minor=5000,sellable=true where code='skill_test'");
  assert.deepEqual((await opts(a)).map(q=>q.code),['PRESELEKCJA'],'runtime metering not active');
  await h.asAdmin();await db.exec('update sc19_commerce.settings set skill_test_metering=true');
  let quote=(await opts(a)).find(q=>q.code==='skill_test');assert.ok(quote);
  await h.asAdmin();await db.exec("update sc19_commerce.product_rules set prerequisites=array['missing'] where kind='addon'");
  assert.equal((await opts(a)).some(q=>q.code==='skill_test'),false);
  await h.asAdmin();await db.exec("update sc19_commerce.product_rules set prerequisites='{}',exclusions=array['package:PRESELEKCJA'] where kind='addon'");
  assert.equal((await opts(a)).some(q=>q.code==='skill_test'),false);
  await h.asAdmin();await db.exec("update sc19_commerce.product_rules set exclusions='{}' where kind='addon'");
  quote=(await opts(a)).find(q=>q.code==='skill_test');
  const before=await balance(a.companyId),order=await make(a,quote);
  await settle(order,5000,'synthetic-addon-1');await settle(order,5000,'synthetic-addon-1');
  assert.equal(await balance(a.companyId),before);
  await h.asAdmin();
  assert.equal((await db.query("select count(*)::int n from private.sc19_credit_journal where reference='settlement:synthetic-addon-1'")).rows[0].n,0);
  await assert.rejects(db.query('select private.sc19_grant_paid($1,$2)',[a.companyId,'synthetic-addon-1']),no('23505'));
  const grant=await e.issue(a);await e.issue(a,{key:grant.key,startBy:grant.startBy});
  await h.asAdmin();const units=(await db.query("select available,used from sc19_commerce.entitlements where company_id=$1 and code='skill_test'",[a.companyId])).rows[0];
  assert.deepEqual(units,{available:0,used:1});
  await assert.rejects(e.issue(b),no('PT422'));
 });
 await t.test('upgrade retains CV balance and prior package, supplies only approved test quantity',async()=>{
  await h.asAdmin();
  await db.exec("update pricing.package_prices set sellable=true where package_code='WERYFIKACJA'");
  await db.query(`insert into sc19_commerce.product_rules(version_id,kind,code,package_code,runtime_ready,auto_purchase,service_code,included_units)
   values($1,'package','WERYFIKACJA','WERYFIKACJA',true,true,'skill_test',2)`,[version]);
  const quote=(await opts(a)).find(q=>q.code==='WERYFIKACJA');assert.ok(quote);
  const before=await balance(a.companyId);const order=await make(a,quote);
  await h.asAdmin();await db.exec("update pricing.package_prices set gross_minor=99999 where package_code='WERYFIKACJA'");
  await settle(order,61500,'synthetic-upgrade-1');
  assert.equal(await balance(a.companyId),before+60);
  await h.asAdmin();
  assert.equal((await db.query("select available from sc19_commerce.entitlements where company_id=$1 and code='skill_test'",[a.companyId])).rows[0].available,2);
  assert.equal((await db.query("select count(*)::int n from sc19_commerce.entitlements where company_id=$1 and code like 'package:%' and available>0",[a.companyId])).rows[0].n,2);
 });
 await t.test('direct CRUD and private accounting functions denied',async()=>{
  await h.asUser(a.owner);
  await assert.rejects(db.query('select * from sc19_commerce.orders'),no('42501'));
  await assert.rejects(db.query("select sc19_commerce.consume_skill_test($1)",[a.companyId]),no('42501'));
  await h.asAdmin();
  assert.equal((await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='sc19_commerce' and has_function_privilege('authenticated',p.oid,'execute')`)).rows[0].n,0);
 });
 await t.test('simultaneous native settlement retries grant one package',async()=>{
  // Embedded development runs cannot prove concurrency; native CI always runs it.
  if(e.embedded)return;
  const quote=(await opts(b)).find(q=>q.code==='PRESELEKCJA');
  const id=await make(b,quote),before=await balance(b.companyId);
  const clients=await Promise.all([e.connect(),e.connect()]);
  for(const c of clients){await c.query('set role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[users.outsider]);}
  await Promise.all(clients.map(c=>call('public.sc19_settle_catalog_order',[id,'synthetic-concurrent',quote.grossMinor,'PLN'],c)));
  assert.equal(await balance(b.companyId),before+quote.cvCredits);
  await h.asUser(b.owner);assert.ok((await call('public.sc19_catalog_entitlements',[b.companyId])).some(r=>r.code==='package:PRESELEKCJA'));
  await h.asUser(a.owner);await assert.rejects(call('public.sc19_catalog_entitlements',[b.companyId]),no('42501'));
 });
 await t.test('R15 erases candidate but preserves company accounting and other tenant',async()=>{
  await h.asAdmin();
  const before=(await db.query('select * from sc19_commerce.orders order by id')).rows;
  await h.asUser(a.owner);
  assert.ok(!(await e.x.preview(a)).blockers.includes('schema_dependency_unknown'));
  await h.asAdmin();await db.exec('create table public.commerce_unknown(candidate_id uuid)');
  await h.asUser(a.owner);assert.ok((await e.x.preview(a)).blockers.includes('schema_dependency_unknown'));
  await h.asAdmin();await db.exec('drop table public.commerce_unknown');
  await h.asUser(a.owner);await e.x.policy(a,0,lifecycleRules);a.resolutionId=await e.x.resolve(a);await e.x.configure();
  const state=await e.x.freeze(a);await e.x.transition(state.request_id,0,'authorized');await e.x.transition(state.request_id,1,'erasing');await e.x.purge(state.request_id,2);
  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[a.candidate.id])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[b.candidate.id])).rows[0].n,1);
  assert.deepEqual((await db.query('select * from sc19_commerce.orders order by id')).rows,before);
 });
 await t.test('operator oldest pending queue remains actionable beyond 100 orders',async()=>{
  await h.asAdmin();
  const template=(await db.query("select id from sc19_commerce.orders where status='paid' and cv_credits>0 limit 1")).rows[0].id;
  await db.query(`insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,quantity,gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text,status)
   select o.company_id,o.buyer_id,gen_random_uuid(),o.version_id,o.kind,o.code,o.package_code,o.quantity,o.gross_minor,o.cv_credits,o.service_code,o.service_units,o.terms_revision,o.terms_text,'cancelled'
   from sc19_commerce.orders o cross join generate_series(1,101) where o.id=$1`,[template]);
  await db.query(`with companies as(insert into public.companies(name,owner_id) select 'Queue fixture '||i,$2 from generate_series(1,101) i returning id)
   insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,quantity,gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text,accepted_at)
   select c.id,o.buyer_id,gen_random_uuid(),o.version_id,o.kind,o.code,o.package_code,o.quantity,o.gross_minor,o.cv_credits,o.service_code,o.service_units,o.terms_revision,o.terms_text,'2000-01-01'::timestamptz
   from companies c cross join sc19_commerce.orders o where o.id=$1`,[template,a.owner]);
  await h.asUser(users.outsider);const queue=await call('public.sc19_catalog_orders');
  assert.equal(queue.length,100);assert.ok(queue.every(o=>o.status==='pending'));
  assert.deepEqual(queue.map(o=>o.id),queue.map(o=>o.id).sort());
  await settle(queue[0].id,queue[0].gross_minor,'synthetic-queue-first');
  const next=await call('public.sc19_catalog_orders');assert.equal(next.length,100);
  assert.ok(!next.some(o=>o.id===queue[0].id));assert.ok(next.some(o=>!queue.some(before=>before.id===o.id)));
 });
});
