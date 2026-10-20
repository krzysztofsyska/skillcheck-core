import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {parse} from 'pg-connection-string';
import {setupRankingDatabase,createRankingHarness,users} from './helpers/screening-ranking-fixture.mjs';
import {lifecycleHarness} from './helpers/erasure-lifecycle-fixture.mjs';
import {assertAcceptedErasureSchema} from './helpers/erasure-preview-fixture.mjs';
const maintenanceUrl=process.env.SCREENING_TEST_DATABASE_URL;
const databaseName=`erasure_r2_${process.pid}`;
const conflict=promise=>assert.rejects(promise,error=>['PT409','55P03'].includes(error.code));

test('SC-010 R2 real PostgreSQL lifecycle serialization',async t=>{
 assert.ok(maintenanceUrl,'SCREENING_TEST_DATABASE_URL required; PGlite does not prove concurrent transactions');
 const config=name=>({...parse(maintenanceUrl),database:name});
 const maintenance=new Client(config('postgres'));await maintenance.connect();await maintenance.query(`drop database if exists ${databaseName}`);await maintenance.query(`create database ${databaseName}`);await maintenance.end();
 const clients=[];
 const connect=async()=>{const db=new Client(config(databaseName));await db.connect();db.exec=sql=>db.query(sql);clients.push(db);await db.query("set statement_timeout='10s';set lock_timeout='3s'");return db;};
 t.after(async()=>{await Promise.all(clients.map(db=>db.end().catch(()=>{})));const cleanup=new Client(config('postgres'));await cleanup.connect();await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',[databaseName]);await cleanup.query(`drop database if exists ${databaseName}`);await cleanup.end();});
 const db=await connect(),h=await setupRankingDatabase(db),l=lifecycleHarness(h);await assertAcceptedErasureSchema(h,t);
 const session=async()=>{const client=await connect(),h=createRankingHarness(client);await h.asUser();return lifecycleHarness(h);};
 for(const sameKey of [true,false])await t.test(`competing freeze requests ${sameKey?'share':'do not share'} idempotency key`,async()=>{
  const f=await l.ready(),a=await session(),b=await session(),p=await l.ticket(f),key=randomUUID();
  await a.db.query('begin');const request=await a.authorize(f,p,key);await conflict(b.authorize(f,p,sameKey?key:randomUUID()));await a.db.query('commit');
  if(sameKey)assert.equal(await b.authorize(f,p,key),request);else await conflict(b.authorize(f,p));
  const state=await b.status(f);assert.equal(state.status,'authorized');await b.cancel(f,request,state.generation);
 });
 await t.test('committed child edit invalidates ticket; uncommitted edit and freeze cannot both succeed',async()=>{
  const f=await l.ready(),a=await session(),b=await session(),p=await l.ticket(f);
  await a.db.query('begin');await a.db.query('update public.candidate_documents set redacted_text=$1 where id=$2',['Concurrent CV text',f.documentId]);
  await conflict(b.authorize(f,p));await a.db.query('commit');await conflict(b.authorize(f,p));
  const next=await b.ticket(f),request=await b.authorize(f,next),state=await b.status(f);await b.cancel(f,request,state.generation);
 });
 await t.test('freeze commit prevents late child insertion and does not corrupt independent candidate',async()=>{
  const f=await l.ready(),other=await h.candidate(f),a=await session(),b=await session(),p=await l.ticket(f);
  await a.db.query('begin');const request=await a.authorize(f,p);
  await conflict(b.db.query('insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text) values($1,$2,$3,$4)',[f.companyId,f.candidate.id,'late CV','late CV']));
  await a.db.query('commit');await assert.rejects(b.db.query('insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text) values($1,$2,$3,$4)',[f.companyId,f.candidate.id,'late CV','late CV']));
  assert.equal((await b.db.query('update public.candidates set email=$1 where id=$2 returning id',['ok@example.test',other.candidate.id])).rowCount,1);
  const state=await b.status(f);await b.cancel(f,request,state.generation);
 });
 await t.test('request/cancel race has one generation and stale ticket cannot reactivate',async()=>{
  const f=await l.ready(),a=await session(),b=await session(),p=await l.ticket(f),request=await l.authorize(f,p),state=await l.status(f),key=randomUUID();
  await a.db.query('begin');await a.cancel(f,request,state.generation,key);await conflict(b.cancel(f,request,state.generation,randomUUID()));await a.db.query('commit');
  assert.equal(await b.cancel(f,request,state.generation,key),request);await conflict(b.authorize(f,p));
  const fresh=await b.ticket(f),next=await b.authorize(f,fresh),nextState=await b.status(f);assert.notEqual(next,request);await b.cancel(f,next,nextState.generation);
 });

 await t.test('old repeatable-read snapshot cannot write a child after another transaction freezes the candidate',async()=>{
  const f=await l.ready(),a=await session(),b=await session(),p=await l.ticket(f);
  await a.db.query('begin isolation level repeatable read');
  await a.db.query('select txid_current_snapshot()');
  const request=await b.authorize(f,p);
  assert.equal((await a.db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,0);
  try{await assert.rejects(a.db.query('insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text) values($1,$2,$3,$4)',[f.companyId,f.candidate.id,'snapshot late CV','snapshot late CV']),error=>['PT409','40001'].includes(error.code));}finally{await a.db.query('rollback');}
  const state=await b.status(f);await b.cancel(f,request,state.generation);
 });
 await t.test('owner transfer concurrent with freeze prevents former-owner authorization',async()=>{
  const f=await l.ready(),a=await session(),b=await session(),p=await l.ticket(f);
  await a.h.asAdmin();await a.db.query('begin');await a.db.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,f.companyId]);
  await assert.rejects(b.authorize(f,p));await a.db.query('commit');await assert.rejects(b.authorize(f,p));
 });
 await t.test('screening start winning candidate lock rejects freeze and leaves active work visible',async()=>{
  const f=await l.ready(),a=await session(),b=await session(),p=await l.ticket(f);
  await a.db.query('begin');const started=await a.h.start(f);await conflict(b.authorize(f,p));await a.db.query('commit');await conflict(b.authorize(f,p));
  await b.h.asUser();assert.equal((await b.db.query('select count(*)::int n from public.screening_analysis_versions where id=$1',[started.analysis_id])).rows[0].n,1);
 });
});
