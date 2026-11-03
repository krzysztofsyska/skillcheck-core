import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { safeNextPath, withNext } from '../lib/safe-next-path.ts';
import { BUY_PRESELEKCJA_LABEL, BUY_PRESELEKCJA_PATH, buyPreselekcjaTarget } from '../lib/buy-preselekcja.ts';
import * as validation from '../lib/auth-validation.ts';
import * as authUrl from '../lib/auth-url.ts';
import * as legal from '../lib/legal.ts';
import * as nextPath from '../lib/safe-next-path.ts';

// SC-BUY-001: one visible "Kup PRESELEKCJĘ" button leads, in a single click, to
// the package checkout screen. Three redirect scenarios plus `next` validation.

test('a signed-in user with a company goes straight to that company checkout', () => {
  const id = '6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
  assert.equal(buyPreselekcjaTarget({ signedIn: true, companyId: id }), `/dashboard/${id}/billing/checkout`);
});

test('a signed-in user without a company creates one first and returns here', () => {
  assert.equal(buyPreselekcjaTarget({ signedIn: true, companyId: null }),
    `/onboarding?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
});

test('an anonymous visitor registers first and returns here', () => {
  assert.equal(buyPreselekcjaTarget({ signedIn: false, companyId: null }),
    `/register?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
  // A stale company id never shortcuts the sign-in requirement.
  assert.equal(buyPreselekcjaTarget({ signedIn: false, companyId: 'abc' }),
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
  ]) assert.equal(safeNextPath(value), null, `rejected: ${String(value)}`);
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
  const external = new FormData(); external.set('name', 'Firma'); external.set('next', '//evil.example');
  assert.equal(await target(() => loadActions({ rpc: { data: id, error: null } }).createCompany(external)), `/dashboard/${id}`);
});

// Surfaces: the button exists where the owner asked for it, and the dashboard
// billing page orders through the checkout screen instead of the contact form.
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('the Kup PRESELEKCJĘ button is on the home page, the header and /preselekcja', () => {
  for (const file of [
    'app/components/marketing/home-page.tsx',
    'app/components/marketing/package-comparison.tsx',
    'app/components/marketing/site-header.tsx',
    'app/preselekcja/page.tsx',
  ]) {
    const source = read(file);
    assert.match(source, /BUY_PRESELEKCJA_PATH/, `${file} links to the purchase path`);
    assert.match(source, /BUY_PRESELEKCJA_LABEL/, `${file} uses the approved label`);
  }
  // The mobile menu is fed by the header's link list.
  assert.match(read('app/components/marketing/site-header.tsx'),
    /\{ href: BUY_PRESELEKCJA_PATH, label: BUY_PRESELEKCJA_LABEL/);
  assert.equal(BUY_PRESELEKCJA_LABEL, 'Kup PRESELEKCJĘ');
});

test('the dashboard billing page orders through the checkout screen', () => {
  const source = read('app/dashboard/[companyId]/billing/page.tsx');
  assert.match(source, /href=\{`\/dashboard\/\$\{companyId\}\/billing\/checkout`\}>Zamów PRESELEKCJĘ</);
  assert.equal(/href="\/rozmowa">Zamów PRESELEKCJĘ/.test(source), false);
});

test('the purchase route resolves server-side and never renders', () => {
  const source = read('app/kup/preselekcja/page.tsx');
  assert.match(source, /auth\.getUser\s*\(/);
  assert.match(source, /redirect\(buyPreselekcjaTarget\(/);
  // Only an owner may order, so an owned company wins over one the user only recruits for.
  assert.match(source, /company\.owner_id === user\.id/);
});

test('the checkout fallback shows the approved package, consent and the payment button', () => {
  const source = read('app/dashboard/[companyId]/billing/checkout/checkout.tsx');
  // No dead end when the offers API is unavailable.
  assert.equal(source.includes('Płatności nie są jeszcze dostępne'), false);
  assert.match(source, /setFallback\(true\)/);
  // The package size now comes from the server as the active policy quota.
  assert.match(read('app/dashboard/[companyId]/billing/checkout/page.tsx'), /preselekcjaOffer\.analyses/);
  assert.match(source, /preselekcjaOffer\.grossPln/);
  assert.match(source, /preselekcjaOffer\.netPln/);
  assert.match(source, /preselekcjaOffer\.validityMonths/);
  assert.match(source, /href="\/regulamin"/);
  assert.match(source, /href="\/polityka-prywatnosci"/);
  assert.match(source, /Przejdź do płatności/);
  // An empty or non-https env keeps the button disabled with the configuration note.
  assert.match(source, /NEXT_PUBLIC_P24_CHECKOUT_URL/);
  assert.match(source, /url\.protocol!=='https:'/);
  assert.match(source, /Płatność Przelewy24 — konfiguracja w toku/);
  // No server-side order exists in this mode: the payment carries the company
  // reference and the screen never promises an automatic credit grant.
  assert.match(source, /searchParams\.set\('ref',companyId\)/);
  assert.match(source, /analizy przyznaje operator po potwierdzeniu wpłaty/);
  // The promised package size follows the active policy, not a hardcoded number.
  assert.match(source, /fallbackCredits/);
  assert.match(read('app/dashboard/[companyId]/billing/checkout/page.tsx'), /loadSc19PackageSizes\(client\)/);
});

test('the Przelewy24 API integration is untouched and the env var is documented', () => {
  assert.match(read('.env.example'), /^NEXT_PUBLIC_P24_CHECKOUT_URL=$/m);
});
