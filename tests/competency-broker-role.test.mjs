/** Embedded PostgreSQL ACL regression; PG16/HTTPS remains a separate CI gate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers/competency-attempt-fixture.mjs';
import {verifyCompetencyGateway} from '../lib/competency-broker-role.ts';

test('B3 actual composed SQL admits only exact LOGIN and gateway privileges',async t=>{
 const e=await boot(t,{embedded:true});
 const db=e.db,user='competency_gateway_acl_fixture';
 await e.h.asAdmin();
 const admin=(await db.query('select current_user name')).rows[0].name;
 assert.match(admin,/^[a-z_][a-z0-9_]*$/);
 await db.exec('create role '+user+' login noinherit; grant competency_test_gateway to '+user);
 await db.exec("set log_parameter_max_length=0;set log_parameter_max_length_on_error=0;set log_statement='none'");
 const audit=async()=>{
  await db.exec('set session authorization '+user);
  try { await verifyCompetencyGateway(db,user); }
  finally { await db.exec('set session authorization '+admin+';set role '+admin); }
 };
 await audit();
 for(const role of [user,'competency_test_gateway']) {
  for(const [grant,revoke] of [
   ['grant select on public.applications to '+role,'revoke select on public.applications from '+role],
   ['grant select(id) on public.applications to '+role,'revoke select(id) on public.applications from '+role],
   ['grant update(status) on public.applications to '+role,'revoke update(status) on public.applications from '+role],
   ['grant usage on schema extensions to '+role,'revoke usage on schema extensions from '+role],
   ['grant select on pg_catalog.pg_authid to '+role,'revoke select on pg_catalog.pg_authid from '+role],
   ['grant select(rolpassword) on pg_catalog.pg_authid to '+role,'revoke select(rolpassword) on pg_catalog.pg_authid from '+role],
   ['grant execute on function pg_catalog.pg_read_file(text) to '+role,'revoke execute on function pg_catalog.pg_read_file(text) from '+role],
   ['grant set on parameter log_statement to '+role,'revoke set on parameter log_statement from '+role],
   ['grant alter system on parameter log_statement to '+role,'revoke alter system on parameter log_statement from '+role],
  ]) {
   await db.exec(grant);
   try { await assert.rejects(audit(),/Unsafe gateway/); }
   finally { await db.exec(revoke); }
   await audit();
  }
 }
 // REVOKE does not remove an owner's ability to self-GRANT the privilege.
 for(const role of [user,'competency_test_gateway']) {
  await db.exec('create table public.sc014_b3_owned(secret text);alter table public.sc014_b3_owned owner to '+role+';revoke all on public.sc014_b3_owned from '+role);
  try { await assert.rejects(audit(),/Unsafe gateway/); }
  finally { await db.exec('drop table public.sc014_b3_owned'); }
  await audit();
 }
 await db.exec('create sequence public.sc014_b3_sequence');
 for(const role of [user,'competency_test_gateway']) {
  await db.exec('grant usage on public.sc014_b3_sequence to '+role);
  try { await assert.rejects(audit(),/Unsafe gateway/); }
  finally { await db.exec('revoke usage on public.sc014_b3_sequence from '+role); }
 }
 await db.exec('drop sequence public.sc014_b3_sequence');
 for(const [create,drop] of [
  ['create function public.sc014_b3_invoker() returns integer language sql as $$select 1$$','drop function public.sc014_b3_invoker()'],
  ['create function private.inspect_candidate_competency_test(text) returns integer language sql as $$select 1$$','drop function private.inspect_candidate_competency_test(text)'],
 ]) {
  await db.exec(create);
  try { await assert.rejects(audit(),/Unsafe gateway/); }
  finally { await db.exec(drop); }
 }
 await db.exec('grant competency_test_gateway to '+user+' with admin option');
 try { await assert.rejects(audit(),/Unsafe gateway/); }
 finally { await db.exec('revoke admin option for competency_test_gateway from '+user); }
 await db.exec('grant competency_test_gateway to '+user+' with inherit true');
 try { await assert.rejects(audit(),/Unsafe gateway/); }
 finally { await db.exec('grant competency_test_gateway to '+user+' with inherit false'); }
 await db.exec('alter role competency_test_gateway login');
 try { await assert.rejects(audit(),/Unsafe gateway/); }
 finally { await db.exec('alter role competency_test_gateway nologin'); }
 await db.exec('revoke execute on function private.status_candidate_competency_test(bytea) from competency_test_gateway');
 try { await assert.rejects(audit(),/Unsafe gateway/); }
 finally { await db.exec('grant execute on function private.status_candidate_competency_test(bytea) to competency_test_gateway'); }
 await audit();
});
