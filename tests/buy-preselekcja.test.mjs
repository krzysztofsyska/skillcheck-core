import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { nextRedirectTarget, safeNextPath, withNext } from '../lib/safe-next-path.ts';
import { BUY_PRESELEKCJA_LABEL, BUY_PRESELEKCJA_PATH, buyPreselekcjaTarget, selectPurchaseCompany } from '../lib/buy-preselekcja.ts';
import * as validation from '../lib/auth-validation.ts';
import * as authUrl from '../lib/auth-url.ts';
import * as legal from '../lib/legal.ts';
import * as nextPath from '../lib/safe-next-path.ts';

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

test('the approved label and the dashboard purchase path are the ones shipped', () => {
  // The button itself is asserted behaviourally against the rendered home page
  // in tests/marketing-http.test.mjs; the checkout screen behaviour lives in
  // tests/sc-019-payment-checkout.test.mjs. Only value assertions belong here.
  assert.equal(BUY_PRESELEKCJA_LABEL, 'Kup PRESELEKCJĘ');
  assert.equal(BUY_PRESELEKCJA_PATH, '/kup/preselekcja');
  const billing = read('app/dashboard/[companyId]/billing/page.tsx');
  assert.match(billing, /href=\{`\/dashboard\/\$\{companyId\}\/billing\/checkout`\}>Zamów PRESELEKCJĘ</);
  assert.equal(/href="\/rozmowa">Zamów PRESELEKCJĘ/.test(billing), false);
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

test('with packages not launched the checkout screen says so instead of implying automatic activation', () => {
  const page = read('app/dashboard/[companyId]/billing/checkout/page.tsx');
  // The promised quota is verified against the live policy in EVERY state —
  // the flag decides how a package is activated, not whether the number is real.
  assert.match(page, /let fallbackCredits: number\|null;\s*\n\s*try\{fallbackCredits=\(await loadSc19PackageSizes\(client\)\)\.PRESELEKCJA;\}catch\{fallbackCredits=null;\}/);
  assert.equal(/fallbackCredits[^;]*=\s*preselekcjaOffer\.analyses/.test(page), false,
    'the marketing figure is never shown as the purchasable quota');
  // The flag, not an API failure, selects manual fulfilment.
  assert.match(page, /packagesEnabled=\{packagesEnabled\}/);
  assert.match(read('app/dashboard/[companyId]/billing/checkout/checkout.tsx'),
    /if\(!packagesEnabled\)\{setFallback\(true\)/);
  // Same statement as the billing page makes when SC19_PACKAGES_ENABLED is off,
  // so the purchase screen never contradicts the rest of the product.
  assert.match(page, /!packagesEnabled&&/);
  assert.match(page, /Automatyczne przyznawanie pakietów nie jest jeszcze uruchomione/);
  assert.match(page, /analizy dodajemy ręcznie po potwierdzeniu wpłaty/);
});

test('the Przelewy24 API integration is untouched and the env var is documented', () => {
  assert.match(read('.env.example'), /^NEXT_PUBLIC_P24_CHECKOUT_URL=$/m);
});
