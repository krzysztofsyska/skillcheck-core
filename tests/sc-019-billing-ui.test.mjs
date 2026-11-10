import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const companyId = '00000000-0000-4000-8000-000000000011';
const ownerId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';

test('catalog purchase actions validate consent, owner, quantities, and retain recruitment context',async()=>{
 const facade=load('lib/sc19-catalog-orders.ts');
 const quote={versionId:companyId,kind:'package',code:'PRESELEKCJA',packageCode:'PRESELEKCJA',quantity:1,grossMinor:30000,cvCredits:60,serviceCode:null,serviceUnits:0,termsRevision:'v1',termsText:'Pełne warunki'};
 const original=process.env.SC19_CATALOG_ORDERS_ENABLED;process.env.SC19_CATALOG_ORDERS_ENABLED='true';
 try {await withFlag('true',async()=>{
  let actor=ownerId,error=null;const calls=[];
  const actions=load('app/dashboard/[companyId]/billing/checkout/catalog-actions.ts',{
   'next/navigation':{redirect},'next/cache':{revalidatePath(){}},
   '../../../../../lib/company-access':{companyAccess:async()=>({company:{owner_id:ownerId},user:{id:actor},client:{rpc:async(name,args)=>{calls.push({name,args});return {error};}}})},
   '../../../../../lib/sc19-catalog-orders':facade,
  });
  const form=()=>{const f=new FormData();for(const [k,v] of Object.entries({companyId,recruitmentId:companyId,requestId:memberId,quote:JSON.stringify(quote),accepted:'yes'}))f.set(k,v);return f;};
  assert.match(await redirected(actions.placeCatalogOrder,form()),/recruitmentId=.*catalogStatus=created/);assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args.expected_quote,quote);
  actor=memberId;await redirected(actions.placeCatalogOrder,form());assert.equal(calls.length,1);
  actor=ownerId;const noConsent=form();noConsent.delete('accepted');await redirected(actions.placeCatalogOrder,noConsent);assert.equal(calls.length,1);
  for(const quantity of [0,1001,1.5]){const f=form();f.set('quote',JSON.stringify({...quote,quantity}));await redirected(actions.placeCatalogOrder,f);}assert.equal(calls.length,1);
  error={code:'22023',message:'internal SQL details'};const url=await redirected(actions.placeCatalogOrder,form());assert.match(url,/catalogStatus=changed/);assert.doesNotMatch(url,/internal/);
 });}finally{if(original===undefined)delete process.env.SC19_CATALOG_ORDERS_ENABLED;else process.env.SC19_CATALOG_ORDERS_ENABLED=original;}
});

test('catalog UI shows accepted terms and pending state; only operator action can confirm verified amount',async()=>{
 const facade=load('lib/sc19-catalog-orders.ts');
 const quote={versionId:companyId,kind:'addon',code:'skill_test',packageCode:'PRESELEKCJA',quantity:1,grossMinor:5000,cvCredits:0,serviceCode:'skill_test',serviceUnits:1,termsRevision:'v1',termsText:'Syntetyczne pełne warunki'};
 const component=load('app/dashboard/[companyId]/billing/checkout/catalog-orders.tsx',{
  '../../../../../lib/sc19-catalog-orders':facade,'../../../../../lib/pricing/cv-pool':load('lib/pricing/cv-pool.ts'),
  './catalog-actions':{placeCatalogOrder(){},cancelCatalogOrder(){}},
 }).default;
 const order={id:memberId,company_id:companyId,code:'skill_test',package_code:'PRESELEKCJA',quantity:1,gross_minor:5000,cv_credits:0,service_units:1,terms_text:quote.termsText,status:'pending',accepted_at:new Date().toISOString()};
 const client={rpc:async name=>({data:name==='sc19_catalog_order_options'?[quote]:name==='sc19_catalog_orders'?[order]:[{code:'skill_test',available:2,used:1}],error:null})};
 const html=renderToStaticMarkup(await component({client,companyId,isOwner:true,recruitmentId:companyId}));
 assert.match(html,/Syntetyczne pełne warunki/);assert.match(html,/disabled=""/);assert.match(html,/Anuluj nieopłacone zamówienie/);
 assert.match(html,/dostępne 2, wykorzystane 1/);
 const member=renderToStaticMarkup(await component({client,companyId,isOwner:false}));assert.doesNotMatch(member,/type="submit"/);
 let authorized=false,calls=0;
 const action=load('app/operator/billing/catalog-order-actions.ts',{
  'next/navigation':{redirect},'next/cache':{revalidatePath(){}},'../../../lib/sc19-catalog-orders':facade,
  '../sales/access':{salesOperator:async()=>{if(!authorized)throw Error('unauthorized');return {rpc:async()=>{calls++;return {error:null};}};}},
 }).settleCatalogOrder;
 const f=new FormData();f.set('orderId',memberId);f.set('settlement','synthetic-paid-1');f.set('amountMinor','5000');f.set('confirm','yes');
 await assert.rejects(action(f),/unauthorized/);assert.equal(calls,0);authorized=true;
 const unconfirmed=new FormData();unconfirmed.set('orderId',memberId);await redirected(action,unconfirmed);assert.equal(calls,0);
 assert.match(await redirected(action,f),/catalogStatus=paid/);assert.equal(calls,1);
});

