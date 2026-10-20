import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { startCompetencyHttps,httpSession } from './helpers/competency-broker-harness.mjs';
import { verifyCompetencyGateway } from '../lib/competency-broker-role.ts';

test('B3 real PG16 admission denies added table, schema and privileged function rights',async t=>{
 const e=await startCompetencyHttps(t,{redis:false});
 const f=await e.seed(),g=await e.issue(f);
 const session=await httpSession(e,g);
 const inspect=()=>e.request('inspect',{cookie:session.cookie,csrf:session.csrf});
 assert.equal((await inspect()).status,200,'restricted baseline gateway is usable');
 const admin=async sql=>{await e.h.asAdmin();await e.db.exec(sql);};
 const user=e.user;
 for(const [grant,revoke] of [
  ['grant select on public.applications to '+user,'revoke select on public.applications from '+user],
  ['grant update on public.applications to '+user,'revoke update on public.applications from '+user],
  ['grant usage on schema private to '+user,'revoke usage on schema private from '+user]
 ]){
  await admin(grant);
  try{ assert.equal((await inspect()).status,503,'unexpected effective privilege must fail closed'); }
  finally{await admin(revoke);}
  assert.equal((await inspect()).status,200,'privilege removal allows existing valid session');
 }
 // Even when role has no table grants, SECURITY DEFINER EXECUTE from PUBLIC
 // is an unauthorized privilege. Temporary synthetic function is not a B2
 // migration and must be removed before the test finishes.
 await admin("create function public.sc014_b3_synthetic_privilege() returns int " +
  "language sql security definer as $$ select 1 $$");
 try{
  assert.equal((await inspect()).status,503,'privileged public function denied');
 }finally{
  await admin('drop function public.sc014_b3_synthetic_privilege()');
 }
 assert.equal((await inspect()).status,200);
});

test('B3 real PG16 rejects unsafe logging on a new dedicated connection',async t=>{
 const e=await startCompetencyHttps(t,{redis:false});
 const client=async()=>{
  const c=new Client({...e.connectionConfig,user:e.user,password:e.password});
  await c.connect();return c;
 };
 const safe=await client();
 try{await verifyCompetencyGateway(safe,e.user);}
 finally{await safe.end();}
 await e.h.asAdmin();
 await e.db.exec('alter role '+e.user+' set log_parameter_max_length=-1');
 const unsafe=await client();
 try{
  assert.equal((await unsafe.query("select current_setting('log_parameter_max_length') as v")).rows[0].v,'-1');
  await assert.rejects(verifyCompetencyGateway(unsafe,e.user),/logging/);
 }finally{await unsafe.end();}
 await e.db.exec('alter role '+e.user+' set log_parameter_max_length=0');
 const restored=await client();
 try{await verifyCompetencyGateway(restored,e.user);}
 finally{await restored.end();}
});

test('B3 enabled adapter installs error listener and client-side timeouts',async t=>{
 const e=await startCompetencyHttps(t,{redis:false});
 assert.equal(e.pool.options.query_timeout,7000);
 assert.ok(e.pool.listenerCount('error')>=1,'idle pool error has a handler');
 assert.doesNotThrow(()=>e.pool.emit('error',new Error('synthetic sensitive details')));
});
