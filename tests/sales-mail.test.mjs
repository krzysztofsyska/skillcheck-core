import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {salesMailTemplateV1} from '../lib/sales-mail-template.ts';
import {sendSalesMail,dispatchSalesMail,authorizedMailWorker,mailSignature,mailEnabled} from '../lib/sales-mail.ts';
const job={lead_id:randomUUID(),lease_id:randomUUID(),email:'test@example.test',template_version:'v1'};
const env={SALES_AUTO_REPLY_ENABLED:'true',VERCEL_ENV:'production',RESEND_API_KEY:'fixture',SALES_MAIL_WORKER_SECRET:'x'.repeat(32)};
test('automatic wording, reply mailbox and no fabricated personal review',()=>{
 const m=salesMailTemplateV1();assert.equal(m.reply_to,'pomoc@skillcheck.pl');assert.match(m.text,/automatyczne potwierdzenie/);
 assert.match(m.text,/Nie musisz powtarzać/);assert.match(m.html,/<html lang="pl">/);assert.match(m.text,/nie przesyłaj CV/);
 assert.doesNotMatch(m.text,/przeczytałem|zapoznałem|24 godzin/);assert.match(m.text,/KTIG CONSULTING/);
});
test('disabled or preview makes no RPC/provider calls',async()=>{
 const store={claim(){throw Error('must not run')}};
 for(const e of [{},{...env,VERCEL_ENV:'preview'},{...env,SALES_AUTO_REPLY_ENABLED:'false'},{...env,SALES_MAIL_WORKER_SECRET:'short'}]) {
  assert.equal(mailEnabled(e),false);assert.equal(await dispatchSalesMail(store,null,e),'disabled');
 }
});
test('one database recipient, stable provider idempotency key, no applicant content',async()=>{
 const calls=[];const id=randomUUID(); const fetcher=async(url,opts)=>{calls.push({url,...opts});return Response.json({id});};
 for(let i=0;i<2;i++) assert.deepEqual(await sendSalesMail({...job,needs:'private',phone:'private'},'fixture',fetcher),{outcome:'accepted',provider:id});
 assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);assert.equal(calls[0].body,calls[1].body);
 const payload=JSON.parse(calls[0].body);assert.deepEqual(payload.to,[job.email]);assert.ok(!('bcc' in payload));assert.doesNotMatch(calls[0].body,/private/);
 assert.equal(calls[0].redirect,'error');assert.equal(calls[0].url,'https://api.resend.com/emails');
});
test('header injection/multiple recipients/unknown template rejected without network',async()=>{
 for(const patch of [{email:'a@test.pl,b@test.pl'},{email:'a\r\nBcc:b@test.pl'},{template_version:'v2'},{lead_id:'../evil'}]) {
  assert.equal((await sendSalesMail({...job,...patch},'x',()=>{throw Error('must not run')})).outcome,'failed');
 }
});
test('transient errors retry, permanent failures stop, malformed acceptance stays uncertain',async()=>{
 for(const code of [408,409,429,500,503]) assert.equal((await sendSalesMail(job,'x',async()=>new Response('',{status:code}))).outcome,'retry');
 for(const code of [400,401,403,422]) assert.equal((await sendSalesMail(job,'x',async()=>new Response('',{status:code}))).outcome,'failed');
 assert.equal((await sendSalesMail(job,'x',async()=>{throw Error('timeout')})).outcome,'retry');
 assert.equal((await sendSalesMail(job,'x',async()=>Response.json({}))).outcome,'retry');
});
test('worker endpoint authentication fails closed',()=>{
 const s='y'.repeat(32);assert.equal(authorizedMailWorker('Bearer '+s,s),true);
 for(const h of [null,'','Bearer short','Bearer '+'z'.repeat(32)]) assert.equal(authorizedMailWorker(h,s),false);
 assert.equal(authorizedMailWorker('Bearer undefined',undefined),false);
});
test('claim, send, finish uses signed scope and failed finish remains unconfirmed',async()=>{
 let observed;const id=randomUUID();const store={
  async claim(target,lease,stamp,signature){assert.equal(signature,mailSignature('claim',target,lease,stamp,null,null,env.SALES_MAIL_WORKER_SECRET));return {...job,lease_id:lease};},
  async finish(j,stamp,outcome,provider,signature){observed=outcome;assert.equal(signature,mailSignature('finish',j.lead_id,j.lease_id,stamp,outcome,provider,env.SALES_MAIL_WORKER_SECRET));return false;}
 };
 assert.equal(await dispatchSalesMail(store,job.lead_id,env,async()=>Response.json({id})),'unconfirmed');assert.equal(observed,'accepted');
});
