import test from 'node:test';
import assert from 'node:assert/strict';
import { activeBoot } from './helpers/competency-active-fixture.mjs';
import { assertCurrentInventory } from './helpers/sc19-migration-fixture.mjs';
import {randomUUID} from 'node:crypto';
import {verifyCompetencyGateway} from '../lib/competency-broker-role.ts';
import {createPostgresSharedLimiter} from '../lib/competency-postgres-limiter.ts';

test('C2: shared limiter has server-owned time, bounded cardinality and isolated privileges',async t=>{
 const {db,h,call,asGateway}=await activeBoot(t,{fullChain:true});await assertCurrentInventory(db);
 const window=(await db.query('select floor(extract(epoch from clock_timestamp())/60)::bigint w')).rows[0].w;
 await asGateway();
 for(let i=0;i<15;i++)assert.equal(await call('private.consume_competency_rate_limit',['a'.repeat(64),window]),true);
 assert.equal(await call('private.consume_competency_rate_limit',['a'.repeat(64),window]),false);
 assert.equal(await call('private.consume_competency_rate_limit',['b'.repeat(64),Number(window)+1]),false);
 assert.equal(await call('private.consume_competency_rate_limit',['b'.repeat(64),Number(window)-1]),false);
 await assert.rejects(call('private.consume_competency_rate_limit',['raw-ip',window]),e=>e.code==='22023');
 await assert.rejects(db.query('select * from competency_runtime.rate_window'),e=>e.code==='42501');
 await h.asUser();await assert.rejects(call('private.consume_competency_rate_limit',['b'.repeat(64),window]),e=>e.code==='42501');
 await h.asAdmin();
 assert.equal((await db.query('select total from competency_runtime.rate_window')).rows[0].total,15);
 // Expiry is checked against the database clock; stale counters are discarded
 // by the next request, even if the previous process vanished.
 await db.query("update competency_runtime.rate_window set window_id=$1,total=300,sources=jsonb_build_object($2::text,15)",[Number(window)-1,'a'.repeat(64)]);
 await asGateway();assert.equal(await call('private.consume_competency_rate_limit',['b'.repeat(64),window]),true);
 await h.asAdmin();const current=(await db.query('select total,sources from competency_runtime.rate_window')).rows[0];
 assert.equal(current.total,1);assert.deepEqual(Object.keys(current.sources),['b'.repeat(64)]);
 await db.query('update competency_runtime.rate_window set window_id=$1',[Number(window)+1]);
 await asGateway();assert.equal(await call('private.consume_competency_rate_limit',['c'.repeat(64),window]),false,'server clock rollback cannot reset a newer window');
});

test('C2: exact gateway audit and production limiter adapter admit only the added RPC',async t=>{
 const {db,h}=await activeBoot(t,{fullChain:true});await h.asAdmin();
 const admin=(await db.query('select current_user name')).rows[0].name;assert.match(admin,/^[a-z_][a-z0-9_]*$/);
 const user='competency_gateway_c2_'+randomUUID().replaceAll('-','').slice(0,16);
 await db.exec(`create role ${user} login noinherit;grant competency_test_gateway to ${user} with admin false,inherit false,set true;
 set log_parameter_max_length=0;set log_parameter_max_length_on_error=0;set log_statement='none';`);
 try{
  await db.exec('set session authorization '+user);
  await assert.rejects(verifyCompetencyGateway(db,user),/Unsafe gateway/);
  await verifyCompetencyGateway(db,user,{postgresLimiter:true});
  let released=false;
  const pool={waitingCount:0,on(){},connect:async()=>({query:(sql,args)=>db.query(sql,args),release(){released=true;}})};
  const limiter=createPostgresSharedLimiter(pool,user);
  const window=(await db.query('select floor(extract(epoch from clock_timestamp())/60)::bigint w')).rows[0].w;
  assert.equal(await limiter.consume('d'.repeat(64),Number(window)),true);assert.equal(released,true);
  await assert.rejects(db.query('select * from competency_runtime.rate_window'),e=>e.code==='42501');
 }finally{await db.exec('set session authorization '+admin+';set role '+admin);await db.exec('drop role '+user);}
});
