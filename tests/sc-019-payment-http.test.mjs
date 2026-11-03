import test from 'node:test';
import assert from 'node:assert/strict';
import { createSc19PaymentHttp } from '../lib/sc19-payment-http.ts';
import { resolveSc19PaymentRuntime,composeSc19PaymentRuntime } from '../lib/sc19-payment-runtime.ts';
import { Sc19PaymentError } from '../lib/sc19-payments.ts';
const id='00000000-0000-4000-8000-000000000001';
const origin='https://app.fixture.invalid';
function harness(extra={}) {
 const calls=[];
 const runtime={appOrigin:origin,signatureHeader:'fixture-signature',
  authenticate:async()=>({userId:id}),
  service:{checkoutEnabled:extra.checkoutEnabled??true,checkout:async input=>{calls.push(input);return {orderId:id,url:'https://pay.fixture.invalid/session'};},
   notification:async (bytes,signature)=>{calls.push({bytes,signature});if(signature!=='valid')throw Error('secret diagnostic');return {state:'applied'};}},
  readOrder:async()=>({id,status:'paid',credits:12,amountMinor:12345,currency:'PLN',termsRevision:'fixture',paymentId:'private-payment'}),
  listOffers:async()=>[],...extra};
 return {http:createSc19PaymentHttp(runtime),calls};
}
const checkout=(body='{}',headers={})=>new Request(origin+'/api/billing/checkout',{method:'POST',headers:{origin,'content-type':'application/json',...headers},body});
test('deployment has no provider registration and all routes fail closed',async()=>{
 assert.equal(await resolveSc19PaymentRuntime(),null);const h=createSc19PaymentHttp(null);
 for(const r of [await h.checkout(checkout()),await h.offers(new Request(origin)),await h.order(new Request(origin),id),await h.webhook(checkout())])assert.equal(r.status,503);
});
test('without a provider the read-only catalog serves offers while every write route stays refused',async()=>{
 const seen=[];
 const catalog={authenticate:async()=>({userId:id}),
  async listOffers(companyId,userId){seen.push([companyId,userId]);return [{id:'preselekcja',revision:'v2',plan:'PRESELEKCJA',
   active:true,approved:true,amountMinor:30000,currency:'PLN',credits:60,termsRevision:'terms-v2',
   termsText:'Warunki z polskimi znakami: ą, ć, ę.',validUntilMs:Date.now()+86400000}];}};
 const h=createSc19PaymentHttp(null,catalog);
 // Only the catalog read answers; registering a transaction needs a provider.
 for(const r of [await h.checkout(checkout()),await h.order(new Request(origin+'?companyId='+id),id),await h.webhook(checkout())]){
  assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'SC19_PAYMENTS_DISABLED'});
 }
 const r=await h.offers(new Request(origin+'/api/billing/offers?companyId='+id));
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const body=await r.json();
 assert.equal(body.checkoutAvailable,false,'the client is told checkout is unavailable, never that it works');
 assert.equal(body.offers.length,1);
 const [offer]=body.offers;
 // Gross stays authoritative; net and VAT are derived from it.
 assert.equal(offer.amountMinor,30000);assert.equal(offer.netMinor,24390);
 assert.equal(offer.vatMinor,5610);assert.equal(offer.vatBasisPoints,2300);
 assert.equal(offer.netMinor+offer.vatMinor,offer.amountMinor);
 assert.deepEqual(seen,[[id,id]],'the company id is validated and the user comes from the server session');
 // Authorization is unchanged: anonymous and malformed tenants never reach the store.
 assert.equal((await createSc19PaymentHttp(null,{...catalog,authenticate:async()=>null})
  .offers(new Request(origin+'?companyId='+id))).status,403);
 assert.equal((await h.offers(new Request(origin+'?companyId=not-a-uuid'))).status,400);
 assert.equal(seen.length,1);
 // A store refusal (owner / verified-company check) surfaces as 403, not as data.
 const denied=createSc19PaymentHttp(null,{...catalog,listOffers:async()=>{throw new Sc19PaymentError('SC19_PAYMENT_FORBIDDEN');}});
 assert.equal((await denied.offers(new Request(origin+'?companyId='+id))).status,403);
});
test('a composed provider takes precedence over the read-only catalog for offers',async()=>{
 let catalogReads=0;
 const catalog={authenticate:async()=>({userId:id}),async listOffers(){catalogReads++;return [];}};
 const live=createSc19PaymentHttp({appOrigin:origin,signatureHeader:'fixture-signature',authenticate:async()=>({userId:id}),
  service:{checkoutEnabled:true},readOrder:async()=>null,
  listOffers:async()=>[{id:'live-offer',revision:'v1',amountMinor:12345,currency:'PLN',credits:12,
   termsRevision:'t',termsText:'x',validUntilMs:Date.now()+86400000}]},catalog);
 const response=await live.offers(new Request(origin+'?companyId='+id));
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.checkoutAvailable,true);
 assert.equal(body.offers[0].id,'live-offer');
 assert.equal(catalogReads,0,'the gated catalog is not consulted once a provider is composed');
});
test('CSRF, missing Origin, forged Host, wrong media type and anonymous user are denied',async()=>{
 for(const headers of [{origin:'https://evil.invalid'},{origin:''},{origin:'https://evil.invalid',host:'app.fixture.invalid'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}]){
  const h=harness();const r=await h.http.checkout(checkout('{}',headers));assert.ok([403,415].includes(r.status));assert.equal(h.calls.length,0);
 }
 const h=harness({authenticate:async()=>null});assert.equal((await h.http.checkout(checkout())).status,403);
});
test('bounded streams reject oversized JSON and raw notifications, not just content-length',async()=>{
 const h=harness();assert.equal((await h.http.checkout(checkout('x'.repeat(4097)))).status,413);
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(262145));c.close();}});
 const r=await h.http.webhook(new Request(origin,{method:'POST',body:stream,duplex:'half',headers:{'fixture-signature':'valid'}}));
 assert.equal(r.status,413);assert.equal(h.calls.length,0);
});
test('malformed JSON has no effects; valid response omits provider session metadata',async()=>{
 const h=harness();assert.equal((await h.http.checkout(checkout('{'))).status,400);assert.equal(h.calls.length,0);
 const r=await h.http.checkout(checkout());assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.deepEqual(await r.json(),{orderId:id,status:'awaiting_payment',checkoutUrl:'https://pay.fixture.invalid/session'});
});
test('raw signed bytes are unchanged and fulfillment survives checkout disablement',async()=>{
 const h=harness({checkoutEnabled:false});assert.equal((await h.http.checkout(checkout())).status,503);
 const raw=' { "x":  1 }\n';const r=await h.http.webhook(new Request(origin,{method:'POST',headers:{'fixture-signature':'valid'},body:raw}));
 assert.equal(r.status,200);assert.equal(new TextDecoder().decode(h.calls[0].bytes),raw);
});
test('verification and persistence exceptions never produce a success acknowledgment or leak details',async()=>{
 const h=harness();const r=await h.http.webhook(new Request(origin,{method:'POST',body:'{}'}));assert.equal(r.status,503);
 assert.equal((await r.text()).includes('secret diagnostic'),false);
 const broken=harness({service:{notification:async()=>{throw Error('database password');}}});
 assert.equal((await broken.http.webhook(new Request(origin,{method:'POST',body:'{}'}))).status,503);
});
test('order status requires auth and valid tenant/id; response reveals no payment identity',async()=>{
 const h=harness();assert.equal((await h.http.order(new Request(origin+'?companyId=bad'),id)).status,400);
 const r=await h.http.order(new Request(origin+'?companyId='+id),id);assert.equal(r.status,200);assert.equal((await r.json()).paymentId,undefined);
 assert.equal((await harness({authenticate:async()=>null}).http.order(new Request(origin+'?companyId='+id),id)).status,403);
});
test('composition refuses untrusted origins and invalid signature header names',()=>{
 for(const appOrigin of ['https://user:pass@app.fixture.invalid','https://app.fixture.invalid/path','http://app.fixture.invalid'])
  assert.throws(()=>composeSc19PaymentRuntime({appOrigin,signatureHeader:'signature'}),/CONFIGURATION_INVALID/);
 assert.throws(()=>composeSc19PaymentRuntime({appOrigin:origin,signatureHeader:'bad\nheader'}),/CONFIGURATION_INVALID/);
});