const publishedPackages = () => ['FREE','PRESELEKCJA','WERYFIKACJA','ASSESSMENT_CENTER'].map((package_code,i) => ({
  package_code,gross_minor:[0,32100,65400,150100][i],cv_included:[5,60,60,50][i],cv_step:5,
  cv_max:[5,60,150,150][i],overage_gross_per_cv_minor:0,sellable:true,vat_basis_points:2300,
}));

function load(file, mocks = {}) {
  const path = fileURLToPath(new URL('../' + file, import.meta.url));
  const mod = new Module(path);
  mod.filename = path;
  mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
  const req = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : req(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, path);
  return mod.exports;
}

function redirect(url) {
  const error = new Error('NEXT_REDIRECT');
  error.url = url;
  throw error;
}

function query(result) {
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle: async () => result,
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return builder;
}

function withFlag(value, run) {
  const previous = process.env.SC19_PACKAGES_ENABLED;
  if (value === undefined) delete process.env.SC19_PACKAGES_ENABLED;
  else process.env.SC19_PACKAGES_ENABLED = value;
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.SC19_PACKAGES_ENABLED;
    else process.env.SC19_PACKAGES_ENABLED = previous;
  });
}

function billingAccess({ userId = ownerId, balance = null, error = null, catalog = [{ plan: 'FREE', credits: 3 }, { plan: 'PRESELEKCJA', credits: 12 }], catalogError = null } = {}) {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return name === 'sc19_package_sizes' ? { data: catalog, error: catalogError } : { data: balance, error };
    },
  };
  const access = {
    companyAccess: async () => ({
      client,
      company: { owner_id: ownerId, name: 'Acme' },
      user: { id: userId },
    }),
  };
  return { calls, client, access };
}

function billingPage(access) {
  return load('app/dashboard/[companyId]/billing/page.tsx', {
    'next/link': ({ children, href }) => React.createElement('a', { href }, children),
    '../../../../lib/company-access': access,
    './actions': { activateSc19Free() {} },
    '../../../../lib/sc19-package-sizes': load('lib/sc19-package-sizes.ts'),
    '../../../../lib/sc19-company-catalog': load('lib/sc19-company-catalog.ts'),
    '../../../../lib/pricing/cv-pool': load('lib/pricing/cv-pool.ts'),
  }).default;
}

function billingAction(access) {
  // SC-FREE-AUTO-001: the action now goes through the automatic-FREE flow. Only
  // the thin 'server-only' adapter is substituted, so the real flow code runs.
  // No SC19_TRIAL_AUTO_SECRET is set here, so the register is never consulted
  // and the behaviour is the pre-automation one: claim, otherwise manual review.
  const flow = load('lib/sc19-trial-auto-flow.ts');
  return load('app/dashboard/[companyId]/billing/actions.ts', {
    'next/cache': { revalidatePath() {} },
    'next/navigation': { redirect },
    '../../../../lib/company-access': access,
    '../../../../lib/sc19-trial-auto-server': { activateFreeWithWhitelist: flow.activateFreeWithWhitelist, trialStore: flow.trialStore },
  }).activateSc19Free;
}

async function redirected(action, form) {
  try {
    await action(form);
  } catch (error) {
    if (error.url) return error.url;
    throw error;
  }
  assert.fail('expected a redirect');
}

function form(nip = '5261040828') {
  const data = new FormData();
  data.set('companyId', companyId);
  data.set('nip', nip);
  return data;
}

