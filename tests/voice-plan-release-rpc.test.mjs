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

test("SC-012-B isolated release RPC enforces approval, current pointer CAS and replay",async t=>{
 assert.ok(url,"real PostgreSQL is required");
 const config=db=>({...parse(url),database:db});
 const maintenance=new Client(config("postgres"));await maintenance.connect();
 await maintenance.query("drop database if exists "+dbName);
 await maintenance.query("create database "+dbName);await maintenance.end();
 const clients=[];
 const connect=async()=>{
   const c=new Client(config(dbName));await c.connect();c.exec=s=>c.query(s);
   clients.push(c);await c.query("set statement_timeout='12s'; set lock_timeout='2s'");
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
 const f=await h.completedApplication(await h.seed(users.owner,randomUUID(),5),Array(5).fill("meets"));
 await h.asUser(users.owner);
 const shortlist=await h.add(f);
 await h.asAdmin();
 const envelope={schemaVersion:1,language:"pl-PL",recordingAllowed:false,
  noticeRequired:true,targetSeconds:420,maximumSeconds:600,questions:[{},{},{},{}]};
 const source=h64("a");
 const plan=(await db.query([
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
  "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
  "template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'{}'::jsonb,$10::jsonb,",
  "'skillcheck-voice-plan-v1',$11,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.recruitment.id,f.application.id,f.position.id,
  f.analysis_id,f.reviewId,shortlist,source,h64("b"),JSON.stringify(envelope),users.owner])).rows[0].id;
 const insertReview=async (decision="approved")=>
  (await db.query([
   "insert into private.voice_plan_review_entries",
   "(company_id,application_id,plan_id,review_version,reviewer_id,decision,source_hash,",
   "retention_policy_version,retention_deadline)",
   "values($1,$2,$3,1,$4,$5,$6,'synthetic-v1','2030-01-01') returning id"
  ].join(" "),[f.companyId,f.application.id,plan,users.owner,decision,source])).rows[0].id;
 const call="select private.sc012b_release_plan($1,$2,$3,$4,$5,$6) as id";
 const args=(review,key=randomUUID(),version=null,release=null)=>[plan,review,source,version,release,key];
 const actor=async id=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||""]);
 await actor(users.owner);
 await t.test("reject unreviewed plans",async()=>{
   await assert.rejects(db.query(call,args(randomUUID())),e=>e.code==="PT409");
 });
 const review=await insertReview();
 await t.test("deny anonymous and foreign-company callers",async()=>{
  await actor("");
  await assert.rejects(db.query(call,args(review)),e=>e.code==="22023");
  await actor(users.otherOwner);
  await assert.rejects(db.query(call,args(review)),e=>e.code==="42501");
  await actor(users.owner);
 });
 await t.test("deny incorrect review, invalid pointer and stale source",async()=>{
  await assert.rejects(db.query(call,args(randomUUID())),e=>e.code==="PT409");
  await assert.rejects(db.query(call,[plan,review,h64("f"),null,null,randomUUID()]),e=>e.code==="PT409");
  await assert.rejects(db.query(call,args(review,randomUUID(),1,randomUUID())),e=>e.code==="PT409");
 });
 const key=randomUUID();
 const release=(await db.query(call,args(review,key))).rows[0].id;
 await t.test("release creates one pointer and immutable history",async()=>{
  const row=(await db.query("select plan_id,release_entry_id,pointer_version from private.voice_plan_current_releases where application_id=$1",[f.application.id])).rows[0];
  assert.equal(row.plan_id,plan);
  assert.equal(row.release_entry_id,release);
  assert.equal(Number(row.pointer_version),1);
  const count=(await db.query("select count(*)::int as n from private.voice_plan_release_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(count,1);
 });
 await t.test("matching idempotency key returns same release; altered key payload conflicts",async()=>{
  assert.equal((await db.query(call,args(review,key))).rows[0].id,release);
  await assert.rejects(db.query(call,args(review,key,1,release)),e=>e.code==="PT409");
  await assert.rejects(db.query(call,args(review,randomUUID())),e=>e.code==="PT409");
 });
 await t.test("client roles cannot execute private release RPC",async()=>{
  await db.query("set role authenticated");
  await assert.rejects(db.query(call,args(review)),e=>e.code==="42501");
  await db.query("reset role");
 });
 await t.test("two concurrent distinct request keys cannot both release the same plan",async()=>{
  const a=await connect(),b=await connect();
  for(const c of [a,b])await c.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
  const results=await Promise.allSettled([a.query(call,args(review)),b.query(call,args(review))]);
  assert.equal(results.filter(x=>x.status==="fulfilled").length,0);
  assert.ok(results.every(x=>x.status==="rejected"&&x.reason.code==="PT409"));
 });
});
