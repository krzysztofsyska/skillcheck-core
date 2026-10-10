import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const uid='00000000-0000-4000-8000-000000000002', id='00000000-0000-4000-8000-000000000001', company='00000000-0000-4000-8000-000000000003';
const exp=Math.floor(Date.now()/1000)+3600;
const token=[Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:uid,exp})).toString('base64url'),'synthetic'].join('.');
const cv='base64-'+Buffer.from(JSON.stringify({access_token:token,refresh_token:'synthetic',expires_at:exp,expires_in:3600,token_type:'bearer',user:{id:uid}})).toString('base64url');
const headers={Cookie:'sb-127-auth-token='+cv};
const initial={id,first_name:'Anna testowa',company_name:'Firma syntetyczna',email:'test@example.invalid',phone:null,needs:'<img src=x onerror=alert(1)>',created_at:'2026-10-09T08:00:00Z',stage:'new',note:'',next_contact_on:null,company_id:null,linked_company_name:null,version:0,closed_at:null,total_count:1};
test('sales panel HTTP access, filtering and browser workflow with synthetic backend', async t=>{
 let operator=true,revoked=false,failure=false,lead={...initial},history=[],requests=[],concurrentWrite=false;
 const stub=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString()||'{}');requests.push({url:req.url,input});res.setHeader('Content-Type','application/json');
  const send=v=>res.end(JSON.stringify(v));
  if(req.url==='/auth/v1/user')return send({id:uid,aud:'authenticated'});
  if(req.url==='/rest/v1/rpc/platform_operator_status')return send(operator);
  if(req.url?.startsWith('/rest/v1/rpc/')){
   if(revoked||failure){res.statusCode=400;return send({message:revoked?'sales_lead_forbidden':'PRIVATE_SQL_DETAIL',code:'P0001'});}
   if(req.url.endsWith('/list_sales_pipeline'))return send(input.target_lead&&input.target_lead!==id?[]:input.stage_filter&&input.stage_filter!=='all'&&input.stage_filter!==lead.stage?[]:[lead]);
   if(req.url.endsWith('/sales_pipeline_history'))return send(history);
   if(req.url.endsWith('/find_sales_companies'))return send(input.search_text==='Firma'?[{id:company,name:'Firma klienta'}]:[]);
   if(req.url.endsWith('/save_sales_pipeline')){
    if(input.expected_version!==lead.version)return send('conflict');
    if(input.new_stage==='won'&&!input.linked_company)return send('company_required');
    lead={...lead,stage:input.new_stage,note:input.new_note,next_contact_on:input.next_contact,company_id:input.linked_company,linked_company_name:input.linked_company?'Firma klienta':null,version:lead.version+1,closed_at:input.new_stage==='lost'?'2026-10-09T09:00:00Z':null};
    history.unshift({...lead,created_at:'2026-10-09T09:00:00Z'});
    if(concurrentWrite){
     concurrentWrite=false;
     lead={...lead,version:lead.version+1,note:'Ustalenia drugiego operatora'};
     history.unshift({...lead,created_at:'2026-10-09T09:01:00Z'});
    }
    return send('ok');
   }
  }
  res.statusCode=404;send({});
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>{stub.closeAllConnections();stub.close();});
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,VERCEL_ENV:'',NEXT_PUBLIC_SITE_URL:base,NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:'+stub.address().port,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'synthetic',SALES_LEADS_ENABLED:''},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base)).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,logs);
 const read=async(path='/operator/sales',auth=true)=>{const res=await fetch(base+path,{headers:auth?headers:{},redirect:'manual'});const html=await res.text();assert.match(res.headers.get('cache-control'),/no-store/);assert.doesNotMatch(html,/PRIVATE_SQL_DETAIL/);return {res,html};};
 await t.test('anonymous, nonoperator, revoked and error fail closed',async()=>{
  assert.equal((await read('/operator/sales',false)).res.status,307);
  operator=false;assert.equal((await read()).res.status,404);assert.equal((await read('/operator/sales/'+id)).res.status,404);operator=true;
  revoked=true;assert.equal((await read()).res.status,404);revoked=false;
  failure=true;assert.equal((await read()).html.includes(initial.email),false);failure=false;
 });
 await t.test('list, detail, filter parameters and escaped user content',async()=>{
  const {html}=await read();assert.match(html,/Proces sprzedaży/);assert.match(html,/Firma syntetyczna/);
  await read('/operator/sales?stage=offer&due=today&page=2');assert.deepEqual(requests.filter(r=>r.url.endsWith('/list_sales_pipeline')).at(-1).input,{stage_filter:'offer',due_filter:'today',page_offset:20});
  const detail=await read('/operator/sales/'+id);assert.equal(detail.res.status,200);assert.match(detail.html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(detail.html,/<img src=x/);
  assert.equal((await read('/operator/sales/bad')).res.status,404);
  assert.equal((await read('/operator/sales/00000000-0000-4000-8000-000000000099')).res.status,404);
 });
 if(process.env.PLAYWRIGHT_MODULE)await t.test('browser desktop/mobile: search, edit, conflict, permissions and terminal confirmation',async()=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,args:JSON.parse(process.env.BROWSER_ARGS||'[]')});
  try{
   const context=await browser.newContext();await context.addCookies([{name:'sb-127-auth-token',value:cv,url:base}]);
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/operator/sales/'+id);
   await page.getByText('Wyszukaj firmę do powiązania',{exact:true}).click();await page.getByLabel('Nazwa firmy').fill('Firma');await page.getByRole('button',{name:'Wyszukaj firmy'}).click();
   await page.getByLabel('Powiązana firma').selectOption(company);
   await page.getByLabel('Etap sprzedaży').selectOption('conversation');await page.getByLabel('Notatka dla zespołu').fill('Ustalono rozmowę.');await page.getByLabel('Data następnego kontaktu').fill('2026-10-10');
   await page.getByRole('button',{name:'Zapisz zmiany'}).click();await page.getByText('Wersja 1 · Rozmowa',{exact:true}).waitFor();assert.equal(lead.company_id,company);assert.equal(lead.next_contact_on,'2026-10-10');assert.equal(await page.getByLabel('Etap sprzedaży').inputValue(),'conversation');assert.equal(await page.getByLabel('Powiązana firma').inputValue(),company);
   for(const width of [1280,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`/tmp/sc-sales-013-detail-${width}.png`,fullPage:true});}
   // Another operator commits after our save, before the refreshed snapshot is read.
   concurrentWrite=true;
   await page.getByLabel('Notatka dla zespołu').fill('Starsza notatka pierwszego operatora');
   await page.getByRole('button',{name:'Zapisz zmiany'}).click();
   await page.getByText('Wersja 3 · Rozmowa',{exact:true}).waitFor();
   assert.equal(await page.locator('input[name="version"]').inputValue(),'3');
   assert.equal(await page.getByLabel('Notatka dla zespołu').inputValue(),'Ustalenia drugiego operatora');
   await page.getByRole('button',{name:'Zapisz zmiany'}).click();
   await page.getByText('Wersja 4 · Rozmowa',{exact:true}).waitFor();
   assert.equal(lead.note,'Ustalenia drugiego operatora');
   lead.version++;await page.getByLabel('Notatka dla zespołu').fill('Moja niezapisana notatka');await page.getByRole('button',{name:'Zapisz zmiany'}).click();await page.getByRole('status').filter({hasText:'Ktoś zmienił'}).waitFor();assert.equal(await page.getByLabel('Notatka dla zespołu').inputValue(),'Moja niezapisana notatka');assert.equal(lead.note,'Ustalenia drugiego operatora');
   await page.reload();revoked=true;await page.getByRole('button',{name:'Zapisz zmiany'}).click();await page.getByRole('status').filter({hasText:'Nie udało się zapisać'}).waitFor();revoked=false;
   await page.getByLabel('Etap sprzedaży').selectOption('lost');const before=requests.filter(r=>r.url.endsWith('/save_sales_pipeline')).length;
   await page.getByRole('button',{name:'Zapisz zmiany'}).click();assert.equal(requests.filter(r=>r.url.endsWith('/save_sales_pipeline')).length,before);
   await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Zapisz zmiany'}).click();await page.getByRole('heading',{name:'Zgłoszenie zakończone'}).waitFor();assert.equal(lead.next_contact_on,null);assert.ok(await page.getByText(/Usunięcie danych po 6 miesiącach/).isVisible());
   await page.goto(base+'/operator/sales');await page.getByRole('combobox',{name:/^Etap/}).selectOption('offer');await page.getByRole('button',{name:'Pokaż'}).click();await page.getByRole('status').filter({hasText:'Brak zgłoszeń'}).waitFor();
   await page.getByRole('link',{name:'Wyczyść filtry'}).click();await page.getByRole('heading',{name:'Firma syntetyczna'}).waitFor();await page.screenshot({path:'/tmp/sc-sales-013-list-390.png',fullPage:true});
   await context.clearCookies();await page.goto(base+'/operator/sales');assert.equal(new URL(page.url()).pathname,'/login');assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 for(const value of [initial.email,initial.first_name,'PRIVATE_SQL_DETAIL'])assert.equal(logs.includes(value),false);
});