test('billing page stays closed and does not read a balance while packages are off', async () => {
  await withFlag(undefined, async () => {
    const fx = billingAccess();
    const html = renderToStaticMarkup(await billingPage(fx.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({}),
    }));
    assert.match(html, /przygotowywane/);
    assert.doesNotMatch(html, /name="nip"|Aktywuj FREE/);
    assert.doesNotMatch(html, /billing\/checkout/, 'SC19_PAGES flag off hides the checkout link too');
    assert.equal(fx.calls.length, 0);
    const url = await redirected(billingAction(fx.access), form());
    assert.equal(url, '/dashboard');
    assert.equal(fx.calls.length, 0);
  });
});

test('billing page shows the owner form only to the owner and hides it once a balance exists', async () => {
  await withFlag('true', async () => {
    const owner = billingAccess();
    const ownerHtml = renderToStaticMarkup(await billingPage(owner.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({ status: 'taken' }),
    }));
    assert.match(ownerHtml, /name="nip"/);
    assert.match(ownerHtml, /Aktywuj FREE/);
    assert.match(ownerHtml, /Darmowa pula została już przypisana/);
    // The FREE copy now explains the automatic VAT-register check instead of
    // sending the company to the contact form for a manual verification.
    assert.match(ownerHtml, /wykazie podatników VAT/);
    // But the MANUAL PATH MUST STAY REACHABLE FROM THE FREE BLOCK (bot review
    // finding, kept asserted): when the register does not confirm or does not
    // answer, the company must have somewhere to go. Asserted on the FREE part
    // of the page only, so the PRESELEKCJA block's own link cannot satisfy it.
    const freeBlock = ownerHtml.slice(ownerHtml.indexOf('FREE —'), ownerHtml.indexOf('PRESELEKCJA'));
    assert.ok(freeBlock.length > 100, 'the FREE block must be on the page to assert about it');
    assert.match(freeBlock, /href="\/rozmowa"/);
    assert.deepEqual(owner.calls, [{ name: 'sc19_package_sizes', args: undefined }, { name: 'sc19_get_balance', args: { target_company: companyId } }]);
    assert.match(ownerHtml, /FREE — 3 analiz CV/);
    assert.match(ownerHtml, /PRESELEKCJA — 12 analiz CV/);
    assert.doesNotMatch(ownerHtml, /5 analiz CV|60 analiz CV/);

    const member = billingAccess({ userId: memberId });
    const memberHtml = renderToStaticMarkup(await billingPage(member.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({}),
    }));
    assert.match(memberHtml, /FREE może aktywować właściciel firmy/);
    assert.doesNotMatch(memberHtml, /name="nip"/);
    // The checkout route is owner-only on the page itself, so the link to it uses
    // the same condition and is never shown to a non-owner member.
    assert.match(ownerHtml, new RegExp(`href="/dashboard/${companyId}/billing/checkout"`));
    assert.doesNotMatch(memberHtml, /billing\/checkout/);

    const funded = billingAccess({ balance: [{ plan: 'FREE', available: 4 }] });
    const fundedHtml = renderToStaticMarkup(await billingPage(funded.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({ status: 'not-a-status' }),
    }));
    assert.match(fundedHtml, /FREE/);
    assert.match(fundedHtml, /4/);
    assert.match(fundedHtml, /analiz CV do wykorzystania/);
    assert.doesNotMatch(fundedHtml, /name="nip"|not-a-status/);
  });
});

