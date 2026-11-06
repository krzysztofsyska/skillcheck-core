import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {activeBoot,observations} from './helpers/competency-active-fixture.mjs';
import {tlsFixture,httpsPost,httpSession} from './helpers/competency-broker-harness.mjs';
import {competencyReport} from '../lib/competency-staff.ts';

test('C2 actual enabled route uses TLS gateway login, shared Postgres limiter and complete report',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Native route evidence required');
 assert.ok(process.env.SC014_B3_TEST_PG_CA,'Disposable workflow TLS certificate required');
 let child,cleanup=async()=>{};t.after(async()=>{if(child&&child.exitCode===null){child.kill();await once(child,'exit');}await cleanup();});
 const e=await activeBoot(t,{fullChain:true}),{db,h,call}=e;
 const user='competency_gateway_c2_'+randomUUID().replaceAll('-','').slice(0,18),password=randomBytes(24).toString('hex');
 await h.asAdmin();await db.exec(`create role ${user} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
 grant competency_test_gateway to ${user} with admin false,inherit false,set true;
 alter role ${user} set log_parameter_max_length=0;alter role ${user} set log_parameter_max_length_on_error=0;`);
 cleanup=async()=>{await h.asAdmin();await db.exec(`drop role ${user}`);};
 const dir=mkdtempSync(join(tmpdir(),'scwer-route-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tls=tlsFixture(t),key=join(dir,'server.key'),cert=join(dir,'server.crt'),ca=join(dir,'trusted.pem');
 writeFileSync(key,tls.key);writeFileSync(cert,tls.cert);writeFileSync(ca,Buffer.concat([tls.cert,readFileSync(process.env.SC014_B3_TEST_PG_CA)]));
 const dsn=new URL(e.databaseUrl(e.name));dsn.hostname='sc014-broker-db.test';dsn.username=user;dsn.password=password;
 child=fork(new URL('./helpers/competency-broker-route-server.mjs',import.meta.url),[],{
  execArgv:[],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_EXTRA_CA_CERTS:ca,SC014_TEST_TLS_KEY:key,SC014_TEST_TLS_CERT:cert,
   COMPETENCY_BROKER_ENABLED:'true',COMPETENCY_CANDIDATE_PREVIEW:'true',VERCEL:'1',VERCEL_ENV:'preview',
   COMPETENCY_BROKER_GATEWAY_DATABASE_URL:dsn.toString(),COMPETENCY_BROKER_LIMITER:'postgres',
   COMPETENCY_BROKER_CSRF_KEY:randomBytes(32).toString('hex'),COMPETENCY_BROKER_SOURCE_HMAC_KEY:randomBytes(32).toString('hex')}});
 const ready=await Promise.race([once(child,'message').then(([value])=>value),once(child,'exit').then(()=>{throw new Error('Route process exited');}),
  new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Route readiness timeout')),15000);timer.unref();})]);
 const request=(operation,options={})=>httpsPost(ready.origin,tls.cert,operation,{...options,headers:{'x-forwarded-for':'203.0.113.5',...options.headers}});
 const f=await e.seed(),g=await e.issue(f),s=await httpSession({request},g);
 const start=await request('start',{cookie:s.cookie,csrf:s.csrf,body:JSON.stringify({operation:'start',requestKey:randomUUID()})});
 assert.equal(start.status,200);
 const submitted=await request('submit',{cookie:s.cookie,csrf:s.csrf,body:JSON.stringify({operation:'submit',answer:{workSample:'Plan wdrożenia obejmuje terminy i komunikację.'},requestKey:randomUUID()})});
 assert.equal(submitted.status,200);
 await h.asUser(f.owner);await call('public.save_competency_test_review',[submitted.data.attemptId,0,JSON.stringify(observations)]);
 const response=await call('public.read_competency_test_response',[submitted.data.attemptId]);
 const report=competencyReport(response,{companyId:f.companyId,recruitmentId:f.recruitment.id,applicationId:f.application.id},submitted.data.attemptId,f.definitionId,f.definition);
 assert.equal(report.confirmed[0].evidence,'Plan');assert.equal(report.review.score,null);
 assert.equal((await request('inspect',{cookie:s.cookie,csrf:'0'.repeat(64)})).status,403);
 assert.equal((await request('inspect',{cookie:s.cookie,csrf:s.csrf,headers:{origin:'https://foreign.invalid'}})).status,403);
 let limited;for(let i=0;i<20;i++){limited=await request('status',{cookie:s.cookie,csrf:s.csrf});if(limited.status===429)break;}
 assert.equal(limited.status,429);assert.doesNotMatch(limited.raw,/candidate|application|token|digest/i);
 await h.asAdmin();const sessions=(await db.query('select s.ssl from pg_stat_activity a join pg_stat_ssl s on s.pid=a.pid where a.usename=$1',[user])).rows;
 assert.ok(sessions.some(row=>row.ssl),'actual construct() pool uses TLS');
});
