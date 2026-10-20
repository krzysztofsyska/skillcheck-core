import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {startCompetencyHttps} from './helpers/competency-broker-harness.mjs';

test('B3 Chromium over real HTTPS: refresh, rotated link and second test retain safe HttpOnly session behavior',async t=>{
 const e=await startCompetencyHttps(t);
 const f=await e.seed({duration:180});
 const grant=await e.issue(f);
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 t.after(async()=>browser.close());
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const page=await context.newPage(),requests=[],errors=[];
 page.on('pageerror',error=>errors.push(error.name));
 page.on('request',request=>requests.push({url:request.url().split('#')[0],method:request.method()}));
 const openGrant=async token=>{
  // A fragment-only goto on this path is a same-document navigation. Visit a
  // fresh document without replacing the browser context or clearing cookies.
  await page.goto('about:blank');
  const [exchange]=await Promise.all([
   page.waitForResponse(reply=>reply.url()===e.origin+'/api/competency/attempt' &&
    reply.request().method()==='POST' && reply.request().postDataJSON()?.operation==='exchange',
    {timeout:15000}),
   page.goto(e.origin+'/__sc014_b3_isolated_harness__#grant='+token,{waitUntil:'domcontentloaded'})
  ]);
  assert.equal(exchange.status(),200,'new document must complete a fresh successful grant exchange');
 };
 await openGrant(grant.token);
 await page.waitForFunction(()=>document.body.dataset.state==='not_started',{timeout:15000});
 assert.equal(await page.evaluate(()=>window.__b3.scrubbedBeforeHydration),true);
 assert.equal(new URL(page.url()).hash,'');
 assert.ok(!page.url().includes(grant.token),'the fragment has been removed');
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
 const cookies=await context.cookies(); // Path-scoped cookies are absent from the root URL filter.
 const session=cookies.find(c=>c.name==='__Secure-sc014_b3_session');
 assert.ok(session,'browser accepted Secure session cookie over actual TLS');
 assert.equal(session.secure,true);assert.equal(session.httpOnly,true);
 assert.equal(session.sameSite,'Strict');assert.equal(session.path,'/api/competency/attempt');
 assert.equal(cookies.some(c=>c.value===grant.token),false,'grant secret cannot be a cookie');
 const init=cookies.find(c=>c.name==='__Secure-sc014_b3_preflight');
 assert.ok(!init,'preflight cookie cleared after exchange');
 const pre=await page.evaluate(()=>window.__b3.initial);
 assert.equal(pre.status,200);assert.equal(pre.data.state,'not_started');
 assert.equal(JSON.stringify(pre).includes('Poufny tytuł'),false);
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.body.dataset.state==='not_started',{timeout:15000});
 assert.equal(new URL(page.url()).hash,'');
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
 // The harness intentionally provides only browser test interactions;
 // no public Next candidate page B4 exists.
 const started=await page.evaluate(()=>window.__b3.op('start',{requestKey:crypto.randomUUID()}));
 assert.equal(started.status,200);assert.equal(started.data.state,'in_progress');
 assert.equal(started.data.test.title,'Poufny tytuł zadania');
 assert.equal(started.data.test.criteria,undefined);
 const save=await page.evaluate(()=>window.__b3.op('save',{draft:'Syntetyczny draft',expectedVersion:0,requestKey:crypto.randomUUID()}));
 assert.equal(save.status,200);assert.equal(save.data.version,1);
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.body.dataset.state==='in_progress',{timeout:15000});
 const resumed=await page.evaluate(()=>window.__b3.initial);
 assert.equal(resumed.data.draft.text,'Syntetyczny draft');
 assert.equal(resumed.data.deadlineAt,started.data.deadlineAt);
 // The recruiter rotates an issued link while this browser still has its old
 // HttpOnly cookie. The new link restores the existing attempt, not a retry.
 await e.h.asUser(f.owner);
 const rotated=await e.call('public.rotate_competency_test_grant',[grant.grantId,grant.revision,randomUUID()]);
 assert.equal((await page.evaluate(()=>window.__b3.op('inspect'))).status,404);
 assert.equal((await context.cookies()).find(c=>c.name==='__Secure-sc014_b3_session').value,session.value);
 await openGrant(rotated.token);
 await page.waitForFunction(()=>document.body.dataset.state==='in_progress',{timeout:15000});
 const afterRotation=await page.evaluate(()=>window.__b3.initial);
 assert.equal(afterRotation.status,200);
 assert.equal(afterRotation.data.attemptId,started.data.attemptId);
 assert.equal(afterRotation.data.deadlineAt,started.data.deadlineAt);
 assert.equal(afterRotation.data.draft.text,'Syntetyczny draft');
 const rotatedCookie=(await context.cookies()).find(c=>c.name==='__Secure-sc014_b3_session');
 assert.notEqual(rotatedCookie.value,session.value);assert.equal(rotatedCookie.httpOnly,true);
 for(const rejectedToken of [grant.token,rotated.token,'0'.repeat(64)]) {
  const denied=await page.evaluate(token=>window.__b3.op('exchange',{token}),rejectedToken);
  assert.equal(denied.status,404,'old, already exchanged and unknown tokens remain unusable');
  assert.equal((await context.cookies()).find(c=>c.name==='__Secure-sc014_b3_session').value,rotatedCookie.value,
   'failed new-link exchange preserves the working cookie');
 }
 assert.equal((await page.evaluate(()=>window.__b3.op('inspect'))).status,200);
 const receipt=await page.evaluate(()=>window.__b3.op('submit',{answer:{workSample:'Plan wdrożenia i komunikacji.'},requestKey:crypto.randomUUID()}));
 assert.equal(receipt.status,200);assert.deepEqual(Object.keys(receipt.data).sort(),['attemptId','state']);
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.body.dataset.state==='submitted',{timeout:15000});
 const status=await page.evaluate(()=>window.__b3.op('status'));
 assert.equal(status.status,200);
 assert.deepEqual(status.data,receipt.data);
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
 const second=await e.seed(),secondGrant=await e.issue(second);
 await openGrant(secondGrant.token);
 await page.waitForFunction(()=>document.body.dataset.state==='not_started',{timeout:15000});
 const secondView=await page.evaluate(()=>window.__b3.initial);
 assert.equal(secondView.status,200);
 assert.equal(secondView.data.revisionId,second.definitionId);
 assert.notEqual((await context.cookies()).find(c=>c.name==='__Secure-sc014_b3_session').value,rotatedCookie.value);
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.body.dataset.state==='not_started',{timeout:15000});
 assert.equal((await page.evaluate(()=>window.__b3.initial)).data.revisionId,second.definitionId);
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
 assert.ok(requests.every(x=>[grant.token,rotated.token,secondGrant.token,'#grant='].every(secret=>!x.url.includes(secret))));
 assert.deepEqual(errors,[],'browser page errors');
});
