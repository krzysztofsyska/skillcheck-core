import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fixture, uuid, company, recruitment } from './helpers/screening-report-fixture.mjs';

test('SC-009: real Next routes with synthetic authenticated PostgREST boundary', async t => {
  const data = fixture(), userId = uuid(50);
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url'), 'synthetic'].join('.');
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'synthetic', expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: 'bearer', user: { id: userId } })).toString('base64url');
  const cookie = 'sb-127-auth-token=' + cookieValue;
  let unavailable = false, revoked = false;
  const requests = [];
  const stub = createServer(async (req,res) => {
    const url = new URL(req.url,'http://stub');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type','application/json');
    if (url.pathname === '/auth/v1/user') return res.end(JSON.stringify({ id:userId,aud:'authenticated',email:'test@example.invalid' }));
    if (!url.pathname.startsWith('/rest/v1/')) { res.statusCode=404; return res.end('{}'); }
    const table = url.pathname.split('/').at(-1);
    requests.push({ table, query: url.searchParams.toString(), auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (unavailable && table.startsWith('get_')) { res.statusCode=404; return res.end(JSON.stringify({code:'PGRST202',message:'SECRET_SQL_DETAILS'})); }
    let rows = revoked ? [] : [...(data[table] ?? [])];
    for (const [key,value] of url.searchParams) {
      if(value.startsWith('eq.')) rows=rows.filter(r=>String(r[key])===value.slice(3));
      if(value.startsWith('in.(')) { const ids=value.slice(4,-1).split(','); rows=rows.filter(r=>ids.includes(String(r[key]))); }
    }
    const order=url.searchParams.get('order')?.split('.')[0];
    if(order) rows.sort((a,b)=>String(a[order]).localeCompare(String(b[order])));
    const offset=Number(url.searchParams.get('offset')??0), limit=Number(url.searchParams.get('limit')??1000);
    rows=rows.slice(offset,offset+limit);
    const fields=url.searchParams.get('select');
    if(fields) rows=rows.map(r=>Object.fromEntries(fields.split(',').map(k=>[k,r[k]])));
    res.end(JSON.stringify(rows));
  });
  await new Promise(r=>stub.listen(0,'127.0.0.1',r));
  t.after(()=>{stub.closeAllConnections();stub.close();});
  const reservation=createServer(); await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
  const port=reservation.address().port; await new Promise(r=>reservation.close(r));
  const base=`http://127.0.0.1:${port}`, path=`/dashboard/${company}/recruitments/${recruitment}/report`;
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{
    env:{...process.env,VERCEL_ENV:'',NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'synthetic-public-key',NEXT_PUBLIC_SITE_URL:base},stdio:['ignore','pipe','pipe'],
  });
  let logs=''; child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);t.after(()=>child.kill());
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{ready=(await fetch(base)).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Next started');
  const read=(suffix='',authenticated=true)=>fetch(base+path+suffix,{redirect:'manual',headers:authenticated?{Cookie:cookie}:{}});
  await t.test('anonymous HTML redirects and export rejects before reads',async()=>{
    const html=await read('',false);assert.equal(html.status,307);assert.equal(html.headers.get('location'),'/login');
    const csv=await read('/export',false);assert.equal(csv.status,401);assert.equal(requests.length,0);
  });
  await t.test('authenticated screen and CSV work through real SDK and route wiring',async()=>{
    const page=await read('?size=5');assert.equal(page.status,200);const html=await page.text();
    assert.match(html,/Raport preselekcji/);assert.match(html,/Spełnia wymagania/);assert.match(html,/Pobierz CSV/);assert.match(html,/Drukuj/);
    assert.doesNotMatch(html,/DO_NOT_EXPORT|SECRET_SQL_DETAILS/);assert.match(page.headers.get('cache-control'),/no-store/);
    const csv=await read('/export?size=5');assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);
    assert.match(await csv.text(),/Tworzy raporty/);
    assert.ok(requests.every(r=>r.auth==='Bearer '+token));
    assert.ok(requests.filter(r=>r.table==='get_screening_ranking').every(r=>JSON.parse(r.body).target_size===5));
  });
  await t.test('missing SC008 disables download without a misleading empty report',async()=>{
    unavailable=true;
    const html=await (await read()).text();assert.match(html,/po uruchomieniu rankingu/);assert.doesNotMatch(html,/Pobierz CSV/);
    const csv=await read('/export');assert.equal(csv.status,503);assert.doesNotMatch(await csv.text(),/SECRET_SQL_DETAILS|DO_NOT_EXPORT/);
    unavailable=false;
  });
  await t.test('revoked and cross-company access fail closed; export params are bounded',async()=>{
    revoked=true;assert.equal((await read('/export')).status,404);revoked=false;
    const foreign=await fetch(base+path.replace(company,uuid(999))+'/export',{headers:{Cookie:cookie}});assert.equal(foreign.status,404);
    for(const query of ['?size=4','?size=11','?size=5&size=6'])assert.equal((await read('/export'+query)).status,400);
    assert.equal((await read('/export',false)).status,401);
  });
  if(process.env.PLAYWRIGHT_MODULE)await t.test('browser: desktop/mobile, CSV download, target selection and print layout',async()=>{
    const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
    const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,args:JSON.parse(process.env.BROWSER_ARGS||'[]')});
    try{
      const context=await browser.newContext();await context.addCookies([{name:'sb-127-auth-token',value:cookieValue,url:base}]);
      const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      for(const width of [1280,390]){
        await page.setViewportSize({width,height:900});await page.goto(base+path);
        await page.getByRole('heading',{name:'Raport preselekcji',exact:true}).waitFor();
        assert.equal(await page.getByText('Spełnia wymagania',{exact:true}).count(),1);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.screenshot({path:`/tmp/sc009-${width}.png`,fullPage:true});
      }
      await page.getByLabel('Wielkość sugestii').selectOption('5');await page.getByRole('button',{name:'Pokaż',exact:true}).click();
      await page.waitForURL('**/report?size=5');
      const download=page.waitForEvent('download');await page.getByRole('link',{name:'Pobierz CSV'}).click();
      assert.match((await download).suggestedFilename(),/^skillcheck-preselekcja-.*\.csv$/);
      await page.emulateMedia({media:'print'});assert.equal(await page.getByRole('button',{name:'Drukuj / zapisz PDF'}).isVisible(),false);
      await page.pdf({path:'/tmp/sc009-print.pdf',format:'A4',printBackground:true});
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
  assert.doesNotMatch(logs,/DO_NOT_EXPORT|SECRET_SQL_DETAILS/);
});
