import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
const company='00000000-0000-4000-8000-000000000001',userId='00000000-0000-4000-8000-000000000011';
test('SC19 real Next routes: authenticated owner UI and disabled transport',async t=>{
 let owner=true;
 const token=[Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'synthetic'].join('.');
 const cookieValue='base64-'+Buffer.from(JSON.stringify({access_token:token,refresh_token:'synthetic',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:userId}})).toString('base64url');
 const stub=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/auth/v1/user'))return res.end(JSON.stringify({id:userId,aud:'authenticated',email:'test@example.invalid'}));
  if(req.url.startsWith('/rest/v1/companies'))return res.end(JSON.stringify([{id:company,name:'Synthetic firm',owner_id:owner?userId:'00000000-0000-4000-8000-000000000099'}]));
  if(req.url.startsWith('/rest/v1/company_members'))return res.end(JSON.stringify([{role:'viewer'}]));
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>{stub.closeAllConnections();stub.close();});
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const base=`http://127.0.0.1:${port}`,path=`/dashboard/${company}/billing/checkout`;
 const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{
  env:{...process.env,VERCEL_ENV:'',NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'synthetic-public-key',NEXT_PUBLIC_SITE_URL:base},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);t.after(()=>child.kill());
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{ready=(await fetch(base)).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'Next server ready');
 const headers={Cookie:'sb-127-auth-token='+cookieValue};
 await t.test('anonymous redirects; owner renders checkout; non-owner receives no purchase UI',async()=>{
  const anon=await fetch(base+path,{redirect:'manual'});assert.equal(anon.status,307);assert.equal(anon.headers.get('location'),'/login');
  const page=await fetch(base+path,{headers});assert.equal(page.status,200);assert.match(await page.text(),/Pakiet PRESELEKCJA/);
  owner=false;assert.match(await (await fetch(base+path,{headers})).text(),/Zamówienie może złożyć właściciel firmy/);owner=true;
 });
 await t.test('all concrete routes refuse activation; no browser success query changes state',async()=>{
  for(const [p,method] of [['checkout','POST'],['offers?companyId='+company,'GET'],['orders/'+company+'?companyId='+company+'&success=true','GET'],['webhook','POST']]){
    const r=await fetch(base+'/api/billing/'+p,{method,headers:{...headers,Origin:base,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(r.status,503);assert.match(r.headers.get('cache-control'),/no-store/);assert.deepEqual(await r.json(),{error:'SC19_PAYMENTS_DISABLED'});
  }
 });
});
