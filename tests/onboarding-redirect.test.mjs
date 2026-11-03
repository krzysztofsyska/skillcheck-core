import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import * as validation from '../lib/auth-validation.ts';
import * as authUrl from '../lib/auth-url.ts';
import * as legal from '../lib/legal.ts';
import * as marketingConsent from '../lib/marketing-consent.ts';
// The real signing module stands in for the 'server-only' wrapper the action
// imports, so the test exercises the actual HMAC and not a stub.
import * as consentSigning from '../lib/marketing-consent-signing.ts';

// SC-CONSENT-001: the registration snapshot is HMAC-signed with the server
// secret, so the action needs one configured. A value local to this test.
process.env.SC19_TRIAL_AUTO_SECRET = 'o'.repeat(32);
const EMAIL = 'firma@przyklad.pl';
const signed = granted => consentSigning.signedConsentDeclaration(granted, EMAIL);

// Loads app/auth/actions.ts with mocked Next.js and Supabase modules.
// `calls` records every RPC, so a test can see what createCompany did besides
// creating the company (SC-CONSENT-001 records the registration consent here).
function load(rpcResult, user = { id: 'u1', email: EMAIL }) {
  const path = new URL('../app/auth/actions.ts', import.meta.url).pathname;
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const require = createRequire(path);
  const calls = [];
  const client = {
    auth: { async getUser() { return { data: { user } }; } },
    async rpc(name, args) {
      calls.push([name, args]);
      return typeof rpcResult === 'function' ? rpcResult(name, args) : rpcResult;
    },
  };
  const mocks = {
    'next/navigation': { redirect(url) { const e = new Error('REDIRECT'); e.url = url; throw e; } },
    'next/headers': { async headers() { return new Map(); } },
    '../../lib/supabase/server': { async createClient() { return client; } },
    '../../lib/auth-validation': validation, '../../lib/auth-url': authUrl, '../../lib/legal': legal,
    '../../lib/marketing-consent': marketingConsent,
    '../../lib/marketing-consent-server': consentSigning,
  };
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  return { ...mod.exports, calls };
}
async function target(rpcResult, name = 'Firma') {
  const form = new FormData(); form.set('name', name);
  try { await load(rpcResult).createCompany(form); } catch (e) { if (e.url) return e.url; throw e; }
  return null;
}
const id = '6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

test('after creating a company the user lands on that company, not the list', async () => {
  assert.equal(await target({ data: id, error: null }), `/dashboard/${id}`);
});
test('an unexpected RPC value falls back to the company list; errors stay on onboarding', async () => {
  for (const data of [null, '', '../operator', `${id}/x`, 42]) assert.equal(await target({ data, error: null }), '/dashboard');
  assert.equal(await target({ data: null, error: { message: 'x' } }), '/onboarding?message=failed');
  assert.equal(await target({ data: id, error: null }, '   '), '/onboarding?message=invalid');
});

// SC-CONSENT-001: the registration-time consent is bound to the new company.
async function createWith(user, rpcResult = { data: id, error: null }) {
  const loaded = load(rpcResult, user);
  const form = new FormData(); form.set('name', 'Firma');
  try { await loaded.createCompany(form); } catch (e) { if (!e.url) throw e; }
  return loaded.calls;
}

test('a ticked marketing consent is recorded against the new company', async () => {
  const calls = await createWith({ id: 'u1', email: EMAIL, user_metadata: { marketing_consent: signed(true) } });
  // The signed RPC, not the panel one: 'registration' is written only against a
  // request signed with the server secret, so an owner calling the Data API
  // himself cannot have the ledger attribute his consent to sign-up.
  assert.deepEqual(calls.map(([name]) => name), ['ensure_initial_company', 'marketing_consent_grant_registration']);
  assert.deepEqual(Object.keys(calls[1][1]).sort(),
    ['consent_version', 'issued_at_ms', 'request_id', 'request_signature', 'target_company']);
  assert.equal(calls[1][1].target_company, id);
  assert.equal(calls[1][1].consent_version, marketingConsent.MARKETING_CONSENT_VERSION);
  assert.match(calls[1][1].request_signature, /^[0-9a-f]{64}$/);
  // Only the version crosses over: the wording comes from the database, and the
  // source is not a parameter of either RPC any more.
  assert.equal('consent_text' in calls[1][1], false);
  assert.equal('consent_source' in calls[1][1], false);
});

test('no consent, a withdrawn one or a FORGED one records nothing', async () => {
  const real = signed(true);
  for (const metadata of [
    undefined, {}, { marketing_consent: null },
    { marketing_consent: signed(false) },
    { marketing_consent: { granted: true, version: 'marketing-9.9' } },
    { marketing_consent: { granted: 'yes', version: marketingConsent.MARKETING_CONSENT_VERSION } },
    // user_metadata is client-writable: a snapshot the user wrote or edited
    // themselves must not reach the ledger, or an append-only record would
    // certify a consent that was never given.
    { marketing_consent: { version: marketingConsent.MARKETING_CONSENT_VERSION, granted: true, declared_at: real.declared_at } },
    { marketing_consent: { ...real, sig: '' } },
    { marketing_consent: { ...real, sig: 'f'.repeat(64) } },
    { marketing_consent: { ...signed(false), granted: true } },
    { marketing_consent: { ...real, declared_at: '2030-01-01T00:00:00.000Z' } },
  ]) {
    const calls = await createWith({ id: 'u1', email: EMAIL, user_metadata: metadata });
    assert.deepEqual(calls.map(([name]) => name), ['ensure_initial_company'], JSON.stringify(metadata));
  }
  // A valid snapshot belonging to another account records nothing either.
  const other = await createWith({ id: 'u2', email: 'ktos.inny@przyklad.pl', user_metadata: { marketing_consent: real } });
  assert.deepEqual(other.map(([name]) => name), ['ensure_initial_company']);
});

test('a failed consent write never blocks the company', async () => {
  // The company is created, the consent write fails: the owner must still reach
  // the dashboard. A consent record is a record, not a gate on registration.
  //
  // The second case is the replay the database refuses (review finding, bot
  // 2026-11-03): the snapshot in user_metadata never expires and
  // ensure_initial_company returns the EXISTING company, so this action can be
  // re-run after the owner has withdrawn the consent. The one-shot rule is
  // enforced in the database (private.marketing_consent_record plus the unique
  // index marketing_consent_one_registration_per_company), and here we only
  // check that its refusal is swallowed exactly like any other: no new ledger
  // row, no crash, the owner still lands on his dashboard.
  for (const error of [
    { code: '42501', message: 'sc19_company_forbidden' },
    { code: '22023', message: 'marketing_consent_registration_not_first' },
  ]) {
    const loaded = load(
      name => name === 'marketing_consent_grant_registration' ? { data: null, error } : { data: id, error: null },
      { id: 'u1', email: EMAIL, user_metadata: { marketing_consent: signed(true) } },
    );
    const form = new FormData(); form.set('name', 'Firma');
    let url = null;
    try { await loaded.createCompany(form); } catch (e) { url = e.url ?? null; }
    assert.equal(url, `/dashboard/${id}`, 'the owner still reaches the company dashboard');
    assert.deepEqual(loaded.calls.map(([name]) => name), ['ensure_initial_company', 'marketing_consent_grant_registration']);
  }
});
