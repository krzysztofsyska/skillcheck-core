import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";
import {behaviorGuideDefinitions} from "../lib/behavior-guide.ts";
import {canonicalVoiceSourceSnapshot} from "../lib/voice/plan-persistence-contract.ts";
import {trustedVoiceTemplateDigest} from "../lib/voice/template-registry.ts";
import {
  reconstructTrustedVoiceSource,verifyStoredVoicePlan,verifyStoredVoicePlanWithinTransaction,
  rehydrateCurrentReleasedVoicePlanWithinTransaction,TrustedSourceError,
} from "../lib/voice/trusted-source-verifier.ts";
import {isAuthenticallyReleasedInterviewPlan,releasedApplicationBinding} from "../lib/voice/interview-plan.ts";
import {voiceScenarioFromApprovedPlan,scenarioApplicationBinding} from "../lib/voice/mvp-package-gate.ts";
import {atomicReviewVoicePlan,atomicReleaseVoicePlan} from "../lib/voice/atomic-plan-operations.ts";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_atomic_"+process.pid+"_"+randomUUID().replaceAll("-","").slice(0,10);
test("SC-012-B verified source and immutable review/release are atomic in one PG session",async t=>{
 assert.ok(url,"requires isolated PostgreSQL 16");
 const parsed=parse(url);
 assert.ok(["127.0.0.1","localhost","::1"].includes(parsed.host)||parsed.host?.startsWith("/tmp/"),
   "SC012 atomic tests require a loopback-only disposable PostgreSQL server");
 const config=db=>({...parsed,database:db});
 const admin=new Client(config("postgres"));await admin.connect();
 await admin.query("drop database if exists "+dbName);
 await admin.query("create database "+dbName);await admin.end();
 const db=new Client(config(dbName));await db.connect();db.exec=s=>db.query(s);
 let observer;
 t.after(async()=>{
  if(observer)await observer.end().catch(()=>{});
  await db.end().catch(()=>{});
  const c=new Client(config("postgres"));await c.connect();
  await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",[dbName]);
  await c.query("drop database if exists "+dbName);await c.end();
 });
 const h=await setupRankingDatabase(db);
 for(const path of [
   "../db/prototypes/sc012b-plan-schema.sql",
   "../db/isolated/sc012b-template-catalog.sql",
   "../db/isolated/sc012b-review-rpc.sql",
   "../db/isolated/sc012b-release-rpc.sql",
 ]) await db.exec(await readFile(new URL(path,import.meta.url),"utf8"));
 await db.query(
  "insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)",
  ["skillcheck-voice-plan-v1",trustedVoiceTemplateDigest("skillcheck-voice-plan-v1")]);
 const seed=await h.seed(users.owner,randomUUID(),5);
 await h.asUser(users.owner);
 await db.query("update public.positions set required_behaviors=$1 where id=$2",
   [behaviorGuideDefinitions.map((x,i)=>x.label+": "+(i<4?"Wysoki":"Standardowy")),seed.position.id]);
 const f=await h.completedApplication(seed,["insufficient_data","meets","below","meets","above"]);
 await h.asUser(users.owner);
 const shortlist=await h.add(f);
 await h.asAdmin();
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
 const selector={companyId:f.companyId,applicationId:f.application.id,
   analysisId:f.analysis_id,reviewId:f.reviewId,shortlistEntryId:shortlist};
 const canonical=await reconstructTrustedVoiceSource(db,selector);
 const persistPlan=async(subject,shortlistId,source,deadline="2030-01-01T00:00:00Z")=>(await db.query([
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
  "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
  "template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,",
  "'skillcheck-voice-plan-v1',$12,'synthetic-v1',$13::timestamptz) returning id"
 ].join(" "),[subject.companyId,subject.recruitment.id,subject.application.id,subject.position.id,
  subject.analysis_id,subject.reviewId,shortlistId,source.sourceHash,source.planContractHash,
  JSON.stringify(canonicalVoiceSourceSnapshot(source.sourceBinding,source.planSourceFingerprint)),
  JSON.stringify(source),users.owner,deadline])).rows[0].id;
 const plan=await persistPlan(f,shortlist,canonical);
 observer=new Client(config(dbName));await observer.connect();
 await observer.query("set lock_timeout='100ms'");
 await db.query("create table public.sc012b_atomic_tx_markers(id uuid primary key)");
 const markerCount=async(client,ids)=>(await client.query(
   "select count(*)::int as n from public.sc012b_atomic_tx_markers where id=any($1::uuid[])",[ids])).rows[0].n;
 const rejectCallerOwned=async(name,run)=>{
  for(const isolation of ["read committed","repeatable read"])
   await t.test(name+" preserves a caller's "+isolation+" transaction",async()=>{
    for(const finish of ["rollback","commit"]){
     const ids=[randomUUID(),randomUUID()];
     await db.query("begin isolation level "+isolation);
     try{
      await db.query("insert into public.sc012b_atomic_tx_markers values($1)",[ids[0]]);
      await db.query("savepoint sc012b_atomic_idle_probe");
      await assert.rejects(run(),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_CONNECTION_NOT_IDLE");
      assert.equal((await db.query("show transaction_isolation")).rows[0].transaction_isolation,isolation);
      assert.equal(await markerCount(db,ids),1,"the caller's prior write remains pending");
      await db.query("rollback to savepoint sc012b_atomic_idle_probe");
      await db.query("release savepoint sc012b_atomic_idle_probe");
      await db.query("insert into public.sc012b_atomic_tx_markers values($1)",[ids[1]]);
      assert.equal(await markerCount(db,ids),2,"caller can continue after rejection");
      assert.equal(await markerCount(observer,ids),0,"helper did not commit either caller write");
      await db.query(finish);
      assert.equal(await markerCount(observer,ids),finish==="commit"?2:0,
        "the caller alone chooses to commit or roll back");
     }finally{
      await db.query("rollback");
      await db.query("delete from public.sc012b_atomic_tx_markers where id=any($1::uuid[])",[ids]);
     }
    }
    await db.query("begin isolation level "+isolation);
    try{
     assert.equal((await db.query("select txid_current_if_assigned() as xid")).rows[0].xid,null);
     await assert.rejects(run(),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_CONNECTION_NOT_IDLE");
     await db.query("savepoint caller_still_active");
     await db.query("release savepoint caller_still_active");
     assert.equal((await db.query("show transaction_isolation")).rows[0].transaction_isolation,isolation);
    }finally{await db.query("rollback");}
    const id=randomUUID();
    await db.query("begin isolation level "+isolation);
    try{
     await db.query("insert into public.sc012b_atomic_tx_markers values($1)",[id]);
     await db.query("savepoint caller_recovery");
     await assert.rejects(db.query("select 1/0"),e=>e.code==="22012");
     await assert.rejects(run(),e=>e.code==="25P02");
     await assert.rejects(db.query("select 1"),e=>e.code==="25P02",
       "an already failed caller transaction must stay failed");
     await db.query("rollback to savepoint caller_recovery");
     assert.equal(await markerCount(db,[id]),1,"the caller can still recover its own savepoint");
     assert.equal(await markerCount(observer,[id]),0);
    }finally{await db.query("rollback");}
    assert.equal(await markerCount(observer,[id]),0);
   });
 };
 const completeWithRestorePinned=async run=>{
  let commits=0;
  const beforeCommit={query:async(sql,params)=>{
   if(sql==="commit"){
    commits++;
    await assert.rejects(observer.query(
      "update private.erasure_execution_config set restore_isolated=true where singleton"),
      e=>e.code==="55P03","restore cannot change after the atomic RPC but before COMMIT");
   }
   return db.query(sql,params);
  }};
  const result=await run(beforeCommit);
  assert.equal(commits,1);
  await observer.query("begin");
  try{
   await observer.query("update private.erasure_execution_config set restore_isolated=true where singleton");
  }finally{await observer.query("rollback");}
  return result;
 };
 const reviewArgs={planId:plan,sourceHash:canonical.sourceHash,
   expectedReviewVersion:0,decision:"approved",reason:null,requestKey:randomUUID()};
 await rejectCallerOwned("a valid new review",()=>atomicReviewVoicePlan(db,reviewArgs));
 assert.equal((await db.query(
   "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n,0);
 let review;
 await t.test("a new atomic review pins restore configuration through COMMIT",async()=>{
  review=await completeWithRestorePinned(client=>atomicReviewVoicePlan(client,reviewArgs));
 });
 assert.match(review,/^[a-f0-9-]{36}$/);
 await t.test("a committed review replay also pins restore configuration through COMMIT",async()=>{
  assert.equal(await completeWithRestorePinned(client=>atomicReviewVoicePlan(client,reviewArgs)),review);
 });
 const releaseArgs={planId:plan,sourceHash:canonical.sourceHash,approvedReviewId:review,
   expectedPointerVersion:null,expectedReleaseId:null,requestKey:randomUUID()};
 await rejectCallerOwned("a valid new release",()=>atomicReleaseVoicePlan(db,releaseArgs));
 assert.equal((await db.query(
   "select count(*)::int as n from private.voice_plan_release_entries where plan_id=$1",[plan])).rows[0].n,0);
 let release;
 await t.test("a new atomic release pins restore configuration through COMMIT",async()=>{
  release=await completeWithRestorePinned(client=>atomicReleaseVoicePlan(client,releaseArgs));
 });
 await t.test("a committed release replay also pins restore configuration through COMMIT",async()=>{
  assert.equal(await completeWithRestorePinned(client=>atomicReleaseVoicePlan(client,releaseArgs)),release);
 });
 await rejectCallerOwned("a committed review replay",()=>atomicReviewVoicePlan(db,reviewArgs));
 await rejectCallerOwned("a committed release replay",()=>atomicReleaseVoicePlan(db,releaseArgs));
 await rejectCallerOwned("a mismatched review source",()=>atomicReviewVoicePlan(db,{
   ...reviewArgs,sourceHash:"f".repeat(64),requestKey:randomUUID(),
 }));
 await rejectCallerOwned("a missing release plan",()=>atomicReleaseVoicePlan(db,{
   ...releaseArgs,planId:randomUUID(),requestKey:randomUUID(),
 }));
 await t.test("idle connections with a repeatable-read default can recover both committed operations",async()=>{
  await db.query("set default_transaction_isolation='repeatable read'");
  try{
   assert.equal(await atomicReviewVoicePlan(db,reviewArgs),review);
   assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
   assert.equal((await db.query("show default_transaction_isolation")).rows[0].default_transaction_isolation,
     "repeatable read");
  }finally{await db.query("reset default_transaction_isolation");}
 });
 const current=(await db.query(
  "select release_entry_id,pointer_version from private.voice_plan_current_releases where application_id=$1",
  [f.application.id])).rows[0];
 assert.equal(current.release_entry_id,release);
 assert.equal(Number(current.pointer_version),1);
 const visible=(await db.query(
  "select private.sc012b_current_release($1) as id",[f.application.id])).rows[0].id;
 assert.equal(visible,release);
 const rehydrateArgs={companyId:f.companyId,applicationId:f.application.id,
   expectedPlanId:plan,expectedReleaseId:release,expectedPointerVersion:1};
 const withRollback=async work=>{
   await db.query("begin");
   try{return await work();}finally{await db.query("rollback");}
 };
 const freshPlan=async(retentionSeconds=3600)=>{
  const subject=await h.completedApplication(await h.candidate(f),
    ["insufficient_data","meets","below","meets","above"]);
  await h.asUser(users.owner);
  const shortlistId=await h.add(subject);
  await h.asAdmin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const selection={companyId:subject.companyId,applicationId:subject.application.id,
    analysisId:subject.analysis_id,reviewId:subject.reviewId,shortlistEntryId:shortlistId};
  const source=await reconstructTrustedVoiceSource(db,selection);
  const deadline=(await db.query(
    "select clock_timestamp()+$1::double precision*interval '1 second' as deadline",
    [retentionSeconds])).rows[0].deadline;
  const id=await persistPlan(subject,shortlistId,source,deadline);
  return {subject,selection,source,plan:id,deadline,reviewArgs:{planId:id,sourceHash:source.sourceHash,
    expectedReviewVersion:0,decision:"approved",reason:null,requestKey:randomUUID()}};
 };
 const releaseInput=(s,reviewId)=>({planId:s.plan,sourceHash:s.source.sourceHash,approvedReviewId:reviewId,
   expectedPointerVersion:null,expectedReleaseId:null,requestKey:randomUUID()});
 const directReview=input=>db.query("select private.sc012b_review_plan($1,$2,$3,$4,$5,$6) as id",
   [input.planId,input.expectedReviewVersion,input.sourceHash,input.decision,input.reason,input.requestKey]);
 const directRelease=input=>db.query("select private.sc012b_release_plan($1,$2,$3,$4,$5,$6) as id",
   [input.planId,input.approvedReviewId,input.sourceHash,input.expectedPointerVersion,input.expectedReleaseId,input.requestKey]);
 const storedState=async(s,client=db)=>(await client.query([
   "select (select count(*)::int from public.voice_plan_versions where application_id=$1) as plans,",
   "(select count(*)::int from private.voice_plan_review_entries where plan_id=$2) as reviews,",
   "(select count(*)::int from private.voice_plan_release_entries where plan_id=$2) as releases,",
   "(select count(*)::int from private.voice_plan_request_keys where company_id=$3) as request_keys,",
   "(select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) from private.voice_plan_current_releases p",
   "where p.application_id=$1) as pointers",
 ].join(" "),[s.subject.application.id,s.plan,s.subject.companyId])).rows[0];
 const waitPast=async deadline=>observer.query(
   "select pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.05)",[deadline]);
 const shortApproval=async(s,seconds)=>(await db.query([
   "insert into private.voice_plan_review_entries",
   "(company_id,application_id,plan_id,review_version,reviewer_id,decision,source_hash,retention_policy_version,retention_deadline)",
   "select company_id,application_id,id,1,$2,'approved',source_hash,retention_policy_version,",
   "clock_timestamp()+$3::double precision*interval '1 second'",
   "from public.voice_plan_versions where id=$1 returning id,retention_deadline",
 ].join(" "),[s.plan,users.owner,seconds])).rows[0];
 await t.test("expired plans reject verification and new writes while historical replay only returns IDs",async()=>{
  const s=await freshPlan(5),approved=await atomicReviewVoicePlan(db,s.reviewArgs);
  const expiredRelease=releaseInput(s,approved);
  const historical=await freshPlan(5),historicalReview=await atomicReviewVoicePlan(db,historical.reviewArgs);
  const historicalReleaseArgs=releaseInput(historical,historicalReview);
  const historicalRelease=await atomicReleaseVoicePlan(db,historicalReleaseArgs);
  await db.query("delete from private.voice_plan_current_releases where application_id=$1",
    [historical.subject.application.id]);
  await waitPast(historical.deadline);
  const before=await storedState(s),historyBefore=await storedState(historical);
  assert.equal(before.reviews,1);assert.equal(before.releases,0);assert.deepEqual(before.pointers,[]);
  assert.equal(historyBefore.releases,1);assert.deepEqual(historyBefore.pointers,[]);
  assert.equal((await reconstructTrustedVoiceSource(db,s.selection)).sourceHash,s.source.sourceHash);
  await assert.rejects(verifyStoredVoicePlan(db,s.plan),e=>e instanceof TrustedSourceError&&e.code==="STALE");
  const nextReview={...s.reviewArgs,expectedReviewVersion:1,requestKey:randomUUID()};
  for(const run of [
    ()=>atomicReviewVoicePlan(db,nextReview),()=>atomicReleaseVoicePlan(db,expiredRelease),
    ()=>directReview(nextReview),()=>directRelease(expiredRelease),
  ]){
   await assert.rejects(run(),e=>e.code==="PT409");
   assert.deepEqual(await storedState(s),before,"no review/release/key/pointer change after expired-plan refusal");
  }
  assert.equal(await atomicReviewVoicePlan(db,s.reviewArgs),approved);
  assert.equal(await atomicReviewVoicePlan(db,historical.reviewArgs),historicalReview);
  assert.equal(await atomicReleaseVoicePlan(db,historicalReleaseArgs),historicalRelease);
  assert.equal((await directReview(historical.reviewArgs)).rows[0].id,historicalReview);
  assert.equal((await directRelease(historicalReleaseArgs)).rows[0].id,historicalRelease);
  assert.deepEqual(await storedState(s),before);
  assert.deepEqual(await storedState(historical),historyBefore,
    "an expired historical replay cannot republish the removed pointer or append history");
 });
 await t.test("a hired completed application denies new review/release authority and preserves history",async()=>{
  const s=await freshPlan(),approved=await atomicReviewVoicePlan(db,s.reviewArgs);
  const releaseArgs=releaseInput(s,approved);
  await db.query("update public.applications set status='hired' where id=$1",[s.subject.application.id]);
  const state=(await db.query(
    "select ap.status,a.execution_status from public.applications ap join public.screening_analysis_versions a on a.application_id=ap.id where a.id=$1",
    [s.subject.analysis_id])).rows[0];
  assert.deepEqual(state,{status:"hired",execution_status:"completed"});
  const before=await storedState(s);
  assert.equal(before.reviews,1);assert.equal(before.releases,0);assert.deepEqual(before.pointers,[]);
  await assert.rejects(reconstructTrustedVoiceSource(db,s.selection),e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await assert.rejects(verifyStoredVoicePlan(db,s.plan),e=>e instanceof TrustedSourceError&&e.code==="STALE");
  const nextReview={...s.reviewArgs,expectedReviewVersion:1,requestKey:randomUUID()};
  for(const run of [
    ()=>atomicReviewVoicePlan(db,nextReview),()=>atomicReleaseVoicePlan(db,releaseArgs),
    ()=>directReview(nextReview),()=>directRelease(releaseArgs),
  ]){
   await assert.rejects(run(),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_SOURCE_STALE");
   assert.deepEqual(await storedState(s),before);
  }
  assert.equal(await atomicReviewVoicePlan(db,s.reviewArgs),approved);
  assert.equal((await directReview(s.reviewArgs)).rows[0].id,approved);
  assert.deepEqual(await storedState(s),before);
 });
 await t.test("an unexpired plan cannot release through an expired exact human approval",async()=>{
  const s=await freshPlan();
  // Independent retention on immutable historical approval is an input the
  // release RPC must check even while the plan's own deadline remains valid.
  const approval=await shortApproval(s,1);
  await waitPast(approval.retention_deadline);
  assert.equal((await verifyStoredVoicePlan(db,s.plan)).sourceHash,s.source.sourceHash);
  const before=await storedState(s),args=releaseInput(s,approval.id);
  for(const run of [()=>atomicReleaseVoicePlan(db,args),()=>directRelease(args)]){
   await assert.rejects(run(),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_REVIEW_STALE");
   assert.deepEqual(await storedState(s),before);
  }
 });
 for(const operation of ["review","release"])await t.test(
   operation+" rejects a plan expiring after successful JS verification and before its RPC",async()=>{
    const s=await freshPlan(5);
    const args=operation==="review"?s.reviewArgs:releaseInput(s,await atomicReviewVoicePlan(db,s.reviewArgs));
    const before=await storedState(s);
    let reachedRpc=0;
    const delayed={query:async(sql,params)=>{
     if(sql.startsWith("select private.sc012b_"+operation+"_plan(")){
      reachedRpc++;
      assert.equal((await db.query(
        "select retention_deadline>clock_timestamp() as valid from public.voice_plan_versions where id=$1",
        [s.plan])).rows[0].valid,true,"JS verification completed while the plan was valid");
      await waitPast(s.deadline);
      const clock=(await db.query([
        "select retention_deadline<=clock_timestamp() as expired,retention_deadline>now() as valid_at_begin",
        "from public.voice_plan_versions where id=$1",
      ].join(" "),[s.plan])).rows[0];
      assert.deepEqual(clock,{expired:true,valid_at_begin:true},"transaction time must not authorize an expired write");
     }
     return db.query(sql,params);
    }};
    await assert.rejects(operation==="review"?atomicReviewVoicePlan(delayed,args):atomicReleaseVoicePlan(delayed,args),
      e=>e.code==="PT409"&&e.message==="VOICE_PLAN_STALE");
    assert.equal(reachedRpc,1,"the real isolated RPC handled the expired authority");
    assert.deepEqual(await storedState(s),before,"delayed expiry leaves no history, key or pointer mutation");
   });
 for(const [operation,expiring] of [["review","plan"],["release","plan"],["release","approval"]])
  await t.test(operation+" rolls back a successful RPC when "+expiring+" expires only before COMMIT",async()=>{
   const s=await freshPlan(expiring==="plan"?5:3600);
   let deadline=s.deadline,approved;
   if(operation==="release"){
    if(expiring==="approval"){
     const approval=await shortApproval(s,5);
     approved=approval.id;deadline=approval.retention_deadline;
    }else approved=await atomicReviewVoicePlan(db,s.reviewArgs);
   }
   const args=operation==="review"?s.reviewArgs:releaseInput(s,approved);
   const before=await storedState(s);
   let rpcId,commitAttempts=0;
   const delayed={query:async(sql,params)=>{
    if(sql==="commit"){
     commitAttempts++;
     assert.match(rpcId,/^[a-f0-9-]{36}$/,"the real RPC completed successfully before the pause");
     const pending=await storedState(s);
     assert.equal(pending.reviews,before.reviews+(operation==="review"?1:0));
     assert.equal(pending.releases,before.releases+(operation==="release"?1:0));
     assert.equal(pending.request_keys,before.request_keys+1);
     if(operation==="release"){
      assert.equal(pending.pointers.length,1);
      assert.equal(pending.pointers[0].release_entry_id,rpcId);
     }else assert.deepEqual(pending.pointers,before.pointers);
     assert.deepEqual(await storedState(s,observer),before,"the successful RPC is still uncommitted");
     assert.equal((await db.query("select $1::timestamptz>clock_timestamp() as valid",[deadline])).rows[0].valid,true);
     await waitPast(deadline);
     const clock=(await db.query(
       "select $1::timestamptz<=clock_timestamp() as expired,$1::timestamptz>now() as valid_at_begin",
       [deadline])).rows[0];
     assert.deepEqual(clock,{expired:true,valid_at_begin:true});
    }
    const result=await db.query(sql,params);
    if(sql.startsWith("select private.sc012b_"+operation+"_plan("))rpcId=result.rows[0].id;
    return result;
   }};
   await assert.rejects(operation==="review"?atomicReviewVoicePlan(delayed,args):atomicReleaseVoicePlan(delayed,args),
     e=>e.code==="PT409"&&e.message==="VOICE_PLAN_STALE_AT_COMMIT");
   assert.equal(commitAttempts,1,"the rejection came from the deferred guard inside COMMIT");
   assert.deepEqual(await storedState(s),before,"COMMIT failure rolls back history, request key and pointer together");
   assert.deepEqual(await storedState(s,observer),before);
  });
 await t.test("WithinTransaction APIs preserve caller work and restore locks across a failed check",async()=>{
  const id=randomUUID();
  await withRollback(async()=>{
   await db.query("insert into public.sc012b_atomic_tx_markers values($1)",[id]);
   assert.equal((await verifyStoredVoicePlanWithinTransaction(db,plan)).sourceHash,canonical.sourceHash);
   assert.ok(isAuthenticallyReleasedInterviewPlan(
     (await rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs)).releasedPlan));
   await assert.rejects(rehydrateCurrentReleasedVoicePlanWithinTransaction(db,{
     ...rehydrateArgs,expectedPointerVersion:2,
   }),e=>e instanceof TrustedSourceError&&e.code==="STALE");
   assert.equal(await markerCount(db,[id]),1);
   assert.equal(await markerCount(observer,[id]),0);
   await assert.rejects(observer.query(
     "update private.erasure_execution_config set restore_isolated=true where singleton"),
     e=>e.code==="55P03","successful source locks survive rollback of a later failed check");
  });
  assert.equal(await markerCount(observer,[id]),0);
 });
 await t.test("restore updater wins first: atomic replays and WithinTransaction checks reject",async()=>{
  try{
   await observer.query("begin");
   await observer.query("update private.erasure_execution_config set restore_isolated=true where singleton");
   for(const run of [
     ()=>atomicReviewVoicePlan(db,reviewArgs),()=>atomicReleaseVoicePlan(db,releaseArgs),
   ])await assert.rejects(run(),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_CONFLICT");
   await withRollback(async()=>{
    for(const run of [
      ()=>verifyStoredVoicePlanWithinTransaction(db,plan),
      ()=>rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs),
    ])await assert.rejects(run(),e=>e instanceof TrustedSourceError&&e.code==="CONFLICT");
   });
   await observer.query("commit");
   for(const run of [
     ()=>atomicReviewVoicePlan(db,reviewArgs),()=>atomicReleaseVoicePlan(db,releaseArgs),
   ])await assert.rejects(run(),e=>e.code==="PT409"&&e.message==="Restore isolation required");
   await withRollback(async()=>{
    for(const run of [
      ()=>verifyStoredVoicePlanWithinTransaction(db,plan),
      ()=>rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs),
    ])await assert.rejects(run(),e=>e.code==="PT409"&&e.message==="Restore isolation required");
   });
  }finally{
   await observer.query("rollback");
   await observer.query("update private.erasure_execution_config set restore_isolated=false where singleton");
  }
  assert.equal(await atomicReviewVoicePlan(db,reviewArgs),review);
  assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
 });
 await db.query("drop table public.sc012b_atomic_tx_markers");
 await t.test("rehydration requires an existing transaction and rejects caller extra authority",async()=>{
   await assert.rejects(rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs),
     e=>e instanceof TrustedSourceError&&e.code==="INVALID");
   await assert.rejects(rehydrateCurrentReleasedVoicePlanWithinTransaction(db,{
     ...rehydrateArgs,released:true,
   }),e=>e instanceof TrustedSourceError&&e.code==="INVALID");
 });
 await t.test("locked current release rebuilds the existing genuine plan and scenario brands",async()=>{
   await withRollback(async()=>{
     const result=await rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs);
     assert.equal(result.planId,plan);
     assert.equal(result.releaseId,release);
     assert.equal(result.pointerVersion,1);
     assert.equal(result.sourceHash,canonical.sourceHash);
     assert.ok(isAuthenticallyReleasedInterviewPlan(result.releasedPlan));
     assert.equal(isAuthenticallyReleasedInterviewPlan(structuredClone(result.releasedPlan)),false);
     const binding={companyId:f.companyId,applicationId:f.application.id,
       sourceFingerprint:canonical.planSourceFingerprint};
     assert.deepEqual(releasedApplicationBinding(result.releasedPlan),binding);
     const scenario=voiceScenarioFromApprovedPlan(result.releasedPlan);
     assert.deepEqual(scenarioApplicationBinding(scenario),binding);
     assert.deepEqual(result.releasedPlan.questions,canonical.questions);
     assert.equal(result.releasedPlan.reviewerId,users.owner);
     assert.equal(result.releasedPlan.releasedBy,users.owner);
     assert.ok(!JSON.stringify(scenario).includes(f.application.id));
     assert.ok(!JSON.stringify(scenario).includes("PRIVATE original CV"));
   });
 });
 await t.test("plan, release and pointer CAS each reject stale expectations",async()=>{
   for(const changed of [
     {expectedPlanId:randomUUID()},
     {expectedReleaseId:randomUUID()},
     {expectedPointerVersion:2},
   ])await withRollback(async()=>{
     await assert.rejects(rehydrateCurrentReleasedVoicePlanWithinTransaction(db,{
       ...rehydrateArgs,...changed,
     }),e=>e instanceof TrustedSourceError&&e.code==="STALE");
   });
 });
 await t.test("newest voice plan wins even while an older pointer and its source remain valid",async()=>{
   await withRollback(async()=>{
     await db.query([
       "insert into public.voice_plan_versions",
       "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
       "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
       "template_version,created_by,retention_policy_version,retention_deadline,supersedes_plan_id,corrects_review_id)",
       "select company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
       "shortlist_entry_id,2,$1,envelope_hash,source_snapshot,plan_envelope,",
       "template_version,created_by,retention_policy_version,retention_deadline,$2,$3",
       "from public.voice_plan_versions where id=$2",
     ].join(" "),["d".repeat(64),plan,review]);
     await assert.rejects(rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs),
       e=>e instanceof TrustedSourceError&&e.code==="STALE");
   });
 });
 await t.test("a current pointer cannot override a newer human requires-changes decision",async()=>{
   await withRollback(async()=>{
     await db.query([
       "insert into private.voice_plan_review_entries",
       "(company_id,application_id,plan_id,review_version,reviewer_id,decision,reason,source_hash,",
       "retention_policy_version,retention_deadline)",
       "values($1,$2,$3,2,$4,'requires_changes','Synthetic correction',$5,'synthetic-v1','2030-01-01')",
     ].join(" "),[f.companyId,f.application.id,plan,users.owner,canonical.sourceHash]);
     await assert.rejects(rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs),
       e=>e instanceof TrustedSourceError&&e.code==="STALE");
   });
 });
 await t.test("current-release rehydration holds candidate and pointer locks against a second session",async()=>{
   const rival=new Client(config(dbName));await rival.connect();
   try{
     await rival.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
     await withRollback(async()=>{
       await rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs);
       await assert.rejects(rival.query([
         "insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text)",
         "values($1,$2,'Synthetic new CV','Synthetic redacted revision')",
       ].join(" "),[f.companyId,f.application.candidate_id]),e=>e.code==="PT409");
       await assert.rejects(rival.query([
         "select application_id from private.voice_plan_current_releases",
         "where company_id=$1 and application_id=$2 for update nowait",
       ].join(" "),[f.companyId,f.application.id]),e=>e.code==="55P03");
       assert.ok(isAuthenticallyReleasedInterviewPlan(
         (await rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs)).releasedPlan));
     });
   }finally{await rival.end();}
 });
 await t.test("a competing document insert holding the candidate lock prevents rehydration",async()=>{
   const rival=new Client(config(dbName));await rival.connect();
   try{
     await rival.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
     await rival.query("begin");
     await rival.query([
       "insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text)",
       "values($1,$2,'Synthetic new CV','Synthetic redacted revision')",
     ].join(" "),[f.companyId,f.application.candidate_id]);
     await withRollback(async()=>{
       await assert.rejects(rehydrateCurrentReleasedVoicePlanWithinTransaction(db,rehydrateArgs),
         e=>e.code==="PT409");
     });
   }finally{await rival.query("rollback");await rival.end();}
 });
 await t.test("source and screening advisory locks remain held through a trusted transaction",async()=>{
  const rival=new Client(config(dbName));await rival.connect();
  try{
    await db.query("begin");
    const verified=await verifyStoredVoicePlanWithinTransaction(db,plan);
    assert.equal(verified.sourceHash,canonical.sourceHash);
    await rival.query("begin");
    const lock=(await rival.query(
      "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",
      ["screening:"+f.application.id])).rows[0];
    assert.equal(lock.acquired,false,"SC-006 screening writer cannot pass while verified source is locked");
    await rival.query("savepoint position_lock");
    await assert.rejects(rival.query(
      "select id from public.positions where id=$1 for update nowait",[f.position.id]),
      e=>e.code==="55P03");
    await rival.query("rollback to savepoint position_lock");
    await rival.query("savepoint candidate_lock");
    await assert.rejects(rival.query(
      "select id from public.candidates where id=$1 for update nowait",
      [f.application.candidate_id]),e=>e.code==="55P03");
    await rival.query("rollback to savepoint candidate_lock");
    await assert.rejects(rival.query(
      "select owner_id from public.companies where id=$1 for update nowait",[f.companyId]),
      e=>e.code==="55P03");
    await rival.query("rollback");
    await db.query("rollback");
  }finally{
    await db.query("rollback").catch(()=>{});
    await rival.query("rollback").catch(()=>{});
    await rival.end();
  }
 });
 await t.test("mismatched caller source is rejected before any immutable review write",async()=>{
  const before=(await db.query(
   "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n;
  await assert.rejects(atomicReviewVoicePlan(db,{...reviewArgs,sourceHash:"f".repeat(64),requestKey:randomUUID()}),
   e=>e.code==="PT409");
  const after=(await db.query(
   "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(after,before);
 });
 await t.test("concurrent position update yields PT409 and no partial history",async()=>{
  const rival=new Client(config(dbName));await rival.connect();
  try{
    await rival.query("begin");
    await rival.query("select id from public.positions where id=$1 for update",[f.position.id]);
    const before=(await db.query(
      "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",
      [plan])).rows[0].n;
    await assert.rejects(atomicReviewVoicePlan(db,{
      ...reviewArgs,requestKey:randomUUID(),
    }),e=>e.code==="PT409");
    const after=(await db.query(
      "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",
      [plan])).rows[0].n;
    assert.equal(after,before);
  }finally{
    await rival.query("rollback").catch(()=>{});
    await rival.end();
  }
 });
 await t.test("screening reanalysis advisory lock contention is a stable PT409",async()=>{
  const rival=new Client(config(dbName));await rival.connect();
  try{
    await rival.query("begin");
    await rival.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
      ["screening:"+f.application.id]);
    await db.query("set lock_timeout='250ms'");
    await assert.rejects(atomicReviewVoicePlan(db,{
      ...reviewArgs,requestKey:randomUUID(),
    }),e=>e.code==="PT409");
  }finally{
    await db.query("set lock_timeout='0'").catch(()=>{});
    await rival.query("rollback").catch(()=>{});
    await rival.end();
  }
 });
 await t.test("recruiter revocation races: authorization locks and fails closed",async()=>{
  const recruiter=users.recruiter;
  await db.query(
    "insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",
    [f.companyId,recruiter]);
  const reviewer=new Client(config(dbName));
  const revoker=new Client(config(dbName));
  await reviewer.connect();await revoker.connect();
  try{
    await reviewer.query("select set_config('request.jwt.claim.sub',$1,false)",[recruiter]);
    // An authorized in-flight transaction holds membership FOR SHARE.
    await reviewer.query("begin");
    await verifyStoredVoicePlanWithinTransaction(reviewer,plan);
    await revoker.query("begin");
    await revoker.query("savepoint revocation_attempt");
    await assert.rejects(revoker.query(
      "select user_id from public.company_members where company_id=$1 and user_id=$2 for update nowait",
      [f.companyId,recruiter]),e=>e.code==="55P03");
    await revoker.query("rollback to savepoint revocation_attempt");
    await revoker.query("rollback");
    await reviewer.query("rollback");
    // Revocation wins first: a concurrent review sees a lock conflict.
    await revoker.query("begin");
    await revoker.query(
      "delete from public.company_members where company_id=$1 and user_id=$2",
      [f.companyId,recruiter]);
    await assert.rejects(atomicReviewVoicePlan(reviewer,{
      ...reviewArgs,requestKey:randomUUID(),
    }),e=>e.code==="PT409");
    await revoker.query("commit");
    await assert.rejects(atomicReviewVoicePlan(reviewer,{
      ...reviewArgs,requestKey:randomUUID(),
    }),e=>e.code==="42501"||/VOICE_TRUSTED_SOURCE_FORBIDDEN/.test(e.message));
  }finally{
    await reviewer.query("rollback").catch(()=>{});
    await revoker.query("rollback").catch(()=>{});
    await reviewer.end();await revoker.end();
  }
 });
 await t.test("two real sessions compete for the first release pointer: exactly one wins",async()=>{
  const other=await h.completedApplication(await h.candidate(f),
    ["insufficient_data","meets","below","meets","above"]);
  await h.asUser(users.owner);
  const otherShortlist=await h.add(other);
  await h.asAdmin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const currentSource=await reconstructTrustedVoiceSource(db,{
    companyId:other.companyId,applicationId:other.application.id,
    analysisId:other.analysis_id,reviewId:other.reviewId,shortlistEntryId:otherShortlist,
  });
  const secondPlan=(await db.query([
    "insert into public.voice_plan_versions",
    "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
    "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
    "template_version,created_by,retention_policy_version,retention_deadline)",
    "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,",
    "'skillcheck-voice-plan-v1',$12,'synthetic-v1','2030-01-01') returning id",
  ].join(" "),[
    other.companyId,other.recruitment.id,other.application.id,other.position.id,
    other.analysis_id,other.reviewId,otherShortlist,currentSource.sourceHash,
    currentSource.planContractHash,
    JSON.stringify(canonicalVoiceSourceSnapshot(currentSource.sourceBinding,currentSource.planSourceFingerprint)),
    JSON.stringify(currentSource),users.owner,
  ])).rows[0].id;
  const secondReview=(await db.query([
    "insert into private.voice_plan_review_entries",
    "(company_id,application_id,plan_id,review_version,reviewer_id,decision,source_hash,",
    "retention_policy_version,retention_deadline)",
    "values($1,$2,$3,1,$4,'approved',$5,'synthetic-v1','2030-01-01') returning id",
  ].join(" "),[
    other.companyId,other.application.id,secondPlan,users.owner,currentSource.sourceHash,
  ])).rows[0].id;
  const a=new Client(config(dbName)),b=new Client(config(dbName));
  await a.connect();await b.connect();
  try{
    for(const client of [a,b])
      await client.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
    const base={
      planId:secondPlan,approvedReviewId:secondReview,sourceHash:currentSource.sourceHash,
      expectedPointerVersion:null,expectedReleaseId:null,
    };
    const [left,right]=await Promise.allSettled([
      atomicReleaseVoicePlan(a,{...base,requestKey:randomUUID()}),
      atomicReleaseVoicePlan(b,{...base,requestKey:randomUUID()}),
    ]);
    const successes=[left,right].filter(x=>x.status==="fulfilled");
    const conflicts=[left,right].filter(x=>x.status==="rejected"&&x.reason.code==="PT409");
    assert.equal(successes.length,1,"one and only one release must commit");
    assert.equal(conflicts.length,1,"loser must fail with PT409");
    const count=(await db.query(
      "select count(*)::int as n from private.voice_plan_release_entries where plan_id=$1",
      [secondPlan])).rows[0].n;
    assert.equal(count,1,"loser must not append history");
    const pointer=(await db.query(
      "select pointer_version from private.voice_plan_current_releases where application_id=$1",
      [other.application.id])).rows[0];
    assert.equal(Number(pointer.pointer_version),1);
    // A new CV revision invalidates the source even if a previous release
    // remains in immutable history.
    await db.query(
      "update public.candidate_documents set redacted_text=redacted_text || ' Aktualizacja CV' where id=$1",
      [other.documentId]);
    await assert.rejects(reconstructTrustedVoiceSource(db,{
      companyId:other.companyId,applicationId:other.application.id,
      analysisId:other.analysis_id,reviewId:other.reviewId,shortlistEntryId:otherShortlist,
    }),e=>/VOICE_TRUSTED_SOURCE_STALE/.test(e.message));
  }finally{await a.end();await b.end();}
 });
 await t.test("source mutation invalidates both RPCs without side effects",async()=>{
  await db.query("update public.positions set title='Modified role' where id=$1",[f.position.id]);
  await assert.rejects(atomicReviewVoicePlan(db,{...reviewArgs,requestKey:randomUUID()}),
    e=>e.code==="PT409"&&e.message==="VOICE_PLAN_SOURCE_STALE");
  await assert.rejects(atomicReleaseVoicePlan(db,{...releaseArgs,requestKey:randomUUID()}),
    e=>e.code==="PT409"&&e.message==="VOICE_PLAN_SOURCE_STALE");
  const n=(await db.query("select count(*)::int as n from private.voice_plan_release_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(n,1);
  const hidden=(await db.query(
    "select private.sc012b_current_release($1) as id",[f.application.id])).rows[0].id;
  assert.equal(hidden,null);
  const pointers=(await db.query(
    "select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",
    [f.application.id])).rows[0].n;
  assert.equal(pointers,0);
  const history=(await db.query(
    "select count(*)::int as n from private.voice_plan_release_entries where plan_id=$1",
    [plan])).rows[0].n;
  assert.equal(history,1);
 });
 await t.test("matching release request can be recovered after source revision",async()=>{
  assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
  await assert.rejects(atomicReleaseVoicePlan(db,{
    ...releaseArgs,requestKey:randomUUID(),
  }),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_SOURCE_STALE");
 });
 await t.test("committed release replay survives a newer plan superseding it",async()=>{
  const successor=(await db.query([
    "insert into public.voice_plan_versions",
    "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
    "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
    "template_version,created_by,retention_policy_version,retention_deadline,",
    "supersedes_plan_id,corrects_review_id)",
    "select company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
    "shortlist_entry_id,2,$1,envelope_hash,source_snapshot,plan_envelope,",
    "template_version,created_by,retention_policy_version,retention_deadline,$2,$3",
    "from public.voice_plan_versions where id=$2 returning id",
  ].join(" "),["c".repeat(64),plan,review])).rows[0].id;
  assert.match(successor,/^[a-f0-9-]{36}$/);
  assert.equal(await atomicReviewVoicePlan(db,reviewArgs),review);
  assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
  const directReview=await db.query(
    "select private.sc012b_review_plan($1,$2,$3,$4,$5,$6) as id",
    [plan,0,canonical.sourceHash,"approved",null,reviewArgs.requestKey]);
  assert.equal(directReview.rows[0].id,review);
  await assert.rejects(atomicReviewVoicePlan(db,{
    ...reviewArgs,decision:"requires_changes",reason:"Inna decyzja",
  }),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_REQUEST_CONFLICT");
  await assert.rejects(atomicReleaseVoicePlan(db,{
    ...releaseArgs,requestKey:randomUUID(),
  }),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_SOURCE_STALE");
 });
 await t.test("unauthorized actor cannot replay an approved operation",async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.otherOwner]);
  await assert.rejects(atomicReleaseVoicePlan(db,releaseArgs),
    e=>e.code==="42501" && e.message==="VOICE_PLAN_FORBIDDEN");
  await assert.rejects(atomicReviewVoicePlan(db,reviewArgs),
    e=>e.code==="42501" && e.message==="VOICE_PLAN_FORBIDDEN");
 });
 await t.test("a frozen candidate cannot append a review or recover a release",async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const ticket=(await db.query([
    "insert into private.erasure_preview_tickets",
    "(company_id,actor_id,anchor_candidate_id,scope_kind,candidate_ids,",
    "manifest_hash,generations,expires_at)",
    "values($1,$2,$3,'candidate_record',array[$3]::uuid[],$4,'{}'::jsonb,now())",
    "returning id",
  ].join(" "),[f.companyId,users.owner,f.application.candidate_id,"a".repeat(64)])).rows[0].id;
  const request=(await db.query([
    "insert into private.erasure_requests",
    "(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,",
    "preview_ticket_id,manifest_hash,policy_revision,resolution_revision,",
    "status,generation)",
    "values($1,$2,$3,array[$3]::uuid[],'candidate_record',$4,$5,1,1,'authorized',1)",
    "returning id",
  ].join(" "),[f.companyId,users.owner,f.application.candidate_id,ticket,"a".repeat(64)])).rows[0].id;
  await db.query([
    "insert into private.erasure_candidate_lifecycle",
    "(candidate_id,company_id,generation,status,request_id) values($1,$2,1,'frozen',$3)",
  ].join(" "),[f.application.candidate_id,f.companyId,request]);
  try{
    await assert.rejects(atomicReviewVoicePlan(db,{
      ...reviewArgs,requestKey:randomUUID(),
    }),e=>e.code==="PT409" && e.message==="Candidate workflow frozen");
    await assert.rejects(atomicReleaseVoicePlan(db,releaseArgs),
      e=>e.code==="PT409" && e.message==="Candidate workflow frozen");
    const history=(await db.query(
      "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",
      [plan])).rows[0].n;
    assert.equal(history,1);
  }finally{
    await db.query(
      "delete from private.erasure_candidate_lifecycle where candidate_id=$1",
      [f.application.candidate_id]);
  }
 });
});