test('FREE activation maps the owner, the NIP and the RPC error without calling the database for a rejected form', async () => {
  await withFlag('true', async () => {
    const badId = billingAccess();
    const wrong = new FormData();
    wrong.set('companyId', 'not-a-company');
    wrong.set('nip', '5261040828');
    assert.equal(await redirected(billingAction(badId.access), wrong), '/dashboard');
    assert.equal(badId.calls.length, 0);

    const member = billingAccess({ userId: memberId });
    assert.equal(await redirected(billingAction(member.access), form()), `/dashboard/${companyId}/billing?status=forbidden`);
    assert.equal(member.calls.length, 0);

    const longNip = billingAccess();
    assert.equal(await redirected(billingAction(longNip.access), form('1'.repeat(21))), `/dashboard/${companyId}/billing?status=invalid`);
    assert.equal(longNip.calls.length, 0);

    // 42501 now has two meanings and they must not be confused: a company that
    // is simply not verified yet goes to manual review (the automatic path would
    // take over here if it were configured), while any other refusal is a real
    // anomaly and must not claim the company was queued for review.
    const cases = [
      ['23505', 'PRIVATE nip secret', 'taken'],
      ['22023', 'PRIVATE nip secret', 'invalid'],
      ['42501', 'sc19_trial_requires_verified_company', 'manual'],
      ['42501', 'PRIVATE nip secret', 'failed'],
      ['XX000', 'PRIVATE nip secret', 'failed'],
    ];
    for (const [code, message, status] of cases) {
      const fx = billingAccess({ error: { code, message } });
      const url = await redirected(billingAction(fx.access), form('526-104-08-28'));
      assert.equal(url, `/dashboard/${companyId}/billing?status=${status}`, `${code} ${message}`);
      // Every call carries the CANONICAL ten digits, never the separators the
      // field accepts: the database normalizes before it rebuilds the signed
      // payload, so signing the raw input made every formatted NIP fail.
      for (const call of fx.calls) assert.equal(call.args.supplied_nip, '5261040828', `${code} ${message}`);
      // No network call, and no signed RPC: without the server secret nothing
      // past the unsigned precheck is attempted, so behaviour is unchanged.
      const expected = status === 'manual'
        ? ['sc19_claim_trial', 'sc19_auto_free_precheck']
        : ['sc19_claim_trial'];
      assert.deepEqual(fx.calls.map(call => call.name), expected, `${code} ${message}`);
    }

    const ok = billingAccess();
    assert.equal(await redirected(billingAction(ok.access), form()), `/dashboard/${companyId}/billing?status=activated`);
    assert.deepEqual(ok.calls[0].args, { target_company: companyId, supplied_nip: '5261040828' });
  });
});

test('the checkout URL renders no priced order summary while packages are off', async () => {
  const checkoutPage = access => load('app/dashboard/[companyId]/billing/checkout/page.tsx', {
    'next/link': ({ children, href }) => React.createElement('a', { href }, children),
    '../../../../../lib/company-access': access,
    './checkout': () => React.createElement('p', null, 'SYNTHETIC CHECKOUT FORM'),
    './catalog-orders': () => React.createElement('p', null, 'SYNTHETIC CATALOG ORDERS'),
  }).default;
  // Flag off: the link is hidden on the billing page, but the URL is still
  // reachable and must not render the purchase UI either.
  await withFlag(undefined, async () => {
    const fx = billingAccess();
    const html = renderToStaticMarkup(await checkoutPage(fx.access)({ params: Promise.resolve({ companyId }) }));
    assert.match(html, /przygotowywane/);
    assert.doesNotMatch(html, /SYNTHETIC CHECKOUT FORM/, 'no order form while packages are off');
    assert.doesNotMatch(html, /Jednorazowy zakup analiz CV/);
  });
  await withFlag('true', async () => {
    const owner = billingAccess();
    const ownerHtml = renderToStaticMarkup(await checkoutPage(owner.access)({ params: Promise.resolve({ companyId }) }));
    assert.match(ownerHtml, /SYNTHETIC CHECKOUT FORM/);
    const member = billingAccess({ userId: memberId });
    const memberHtml = renderToStaticMarkup(await checkoutPage(member.access)({ params: Promise.resolve({ companyId }) }));
    assert.match(memberHtml, /Zamówienie może złożyć właściciel firmy/);
    assert.doesNotMatch(memberHtml, /SYNTHETIC CHECKOUT FORM/);
  });
});

test('company dashboard links to billing only while the package flag is on', async () => {
  const access = {
    companyAccess: async () => ({
      client: { from: () => query({ data: [], error: null, count: 0 }) },
      company: { name: 'Acme', owner_id: ownerId },
      user: { id: ownerId },
      canEdit: true,
    }),
  };
  const page = load('app/dashboard/[companyId]/page.tsx', {
    'next/link': ({ children, href }) => React.createElement('a', { href }, children),
    '../../../lib/company-access': access,
    '../../../lib/white-label-flag': { whiteLabelEnabled: () => false },
    './forms': { ProfileForm() { return null; }, RecruitmentForm() { return null; } },
  }).default;
  await withFlag(undefined, async () => {
    const html = renderToStaticMarkup(await page({ params: Promise.resolve({ companyId }) }));
    assert.doesNotMatch(html, /\/billing/);
  });
  await withFlag('true', async () => {
    const html = renderToStaticMarkup(await page({ params: Promise.resolve({ companyId }) }));
    assert.match(html, new RegExp(`/dashboard/${companyId}/billing`));
  });
});


