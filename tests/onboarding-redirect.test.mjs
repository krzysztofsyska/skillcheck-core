import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import * as validation from '../lib/auth-validation.ts';
import * as authUrl from '../lib/auth-url.ts';
import * as legal from '../lib/legal.ts';
import * as marketingConsent from '../lib/marketing-consent.ts';

// Loads app/auth/actions.ts with mocked Next.js and Supabase modules.
// `calls` records every RPC, so a test can see what createCompany did besides
// creating the company (SC-CONSENT-001 records the registration consent here).
function load(rpcResult, user = { id: 'u1' }) {
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
  const declaration = marketingConsent.marketingConsentDeclaration(true);
  const calls = await createWith({ id: 'u1', user_metadata: { marketing_consent: declaration } });
  assert.deepEqual(calls.map(([name]) => name), ['ensure_initial_company', 'marketing_consent_grant']);
  assert.deepEqual(calls[1][1], {
    target_company: id, consent_version: marketingConsent.MARKETING_CONSENT_VERSION, consent_source: 'registration',
  });
  // Only the version crosses over: the wording comes from the database.
  assert.equal('consent_text' in calls[1][1], false);
});

test('no consent, a withdrawn one or a forged version records nothing', async () => {
  for (const metadata of [
    undefined, {}, { marketing_consent: null },
    { marketing_consent: marketingConsent.marketingConsentDeclaration(false) },
    { marketing_consent: { granted: true, version: 'marketing-9.9' } },
    { marketing_consent: { granted: 'yes', version: marketingConsent.MARKETING_CONSENT_VERSION } },
  ]) {
    const calls = await createWith({ id: 'u1', user_metadata: metadata });
    assert.deepEqual(calls.map(([name]) => name), ['ensure_initial_company'], JSON.stringify(metadata));
  }
});

test('a failed consent write never blocks the company', async () => {
  // The company is created, the consent write fails: the owner must still reach
  // the dashboard. A consent record is a record, not a gate on registration.
  const loaded = load(
    name => name === 'marketing_consent_grant'
      ? { data: null, error: { code: '42501', message: 'sc19_company_forbidden' } }
      : { data: id, error: null },
    { id: 'u1', user_metadata: { marketing_consent: marketingConsent.marketingConsentDeclaration(true) } },
  );
  const form = new FormData(); form.set('name', 'Firma');
  let url = null;
  try { await loaded.createCompany(form); } catch (e) { url = e.url ?? null; }
  assert.equal(url, `/dashboard/${id}`, 'the owner still reaches the company dashboard');
  assert.deepEqual(loaded.calls.map(([name]) => name), ['ensure_initial_company', 'marketing_consent_grant']);
});
