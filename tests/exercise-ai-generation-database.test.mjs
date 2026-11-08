import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {guardBoot,denied} from './helpers/exercise-ai-grant-guard-fixture.mjs';
import {users} from './helpers/competency-active-fixture.mjs';
const migration='20261107171053_exercise_ai_generation.sql';
test('C6 non-owner recruiter completes a pending draft; viewers, other tenants and other actors cannot use the reservation',async t=>{
 const e=await guardBoot(t),{db,h}=e;await e.install();
 for(const name of ['20261106150000_exercise_ai_recruiter_api.sql','20261107164219_exercise_ai_revision_workflow.sql','20261107164252_sc019_catalog_orders.sql','20261107170432_single_analysis_preselection_group.sql',migration])
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 const f=await e.seed(),foreign=await e.seed({owner:users.otherOwner}),key=randomUUID(),fingerprint='a'.repeat(64);
 await h.asAdmin();
 await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer'),($1,$4,'recruiter')",[f.companyId,users.recruiter,users.viewer,users.outsider]);
 const stamp=(await db.query('select updated_at::text from public.company_profiles where company_id=$1',[f.companyId])).rows[0]?.updated_at??null;
 const args=[f.companyId,f.recruitment.id,key,f.position.updated_at,stamp,fingerprint];
 const reserve=()=>e.call('public.reserve_exercise_ai_generation',args);
 const trace={provider:'synthetic',model:'fixture',prompt_version:'v1',payload_schema_version:1,result_schema_version:1,input_fingerprint:fingerprint,position_id:f.position.id,position_updated_at:f.position.updated_at};
 const finish=()=>e.call('public.finish_exercise_ai_generation',[f.companyId,f.recruitment.id,key,fingerprint,JSON.stringify(f.definition),JSON.stringify(trace),null]);
 for(const actor of [users.viewer,users.otherOwner,null]) {await h.asUser(actor);await assert.rejects(reserve(),denied('PT404'));await assert.rejects(finish(),denied('PT404'));}
 await h.asUser(users.recruiter);assert.equal((await reserve()).claimed,true);
 await assert.rejects(e.call('public.reserve_exercise_ai_generation',[foreign.companyId,foreign.recruitment.id,randomUUID(),foreign.position.updated_at,null,fingerprint]),denied('PT404'));
 for(const actor of [users.outsider,f.owner]) {await h.asUser(actor);await assert.rejects(reserve(),denied('PT409'));await assert.rejects(finish(),denied('PT404'));}
 await h.asAdmin();await db.query("update public.company_members set role='viewer' where company_id=$1 and user_id=$2",[f.companyId,users.recruiter]);
 await h.asUser(users.recruiter);await assert.rejects(finish(),denied('PT404'));
 await h.asAdmin();await db.query("update public.company_members set role='recruiter' where company_id=$1 and user_id=$2",[f.companyId,users.recruiter]);
 await h.asUser(users.recruiter);const done=await finish();assert.equal(done.status,'completed');assert.equal((await finish()).definition_id,done.definition_id);
 const row=(await db.query('select created_by,approved_at,approval_mode from exercise_ai.proposals where definition_entry_id=$1',[done.definition_id])).rows[0];
 assert.equal(row.created_by,users.recruiter);assert.equal(row.approved_at,null);assert.equal(row.approval_mode,null);
 assert.equal((await db.query('select author_id from public.exercise_definition_entries where id=$1',[done.definition_id])).rows[0].author_id,users.recruiter);
});
test('C6 durable generation: tenant/actor/snapshot binding, single claim, quota, timeout and atomic pending completion',async t=>{
 const e=await guardBoot(t),{db,h}=e;await e.install();
 for(const name of ['20261106150000_exercise_ai_recruiter_api.sql','20261107164219_exercise_ai_revision_workflow.sql','20261107164252_sc019_catalog_orders.sql','20261107170432_single_analysis_preselection_group.sql',migration]) {
  if(name==='20261107164252_sc019_catalog_orders.sql') {
   await assert.rejects(db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8')),
    error=>error.code==='55000'&&error.message==='c6_generation_requires_r15');
   await db.exec('rollback');
   assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='exercise_ai' and table_name='recruitment_settings' and column_name='generation_requests'")).rows[0].n,0);
  }
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 const f=await e.seed(),key=randomUUID(),fingerprint='a'.repeat(64);
 const companyStamp=(await db.query('select updated_at::text from public.company_profiles where company_id=$1',[f.companyId])).rows[0]?.updated_at??null;
 const args=[f.companyId,f.recruitment.id,key,f.position.updated_at,companyStamp,fingerprint];
 const reserve=(a=args,client=db)=>e.call('public.reserve_exercise_ai_generation',a,client);
 const trace={provider:'synthetic',model:'fixture',prompt_version:'v1',payload_schema_version:1,result_schema_version:1,input_fingerprint:fingerprint,position_id:f.position.id,position_updated_at:f.position.updated_at};
 const finish=(k=key,definition=f.definition,provenance=trace,error=null,client=db)=>e.call('public.finish_exercise_ai_generation',[f.companyId,f.recruitment.id,k,fingerprint,definition&&JSON.stringify(definition),provenance&&JSON.stringify(provenance),error],client);
 assert.equal((await reserve()).claimed,true);assert.equal((await reserve()).claimed,false);
 await assert.rejects(reserve([...args.slice(0,5),'b'.repeat(64)]),denied('PT409'));
 await assert.rejects(reserve([randomUUID(),...args.slice(1)]),denied('42501','PT404'));
 await h.asUser('10000000-0000-0000-0000-000000000004');
 await assert.rejects(reserve(),denied('42501','PT404'));await h.asUser(f.owner);
 await assert.rejects(finish(key,{...f.definition,criteria:[]}),denied('22023','PT422'));
 await db.query('select exercise_ai.set_auto_release($1,true)',[f.recruitment.id]);
 const done=await finish();assert.equal(done.status,'completed');assert.ok(done.exercise_id);
 assert.equal((await finish(key,null,null,'exercise_ai_timeout')).definition_id,done.definition_id,'completion cannot become failure');
 assert.equal((await reserve()).exercise_id,done.exercise_id);
 await h.asAdmin();assert.equal((await db.query('select approved_at from exercise_ai.proposals where definition_entry_id=$1',[done.definition_id])).rows[0].approved_at,null);
 assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value,'1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44');
 await h.asUser(f.owner);
 const crash=randomUUID();await reserve([args[0],args[1],crash,...args.slice(3)]);
 await h.asAdmin();await db.query("update exercise_ai.recruitment_settings set generation_requests=jsonb_set(generation_requests,array[$1,'expires_at'],to_jsonb('2000-01-01T00:00:00Z'::text)) where recruitment_id=$2",[crash,f.recruitment.id]);
 await h.asUser(f.owner);const expired=await reserve([args[0],args[1],crash,...args.slice(3)]);assert.equal(expired.status,'failed');assert.equal(expired.claimed,false);
 const stale=randomUUID();await reserve([args[0],args[1],stale,...args.slice(3)]);
 await h.asAdmin();await db.query("update public.positions set title=title||' changed' where id=$1",[f.position.id]);await h.asUser(f.owner);
 await assert.rejects(finish(stale),denied('PT409'));
 assert.equal((await finish(stale,null,null,'exercise_ai_network_error')).status,'failed');
 const newStamp=(await db.query('select updated_at::text from public.positions where id=$1',[f.position.id])).rows[0].updated_at;
 await h.asAdmin();await db.query('update exercise_ai.recruitment_settings set draft_ceiling=3 where recruitment_id=$1',[f.recruitment.id]);await h.asUser(f.owner);
 await assert.rejects(reserve([args[0],args[1],randomUUID(),newStamp,companyStamp,fingerprint]),denied('PT429'));
 await h.asAdmin();await assert.rejects(db.exec(await readFile(new URL('../supabase/rollbacks/20261107171053_exercise_ai_generation_down.sql',import.meta.url),'utf8')),denied('55000'));await db.exec('rollback');
});

