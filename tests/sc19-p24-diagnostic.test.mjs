import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  sc19PreviewPaymentConfig, sc19PreviewPaymentGate, sc19ProductionSandboxPaymentConfig,
  sc19ProductionSandboxPaymentGate, sc19SandboxPaymentConfig, sc19SandboxPaymentGate,
} from '../lib/sc19-payment-preview.ts';
import {
  sc19P24CredentialProbe, sc19P24Diagnostic, sc19P24DiagnosticCode, sc19PackagesRefusal,
} from '../lib/sc19-p24-diagnostic.ts';

const ref = 'orbyscrupgnupifzlqxp';
const productionRef = 'wsvjawuikxfzjyivxgsu';
const CRC = 'synthetic-production-crc';
const API_KEY = 'synthetic-production-api-key';
const PASSWORD = 'synthetic-production-password';
const productionEnv = Object.freeze({
  VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main', P24_SANDBOX: 'true',
  NEXT_PUBLIC_SUPABASE_URL: `https://${productionRef}.supabase.co`,
  NEXT_PUBLIC_SITE_URL: 'https://skillcheck.pl',
  P24_MERCHANT_ID: '428647', P24_POS_ID: '428647', P24_CRC: CRC, P24_API_KEY: API_KEY,
  SC19_PACKAGES_ENABLED: 'true',
  SC19_P24_CHECKOUT_DATABASE_URL:
    `postgresql://sc19_p24_checkout.${productionRef}:${PASSWORD}@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`,
});
const previewEnv = Object.freeze({
  VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'integration', P24_SANDBOX: 'true',
  VERCEL_BRANCH_URL: 'skillcheck-branch.vercel.app', VERCEL_URL: 'skillcheck-hash.vercel.app',
  NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  P24_MERCHANT_ID: '12345', P24_POS_ID: '12346', P24_CRC: CRC, P24_API_KEY: API_KEY,
  SC19_P24_PREVIEW_DATABASE_URL:
    `postgresql://sc19_p24_preview.${ref}:${PASSWORD}@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`,
});

test('the gate reports a configuration and no refusal on both supported deployments', () => {
  for (const [env, gate, config] of [
    [productionEnv, sc19ProductionSandboxPaymentGate, sc19ProductionSandboxPaymentConfig],
    [previewEnv, sc19PreviewPaymentGate, sc19PreviewPaymentConfig],
  ]) {
    const result = gate(env);
    assert.equal(result.ok, true);
    // The wrapper the request path uses must agree with the diagnostic, always.
    assert.deepEqual(result.config, config(env));
    assert.deepEqual(sc19SandboxPaymentGate(env).config, config(env));
    assert.deepEqual(sc19SandboxPaymentConfig(env), config(env));
  }
});

