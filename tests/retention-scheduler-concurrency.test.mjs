import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {parse} from 'pg-connection-string';
import {setupRankingDatabase,createRankingHarness} from './helpers/screening-ranking-fixture.mjs';
import {retentionHarness} from './helpers/retention-scheduler-fixture.mjs';
import {setupExecutionLedger} from './helpers/erasure-execution-fixture.mjs';
import {assertAcceptedErasureSchema} from './helpers/erasure-preview-fixture.mjs';
const url=process.env.SCREENING_TEST_DATABASE_URL;
const conflict=p=>assert.rejects(p,e=>e.code==='PT409');
test('SC-010 R4 real PostgreSQL eligibility and delegated irreversible transition races',async t=>{
 assert.ok(url,'SCREENING_TEST_DATABASE_URL required; no PGlite concurrency substitute');
 const names=[`retention_r4_${process.pid}`,`retention_r4_ledger_${process.pid}`],config=name=>({...parse(url),database:name}),maintenance=new Client(config('postgres'));
 await maintenance.connect();for(const name of names){await maintenance.query(`drop database if exists ${name}`);await maintenance.query(`create database ${name}`);}await maintenance.end();
 const clients=[];const connect=async(name=names[0])=>{const db=new Client(config(name));await db.connect();db.exec=sql=>db.query(sql);clients.push(db);await db.query("set statement_timeout='10s';set lock_timeout='3s'");return db;};
 t.after(async()=>{await Promise.all(clients.map(db=>db.end().catch(()=>{})));const c=new Client(config('postgres'));await c.connect();for(const name of names){await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',[name]);await c.query(`drop database if exists ${name}`);}await c.end();});
 const db=await connect(),h=await setupRankingDatabase(db),x=await setupExecutionLedger(retentionHarness(h),await connect(names[1]));await assertAcceptedErasureSchema(h,t);await x.configure();
 const session=async()=>retentionHarness(createRankingHarness(await connect()));
 const due=async()=>{const f=await x.ready();await x.close(f);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);return f;};
 await t.test('simultaneous ticks create at most one automatic request for the same scope',async()=>{
  const f=await due(),a=await session(),b=await session();await a.db.query('begin');const tick=await a.tick(),request=tick.results.find(r=>r.request_id)?.request_id;assert.ok(request);
  const competing=await b.tick();assert.equal(competing.authorized,0);await a.db.query('commit');await b.tick();await h.asUser(f.owner);assert.equal((await x.scheduleStatus(f)).authorized,1);
 });
 for(const change of ['reopen','new_application'])await t.test(`${change} committed before tick invalidates the previously due scope`,async()=>{
  const f=await due(),a=await session(),b=await session();await a.h.asUser(f.owner);await a.db.query('begin');
  if(change==='reopen')await a.db.query("update public.recruitments set status='open' where id=$1",[f.recruitment.id]);
  else {const rec=await a.h.insert('recruitments',{company_id:f.companyId,position_id:f.position.id,name:'New active purpose',status:'open'});await a.h.insert('applications',{company_id:f.companyId,recruitment_id:rec.id,candidate_id:f.candidate.id});}
  const competing=await b.tick();assert.equal(competing.authorized,0);await a.db.query('commit');const retried=await b.tick();assert.ok(retried.results.some(r=>r.blockers?.includes('active_purpose')));await h.asUser(f.owner);assert.equal(await x.status(f),null);await x.revoke(f);
 });
 for(const first of ['revocation','erasing'])await t.test(`${first} excludes the competing delegated authority transition`,async()=>{
  const f=await due(),request=(await x.tick()).results.find(r=>r.request_id)?.request_id;assert.ok(request);await x.transition(request,0,'authorized');const a=await session(),b=await session();await a.db.query('begin');
  if(first==='revocation'){await a.h.asUser(f.owner);await a.revoke(f);await conflict(b.reserve(request,1,'erasing'));await a.db.query('commit');await conflict(b.reserve(request,1,'erasing'));}
  else {const reserved=await a.reserve(request,1,'erasing');await b.h.asUser(f.owner);await conflict(b.revoke(f));await a.db.query('commit');await conflict(b.revoke(f));await x.ack(reserved);await x.purge(request,2);}
 });
 await t.test('stale-snapshot scheduler transactions cannot authorize from a previous eligibility snapshot',async()=>{
  const f=await due(),a=await session();await a.db.query('begin isolation level repeatable read');await conflict(a.tick());await a.db.query('rollback');await h.asUser(f.owner);assert.equal(await x.status(f),null);await x.revoke(f);
 });
});
