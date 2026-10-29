import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// Requires `npm run build`. Synthetic Supabase stub; no real accounts, prices or costs.
const uid = '00000000-0000-4000-8000-000000000002';
const exp = Math.floor(Date.now() / 1000) + 3600;
const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: uid, exp })).toString('base64url'), 'synthetic'].join('.');
const cv = 'base64-' + Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'synthetic', expires_at: exp, expires_in: 3600, token_type: 'bearer', user: { id: uid } })).toString('base64url');

test('internal pricing calculator: owner-only access and browser workflow', async t => {
  let operator = true;
  const requests = [];
  const stub = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/v1/user') return res.end(JSON.stringify({ id: uid, aud: 'authenticated' }));
    if (req.url === '/rest/v1/rpc/platform_operator_status') return res.end(JSON.stringify(operator));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r)); t.after(() => { stub.closeAllConnections(); stub.close(); });
  const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VERCEL_ENV: '', NEXT_PUBLIC_SITE_URL: base, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:' + stub.address().port, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill()); let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await fetch(base)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)); } assert.ok(ready, logs);
  const read = async (auth = true) => {
    const res = await fetch(base + '/operator/pricing', { headers: auth ? { Cookie: 'sb-127-auth-token=' + cv } : {}, redirect: 'manual' });
    return { res, html: await res.text() };
  };

  await t.test('anonymous and non-operator users are refused', async () => {
    assert.equal((await read(false)).res.status, 307);
    operator = false; assert.equal((await read()).res.status, 404); operator = true;
  });
  await t.test('operator sees the calculator, marked noindex and not connected to customers', async () => {
    const { res, html } = await read();
    assert.equal(res.status, 200);
    assert.match(html, /Wewnętrzny kalkulator cen/);
    assert.match(html, /nie zmieniają/);
    assert.match(html, /noindex/);
  });

  if (process.env.PLAYWRIGHT_MODULE) await t.test('browser: price, costs, margin, persistence and layout', async () => {
    const pw = await import(process.env.PLAYWRIGHT_MODULE);
    const chromium = pw.chromium ?? pw.default.chromium;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'sb-127-auth-token', value: cv, url: base }]);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      const before = requests.length;
      await page.goto(base + '/operator/pricing');
      const result = page.getByRole('region', { name: 'Wynik' });
      await result.getByText('300,00 zł').waitFor();
      await page.getByLabel('Koszt analizy 1 CV').fill('0,50'); await page.getByLabel('Koszt analizy 1 CV').blur();
      await result.getByText('30,00 zł').first().waitFor(); // 60 CV × 0,50 zł
      await page.getByLabel('WERYFIKACJA — cena brutto').fill('1230'); await page.getByLabel('WERYFIKACJA — cena brutto').blur();
      await page.getByRole('combobox', { name: /^Pakiet/ }).selectOption('WERYFIKACJA');
      await result.getByText('1 230,00 zł').waitFor();
      await page.reload();
      await page.getByRole('combobox', { name: /^Pakiet/ }).selectOption('WERYFIKACJA');
      await result.getByText('1 230,00 zł').waitFor();
      // Costs never leave the browser: only the page and its assets were requested from the server side.
      assert.ok(requests.slice(before).every(u => u === '/auth/v1/user' || u === '/rest/v1/rpc/platform_operator_status'), requests.slice(before).join(','));
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/sc-pricing-internal-${width}.png`, fullPage: true });
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
