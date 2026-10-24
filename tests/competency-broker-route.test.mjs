import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {startCompetencyHttps,httpsPost,httpSession,findCookie} from './helpers/competency-broker-harness.mjs';

test('B3 actual enabled route -> production construct -> trusted TLS PostgreSQL16 and Redis REST',async t=>{
 assert.ok(process.env.SC014_B3_TEST_PG_CA,'The isolated workflow must provision a trusted PostgreSQL TLS certificate');
 let child;
 t.after(async()=>{if(child && child.exitCode===null){child.kill();await once(child,'exit');}});
 const e=await startCompetencyHttps(t,{redis:false});
 const dir=mkdtempSync(join(tmpdir(),'sc014-b3-route-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const key=join(dir,'server.key'),cert=join(dir,'server.crt'),ca=join(dir,'trusted.pem');
 execFileSync('openssl',['req','-x509','-nodes','-newkey','rsa:2048','-days','1',
  '-keyout',key,'-out',cert,'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 writeFileSync(ca,Buffer.concat([readFileSync(cert),readFileSync(process.env.SC014_B3_TEST_PG_CA)]));
 const dsn=new URL('postgresql://sc014-broker-db.test');
 dsn.username=e.user;dsn.password=e.password;dsn.port=String(e.connectionConfig.port||5432);dsn.pathname='/'+e.databaseName;
 child=fork(new URL('./helpers/competency-broker-route-server.mjs',import.meta.url),[],{
  execArgv:[],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,
   NODE_EXTRA_CA_CERTS:ca,SC014_TEST_TLS_KEY:key,SC014_TEST_TLS_CERT:cert,
   COMPETENCY_BROKER_ENABLED:'true',VERCEL:'1',COMPETENCY_BROKER_GATEWAY_DATABASE_URL:dsn.toString(),
   COMPETENCY_BROKER_CSRF_KEY:randomBytes(32).toString('hex'),
   COMPETENCY_BROKER_SOURCE_HMAC_KEY:randomBytes(32).toString('hex'),
   COMPETENCY_BROKER_LIMITER_REST_TOKEN:'isolated-route-fixture-token'}});
 const ready=await Promise.race([
  once(child,'message').then(([message])=>message),
  once(child,'exit').then(()=>{throw Error('Isolated route server exited before readiness');}),
  new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(Error('Route server readiness timeout')),15000);timeout.unref();})
 ]);
 const request=(operation,options={})=>httpsPost(ready.origin,readFileSync(cert),operation,
  {...options,headers:{'x-forwarded-for':'203.0.113.136',...options.headers}});
 const f=await e.seed(),grant=await e.issue(f);
 let session=await httpSession({request},grant);
 const inspected=await request('inspect',{cookie:session.cookie,csrf:session.csrf});
 assert.equal(inspected.status,200,inspected.raw);assert.equal(inspected.data.state,'not_started');
 const started=await request('start',{cookie:session.cookie,csrf:session.csrf,
  body:JSON.stringify({operation:'start',requestKey:randomUUID()})});
 assert.equal(started.status,200,started.raw);assert.equal(started.data.state,'in_progress');
 const saved=await request('save',{cookie:session.cookie,csrf:session.csrf,
  body:JSON.stringify({operation:'save',draft:'Syntetyczny draft po rotacji',expectedVersion:0,requestKey:randomUUID()})});
 assert.equal(saved.status,200);
 await e.h.asUser(f.owner);
 const rotated=await e.call('public.rotate_competency_test_grant',[grant.grantId,grant.revision,randomUUID()]);
 assert.equal((await request('inspect',{cookie:session.cookie,csrf:session.csrf})).status,404);
 const previous=session;
 const renewedCsrf=await request('bootstrap',{cookie:previous.cookie,headers:{'x-sc014-intent':'bootstrap'}});
 assert.equal(renewedCsrf.status,200);assert.equal(renewedCsrf.headers['set-cookie'],undefined);
 const replacement=await request('exchange',{cookie:previous.cookie,csrf:renewedCsrf.data.csrf,
  body:JSON.stringify({operation:'exchange',token:rotated.token})});
 assert.equal(replacement.status,200,replacement.raw);
 session={cookie:findCookie(replacement,'__Secure-sc014_b3_session'),csrf:replacement.data.csrf};
 assert.notEqual(session.cookie,previous.cookie);
 const recovered=await request('inspect',{cookie:session.cookie,csrf:session.csrf});
 assert.equal(recovered.status,200);assert.equal(recovered.data.deadlineAt,started.data.deadlineAt);
 assert.equal(recovered.data.draft.text,'Syntetyczny draft po rotacji');
 await e.h.asAdmin();
 const connections=(await e.db.query('select s.ssl from pg_stat_activity a join pg_stat_ssl s on s.pid=a.pid where a.usename=$1',[e.user])).rows;
 assert.ok(connections.some(row=>row.ssl===true),'actual production pool authenticated over TLS');
 for(const headers of [ {'x-forwarded-for':'203.0.113.136, 198.51.100.1'}, {'x-forwarded-for':'invalid'}, {'x-forwarded-for':''} ]) {
  const rejected=await request('inspect',{cookie:session.cookie,csrf:session.csrf,headers});
  assert.equal(rejected.status,503,'untrusted/invalid ingress source denied by production adapter');
 }
 await e.db.exec('grant select on public.applications to competency_test_gateway');
 try {
  const denied=await request('inspect',{cookie:session.cookie,csrf:session.csrf});
  assert.equal(denied.status,503);assert.equal(denied.headers['set-cookie'],undefined);
  assert.doesNotMatch(denied.raw,/applications|SELECT|token|password|postgres/i);
 } finally {await e.db.exec('revoke select on public.applications from competency_test_gateway');}
 assert.equal((await request('inspect',{cookie:session.cookie,csrf:session.csrf})).status,200);
});