// One case per refusal reason. `shape` is asserted exactly: it is the operator's
// only clue, and it is also the place a secret could leak, so it is pinned.
const productionCases = [
  ['not_vercel', { VERCEL: undefined }, 'missing'],
  ['not_vercel', { VERCEL: '0' }, 'value:0'],
  ['vercel_env', { VERCEL_ENV: 'preview' }, 'value:preview'],
  ['vercel_env', { VERCEL_ENV: undefined }, 'missing'],
  ['git_ref', { VERCEL_GIT_COMMIT_REF: 'integration' }, 'value:integration'],
  // A deployment that does not expose Vercel's system variables at runtime looks
  // exactly like this, which is why the reason has to be distinguishable.
  ['git_ref', { VERCEL_GIT_COMMIT_REF: undefined }, 'missing'],
  ['sandbox_flag', { P24_SANDBOX: undefined }, 'missing'],
  ['sandbox_flag', { P24_SANDBOX: '' }, 'empty'],
  ['sandbox_flag', { P24_SANDBOX: 'True' }, 'value:True'],
  ['sandbox_flag', { P24_SANDBOX: 'true ' }, 'value:true '],
  // A key pasted into the flag by mistake is reported by length, never echoed.
  ['sandbox_flag', { P24_SANDBOX: API_KEY + API_KEY }, `length:${(API_KEY + API_KEY).length}`],
  ['supabase_url', { NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co` }, `value:https://${ref}.supabase.co`],
  ['supabase_url', { NEXT_PUBLIC_SUPABASE_URL: undefined }, 'missing'],
  ['site_url', { NEXT_PUBLIC_SITE_URL: undefined }, 'missing'],
  ['site_url', { NEXT_PUBLIC_SITE_URL: 'https://www.skillcheck.pl' }, 'value:https://www.skillcheck.pl'],
  ['site_url', { NEXT_PUBLIC_SITE_URL: 'https://skillcheck.pl/' + '?a=1' }, 'value:https://skillcheck.pl/?a=1'],
  ['p24_merchant_id', { P24_MERCHANT_ID: undefined }, 'missing'],
  ['p24_merchant_id', { P24_MERCHANT_ID: '' }, 'empty'],
  ['p24_merchant_id', { P24_MERCHANT_ID: '428 647' }, 'length:7'],
  ['p24_pos_id', { P24_POS_ID: '0' }, 'length:1'],
  ['p24_pos_id', { P24_POS_ID: undefined }, 'missing'],
  ['p24_crc', { P24_CRC: undefined }, 'missing'],
  ['p24_crc', { P24_CRC: 'short' }, 'length:5'],
  ['p24_api_key', { P24_API_KEY: undefined }, 'missing'],
  ['p24_api_key', { P24_API_KEY: 'too-short' }, 'length:9'],
  ['database_url', { SC19_P24_CHECKOUT_DATABASE_URL: undefined }, 'missing'],
  ['database_url', { SC19_P24_CHECKOUT_DATABASE_URL: '' }, 'empty'],
  ['database_url', { SC19_P24_CHECKOUT_DATABASE_URL: 'not a url' }, 'not_a_url,length:9'],
  ['database_url', { SC19_P24_CHECKOUT_DATABASE_URL:
    productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace('sc19_p24_checkout', 'postgres') }, 'wrong:username'],
  ['database_url', { SC19_P24_CHECKOUT_DATABASE_URL:
    productionEnv.SC19_P24_CHECKOUT_DATABASE_URL + '?sslmode=disable' }, 'wrong:query'],
  ['database_url', { SC19_P24_CHECKOUT_DATABASE_URL:
    productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace(':6543', ':5432') }, 'wrong:port'],
  ['database_url', { SC19_P24_CHECKOUT_DATABASE_URL:
    productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace('postgresql://', 'postgres://') }, 'wrong:protocol'],
];

test('every condition the production sandbox gate refuses on is named, with a safe shape hint', () => {
  const seen = new Set();
  for (const [reason, overrides, shape] of productionCases) {
    const env = { ...productionEnv, ...overrides };
    for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete env[key];
    const result = sc19ProductionSandboxPaymentGate(env);
    assert.equal(result.ok, false, reason);
    assert.equal(result.refusal.reason, reason, JSON.stringify(overrides));
    assert.equal(result.refusal.shape, shape, reason);
    // The refusal must never reveal a key, a CRC or the database password.
    for (const secret of [CRC, API_KEY, PASSWORD, 'pooler.supabase.com'])
      assert.equal(result.refusal.shape.includes(secret), false, reason);
    // The real request path refuses on exactly the same input.
    assert.equal(sc19ProductionSandboxPaymentConfig(env), null, reason);
    seen.add(reason);
  }
  assert.deepEqual([...seen].sort(), ['database_url', 'git_ref', 'not_vercel', 'p24_api_key',
    'p24_crc', 'p24_merchant_id', 'p24_pos_id', 'sandbox_flag', 'site_url', 'supabase_url', 'vercel_env']);
});

test('the request origin is a refusal of its own on both deployments', () => {
  const production = sc19ProductionSandboxPaymentGate(productionEnv, 'https://skillcheck-core-hash.vercel.app');
  assert.equal(production.ok, false);
  assert.deepEqual(production.refusal, { reason: 'request_origin', shape: 'value:https://skillcheck-core-hash.vercel.app' });
  assert.equal(sc19ProductionSandboxPaymentConfig(productionEnv, 'https://skillcheck-core-hash.vercel.app'), null);
  // Production answers the request origin from its own constant, so the domain itself passes.
  assert.equal(sc19ProductionSandboxPaymentGate(productionEnv, 'https://skillcheck.pl').ok, true);

  const preview = sc19PreviewPaymentGate(previewEnv, 'https://other.vercel.app');
  assert.deepEqual(preview.refusal, { reason: 'request_origin', shape: 'value:https://other.vercel.app' });
  const hostless = { ...previewEnv };
  delete hostless.VERCEL_BRANCH_URL; delete hostless.VERCEL_URL;
  assert.equal(sc19PreviewPaymentGate(hostless).refusal.reason, 'deployment_host');
});

test('the shared entry point reports the reason of the branch the deployment belongs to', () => {
  // A production deployment must not be told "wrong branch: expected integration".
  assert.equal(sc19SandboxPaymentGate({ ...productionEnv, P24_SANDBOX: 'False' }).refusal.reason, 'sandbox_flag');
  assert.equal(sc19SandboxPaymentGate({ ...productionEnv, NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' })
    .refusal.reason, 'site_url');
  // And a preview deployment keeps the preview branch's answer.
  assert.equal(sc19SandboxPaymentGate({ ...previewEnv, P24_CRC: 'x' }).refusal.reason, 'p24_crc');
  assert.equal(sc19SandboxPaymentGate({ ...previewEnv, VERCEL_ENV: 'development' }).refusal.reason, 'vercel_env');
});

test('the credential probe reports only an outcome and a status, and never sends a payment', async () => {
  const calls = [];
  const probeWith = (handler) => sc19P24CredentialProbe({ posId: 428647, apiKey: API_KEY }, async (url, init) => {
    calls.push({ url, init });
    return handler();
  });
  assert.deepEqual(await probeWith(() => ({ status: 200 })), { outcome: 'ok', status: 200 });
  assert.deepEqual(await probeWith(() => ({ status: 401 })), { outcome: 'unauthorized', status: 401 });
  assert.deepEqual(await probeWith(() => ({ status: 500 })), { outcome: 'http', status: 500 });
  assert.deepEqual(await probeWith(() => ({ status: 403 })), { outcome: 'http', status: 403 });
  assert.deepEqual(await probeWith(() => { throw Error('ENOTFOUND'); }), { outcome: 'unreachable', status: null });
  for (const { url, init } of calls) {
    // Read-only, sandbox only, no transaction, no body, no redirect following.
    assert.equal(url, 'https://sandbox.przelewy24.pl/api/v1/testAccess');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal('body' in init, false);
    assert.equal(init.signal instanceof AbortSignal, true);
    assert.equal(init.headers.authorization, 'Basic ' + Buffer.from(`428647:${API_KEY}`).toString('base64'));
  }
});

test('the diagnostic probes only once the gate resolved, and its code carries no value', async () => {
  let probed = 0;
  const fetchImpl = async () => { probed += 1; return { status: 401 }; };
  const refused = await sc19P24Diagnostic({ ...productionEnv, P24_SANDBOX: 'nope' }, fetchImpl);
  assert.deepEqual(refused, { refusal: { reason: 'sandbox_flag', shape: 'value:nope' }, probe: null });
  assert.equal(probed, 0, 'a refused gate has no credentials to check');
  assert.equal(sc19P24DiagnosticCode(refused), 'gate_sandbox_flag');

  const resolved = await sc19P24Diagnostic(productionEnv, fetchImpl);
  assert.deepEqual(resolved, { refusal: null, probe: { outcome: 'unauthorized', status: 401 } });
  assert.equal(probed, 1);
  assert.equal(sc19P24DiagnosticCode(resolved), 'provider_unauthorized');
  // Whatever happens, the code that ends up in a URL is a short machine name.
  for (const result of [refused, resolved]) {
    const code = sc19P24DiagnosticCode(result);
    assert.match(code, /^(gate|provider)_[a-z_]{1,40}$/);
    for (const secret of [CRC, API_KEY, PASSWORD]) assert.equal(code.includes(secret), false);
  }
});

// SC19_PACKAGES_ENABLED is not a gate condition — it is a runtime switch that
// `lib/sc19-payment-http.ts` refuses on BEFORE the provider is called. A panel
// that ignored it would say "all conditions pass" and send the operator to
// Przelewy24 for a configuration fault, which is the confusion this file exists
// to end (independent review F1 / Codex P2 on PR #425).
test('the packages switch refuses in the diagnostic, and never inside the gate', async () => {
  let probed = 0;
  const fetchImpl = async () => { probed += 1; return { status: 200 }; };
  for (const [value, shape] of [[undefined, 'missing'], ['', 'empty'], ['True', 'value:True'],
    ['false', 'value:false'], [API_KEY + API_KEY, `length:${(API_KEY + API_KEY).length}`]]) {
    const env = { ...productionEnv, SC19_PACKAGES_ENABLED: value };
    if (value === undefined) delete env.SC19_PACKAGES_ENABLED;
    assert.deepEqual(sc19PackagesRefusal(env), { reason: 'packages_flag', shape });
    const result = await sc19P24Diagnostic(env, fetchImpl);
    assert.deepEqual(result, { refusal: { reason: 'packages_flag', shape }, probe: null });
    assert.equal(sc19P24DiagnosticCode(result), 'gate_packages_flag');
    // The deployment gate must stay exactly what #421 reviewed: this flag is not
    // one of its conditions and must not change its verdict either way.
    assert.equal(sc19ProductionSandboxPaymentGate(env).ok, true);
    assert.notEqual(sc19ProductionSandboxPaymentConfig(env), null);
    for (const secret of [CRC, API_KEY, PASSWORD]) assert.equal(shape.includes(secret), false);
  }
  assert.equal(probed, 0, 'a refused switch must not make the operator probe Przelewy24');
  assert.equal(sc19PackagesRefusal(productionEnv), null);
  // A gate refusal still wins: it is the first thing the request path refuses on.
  const both = await sc19P24Diagnostic({ ...productionEnv, SC19_PACKAGES_ENABLED: 'no', P24_SANDBOX: 'no' }, fetchImpl);
  assert.equal(both.refusal.reason, 'sandbox_flag');
  assert.equal(probed, 0);
});

// The rendered panel and the server action behind the button must refuse on the
// same two things in the same order, or the page contradicts its own button.
test('the panel asks the same two questions as the server action', async () => {
  const panel = await readFile(new URL('../app/operator/billing/p24-diagnostic.tsx', import.meta.url), 'utf8');
  assert.match(panel, /const refusal = gate\.ok \? sc19PackagesRefusal\(process\.env\) : gate\.refusal;/);
  assert.match(panel, /packages_flag: \{ what:/);
  // A stale ?p24= code must not be printed next to a fresh refusal.
  assert.match(panel, /\{probe && !refusal \?/);
  // The operator page must outlive its own 8 s probe plus two Supabase round trips.
  const page = await readFile(new URL('../app/operator/billing/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /export const maxDuration = 60;/);
});

// A killed invocation never reaches our error handling: the client gets the
// platform's HTML 503 and the database keeps no trace. The route's own time
// budget must therefore exceed the provider call it makes.
test('every billing route outlives the Przelewy24 call it can make', async () => {
  const provider = await readFile(new URL('../lib/sc19-przelewy24-provider.ts', import.meta.url), 'utf8');
  const timeout = Number(/const TIMEOUT_MS = ([0-9_]+);/.exec(provider)[1].replaceAll('_', ''));
  assert.ok(timeout >= 5_000 && timeout <= 12_000, `provider timeout ${timeout}`);
  for (const route of ['checkout', 'offers', 'webhook', 'orders/[orderId]']) {
    const source = await readFile(new URL(`../app/api/billing/${route}/route.ts`, import.meta.url), 'utf8');
    const declared = Number(/export const maxDuration ?= ?([0-9]+);/.exec(source)?.[1]);
    assert.ok(declared >= timeout / 1000 + 20, `${route} declares maxDuration ${declared}`);
    assert.ok(declared <= 60, `${route} must stay within the plan limit`);
  }
});

// The generic client message hid our own error codes, which is why a provider
// refusal and a platform timeout were indistinguishable from the browser.
test('the checkout client reads the error code instead of swallowing it', async () => {
  const source = await readFile(
    new URL('../app/dashboard/[companyId]/billing/checkout/checkout.tsx', import.meta.url), 'utf8');
  assert.match(source, /response\.json\(\)\.catch\(\(\)=>null\)\?\?\{\}/);
  assert.doesNotMatch(source, /const data=await response\.json\(\);/);
  assert.match(source, /podaj kod: \$\{code\}/);
});
