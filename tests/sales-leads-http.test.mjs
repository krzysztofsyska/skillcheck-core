import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { signSalesLead } from '../lib/sales-lead-signature.ts';

const secret = 'local-only-sales-test-secret-32-bytes';
const idle = { status: 'idle', message: '', retry: null };
const leadId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const input = (extra = {}) => ({ idempotency_key: randomUUID(), first_name: '  Jaś   Kowalski ', company_name: ' Firma  Testowa ', email: 'TEST@example.invalid', phone: '', needs: 'Potrzebujemy rekrutacji\r\nW dziale sprzedaży.', ...extra });
const manifest = JSON.parse(await readFile('.next/server/server-reference-manifest.json', 'utf8'));
const action = Object.entries(manifest.node).find(([, value]) => value.filename === 'app/rozmowa/actions.ts' && value.exportedName === 'submitLead')?.[0];
assert.ok(action, 'build contains submitLead action');

async function start(t, env = {}) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VERCEL_ENV: '', NEXT_PUBLIC_SITE_URL: base, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-only-key', SALES_LEADS_ENABLED: 'true', SALES_LEAD_REQUEST_SECRET: secret, SALES_LEAD_NOTICE: 'Testowa informacja o danych — wyłącznie lokalny test.', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let logs = '';
  child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(base + '/rozmowa')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Next started');
  async function submit(values, previous = idle, headers = { 'x-real-ip': '203.0.113.10' }) {
    const res = await fetch(base + '/rozmowa', { method: 'POST', headers: { Origin: base, 'Next-Action': action, 'Content-Type': 'text/plain;charset=UTF-8', ...headers }, body: JSON.stringify([previous, values]) });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const state = text.split('\n').map(line => { try { return JSON.parse(line.replace(/^[0-9a-f]+:/, '')); } catch { return null; } }).find(value => ['error', 'success'].includes(value?.status));
    assert.ok(state, 'action returned state: ' + text);
    return state;
  }
  return { base, submit, logs: () => logs };
}

