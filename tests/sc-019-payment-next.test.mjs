import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
const company='00000000-0000-4000-8000-000000000001',userId='00000000-0000-4000-8000-000000000011';
const token=[Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'synthetic'].join('.');
const cookieValue='base64-'+Buffer.from(JSON.stringify({access_token:token,refresh_token:'synthetic',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:userId}})).toString('base64url');
const headers={Cookie:'sb-127-auth-token='+cookieValue};
const path=`/dashboard/${company}/billing/checkout`;
/** One real `next start` against a synthetic Supabase stub. `packages` is the
 * SC19_PACKAGES_ENABLED value: a server component and a route handler read the
 * flag per request from the server's own environment, so one server cannot show
 * both states and each needs its own. `ownerIs` lets a subtest change who owns
 * the company between requests. */
async function startNext(t,{packages}) {
 const state={owner:true};
 const stub=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/auth/v1/user'))return res.end(JSON.stringify({id:userId,aud:'authenticated',email:'test@example.invalid'}));
  if(req.url.startsWith('/rest/v1/companies'))return res.end(JSON.stringify([{id:company,name:'Synthetic firm',owner_id:state.owner?userId:'00000000-0000-4000-8000-000000000099'}]));
  if(req.url.startsWith('/rest/v1/company_members'))return res.end(JSON.stringify([{role:'viewer'}]));
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>{stub.closeAllConnections();stub.close();});
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,VERCEL_ENV:'',NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'synthetic-public-key',NEXT_PUBLIC_SITE_URL:base};
 if(packages===undefined)delete env.SC19_PACKAGES_ENABLED;else env.SC19_PACKAGES_ENABLED=packages;
 const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],
  {env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);t.after(()=>child.kill());
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{ready=(await fetch(base)).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'Next server ready');
 return {base,state};
}
test('SC19 real Next routes: authenticated owner UI and disabled transport',async t=>{
 // The checkout page is behind SC19_PACKAGES_ENABLED, exactly like billing/page.tsx
 // and billing/actions.ts, so the purchase UI only renders with the flag on. The
 // flag-off behaviour of this same page is asserted in tests/sc-019-billing-ui.test.mjs,
 // and the flag-off behaviour of the offer route in the test below.
 const {base,state}=await startNext(t,{packages:'true'});
 const owner=value=>{state.owner=value;};
 await t.test('anonymous redirects; owner renders checkout; non-owner receives no purchase UI',async()=>{
  const anon=await fetch(base+path,{redirect:'manual'});assert.equal(anon.status,307);assert.equal(anon.headers.get('location'),'/login');
  const page=await fetch(base+path,{headers});assert.equal(page.status,200);assert.match(await page.text(),/Pakiet PRESELEKCJA/);
  owner(false);assert.match(await (await fetch(base+path,{headers})).text(),/Zamówienie może złożyć właściciel firmy/);owner(true);
 });
 await t.test('every route that could take money refuses activation; no browser success query changes state',async()=>{
  // Registering a transaction needs a provider; there is none, so these stay shut.
  for(const [p,method] of [['checkout','POST'],['orders/'+company+'?companyId='+company+'&success=true','GET'],['webhook','POST']]){
    const r=await fetch(base+'/api/billing/'+p,{method,headers:{...headers,Origin:base,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(r.status,503);assert.match(r.headers.get('cache-control'),/no-store/);assert.deepEqual(await r.json(),{error:'SC19_PAYMENTS_DISABLED'});
  }
 });
 await t.test('reading the offer needs no provider, but the stub database still refuses this company',async()=>{
  // The read-only catalog is composed even with no provider. Against the synthetic
  // Supabase stub, public.sc19_checkout_offers is not reachable, so the route must
  // fail closed rather than invent an offer or expose a database error.
  const r=await fetch(base+'/api/billing/offers?companyId='+company,{headers});
  assert.match(r.headers.get('cache-control'),/no-store/);
  // Deterministic against this stub: the RPC is unreachable, so the catalog maps a
  // non-42501 failure to SC19_PAYMENT_RETRY -> 503. This is exactly the shape the
  // checkout page showed on Preview while the SC-019 migrations were missing from
  // supabase/preview-migrations.txt, which is why that list is now asserted to be
  // complete in tests/preview-db-migrate-workflow.test.mjs.
  const body=await r.json();
  assert.equal(r.status,503,`unexpected offers status ${r.status}: ${JSON.stringify(body)}`);
  assert.deepEqual(body,{error:'SC19_PAYMENT_RETRY'});
  assert.equal(body.offers,undefined,'no offer is served without a successful authorized read');
  assert.equal(body.checkoutAvailable,undefined);
 });
});

// With packages switched off the panel hides the Pakiety entry and the checkout
// page only shows a notice, so the offer route must not serve the price, the
// credit count and the terms to a direct GET either — and must answer with the
// ordinary "payments unavailable" shape, not a new code the UI mishandles.
test('SC19 offer route honours SC19_PACKAGES_ENABLED before resolving the catalog',async t=>{
 const {base}=await startNext(t,{packages:undefined});
 await t.test('an unset flag refuses the offer read exactly like a deployment with no payments',async()=>{
  const r=await fetch(base+'/api/billing/offers?companyId='+company,{headers});
  assert.equal(r.status,503);assert.match(r.headers.get('cache-control'),/no-store/);
  // Identical to the flag-on-but-no-provider-and-no-catalog answer, and NOT the
  // SC19_PAYMENT_RETRY the resolved catalog produces against the same stub: the
  // catalog is never reached, so the switch really keeps the offer unavailable.
  assert.deepEqual(await r.json(),{error:'SC19_PAYMENTS_DISABLED'});
 });
 await t.test('the write routes stay refused and the checkout page sells nothing',async()=>{
  for(const [p,method] of [['checkout','POST'],['webhook','POST']]){
   const r=await fetch(base+'/api/billing/'+p,{method,headers:{...headers,Origin:base,'Content-Type':'application/json'},body:'{}'});
   assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'SC19_PAYMENTS_DISABLED'});
  }
  const page=await fetch(base+path,{headers});assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Zakup nie jest jeszcze dostępny/);
  assert.doesNotMatch(html,/Akceptuję powyższe warunki|Zamawiam i płacę/,'no order form while packages are off');
 });
 await t.test('an invalid flag value is not "true"',async()=>{
  // Only the exact string 'true' opens the read; anything else is off.
  const other=await startNext(t,{packages:'1'});
  assert.deepEqual(await (await fetch(other.base+'/api/billing/offers?companyId='+company,{headers})).json(),
   {error:'SC19_PAYMENTS_DISABLED'});
 });
});
