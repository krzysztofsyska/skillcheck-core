import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";
import {behaviorGuideDefinitions} from "../lib/behavior-guide.ts";
import {
  getTrustedVoiceTemplate,trustedVoiceTemplateDigest,assertPinnedVoiceQuestions,pinnedClarificationGaps,
} from "../lib/voice/template-registry.ts";
import {buildInterviewPlan} from "../lib/voice/interview-plan.ts";
import {canonicalVoiceSourceSnapshot} from "../lib/voice/plan-persistence-contract.ts";
import {
  reconstructTrustedVoiceSource,verifyStoredVoicePlan,TrustedSourceError,
} from "../lib/voice/trusted-source-verifier.ts";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_source_"+process.pid+"_"+randomUUID().replaceAll("-","").slice(0,10);
test("SC-012-B reconstructs source from live trusted DB and rejects stale or altered plans",async t=>{
 assert.ok(url,"PostgreSQL 16 is required");
 const parsed=parse(url);
 assert.ok(["127.0.0.1","localhost","::1"].includes(parsed.host)||parsed.host?.startsWith("/tmp/"),
   "SC012 source tests require a loopback-only disposable PostgreSQL server");
 const config=db=>({...parsed,database:db});
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
 await db.exec(await readFile(new URL("../db/prototypes/sc012b-plan-schema.sql",import.meta.url),"utf8"));
 await db.exec(await readFile(new URL("../db/isolated/sc012b-template-catalog.sql",import.meta.url),"utf8"));
 await db.query("insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)",
   ["skillcheck-voice-plan-v1",trustedVoiceTemplateDigest("skillcheck-voice-plan-v1")]);
 const seed=await h.seed(users.owner,randomUUID(),5);
 await h.asUser(users.owner);
 const behaviors=behaviorGuideDefinitions.map((b,i)=>b.label+": "+(i<4?"Wysoki":"Standardowy"));
 await db.query("update public.positions set required_behaviors=$1 where id=$2",
   [behaviors,seed.position.id]);
 const f=await h.completedApplication(seed,
   ["insufficient_data","meets","below","meets","above"]);
 await h.asUser(users.owner);
 const shortlist=await h.add(f);
 await h.asAdmin();
 const setActor=async actor=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor||""]);
 const selector={
  companyId:f.companyId,applicationId:f.application.id,analysisId:f.analysis_id,
  reviewId:f.reviewId,shortlistEntryId:shortlist,
 };
 await setActor(users.owner);
 const expected=await reconstructTrustedVoiceSource(db,selector);
 assert.equal(expected.templateVersion,"skillcheck-voice-plan-v1");
 assert.equal(expected.recordingAllowed,false);
 assert.equal(expected.noticeRequired,true);
 assert.ok(expected.questions.length>=4&&expected.questions.length<=6);
 assert.equal(expected.questions.filter(q=>q.kind==="common").length,4);
 assert.ok(expected.questions.filter(q=>q.kind==="common").every(q=>q.maxSeconds===60));
 assert.ok(expected.questions.filter(q=>q.kind==="clarification").every(q=>q.maxSeconds===45));
 assert.equal(expected.sourceBinding.analysisId,f.analysis_id);
 assert.ok(expected.questions.every(q=>!q.text.includes("PRIVATE")));
 const sourceSnapshot=canonicalVoiceSourceSnapshot(
   expected.sourceBinding,expected.planSourceFingerprint);
 const insertPlan=async(snapshot,{
   subject=f,source=expected,shortlistId=shortlist,retentionDeadline="2030-01-01T00:00:00Z",
 }={})=>{
  const row=await db.query([
   "insert into public.voice_plan_versions",
   "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
   "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
   "template_version,created_by,retention_policy_version,retention_deadline)",
   "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,",
   "'skillcheck-voice-plan-v1',$12,'synthetic-v1',$13::timestamptz) returning id"
  ].join(" "),[subject.companyId,subject.recruitment.id,subject.application.id,subject.position.id,
   subject.analysis_id,subject.reviewId,shortlistId,source.sourceHash,source.planContractHash,
   JSON.stringify(snapshot),JSON.stringify(source),users.owner,retentionDeadline]);
  return row.rows[0].id;
 };
 const replacePlan=async()=>{
  await db.query("alter table public.voice_plan_versions disable trigger voice_plan_versions_immutable");
  await db.query("delete from public.voice_plan_versions where company_id=$1 and application_id=$2",
    [f.companyId,f.application.id]);
  await db.query("alter table public.voice_plan_versions enable trigger voice_plan_versions_immutable");
 };
 await t.test("empty or overbroad source snapshot cannot verify",async()=>{
  const empty=await insertPlan({});
  await assert.rejects(verifyStoredVoicePlan(db,empty),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await replacePlan();
  const leaked=await insertPlan({...sourceSnapshot,cvText:"PRIVATE original CV"});
  await assert.rejects(verifyStoredVoicePlan(db,leaked),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await replacePlan();
 });
 await t.test("an expired canonical plan is stale even when its live source is unchanged",async()=>{
  const expired=await insertPlan(sourceSnapshot,{retentionDeadline:"2000-01-01T00:00:00Z"});
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
  await assert.rejects(verifyStoredVoicePlan(db,expired),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  assert.equal((await db.query(
    "select count(*)::int as n from public.voice_plan_versions where id=$1",[expired])).rows[0].n,1,
    "expired history remains stored without granting current verification");
  await replacePlan();
 });
 const plan=await insertPlan(sourceSnapshot);
 await t.test("canonical saved envelope verifies with unchanged source",async()=>{
  const result=await verifyStoredVoicePlan(db,plan);
  assert.deepEqual(result.questions,expected.questions);
 });
 await t.test("standalone source reads preserve every caller-owned transaction",async tx=>{
  const observer=new Client(config(dbName));await observer.connect();
  await db.query("create table public.sc012b_source_tx_markers(id uuid primary key)");
  const count=async(client,ids)=>(await client.query(
    "select count(*)::int as n from public.sc012b_source_tx_markers where id=any($1::uuid[])",[ids])).rows[0].n;
  const operations=[
    ["valid reconstruction",()=>reconstructTrustedVoiceSource(db,selector)],
    ["valid stored plan",()=>verifyStoredVoicePlan(db,plan)],
    ["invalid reconstruction",()=>reconstructTrustedVoiceSource(db,{...selector,reviewId:randomUUID()})],
    ["missing stored plan",()=>verifyStoredVoicePlan(db,randomUUID())],
  ];
  try{
   for(const isolation of ["read committed","repeatable read"]){
    for(const [name,run] of operations)await tx.test(name+" preserves "+isolation,async()=>{
     for(const finish of ["rollback","commit"]){
      const ids=[randomUUID(),randomUUID()];
      await db.query("begin isolation level "+isolation);
      try{
       await db.query("insert into public.sc012b_source_tx_markers values($1)",[ids[0]]);
       // A caller's identically named savepoint must survive the idle probe.
       await db.query("savepoint sc012b_source_idle_probe");
       await assert.rejects(run(),e=>e instanceof TrustedSourceError&&e.code==="INVALID");
       assert.equal((await db.query("show transaction_isolation")).rows[0].transaction_isolation,isolation);
       assert.equal(await count(db,ids),1,"the caller's earlier write must remain pending");
       await db.query("rollback to savepoint sc012b_source_idle_probe");
       await db.query("release savepoint sc012b_source_idle_probe");
       await db.query("insert into public.sc012b_source_tx_markers values($1)",[ids[1]]);
       assert.equal(await count(db,ids),2,"the caller can still write after rejection");
       assert.equal(await count(observer,ids),0,"neither caller write was committed by the helper");
       await db.query(finish);
       assert.equal(await count(observer,ids),finish==="commit"?2:0,
         "only the caller decides whether its changes commit");
      }finally{
       await db.query("rollback");
       await db.query("delete from public.sc012b_source_tx_markers where id=any($1::uuid[])",[ids]);
      }
     }
    });
    await tx.test(isolation+" without an allocated XID is still caller-owned",async()=>{
     for(const [,run] of operations.slice(0,2)){
      await db.query("begin isolation level "+isolation);
      try{
       assert.equal((await db.query("select txid_current_if_assigned() as xid")).rows[0].xid,null);
       await assert.rejects(run(),e=>e instanceof TrustedSourceError&&e.code==="INVALID");
       await db.query("savepoint caller_still_active");
       await db.query("release savepoint caller_still_active");
       assert.equal((await db.query("show transaction_isolation")).rows[0].transaction_isolation,isolation);
      }finally{await db.query("rollback");}
     }
    });
    await tx.test(isolation+" failed caller transaction stays failed until caller recovery",async()=>{
     for(const [,run] of operations.slice(0,2)){
      const id=randomUUID();
      await db.query("begin isolation level "+isolation);
      try{
       await db.query("insert into public.sc012b_source_tx_markers values($1)",[id]);
       await db.query("savepoint caller_recovery");
       await assert.rejects(db.query("select 1/0"),e=>e.code==="22012");
       await assert.rejects(run(),e=>e.code==="25P02");
       await assert.rejects(db.query("select 1"),e=>e.code==="25P02",
         "helper must neither roll back nor recover the failed caller transaction");
       await db.query("rollback to savepoint caller_recovery");
       assert.equal(await count(db,[id]),1,"the caller's recovery savepoint remains usable");
       assert.equal(await count(observer,[id]),0);
      }finally{await db.query("rollback");}
      assert.equal(await count(observer,[id]),0);
     }
    });
   }
  }finally{
   await db.query("rollback");
   await observer.end();
   await db.query("drop table public.sc012b_source_tx_markers");
  }
 });
 await t.test("standalone source reads choose read committed on an idle repeatable-read session",async()=>{
  await db.query("set default_transaction_isolation='repeatable read'");
  try{
   assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
   assert.equal((await verifyStoredVoicePlan(db,plan)).sourceHash,expected.sourceHash);
   assert.equal((await db.query("show default_transaction_isolation")).rows[0].default_transaction_isolation,
     "repeatable read","standalone calls do not change the session default");
  }finally{await db.query("reset default_transaction_isolation");}
 });
 await t.test("both standalone reads pin restore configuration until their own COMMIT",async()=>{
  const updater=new Client(config(dbName));await updater.connect();
  await updater.query("set lock_timeout='100ms'");
  try{
   for(const run of [
     client=>reconstructTrustedVoiceSource(client,selector),
     client=>verifyStoredVoicePlan(client,plan),
   ]){
    let commits=0;
    const beforeCommit={query:async(sql,params)=>{
     if(sql==="commit"){
      commits++;
      await assert.rejects(updater.query(
        "update private.erasure_execution_config set restore_isolated=true where singleton"),
        e=>e.code==="55P03","restore cannot switch after source checks but before commit");
     }
     return db.query(sql,params);
    }};
    assert.equal((await run(beforeCommit)).sourceHash,expected.sourceHash);
    assert.equal(commits,1);
    await updater.query("begin");
    await updater.query("update private.erasure_execution_config set restore_isolated=true where singleton");
    await updater.query("rollback");
   }
  }finally{await updater.query("rollback");await updater.end();}
 });
 await t.test("restore updater wins first: pending, committed and missing config fail closed",async()=>{
  const updater=new Client(config(dbName));await updater.connect();
  const original=(await db.query("select to_jsonb(c) as value from private.erasure_execution_config c where singleton")).rows[0].value;
  const operations=[()=>reconstructTrustedVoiceSource(db,selector),()=>verifyStoredVoicePlan(db,plan)];
  try{
   await updater.query("begin");
   await updater.query("update private.erasure_execution_config set restore_isolated=true where singleton");
   for(const run of operations)await assert.rejects(run(),
     e=>e instanceof TrustedSourceError&&e.code==="CONFLICT");
   await updater.query("commit");
   for(const run of operations)await assert.rejects(run(),e=>e.code==="PT409");
   await updater.query("delete from private.erasure_execution_config where singleton");
   for(const run of operations)await assert.rejects(run(),
     e=>e instanceof TrustedSourceError&&e.code==="CONFLICT");
  }finally{
   await updater.query("rollback");
   await updater.query("delete from private.erasure_execution_config where singleton");
   await updater.query(
     "insert into private.erasure_execution_config select * from jsonb_populate_record(null::private.erasure_execution_config,$1::jsonb)",
     [JSON.stringify(original)]);
   await updater.end();
  }
  assert.equal((await verifyStoredVoicePlan(db,plan)).sourceHash,expected.sourceHash);
 });
 await t.test("immutable DB template catalog prevents silent template replacement",async()=>{
  await assert.rejects(db.query(
    "update private.voice_plan_template_catalog set manifest_digest=$1 where version=$2",
    ["f".repeat(64),"skillcheck-voice-plan-v1"]),e=>e.code==="42501");
  await assert.rejects(db.query(
    "delete from private.voice_plan_template_catalog where version=$1",
    ["skillcheck-voice-plan-v1"]),e=>e.code==="42501");
 });
 await t.test("cross-tenant user cannot reconstruct approved source",async()=>{
  await setActor(users.otherOwner);
  await assert.rejects(reconstructTrustedVoiceSource(db,selector),
    e=>e instanceof TrustedSourceError&&e.code==="FORBIDDEN");
  await setActor(users.owner);
 });
 await t.test("recruiter membership is required and revocation is fail-closed",async()=>{
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",
    [f.companyId,users.recruiter]);
  await setActor(users.recruiter);
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
  await setActor(users.owner);
  await db.query("delete from public.company_members where company_id=$1 and user_id=$2",
    [f.companyId,users.recruiter]);
  await setActor(users.recruiter);
  await assert.rejects(reconstructTrustedVoiceSource(db,selector),
    e=>e instanceof TrustedSourceError&&e.code==="FORBIDDEN");
  await setActor(users.owner);
 });
 await t.test("tampered saved source hash cannot grant authority",async()=>{
  await assert.rejects(verifyStoredVoicePlan(db,randomUUID()),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  // Even a forged browser-supplied snapshot is not an input to the verifier.
  const fake={...selector,reviewId:randomUUID()};
  await assert.rejects(reconstructTrustedVoiceSource(db,fake),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
 });
 await t.test("obsolete ranking policy invalidates an otherwise active shortlist",async()=>{
  await db.query(`insert into private.screening_ranking_policies
    (version,min_coverage,below_points,meets_points,above_points,min_target_size,max_target_size,default_target_size)
    values ('screening-ranking-v2',0.60,0,60,100,5,10,10)`);
  const original=(await db.query(`select pg_get_functiondef(p.oid) as definition from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='get_recruitment_shortlist'`)).rows[0].definition;
  assert.match(original,/screening-ranking-v1/);
  await db.query(original.replaceAll("screening-ranking-v1","screening-ranking-v2"));
  await assert.rejects(reconstructTrustedVoiceSource(db,selector),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await assert.rejects(verifyStoredVoicePlan(db,plan),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await db.query(original);
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
 });
 await t.test("row lock contention returns a domain conflict",async()=>{
  const other=new Client(config(dbName));
  await other.connect();
  try{
   await other.query("begin");
   await other.query("select id from public.companies where id=$1 for update",[f.companyId]);
   await assert.rejects(reconstructTrustedVoiceSource(db,selector),
     e=>e instanceof TrustedSourceError&&e.code==="CONFLICT");
  }finally{
   await other.query("rollback");
   await other.end();
  }
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
 });
 await t.test("position revision invalidates the saved plan",async()=>{
  await db.query("update public.positions set title='New analyst role' where id=$1",[f.position.id]);
  await assert.rejects(verifyStoredVoicePlan(db,plan),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
 });
 await t.test("a completed in-progress application stops granting source authority when hired",async()=>{
  const candidate=await h.candidate(f);
  await db.query("update public.applications set status='in_progress' where id=$1",[candidate.application.id]);
  const hired=await h.completedApplication(candidate,["insufficient_data","meets","below","meets","above"]);
  await h.asUser(users.owner);
  const shortlistId=await h.add(hired);
  await h.asAdmin();await setActor(users.owner);
  const hiredSelector={companyId:hired.companyId,applicationId:hired.application.id,
    analysisId:hired.analysis_id,reviewId:hired.reviewId,shortlistEntryId:shortlistId};
  const source=await reconstructTrustedVoiceSource(db,hiredSelector);
  const saved=await insertPlan(canonicalVoiceSourceSnapshot(source.sourceBinding,source.planSourceFingerprint),{
    subject:hired,source,shortlistId,
  });
  assert.equal((await verifyStoredVoicePlan(db,saved)).sourceHash,source.sourceHash);
  await db.query("update public.applications set status='hired' where id=$1",[hired.application.id]);
  const state=(await db.query(
    "select ap.status,a.execution_status from public.applications ap join public.screening_analysis_versions a on a.application_id=ap.id where a.id=$1",
    [hired.analysis_id])).rows[0];
  assert.deepEqual(state,{status:"hired",execution_status:"completed"});
  await assert.rejects(reconstructTrustedVoiceSource(db,hiredSelector),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await assert.rejects(verifyStoredVoicePlan(db,saved),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
 });
});

test("SC-012-B template registry only permits explicitly versioned, pinned templates",()=>{
 const template=getTrustedVoiceTemplate("skillcheck-voice-plan-v1");
 assert.equal(template.recordingAllowed,false);
 assert.equal(template.selectionRules.commonCount,4);
 assert.equal(template.selectionRules.commonMaxSeconds,60);
 assert.equal(template.selectionRules.clarificationMaxSeconds,45);
 assert.equal(template.selectionRules.clarificationLimit,2);
 assert.deepEqual(template.selectionRules.priorityLevels,["Krytyczny","Wysoki","Standardowy","Niski"]);
 assert.deepEqual(template.selectionRules.gapQualifyingRatings,["insufficient_data"]);
 assert.match(trustedVoiceTemplateDigest("skillcheck-voice-plan-v1"),/^[a-f0-9]{64}$/);
 assert.throws(()=>getTrustedVoiceTemplate("skillcheck-voice-plan-v2"),/VOICE_TEMPLATE_UNSUPPORTED/);
 assert.ok(Object.isFrozen(template));
});

test("SC-012-B pins question order, duration, identity and independently selected gaps",()=>{
 const source={
   companyId:randomUUID(),applicationId:randomUUID(),
   positionRevision:"2026-10-12T08:00:00.000Z",
   analysisRevision:randomUUID(),reviewRevision:randomUUID(),
   screeningReviewed:true,screeningCurrent:true,
   position:{
     title:"Handlowiec",tasks:["Kontakt z klientami"],kpis:["Wynik sprzedaży"],
     requiredCompetencies:["Negocjacje"],
     requiredBehaviors:behaviorGuideDefinitions.map((area,i)=>area.label+": "+(i<4?"Wysoki":"Standardowy")),
   },
   gaps:[{criterionId:"task:1",kind:"task",reason:"missing_evidence"}],
 };
 const generated=buildInterviewPlan(source);
 assert.doesNotThrow(()=>assertPinnedVoiceQuestions(source,generated.questions));
 for(const changed of [
   generated.questions.map((q,i)=>i===0?{...q,maxSeconds:61}:q),
   [...generated.questions].reverse(),
   generated.questions.map((q,i)=>i===0?{...q,id:"common-other"}:q),
   generated.questions.map((q,i)=>i===0?{...q,followUps:["Unapproved follow-up"]}:q),
 ])assert.throws(()=>assertPinnedVoiceQuestions(source,changed),/VOICE_TEMPLATE_GENERATOR_DRIFT/);
 const material={
   criteria:[{id:"kpi:1",kind:"kpi"},{id:"task:1",kind:"task"},{id:"competency:1",kind:"competency"}],
   results:[{criterionId:"kpi:1",rating:"insufficient_data"},
     {criterionId:"task:1",rating:"insufficient_data"},{criterionId:"competency:1",rating:"below"}],
   overrides:[{criterionId:"task:1",rating:null}],
 };
 assert.deepEqual(pinnedClarificationGaps(material),[
   {criterionId:"task:1",kind:"task",reason:"missing_evidence"},
   {criterionId:"kpi:1",kind:"kpi",reason:"missing_evidence"},
 ]);
 assert.deepEqual(pinnedClarificationGaps({...material,overrides:[{criterionId:"task:1",rating:"above"}]}),[
   {criterionId:"kpi:1",kind:"kpi",reason:"missing_evidence"},
 ]);
});
