import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {startCompetencyHttps,httpSession,findCookie,createSharedLimiter} from './helpers/competency-broker-harness.mjs';

const requestKey=()=>randomUUID();
const body=(operation,fields={})=>JSON.stringify({operation,...fields});
const denied=r=>[403,404,409,422,429,503].includes(r.status);
function security(r){
 assert.match(r.headers['cache-control'],/no-store/);
 assert.equal(r.headers['referrer-policy'],'no-referrer');
 assert.equal(r.headers['access-control-allow-origin'],undefined);
 assert.doesNotMatch(r.raw,/Poufny tytuł|criteria|company_id|candidate_id|submission_digest|token_digest/);
}
test('B3 real HTTPS -> restricted PostgreSQL16: committed exchange/start/180min/draft/submit/receipt',async t=>{
 const e=await startCompetencyHttps(t);
 const f=await e.seed({duration:180}),g=await e.issue(f);
 const s=await httpSession(e,g);
 const cookies=e.pool.totalCount;
 assert.ok(cookies<=4);
 const inspect=await e.request('inspect',{csrf:s.csrf,cookie:s.cookie});
 assert.equal(inspect.status,200);security(inspect);
 assert.deepEqual(Object.keys(inspect.data).sort(),['durationMinutes','label','revisionId','state','version']);
 assert.equal(inspect.data.state,'not_started');assert.equal(inspect.data.durationMinutes,180);
 const started=await e.request('start',{csrf:s.csrf,cookie:s.cookie,body:body('start',{requestKey:requestKey()})});
 assert.equal(started.status,200,started.raw);security(started);
 assert.equal(started.data.state,'in_progress');assert.equal(started.data.test.title,'Poufny tytuł zadania');
 const deadline=Date.parse(started.data.deadlineAt),start=Date.parse(started.data.startedAt);
 assert.equal(Math.round((deadline-start)/60000),180);
 assert.equal(JSON.stringify(started.data).includes('"criteria"'),false);
 const recovered=await e.request('inspect',{csrf:s.csrf,cookie:s.cookie});assert.equal(recovered.status,200);
 assert.equal(recovered.data.deadlineAt,started.data.deadlineAt);
 const saveKey=requestKey();
 const saved=await e.request('save',{csrf:s.csrf,cookie:s.cookie,body:body('save',{draft:'Fikcyjny plan',expectedVersion:0,requestKey:saveKey})});
 assert.equal(saved.status,200);assert.equal(saved.data.version,1);
 const retry=await e.request('save',{csrf:s.csrf,cookie:s.cookie,body:body('save',{draft:'Fikcyjny plan',expectedVersion:0,requestKey:saveKey})});
 assert.equal(retry.status,200);assert.equal(retry.data.version,1);
 const conflict=await e.request('save',{csrf:s.csrf,cookie:s.cookie,body:body('save',{draft:'Konflikt',expectedVersion:0,requestKey:requestKey()})});
 assert.equal(conflict.status,409);
 const resumed=await e.request('inspect',{csrf:s.csrf,cookie:s.cookie});
 assert.deepEqual(resumed.data.draft,{text:'Fikcyjny plan',version:1});
 const invalid=await e.request('submit',{csrf:s.csrf,cookie:s.cookie,body:body('submit',{answer:{workSample:'!!!'},requestKey:requestKey()})});
 assert.equal(invalid.status,422);security(invalid);
 const persisted=await e.request('inspect',{csrf:s.csrf,cookie:s.cookie});
 assert.equal(persisted.data.draft.text,'Fikcyjny plan','invalid submit never erases draft');
 const answer={workSample:' Plan bezpiecznego wdrożenia z komunikacją. '};
 const receipt=await e.request('submit',{csrf:s.csrf,cookie:s.cookie,body:body('submit',{answer,requestKey:requestKey()})});
 assert.equal(receipt.status,200);security(receipt);
 assert.deepEqual(Object.keys(receipt.data).sort(),['attemptId','state']);
 const replay=await e.request('submit',{csrf:s.csrf,cookie:s.cookie,body:body('submit',{answer:{workSample:'Plan bezpiecznego wdrożenia z komunikacją.'},requestKey:requestKey()})});
 assert.equal(replay.status,200);assert.deepEqual(replay.data,receipt.data);
 const status=await e.request('status',{csrf:s.csrf,cookie:s.cookie});
 assert.equal(status.status,200);assert.deepEqual(status.data,receipt.data);
 const after=await e.request('save',{csrf:s.csrf,cookie:s.cookie,body:body('save',{draft:'Inny tekst',expectedVersion:1,requestKey:requestKey()})});
 assert.equal(after.status,409);
 await e.h.asAdmin();
 const draft=(await e.db.query('select count(*)::int n from private.competency_test_drafts where attempt_id=$1',[receipt.data.attemptId])).rows[0].n;
 assert.equal(draft,0);
});
test('B3 real HTTPS: only one exchange, lost response demands issuer rotation, no reused grant secret',async t=>{
 const e=await startCompetencyHttps(t);
 const f=await e.seed(),g=await e.issue(f),s=await httpSession(e,g);
 assert.equal((await e.request('bootstrap',{cookie:s.cookie,headers:{'x-sc014-intent':'bootstrap'}})).status,200);
 const pre=await e.request('bootstrap',{headers:{'x-sc014-intent':'bootstrap'}});
 assert.equal(pre.status,200);
 const init=findCookie(pre,'__Secure-sc014_b3_preflight');
 const again=await e.request('exchange',{cookie:init,csrf:pre.data.csrf,body:body('exchange',{token:g.token})});
 assert.ok(denied(again),'committed grant session cannot be replayed');
 assert.equal(again.headers['set-cookie'],undefined);
 await e.h.asUser(f.owner);
 await e.call('public.revoke_competency_test_grant',[g.grantId,requestKey()]);
 const revoked=await e.request('inspect',{csrf:s.csrf,cookie:s.cookie});
 assert.equal(revoked.status,404);
 assert.equal((await e.request('status',{csrf:s.csrf,cookie:s.cookie})).status,404);
});
test('B3 real PostgreSQL two tenants, revocation and one-session isolation',async t=>{
 const e=await startCompetencyHttps(t);
 const fA=await e.seed(),gA=await e.issue(fA);
 const fB=await e.seed(),gB=await e.issue(fB);
 const sA=await httpSession(e,gA);
 const sB=await httpSession(e,gB);
 const ownA=await e.request('inspect',{csrf:sA.csrf,cookie:sA.cookie});
 const ownB=await e.request('inspect',{csrf:sB.csrf,cookie:sB.cookie});
 assert.equal(ownA.status,200);assert.equal(ownB.status,200);
 assert.equal(ownA.data.revisionId,fA.definitionId);
 assert.equal(ownB.data.revisionId,fB.definitionId);
 assert.notEqual(ownA.data.revisionId,ownB.data.revisionId);
 const wrongCsrf=await e.request('start',{csrf:sA.csrf,cookie:sB.cookie,body:body('start',{requestKey:requestKey()})});
 assert.equal(wrongCsrf.status,403);
 const noSession=await e.request('inspect',{csrf:sA.csrf});assert.equal(noSession.status,403);
 await e.h.asUser(fA.owner);
 await e.call('public.revoke_competency_test_grant',[gA.grantId,requestKey()]);
 assert.equal((await e.request('inspect',{csrf:sA.csrf,cookie:sA.cookie})).status,404);
 assert.equal((await e.request('inspect',{csrf:sB.csrf,cookie:sB.cookie})).status,200);
});
test('B3 origin, CORS, no trust in caller proxy headers, HTTP errors never leak SQL',async t=>{
 const e=await startCompetencyHttps(t);
 const f=await e.seed(),g=await e.issue(f);
 const pre=await e.request('bootstrap',{headers:{'x-sc014-intent':'bootstrap'}});
 assert.equal(pre.status,200);
 const init=findCookie(pre,'__Secure-sc014_b3_preflight');
 for(const headers of [
  {origin:'https://evil.test'},
  {'sec-fetch-site':'cross-site'},
  {'content-encoding':'gzip'},
  {'content-type':'text/plain'},
  {'x-oversized':'x'.repeat(8200)}
 ]){
  const refused=await e.request('exchange',{csrf:pre.data.csrf,cookie:init,headers,body:body('exchange',{token:g.token})});
  assert.ok(denied(refused));security(refused);
 }
 const bad=await e.request('exchange',{csrf:pre.data.csrf,cookie:init,headers:{'x-forwarded-for':'192.168.0.1','x-real-ip':'198.51.100.2'},body:'{"operation":"exchange","token":"BAD"}'});
 assert.equal(bad.status,400);
 const {cookie,csrf}=await httpSession(e,g);
 assert.equal((await e.request('inspect',{cookie,csrf:'f'.repeat(64)})).status,403);
});
test('B3 shared real Redis limiter: global and per-source budget across independent instances',async t=>{
 execFileSync('redis-cli',['-h','127.0.0.1','-p','6379','FLUSHDB'],{stdio:'ignore'});
 const suffix=randomUUID().replaceAll('-','');
 // To avoid Redis test overlap, EVAL keys are minute scoped, and the workflow
 // runs a single test worker; flush only this isolated Redis instance upfront.
 // First demonstrate two client objects share one Redis state under the same HMAC.
 const limiterA=createSharedLimiter({global:6,source:3});
 const limiterB=createSharedLimiter({global:6,source:3});
 const minute=Math.floor(Date.now()/60000);
 const source='e'.repeat(64),other='d'.repeat(64);
 const results=[
  await limiterA.consume(source,minute),
  await limiterB.consume(source,minute),
  await limiterA.consume(source,minute),
  await limiterB.consume(source,minute)
 ];
 assert.deepEqual(results,[true,true,true,false],suffix);
 const more=[await limiterB.consume(other,minute),await limiterA.consume(other,minute),await limiterB.consume(other,minute)];
 assert.deepEqual(more,[true,true,true]);
 assert.equal(await limiterA.consume('c'.repeat(64),minute),false,'global cap is shared');
});