test('offers and checkout share the composed service gate, including unapproved LIVE and invalid scope',async()=>{
 const scope={provider:'synthetic',account:'merchant-fixture',mode:'test'};
 for(const override of [{enabled:false},{scope:{...scope,mode:'live'}},{scope:{...scope,account:''}},
   {scope:{...scope,provider:''}},{scope:{...scope,mode:'invalid'}}]){
  let db=0,providerCalls=0;
  const runtime=composeSc19PaymentRuntime({pool:{async connect(){db++;throw Error('must not connect');}},
   provider:{async createCheckout(){providerCalls++;},async verifyAndRetrieve(){providerCalls++;return null;}},
   authenticate:async()=>({userId:id}),appOrigin:origin,signatureHeader:'fixture-signature',checkoutOrigins:[],
   enabled:true,liveApproved:false,scope,...override});
  assert.equal(runtime.service.checkoutEnabled,false);
  const http=createSc19PaymentHttp(runtime);
  for(const response of [await http.offers(new Request(origin+'?companyId='+id)),await http.checkout(checkout())]){
   assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'SC19_PAYMENTS_DISABLED'});
  }
  assert.equal(db,0);assert.equal(providerCalls,0);
 }
 for(const allowed of [{scope},{scope:{...scope,mode:'live'},liveApproved:true}]){
  const runtime=composeSc19PaymentRuntime({pool:{},provider:{},authenticate:async()=>({userId:id}),
   appOrigin:origin,signatureHeader:'fixture-signature',checkoutOrigins:[],enabled:true,liveApproved:false,...allowed});
  assert.equal(runtime.service.checkoutEnabled,true);
 }
});
