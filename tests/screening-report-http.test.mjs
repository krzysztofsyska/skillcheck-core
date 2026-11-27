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
  let unavailable = false, revoked = false, auditFails = false, auditWithdrawn = false, historyFails = false;
  const requests = [], audits = [], screeningAudits = [];
  const stub = createServer(async (req,res) => {
    const url = new URL(req.url,'http://stub');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type','application/json');
    if (url.pathname === '/auth/v1/user') return res.end(JSON.stringify({ id:userId,aud:'authenticated',email:'test@example.invalid' }));
    if (!url.pathname.startsWith('/rest/v1/')) { res.statusCode=404; return res.end('{}'); }
    const table = url.pathname.split('/').at(-1);
    requests.push({ table, query: url.searchParams.toString(), auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    // SC-015-D: zapis audytu eksportu raportu kandydata (funkcja zwraca uuid wpisu).
    if (table === 'record_candidate_report_export') {
      audits.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      if (auditWithdrawn) { res.statusCode=400; return res.end(JSON.stringify({code:'55000',message:'SECRET_SQL_DETAILS'})); }
      if (auditFails) { res.statusCode=500; return res.end(JSON.stringify({code:'XX000',message:'SECRET_SQL_DETAILS'})); }
      return res.end(JSON.stringify(uuid(777)));
    }
    // R0 SC-009a: zapis w rejestrze pobrań CSV raportu preselekcji (funkcja zwraca uuid wpisu).
    if (table === 'record_screening_report_export') {
      screeningAudits.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      if (auditFails) { res.statusCode=500; return res.end(JSON.stringify({code:'XX000',message:'SECRET_SQL_DETAILS'})); }
      return res.end(JSON.stringify(uuid(778)));
    }
    // SC-015-D2: historia eksportu odczytywana z dziennika (tu: z zapisanych wywołań audytu).
    if (table === 'list_candidate_report_exports') {
      if (historyFails) { res.statusCode=500; return res.end(JSON.stringify({code:'XX000',message:'SECRET_SQL_DETAILS'})); }
      return res.end(JSON.stringify(audits.slice(0,1).map(()=>({exported_at:'2026-11-16T10:00:00+00:00',actor_id:userId,actor_role:'recruiter',is_me:true}))));
    }
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
    if(fields && fields !== '*') rows=rows.map(r=>Object.fromEntries(fields.split(',').map(k=>[k,r[k]])));
    // PostgREST maybeSingle uses an object media type. Preserve that real SDK
    // contract when exercising the individual candidate route below.
    res.end(JSON.stringify(req.headers.accept?.includes('application/vnd.pgrst.object+json') ? rows[0] ?? null : rows));
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
    assert.deepEqual(screeningAudits.at(-1).body,{target_company:company,target_recruitment:recruitment,export_kind:'screening_report_csv',target_size:5});
    assert.equal(screeningAudits.at(-1).auth,'Bearer '+token);
    auditFails=true;const blocked=await read('/export?size=5');auditFails=false;
    assert.equal(blocked.status,503);assert.equal(blocked.headers.get('content-disposition'),null);
    assert.doesNotMatch(await blocked.text(),/SECRET_SQL_DETAILS|Tworzy raporty/);
    assert.ok(requests.every(r=>r.auth==='Bearer '+token));
    assert.ok(requests.filter(r=>r.table==='get_screening_ranking').every(r=>JSON.parse(r.body).target_size===5));
  });
  await t.test('five CVs: a human correction changes one candidate in both real report routes',async()=>{
    const saved = structuredClone(data);
    try {
      data.companies[0].owner_id = userId;
      data.company_members = [];
      data.candidate_documents = [];
      data.position_requirement_flags = [{ criterion_id:'task:1', criterion_text:'Raportowanie', flag:'required' }];
      for (const table of ['applications','get_screening_ranking','screening_analysis_versions','screening_result_reviews','screening_criterion_results']) {
        data[table] = Array.from({length:5},(_,i)=>{
          const row = structuredClone(saved[table][0]);
          const app=uuid(100+i), analysis=uuid(200+i), review=uuid(300+i);
          if(table==='applications') Object.assign(row,{id:app,candidate_id:uuid(500+i),status:'new'});
          if(table==='get_screening_ranking') Object.assign(row,{application_id:app,analysis_id:analysis,review_id:review,rank:i+1});
          if(table==='screening_analysis_versions') Object.assign(row,{id:analysis,application_id:app,analysis_version:1});
          if(table==='screening_result_reviews') Object.assign(row,{id:review,analysis_id:analysis});
          if(table==='screening_criterion_results') Object.assign(row,{id:uuid(400+i),analysis_id:analysis,verdict:'supported',human_status:'accepted',evidence:[{start:0,end:9,quote:`DowodCV_${i}`} ]});
          return row;
        });
      }
      const one = async i => {
        const response=await fetch(base+path.replace('/report',`/applications/${uuid(100+i)}/report`),{headers:{Cookie:cookie}});
        assert.equal(response.status,200);
        const html=await response.text();assert.match(html,/Raport kandydata/);return html;
      };
      let comparison=await (await read()).text();
      for(let i=0;i<5;i++) assert.ok(comparison.includes(`/applications/${uuid(100+i)}/report`),'each candidate has its own report link');
      for(let i=0;i<5;i++) {assert.ok(comparison.includes(`DowodCV_${i}`));assert.ok((await one(i)).includes(`DowodCV_${i}`));}
      const corrected=data.screening_criterion_results[0];
      Object.assign(corrected,{human_status:'edited',human_verdict:'supported',human_evidence:[{start:0,end:13,quote:'KorektaCV_zero'}]});
      data.screening_analysis_versions[0].latest_review_version=3;
      data.screening_result_reviews[0].review_version=3;
      // Matrix corrections are stored on the result row; legacy rating
      // overrides alone use approved_with_changes and their separate table.
      data.screening_result_reviews[0].disposition='approved';
      comparison=await (await read()).text();
      assert.ok(comparison.includes('KorektaCV_zero'));assert.ok(!comparison.includes('DowodCV_0'));
      const changed=await one(0);assert.ok(changed.includes('KorektaCV_zero'));assert.ok(!changed.includes('DowodCV_0'));
      // SC-015-D: CSV kandydata ma te same dowody co ekran, nagłówki bez cache i wpis audytu przed wydaniem pliku.
      assert.match(changed,/Pobierz CSV/);
      assert.match(changed,/Historia eksportu/);assert.match(changed,/Ten raport nie był jeszcze eksportowany\./);
      const exportPath=base+path.replace('/report',`/applications/${uuid(100)}/report/export`);
      const exported=await fetch(exportPath,{headers:{Cookie:cookie}});
      assert.equal(exported.status,200);assert.match(exported.headers.get('content-type'),/text\/csv/);
      assert.equal(exported.headers.get('cache-control'),'private, no-store');assert.equal(exported.headers.get('referrer-policy'),'no-referrer');
      assert.equal(exported.headers.get('content-disposition'),`attachment; filename="skillcheck-raport-kandydata-${uuid(100)}.csv"`);
      const exportedCsv=await exported.text();assert.ok(exportedCsv.includes('KorektaCV_zero'));assert.ok(!exportedCsv.includes('DowodCV_0'));
      assert.equal(audits.length,1);assert.equal(audits[0].auth,'Bearer '+token);
      const afterExport=await one(0);assert.match(afterExport,/Ty \(rekruter\)/);assert.doesNotMatch(afterExport,/nie był jeszcze eksportowany/);
      historyFails=true;
      const historyDown=await one(0);assert.match(historyDown,/KorektaCV_zero/);
      assert.match(historyDown,/Nie udało się teraz wczytać historii eksportu/);assert.doesNotMatch(historyDown,/SECRET_SQL_DETAILS/);historyFails=false;
      assert.deepEqual(audits[0].body,{target_company:company,target_recruitment:recruitment,target_application:uuid(100),export_kind:'candidate_report_csv',analysis_version:1});
      auditFails=true;
      const failedAudit=await fetch(exportPath,{headers:{Cookie:cookie}});assert.equal(failedAudit.status,503);
      assert.doesNotMatch(await failedAudit.text(),/KorektaCV_zero|SECRET_SQL_DETAILS/);auditFails=false;
      auditWithdrawn=true;
      const withdrawnExport=await fetch(exportPath,{headers:{Cookie:cookie}});assert.equal(withdrawnExport.status,403);
      assert.doesNotMatch(await withdrawnExport.text(),/KorektaCV_zero|SECRET_SQL_DETAILS/);auditWithdrawn=false;
      assert.equal((await fetch(exportPath,{redirect:'manual'})).status,401);
      const foreignExport=await fetch(exportPath.replace(company,uuid(999)),{headers:{Cookie:cookie}});assert.equal(foreignExport.status,404);
      assert.equal(audits.length,3,'odmowa przed odczytem nie zapisuje audytu');
      for(let i=1;i<5;i++) {
        assert.ok(comparison.includes(`DowodCV_${i}`));
        const unchanged=await one(i);assert.ok(unchanged.includes(`DowodCV_${i}`));assert.ok(!unchanged.includes('KorektaCV_zero'));
      }
      // A revoked approval cannot remain confirmed. The individual report
      // deliberately retains historical evidence with an outdated warning.
      data.screening_result_reviews[0].disposition='needs_reanalysis';
      data.get_screening_ranking[0].eligibility_reason='needs_reanalysis';
      data.get_screening_ranking[0].rankable=false;
      data.get_screening_ranking[0].rank=null;
      comparison=await (await read()).text();
      assert.ok(!comparison.includes('KorektaCV_zero'));
      const revokedReport=await one(0);
      assert.match(revokedReport,/Wynik nieaktualny/);
      assert.doesNotMatch(revokedReport,/<strong>Potwierdzone w CV<\/strong>/);
    } finally {
      for(const key of Object.keys(data)) delete data[key];Object.assign(data,saved);
    }
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
