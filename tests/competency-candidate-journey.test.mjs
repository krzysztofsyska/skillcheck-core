import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { boot, users } from './helpers/competency-attempt-fixture.mjs';
import { tlsFixture } from './helpers/competency-broker-harness.mjs';
import { createCompetencyBroker, B3_ENDPOINT } from '../lib/competency-attempt-broker.ts';
import { GET } from '../app/zadanie-kompetencyjne/route.ts';
import { staffWorkSample } from '../lib/competency-staff-response.ts';

test('one-time invitation, browser draft recovery, submission and recruiter readback', async t => {
  const e = await boot(t, {embedded:true});
  const f = await e.seed();
  await e.h.asAdmin();
  await e.db.query("insert into public.company_members(company_id,user_id,role) values ($1,$2,'recruiter')", [f.companyId, users.recruiter]);
  await e.h.asUser(users.recruiter);
  const grant = await e.call('public.create_competency_test_grant', [
    f.application.id, f.definitionId, new Date(Date.now()+3600000).toISOString(), randomUUID(),
  ]);
  await e.asGateway();
  for (const [key,value] of Object.entries({VERCEL_ENV:'preview',COMPETENCY_BROKER_ENABLED:'true',COMPETENCY_CANDIDATE_PREVIEW:'true'})) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const path = '/zadanie-kompetencyjne';
  let broker, origin;
  const server = createServer(tlsFixture(t), async (req,res) => {
    try {
      const request = new Request(origin+req.url, {method:req.method, headers:req.headers,
        ...(req.method === 'POST' ? {body:req,duplex:'half'} : {})});
      const reply = req.url === path ? GET(request) : req.url === B3_ENDPOINT ? await broker(request) : new Response(null,{status:404});
      for (const [name,value] of reply.headers) if (name !== 'set-cookie') res.setHeader(name,value);
      res.setHeader('set-cookie',reply.headers.getSetCookie());
      res.writeHead(reply.status).end(await reply.text());
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  origin = 'https://127.0.0.1:'+server.address().port;
  broker = createCompetencyBroker({enabled:true,expectedOrigin:origin,csrfKey:randomBytes(32),sourceKey:randomBytes(32),
    trustedSource:()=> '127.0.0.1', limiter:{consume:async()=>true},
    acquire:async()=>({query:(sql,values)=>e.db.query(sql,values),release(){}})});
  const browser = await chromium.launch({headless:true,executablePath:process.env.SKILLCHECK_TEST_CHROME});
  t.after(() => browser.close());
  const page = await browser.newPage({ignoreHTTPSErrors:true});
  await page.goto(origin+path+'#grant='+grant.token);
  await page.getByRole('button',{name:'Rozpocznij zadanie'}).click();
  assert.equal(new URL(page.url()).hash,'');
  const answer = 'Plan wdrożenia obejmuje terminy i komunikację.';
  await page.getByLabel('Twoja odpowiedź').fill(answer);
  await page.getByRole('button',{name:'Zapisz szkic'}).click();
  await page.getByText('Szkic zapisany.').waitFor();
  await page.reload();
  await page.getByLabel('Twoja odpowiedź').waitFor();
  assert.equal(await page.getByLabel('Twoja odpowiedź').inputValue(),answer);
  const receipt = page.waitForResponse(r=>r.request().postDataJSON()?.operation==='submit');
  await page.getByRole('button',{name:'Wyślij odpowiedź ostateczną'}).click();
  const {attemptId} = await (await receipt).json();
  await page.getByText('Odpowiedź została przyjęta.').waitFor();
  await e.h.asUser(users.recruiter);
  const attempts = await e.call('public.list_competency_test_attempts',[f.application.id]);
  assert.deepEqual(attempts.map(row=>[row.id,row.state]),[[attemptId,'submitted']]);
  const read = await e.call('public.read_competency_test_response',[attemptId]);
  assert.equal(read.definitionId,f.definitionId);
  const scope={companyId:f.companyId,recruitmentId:f.recruitment.id,applicationId:f.application.id};
  assert.equal(staffWorkSample(read,scope,attemptId),answer);
  assert.throws(()=>staffWorkSample(read,{...scope,applicationId:randomUUID()},attemptId));
  await e.h.asUser(users.otherOwner);
  await assert.rejects(e.call('public.read_competency_test_response',[attemptId]),err=>['42501','PT404'].includes(err.code));
});