test('contact action: local HTTP, signed RPC, errors and retries (no real leads)', async t => {
  const requests = [];
  let response = [{ lead_id: leadId, result_code: 'accepted' }];
  let rpcError = false;
  let authFailure = false;
  const stub = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/v1/user' && authFailure) { res.statusCode = 401; return res.end(JSON.stringify({ message: 'Invalid JWT', code: 'bad_jwt' })); }
    if (req.url === '/auth/v1/user') return res.end(JSON.stringify({ id: userId, aud: 'authenticated', email: 'test@example.invalid' }));
    assert.equal(req.url, '/rest/v1/rpc/submit_sales_lead');
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authorization: req.headers.authorization });
    if (rpcError) { res.statusCode = 400; res.end(JSON.stringify({ message: 'PRIVATE_SQL_DETAIL', code: 'XX000' })); }
    else res.end(JSON.stringify(response));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  const server = await start(t, { NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stub.address().port}` });
  await t.test('public page and navigation regression', async () => {
    for (const route of ['/', '/demo', '/rozmowa', '/login', '/register', '/forgot-password']) {
      const res = await fetch(server.base + route); assert.equal(res.status, 200);
      const html = await res.text();
      if (['/', '/demo', '/rozmowa'].includes(route)) assert.match(html, /href="\/rozmowa"/);
      assert.doesNotMatch(html, new RegExp(secret));
      if (route === '/rozmowa') {
        for (const name of ['first_name', 'company_name', 'email', 'phone', 'needs']) assert.match(html, new RegExp(`name="${name}"`));
        assert.match(html, /Testowa informacja o danych/);
      }
    }
    for (const route of ['/dashboard', '/onboarding']) {
      const res = await fetch(server.base + route, { redirect: 'manual' });
      assert.equal(res.status, 307); assert.equal(new URL(res.headers.get('location'), server.base).pathname, '/login');
    }
  });
  await t.test('trusted IP required; spoofed forwarded IP never used', async () => {
    for (const ip of [null, '', '1.2.3.4, 2.3.4.5', '127.0.0.1:123', 'fe80::1%eth0', '999.1.1.1']) {
      const headers = { 'x-forwarded-for': '203.0.113.10' }; if (ip !== null) headers['x-real-ip'] = ip;
      assert.equal((await server.submit(input(), idle, headers)).status, 'error');
    }
    assert.equal(requests.length, 0);
  });
  await t.test('raw limits, controls, required fields and malformed input rejected before RPC', async () => {
    for (const values of [null, {}, input({ first_name: ' '.repeat(81) }), input({ first_name: 'Ja\x00ś' }), input({ needs: 'short' }), input({ email: 'invalid' }), input({ company_name: '' }), input({ phone: 'abcde' }), input({ phone: 12345 }), input({ idempotency_key: 'no' }), input({ needs: ' '.repeat(1001) })]) {
      assert.equal((await server.submit(values)).status, 'error');
    }
    assert.equal(requests.length, 0);
  });
  await t.test('accepted/replay need an ID; all errors fail closed even with an ID', async () => {
    for (const code of ['accepted', 'replay', 'sales_lead_invalid', 'sales_lead_unauthorized', 'sales_lead_rate_limited', 'sales_lead_unavailable', 'sales_lead_idempotency_conflict', 'unknown']) {
      response = [{ lead_id: leadId, result_code: code }];
      const state = await server.submit(input());
      assert.equal(state.status, ['accepted', 'replay'].includes(code) ? 'success' : 'error');
      if (state.status === 'success') assert.equal(state.message, 'Zgłoszenie zostało zapisane. To nie jest rezerwacja terminu rozmowy.');
      if (code === 'sales_lead_idempotency_conflict') assert.equal(state.retry, null);
    }
    for (const invalid of [[], null, [{ lead_id: null, result_code: 'accepted' }], [{ lead_id: '', result_code: 'replay' }], [{ lead_id: leadId, result_code: 'accepted' }, { lead_id: leadId, result_code: 'accepted' }]]) {
      response = invalid; assert.equal((await server.submit(input())).status, 'error');
    }
  });
  await t.test('normalization, retry key, signatures, fresh time and no user-agent input', async () => {
    rpcError = true;
    const first = input(); const state = await server.submit(first);
    assert.equal(state.status, 'error'); assert.equal(state.retry.key, first.idempotency_key);
    const body = requests.at(-1).body;
    assert.equal(body.first_name, 'Jaś Kowalski'); assert.equal(body.company_name, 'Firma Testowa');
    assert.equal(body.email, 'test@example.invalid'); assert.equal(body.phone, null);
    assert.equal(body.needs, 'Potrzebujemy rekrutacji\nW dziale sprzedaży.');
    assert.equal(body.request_signature, signSalesLead(body, secret));
    assert.ok(Math.abs(Date.now() * 1000 - body.issued_at_us) < 5_000_000);
    await server.submit({ ...first, first_name: 'Jaś Kowalski', email: 'test@example.invalid', idempotency_key: randomUUID() }, state, { 'x-real-ip': '203.0.113.10', 'User-Agent': 'different-agent' });
    assert.equal(requests.at(-1).body.idempotency_key, first.idempotency_key);
    assert.equal(requests.at(-1).body.source_ip, body.source_ip);
    const changed = input({ needs: 'Nowa treść zapytania.' });
    await server.submit(changed, state); assert.equal(requests.at(-1).body.idempotency_key, changed.idempotency_key);
    await server.submit(input(), idle, { 'x-real-ip': '2001:db8::1' });
    assert.equal(requests.at(-1).body.source_ip, '2001:db8::1');
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_SQL_DETAIL|request_signature/);
    rpcError = false;
  });
  await t.test('authenticated signature binds validated auth user, never browser submitted_by', async () => {
    response = [{ lead_id: leadId, result_code: 'accepted' }];
    const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now()/1000) + 3600 })).toString('base64url'), 'test'].join('.');
    const session = { access_token: token, refresh_token: 'test-refresh', expires_at: Math.floor(Date.now()/1000) + 3600, expires_in: 3600, token_type: 'bearer', user: { id: userId } };
    const cookie = 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
    const state = await server.submit(input({ submitted_by: 'forged', source_ip: 'forged', issued_at_us: 1, request_signature: 'forged' }), idle, { 'x-real-ip': '203.0.113.10', Cookie: cookie });
    assert.equal(state.status, 'success');
    const sent = requests.at(-1);
    assert.equal(sent.authorization, 'Bearer ' + token);
    assert.equal(sent.body.request_signature, signSalesLead({ ...sent.body, submitted_by: userId }, secret));
    assert.equal('submitted_by' in sent.body, false);
    authFailure = true;
    const count = requests.length;
    assert.equal((await server.submit(input(), idle, { 'x-real-ip': '203.0.113.10', Cookie: cookie })).status, 'error');
    assert.equal(requests.length, count, 'invalid authenticated session must not downgrade to anonymous RPC');
    authFailure = false;
  });
  await t.test('logs contain no PII, SQL detail, source IP or signature', () => {
    for (const forbidden of ['Jaś', 'example.invalid', 'Firma Testowa', '203.0.113.10', 'PRIVATE_SQL_DETAIL', secret, ...requests.map(r => r.body.request_signature)]) assert.equal(server.logs().includes(forbidden), false, forbidden);
  });
});

for (const [label, env] of [
  ['flag off', { SALES_LEADS_ENABLED: '' }],
  ['missing notice', { SALES_LEAD_NOTICE: ' ' }],
  ['missing secret', { SALES_LEAD_REQUEST_SECRET: '' }],
  ['short secret', { SALES_LEAD_REQUEST_SECRET: 'short' }],
]) test(`contact disabled: ${label}`, async t => {
  const server = await start(t, env);
  const html = await (await fetch(server.base + '/rozmowa')).text();
  assert.match(html, /Formularz nie przyjmuje teraz zgłoszeń/);
  assert.doesNotMatch(html, /name="first_name"/);
  assert.equal((await server.submit(input())).status, 'error');
  assert.equal(server.logs().includes('fetch failed'), false);
});
