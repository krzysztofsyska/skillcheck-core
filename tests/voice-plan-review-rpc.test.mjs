import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_review_"+process.pid;
test("SC-012-B isolated review RPC enforces human review CAS, request replay and denied writes",async t=>{
 assert.ok(url,"Real PostgreSQL 16 is required");
 const config=db=>({...parse(url),database:db});
 const m=new Client(config("postgres"));await m.connect();
 await m.query("drop database if exists "+dbName);
 await m.query("create database "+dbName);await m.end();
 const db=new Client(config(dbName));await db.connect();db.exec=s=>db.query(s);
 await db.query("set statement_timeout='20s'");
 const extra=[];
 const open=async()=>{
  const client=new Client(config(dbName));await client.connect();extra.push(client);
  await client.query("set statement_timeout='10s';set lock_timeout='3s'");
  return client;
 };
 t.after(async()=>{
   await Promise.all([db,...extra].map(client=>client.end().catch(()=>{})));
   const c=new Client(config("postgres"));await c.connect();
   await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",[dbName]);
   await c.query("drop database if exists "+dbName);await c.end();
 });
 const h=await setupRankingDatabase(db);
 const schema=await readFile(new URL("../db/prototypes/sc012b-plan-schema.sql",import.meta.url),"utf8");
 const rpc=await readFile(new URL("../db/isolated/sc012b-review-rpc.sql",import.meta.url),"utf8");
 await db.exec(schema);await db.exec(rpc);
 const f=await h.completedApplication(await h.seed(users.owner,randomUUID(),5),Array(5).fill("meets"));
 await h.asUser(users.owner);
 const shortlist=await h.add(f);
 await h.asAdmin();
 const source="a".repeat(64);
 const envelope={schemaVersion:1,language:"pl-PL",recordingAllowed:false,
   noticeRequired:true,targetSeconds:420,maximumSeconds:600,questions:[{},{},{},{}]};
 const plan=(await db.query([
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
  "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
  "template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'{}'::jsonb,$10::jsonb,",
  "'skillcheck-voice-plan-v1',$11,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.recruitment.id,f.application.id,f.position.id,
  f.analysis_id,f.reviewId,shortlist,source,"b".repeat(64),JSON.stringify(envelope),users.owner])).rows[0].id;
 const call="select private.sc012b_review_plan($1,$2,$3,$4,$5,$6) as id";
 const args=(version,decision,reason,key)=>[plan,version,source,decision,reason,key];
 const setActor=async actor=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor||""]);
 await t.test("anonymous or cross-tenant actor denied",async()=>{
  await setActor("");
  await assert.rejects(db.query(call,args(0,"approved",null,randomUUID())),e=>e.code==="22023");
  await setActor(users.otherOwner);
  await assert.rejects(db.query(call,args(0,"approved",null,randomUUID())),e=>e.code==="42501");
 });
 await setActor(users.owner);
 const key=randomUUID();
 const first=(await db.query(call,args(0,"approved",null,key))).rows[0].id;
 assert.match(first,/^[0-9a-f-]{36}$/);
 await t.test("same idempotency key returns original result even after version increments",async()=>{
  const replay=(await db.query(call,args(0,"approved",null,key))).rows[0].id;
  assert.equal(replay,first);
  await assert.rejects(db.query(call,args(0,"requires_changes","Changed",key)),e=>e.code==="PT409");
  const count=(await db.query("select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(count,1);
 });
 await t.test("stale expected review version fails with no appended review",async()=>{
  await assert.rejects(db.query(call,args(0,"approved",null,randomUUID())),e=>e.code==="PT409");
 });
 await t.test("requires_changes demands a non-empty reason",async()=>{
  await assert.rejects(db.query(call,args(1,"requires_changes","  ",randomUUID())),e=>e.code==="22023");
  const changed=(await db.query(call,args(1,"requires_changes","\u00a0Doprecyzować pytania\u202f",randomUUID()))).rows[0].id;
  assert.notEqual(changed,first);
  const rows=(await db.query("select decision,reason from private.voice_plan_review_entries where plan_id=$1 order by review_version",[plan])).rows;
  assert.deepEqual(rows.map(x=>x.decision),["approved","requires_changes"]);
  assert.equal(rows[1].reason,"Doprecyzować pytania");
 });

 await t.test("null decision and whitespace-only reason are invalid input",async()=>{
  await assert.rejects(db.query(call,args(2,null,null,randomUUID())),e=>e.code==="22023");
  for(const whitespace of ["\t\n","\r\v\f","   ","\u00a0","\u202f","\u00a0\u202f\u2003"])
   await assert.rejects(db.query(call,args(2,"requires_changes",whitespace,randomUUID())),e=>e.code==="22023");
 });
 await t.test("requires_changes is terminal for the same plan version",async()=>{
  await assert.rejects(db.query(call,args(2,"approved",null,randomUUID())),e=>e.code==="PT409");
  const count=(await db.query("select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(count,2);
 });
 await t.test("latest screening review mismatch invalidates the voice plan",async()=>{
  await db.query("update public.screening_analysis_versions set latest_review_version=latest_review_version+1 where id=$1",[f.analysis_id]);
  await assert.rejects(db.query(call,args(2,"approved",null,randomUUID())),e=>e.code==="PT409");
  await db.query("update public.screening_analysis_versions set latest_review_version=latest_review_version-1 where id=$1",[f.analysis_id]);
 });


 let successorPlan;
 await t.test("superseded plan cannot be reviewed after new version",async()=>{
  const lastReview=(await db.query("select id from private.voice_plan_review_entries where plan_id=$1 order by review_version desc limit 1",[plan])).rows[0].id;
  successorPlan=(await db.query([
   "insert into public.voice_plan_versions",
   "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
   "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
   "template_version,created_by,retention_policy_version,retention_deadline,",
   "supersedes_plan_id,corrects_review_id)",
   "select company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
   "shortlist_entry_id,2,$1,$2,source_snapshot,plan_envelope,template_version,created_by,",
   "retention_policy_version,retention_deadline,id,$3",
   "from public.voice_plan_versions where id=$4 returning id"
  ].join(" "),["c".repeat(64),"d".repeat(64),lastReview,plan])).rows[0]?.id;
  const replay=(await db.query(call,args(0,"approved",null,key))).rows[0].id;
  assert.equal(replay,first);
  await assert.rejects(db.query(call,args(0,"requires_changes","Inna decyzja",key)),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_REQUEST_CONFLICT");
  await assert.rejects(db.query(call,args(2,"approved",null,randomUUID())),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_SUPERSEDED");
 });

 await t.test("removed shortlist invalidates pending review",async()=>{
  await setActor(users.owner);
  await db.query("select public.remove_recruitment_shortlist_entry($1)",[shortlist]);
  await assert.rejects(db.query(call,[successorPlan,0,"c".repeat(64),"approved",null,randomUUID()]),e=>e.code==="PT409");
  assert.equal((await db.query(call,args(0,"approved",null,key))).rows[0].id,first);
 });

 const freshPlan=async()=>{
  const seeded=await h.seed(users.owner,randomUUID(),5);
  const done=await h.completedApplication(seeded,Array(5).fill("meets"));
  await h.asUser(users.owner);
  const entry=await h.add(done);
  await h.asAdmin();
  const hash="e".repeat(64);
  const id=(await db.query([
   "insert into public.voice_plan_versions",
   "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
   "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
   "template_version,created_by,retention_policy_version,retention_deadline)",
   "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'{}'::jsonb,$10::jsonb,",
   "'skillcheck-voice-plan-v1',$11,'synthetic-v1','2030-01-01') returning id"
  ].join(" "),[done.companyId,done.recruitment.id,done.application.id,done.position.id,
   done.analysis_id,done.reviewId,entry,hash,"f".repeat(64),JSON.stringify(envelope),users.owner])).rows[0].id;
  await setActor(users.owner);
  return {done,id,hash,candidateId:done.candidate.id,analysisId:done.analysis_id};
 };
 const reviewCount=async planId=>(await db.query("select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[planId])).rows[0].n;

 await t.test("repeatable read cannot review a plan from a stale snapshot",async()=>{
  const fresh=await freshPlan();
  const other=await open();
  await other.query("begin isolation level repeatable read");
  await other.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  await other.query("select txid_current_snapshot()");
  await assert.rejects(other.query(call,[fresh.id,0,fresh.hash,"approved",null,randomUUID()]),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_REQUIRES_READ_COMMITTED");
  await other.query("rollback");
  assert.equal(await reviewCount(fresh.id),0);
  const accepted=(await db.query(call,[fresh.id,0,fresh.hash,"approved",null,randomUUID()])).rows[0].id;
  assert.match(accepted,/^[0-9a-f-]{36}$/);
 });

 await t.test("idempotent replay survives release and a new key stays blocked",async()=>{
  const fresh=await freshPlan();
  const requestKey=randomUUID();
  const accepted=(await db.query(call,[fresh.id,0,fresh.hash,"approved",null,requestKey])).rows[0].id;
  await h.asAdmin();
  await db.query([
   "insert into private.voice_plan_release_entries",
   "(company_id,application_id,plan_id,approved_review_id,release_version,source_hash,released_by,retention_policy_version,retention_deadline)",
   "select company_id,application_id,plan_id,id,1,source_hash,reviewer_id,retention_policy_version,retention_deadline",
   "from private.voice_plan_review_entries where id=$1"
  ].join(" "),[accepted]);
  await setActor(users.owner);
  assert.equal((await db.query(call,[fresh.id,0,fresh.hash,"approved",null,requestKey])).rows[0].id,accepted);
  await assert.rejects(db.query(call,[fresh.id,1,fresh.hash,"approved",null,randomUUID()]),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_ALREADY_RELEASED");
  assert.equal(await reviewCount(fresh.id),1);
 });

 await t.test("analysis lock contention is a stable conflict",async()=>{
  const fresh=await freshPlan();
  const other=await open();
  await other.query("begin");
  await other.query("select id from public.screening_analysis_versions where id=$1 for update",[fresh.analysisId]);
  await assert.rejects(db.query(call,[fresh.id,0,fresh.hash,"approved",null,randomUUID()]),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_SOURCE_BUSY");
  await other.query("rollback");
  assert.equal(await reviewCount(fresh.id),0);
 });

 await t.test("frozen candidate blocks a new review and an in-progress freeze conflicts",async()=>{
  const fresh=await freshPlan();
  const other=await open();
  await other.query("begin");
  await other.query("select id from public.candidates where id=$1 for update",[fresh.candidateId]);
  await assert.rejects(db.query(call,[fresh.id,0,fresh.hash,"approved",null,randomUUID()]),e=>e.code==="PT409"&&e.message==="Candidate workflow busy");
  await other.query("rollback");
  assert.equal(await reviewCount(fresh.id),0);
  const requestKey=randomUUID();
  const accepted=(await db.query(call,[fresh.id,0,fresh.hash,"approved",null,requestKey])).rows[0].id;
  await h.asAdmin();
  const ticket=(await db.query([
   "insert into private.erasure_preview_tickets",
   "(company_id,actor_id,anchor_candidate_id,scope_kind,candidate_ids,manifest_hash,generations,expires_at)",
   "values($1,$2,$3,'candidate_record',array[$3::uuid],'synthetic','{}'::jsonb,clock_timestamp()+interval '5 minutes')",
   "returning id"
  ].join(" "),[fresh.done.companyId,users.owner,fresh.candidateId])).rows[0].id;
  const request=(await db.query([
   "insert into private.erasure_requests",
   "(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)",
   "values($1,$2,$3,array[$3::uuid],'candidate_record',$4,'synthetic',1,0,'authorized',1) returning id"
  ].join(" "),[fresh.done.companyId,users.owner,fresh.candidateId,ticket])).rows[0].id;
  await db.query([
   "insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)",
   "values($1,$2,1,'frozen',$3)"
  ].join(" "),[fresh.candidateId,fresh.done.companyId,request]);
  await setActor(users.owner);
  assert.equal((await db.query(call,[fresh.id,0,fresh.hash,"approved",null,requestKey])).rows[0].id,accepted);
  await assert.rejects(db.query(call,[fresh.id,1,fresh.hash,"approved",null,randomUUID()]),e=>e.code==="PT409"&&e.message==="Candidate workflow frozen");
  assert.equal(await reviewCount(fresh.id),1);
 });

 await t.test("no client role can directly execute the private RPC",async()=>{
  await db.query("set role authenticated");
  await assert.rejects(db.query(call,args(2,"approved",null,randomUUID())),e=>["42501","3F000"].includes(e.code));
  await db.query("reset role");
 });
});
