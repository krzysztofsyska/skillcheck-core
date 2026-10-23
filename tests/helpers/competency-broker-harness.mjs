/**
 * Test-only SC-014-B3 server. This file is never imported by Next production.
 * A real PostgreSQL16 DB, a restricted LOGIN, real HTTPS and (in CI) Redis
 * are mandatory. No fixture data is real candidate data.
 */
import assert from 'node:assert/strict';
import {createServer as createHttpsServer} from 'node:https';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {boot, b2Tables} from './competency-attempt-fixture.mjs';
import {competencyBrokerMethodDenied,B3_ENDPOINT} from '../../lib/competency-attempt-broker.ts';
import {createCompetencyGatewayRuntime} from '../../lib/competency-attempt-broker-runtime.ts';
import {verifyCompetencyGateway} from '../../lib/competency-broker-role.ts';
import {createRedisRestLimiter} from '../../lib/competency-broker-limiter.ts';

function tlsFixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'sc014-b3-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const key=join(dir,'tls.key'),cert=join(dir,'tls.crt');
 execFileSync('openssl',['req','-x509','-nodes','-newkey','rsa:2048','-days','1',
  '-keyout',key,'-out',cert,'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],
  {stdio:'ignore'});
 return {key:readFileSync(key),cert:readFileSync(cert)};
}

