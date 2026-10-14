import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_release_"+process.pid;
const h64=x=>x.repeat(64);
const template="skillcheck-voice-plan-v1";
const envelopeHash=h64("b");
const envelope={schemaVersion:1,language:"pl-PL",recordingAllowed:false,
  noticeRequired:true,targetSeconds:420,maximumSeconds:600,questions:[{},{},{},{}]};
const call="select private.sc012b_release_plan($1,$2,$3,$4,$5,$6) as id";
const has=(code,fragment)=>e=>e.code===code&&String(e.message).includes(fragment);

test("SC-012-B isolated release RPC enforces approval, current pointer CAS and replay",async t=>{
 assert.ok(url,"real PostgreSQL is required");
 const config=db=>({...parse(url),database:db});
 const maintenance=new Client(config("postgres"));await maintenance.connect();
 await maintenance.query("drop database if exists "+dbName);
 await maintenance.query("create database "+dbName);await maintenance.end();
 const clients=[];
 const connect=async()=>{
   const c=new Client(config(dbName));await c.connect();c.exec=s=>c.query(s);
   clients.push(c);await c.query("set statement_timeout='20s'; set lock_timeout='2s'");
   return c;
 };
 t.after(async()=>{
  await Promise.all(clients.map(c=>c.end().catch(()=>{})));
  const c=new Client(config("postgres"));await c.connect();
  await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",[dbName]);
  await c.query("drop database if exists "+dbName);await c.end();
 });
 const db=await connect(),h=await setupRankingDatabase(db);
 await db.exec(await readFile(new URL("../db/prototypes/sc012b-plan-schema.sql",import.meta.url),"utf8"));
 await db.exec(await readFile(new URL("../db/isolated/sc012b-release-rpc.sql",import.meta.url),"utf8"));
 await db.query("insert into private.voice_plan_template_catalog(template_version,envelope_contract_hash,enabled) values($1,$2,true)",[template,envelopeHash]);
 const actor=async(id,client=db)=>client.query("select set_config('request.jwt.claim.sub',$1,false)",[id||""]);
 const args=(plan,review,source,key=randomUUID(),version=null,release=null)=>[plan,review,source,version,release,key];
 async function insertPlan(fix,shortlist,{version=1,supersedes=null,corrects=null,retention="2030-01-01"}={}){
  return (await db.query([
   "with src as (select private.sc012b_recompute_release_source($1,$2,$3,$4,$5,$6,$7) as p)",
   "insert into public.voice_plan_versions",
   "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
   "shortlist_entry_id,supersedes_plan_id,corrects_review_id,plan_version,source_hash,envelope_hash,",
   "source_snapshot,plan_envelope,template_version,created_by,retention_policy_version,retention_deadline)",
   "select $1,$8,$2,$9,$3,$4,$5,$10,$11,$12,src.p->>'sourceHash',$13,src.p->'sourceSnapshot',$14::jsonb,$6,$15,'synthetic-v1',$16::timestamptz from src",
   "returning id, source_hash, source_snapshot::text as snapshot"
  ].join(" "),[fix.companyId,fix.application.id,fix.analysis_id,fix.reviewId,shortlist,template,envelopeHash,
   fix.recruitment.id,fix.position.id,supersedes,corrects,version,envelopeHash,JSON.stringify(envelope),users.owner,retention])).rows[0];
 }
 async function insertReview(fix,planId,source,retention="2030-01-01",decision="approved"){
  return (await db.query([
   "insert into private.voice_plan_review_entries",
   "(company_id,application_id,plan_id,review_version,reviewer_id,decision,source_hash,",
   "retention_policy_version,retention_deadline)",
   "values($1,$2,$3,1,$4,$5,$6,'synthetic-v1',$7::timestamptz) returning id"
  ].join(" "),[fix.companyId,fix.application.id,planId,users.owner,decision,source,retention])).rows[0].id;
 }
 async function freshApproved(retention="2030-01-01",reviewRetention=retention){
  const seeded=await h.seed(users.owner,randomUUID(),5);
  const done=await h.completedApplication(seeded,Array(5).fill("meets"));
  await h.asUser(users.owner);
  const shortlist=await h.add(done);
  await h.asAdmin();
  const plan=await insertPlan(done,shortlist,{retention});
  const review=await insertReview(done,plan.id,plan.source_hash,reviewRetention);
  return {...done,shortlist,planId:plan.id,source:plan.source_hash,snapshot:plan.snapshot,review};
 }
 const primary=await freshApproved();
 await actor(users.owner);
 await t.test("reject unreviewed plans",async()=>{
  const bare=await h.seed(users.owner,randomUUID(),5);
  const done=await h.completedApplication(bare,Array(5).fill("meets"));
  await h.asUser(users.owner);
  const shortlist=await h.add(done);
  await h.asAdmin();
  const plan=await insertPlan(done,shortlist);
  await actor(users.owner);
  await assert.rejects(db.query(call,args(plan.id,randomUUID(),plan.source_hash)),has("PT409","VOICE_PLAN_REVIEW_STALE"));
 });
 await t.test("deny anonymous and foreign-company callers",async()=>{
  await actor("");
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source)),e=>e.code==="22023");
  await actor(users.otherOwner);
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source)),e=>e.code==="42501");
  await actor(users.owner);
 });
 await t.test("deny incorrect review, invalid pointer and stale source",async()=>{
  await assert.rejects(db.query(call,args(primary.planId,randomUUID(),primary.source)),has("PT409","VOICE_PLAN_REVIEW_STALE"));
  await assert.rejects(db.query(call,args(primary.planId,primary.review,h64("f"))),has("PT409","VOICE_PLAN_STALE"));
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source,randomUUID(),1,randomUUID())),has("PT409","VOICE_PLAN_POINTER_CONFLICT"));
 });
 await t.test("withdrawn template blocks release without marking screening stale",async()=>{
  await db.query("update private.voice_plan_template_catalog set enabled=false, withdrawn_at=now() where template_version=$1",[template]);
  try{
   await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source)),has("PT409","VOICE_PLAN_TEMPLATE_STALE"));
   const stale=await db.query("select stale_at from public.screening_analysis_versions where id=$1",[primary.analysis_id]);
   assert.equal(stale.rows[0].stale_at,null);
  }finally{
   await db.query("update private.voice_plan_template_catalog set enabled=true, withdrawn_at=null where template_version=$1",[template]);
  }
 });
 const key=randomUUID();
 const release=(await db.query(call,args(primary.planId,primary.review,primary.source,key))).rows[0].id;
 await t.test("release creates one pointer and immutable history",async()=>{
  assert.equal(primary.snapshot.includes("PRIVATE"),false);
  assert.equal(primary.snapshot.includes("original CV"),false);
  const row=(await db.query("select plan_id,release_entry_id,pointer_version from private.voice_plan_current_releases where application_id=$1",[primary.application.id])).rows[0];
  assert.equal(row.plan_id,primary.planId);
  assert.equal(row.release_entry_id,release);
  assert.equal(Number(row.pointer_version),1);
  const history=(await db.query("select count(*)::int as n, min(release_version)::int as version from private.voice_plan_release_entries where plan_id=$1",[primary.planId])).rows[0];
  assert.equal(history.n,1);
  assert.equal(history.version,1);
 });
 await t.test("matching idempotency key returns same release; altered key payload conflicts",async()=>{
  assert.equal((await db.query(call,args(primary.planId,primary.review,primary.source,key))).rows[0].id,release);
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source,key,1,release)),has("PT409","VOICE_PLAN_REQUEST_CONFLICT"));
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source)),has("PT409","VOICE_PLAN_POINTER_CONFLICT"));
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source,randomUUID(),1,release)),has("PT409","VOICE_PLAN_ALREADY_RELEASED"));
 });
 await t.test("client roles cannot execute private release or freshness functions",async()=>{
  await db.query("set role authenticated");
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source)),e=>e.code==="42501");
  await assert.rejects(db.query("select private.sc012b_effective_release($1)",[primary.application.id]),e=>e.code==="42501");
  await assert.rejects(db.query("select private.sc012b_recompute_release_source($1,$2,$3,$4,$5,$6,$7)",[primary.companyId,primary.application.id,primary.analysis_id,primary.reviewId,primary.shortlist,template,envelopeHash]),e=>e.code==="42501");
  await db.query("reset role");
  await actor(users.owner);
 });
 await t.test("effective release rechecks template and stale source without dropping the pointer",async()=>{
  assert.equal((await db.query("select private.sc012b_effective_release($1) as id",[primary.application.id])).rows[0].id,release);
  await actor(users.otherOwner);
  await assert.rejects(db.query("select private.sc012b_effective_release($1)",[primary.application.id]),e=>e.code==="42501");
  await actor(users.owner);
  await db.query("update private.voice_plan_template_catalog set enabled=false, withdrawn_at=now() where template_version=$1",[template]);
  try{
   await assert.rejects(db.query("select private.sc012b_effective_release($1)",[primary.application.id]),has("PT409","VOICE_PLAN_TEMPLATE_STALE"));
   const stale=await db.query("select stale_at from public.screening_analysis_versions where id=$1",[primary.analysis_id]);
   assert.equal(stale.rows[0].stale_at,null);
  }finally{
   await db.query("update private.voice_plan_template_catalog set enabled=true, withdrawn_at=null where template_version=$1",[template]);
  }
  assert.equal((await db.query("select private.sc012b_effective_release($1) as id",[primary.application.id])).rows[0].id,release);
  await db.query("update public.screening_analysis_versions set stale_at=now(), stale_reason='manual_invalidation' where id=$1",[primary.analysis_id]);
  assert.equal((await db.query(call,args(primary.planId,primary.review,primary.source,key))).rows[0].id,release);
  await assert.rejects(db.query(call,args(primary.planId,primary.review,primary.source)),has("PT409","VOICE_PLAN_SOURCE_STALE"));
  await assert.rejects(db.query("select private.sc012b_effective_release($1)",[primary.application.id]),has("PT409","VOICE_PLAN_SOURCE_STALE"));
  const pointer=(await db.query("select release_entry_id from private.voice_plan_current_releases where application_id=$1",[primary.application.id])).rows[0];
  assert.equal(pointer.release_entry_id,release);
  await db.query([
   "insert into private.voice_plan_review_entries",
   "(company_id,application_id,plan_id,review_version,reviewer_id,decision,reason,source_hash,",
   "retention_policy_version,retention_deadline)",
   "values($1,$2,$3,2,$4,'requires_changes','source no longer current',$5,'synthetic-v1','2030-01-01')"
  ].join(" "),[primary.companyId,primary.application.id,primary.planId,users.owner,primary.source]);
  await assert.rejects(db.query("select private.sc012b_effective_release($1)",[primary.application.id]),has("PT409","VOICE_PLAN_REVIEW_STALE"));
  assert.equal((await db.query(call,args(primary.planId,primary.review,primary.source,key))).rows[0].id,release);
 });
 await t.test("expired plan or review retention is not promoted",async()=>{
  const expired=await freshApproved("2000-01-01");
  await actor(users.owner);
  await assert.rejects(db.query(call,args(expired.planId,expired.review,expired.source)),has("PT409","VOICE_PLAN_RETENTION_EXPIRED"));
  const mixed=await freshApproved("2030-01-01","2000-01-01");
  await actor(users.owner);
  await assert.rejects(db.query(call,args(mixed.planId,mixed.review,mixed.source)),has("PT409","VOICE_PLAN_RETENTION_EXPIRED"));
 });
 await t.test("stored hash is recomputed from live position state even if stale_at was cleared",async()=>{
  const drift=await freshApproved();
  await db.query("update public.positions set title='Analyst II' where id=$1",[drift.position.id]);
  await db.query("update public.screening_analysis_versions set stale_at=null, stale_reason=null where id=$1",[drift.analysis_id]);
  await actor(users.owner);
  await assert.rejects(db.query(call,args(drift.planId,drift.review,drift.source)),has("PT409","VOICE_PLAN_STALE"));
 });
 await t.test("replacement release increments release version and replays the old request",async()=>{
  const first=await freshApproved();
  const firstKey=randomUUID();
  await actor(users.owner);
  const firstRelease=(await db.query(call,args(first.planId,first.review,first.source,firstKey))).rows[0].id;
  await h.asUser(users.owner);
  await h.remove(first.shortlist);
  await h.asAdmin();
  await db.query("update public.positions set title='Analyst II' where id=$1",[first.position.id]);
  const next=await h.completedApplication(first,Array(5).fill("meets"));
  await h.asUser(users.owner);
  const shortlist=await h.add(next);
  await h.asAdmin();
  const successor=await insertPlan(next,shortlist,{version:2,supersedes:first.planId,corrects:first.review});
  const successorReview=await insertReview(next,successor.id,successor.source_hash);
  await actor(users.owner);
  assert.equal((await db.query(call,args(first.planId,first.review,first.source,firstKey))).rows[0].id,firstRelease);
  await assert.rejects(db.query(call,args(first.planId,first.review,first.source)),has("PT409","VOICE_PLAN_SUPERSEDED"));
  const second=(await db.query(call,args(successor.id,successorReview,successor.source_hash,randomUUID(),1,firstRelease))).rows[0].id;
  const versions=await db.query("select plan_id, release_version::int as version from private.voice_plan_release_entries where application_id=$1 order by release_version",[first.application.id]);
  assert.deepEqual(versions.rows,[{plan_id:first.planId,version:1},{plan_id:successor.id,version:2}]);
  const pointer=(await db.query("select plan_id, release_entry_id, pointer_version::int as version from private.voice_plan_current_releases where application_id=$1",[first.application.id])).rows[0];
  assert.equal(pointer.plan_id,successor.id);
  assert.equal(pointer.release_entry_id,second);
  assert.equal(pointer.version,2);
  assert.equal((await db.query("select private.sc012b_effective_release($1) as id",[first.application.id])).rows[0].id,second);
 });
 await t.test("two concurrent first releases of an unreleased plan produce one pointer",async()=>{
  const open=await freshApproved();
  const a=await connect(),b=await connect();
  for(const c of [a,b])await c.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const results=await Promise.allSettled([
   a.query(call,args(open.planId,open.review,open.source)),
   b.query(call,args(open.planId,open.review,open.source))
  ]);
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
  assert.ok(results.some(x=>x.status==="rejected"&&x.reason.code==="PT409"));
  const count=(await db.query("select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",[open.application.id])).rows[0].n;
  assert.equal(count,1);
 });
 await t.test("recruiter revocation either blocks the release or waits behind its membership lock",async()=>{
  const waiting=await freshApproved();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",[waiting.companyId,users.recruiter]);
  await db.query("update public.company_members set role='viewer' where company_id=$1 and user_id=$2",[waiting.companyId,users.recruiter]);
  await actor(users.recruiter);
  await assert.rejects(db.query(call,args(waiting.planId,waiting.review,waiting.source)),e=>e.code==="42501");
  await db.query("update public.company_members set role='recruiter' where company_id=$1 and user_id=$2",[waiting.companyId,users.recruiter]);
  const holder=await connect(),revoker=await connect();
  await holder.query("begin");
  await holder.query("select set_config('request.jwt.claim.sub',$1,false)",[users.recruiter]);
  const held=await holder.query(call,args(waiting.planId,waiting.review,waiting.source));
  await revoker.query("set lock_timeout='2s'");
  await assert.rejects(revoker.query("delete from public.company_members where company_id=$1 and user_id=$2",[waiting.companyId,users.recruiter]),e=>e.code==="55P03");
  await holder.query("commit");
  const removed=await revoker.query("delete from public.company_members where company_id=$1 and user_id=$2 returning user_id",[waiting.companyId,users.recruiter]);
  assert.equal(removed.rowCount,1);
  assert.equal((await db.query("select released_by from private.voice_plan_release_entries where id=$1",[held.rows[0].id])).rows[0].released_by,users.recruiter);

  const blocked=await freshApproved();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",[blocked.companyId,users.recruiter]);
  const locker=await connect(),racer=await connect();
  await locker.query("begin");
  await locker.query("select role from public.company_members where company_id=$1 and user_id=$2 for update",[blocked.companyId,users.recruiter]);
  await racer.query("set lock_timeout='8s'");
  await racer.query("select set_config('request.jwt.claim.sub',$1,false)",[users.recruiter]);
  const started=Date.now();
  await assert.rejects(racer.query(call,args(blocked.planId,blocked.review,blocked.source)),has("PT409","VOICE_PLAN_CONFLICT"));
  assert.ok(Date.now()-started<1500,"membership NOWAIT must fail before lock_timeout");
  await locker.query("delete from public.company_members where company_id=$1 and user_id=$2",[blocked.companyId,users.recruiter]);
  await locker.query("commit");
  await assert.rejects(racer.query(call,args(blocked.planId,blocked.review,blocked.source)),e=>e.code==="42501");
 });
});
