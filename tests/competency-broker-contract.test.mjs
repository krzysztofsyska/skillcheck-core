import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCompetencyBroker, B3_ENDPOINT, B3_MAX_BODY,
  B3_SESSION_COOKIE, B3_INIT_COOKIE} from '../lib/competency-attempt-broker.ts';
import {POST, GET, OPTIONS} from '../app/api/competency/attempt/route.ts';

const origin='https://candidate.test';
const endpoint=origin+B3_ENDPOINT;
const token='a'.repeat(64);
const issuedSession='b'.repeat(64);
const testId='00000000-0000-4000-8000-000000000001';
const requestKey=randomUUID();
const noStore=r=>{assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.equal(r.headers.get('access-control-allow-origin'),null);};
const json=(operation,csrf,extra={},cookies='',headers={})=>new Request(endpoint,{method:'POST',
 headers:{'content-type':'application/json',origin, ...(csrf?{'x-sc014-csrf':csrf}:{}),cookie:cookies,...headers},
 body:JSON.stringify({operation,...extra})});
function setup({failCommit=false,limiter={consume:async()=>true},now=()=>Date.now(),exchangeSession=()=>issuedSession}={}){
 const state={called:[],released:[],active:0};
 const broker=createCompetencyBroker({
  enabled:true,expectedOrigin:origin,csrfKey:Buffer.alloc(32,17),
  sourceKey:Buffer.alloc(32,19),now,trustedSource:()=> '203.0.113.10',limiter,
  acquire:async()=>{
   state.active++;let ended=false;
   return {query:async(sql,values)=>{
    state.called.push({sql,values});
    if(sql==='commit'&&(typeof failCommit==='function'?failCommit():failCommit))throw new Error('synthetic broken COMMIT: '+token);
    if(sql==='commit'){ended=true;return {rows:[]};}
    if(sql.startsWith('select private.exchange_'))return {rows:[{result:{session:exchangeSession(values[0]),expiresAt:new Date(now()+3600000).toISOString()}}]};
    if(sql.startsWith('select private.inspect_'))return {rows:[{result:{state:'not_started',revisionId:testId,version:1,durationMinutes:180,label:'Test kompetencji',company_id:'SECRET'}}]};
    if(sql.startsWith('select private.start_'))return {rows:[{result:{state:'in_progress',attemptId:testId,startedAt:new Date().toISOString(),deadlineAt:new Date(now()+10800000).toISOString(),
      test:{revisionId:testId,version:1,title:'Fikcyjne ćwiczenie',instructions:'Plan',expectedOutput:'Plan działania',durationMinutes:180,criteria:['PRIVATE']},
      draft:{text:'',version:0},company_id:'SECRET'}}]};
    if(sql.startsWith('select private.save_'))return {rows:[{result:{version:1}}]};
    if(sql.startsWith('select private.submit_')||sql.startsWith('select private.status_'))
      return {rows:[{result:{state:'submitted',attemptId:testId,company_id:'SECRET'}}]};
    return {rows:[]};
   },release:destroy=>{state.released.push({destroy,ended});state.active--;}};
  }
 });
 return {broker,state};
}
async function establish(broker){
 const pre=await broker(json('bootstrap',null,{},'',{'x-sc014-intent':'bootstrap'}));noStore(pre);
 assert.equal(pre.status,200);
 const csrf=(await pre.json()).csrf;
 const init=pre.headers.getSetCookie().find(x=>x.startsWith(B3_INIT_COOKIE+'=')).split(';')[0];
 const exchanged=await broker(json('exchange',csrf,{token},init));noStore(exchanged);
 assert.equal(exchanged.status,200);
 const body=await exchanged.json();
 assert.deepEqual(Object.keys(body).sort(),['csrf','state']);
 assert.equal(body.state,'session_established');
 const setCookie=exchanged.headers.getSetCookie().find(x=>x.startsWith(B3_SESSION_COOKIE+'='));
 assert.match(setCookie,/Secure; HttpOnly; SameSite=Strict/);
 assert.match(setCookie,/Path=\/api\/competency\/attempt/);
 assert.doesNotMatch(setCookie,/Domain=/);
 assert.ok(Number(/Max-Age=(\d+)/.exec(setCookie)[1])>11700,'180min plus receipt recovery');
 const cookie=setCookie.split(';')[0];
 assert.equal(JSON.stringify(body).includes(issuedSession),false);
 return {cookie,csrf:body.csrf,init};
}
test('default route is inert even with a fully formed request, methods never become RPC',async()=>{
 const previous=process.env.COMPETENCY_BROKER_ENABLED;
 delete process.env.COMPETENCY_BROKER_ENABLED;
 try{
  const disabled=await POST(json('bootstrap',null,{},'',{'x-sc014-intent':'bootstrap'}));
  assert.equal(disabled.status,503);noStore(disabled);
  for(const fn of [GET,OPTIONS]){const denied=fn();assert.equal(denied.status,405);noStore(denied);}
 }finally{if(previous!==undefined)process.env.COMPETENCY_BROKER_ENABLED=previous;}
});
test('POST-only broker: preflight is same-origin, custom-header protected, and response is private',async()=>{
 const {broker,state}=setup();
 const denied=await broker(new Request(endpoint,{method:'GET'}));assert.equal(denied.status,405);noStore(denied);
 const wrong=await broker(new Request(endpoint,{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test'},body:'{"operation":"bootstrap"}'}));
 assert.equal(wrong.status,403);noStore(wrong);
 const blocked=await broker(json('bootstrap',null));
 assert.equal(blocked.status,403);
 const result=await establish(broker);assert.equal(state.called.length,4);
 const inspect=await broker(json('inspect',result.csrf,{},result.cookie));assert.equal(inspect.status,200);
 assert.deepEqual(Object.keys(await inspect.json()).sort(),['durationMinutes','label','revisionId','state','version']);
 const refreshed=await broker(json('bootstrap',null,{},result.cookie,{'x-sc014-intent':'bootstrap'}));
 assert.equal(refreshed.status,200);assert.equal((await refreshed.json()).csrf,result.csrf);
 assert.equal(refreshed.headers.get('set-cookie'),null,'cannot duplicate existing session');
 assert.equal((await broker(json('inspect','0'.repeat(64),{},result.cookie))).status,403);
 assert.equal((await broker(json('inspect',result.csrf,{},''))).status,403);
 assert.equal((await broker(json('exchange','0'.repeat(64),{token},result.cookie))).status,403);
 assert.equal(state.active,0);assert.ok(state.released.every(x=>x.destroy===false && x.ended));
});
test('CSRF, strict input shapes, allowlisted in-progress/receipt projections',async()=>{
 const {broker,state}=setup();const {cookie,csrf}=await establish(broker);
 const start=await broker(json('start',csrf,{requestKey},cookie));assert.equal(start.status,200);
 const active=await start.json();assert.deepEqual(Object.keys(active.test).sort(),
   ['durationMinutes','expectedOutput','instructions','revisionId','title','version']);
 assert.equal(active.test.criteria,undefined);assert.equal(active.company_id,undefined);
 const save=await broker(json('save',csrf,{draft:'Plan',expectedVersion:0,requestKey:randomUUID()},cookie));
 assert.deepEqual(await save.json(),{version:1});
 const submit=await broker(json('submit',csrf,{answer:{workSample:'Plan wdrożenia'},requestKey:randomUUID()},cookie));
 assert.deepEqual(await submit.json(),{state:'submitted',attemptId:testId});
 const status=await broker(json('status',csrf,{},cookie));
 assert.deepEqual(await status.json(),{state:'submitted',attemptId:testId});
 const before=state.called.length;
 for(const x of [
  {operation:'inspect',session:issuedSession},
  {operation:'exchange',token,session:issuedSession},
  {operation:'save',draft:'text',expectedVersion:-1,requestKey},
  {operation:'submit',answer:{workSample:'okay',score:100},requestKey},
  {operation:'submit',answer:{workSample:34},requestKey},
  {operation:'remove',requestKey}
 ]){
  assert.equal((await broker(new Request(endpoint,{method:'POST',headers:{origin,'content-type':'application/json','x-sc014-csrf':csrf,cookie},
    body:JSON.stringify(x)}))).status,400);
 }
 assert.equal(state.called.length,before,'reject before SQL');
});
test('128KiB streaming including no Content-Length, encodings and malformed JSON',async()=>{
 const {broker,state}=setup();
 const goodHeaders={origin,'content-type':'application/json','x-sc014-intent':'bootstrap'};
 const huge=new Request(endpoint,{method:'POST',headers:goodHeaders,body:'a'.repeat(B3_MAX_BODY+1)});
 assert.equal((await broker(huge)).status,413);
 const chunked=()=>new ReadableStream({start(controller){
   controller.enqueue(new TextEncoder().encode('{"operation":"bootstrap","padding":"'));
   controller.enqueue(new Uint8Array(B3_MAX_BODY));controller.enqueue(new TextEncoder().encode('"}'));controller.close();
 }});
 assert.equal((await broker(new Request(endpoint,{method:'POST',headers:goodHeaders,body:chunked(),duplex:'half'}))).status,413);
 for(const [body,headers] of [
  ['{',goodHeaders],
  [JSON.stringify({operation:'bootstrap'}),{...goodHeaders,'content-encoding':'gzip'}],
  [JSON.stringify({operation:'bootstrap'}),{...goodHeaders,'content-type':'text/plain'}]
 ]){
  assert.notEqual((await broker(new Request(endpoint,{method:'POST',headers,body}))).status,200);
 }
 assert.equal(state.called.length,0);
});
test('uncertain transaction destroys lease, never returns cookie nor secrets',async()=>{
 const {broker,state}=setup({failCommit:true});
 const init=await broker(json('bootstrap',null,{},'',{'x-sc014-intent':'bootstrap'}));
 const {csrf}=await init.json();const cookie=init.headers.getSetCookie()[0].split(';')[0];
 const broken=await broker(json('exchange',csrf,{token},cookie));
 assert.equal(broken.status,503);assert.equal(broken.headers.get('set-cookie'),null);
 assert.doesNotMatch(await broken.text(),new RegExp(token+'|'+issuedSession+'|synthetic|commit','i'));
 assert.equal(state.released.length,1);assert.equal(state.released[0].destroy,true);
 assert.equal(state.active,0);
});
test('shared limiter failure/denial never opens a PostgreSQL connection',async()=>{
 for(const limiter of [{consume:async()=>false},{consume:async()=>{throw Error('redis lost')} }]){
  const {broker,state}=setup({limiter});const denied=await broker(json('bootstrap',null,{},'',{'x-sc014-intent':'bootstrap'}));
  assert.ok([429,503].includes(denied.status));assert.equal(state.called.length,0);noStore(denied);
 }
});


test('P2 shared limiter charges requests BEFORE reading slow streamed bodies',async()=>{
 let reads=0,charges=0;
 const limiter={consume:async()=>{charges++;return false;}};
 const {broker,state}=setup({limiter});
 const stream=new ReadableStream({pull(){reads++;}},{highWaterMark:0});
 const req=new Request(endpoint,{
  method:'POST',headers:{origin,'content-type':'application/json','x-sc014-intent':'bootstrap'},
  body:stream,duplex:'half'
 });
 const rejected=await broker(req);
 assert.equal(rejected.status,429);noStore(rejected);
 assert.equal(charges,1,'one shared limiter debit before streaming');
 assert.equal(reads,0,'body stream cannot consume CPU/memory ahead of shared limiter');
 assert.equal(state.called.length,0,'no database before admission');
 await req.body.cancel();
});


test('explicit new grant exchange uses current cookie CSRF and preserves the session on rejection',async()=>{
 const nextToken='c'.repeat(64),nextSession='d'.repeat(64),unknownToken='e'.repeat(64);
 const {broker,state}=setup({exchangeSession:value=>{
  if(value===token)return issuedSession;
  if(value===nextToken)return nextSession;
  throw Object.assign(new Error('synthetic unavailable grant'),{code:'PT404'});
 }});
 const first=await establish(broker);
 const refresh=await broker(json('bootstrap',null,{},first.cookie,{'x-sc014-intent':'bootstrap'}));
 assert.equal(refresh.status,200);assert.equal((await refresh.json()).csrf,first.csrf);
 assert.equal(refresh.headers.get('set-cookie'),null,'ordinary refresh never replaces a session');
 const pre=await broker(json('bootstrap',null,{},'',{'x-sc014-intent':'bootstrap'}));
 const preCsrf=(await pre.json()).csrf,init=pre.headers.getSetCookie()[0].split(';')[0];
 const both=first.cookie+'; '+init,before=state.called.length;
 for(const csrf of [null,'0'.repeat(64),preCsrf]) {
  const denied=await broker(json('exchange',csrf,{token:nextToken},both));
  assert.equal(denied.status,403);assert.equal(denied.headers.get('set-cookie'),null);
 }
 const crossOrigin=await broker(json('exchange',first.csrf,{token:nextToken},both,{origin:'https://other.test'}));
 assert.equal(crossOrigin.status,403);assert.equal(state.called.length,before,'wrong proof never reaches SQL');
 const changed=await broker(json('exchange',first.csrf,{token:nextToken},both));
 assert.equal(changed.status,200);noStore(changed);
 const payload=await changed.json(),cookie=changed.headers.getSetCookie().find(x=>x.startsWith(B3_SESSION_COOKIE+'=')).split(';')[0];
 assert.notEqual(cookie,first.cookie);assert.notEqual(payload.csrf,first.csrf);
 assert.equal(JSON.stringify(payload).includes(nextSession),false);
 assert.equal(state.released.at(-1).ended,true,'replacement cookie is emitted after COMMIT');
 assert.equal((await broker(json('inspect',first.csrf,{},cookie))).status,403,'old CSRF cannot authorize new cookie');
 const failed=await broker(json('exchange',payload.csrf,{token:unknownToken},cookie));
 assert.equal(failed.status,404);assert.equal(failed.headers.get('set-cookie'),null,'bad new link leaves current cookie untouched');
 assert.equal((await broker(json('inspect',payload.csrf,{},cookie))).status,200);
});

test('uncertain replacement COMMIT never publishes or clears the existing cookie',async()=>{
 let fail=false;
 const {broker,state}=setup({failCommit:()=>fail});
 const first=await establish(broker);fail=true;
 const reply=await broker(json('exchange',first.csrf,{token:'c'.repeat(64)},first.cookie));
 assert.equal(reply.status,503);assert.equal(reply.headers.get('set-cookie'),null);
 assert.equal(state.released.at(-1).destroy,true);
 fail=false;assert.equal((await broker(json('inspect',first.csrf,{},first.cookie))).status,200);
});
