import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nextRedirectTarget, safeNextPath, withNext } from '../lib/safe-next-path.ts';
import { BUY_PRESELEKCJA_LABEL, BUY_PRESELEKCJA_PATH, buyPreselekcjaTarget, selectPurchaseCompany } from '../lib/buy-preselekcja.ts';
import * as validation from '../lib/auth-validation.ts';
import * as authUrl from '../lib/auth-url.ts';
import * as legal from '../lib/legal.ts';
import * as nextPath from '../lib/safe-next-path.ts';
import * as marketingConsent from '../lib/marketing-consent.ts';
// SC-CONSENT-001 also lives in app/auth/actions.ts, so loading that module here
// needs its two consent dependencies mocked as well. The real signing module
// stands in for the 'server-only' wrapper the action imports, exactly as
// tests/onboarding-redirect.test.mjs does it, and the secret is a value local
// to this test. No consent is recorded in any scenario below: the mocked users
// carry no signed sign-up snapshot.
import * as consentSigning from '../lib/marketing-consent-signing.ts';
process.env.SC19_TRIAL_AUTO_SECRET ??= 'o'.repeat(32);

// SC-BUY-001: one visible "Kup PRESELEKCJĘ" button leads, in a single click, to
// the package checkout screen. Three redirect scenarios plus `next` validation.

const OWNER = 'u-owner';
const owned = { id: '6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', owner_id: OWNER };
const someoneElses = { id: 'aaaaaaaa-1111-4222-8333-444444444444', owner_id: 'u-other' };

test('a signed-in owner goes straight to that company checkout', () => {
  assert.equal(buyPreselekcjaTarget({ userId: OWNER, companies: [owned] }),
    `/dashboard/${owned.id}/billing/checkout`);
  // An owned company wins over one the user only recruits for, whatever the order.
  assert.equal(buyPreselekcjaTarget({ userId: OWNER, companies: [someoneElses, owned] }),
    `/dashboard/${owned.id}/billing/checkout`);
  assert.equal(selectPurchaseCompany([someoneElses, owned], OWNER), owned.id);
  assert.equal(selectPurchaseCompany([someoneElses], OWNER), null);
  assert.equal(selectPurchaseCompany([], OWNER), null);
});

