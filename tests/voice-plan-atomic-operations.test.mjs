import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";
import {behaviorGuideDefinitions} from "../lib/behavior-guide.ts";
import {trustedVoiceTemplateDigest} from "../lib/voice/template-registry.ts";
import {canonicalVoiceSourceSnapshot} from "../lib/voice/plan-persistence-contract.ts";
import {reconstructTrustedVoiceSource,verifyStoredVoicePlanWithinTransaction} from "../lib/voice/trusted-source-verifier.ts";
import {atomicReviewVoicePlan,atomicReleaseVoicePlan} from "../lib/voice/atomic-plan-operations.ts";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_atomic_"+process.pid;
test("SC-012-B verified source and immutable review/release are atomic in one PG session",async t=>{
 assert.ok(url,"requires isolated PostgreSQL 16");
 const config=db=>({...parse(url),database:db});
 const admin=new Client(config("postgres"));await admin.connect();
 await admin.query("drop database if exists "+dbName);
 await admin.query("create database "+dbName);await admin.end();
 const db=new Client(config(dbName));await db.connect();db.exec=s=>db.query(s);
 t.after(async()=>{
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
 const plan=(await db.query([
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
  "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
  "template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,",
  "'skillcheck-voice-plan-v1',$12,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.recruitment.id,f.application.id,f.position.id,
  f.analysis_id,f.reviewId,shortlist,canonical.sourceHash,canonical.planContractHash,
  JSON.stringify(canonicalVoiceSourceSnapshot(canonical.sourceBinding,canonical.planSourceFingerprint)),
  JSON.stringify(canonical),users.owner])).rows[0].id;
 const reviewArgs={planId:plan,sourceHash:canonical.sourceHash,
   expectedReviewVersion:0,decision:"approved",reason:null,requestKey:randomUUID()};
 const review=await atomicReviewVoicePlan(db,reviewArgs);
 assert.match(review,/^[a-f0-9-]{36}$/);
 assert.equal(await atomicReviewVoicePlan(db,reviewArgs),review);
 const releaseArgs={planId:plan,sourceHash:canonical.sourceHash,approvedReviewId:review,
   expectedPointerVersion:null,expectedReleaseId:null,requestKey:randomUUID()};
 const release=await atomicReleaseVoicePlan(db,releaseArgs);
 assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
 const current=(await db.query(
  "select release_entry_id,pointer_version from private.voice_plan_current_releases where application_id=$1",
  [f.application.id])).rows[0];
 assert.equal(current.release_entry_id,release);
 assert.equal(Number(current.pointer_version),1);
 const visible=(await db.query(
  "select private.sc012b_current_release($1) as id",[f.application.id])).rows[0].id;
 assert.equal(visible,release);


 await t.test("expired plan, approval, or release never authorizes current dispatch",async()=>{
  // Only isolated synthetic PostgreSQL 16. DDL is transactional and rolled
  // back after each case; immutable production history is never changed.
  for(const fixture of [
   {table:"public.voice_plan_versions",trigger:"voice_plan_versions_immutable",id:plan},
   {table:"private.voice_plan_review_entries",trigger:"voice_plan_reviews_immutable",id:review},
   {table:"private.voice_plan_release_entries",trigger:"voice_plan_releases_immutable",id:release},
  ]){
   await db.query("begin");
   try{
    await db.query("alter table "+fixture.table+" disable trigger "+fixture.trigger);
    await db.query("update "+fixture.table+
      " set retention_deadline=now()-interval '1 second' where id=$1",[fixture.id]);
    assert.equal((await db.query(
      "select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",
      [f.application.id])).rows[0].n,1);
    const expired=await db.query("select private.sc012b_current_release($1) as id",
      [f.application.id]);
    assert.equal(expired.rows[0].id,null,
      fixture.table+" expired data must not authorize dispatch");
    assert.equal((await db.query(
      "select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",
      [f.application.id])).rows[0].n,0,
      fixture.table+" expired pointer must be revoked in the same transaction");
    assert.equal((await db.query(
      "select count(*)::int as n from private.voice_plan_release_entries where id=$1",
      [release])).rows[0].n,1,"immutable release history must remain");
   }finally{
    await db.query("rollback");
   }
   assert.equal((await db.query("select private.sc012b_current_release($1) as id",
     [f.application.id])).rows[0].id,release,
     fixture.table+" synthetic rollback must restore the original current release");
  }
 });

 await t.test("newer plan version revokes old current release even if source is unchanged",async()=>{
  // A newly inserted version may require human review and release, but must
  // never leave the superseded, previously approved release dispatchable.
  await db.query("begin");
  try{
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
   assert.equal((await db.query(
    "select private.sc012b_current_release($1) as id",
    [f.application.id])).rows[0].id,null,
    "old release must not authorize dispatch after plan supersession");
   assert.equal((await db.query(
    "select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",
    [f.application.id])).rows[0].n,0,
    "superseded pointer must be revoked atomically");
   assert.equal((await db.query(
    "select count(*)::int as n from private.voice_plan_release_entries where id=$1",
    [release])).rows[0].n,1,"release history is immutable");
  }finally{
   await db.query("rollback");
  }
  assert.equal((await db.query(
   "select private.sc012b_current_release($1) as id",
   [f.application.id])).rows[0].id,release,
   "synthetic rollback must restore the previously current release");
 });

 await t.test("ranking-policy advancement revokes a previously current release",async()=>{
  // Keep the existing release intact for subsequent regressions: both the
  // synthetic policy upgrade and stale-pointer deletion are rolled back.
  await db.query("begin");
  try{
    const original=(await db.query(`select pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='get_recruitment_shortlist'`)).rows[0].definition;
    assert.match(original,/screening-ranking-v1/);
    await db.query(`insert into private.screening_ranking_policies
      (version,min_coverage,below_points,meets_points,above_points,
       min_target_size,max_target_size,default_target_size)
      values ('screening-ranking-v2',0.60,0,60,100,5,10,10)`);
    await db.query(original.replaceAll("screening-ranking-v1","screening-ranking-v2"));
    const shortlisted=(await db.query(
      "select policy_current from public.get_recruitment_shortlist($1,false) where entry_id=$2",
      [f.recruitment.id,shortlist])).rows;
    assert.ok(shortlisted.length===0 || shortlisted.every(row=>row.policy_current===false));
    assert.equal((await db.query(
      "select private.sc012b_current_release($1) as id",
      [f.application.id])).rows[0].id,null,
      "old ranking policy must never authorize dispatch");
    assert.equal((await db.query(
      "select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",
      [f.application.id])).rows[0].n,0,
      "the stale pointer must be removed, release history preserved");
  }finally{
    await db.query("rollback");
  }
  assert.equal((await db.query(
    "select private.sc012b_current_release($1) as id",
    [f.application.id])).rows[0].id,release);
 });


 await t.test("forced screening reanalysis hides a release despite identical source fingerprint",async()=>{
  // A separate synthetic tenant keeps the original release intact for the
  // subsequent concurrent-reader and source-mutation regression cases.
  const tenant=await h.seed(users.owner,randomUUID(),5);
  await h.asUser(users.owner);
  await db.query("update public.positions set required_behaviors=$1 where id=$2",
    [behaviorGuideDefinitions.map((x,i)=>x.label+": "+(i<4?"Wysoki":"Standardowy")),tenant.position.id]);
  const other=await h.completedApplication(tenant,
    ["insufficient_data","meets","below","meets","above"]);
  await h.asUser(users.owner);
  const otherShortlist=await h.add(other);
  await h.asAdmin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const verified=await reconstructTrustedVoiceSource(db,{
    companyId:other.companyId,applicationId:other.application.id,
    analysisId:other.analysis_id,reviewId:other.reviewId,
    shortlistEntryId:otherShortlist,
  });
  const otherPlan=(await db.query([
    "insert into public.voice_plan_versions",
    "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
    "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
    "template_version,created_by,retention_policy_version,retention_deadline)",
    "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,",
    "'skillcheck-voice-plan-v1',$12,'synthetic-v1','2030-01-01') returning id",
  ].join(" "),[
    other.companyId,other.recruitment.id,other.application.id,other.position.id,
    other.analysis_id,other.reviewId,otherShortlist,verified.sourceHash,
    verified.planContractHash,
    JSON.stringify(canonicalVoiceSourceSnapshot(verified.sourceBinding,verified.planSourceFingerprint)),
    JSON.stringify(verified),users.owner,
  ])).rows[0].id;
  const otherReview=await atomicReviewVoicePlan(db,{
    planId:otherPlan,sourceHash:verified.sourceHash,expectedReviewVersion:0,
    decision:"approved",reason:null,requestKey:randomUUID(),
  });
  const otherRelease=await atomicReleaseVoicePlan(db,{
    planId:otherPlan,sourceHash:verified.sourceHash,approvedReviewId:otherReview,
    expectedPointerVersion:null,expectedReleaseId:null,requestKey:randomUUID(),
  });
  const current=async()=>(await db.query(
    "select private.sc012b_current_release($1) as id",
    [other.application.id])).rows[0].id;
  assert.equal(await current(),otherRelease);
  const previous=(await db.query(
    "select id,input_fingerprint,execution_status,stale_at from public.screening_analysis_versions where id=$1",
    [other.analysis_id])).rows[0];
  assert.equal(previous.execution_status,"completed");
  assert.equal(previous.stale_at,null);
  // While forced reanalysis is pending, only the newer analysis ID invalidates
  // this release: the prior analysis and source fingerprint are still current.
  const forced=await h.start(other,{force:true});
  assert.notEqual(forced.analysis_id,other.analysis_id);
  await h.asAdmin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const newest=(await db.query(
    "select id,input_fingerprint,execution_status from public.screening_analysis_versions "+
    "where company_id=$1 and application_id=$2 "+
    "order by analysis_version desc limit 1",
    [other.companyId,other.application.id])).rows[0];
  assert.equal(newest.id,forced.analysis_id);
  assert.equal(newest.execution_status,"pending");
  assert.equal(newest.input_fingerprint,previous.input_fingerprint,
    "forced reanalysis must retain the unchanged source fingerprint");
  const old=(await db.query(
    "select execution_status,stale_at from public.screening_analysis_versions where id=$1",
    [other.analysis_id])).rows[0];
  assert.equal(old.execution_status,"completed");
  assert.equal(old.stale_at,null,
    "regression requires prior completed analysis to remain otherwise current");
  assert.equal(await current(),null,"older release must no longer be visible");
  const pointer=(await db.query(
    "select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",
    [other.application.id])).rows[0];
  assert.equal(pointer.n,0,"stale current pointer must be removed");
  await h.complete(other,forced,
    ["insufficient_data","meets","below","meets","above"]);
  await h.asAdmin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const superseded=(await db.query(
    "select execution_status,stale_at,stale_reason,superseded_by_analysis_id "+
    "from public.screening_analysis_versions where id=$1",
    [other.analysis_id])).rows[0];
  assert.equal(superseded.execution_status,"completed");
  assert.ok(superseded.stale_at,"completed reanalysis must mark the prior analysis stale");
  assert.equal(superseded.stale_reason,"manual_invalidation");
  assert.equal(superseded.superseded_by_analysis_id,forced.analysis_id);
  const afterCompletion=(await db.query(
    "select count(*)::int as n from private.voice_plan_current_releases where application_id=$1",
    [other.application.id])).rows[0];
  assert.equal(afterCompletion.n,0,"completed reanalysis must not restore the current pointer");
  assert.equal(await current(),null,"completed reanalysis must not restore the old release");
  const immutable=(await db.query(
    "select count(*)::int as n from private.voice_plan_release_entries where id=$1 and plan_id=$2",
    [otherRelease,otherPlan])).rows[0];
  assert.equal(immutable.n,1,"release history remains immutable");
  const approved=(await db.query(
    "select count(*)::int as n from private.voice_plan_review_entries where id=$1 and plan_id=$2",
    [otherReview,otherPlan])).rows[0];
  assert.equal(approved.n,1,"approved review history remains immutable");
  assert.equal((await db.query(
    "select private.sc012b_current_release($1) as id",
    [f.application.id])).rows[0].id,release,"the other tenant's release remains visible");
  const unaffected=(await db.query(
    "select release_entry_id,pointer_version from private.voice_plan_current_releases where application_id=$1",
    [f.application.id])).rows[0];
  assert.equal(unaffected.release_entry_id,release);
  assert.equal(Number(unaffected.pointer_version),1);
 });
 await t.test("screening writer advisory lock blocks the trusted current-release reader until commit",async()=>{
  // Three independent PostgreSQL 16 sessions: a screening writer, a
  // JWT-authenticated reader, and an observer of the server's lock table.
  // Only synthetic fixture data is used; no provider requests are made.
  const writer=new Client(config(dbName));
  const reader=new Client(config(dbName));
  const observer=new Client(config(dbName));
  const sessions=[writer,reader,observer];
  let writerTxOpen=false;
  let readCompletion=null;
  try{
    for(const session of sessions) await session.connect();
    await reader.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
    await reader.query("set statement_timeout='15000ms'");
    await observer.query("set statement_timeout='5000ms'");
    await writer.query("begin");
    writerTxOpen=true;
    await writer.query("set local statement_timeout='15000ms'");
    await writer.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      ["screening:"+f.application.id]);
    const readerPid=(await reader.query("select pg_backend_pid() as pid")).rows[0].pid;
    // Attach rejection handling immediately: the query may fail while the
    // independent observer is sampling pg_stat_activity.
    readCompletion=reader.query(
      "select private.sc012b_current_release($1) as id",
      [f.application.id]).then(
        result=>({result}),
        error=>({error}));
    let sawAdvisoryWait=false;
    for(let attempt=0;attempt<100;attempt++){
      await observer.query("select pg_stat_clear_snapshot()");
      const state=(await observer.query(
        "select wait_event_type,wait_event from pg_stat_activity where pid=$1",
        [readerPid])).rows[0];
      if(state?.wait_event_type==="Lock"&&state.wait_event==="advisory"){
        sawAdvisoryWait=true;
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.ok(sawAdvisoryWait,
      "JWT owner reader must wait for the screening writer's advisory lock");
    // The writer must still be able to lock the release pointer. Taking the
    // pointer lock first in the reader would invert the lock order.
    const pointer=(await writer.query(
      "select release_entry_id from private.voice_plan_current_releases "+
      "where application_id=$1 for update nowait",
      [f.application.id])).rows[0];
    assert.equal(pointer?.release_entry_id,release);
    await writer.query("commit");
    writerTxOpen=false;
    const completed=await readCompletion;
    if(completed.error) throw completed.error;
    assert.equal(completed.result.rows[0]?.id,release,
      "current release becomes readable after writer commit");
  }finally{
    if(writerTxOpen) await writer.query("rollback").catch(()=>{});
    if(readCompletion) await readCompletion;
    for(const session of sessions) await session.end().catch(()=>{});
  }
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
