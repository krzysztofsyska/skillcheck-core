import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  readFakturowniaConfig, createFakturowniaClient, checkFakturowniaConnection, parseInvoice,
  FakturowniaError, fakturowniaMessages,
} from '../lib/fakturownia-client.ts';

const TOKEN = 'SyntheticTok3nValue_abc123/XYZ';
const env = { FAKTUROWNIA_ACCOUNT: 'ktig-test', FAKTUROWNIA_API_TOKEN: TOKEN };
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });

function recorder(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const handler = routes[u.pathname];
    if (!handler) return reply(404, { message: 'not found' });
    return typeof handler === 'function' ? handler(u, init) : handler;
  };
  return { calls, fetchImpl };
}

test('config: requires both variables, normalizes account, rejects unsafe values', () => {
  assert.throws(() => readFakturowniaConfig({}), e => e.code === 'FAKTUROWNIA_NOT_CONFIGURED');
  assert.throws(() => readFakturowniaConfig({ FAKTUROWNIA_ACCOUNT: 'ktig' }), e => e.code === 'FAKTUROWNIA_CONFIG_INVALID');
  assert.equal(readFakturowniaConfig({ ...env, FAKTUROWNIA_ACCOUNT: ' KTIG-Test.fakturownia.pl ' }).account, 'ktig-test');
  for (const account of ['evil.com/x', 'a b', '-lead', 'x'.repeat(64), 'ktig@host'])
    assert.throws(() => readFakturowniaConfig({ ...env, FAKTUROWNIA_ACCOUNT: account }), e => e.code === 'FAKTUROWNIA_CONFIG_INVALID', account);
  for (const token of ['short', 'has space inside', 'amp&inject=1', 'line\nbreak', 'x'.repeat(201)])
    assert.throws(() => readFakturowniaConfig({ ...env, FAKTUROWNIA_API_TOKEN: token }), e => e.code === 'FAKTUROWNIA_CONFIG_INVALID');
});

test('connection check is read-only, targets only the configured account and reports companies', async () => {
  const { calls, fetchImpl } = recorder({
    '/departments.json': reply(200, [{ id: 7, name: 'KTIG CONSULTING Sp. z o.o.', tax_no: '7393954155', bank_account: 'SECRET-IGNORED' }]),
    '/invoices.json': (u) => {
      assert.equal(u.searchParams.get('kind'), 'proforma');
      assert.equal(u.searchParams.get('period'), 'this_month');
      return reply(200, [{ id: 1, kind: 'proforma', status: 'issued' }, { id: 2, kind: 'proforma', status: 'paid' }]);
    },
  });
  const health = await checkFakturowniaConnection(env, fetchImpl);
  assert.deepEqual(health, { ok: true, account: 'ktig-test', proformasThisMonth: 2,
    departments: [{ id: 7, name: 'KTIG CONSULTING Sp. z o.o.', taxNo: '7393954155' }] });
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(new URL(url).origin, 'https://ktig-test.fakturownia.pl');
    assert.equal(new URL(url).searchParams.get('api_token'), TOKEN);
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('HTTP failures map to fixed codes and never expose the token or URL', async () => {
  const cases = [[401, 'FAKTUROWNIA_UNAUTHORIZED'], [403, 'FAKTUROWNIA_UNAUTHORIZED'], [404, 'FAKTUROWNIA_ACCOUNT_NOT_FOUND'],
    [429, 'FAKTUROWNIA_RATE_LIMITED'], [502, 'FAKTUROWNIA_UNAVAILABLE'], [422, 'FAKTUROWNIA_REQUEST_REJECTED']];
  for (const [status, code] of cases) {
    const health = await checkFakturowniaConnection(env, async () => reply(status, { message: `echo ${TOKEN}` }));
    assert.deepEqual(health, { ok: false, code, httpStatus: status });
    assert.ok(!JSON.stringify(health).includes(TOKEN));
    assert.ok(fakturowniaMessages[code].length > 10);
  }
});

test('transport errors carrying the URL are replaced by a fixed code', async () => {
  const leaking = async (url) => { throw new TypeError(`fetch failed for ${url}`); };
  const health = await checkFakturowniaConnection(env, leaking);
  assert.deepEqual(health, { ok: false, code: 'FAKTUROWNIA_UNAVAILABLE', httpStatus: null });
  const client = createFakturowniaClient(readFakturowniaConfig(env), leaking);
  await assert.rejects(client.departments(), e => e instanceof FakturowniaError && !String(e.message + e.stack).includes(TOKEN));
});

test('timeout aborts the request and reports FAKTUROWNIA_TIMEOUT', async () => {
  const hanging = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error(url))));
  const client = createFakturowniaClient(readFakturowniaConfig(env), hanging, 20);
  await assert.rejects(client.departments(), e => e.code === 'FAKTUROWNIA_TIMEOUT');
});