test('a signed-in user without a company creates one first and returns here', () => {
  assert.equal(buyPreselekcjaTarget({ userId: OWNER, companies: [] }),
    `/onboarding?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
});

test('a recruiter who owns nothing is told why, not sent to a screen that refuses them', () => {
  assert.equal(buyPreselekcjaTarget({ userId: OWNER, companies: [someoneElses] }),
    '/dashboard?message=owner-required');
  assert.match(readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8'),
    /owner-required/);
});

test('an anonymous visitor registers first and returns here', () => {
  assert.equal(buyPreselekcjaTarget({ userId: null, companies: [] }),
    `/register?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
  // A readable company never shortcuts the sign-in requirement.
  assert.equal(buyPreselekcjaTarget({ userId: null, companies: [owned] }),
    `/register?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
});

test('only internal paths survive next validation — no open redirect', () => {
  assert.equal(safeNextPath(BUY_PRESELEKCJA_PATH), BUY_PRESELEKCJA_PATH);
  assert.equal(safeNextPath('/dashboard/x/billing/checkout?a=1#b'), '/dashboard/x/billing/checkout?a=1#b');
  for (const value of [
    'https://evil.example', 'http://evil.example', '//evil.example', '///evil.example',
    '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)', 'data:text/html,x',
    'kup/preselekcja', '', '   ', null, undefined, 42, {},
    '/ok\nSet-Cookie: a=b', '/ok\u0000', '/' + 'a'.repeat(600),
    // Dot segments are resolved after the prefix check, so a leading "/.." can
    // hide a protocol-relative target: these must be rejected on the OUTPUT.
    '/..//evil.example', '/.//evil.example', '/a/../..//evil.example',
    '/./\\/evil', '/../\\/evil.example', '/a\\/evil', '/\\\\evil.example',
  ]) assert.equal(safeNextPath(value), null, `rejected: ${String(value)}`);
});

test('safeNextPath is idempotent — what it returns, it also accepts unchanged', () => {
  for (const value of [
    '/kup/preselekcja', '/dashboard/x/billing/checkout?a=1#b', '/a/../b', '/./a',
    '/..//evil.example', '/a/../..//evil.example', '/./\\/evil', '/%2f%2fevil.example',
  ]) {
    const once = safeNextPath(value);
    assert.equal(safeNextPath(once), once, `idempotent for: ${value}`);
    if (once !== null) {
      assert.ok(once.startsWith('/') && !once.startsWith('//') && !once.includes('\\'),
        `accepted value stays internal: ${value} -> ${once}`);
    }
  }
});

test('nextRedirectTarget never hands redirect() an unvalidated value', () => {
  assert.equal(nextRedirectTarget('/kup/preselekcja', '/dashboard'), '/kup/preselekcja');
  for (const value of ['//evil.example', '/..//evil.example', 'https://evil.example', null, '/a\\/evil'])
    assert.equal(nextRedirectTarget(value, '/dashboard'), '/dashboard', `fallback for: ${String(value)}`);
});

test('withNext appends only a validated target and leaves the path alone otherwise', () => {
  assert.equal(withNext('/login', '/kup/preselekcja'), '/login?next=%2Fkup%2Fpreselekcja');
  assert.equal(withNext('/login?message=failed', '/kup/preselekcja'), '/login?message=failed&next=%2Fkup%2Fpreselekcja');
  assert.equal(withNext('/login', 'https://evil.example'), '/login');
  assert.equal(withNext('/login', null), '/login');
});

// The auth actions carry a validated `next` through sign-in, sign-up and the
// first company, so the visitor lands back on the purchase path.
function loadActions({ signInError = null, rpc = { data: null, error: null }, user = { id: 'u1' } } = {}) {
  const path = new URL('../app/auth/actions.ts', import.meta.url).pathname;
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const require = createRequire(path);
  const client = {
    auth: {
      async getUser() { return { data: { user } }; },
      async signInWithPassword() { return { error: signInError }; },
    },
    async rpc() { return rpc; },
  };
  const mocks = {
    'next/navigation': { redirect(url) { const e = new Error('REDIRECT'); e.url = url; throw e; } },
    'next/headers': { async headers() { return new Map(); } },
    '../../lib/supabase/server': { async createClient() { return client; } },
    '../../lib/auth-validation': validation, '../../lib/auth-url': authUrl,
    '../../lib/legal': legal, '../../lib/safe-next-path': nextPath,
    '../../lib/marketing-consent': marketingConsent,
    '../../lib/marketing-consent-server': consentSigning,
  };
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  return mod.exports;
}
async function target(run) {
  try { await run(); } catch (e) { if (e.url) return e.url; throw e; }
  return null;
}

test('sign-in returns to the purchase path and refuses an external one', async () => {
  const form = new FormData();
  form.set('email', 'kupujacy@firma.example'); form.set('password', 'haslo-dluzsze-niz-12');
  form.set('next', BUY_PRESELEKCJA_PATH);
  assert.equal(await target(() => loadActions().login(form)), BUY_PRESELEKCJA_PATH);
  form.set('next', 'https://evil.example');
  assert.equal(await target(() => loadActions().login(form)), '/dashboard');
  form.set('next', BUY_PRESELEKCJA_PATH);
  assert.equal(await target(() => loadActions({ signInError: { message: 'x' } }).login(form)),
    `/login?message=failed&next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
});

test('the first company hands the visitor back to the purchase path', async () => {
  const id = '6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
  const form = new FormData(); form.set('name', 'Firma'); form.set('next', BUY_PRESELEKCJA_PATH);
  assert.equal(await target(() => loadActions({ rpc: { data: id, error: null } }).createCompany(form)), BUY_PRESELEKCJA_PATH);
  const plain = new FormData(); plain.set('name', 'Firma');
  assert.equal(await target(() => loadActions({ rpc: { data: id, error: null } }).createCompany(plain)), `/dashboard/${id}`);
  for (const hostile of ['//evil.example', '/..//evil.example', '/a\\/evil', 'https://evil.example']) {
    const external = new FormData(); external.set('name', 'Firma'); external.set('next', hostile);
    const landed = await target(() => loadActions({ rpc: { data: id, error: null } }).createCompany(external));
    assert.ok(landed === `/dashboard/${id}` || landed === '/dashboard', `never leaves the origin: ${hostile} -> ${landed}`);
  }
});

// Surfaces: the button exists where the owner asked for it, and the dashboard
// billing page orders through the checkout screen instead of the contact form.
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function renderWorkspace(params) {
  function loadComponent(file, mocks) {
    const path = new URL(`../${file}`, import.meta.url).pathname;
    const mod = new Module(path); mod.filename = path;
    mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
    const require = createRequire(path);
    mod.require = id => id in mocks ? mocks[id] : require(id);
    mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, path);
    return mod.exports;
  }
  const navigation = loadComponent('app/components/workspace-navigation.tsx', {
    'next/navigation': { useParams: () => params },
    '../../lib/buy-preselekcja': { BUY_PRESELEKCJA_LABEL, BUY_PRESELEKCJA_PATH },
    './workspace-navigation.module.css': { default: {} },
  });
  const { default: Layout } = loadComponent('app/dashboard/layout.tsx', {
    '../components/workspace-navigation': navigation,
  });
  return renderToStaticMarkup(createElement(Layout, null,
    createElement('main', null, 'Treść panelu firmy')));
}

test('every dashboard page offers a way to the public site and another purchase', () => {
  for (const params of [{}, { companyId: owned.id }, {
    companyId: owned.id, recruitmentId: 'recruitment-1', applicationId: 'application-1',
  }]) {
    const html = renderWorkspace(params);
    assert.match(html, /aria-label="Nawigacja konta"/);
    assert.match(html, /href="\/">SkillCheck — strona główna<\/a>/);
    assert.match(html, /href="\/#pakiety">Oferta i pakiety<\/a>/);
    assert.match(html, /href="\/dashboard">Moje konto<\/a>/);
    const purchase = params.companyId
      ? `/dashboard/${owned.id}/billing/checkout` : '/kup/preselekcja';
    assert.ok(html.includes(`href="${purchase}">Kup PRESELEKCJĘ</a>`));
    assert.match(html, /<main>Treść panelu firmy<\/main>/);
  }
});

test('purchase navigation stays in the selected company rather than choosing the first one', () => {
  const otherOwnedCompany = 'bbbbbbbb-1111-4222-8333-444444444444';
  const html = renderWorkspace({ companyId: otherOwnedCompany });
  assert.ok(html.includes(`href="/dashboard/${otherOwnedCompany}/billing/checkout"`));
  assert.equal(html.includes(`href="/dashboard/${owned.id}/billing/checkout"`), false);
  assert.equal(html.includes('href="/kup/preselekcja"'), false);
});

test('the approved label and the dashboard purchase path are the ones shipped', () => {
  // The button itself is asserted behaviourally against the rendered home page
  // in tests/marketing-http.test.mjs; the checkout screen behaviour lives in
  // tests/sc-019-payment-checkout.test.mjs. Only value assertions belong here.
  assert.equal(BUY_PRESELEKCJA_LABEL, 'Kup PRESELEKCJĘ');
  assert.equal(BUY_PRESELEKCJA_PATH, '/kup/preselekcja');
  // The dashboard route to the checkout screen is owned by SC-P24-VERIFY-001;
  // this task only guarantees the public one-click path still ends there.
  const billing = read('app/dashboard/[companyId]/billing/page.tsx');
  assert.match(billing, /const checkoutHref = `\/dashboard\/\$\{companyId\}\/billing\/checkout` \+/);
  assert.match(billing, /href=\{checkoutHref\}/);
});

test('every next consumer re-validates before redirecting', () => {
  // A value that crossed a request boundary is never passed to redirect() raw.
  const onboarding = read('app/onboarding/page.tsx');
  assert.match(onboarding, /nextRedirectTarget\(next, "\/dashboard"\)/);
  for (const raw of [/redirect\(next\)/, /redirect\(next \?\?/, /\? next :/])
    assert.equal(raw.test(onboarding), false, `no raw redirect of next in onboarding: ${raw}`);
  const actions = read('app/auth/actions.ts');
  for (const raw of [/redirect\(next\)/, /redirect\(next \?\?/])
    assert.equal(raw.test(actions), false, `no raw redirect of next in auth actions: ${raw}`);
});



// SC-019 / #283: route-level regression. A recruitment can reach checkout without
// pretending that unavailable extras are purchasable. The checkout reconstructs
// the return link from a UUID, never from an arbitrary URL.
async function renderRecruitmentPurchase(enabled) {
  const file='app/dashboard/[companyId]/recruitments/[recruitmentId]/page.tsx';
  const abs=new URL('../'+file,import.meta.url).pathname;
  const mod=new Module(abs);mod.filename=abs;mod.paths=Module._nodeModulePaths(new URL('../',import.meta.url).pathname);
  const req=createRequire(abs);
  const recruitmentId='bbbbbbbb-1111-4222-8333-444444444444';
  const query=table=>{
    const obj={select(){return this;},eq(){return this;},order(){return this;},in(){return this;},
      maybeSingle:async()=>({data:{id:recruitmentId,name:'Rekrutacja próbna',position_id:owned.id},error:null}),
      then(resolve){return Promise.resolve({data:[],error:null}).then(resolve);}};
    return obj;
  };
  const client={from:query,rpc:async()=>({data:[],error:null})};
  const mocks={
    'next/link':{default:({children,...props})=>createElement('a',props,children)},
    'next/navigation':{notFound(){throw Error('not-found');}},
    '../../../../../lib/company-access':{companyAccess:async()=>({client,canEdit:true})},
    './assessment-forms':{StageForm:()=>null,StageControls:()=>null},
    './bulk/groups':{PreselectionGroups:()=>null},
    '../../../../../lib/screening-report':{groupAnalysisCurrent:()=>false},
    '../../../../../lib/preselection-currency':{loadCurrentRanking:async()=>new Map()},
  };
  mod.require=id=>id in mocks?mocks[id]:req(id);
  mod._compile(ts.transpileModule(readFileSync(abs,'utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }}).outputText,abs);
  const previous=process.env.SC19_PACKAGES_ENABLED;
  try {
    if(enabled)process.env.SC19_PACKAGES_ENABLED='true';else delete process.env.SC19_PACKAGES_ENABLED;
    const output=await mod.exports.default({params:Promise.resolve({companyId:owned.id,recruitmentId})});
    return renderToStaticMarkup(output);
  } finally {
    if(previous===undefined)delete process.env.SC19_PACKAGES_ENABLED;
    else process.env.SC19_PACKAGES_ENABLED=previous;
  }
}
test('recruitment shows purchase links only while package sales are enabled',async()=>{
  const html=await renderRecruitmentPurchase(true);
  const prefix='/dashboard/'+owned.id+'/billing';
  assert.ok(html.includes('href="'+prefix+'?recruitmentId=bbbbbbbb-1111-4222-8333-444444444444">Pakiet i pozostałe analizy CV</a>'));
  assert.ok(html.includes('href="'+prefix+'/checkout?recruitmentId=bbbbbbbb-1111-4222-8333-444444444444">Kup kolejną PRESELEKCJĘ</a>'));
  const disabled=await renderRecruitmentPurchase(false);
  assert.equal(disabled.includes('/billing/checkout?recruitmentId='),false);
});
async function renderReturnFromCheckout(recruitmentId) {
  const file='app/dashboard/[companyId]/billing/checkout/page.tsx';
  const abs=new URL('../'+file,import.meta.url).pathname;
  const mod=new Module(abs);mod.filename=abs;mod.paths=Module._nodeModulePaths(new URL('../',import.meta.url).pathname);
  const req=createRequire(abs);
  const mocks={
    'next/link':{default:({children,...props})=>createElement('a',props,children)},
    '../../../../../lib/company-access':{companyAccess:async()=>({company:{owner_id:OWNER},user:{id:OWNER}})},
    '../../../../../lib/sc19-payment-preview.ts':{sc19PreviewPaymentConfig:()=>null},
    './checkout':{default:()=>createElement('div',null,'Oferta')},
  };
  mod.require=id=>id in mocks?mocks[id]:req(id);
  mod._compile(ts.transpileModule(readFileSync(abs,'utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }}).outputText,abs);
  const output=await mod.exports.default({
    params:Promise.resolve({companyId:owned.id}),searchParams:Promise.resolve({recruitmentId}),
  });
  return renderToStaticMarkup(output);
}
test('checkout returns only to a valid in-company recruitment path, never an external URL',async()=>{
  const valid='bbbbbbbb-1111-4222-8333-444444444444';
  assert.ok((await renderReturnFromCheckout(valid)).includes('href="/dashboard/'+owned.id+'/recruitments/'+valid+'">'));
  for(const invalid of ['//evil.example','https://evil.example','../operator',valid+'/../operator',null,[valid]]) {
    const html=await renderReturnFromCheckout(invalid);
    assert.ok(html.includes('href="/dashboard/'+owned.id+'">'),String(invalid));
    assert.ok(!html.includes('evil.example'),String(invalid));
  }
});


// A recruitment's context must survive a visit to the shared company catalogue,
// without granting extra purchase rights or accepting a caller-controlled URL.
async function renderBillingFromRecruitment(recruitmentId, enabled=true) {
  const file='app/dashboard/[companyId]/billing/page.tsx';
  const abs=new URL('../'+file,import.meta.url).pathname;
  const mod=new Module(abs);mod.filename=abs;mod.paths=Module._nodeModulePaths(new URL('../',import.meta.url).pathname);
  const req=createRequire(abs);
  const client={rpc:async()=>({data:[{plan:'FREE',available:4}],error:null})};
  const mocks={
    'next/link':{default:({children,...props})=>createElement('a',props,children)},
    '../../../../lib/company-access':{companyAccess:async()=>({
      client,company:{...owned,name:'Firma próbna'},user:{id:OWNER},
    })},
    '../../../../lib/sc19-package-sizes':{
      loadSc19PackageSizes:async()=>({FREE:5,PRESELEKCJA:60}),
      sc19AnalysisScope:n=>String(n)+' analiz',
    },
    './actions':{activateSc19Free:async()=>{}},
  };
  mod.require=id=>id in mocks?mocks[id]:req(id);
  mod._compile(ts.transpileModule(readFileSync(abs,'utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }}).outputText,abs);
  const previous=process.env.SC19_PACKAGES_ENABLED;
  try {
    if(enabled)process.env.SC19_PACKAGES_ENABLED='true';else delete process.env.SC19_PACKAGES_ENABLED;
    const output=await mod.exports.default({
      params:Promise.resolve({companyId:owned.id}),
      searchParams:Promise.resolve({recruitmentId}),
    });
    return renderToStaticMarkup(output);
  } finally {
    if(previous===undefined)delete process.env.SC19_PACKAGES_ENABLED;
    else process.env.SC19_PACKAGES_ENABLED=previous;
  }
}
test('company catalogue preserves the recruitment return and checkout context',async()=>{
  const id='bbbbbbbb-1111-4222-8333-444444444444',base='/dashboard/'+owned.id;
  const html=await renderBillingFromRecruitment(id);
  assert.ok(html.includes('href="'+base+'/recruitments/'+id+'">'),html.slice(0,300));
  assert.ok(html.includes('href="'+base+'/billing/checkout?recruitmentId='+id+'">'));
  const disabled=await renderBillingFromRecruitment(id,false);
  assert.ok(disabled.includes('href="'+base+'/recruitments/'+id+'">'));
  assert.ok(!disabled.includes('/billing/checkout?recruitmentId='));
});
test('company catalogue rejects invalid or arbitrary return URLs',async()=>{
  const id='bbbbbbbb-1111-4222-8333-444444444444',base='/dashboard/'+owned.id;
  for(const invalid of ['https://evil.example','//evil.example','../admin',id+'/..',null,[id]]) {
    const html=await renderBillingFromRecruitment(invalid);
    assert.ok(html.includes('href="'+base+'">'),String(invalid));
    assert.ok(html.includes('href="'+base+'/billing/checkout">'),String(invalid));
    assert.ok(!html.includes('evil.example'),String(invalid));
  }
});