// SC-020-D: domains and the white-label change history are linked from the company panel, for the owner only.
test('company dashboard links to domains and white-label history for the owner only, while white-label is on', async () => {
  const render = async (userId, enabled) => {
    const page = load('app/dashboard/[companyId]/page.tsx', {
      'next/link': ({ children, href }) => React.createElement('a', { href }, children),
      '../../../lib/company-access': { companyAccess: async () => ({
        client: { from: () => query({ data: [], error: null, count: 0 }) },
        company: { name: 'Acme', owner_id: ownerId }, user: { id: userId }, canEdit: true,
      }) },
      '../../../lib/white-label-flag': { whiteLabelEnabled: () => enabled },
      './forms': { ProfileForm() { return null; }, RecruitmentForm() { return null; } },
    }).default;
    return renderToStaticMarkup(await page({ params: Promise.resolve({ companyId }) }));
  };
  const owner = await render(ownerId, true);
  assert.match(owner, new RegExp(`/dashboard/${companyId}/domeny`));
  assert.match(owner, new RegExp(`/dashboard/${companyId}/zmiany-marki`));
  assert.match(owner, new RegExp(`/dashboard/${companyId}/marka`));
  const member = await render(memberId, true);
  assert.doesNotMatch(member, /\/domeny|\/zmiany-marki/);
  assert.match(member, new RegExp(`/dashboard/${companyId}/marka`));
  assert.doesNotMatch(await render(ownerId, false), /\/domeny|\/zmiany-marki|\/marka/);
});

test('billing never presents a grant form with an unavailable or invalid policy', async () => {
  await withFlag('true', async () => {
    for (const options of [
      {catalog: null}, {catalog: []}, {catalogError: {code:'PGRST202'}},
      {catalog:[{plan:'FREE',credits:0},{plan:'PRESELEKCJA',credits:12}]},
      {catalog:[{plan:'FREE',credits:3},{plan:'PRESELEKCJA',credits:12.5}]},
    ]) {
      const fx=billingAccess(options);
      await assert.rejects(billingPage(fx.access)({params:Promise.resolve({companyId}),searchParams:Promise.resolve({})}), /Nie można odczytać wielkości pakietów/);
      assert.deepEqual(fx.calls,[{name:'sc19_package_sizes',args:undefined}]);
    }
  });
});


