// R8 SC-020 krok 1 (SC-020a) — test końcowy dwóch marek na prawdziwym `next start`
// (po `npm run build`). Dwie fikcyjne firmy, każda na własnym adresie strony,
// z własnym logo, kolorami i raportem w swojej marce. Auth i PostgREST to cienka
// atrapa, ale KAŻDE zapytanie o dane wykonuje prawdziwy PostgreSQL z pełnym
// łańcuchem migracji jako rola `authenticated` (albo `anon`): RLS, funkcje
// security definer i polityki Storage są prawdziwe. Sprawdzamy, że strona firmy
// (panel, logo, raport preselekcji) pokazuje wyłącznie jej markę i jej dane,
// a kontrola strony wykrywa wyciek (dowód negatywny). Tylko dane syntetyczne.
//
// Atrapa jest kopią tej z tests/white-label-isolation-http.test.mjs (tamtego pliku
// nie zmieniamy — zasada R8), rozszerzoną o `offset`, filtr `in.(…)` oraz
// porządkowanie i stronicowanie wyników RPC, których używa raport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { bootWhiteLabel, users } from './helpers/white-label-fixture.mjs';
import { reportTitle, setupTwoBrands } from './helpers/white-label-two-brands.mjs';

const PUBLIC_KEY = 'synthetic-public-key';
const IDENT = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token = sub => [Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'synthetic'].join('.');
const subOf = bearer => {
  try { return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub ?? null; } catch { return null; }
};
const session = userId => ({ access_token: token(userId), refresh_token: `refresh-${userId}`, expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600, token_type: 'bearer', user: { id: userId, aud: 'authenticated', email: 'synthetic@example.invalid' } });
const cookieFor = userId => 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify(session(userId))).toString('base64url');

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, body: buffer.toString('utf8').replaceAll('<!-- -->', '') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** `order`, `limit` and `offset` query parameters -> SQL suffix (validated identifiers only). */
function paging(searchParams) {
  let order = '', limit = '', offset = '';
  for (const [key, value] of searchParams) {
    if (key === 'order') {
      order = ' order by ' + value.split(',').map(part => {
        const [column, direction = 'asc'] = part.split('.');
        if (!IDENT.test(column) || !['asc', 'desc'].includes(direction)) throw Object.assign(new Error('bad order'), { status: 400 });
        return `"${column}" ${direction}`;
      }).join(',');
    } else if (key === 'limit') limit = ` limit ${Math.min(Number(value) || 0, 1000)}`;
    else if (key === 'offset') offset = ` offset ${Math.max(Number(value) || 0, 0)}`;
  }
  return order + limit + offset;
}

