// Local Next + synthetic RPC only. Requires Playwright and a Chromium executable.
// Optional PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE, BROWSER_ARGS support external test runtimes.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createServer}=require('node:http'); const {spawn}=require('node:child_process'); const assert=require('node:assert/strict');
(async()=>{
let mode='error'; const requests=[];
const stub=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));await new Promise(r=>setTimeout(r,200));res.setHeader('Content-Type','application/json');if(mode==='error'){res.statusCode=400;res.end('{}');}else res.end(JSON.stringify([{lead_id:'00000000-0000-4000-8000-000000000001',result_code:mode}]));});
await new Promise(r=>stub.listen(0,'127.0.0.1',r));
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));const base=`http://127.0.0.1:${port}`;
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--port',String(port),'--hostname','127.0.0.1'],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'test',SALES_LEADS_ENABLED:'true',SALES_LEAD_REQUEST_SECRET:'local-only-test-secret-at-least-32-bytes',SALES_LEAD_NOTICE:'Lokalny test formularza. Dane są fikcyjne.'},stdio:['ignore','pipe','pipe']});
let serverLogs='';app.stdout.on('data',d=>serverLogs+=d);app.stderr.on('data',d=>serverLogs+=d);let browser;
try {
for(let i=0;i<70;i++){try {if((await fetch(base+'/rozmowa')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined,args:JSON.parse(process.env.BROWSER_ARGS || '["--no-sandbox","--disable-dev-shm-usage"]')});const page=await browser.newPage({extraHTTPHeaders:{'x-real-ip':'203.0.113.10'},viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
// Exercise the shipped calculator script and its actual link, not a constructed URL.
for (const width of [1280, 390]) {
  await page.setViewportSize({width,height:900});
  await page.goto(base+'/kalkulator');
  await page.locator('#volumeSlider').focus();await page.keyboard.press('End');
  assert.equal(await page.locator('#volumeValue').textContent(),'150 CV');
  await page.locator('[data-extra="calls"]').check();
  await page.locator('[data-extra="consult"]').check();
  await page.locator('#timePerCv').fill('300');
  assert.equal(await page.locator('#timePerCv').inputValue(),'240');
  assert.match(await page.locator('#timePerCvCorrection').textContent(),/skorygowana do 240/);
  assert.equal(await page.locator('#manualHours').textContent(),'600,0 h');
  await page.locator('#hourlyTimeCost').fill('20000');
  assert.equal(await page.locator('#hourlyTimeCost').inputValue(),'10000');
  await page.locator('#quoteButton').click();
  const destination = new URL(await page.locator('#openLead').getAttribute('href'),base);
  assert.equal(destination.searchParams.get('cv'),'150');
  assert.equal(destination.searchParams.get('extra'),'calls,consult');
  assert.deepEqual([...destination.searchParams.keys()].sort(),['cv','extra','pack','source']);
  await page.locator('#openLead').click();
  assert.match(await page.locator('#lead-needs').inputValue(),/PRESELEKCJA.*150 CV/);
  assert.match(await page.locator('#lead-needs').inputValue(),/Konsultacja eksperta/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.goBack();
  if(await page.locator('#quoteDialog').evaluate(el=>el.open)) await page.locator('#closeQuote').click();
  await page.locator('#tryFreeTop').click();
  await page.locator('#openLead').click();
  assert.match(await page.locator('#lead-needs').inputValue(),/Wybrany wariant: FREE/);
  assert.match(await page.locator('#lead-needs').inputValue(),/Dodatki do wyceny: brak/);
}
await page.setViewportSize({width:1280,height:900});
await page.goto(base+'/rozmowa');
await page.getByLabel('Imię',{exact:true}).fill('  Jaś  '); await page.getByLabel('Firma',{exact:true}).fill('Firma testowa'); await page.getByLabel('E-mail',{exact:true}).fill('TEST@example.invalid'); await page.getByLabel('O jakiej rekrutacji chcesz porozmawiać?').fill('Szukamy dwóch handlowców.');
await page.getByRole('button',{name:'Wyślij zgłoszenie'}).click();
await page.getByRole('button',{name:'Zapisuję zgłoszenie…'}).waitFor(); assert.equal(await page.locator('form').getAttribute('aria-busy'),'true');
await page.getByText('Nie udało się zapisać zgłoszenia. Dane zostały w formularzu. Możesz spróbować ponownie.',{exact:true}).waitFor(); assert.equal(await page.getByLabel('Imię',{exact:true}).inputValue(),'  Jaś  ');
if(!requests[0]) { console.log('SERVER',serverLogs); throw new Error('No RPC reached'); } const firstKey=requests[0].idempotency_key;
await page.getByLabel('Imię',{exact:true}).fill('Jaś'); await page.getByRole('button',{name:'Wyślij zgłoszenie'}).click(); await page.getByRole('button',{name:'Zapisuję zgłoszenie…'}).waitFor(); await page.getByRole('button',{name:'Wyślij zgłoszenie'}).waitFor();assert.equal(requests.at(-1).idempotency_key,firstKey);
mode='sales_lead_idempotency_conflict'; await page.getByRole('button',{name:'Wyślij zgłoszenie'}).click();await page.getByText('To zgłoszenie różni się od poprzedniej próby. Wyślij je ponownie.').waitFor();
mode='accepted';await page.getByRole('button',{name:'Wyślij zgłoszenie'}).click();await page.getByText('Zgłoszenie zostało zapisane. To nie jest rezerwacja terminu rozmowy.').waitFor();assert.notEqual(requests.at(-1).idempotency_key,firstKey);assert.equal(await page.locator('form').count(),0);
await page.goto(base+'/rozmowa');
await page.getByLabel('Imię',{exact:true}).fill('  Jaś  '); await page.getByLabel('Firma',{exact:true}).fill('Firma testowa'); await page.getByLabel('E-mail',{exact:true}).fill('TEST@example.invalid'); await page.getByLabel('O jakiej rekrutacji chcesz porozmawiać?').fill('Szukamy dwóch handlowców.');
let drop=true;
await page.route('**/rozmowa',async route=>{if(route.request().method()==='POST'&&drop){drop=false;await route.fetch();await route.abort('failed');}else await route.continue();});
await page.getByRole('button',{name:'Wyślij zgłoszenie'}).click();
await page.getByText('Nie udało się zapisać zgłoszenia. Dane zostały w formularzu. Możesz spróbować ponownie.',{exact:true}).waitFor();
const lostKey=requests.at(-1).idempotency_key;
await page.getByLabel('Imię',{exact:true}).fill('Jaś'); await page.getByLabel('E-mail',{exact:true}).fill('test@example.invalid');
await page.getByRole('button',{name:'Wyślij zgłoszenie'}).click();
await page.getByText('Zgłoszenie zostało zapisane. To nie jest rezerwacja terminu rozmowy.').waitFor();
assert.equal(requests.at(-1).idempotency_key,lostKey,'Lost response + equivalent normalized edit must preserve UUID');
await page.goto(base+'/rozmowa'); await page.screenshot({path:'/tmp/sc-sales-006c-desktop.png',fullPage:true});
await page.setViewportSize({width:390,height:844});await page.reload();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.getByRole('button',{name:'Menu',exact:true}).click();await page.getByRole('navigation',{name:'Menu',exact:true}).getByRole('link',{name:'Kalkulator pakietów'}).click();await page.waitForURL('**/kalkulator-demo.html');await page.goto(base+'/rozmowa');await page.screenshot({path:'/tmp/sc-sales-006c-mobile.png',fullPage:true});
const beforeInvalid=requests.length;
await page.getByRole('button',{name:'Wyślij zgłoszenie'}).click();
assert.equal(await page.getByLabel('Imię',{exact:true}).evaluate(el=>el.validity.valueMissing),true);
assert.equal(requests.length,beforeInvalid,'required field validation prevents a request');
await page.getByLabel('Imię',{exact:true}).focus(); await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').getAttribute('name'),'company_name');
await page.getByLabel('Imię',{exact:true}).fill('Anna');await page.getByLabel('Firma',{exact:true}).fill('Firma testowa');await page.getByLabel('E-mail',{exact:true}).fill('anna@example.invalid');await page.getByLabel('O jakiej rekrutacji chcesz porozmawiać?').fill('Rekrutacja na stanowisko handlowe.');
await page.getByLabel('E-mail',{exact:true}).focus();await page.keyboard.press('Enter');await page.getByText('Zgłoszenie zostało zapisane. To nie jest rezerwacja terminu rozmowy.').waitFor();assert.equal(await page.locator('form').count(),0);assert.deepEqual(errors,[]);
console.log('PASS browser: pending, preserved values, normalized retry including lost response, conflict new UUID, success hides form, mobile navigation, keyboard, no overflow/JS errors.');
}finally{await browser?.close();app.kill();stub.closeAllConnections();stub.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