test('timeout also bounds a stalled response body', async () => {
  let aborted = false;
  const stalledBody = async (url, init) => {
    init.signal.addEventListener('abort', () => { aborted = true; });
    return { status: 200, ok: true, json: () => new Promise(() => {}) };
  };
  const client = createFakturowniaClient(readFakturowniaConfig(env), stalledBody, 20);
  const started = Date.now();
  await assert.rejects(client.departments(), e => e.code === 'FAKTUROWNIA_TIMEOUT' && e.httpStatus === null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true);
});

test('malformed payloads fail closed', async () => {
  for (const body of [{ id: 1 }, [{ name: 'no id' }], 'text', null]) {
    const health = await checkFakturowniaConnection(env, async () => reply(200, body));
    assert.equal(health.ok, false);
    assert.equal(health.code, 'FAKTUROWNIA_RESPONSE_INVALID');
  }
  const badJson = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('x'); } });
  assert.equal((await checkFakturowniaConnection(env, badJson)).code, 'FAKTUROWNIA_RESPONSE_INVALID');
});

test('invoice parsing keeps only allowlisted fields and a safe public view token', async () => {
  const inv = parseInvoice({ id: 55, kind: 'proforma', status: 'paid', number: 'PRO 1/10/2026', oid: 'sc19:order',
    price_gross: '369.00', paid: '369.00', currency: 'PLN', token: 'HBO3Npx2OzSW79RQL7XV2', buyer_tax_no: '123', api_token: TOKEN });
  assert.deepEqual(Object.keys(inv).sort(), ['currency', 'id', 'kind', 'number', 'oid', 'paid', 'priceGross', 'status', 'viewToken']);
  const client = createFakturowniaClient(readFakturowniaConfig(env), async () => reply(200, {}));
  assert.equal(client.publicViewUrl(inv), 'https://ktig-test.fakturownia.pl/invoice/HBO3Npx2OzSW79RQL7XV2');
  assert.equal(parseInvoice({ id: 1, kind: 'vat', status: 'issued', token: '../../x' }).viewToken, null);
  const { calls, fetchImpl } = recorder({ '/invoices/55.json': reply(200, { id: 55, kind: 'proforma', status: 'issued' }) });
  const c2 = createFakturowniaClient(readFakturowniaConfig(env), fetchImpl);
  assert.equal((await c2.invoice(55)).status, 'issued');
  assert.equal(new URL(calls[0].url).pathname, '/invoices/55.json');
  await assert.rejects(c2.invoice(-1), e => e.code === 'FAKTUROWNIA_REQUEST_REJECTED');
  await assert.rejects(c2.invoice(1.5), e => e.code === 'FAKTUROWNIA_REQUEST_REJECTED');
});

test('operator page is owner-gated, read-only and never renders the token variable', async () => {
  const page = await readFile(new URL('../app/operator/fakturownia/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /await salesOperator\(\)/);
  assert.match(page, /import 'server-only'/);
  assert.ok(!/FAKTUROWNIA_API_TOKEN\s*\]|process\.env\.FAKTUROWNIA_API_TOKEN/.test(page));
  assert.ok(!/method:\s*'POST'|createProforma|send_by_email/.test(page));
  assert.match(page, /robots: \{ index: false, follow: false \}/);
});
