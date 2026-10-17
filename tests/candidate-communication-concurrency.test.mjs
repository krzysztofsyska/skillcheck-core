import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {parse} from 'pg-connection-string';
import {setupRankingDatabase,createRankingHarness} from './helpers/screening-ranking-fixture.mjs';
import {communicationHarness} from './helpers/candidate-communication-fixture.mjs';
const maintenanceUrl=process.env.SCREENING_TEST_DATABASE_URL;
const databaseName=`candidate_sc010_${process.pid}`;
const conflict=promise=>assert.rejects(promise,error=>error.code==='PT409');
test('SC-010 real PostgreSQL concurrent contact mutations are serialized without stale authority',async t=>{
 assert.ok(maintenanceUrl,'SCREENING_TEST_DATABASE_URL required; PGlite is not a concurrency substitute');
 const config=name=>({...parse(maintenanceUrl),database:name});
 const maintenance=new Client(config('postgres'));await maintenance.connect();
 await maintenance.query(`drop database if exists ${databaseName}`);await maintenance.query(`create database ${databaseName}`);await maintenance.end();
 const clients=[];
 const connect=async()=>{const db=new Client(config(databaseName));await db.connect();db.exec=sql=>db.query(sql);clients.push(db);await db.query("set statement_timeout='10s';set lock_timeout='3s'");return db;};
 t.after(async()=>{await Promise.all(clients.map(db=>db.end().catch(()=>{})));const cleanup=new Client(config('postgres'));await cleanup.connect();await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',[databaseName]);await cleanup.query(`drop database if exists ${databaseName}`);await cleanup.end();});
 const db=await connect(),h=await setupRankingDatabase(db),c=communicationHarness(h);
 const session=async()=>{const client=await connect(),harness=createRankingHarness(client);await harness.asUser();return {...communicationHarness(harness),db:client};};
 for(const side of ['left','right'])await t.test(`two prepares, ${side} wins candidate lock: exactly one draft and one event`,async()=>{
  const f=await c.ready(),a=await session(),b=await session(),winner=side==='left'?a:b,loser=side==='left'?b:a,key=randomUUID();
  await winner.db.query('begin');const id=await winner.prepare(f,key);await conflict(loser.prepare(f,key));await winner.db.query('commit');
  assert.equal(await loser.prepare(f,key),id);await conflict(loser.prepare(f));
  const rows=await c.list(f);assert.equal(rows.length,1);assert.equal(rows[0].id,id);assert.equal(rows[0].state,'draft');assert.equal((await c.history(id)).length,1);
 });
 await t.test('same request key across different candidates rolls loser transaction back without ghost events',async()=>{
  const f=await c.ready(),other=await h.completedApplication(await h.candidate(f),Array(5).fill('meets'));other.shortlistId=await h.add(other);
  const a=await session(),b=await session(),key=randomUUID();await a.db.query('begin');const id=await a.prepare(f,key);
  const pending=b.prepare(other,key).then(value=>({value}),error=>({error}));
  await h.asAdmin();let waiting=false;
  for(let i=0;i<200;i++){
   const row=(await db.query('select wait_event_type from pg_stat_activity where pid=$1',[b.db.processID])).rows[0];
   if(row?.wait_event_type==='Lock'){waiting=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(waiting,'loser must wait on shared request-key unique index');await a.db.query('commit');
  const result=await pending;assert.equal(result.error?.code,'PT409');
  await h.asUser();assert.equal((await c.list(f))[0].id,id);assert.equal((await c.list(other)).length,0);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.candidate_communication_events where company_id=$1',[f.companyId])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from private.contact_requests where company_id=$1 and request_key=$2',[f.companyId,key])).rows[0].n,1);
  await h.asUser();assert.ok(await b.prepare(other));assert.equal((await c.list(other)).length,1);
 });
 for(const op of ['permission','preferences'])await t.test(`concurrent ${op} writes cannot both consume revision zero`,async()=>{
  const f=await c.ready(),a=await session(),b=await session();
  const write=s=>op==='permission'?s.permission(f,'revoked'):s.preferences(f);
  await a.db.query('begin');await write(a);await conflict(write(b));await a.db.query('commit');await conflict(write(b));
  await h.asUser();const table=op==='permission'?'candidate_contact_permissions':'candidate_contact_preferences';
  const rows=(await db.query(`select revision from public.${table} where candidate_id=$1`,[f.candidate.id])).rows;assert.equal(rows.length,1);assert.equal(Number(rows[0].revision),1);
 });
 for(const first of ['prepare','revoke'])await t.test(`${first} holds first lock: prepare versus revocation cannot leave an active denied draft`,async()=>{
  const f=await c.ready(),a=await session(),b=await session();
  if(first==='prepare'){
   await a.db.query('begin');const id=await a.prepare(f);await conflict(b.permission(f,'revoked'));await a.db.query('commit');await b.permission(f,'revoked');
   const rows=await c.list(f);assert.equal(rows.length,1);assert.equal(rows[0].state,'cancelled');assert.equal((await c.history(id)).length,2);
  }else{
   await a.db.query('begin');await a.permission(f,'revoked');await conflict(b.prepare(f));await a.db.query('commit');await conflict(b.prepare(f));assert.equal((await c.list(f)).length,0);
  }
  await h.asUser();assert.equal((await db.query('select state from public.candidate_contact_permissions where candidate_id=$1',[f.candidate.id])).rows[0].state,'revoked');
 });
 await t.test('two cancels serialize and retry records only one cancellation event',async()=>{
  const f=await c.ready(),id=await c.prepare(f),a=await session(),b=await session();await a.db.query('begin');await a.cancel(id);await conflict(b.cancel(id));await a.db.query('commit');assert.equal(await b.cancel(id),id);
  const rows=await c.list(f);assert.equal(rows[0].state,'cancelled');assert.equal(Number(rows[0].version),2);assert.equal((await c.history(id)).filter(e=>e.event_type==='cancelled').length,1);
 });
 for(const first of ['prepare','cancel'])await t.test(`${first} locks first: prepare and cancellation preserve at most one active draft`,async()=>{
  const f=await c.ready(),id=await c.prepare(f),a=await session(),b=await session();
  if(first==='cancel'){
   await a.db.query('begin');await a.cancel(id);await conflict(b.prepare(f));await a.db.query('commit');await b.prepare(f);
  }else{
   // Same-key replay still takes candidate lock before observing request history.
   await c.cancel(id);const key=randomUUID();await a.db.query('begin');const next=await a.prepare(f,key);await conflict(b.cancel(id));await a.db.query('commit');await b.cancel(next);
  }
  const rows=await c.list(f);assert.equal(rows.length,2);assert.ok(rows.filter(r=>r.state==='draft').length<=1);assert.equal(rows.find(r=>r.id===id).state,'cancelled');
 });
});
