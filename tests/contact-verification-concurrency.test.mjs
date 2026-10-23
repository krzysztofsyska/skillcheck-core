import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {parse} from 'pg-connection-string';
import {setupRankingDatabase,createRankingHarness} from './helpers/screening-ranking-fixture.mjs';
import {verificationHarness} from './helpers/contact-verification-fixture.mjs';
const maintenanceUrl=process.env.SCREENING_TEST_DATABASE_URL;
const databaseName=`contact_b2_${process.pid}`;
const conflict=promise=>assert.rejects(promise,error=>error.code==='PT409'||error.message==='CONTACT_VERIFICATION_NOT_ACCEPTED');

test('SC-010 B2 real PostgreSQL locking prevents stale evidence and approvals',async t=>{
 assert.ok(maintenanceUrl,'SCREENING_TEST_DATABASE_URL required; no PGlite concurrency substitute');
 const config=name=>({...parse(maintenanceUrl),database:name});
 const maintenance=new Client(config('postgres'));await maintenance.connect();
 await maintenance.query(`drop database if exists ${databaseName}`);await maintenance.query(`create database ${databaseName}`);await maintenance.end();
 const clients=[];
 const connect=async()=>{const db=new Client(config(databaseName));await db.connect();db.exec=sql=>db.query(sql);clients.push(db);await db.query("set statement_timeout='10s';set lock_timeout='3s'");return db;};
 t.after(async()=>{await Promise.all(clients.map(db=>db.end().catch(()=>{})));const cleanup=new Client(config('postgres'));await cleanup.connect();await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',[databaseName]);await cleanup.query(`drop database if exists ${databaseName}`);await cleanup.end();});
 const db=await connect(),h=await setupRankingDatabase(db),v=verificationHarness(h);
 const session=async()=>{const db=await connect(),h=createRankingHarness(db);await h.asUser();return {...verificationHarness(h),h,db};};
 for(const same of [true,false])await t.test(`two receipt ingestions ${same?'same':'different'} nonce consume one contact generation`,async()=>{
  const f=await v.ready(),a=await session(),b=await session(),r=a.receipt(f),other=same?r:b.receipt(f);
  await a.db.query('begin');assert.equal(await a.ingest(f,r),r.receipt_id);await conflict(b.ingest(f,other));await a.db.query('commit');
  if(same)assert.equal(await b.ingest(f,r),r.receipt_id);else await conflict(b.ingest(f,other));
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.candidate_verified_contact_points where company_id=$1',[f.companyId])).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from private.candidate_verified_contact_receipts where company_id=$1',[f.companyId])).rows[0].n,1);
 });
 for(const first of ['ingest','revoke'])await t.test(`${first} first: receipt versus revoke cannot restore authority`,async()=>{
  const f=await v.ready(),a=await session(),b=await session(),r=a.receipt(f);
  await a.db.query('begin');
  if(first==='ingest'){await a.ingest(f,r);await conflict(b.permission(f,'revoked'));await a.db.query('commit');await b.permission(f,'revoked');}
  else{await a.permission(f,'revoked');await conflict(b.ingest(f,r));await a.db.query('commit');await conflict(b.ingest(f,r));}
  await h.asUser();assert.equal((await db.query('select state from public.candidate_contact_permissions where candidate_id=$1',[f.candidate.id])).rows[0].state,'revoked');
 });
 await t.test('two approvals serialize; same request retry returns original immutable snapshot',async()=>{
  const f=await v.ready(),id=await v.prepare(f),receipt=await v.ingest(f),a=await session(),b=await session(),key=randomUUID();
  await a.db.query('begin');const approval=await a.approve(id,receipt,1,key);await conflict(b.approve(id,receipt,1,key));await a.db.query('commit');assert.equal(await b.approve(id,receipt,1,key),approval);await conflict(b.approve(id,receipt,1));
  await h.asUser();assert.equal((await v.status(id)).approval_id,approval);assert.equal((await db.query('select count(*)::int n from public.candidate_communication_approvals where communication_id=$1',[id])).rows[0].n,1);
 });
 for(const operation of ['revoke','preferences','contact','review','shortlist'])for(const first of ['approve','change'])await t.test(`${operation} versus approval, ${first} locks first: no current stale snapshot`,async()=>{
  const f=await v.ready(),id=await v.prepare(f),rid=await v.ingest(f),a=await session(),b=await session();
  const replacement={expected_contact_version:1,destination:'replacement@example.test'},r=b.receipt(f,replacement);
  const change=async s=>{
   if(operation==='revoke')return s.permission(f,'revoked');
   if(operation==='preferences')return s.preferences(f);
   if(operation==='contact')return s.ingest(f,r,{context:replacement});
   if(operation==='review')return s.h.review(f,f.analysis_id);
   return s.h.remove(f.shortlistId);
  };
  await a.db.query('begin');
  if(first==='approve'){
   await a.approve(id,rid);
   if(operation==='shortlist'){
    // SC-008 shortlist removal still uses a blocking row lock. Observe the
    // actual wait, release the approval snapshot, then require their success.
    const pending=change(b).then(value=>({value}),error=>({error}));
    await h.asAdmin();let waiting=false;
    for(let i=0;i<150;i++){
     const row=(await db.query('select wait_event_type from pg_stat_activity where pid=$1',[b.db.processID])).rows[0];
     if(row?.wait_event_type==='Lock'){waiting=true;break;}
     await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(waiting,'source writer must wait for approved source snapshot');await a.db.query('commit');
    const result=await pending;if(result.error)throw result.error;
   }else{
    // R2 review now takes the candidate NOWAIT guard before reading its source.
    if(operation==='review')await assert.rejects(change(b),error=>error.code==='PT409');
    else await conflict(change(b));
    await a.db.query('commit');await b.h.asUser();await change(b);
   }
  }else{
   await change(a);await conflict(b.approve(id,rid));await a.db.query('commit');await b.h.asUser();await conflict(b.approve(id,rid));
  }
  await h.asUser();assert.equal((await v.status(id)).is_current,false);
 });
});
