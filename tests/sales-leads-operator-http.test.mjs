import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const userId = '00000000-0000-4000-8000-000000000002';
const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now()/1000) + 3600 })).toString('base64url'), 'synthetic'].join('.');
const cookieValue = 'base64-' + Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'synthetic-refresh', expires_at: Math.floor(Date.now()/1000) + 3600, expires_in: 3600, token_type: 'bearer', user: { id: userId } })).toString('base64url');
const cookie = 'sb-127-auth-token=' + cookieValue;
const fixture = {
  id: '00000000-0000-4000-8000-000000000001', idempotency_key: '00000000-0000-4000-8000-000000000003',
  first_name: 'Testowy Kontakt', company_name: 'Firma syntetyczna', email: 'test@example.invalid', phone: null,
  needs: '<img src=x onerror=alert(1)>\nPotrzebujemy rozmowy.', status: 'received', submitted_by: userId,
  fingerprint_hash: 'PRIVATE_FINGERPRINT_NOT_FOR_BROWSER', created_at: '2026-10-08T06:30:00Z',
};

test('operator leads: authorization, private rendering and errors via HTTP', async t => {
  let operator = true, statusFailure = false, listFailure = false, revoked = false, authFailure = false;
  let rows = [fixture];
  const requests = [];
  const stub = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    res.setHeader('Content-Type', 'application/json');
    requests.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url === '/auth/v1/user') {
      if (authFailure) { res.statusCode = 401; return res.end(JSON.stringify({ message: 'Invalid JWT', code: 'bad_jwt' })); }
      return res.end(JSON.stringify({ id: userId, aud: 'authenticated', email: 'operator@example.invalid' }));
    }
    if (req.url === '/rest/v1/rpc/platform_operator_status') {
      if (statusFailure) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'PRIVATE_SQL_DETAIL' })); }
      return res.end(JSON.stringify(operator));
    }
    if (req.url === '/rest/v1/rpc/list_sales_leads_inbox') {
      if (revoked || listFailure) { res.statusCode = 400; return res.end(JSON.stringify({ message: revoked ? 'sales_lead_forbidden' : 'PRIVATE_SQL_DETAIL', code: 'P0001' })); }
      return res.end(JSON.stringify(rows));
    }
    if (req.url === '/rest/v1/rpc/close_sales_lead') {
      if (!operator || revoked) return res.end(JSON.stringify('sales_lead_forbidden'));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.target_lead, fixture.id);
      rows = rows.map(row => row.id === input.target_lead ? { ...row, closed_at: '2026-10-09T07:00:00Z' } : row);
      return res.end(JSON.stringify('ok'));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VERCEL_ENV: '', NEXT_PUBLIC_SITE_URL: base, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', SALES_LEADS_ENABLED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(base + '/')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Next started');
  const read = async (authenticated = true) => {
    const res = await fetch(base + '/operator/leads', { redirect: 'manual', headers: authenticated ? { Cookie: cookie } : {} });
    const html = await res.text();
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.doesNotMatch(html, /PRIVATE_SQL_DETAIL|PRIVATE_FINGERPRINT_NOT_FOR_BROWSER/);
    assert.equal(html.includes(fixture.idempotency_key), false);
    return { res, html };
  };
  const listCalls = () => requests.filter(r => r.url === '/rest/v1/rpc/list_sales_leads_inbox');
  await t.test('anonymous redirects before RPC', async () => {
    const { res } = await read(false);
    assert.equal(res.status, 307); assert.equal(res.headers.get('location'), '/login');
    assert.equal(listCalls().length, 0);
  });
  await t.test('company user without operator role gets 404, no list call', async () => {
    operator = false;
    const { res, html } = await read(); assert.equal(res.status, 404);
    assert.equal(html.includes(fixture.email), false); assert.equal(listCalls().length, 0);
    operator = true;
  });
  await t.test('operator reads fields, bounded RPC and escaped text', async () => {
    const { res, html } = await read(); assert.equal(res.status, 200);
    for (const value of [fixture.company_name, fixture.first_name, fixture.email, userId, 'Nie podano', 'Otrzymane', 'Europe/Warsaw']) assert.ok(html.includes(value), value);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.deepEqual(JSON.parse(listCalls().at(-1).body), { result_limit: 50 });
    assert.equal(listCalls().at(-1).authorization, 'Bearer ' + token);
    assert.match(html, /mailto:test%40example.invalid\?subject=/);
    assert.match(html, /Odpowiedz e-mailem/);
  });
  await t.test('empty response has explicit empty state', async () => {
    rows = []; const { html } = await read(); assert.match(html, /Nie ma jeszcze zgłoszeń/); rows = [fixture];
  });
  await t.test('role revocation between checks fails closed', async () => {
    revoked = true;
    const { res, html } = await read(); assert.equal(res.status, 404); assert.equal(html.includes(fixture.email), false);
    revoked = false;
  });
  await t.test('status and list errors do not masquerade as empty list or leak SQL', async () => {
    for (const which of ['status', 'list']) {
      statusFailure = which === 'status'; listFailure = which === 'list';
      const before = listCalls().length;
      const { html } = await read(); assert.equal(html.includes(fixture.email), false); assert.doesNotMatch(html, /Nie ma jeszcze zgłoszeń/);
      if (statusFailure) assert.equal(listCalls().length, before);
      statusFailure = false; listFailure = false;
    }
  });
  await t.test('invalid session cannot read data', async () => {
    authFailure = true; const before = listCalls().length;
    const { res } = await read(); assert.equal(res.status, 307); assert.equal(listCalls().length, before); authFailure = false;
  });
  await t.test('authorized result is never reused for anonymous request', async () => {
    await read(); const { res, html } = await read(false); assert.equal(res.status, 307); assert.equal(html.includes(fixture.email), false);
  });
  await t.test('existing public and protected routes', async () => {
    for (const route of ['/', '/demo', '/rozmowa', '/login', '/register', '/forgot-password']) assert.equal((await fetch(base + route)).status, 200, route);
    for (const route of ['/dashboard', '/onboarding']) {
      const res = await fetch(base + route, { redirect: 'manual' }); assert.equal(res.status, 307); assert.equal(res.headers.get('location'), '/login');
    }
  });
  await t.test('logs omit PII and raw RPC detail', () => {
    for (const value of [fixture.email, fixture.first_name, fixture.company_name, fixture.fingerprint_hash, 'PRIVATE_SQL_DETAIL']) assert.equal(logs.includes(value), false, value);
  });
  // Optional real Chromium pass, using the same synthetic backend as HTTP tests.
  if (process.env.PLAYWRIGHT_MODULE) await t.test('browser: desktop/mobile, refresh and authorization', async () => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: JSON.parse(process.env.BROWSER_ARGS || '[]') });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'sb-127-auth-token', value: cookieValue, url: base }]);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 }); await page.goto(base + '/operator/leads');
        await page.getByRole('heading', { name: 'Zgłoszenia kontaktowe' }).waitFor();
        assert.ok(await page.getByText(fixture.email, { exact: true }).isVisible());
        assert.equal(await page.locator('img[src="x"]').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const reply = new URL(await page.getByRole('link', {name:'Odpowiedz e-mailem'}).getAttribute('href'));
        assert.equal(decodeURIComponent(reply.pathname), fixture.email);
        assert.deepEqual([...reply.searchParams.keys()], ['subject']);
        await page.screenshot({ path: `/tmp/sc-sales-006d-${width}.png`, fullPage: true });
      }
      await page.getByText('Zakończ rozmowę bez zawarcia umowy', {exact:true}).click();
      const beforeClose = requests.filter(r=>r.url==='/rest/v1/rpc/close_sales_lead').length;
      await page.getByRole('button',{name:'Potwierdź zakończenie'}).click();
      assert.equal(requests.filter(r=>r.url==='/rest/v1/rpc/close_sales_lead').length,beforeClose);
      await page.getByRole('checkbox').check();
      await page.getByRole('button',{name:'Potwierdź zakończenie'}).click();
      await page.getByText('Zakończone',{exact:true}).waitFor();
      assert.equal(requests.filter(r=>r.url==='/rest/v1/rpc/close_sales_lead').length,beforeClose+1);
      assert.ok(await page.getByText(/Usunięcie danych po 6 miesiącach/).isVisible());
      rows=[fixture]; await page.reload();
      await page.getByText('Zakończ rozmowę bez zawarcia umowy',{exact:true}).click();
      await page.getByRole('checkbox').check(); revoked=true;
      await page.getByRole('button',{name:'Potwierdź zakończenie'}).click();
      await page.getByRole('status').filter({hasText:'Nie udało się zakończyć zgłoszenia'}).waitFor();
      assert.equal(rows[0].closed_at,undefined); revoked=false;
      rows = []; await page.getByRole('link', { name: 'Odśwież zgłoszenia' }).click(); await page.getByRole('status').filter({ hasText: 'Nie ma jeszcze zgłoszeń' }).waitFor(); rows = [fixture];
      operator = false; const forbidden = await page.goto(base + '/operator/leads'); assert.equal(forbidden.status(), 404); assert.equal(await page.getByText(fixture.email, { exact: true }).count(), 0); operator = true;
      await context.clearCookies(); await page.goto(base + '/operator/leads'); assert.equal(new URL(page.url()).pathname, '/login');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