/** Minimal PostgREST/Auth/Storage boundary backed by the real database. */
function supabaseStub(databaseUrl, objects, state) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  pool.on('error', () => {});
  const asCaller = async (authorization, work) => {
    const bearer = (authorization ?? '').replace(/^Bearer /, '');
    const sub = bearer && bearer !== PUBLIC_KEY ? subOf(bearer) : null;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${sub ? 'authenticated' : 'anon'}`);
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [sub ?? '']);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  const fail = (res, error) => {
    const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : error.status ?? 400;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: error.code ?? 'stub', message: error.message, details: null, hint: null }));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    try {
      if (url.pathname === '/auth/v1/user') {
        const sub = subOf((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!sub) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"invalid"}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: sub, aud: 'authenticated', email: 'synthetic@example.invalid' }));
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const userId = String(body.refresh_token ?? '').replace(/^refresh-/, '');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(session(userId)));
      }
      if (url.pathname.startsWith('/storage/v1/object/brand-assets/')) {
        const name = decodeURIComponent(url.pathname.slice('/storage/v1/object/brand-assets/'.length));
        const visible = await asCaller(req.headers.authorization, async client =>
          (await client.query("select count(*)::int n from storage.objects where bucket_id='brand-assets' and name=$1", [name])).rows[0].n === 1);
        if (!visible || !objects.has(name)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"statusCode":"404","error":"not_found","message":"Object not found"}'); }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(objects.get(name));
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.slice('/rest/v1/rpc/'.length);
        if (!IDENT.test(name)) throw Object.assign(new Error('bad function'), { status: 400 });
        const keys = Object.keys(body);
        if (!keys.every(key => IDENT.test(key))) throw Object.assign(new Error('bad argument'), { status: 400 });
        const args = keys.map((key, i) => `${key} => $${i + 1}`).join(', ');
        const values = keys.map(key => body[key] !== null && typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key]);
        const suffix = paging(url.searchParams);
        const result = await asCaller(req.headers.authorization, async client => {
          const meta = (await client.query("select proretset from pg_proc where pronamespace='public'::regnamespace and proname=$1", [name])).rows[0];
          if (!meta) throw Object.assign(new Error('function not found'), { status: 404, code: 'PGRST202' });
          if (meta.proretset) return (await client.query(`select * from public.${name}(${args})${suffix}`, values)).rows;
          return (await client.query(`select public.${name}(${args}) as v`, values)).rows[0].v;
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      if (url.pathname.startsWith('/rest/v1/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const table = url.pathname.slice('/rest/v1/'.length);
        if (!IDENT.test(table)) throw Object.assign(new Error('bad table'), { status: 400 });
        const select = url.searchParams.get('select') ?? '*';
        const columns = select === '*' ? '*' : select.split(',').map(column => {
          if (!IDENT.test(column)) throw Object.assign(new Error(`unsupported select ${select}`), { status: 400 });
          return `"${column}"`;
        }).join(',');
        const where = [], values = [];
        for (const [key, value] of url.searchParams) {
          if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
          if (IDENT.test(key) && value.startsWith('eq.')) {
            values.push(value.slice(3)); where.push(`"${key}"::text = $${values.length}`);
          } else if (IDENT.test(key) && /^in\.\(.*\)$/.test(value)) {
            const list = value.slice(4, -1).split(',').map(item => item.replace(/^"|"$/g, ''));
            if (!list.every(item => UUID.test(item))) throw Object.assign(new Error(`unsupported in-list ${key}`), { status: 400 });
            values.push(list); where.push(`"${key}"::text = any($${values.length}::text[])`);
          } else throw Object.assign(new Error(`unsupported filter ${key}=${value}`), { status: 400 });
        }
        const sql = `select ${columns} from public."${table}"${where.length ? ' where ' + where.join(' and ') : ''}${paging(url.searchParams)}`;
        const rows = await asCaller(req.headers.authorization, async client => (await client.query(sql, values)).rows);
        res.writeHead(200, { 'content-type': 'application/json', 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
        if (req.method === 'HEAD') return res.end();
        return res.end(JSON.stringify(req.headers.accept?.includes('vnd.pgrst.object') ? rows[0] ?? null : rows));
      }
      throw Object.assign(new Error(`unsupported ${req.method} ${url.pathname}`), { status: 501 });
    } catch (error) {
      state.errors.push(`${req.method} ${url.pathname}${url.search}: ${error.code ?? ''} ${error.message}`);
      fail(res, error);
    }
  });
  return { server, pool };
}

/**
 * The page check under test: the HTML is in the company's own brand (name, colours, logo
 * address) and carries nothing that identifies the other company.
 */
export function assertOwnBrandPage(html, own, other, label) {
  assert.match(html, new RegExp(`--brand-primary:\\s*${own.colors.primary}`, 'i'), `${label}: own primary colour`);
  assert.match(html, new RegExp(`--brand-accent:\\s*${own.colors.accent}`, 'i'), `${label}: own accent colour`);
  assert.ok(html.includes(own.brandName), `${label}: own brand name`);
  assert.ok(html.includes(`/dashboard/${own.companyId}/marka/zasob/${own.logo.assetId}`), `${label}: own logo`);
  const text = html.toLowerCase();
  for (const marker of [other.companyId, other.company, other.brandName, other.host, other.candidateName, other.recruitmentName,
    other.logo.assetId, other.reportedApplicationId, other.colors.primary, other.colors.accent]) {
    assert.ok(!text.includes(String(marker).toLowerCase()), `${label}: leak of the other company (${marker})`);
  }
}

test('SC-020a: two brands on their own site addresses — panel, logo and report only in own brand with own data', async t => {
  const e = await bootWhiteLabel(t);
  const tenant = await setupTwoBrands(e);
  const { A, B } = tenant;
  const objects = new Map([[A.logo.path, A.logo.bytes], [B.logo.path, B.logo.bytes]]);
  const state = { errors: [] };
  const stub = supabaseStub(e.databaseUrl(e.name), objects, state);
  await new Promise(resolve => stub.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { stub.server.closeAllConnections(); stub.server.close(); await stub.pool.end(); });

  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VERCEL_ENV: '', WHITE_LABEL_ENABLED: 'true', NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stub.server.address().port}`,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY, NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 80 && !ready; i += 1) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await get(port, '/login', { host: `127.0.0.1:${port}` })).status === 200; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Next server started');

  const page = (host, path, userId) => get(port, path, { host, 'x-forwarded-host': host, ...(userId ? { cookie: cookieFor(userId) } : {}) });
  const debug = () => `${state.errors.slice(-5).join('\n')}\n${logs.slice(-1500)}`;
  const pairs = [[A, B, users.owner], [B, A, users.otherOwner]];

  await t.test('own site address: panel in own brand (name, colours, logo), nothing of the other company', async () => {
    for (const [own, other, userId] of pairs) {
      const res = await page(own.host, `/dashboard/${own.companyId}`, userId);
      assert.equal(res.status, 200, debug());
      assertOwnBrandPage(res.body, own, other, `${own.brandName} panel`);
      assert.match(res.headers['cache-control'] ?? '', /no-store/);
    }
  });

  await t.test('own logo file is served on own address and is the own file', async () => {
    for (const [own, other, userId] of pairs) {
      const res = await page(own.host, `/dashboard/${own.companyId}/marka/zasob/${own.logo.assetId}`, userId);
      assert.equal(res.status, 200, debug());
      assert.equal(res.headers['content-type'], 'image/png');
      assert.deepEqual(res.buffer, own.logo.bytes);
      assert.notDeepEqual(res.buffer, other.logo.bytes);
    }
  });

  await t.test('preselection report: title in own brand, own analysed candidate, nothing of the other company', async () => {
    for (const [own, other, userId] of pairs) {
      const res = await page(own.host, `/dashboard/${own.companyId}/recruitments/${own.recruitment.id}/report`, userId);
      assert.equal(res.status, 200, debug());
      const title = res.body.match(/<title>([^<]*)<\/title>/)?.[1];
      assert.equal(title, reportTitle(own.brandName), `${own.brandName}: report title (also the print/PDF header)`);
      assert.doesNotMatch(res.body, /role="status" class="notice"/, `${own.brandName}: report loaded, not an error notice\n${debug()}`);
      assert.ok(res.body.includes(own.reportedApplicationId), `${own.brandName}: own analysed candidate in the report`);
      assertOwnBrandPage(res.body, own, other, `${own.brandName} report`);
    }
  });

  await t.test('the other company panel, logo and report on this address: 404 without any brand', async () => {
    for (const [own, other, userId] of pairs) {
      for (const path of [`/dashboard/${other.companyId}`, `/dashboard/${other.companyId}/marka/zasob/${other.logo.assetId}`,
        `/dashboard/${other.companyId}/recruitments/${other.recruitment.id}/report`,
        `/dashboard/${own.companyId}/marka/zasob/${other.logo.assetId}`]) {
        const res = await page(own.host, path, userId);
        assert.equal(res.status, 404, `${own.host} ${path}`);
        assert.doesNotMatch(res.body, new RegExp(`${other.brandName}|${other.recruitmentName}`), `${own.host} ${path}`);
      }
      // A session of the other company on this address sees nothing of this company.
      const foreign = await page(own.host, `/dashboard/${own.companyId}/recruitments/${own.recruitment.id}/report`,
        userId === users.owner ? users.otherOwner : users.owner);
      assert.equal(foreign.status, 404);
      assert.ok(!foreign.body.includes(own.brandName) && !foreign.body.includes(own.reportedApplicationId), `${own.host}: foreign session`);
    }
  });

  await t.test('negative proof: the page check fails on the other company page or a page with injected foreign data', async () => {
    const pageA = (await page(A.host, `/dashboard/${A.companyId}/recruitments/${A.recruitment.id}/report`, users.owner)).body;
    const pageB = (await page(B.host, `/dashboard/${B.companyId}/recruitments/${B.recruitment.id}/report`, users.otherOwner)).body;
    assertOwnBrandPage(pageA, A, B, 'control');
    for (const [name, html] of [
      ['page of company B checked as A', pageB],
      ['foreign brand name', pageA.replace('</body>', `<p>${B.brandName}</p></body>`)],
      ['foreign colour', pageA.replace('</body>', `<i style="color:${B.colors.primary}"></i></body>`)],
      ['foreign candidate', pageA.replace('</body>', `<a href="/x/${B.reportedApplicationId}">x</a></body>`)],
      ['foreign site address', pageA.replace('</body>', `<a href="https://${B.host}/">x</a></body>`)],
      ['own colours missing', pageA.replaceAll(A.colors.primary, '#000000')],
      ['own logo missing', pageA.replaceAll(A.logo.assetId, '00000000-0000-4000-8000-000000000000')],
    ]) {
      assert.throws(() => assertOwnBrandPage(html, A, B, name), { code: 'ERR_ASSERTION' }, `check must flag: ${name}`);
    }
  });
});