// U1 z przeglądu 6c12d2d: operator podejmuje decyzję na podstawie powodu odmowy,
// więc każdy kod, który potrafi trafić do jego raportu, musi mieć polską treść.
// Bez tego fallback pokazuje mu surowy kod (`powód: NIP_RELEASED`) dokładnie tam,
// gdzie jest potrzebna jego decyzja. Kody zbieramy ze źródeł, nie z listy ręcznej,
// żeby nowy kod w migracji albo w kliencie wykazu wymusił tu tłumaczenie.
test('every automatic-check refusal code the operator can see has Polish copy', () => {
  const sources = [
    'supabase/migrations/20261103090000_sc19_auto_trial_marketing_consent.sql',
    'lib/sc19-trial-auto.ts',
    'lib/sc19-trial-auto-flow.ts',
  ].map(f => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
  const codes = new Set(
    [...sources.matchAll(/'((?:NIP|WHITELIST|STATUS|AUTO|NO_SERVER)_[A-Z_]+|COOLDOWN|IN_FLIGHT|ANOTHER_NIP_TRIED)'/g)]
      .map(m => m[1]),
  );
  assert.ok(codes.has('NIP_RELEASED'), 'the release guard code is among the sources');
  assert.ok(codes.size >= 12, `expected the known refusal codes, found ${codes.size}`);
  const page = readFileSync(new URL('../app/operator/billing/page.tsx', import.meta.url), 'utf8');
  const block = page.match(/const autoReasons: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'the operator page still carries the refusal-code dictionary');
  const translated = new Set([...block[1].matchAll(/^\s*([A-Z_]+):/gm)].map(m => m[1]));
  const missing = [...codes].filter(c => !translated.has(c)).sort();
  assert.deepEqual(missing, [], `refusal codes without Polish copy: ${missing.join(', ')}`);
});

async function catalogPage({packages=publishedPackages(),addons=[],catalogError=null,throws=false,userId=ownerId,
  catalogFlag='true',packagesFlag='true'}={}) {
  const old=process.env.SC19_CATALOG_ENABLED;
  if(catalogFlag===undefined)delete process.env.SC19_CATALOG_ENABLED;else process.env.SC19_CATALOG_ENABLED=catalogFlag;
  const fx=billingAccess({userId,balance:[{plan:'FREE',available:4}]});
  const original=fx.client.rpc;
  fx.client.rpc=async(name,args)=>{
    if(!name.startsWith('pricing_published_'))return original(name,args);
    fx.calls.push({name,args});
    if(throws)throw new Error('private database details');
    return {data:name==='pricing_published_packages'?packages:addons,error:catalogError};
  };
  try {
    return await withFlag(packagesFlag,async()=>({calls:fx.calls,html:renderToStaticMarkup(await billingPage(fx.access)({
      params:Promise.resolve({companyId}),searchParams:Promise.resolve({recruitmentId:'bbbbbbbb-1111-4222-8333-444444444444'}),
    }))}));
  } finally {if(old===undefined)delete process.env.SC19_CATALOG_ENABLED;else process.env.SC19_CATALOG_ENABLED=old;}
}

test('company catalog is read-only for owner and member, using published prices without enabling unready packages',async()=>{
  for(const userId of [ownerId,memberId]) {
    const {html,calls}=await catalogPage({userId});
    const section=html.split('aria-label="Katalog pakietów"')[1].split('</section>')[0];
    assert.match(section,/321,00 zł/);assert.match(section,/654,00 zł/);assert.match(section,/1 501,00 zł/);
    assert.doesNotMatch(section,/300,00 zł|615,00 zł|1 499,00 zł/);
    assert.match(section,/WERYFIKACJA<\/th>.*?Niedostępny do zakupu/);
    assert.match(section,/ASSESSMENT CENTER<\/th>.*?Niedostępny do zakupu/);
    assert.doesNotMatch(section,/<a |<button|<form/);
    assert.match(section,/Dostępność zamówienia, jego cenę i warunki potwierdzisz w kasie/);
    assert.deepEqual(calls.filter(c=>c.name.startsWith('pricing_')).map(c=>c.name).sort(),['pricing_published_addons','pricing_published_packages']);
    assert.match(html,/4<\/strong> analiz CV/);
    assert.match(html,/recruitments\/bbbbbbbb-1111-4222-8333-444444444444/);
    assert.equal(html.includes('/billing/checkout?recruitmentId='),userId===ownerId);
  }
});

test('catalog requires both exact flags and performs no optional reads otherwise',async()=>{
  for(const options of [{catalogFlag:'false'},{catalogFlag:'TRUE'},{catalogFlag:''},{packagesFlag:'false'}]) {
    const {html,calls}=await catalogPage(options);
    assert.doesNotMatch(html,/aria-label="Katalog pakietów"/);
    assert.equal(calls.some(c=>c.name.startsWith('pricing_')),false);
  }
});

test('missing or invalid published catalog shows only a safe notice, with no invented prices',async()=>{
  const duplicate=publishedPackages();duplicate[3]=duplicate[2];
  const broken=publishedPackages();broken[1].gross_minor='32100';
  const sellable=publishedPackages();sellable[1].sellable='true';
  const negative=publishedPackages();negative[1].gross_minor=-1;
  for(const options of [{packages:[]},{packages:null},{packages:{}},{packages:duplicate},{packages:broken},
    {packages:sellable},{packages:negative},{addons:null},{catalogError:{message:'private database details'}},{throws:true}]) {
    const {html}=await catalogPage(options);
    assert.match(html,/Nie można teraz odczytać katalogu/);
    assert.doesNotMatch(html,/321,00 zł|private database details/);
    assert.match(html,/4<\/strong> analiz CV/);
  }
});

test('only reviewed addon names are visible and no addon becomes purchasable from catalog data',async()=>{
  const {html}=await catalogPage({addons:[
    {code:'report',name:'untrusted name',unit:'untrusted unit',gross_minor:1234},
    {code:'ocr_page',name:'other',unit:'other',gross_minor:567},
    {code:'interview',name:'voicebot',unit:'call',gross_minor:999},
    {code:'unknown_service',name:'promised new service',unit:'unit',gross_minor:999},
  ]});
  assert.match(html,/Raport PDF\/CSV: 12,34 zł brutto \/ raport/);
  assert.match(html,/Strona OCR: 5,67 zł brutto \/ strona/);
  assert.match(html,/Zakup dodatków nie jest jeszcze dostępny/);
  assert.doesNotMatch(html,/voicebot|untrusted|promised new service/);
  const bad=await catalogPage({addons:[{code:'report',gross_minor:0}]});
  assert.match(bad.html,/Nie można teraz odczytać katalogu/);
  const duplicate=await catalogPage({addons:[{code:'report',gross_minor:100},{code:'report',gross_minor:200}]});
  assert.match(duplicate.html,/Nie można teraz odczytać katalogu/);
});