test('C6 native two sessions cannot claim one generation twice or overspend last slot',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Native connections required');
 const e=await guardBoot(t),{db,h}=e,rival=await e.connect();await e.install();
 for(const name of ['20261106150000_exercise_ai_recruiter_api.sql','20261107164219_exercise_ai_revision_workflow.sql','20261107164252_sc019_catalog_orders.sql','20261107170432_single_analysis_preselection_group.sql',migration])
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 const f=await e.seed(),key=randomUUID(),stamp=(await db.query('select updated_at::text from public.company_profiles where company_id=$1',[f.companyId])).rows[0]?.updated_at??null;
 await rival.exec("set role authenticated;set lock_timeout='100ms'");await rival.query("select set_config('request.jwt.claim.sub',$1,false)",[f.owner]);
 const reserve=(key,client=db)=>e.call('public.reserve_exercise_ai_generation',[f.companyId,f.recruitment.id,key,f.position.updated_at,stamp,'a'.repeat(64)],client);
 await db.exec('begin');try {assert.equal((await reserve(key)).claimed,true);await assert.rejects(reserve(key,rival),denied('55P03'));await db.exec('commit');}finally{await db.exec('rollback');}
 assert.equal((await reserve(key,rival)).claimed,false);
 await h.asAdmin();await db.query('update exercise_ai.recruitment_settings set draft_ceiling=2 where recruitment_id=$1',[f.recruitment.id]);await h.asUser(f.owner);
 await db.exec('begin');try{await reserve(randomUUID());await assert.rejects(reserve(randomUUID(),rival),denied('55P03'));await db.exec('commit');}finally{await db.exec('rollback');}
 await assert.rejects(reserve(randomUUID(),rival),denied('PT429'));
});
