// SC-BUY-002 (bot review finding, PR #266): a visitor who clicks
// "Kup PRESELEKCJĘ" before signing up must still land on the checkout screen
// after confirming the e-mail address. The target travels:
//   /kup/preselekcja -> /register?next=... -> confirmation link -> /auth/callback
//   -> /dashboard?next=... -> /onboarding?next=... -> checkout
// Every hop re-validates the value with safeNextPath, because the link leaves
// our control inside the user's mailbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import * as validation from '../lib/auth-validation.ts';
import * as authUrl from '../lib/auth-url.ts';
import * as legal from '../lib/legal.ts';
import * as marketingConsent from '../lib/marketing-consent.ts';
import * as nextPath from '../lib/safe-next-path.ts';
import * as consentSigning from '../lib/marketing-consent-signing.ts';
import { BUY_PRESELEKCJA_PATH } from '../lib/buy-preselekcja.ts';

process.env.SC19_TRIAL_AUTO_SECRET = 'o'.repeat(32);
const ORIGIN = 'https://skillcheck.example';
const ENV = { NEXT_PUBLIC_SITE_URL: ORIGIN };
const CHECKOUT = '/dashboard/6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/billing/checkout';
const HOSTILE = ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined, 42];

test('the confirmation link carries the purchase target, validated', () => {
  assert.equal(authUrl.authCallbackUrl('signup', ORIGIN, ENV, BUY_PRESELEKCJA_PATH),
    `${ORIGIN}/auth/callback?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
  assert.equal(authUrl.authCallbackUrl('signup', ORIGIN, ENV, CHECKOUT),
    `${ORIGIN}/auth/callback?next=${encodeURIComponent(CHECKOUT)}`);
  // No target, or one that could leave the origin: a plain callback link.
  for (const value of HOSTILE) {
    assert.equal(authUrl.authCallbackUrl('signup', ORIGIN, ENV, value), `${ORIGIN}/auth/callback`, String(value));
  }
  assert.equal(authUrl.authCallbackUrl('signup', ORIGIN, ENV), `${ORIGIN}/auth/callback`);
});

test('a password-reset link never carries a purchase target', () => {
  // A recovery link must land on /reset-password. Honouring `next` there would
  // let a stale or crafted link send someone holding a recovery session
  // somewhere else entirely.
  assert.equal(authUrl.authCallbackUrl('recovery', ORIGIN, ENV, BUY_PRESELEKCJA_PATH), `${ORIGIN}/auth/callback?flow=recovery`);
});

// --- register(): the target reaches Supabase as part of emailRedirectTo -----

function loadActions() {
  const path = new URL('../app/auth/actions.ts', import.meta.url).pathname;
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const require = createRequire(path);
  const signUps = [];
  const client = {
    auth: {
      async getUser() { return { data: { user: null } }; },
      async signUp(args) { signUps.push(args); return { data: { session: null }, error: null }; },
    },
    async rpc() { return { data: null, error: null }; },
  };
  const mocks = {
    'next/navigation': { redirect(url) { const e = new Error('REDIRECT'); e.url = url; throw e; } },
    'next/headers': { async headers() { return new Map([['origin', ORIGIN]]); } },
    '../../lib/supabase/server': { async createClient() { return client; } },
    '../../lib/auth-validation': validation, '../../lib/auth-url': authUrl, '../../lib/legal': legal,
    '../../lib/marketing-consent': marketingConsent,
    '../../lib/marketing-consent-server': consentSigning,
    '../../lib/safe-next-path': nextPath,
  };
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  return { ...mod.exports, signUps };
}

async function registerWith(next) {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  const loaded = loadActions();
  const form = new FormData();
  form.set('email', 'firma@przyklad.pl');
  form.set('password', 'HasloDlugieNaDwanascie');
  form.set(legal.LEGAL_ACCEPTANCE_FIELD, legal.LEGAL_ACCEPTANCE_VALUE);
  if (next !== undefined) form.set('next', next);
  let url = null;
  try { await loaded.register(form); } catch (e) { if (!e.url) throw e; url = e.url; }
  if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = previous;
  return { url, signUps: loaded.signUps };
}

test('signing up from the purchase path asks for a confirmation link that returns to it', async () => {
  const { url, signUps } = await registerWith(BUY_PRESELEKCJA_PATH);
  assert.equal(signUps.length, 1, 'the account was created');
  assert.equal(signUps[0].options.emailRedirectTo,
    `${ORIGIN}/auth/callback?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
  // No session yet (confirmation required), so the browser waits on /login —
  // and that page keeps the target too, for someone who signs in by hand.
  assert.equal(url, `/login?message=confirm&next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
});

test('an ordinary sign-up, or a hostile target, produces a plain confirmation link', async () => {
  for (const next of [undefined, '//evil.example', 'https://evil.example']) {
    const { signUps } = await registerWith(next);
    assert.equal(signUps[0].options.emailRedirectTo, `${ORIGIN}/auth/callback`, String(next));
  }
});

// --- /auth/callback: the confirmed account is sent on with the target --------

function loadCallback() {
  const path = new URL('../app/auth/callback/route.ts', import.meta.url).pathname;
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const require = createRequire(path);
  const mocks = {
    // NextResponse.redirect stands in for the real one: the route only reads the
    // resulting URL and sets two headers on it.
    'next/server': { NextResponse: { redirect: url => ({ url: String(url), headers: { set() {} } }) } },
    '../../../lib/supabase/server': {
      async createClient() {
        return { auth: { async exchangeCodeForSession() { return { data: {}, error: null }; } } };
      },
    },
    '../../../lib/auth-url': authUrl,
    '../../../lib/safe-next-path': nextPath,
  };
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  return mod.exports;
}

async function callbackDestinationFor(query) {
  const { GET } = loadCallback();
  const url = new URL(`${ORIGIN}/auth/callback?${query}`);
  const response = await GET({ nextUrl: url, url: url.toString() });
  return new URL(response.url).pathname + new URL(response.url).search;
}

test('after confirming the address the purchase target survives', async () => {
  assert.equal(await callbackDestinationFor(`code=abc&next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`),
    `/dashboard?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
});

test('a confirmation without a target, or with a hostile one, lands on the dashboard', async () => {
  assert.equal(await callbackDestinationFor('code=abc'), '/dashboard');
  for (const value of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
    assert.equal(await callbackDestinationFor(`code=abc&next=${encodeURIComponent(value)}`), '/dashboard', value);
  }
});

test('a recovery link ignores a target appended to it', async () => {
  assert.equal(await callbackDestinationFor(`code=abc&flow=recovery&next=${encodeURIComponent(CHECKOUT)}`), '/reset-password');
});

test('a callback without a code still goes to the login notice', async () => {
  assert.equal(await callbackDestinationFor(`next=${encodeURIComponent(CHECKOUT)}`), '/login?message=callback');
});

// --- /dashboard: the last hop, on to onboarding or to the target ------------

function loadDashboard(companies) {
  const path = new URL('../app/dashboard/page.tsx', import.meta.url).pathname;
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const require = createRequire(path);
  const client = {
    auth: { async getUser() { return { data: { user: { id: 'u1', email: 'firma@przyklad.pl' } } }; } },
    from: () => ({ select: () => ({ order: async () => ({ data: companies, error: null }) }) }),
  };
  const mocks = {
    'next/navigation': { redirect(url) { const e = new Error('REDIRECT'); e.url = url; throw e; } },
    'next/link': { default: () => null },
    '../../lib/supabase/server': { async createClient() { return client; } },
    '../../lib/safe-next-path': nextPath,
    '../auth/actions': { logout() {} },
    '../components/submit-button': { SubmitButton: () => null },
  };
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, path);
  return mod.exports.default;
}

async function dashboardRedirect(companies, searchParams) {
  const Dashboard = loadDashboard(companies);
  try { await Dashboard({ searchParams: Promise.resolve(searchParams) }); } catch (e) {
    if (e.url) return e.url;
    throw e;
  }
  return null; // the page rendered: the company list
}

const COMPANY = [{ id: '6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', name: 'Firma' }];

test('a brand-new account is sent to onboarding WITH the purchase target', async () => {
  assert.equal(await dashboardRedirect([], { next: BUY_PRESELEKCJA_PATH }),
    `/onboarding?next=${encodeURIComponent(BUY_PRESELEKCJA_PATH)}`);
  // This is the whole point of the fix: without the target the new owner
  // finishes in the company list and has to find the button again.
  assert.equal(await dashboardRedirect([], {}), '/onboarding');
});

test('an account that already has a company goes straight to the target', async () => {
  assert.equal(await dashboardRedirect(COMPANY, { next: CHECKOUT }), CHECKOUT);
  assert.equal(await dashboardRedirect(COMPANY, { next: BUY_PRESELEKCJA_PATH }), BUY_PRESELEKCJA_PATH);
});

test('no target, a hostile one, or one pointing back here: the company list renders', async () => {
  for (const searchParams of [{}, { next: '//evil.example' }, { next: 'https://evil.example' },
    { next: '/dashboard' }, { next: '/dashboard?message=owner-required' }]) {
    assert.equal(await dashboardRedirect(COMPANY, searchParams), null, JSON.stringify(searchParams));
  }
});
