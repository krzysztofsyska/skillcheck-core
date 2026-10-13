import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {parse} from 'pg-connection-string';
import {setupRankingDatabase,createRankingHarness} from './helpers/screening-ranking-fixture.mjs';
import {executionHarness,setupExecutionLedger} from './helpers/erasure-execution-fixture.mjs';
import {assertAcceptedErasureSchema} from './helpers/erasure-preview-fixture.mjs';
const url=process.env.SCREENING_TEST_DATABASE_URL;
const productName=`erasure_r3_${process.pid}`,ledgerName=`erasure_r3_ledger_${process.pid}`;
const conflict=promise=>assert.rejects(promise,error=>error.code==='PT409');

test('SC-010 R3 actual PostgreSQL request, ACK and purge serialization',async t=>{
 assert.ok(url,'SCREENING_TEST_DATABASE_URL is required; no PGlite concurrency substitute');
 const config=name=>({...parse(url),database:name});
 const maintenance=new Client(config('postgres'));await maintenance.connect();
 for(const name of [productName,ledgerName]){await maintenance.query(`drop database if exists ${name}`);await maintenance.query(`create database ${name}`);}await maintenance.end();
 const clients=[];
 const connect=async(name=productName)=>{const db=new Client(config(name));await db.connect();db.exec=sql=>db.query(sql);clients.push(db);await db.query("set statement_timeout='10s';set lock_timeout='3s'");return db;};
 t.after(async()=>{await Promise.all(clients.map(db=>db.end().catch(()=>{})));const c=new Client(config('postgres'));await c.connect();for(const name of [productName,ledgerName]){await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',[name]);await c.query(`drop database if exists ${name}`);}await c.end();});
 const db=await connect(),h=await setupRankingDatabase(db),ledgerDb=await connect(ledgerName),x=await setupExecutionLedger(executionHarness(h),ledgerDb);
 await assertAcceptedErasureSchema(h,t);await x.configure();
 const session=async()=>executionHarness(createRankingHarness(await connect()));
 for(const sameKey of [true,false])await t.test(`two reservations ${sameKey?'same':'different'} command serialize without competing envelopes`,async()=>{
  const f=await x.ready(),state=await x.freeze(f),a=await session(),b=await session(),key=randomUUID();
  await a.db.query('begin');const reservation=await a.reserve(state.request_id,0,'authorized',key);
  await conflict(b.reserve(state.request_id,0,'authorized',sameKey?key:randomUUID()));await a.db.query('commit');
  if(sameKey)assert.deepEqual(await b.reserve(state.request_id,0,'authorized',key),reservation);else await conflict(b.reserve(state.request_id,0,'authorized'));
  await x.ack(reservation);assert.equal((await x.work(state.request_id)).sequence,1);
 });
 for(const first of ['cancel','erasing'])await t.test(`${first} wins: ledger reservation excludes the competing irreversible transition`,async()=>{
  const f=await x.ready(),state=await x.freeze(f),a=await session(),b=await session();await x.transition(state.request_id,0,'authorized');
  await a.db.query('begin');
  if(first==='cancel'){
   await a.h.asUser(f.owner);await a.cancel(f,state.request_id,state.generation);await conflict(b.reserve(state.request_id,1,'erasing'));await a.db.query('commit');
   const reserved=await x.work(state.request_id);await x.ack(reserved);await conflict(b.reserve(state.request_id,2,'erasing'));
   await h.asUser(f.owner);assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,1);
  }else{
   const reserved=await a.reserve(state.request_id,1,'erasing');await b.h.asUser(f.owner);await conflict(b.cancel(f,state.request_id,state.generation));await a.db.query('commit');await x.ack(reserved);
   await b.h.asUser(f.owner);await conflict(b.cancel(f,state.request_id,state.generation));await x.purge(state.request_id,2);
  }
 });
 await t.test('two purgers cannot duplicate deletion or bypass a committed tombstone',async()=>{
  const f=await x.ready({rich:true}),state=await x.freeze(f),a=await session(),b=await session();await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
  await a.db.query('begin');const result=await a.purge(state.request_id,2);await conflict(b.purge(state.request_id,2));await a.db.query('commit');
  const replay=await b.purge(state.request_id,2);assert.equal(replay.receipt_id,result.receipt_id);
  await b.h.asUser(f.owner);await conflict(b.db.query('insert into public.candidates(id,company_id,first_name,last_name) values($1,$2,$3,$4)',[f.candidate.id,f.companyId,'Late','Client']));
 });
 for(const first of ['hold','erasing'])await t.test(`${first} obtains request lock: hold and erasing never both win`,async()=>{
  const f=await x.ready(),state=await x.freeze(f),a=await session(),b=await session();await x.transition(state.request_id,0,'authorized');
  const hold=async s=>{await s.h.asUser(f.owner);return s.db.query("select public.set_candidate_erasure_hold($1,'owner_review',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',$2)",[state.request_id,randomUUID()]);};
  await a.db.query('begin');
  if(first==='hold'){await hold(a);await conflict(b.reserve(state.request_id,1,'erasing'));await a.db.query('commit');await conflict(b.reserve(state.request_id,1,'erasing'));}
  else{const reserved=await a.reserve(state.request_id,1,'erasing');await conflict(hold(b));await a.db.query('commit');await conflict(hold(b));await x.ack(reserved);}
 });
 await t.test('worker session cannot become the purge owner',async()=>{
  const isolated=await connect();await isolated.query('set session authorization erasure_worker');
  await assert.rejects(isolated.query('set role erasure_purge_owner'),error=>error.code==='42501');
 });

 await t.test('erasing reservation excludes a concurrent policy change through ledger acknowledgment',async()=>{
  const f=await x.ready(),state=await x.freeze(f),a=await session(),b=await session();await x.transition(state.request_id,0,'authorized');
  await b.h.asUser(f.owner);const policy=await b.getPolicy(f),rules=policy.rules.map(rule=>({...rule,duration_days:rule.duration_days+1}));
  await a.db.query('begin');const reserved=await a.reserve(state.request_id,1,'erasing');
  await conflict(b.policy(f,policy.revision,rules));await a.db.query('commit');await conflict(b.policy(f,policy.revision,rules));
  await x.ack(reserved);await x.purge(state.request_id,2);
 });

});