function redisRestTestAdapter(options) {
 // Execute exactly the EVAL command produced by the production REST adapter
 // against the real disposable Redis 7 service; no in-memory fake limiter.
 return async (_url, init)=>{
  assert.equal(init.method,'POST');
  assert.match(init.headers.Authorization,/^Bearer /);
  const command=JSON.parse(init.body);
  assert.equal(command[0],'EVAL');assert.equal(command[2],2);
  const result=execFileSync('redis-cli',['-h','127.0.0.1','-p','6379','--raw',
    ...command.map(String)],{encoding:'utf8',timeout:2000}).trim();
  if(!/^[01]$/.test(result))return Response.json({error:'eval_failed'},{status:400});
  return Response.json({result:Number(result)});
 };
}
export function createSharedLimiter(limits={global:200,source:40}) {
 return createRedisRestLimiter('https://redis.invalid.example','isolated-fixture-token',
  redisRestTestAdapter(),limits);
}
export async function startCompetencyHttps(t,{redis=true,source='203.0.113.1',limits={global:200,source:40}}={}){
 // Register cleanup ahead of B2's disposable database drop hook.
 let cleanupRole=async()=>{};
 t.after(async()=>cleanupRole());
 const e=await boot(t,{embedded:false});
 const {db,h}=e;await h.asAdmin();
 const user='competency_gateway_b3_'+randomUUID().replaceAll('-','').slice(0,18);
 const password=randomBytes(24).toString('hex');
 await db.exec('create role '+user+" login password '"+password+"' nosuperuser nocreatedb nocreaterole noinherit nobypassrls;grant competency_test_gateway to "+user);
 // Restricted LOGIN is configured by the isolated test-only PostgreSQL
 // administrator; deployed clusters must be provisioned separately.
 await db.exec('alter role '+user+' set log_parameter_max_length=0');
 const pool=new Pool({...e.connectionConfig,user,password,max:4,connectionTimeoutMillis:2000,idleTimeoutMillis:5000,query_timeout:7000,
  options:'-c statement_timeout=5000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=8000'});
 cleanupRole=async()=>{await pool.end();await h.asAdmin();await db.exec('drop role '+user);};
 const direct=await pool.connect();
 try{
  assert.equal((await direct.query("select session_user name")).rows[0].name,user);
  const memberships=(await direct.query(
    "select count(*)::int n,coalesce(bool_and(parent.rolname='competency_test_gateway'),false) only_gateway " +
    "from pg_auth_members m join pg_roles parent on parent.oid=m.roleid " +
    "join pg_roles child on child.oid=m.member where child.rolname=session_user"
  )).rows[0];
  assert.deepEqual(memberships,{n:1,only_gateway:true});
  const logs=(await direct.query(
    "select current_setting('log_statement') statements, " +
    "current_setting('log_parameter_max_length') success_parameters, " +
    "current_setting('log_parameter_max_length_on_error') error_parameters"
  )).rows[0];
  assert.equal(logs.statements,'none');assert.equal(logs.success_parameters,'0');assert.equal(logs.error_parameters,'0');
  await verifyCompetencyGateway(direct,user);
  for(const table of b2Tables){
   await assert.rejects(direct.query('select * from '+table),x=>x.code==='42501');
  }
  await assert.rejects(direct.query('set role authenticated'),x=>x.code==='42501');
  await assert.rejects(direct.query('select public.create_competency_test_grant($1,$2,$3,$4)',
   [randomUUID(),randomUUID(),new Date().toISOString(),randomUUID()]),x=>x.code==='42501');
 }finally{direct.release(true);}
 const tls=tlsFixture(t);
 let broker,origin;
 const server=createHttpsServer(tls,async(req,res)=>{
  try{
   const path=new URL(req.url,'https://127.0.0.1').pathname;
   if(path==='/__sc014_b3_isolated_harness__'){
    const nonce=randomBytes(18).toString('base64');
    res.writeHead(200,{
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; connect-src 'self'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(browserHarnessHtml(nonce));return;
   }
   if(path!==B3_ENDPOINT){res.writeHead(404,{'Cache-Control':'no-store'});res.end();return;}
   const method=req.method||'GET';
   const request=new Request(origin+B3_ENDPOINT,{method,headers:req.headers,
     ...(method==='POST'?{body:req,duplex:'half'}:{})});
   const reply=method==='POST'?await broker(request):competencyBrokerMethodDenied();
   for(const [key,value] of reply.headers){
    if(key!=='set-cookie')res.setHeader(key,value);
   }
   const cookies=reply.headers.getSetCookie();
   if(cookies.length)res.setHeader('Set-Cookie',cookies);
   res.statusCode=reply.status;
   res.end(Buffer.from(await reply.arrayBuffer()));
  }catch{
   res.writeHead(503,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
   res.end('{"error":"unavailable"}');
  }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 origin='https://127.0.0.1:'+server.address().port;
 const csrfKey=randomBytes(32),sourceKey=randomBytes(32);
 const limiter=redis?createSharedLimiter(limits):{consume:async()=>true};
 let acquired=0;
 // Exercise the SAME enabled adapter as Vercel, with a disposable PG Pool.
 // No impersonated gateway query path or test-only production downgrade.
 const handler=()=>createCompetencyGatewayRuntime({
   expectedOrigin:origin,expectedUser:user,csrfKey,sourceKey,limiter,pool,
   trustedSource:()=>source,onConnection:()=>{acquired++;}
 });
 broker=handler();
 return {...e,user,password,pool,origin,cert:tls.cert,server,
  request:(operation,options={})=>httpsPost(origin,tls.cert,operation,options),
  secondInstance:handler,get acquired(){return acquired;}};
}

export function browserHarnessHtml(nonce){
 // The inline script runs in the HEAD before markup and before any hydration
 // or telemetry. No public Next route imports this test-only harness.
 return '<!doctype html><html lang="pl"><head><meta charset="utf-8">'+
 '<script nonce="'+nonce+'">'+
 '(function(){ "use strict";'+
 'let grant=location.hash.startsWith("#grant=")?location.hash.slice(7):null;'+
 'history.replaceState(null,"",location.pathname);'+
 'const scrubbed=!location.hash;let csrf=null;const endpoint="/api/competency/attempt";'+
 'async function post(operation,extra){'+
 'const init={method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(Object.assign({operation},extra||{}))};'+
 'if(operation==="bootstrap")init.headers["x-sc014-intent"]="bootstrap";'+
 'else init.headers["x-sc014-csrf"]=csrf;'+
 'const res=await fetch(endpoint,init);return {status:res.status,data:await res.json()};}'+
 'window.__b3={scrubbedBeforeHydration:scrubbed,op:async function(operation,extra){return post(operation,extra);}};'+
 '(async function(){try{let pre=await post("bootstrap");csrf=pre.data.csrf;'+
 'if(grant){let result=await post("exchange",{token:grant});grant=null;if(result.status!==200)throw Error("exchange denied");csrf=result.data.csrf;}'+
 'let inspect=await post("inspect");window.__b3.initial=inspect;'+
 'document.body.dataset.state=inspect.data.state||"denied";'+
 '}catch(e){grant=null;document.body.dataset.state="denied";}})();'+
 '})();'+
 '</script></head><body data-state="starting"><main>SC-014-B3 isolated synthetic harness</main></body></html>';
}
export function httpsPost(origin,cert,operation,{csrf,cookie,headers,body}={}){
 return new Promise((resolve,reject)=>{
  const https=requireHttps();
  const text=body??JSON.stringify({operation});
  const req=https.request(origin+B3_ENDPOINT,{method:'POST',ca:cert,
    headers:{origin,'content-type':'application/json',...(csrf?{'x-sc014-csrf':csrf}:{}),
      ...(cookie?{cookie}:{}),...headers}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
      const raw=Buffer.concat(chunks).toString('utf8');
      let data=null;try{data=JSON.parse(raw);}catch{}
      resolve({status:res.statusCode,headers:res.headers,data,raw});
    });
  });req.on('error',reject);req.end(text);
 });
}
function requireHttps(){return httpsModule;}
import * as httpsModule from 'node:https';
export function findCookie(response,name){
 const cookies=response.headers['set-cookie']||[];
 const cookie=cookies.find(c=>c.startsWith(name+'='));
 return cookie?.split(';')[0]||null;
}
export async function httpSession(e,grant){
 const pre=await e.request('bootstrap',{headers:{'x-sc014-intent':'bootstrap'}});
 assert.equal(pre.status,200);
 const init=findCookie(pre,'__Secure-sc014_b3_preflight');
 const exchanged=await e.request('exchange',{cookie:init,csrf:pre.data.csrf,body:JSON.stringify({operation:'exchange',token:grant.token})});
 assert.equal(exchanged.status,200,exchanged.raw);
 return {cookie:findCookie(exchanged,'__Secure-sc014_b3_session'),csrf:exchanged.data.csrf};
}
