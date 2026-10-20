import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { startCompetencyHttps,httpSession } from './helpers/competency-broker-harness.mjs';
import { verifyCompetencyGateway } from '../lib/competency-broker-role.ts';

test('B3 real PG16 exact login/gateway allowlists deny table, column, schema and invoker rights',async t=>{
 const e=await startCompetencyHttps(t,{redis:false});
 const f=await e.seed(),g=await e.issue(f);
 const session=await httpSession(e,g);
 const inspect=()=>e.request('inspect',{cookie:session.cookie,csrf:session.csrf});
 assert.equal((await inspect()).status,200,'restricted baseline gateway is usable');
 const admin=async sql=>{await e.h.asAdmin();await e.db.exec(sql);};
 const user=e.user;
 const denied=async()=>{
  const before=e.acquired,reply=await inspect();
  assert.equal(reply.status,503);assert.equal(reply.headers['set-cookie'],undefined);
  assert.equal(e.acquired,before,'no verified B2 lease after unsafe privileges');
  assert.doesNotMatch(reply.raw,/applications|SELECT|token|password|postgres/i);
 };
 for (const role of [user,'competency_test_gateway']) {
  for(const [grant,revoke] of [
   ['grant select on public.applications to '+role,'revoke select on public.applications from '+role],
   ['grant update on public.applications to '+role,'revoke update on public.applications from '+role],
   ['grant select(id) on public.applications to '+role,'revoke select(id) on public.applications from '+role],
   ['grant update(status) on public.applications to '+role,'revoke update(status) on public.applications from '+role],
   ['grant usage on schema auth to '+role,'revoke usage on schema auth from '+role],
   ['grant create on schema public to '+role,'revoke create on schema public from '+role],
   ['grant select on pg_catalog.pg_authid to '+role,'revoke select on pg_catalog.pg_authid from '+role],
   ['grant select(rolpassword) on pg_catalog.pg_authid to '+role,'revoke select(rolpassword) on pg_catalog.pg_authid from '+role],
   ['grant execute on function pg_catalog.pg_read_file(text) to '+role,'revoke execute on function pg_catalog.pg_read_file(text) from '+role],
   ['grant set on parameter log_statement to '+role,'revoke set on parameter log_statement from '+role],
   ['grant alter system on parameter log_statement to '+role,'revoke alter system on parameter log_statement from '+role],
  ]) {
   await admin(grant);
   try { await denied(); }
   finally { await admin(revoke); }
   assert.equal((await inspect()).status,200,'removing the right restores the same valid session');
  }
 }
 for(const role of [user,'competency_test_gateway']) {
  await admin('create table public.sc014_b3_owned(secret text);alter table public.sc014_b3_owned owner to '+role+';revoke all on public.sc014_b3_owned from '+role);
  try { await denied(); }
  finally { await admin('drop table public.sc014_b3_owned'); }
  assert.equal((await inspect()).status,200);
 }
 await admin('grant usage on schema private to '+user);
 try { await denied(); }
 finally { await admin('revoke usage on schema private from '+user); }
 // An ordinary invoker function is also outside the exact six RPC signatures.
 await admin("create function public.sc014_b3_invoker() returns int language sql as $$select 1$$");
 try { await denied(); }
 finally { await admin('drop function public.sc014_b3_invoker()'); }
 // A new overload of a legitimate name must not enter the allowlist.
 await admin("create function private.inspect_candidate_competency_test(text) returns int language sql as $$select 1$$");
 try { await denied(); }
 finally { await admin('drop function private.inspect_candidate_competency_test(text)'); }
 assert.equal((await inspect()).status,200);
 // Even when role has no table grants, SECURITY DEFINER EXECUTE from PUBLIC
 // is an unauthorized privilege. Temporary synthetic function is not a B2
 // migration and must be removed before the test finishes.
 await admin("create function public.sc014_b3_synthetic_privilege() returns int " +
  "language sql security definer as $$ select 1 $$");
 try{
  await denied();
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
