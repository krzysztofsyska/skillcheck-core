import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {parse} from 'pg-connection-string';
import {setupRankingDatabase,createRankingHarness,users} from './helpers/screening-ranking-fixture.mjs';
import {erasureHarness,retentionRules} from './helpers/erasure-preview-fixture.mjs';
const maintenanceUrl=process.env.SCREENING_TEST_DATABASE_URL;
const databaseName=`erasure_r1_${process.pid}`;
const conflict=promise=>assert.rejects(promise,error=>error.code==='PT409');

test('SC-010 R1 real PostgreSQL CAS and read-only manifest consistency',async t=>{
 assert.ok(maintenanceUrl,'SCREENING_TEST_DATABASE_URL required; no PGlite concurrency substitute');
 const config=name=>({...parse(maintenanceUrl),database:name});
 const maintenance=new Client(config('postgres'));await maintenance.connect();
 await maintenance.query(`drop database if exists ${databaseName}`);await maintenance.query(`create database ${databaseName}`);await maintenance.end();
 const clients=[];
 const connect=async()=>{const db=new Client(config(databaseName));await db.connect();db.exec=sql=>db.query(sql);clients.push(db);await db.query("set statement_timeout='10s';set lock_timeout='3s'");return db;};
 t.after(async()=>{await Promise.all(clients.map(db=>db.end().catch(()=>{})));const cleanup=new Client(config('postgres'));await cleanup.connect();await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',[databaseName]);await cleanup.query(`drop database if exists ${databaseName}`);await cleanup.end();});
 const db=await connect(),h=await setupRankingDatabase(db),e=erasureHarness(h);
 const session=async()=>{const db=await connect(),h=createRankingHarness(db);await h.asUser();return {...erasureHarness(h),h,db};};
 const waiting=async client=>{await h.asAdmin();for(let i=0;i<150;i++){const row=(await db.query('select wait_event_type from pg_stat_activity where pid=$1',[client.processID])).rows[0];if(row?.wait_event_type==='Lock')return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('writer should wait on the actual locked row');};
 for(const operation of ['policy','resolution'])for(const sameKey of [true,false])await t.test(`two ${operation} mutations, ${sameKey?'shared':'different'} key: one version and deterministic retry`,async()=>{
  const f=await h.seed(),a=await session(),b=await session(),key=randomUUID();
  const write=(s,k)=>operation==='policy'?s.policy(f,0,retentionRules,k):s.resolve(f,[f.candidate.id],0,k);
  await a.db.query('begin');const id=await write(a,key);await conflict(write(b,sameKey?key:randomUUID()));await a.db.query('commit');
  if(sameKey)assert.equal(await write(b,key),id);else await conflict(write(b,randomUUID()));
  await h.asUser();const preview=await e.preview(f,operation==='resolution'?'confirmed_subject':'candidate_record',operation==='resolution'?id:null);
  assert.equal(operation==='policy'?preview.policy_revision:preview.resolution_revision,1);
 });
 await t.test('policy update cannot race ownership transfer into new authorization by former owner',async()=>{
  const f=await h.seed(),a=await session(),b=await session();
  await a.h.asAdmin();await a.db.query('begin');await a.db.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,f.companyId]);
  await assert.rejects(b.policy(f));await a.db.query('commit');await assert.rejects(b.policy(f));await assert.rejects(b.resolve(f));
  await b.h.asUser(users.otherOwner);assert.ok(await b.policy(f));
 });
 await t.test('owner resolution serializes with candidate edits and a later preview binds committed contents',async()=>{
  const f=await h.seed(),a=await session(),b=await session();const before=await e.preview(f);
  await a.db.query('begin');const resolution=await a.resolve(f);
  const pending=b.db.query('update public.candidates set email=$1 where id=$2',['concurrent@example.test',f.candidate.id]).then(value=>({value}),error=>({error}));
  await waiting(b.db);await a.db.query('commit');const result=await pending;if(result.error)throw result.error;
  await h.asUser();const after=await e.preview(f,'confirmed_subject',resolution);assert.notEqual(after.manifest_hash,before.manifest_hash);assert.equal(after.candidate_count,1);
 });
 await t.test('preview ignores uncommitted graph writes then invalidates hash after commit without mutating rows',async()=>{
  const f=await h.seed(),a=await session(),b=await session();await e.policy(f);const resolution=await e.resolve(f),before=await e.preview(f,'confirmed_subject',resolution);
  await a.db.query('begin');await a.db.query('update public.candidates set email=$1 where id=$2',['pending@example.test',f.candidate.id]);
  const during=await b.preview(f,'confirmed_subject',resolution);assert.equal(during.manifest_hash,before.manifest_hash);assert.deepEqual(during.counts,before.counts);
  await a.db.query('commit');const after=await b.preview(f,'confirmed_subject',resolution);assert.notEqual(after.manifest_hash,before.manifest_hash);assert.deepEqual(after.counts,before.counts);
 });
 await t.test('preview binds only committed policy and resolution revisions',async()=>{
  const f=await h.seed(),a=await session(),b=await session();await e.policy(f);const resolution=await e.resolve(f),before=await e.preview(f,'confirmed_subject',resolution);
  await a.db.query('begin');await a.policy(f,1,[{...retentionRules[0],duration_days:31}]);await a.resolve(f,[f.candidate.id],1);
  const during=await b.preview(f,'confirmed_subject',resolution);assert.equal(during.manifest_hash,before.manifest_hash);
  await a.db.query('commit');const after=await b.preview(f,'confirmed_subject',resolution);assert.notEqual(after.manifest_hash,before.manifest_hash);assert.ok(after.blockers.includes('subject_resolution_changed'));assert.equal(after.policy_revision,2);
 });
});
