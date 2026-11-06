import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {activeBoot,users,observations} from './helpers/competency-active-fixture.mjs';
import {tlsFixture} from './helpers/competency-broker-harness.mjs';
import {createCompetencyBroker,B3_ENDPOINT} from '../lib/competency-attempt-broker.ts';
import {GET} from '../app/zadanie-kompetencyjne/route.ts';
import {competencyReport,parseCompetencyAccess} from '../lib/competency-staff.ts';

test('C1-C3 synthetic journey: shortlist, issued invitation, browser answer, human evidence and report',async t=>{
 const e=await activeBoot(t,{fullChain:true}),{db,h,call}=e;
 const f=await e.seed();await h.asAdmin();
 await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",[f.companyId,users.recruiter]);
 await h.asUser(users.recruiter);
 const g=await call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()]);
 await e.asGateway();
 for(const [key,value] of Object.entries({VERCEL_ENV:'preview',COMPETENCY_BROKER_ENABLED:'true',COMPETENCY_CANDIDATE_PREVIEW:'true'})){
  const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
 }
 let broker,origin;
 const server=createServer(tlsFixture(t),async(req,res)=>{
  try{
   const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:req,duplex:'half'}:{})});
   const reply=req.url==='/zadanie-kompetencyjne'?GET(request):req.url===B3_ENDPOINT?await broker(request):new Response(null,{status:404});
   for(const [key,value] of reply.headers)if(key!=='set-cookie')res.setHeader(key,value);
   res.setHeader('set-cookie',reply.headers.getSetCookie());res.writeHead(reply.status).end(await reply.text());
  }catch{res.writeHead(500).end();}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 origin='https://127.0.0.1:'+server.address().port;
 broker=createCompetencyBroker({enabled:true,expectedOrigin:origin,csrfKey:randomBytes(32),sourceKey:randomBytes(32),
  trustedSource:()=> '127.0.0.1',
  limiter:{consume:(source,window)=>call('private.consume_competency_rate_limit',[source,window])},
  acquire:async()=>({query:(sql,values)=>db.query(sql,values),release(){}})});
 const browser=await chromium.launch({headless:true,executablePath:process.env.SKILLCHECK_TEST_CHROME});t.after(()=>browser.close());
 const page=await browser.newPage({ignoreHTTPSErrors:true});
 await page.goto(origin+'/zadanie-kompetencyjne#grant='+g.token);
 await page.getByRole('button',{name:'Rozpocznij zadanie'}).click();assert.equal(new URL(page.url()).hash,'');
 const answer='Plan wdrożenia obejmuje terminy i komunikację.';
 await page.getByLabel('Twoja odpowiedź').fill(answer);await page.getByRole('button',{name:'Zapisz szkic'}).click();
 await page.getByText('Szkic zapisany.').waitFor();await page.reload();
 await page.getByLabel('Twoja odpowiedź').waitFor();assert.equal(await page.getByLabel('Twoja odpowiedź').inputValue(),answer);
 const sent=page.waitForResponse(r=>r.request().postDataJSON()?.operation==='submit');
 await page.getByRole('button',{name:'Wyślij odpowiedź ostateczną'}).click();const {attemptId}=await(await sent).json();
 await page.getByText('Odpowiedź została przyjęta.').waitFor();
 await h.asUser(users.recruiter);
 assert.equal(parseCompetencyAccess(await call('public.list_competency_test_access',[f.application.id])).access[0].state,'submitted');
 await call('public.save_competency_test_review',[attemptId,0,JSON.stringify(observations)]);
 const response=await call('public.read_competency_test_response',[attemptId]);
 const report=competencyReport(response,{companyId:f.companyId,recruitmentId:f.recruitment.id,applicationId:f.application.id},attemptId,f.definitionId,f.definition);
 assert.equal(report.answer,answer);assert.equal(report.confirmed[0].evidence,'Plan');assert.deepEqual(report.missing,['Komunikacja']);assert.equal(report.review.score,null);
 await h.asUser(users.otherOwner);await assert.rejects(call('public.read_competency_test_response',[attemptId]),e=>['42501','PT404'].includes(e.code));
});
