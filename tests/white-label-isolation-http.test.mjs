// SC-020-D — pełny zestaw negatywny dla dwóch firm na prawdziwym `next start`
// (po `npm run build`). Auth i PostgREST to cienka atrapa, ale KAŻDE zapytanie
// do danych wykonuje prawdziwy PostgreSQL z pełnym łańcuchem migracji, jako
// rola `authenticated` z identyfikatorem zalogowanego użytkownika (albo `anon`):
// RLS, funkcje security definer i polityki Storage są prawdziwe.
// Sprawdzamy: podszywanie się pod Host/X-Forwarded-Host, podrobione nagłówki
// firmy, dostęp do marki/plików/panelu innej firmy na każdej domenie, sesję
// innej firmy, edycje bez uprawnień (strony tylko do odczytu), zła/odwołana/
// nieświeża domena, przywrócenie marki, awarię rozpoznania domeny, nagłówki
// cache i ciasteczka tylko dla hosta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { bootWhiteLabel, users } from './helpers/white-label-fixture.mjs';

const PUBLIC_KEY = 'synthetic-public-key';
const IDENT = /^[a-z_][a-z0-9_]*$/;
const token = sub => [Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'synthetic'].join('.');
const subOf = bearer => {
  try { return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub ?? null; } catch { return null; }
};
const session = (userId, expired = false) => {
  const expiresAt = Math.floor(Date.now() / 1000) + (expired ? -600 : 3600);
  return { access_token: token(userId), refresh_token: `refresh-${userId}`, expires_at: expiresAt, expires_in: expired ? 0 : 3600,
    token_type: 'bearer', user: { id: userId, aud: 'authenticated', email: 'synthetic@example.invalid' } };
};
const cookieFor = (userId, expired) => 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify(session(userId, expired))).toString('base64url');

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
    state.requests.push(`${req.method} ${url.pathname}`);
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
        if (name === 'tenant_domain_resolve' && state.resolveDown) throw Object.assign(new Error('upstream down'), { status: 503, code: 'stub_down' });
        const keys = Object.keys(body);
        if (!keys.every(key => IDENT.test(key))) throw Object.assign(new Error('bad argument'), { status: 400 });
        const args = keys.map((key, i) => `${key} => $${i + 1}`).join(', ');
        const values = keys.map(key => body[key] !== null && typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key]);
        const result = await asCaller(req.headers.authorization, async client => {
          const meta = (await client.query("select proretset from pg_proc where pronamespace='public'::regnamespace and proname=$1", [name])).rows[0];
          if (!meta) throw Object.assign(new Error('function not found'), { status: 404, code: 'PGRST202' });
          if (meta.proretset) return (await client.query(`select * from public.${name}(${args})`, values)).rows;
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
        let order = '', limit = '';
        for (const [key, value] of url.searchParams) {
          if (key === 'select') continue;
          if (key === 'order') {
            order = ' order by ' + value.split(',').map(part => {
              const [column, direction = 'asc'] = part.split('.');
              if (!IDENT.test(column) || !['asc', 'desc'].includes(direction)) throw Object.assign(new Error('bad order'), { status: 400 });
              return `"${column}" ${direction}`;
            }).join(',');
          } else if (key === 'limit') {
            limit = ` limit ${Math.min(Number(value) || 0, 1000)}`;
          } else if (IDENT.test(key) && value.startsWith('eq.')) {
            values.push(value.slice(3)); where.push(`"${key}"::text = $${values.length}`);
          } else throw Object.assign(new Error(`unsupported filter ${key}=${value}`), { status: 400 });
        }
        const sql = `select ${columns} from public."${table}"${where.length ? ' where ' + where.join(' and ') : ''}`;
        const rows = await asCaller(req.headers.authorization, async client => (await client.query(sql + order + limit, values)).rows);
        const headers = { 'content-type': 'application/json', 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        return res.end(JSON.stringify(req.headers.accept?.includes('vnd.pgrst.object') ? rows[0] ?? null : rows));
      }
      throw Object.assign(new Error(`unsupported ${req.method} ${url.pathname}`), { status: 501 });
    } catch (error) {
      state.errors.push(`${req.method} ${url.pathname}: ${error.code ?? ''} ${error.message}`);
      fail(res, error);
    }
  });
  return { server, pool };
}

test('SC-020-D: two companies, two customer domains, every cross-tenant path refused on a real server', async t => {
  const e = await bootWhiteLabel(t);
  const { db, h, a, b } = e;
  const A = a.companyId, B = b.companyId;
  // Synthetic brands and active domains for both companies.
  const logoA = await e.registerLogo(A);
  const logoB = await e.registerLogo(B);
  const firstA = await e.publishBrand(A, 'Alfa Marka', logoA.assetId);
  await e.publishBrand(B, 'Beta Marka', logoB.assetId);
  await e.activeDomain(A, 'kariera.firma-a.pl');
  await e.activeDomain(B, 'jobs.firma-b.pl');
  await h.asAdmin();
  const objects = new Map([[logoA.path, logoA.bytes], [logoB.path, logoB.bytes]]);
  const state = { requests: [], errors: [], resolveDown: false };
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

  const platform = `127.0.0.1:${port}`;
  const hostA = 'kariera.firma-a.pl', hostB = 'jobs.firma-b.pl';
  const as = (userId, host, extra = {}) => ({ host, 'x-forwarded-host': host, ...(userId ? { cookie: cookieFor(userId) } : {}), ...extra });
  const page = (host, path, userId, extra) => get(port, path, as(userId, host, extra));
  const noStore = res => assert.match(res.headers['cache-control'] ?? '', /private/i, 'never cacheable by a shared cache') && undefined;

  await t.test('spoofed Host / X-Forwarded-Host and malformed hosts are refused before anything else', async () => {
    for (const headers of [
      { host: hostA, 'x-forwarded-host': hostB, cookie: cookieFor(users.otherOwner) },
      { host: platform, 'x-forwarded-host': hostA, cookie: cookieFor(users.owner) },
      { host: hostB, 'x-forwarded-host': `${hostB}, ${hostA}` },
      { host: `${hostA}.` }, { host: `${hostA}:99999` }, { host: `user@${hostA}` },
    ]) {
      const res = await get(port, `/dashboard/${A}`, headers);
      assert.equal(res.status, 400, JSON.stringify(headers));
      assert.match(res.headers['cache-control'], /no-store/);
    }
  });

  await t.test('forged tenant headers are replaced by the proxy on every host', async () => {
    const forged = { 'x-skillcheck-tenant-company': A, 'x-skillcheck-tenant-host': hostA };
    const onPlatform = await page(platform, '/dashboard', users.otherOwner, forged);
    assert.equal(onPlatform.status, 200);
    assert.match(onPlatform.body, /Firma B/, 'platform host: forged A header ignored, B still listed');
    assert.doesNotMatch(onPlatform.body, /nie ma dostępu/);
    const onA = await page(hostA, '/dashboard', users.owner, { 'x-skillcheck-tenant-company': B });
    assert.equal(onA.status, 200);
    assert.match(onA.body, /Firma A/);
    assert.doesNotMatch(onA.body, /Firma B/);
  });

  await t.test('own domain: own panel, own published brand, own logo; responses are private', async () => {
    const panel = await page(hostA, `/dashboard/${A}`, users.owner);
    assert.equal(panel.status, 200, logs.slice(-2000));
    assert.match(panel.body, /Alfa Marka/);
    assert.doesNotMatch(panel.body, /Beta Marka|Firma B/);
    assert.match(panel.headers['cache-control'], /no-store/);
    assert.match(panel.body, new RegExp(`/dashboard/${A}/domeny`), 'owner sees the domains link');
    assert.match(panel.body, new RegExp(`/dashboard/${A}/zmiany-marki`));
    const logo = await page(hostA, `/dashboard/${A}/marka/zasob/${logoA.assetId}`, users.owner);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers['content-type'], 'image/png');
    assert.deepEqual(logo.buffer, logoA.bytes);
    noStore(logo);
    const panelB = await page(hostB, `/dashboard/${B}`, users.otherOwner);
    assert.equal(panelB.status, 200);
    assert.match(panelB.body, /Beta Marka/);
    assert.doesNotMatch(panelB.body, /Alfa Marka|Firma A/);
  });

  await t.test('another company on a customer domain: panel, sub-pages, logo, operator — all 404', async () => {
    for (const [host, other, user, asset] of [[hostA, B, users.otherOwner, logoB.assetId], [hostB, A, users.owner, logoA.assetId]]) {
      for (const path of [`/dashboard/${other}`, `/dashboard/${other}/marka`, `/dashboard/${other}/domeny`, `/dashboard/${other}/zmiany-marki`,
        `/dashboard/${other}/candidates`, `/dashboard/${other}/marka/zasob/${asset}`, `/DASHBOARD/${other}`, '/operator/billing']) {
        const res = await page(host, path, user);
        assert.equal(res.status, 404, `${host} ${path}`);
        assert.doesNotMatch(res.body, /Alfa Marka|Beta Marka/, `${host} ${path}`);
        assert.match(res.headers['cache-control'] ?? '', /no-store/);
      }
    }
  });

  await t.test('a session of another company on this domain sees nothing of it and is not redirected away', async () => {
    for (const path of [`/dashboard/${A}`, `/dashboard/${A}/marka`, `/dashboard/${A}/domeny`, `/dashboard/${A}/zmiany-marki`]) {
      const res = await page(hostA, path, users.otherOwner);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(res.body, /Alfa Marka|kariera\.firma-a\.pl/, path);
    }
    const logo = await page(hostA, `/dashboard/${A}/marka/zasob/${logoA.assetId}`, users.otherOwner);
    assert.equal(logo.status, 404);
    assert.notDeepEqual(logo.buffer, logoA.bytes);
    for (const user of [users.otherOwner, users.outsider]) {
      const list = await page(hostA, '/dashboard?next=%2Fkup%2Fpreselekcja', user);
      assert.equal(list.status, 200, 'no redirect to `next` on a domain the account cannot use');
      assert.match(list.body, /nie ma dostępu/);
      assert.match(list.body, /Wyloguj się/);
      assert.doesNotMatch(list.body, /Firma A|Firma B/);
    }
    // Anonymous: login first, nothing of the company leaks.
    const anon = await page(hostA, `/dashboard/${A}/marka/zasob/${logoA.assetId}`, null);
    assert.equal(anon.status, 404);
  });

  await t.test('a company asset is never served under another company id, even on its own domain', async () => {
    const res = await page(hostB, `/dashboard/${B}/marka/zasob/${logoA.assetId}`, users.otherOwner);
    assert.equal(res.status, 404);
    const viaPlatform = await page(platform, `/dashboard/${B}/marka/zasob/${logoA.assetId}`, users.otherOwner);
    assert.equal(viaPlatform.status, 404);
    const otherViaPlatform = await page(platform, `/dashboard/${A}/marka/zasob/${logoA.assetId}`, users.otherOwner);
    assert.equal(otherViaPlatform.status, 404);
  });

  await t.test('members without owner rights get read-only pages; no editor, no domain or history data', async () => {
    for (const user of [users.recruiter, users.viewer]) {
      const panel = await page(hostA, `/dashboard/${A}`, user);
      assert.equal(panel.status, 200);
      assert.match(panel.body, /Alfa Marka/, 'members see the published brand');
      assert.doesNotMatch(panel.body, /\/domeny|\/zmiany-marki/);
      const brand = await page(hostA, `/dashboard/${A}/marka`, user);
      assert.match(brand.body, /ustawia właściciel konta firmy/);
      assert.doesNotMatch(brand.body, /Zapisz szkic|Opublikuj|Przywróć/);
      const domains = await page(hostA, `/dashboard/${A}/domeny`, user);
      assert.match(domains.body, /Domenami firmy zarządza właściciel/);
      assert.doesNotMatch(domains.body, /skillcheck-domain-verification|_skillcheck-challenge/);
      const history = await page(hostA, `/dashboard/${A}/zmiany-marki`, user);
      assert.match(history.body, /Historię zmian widzi właściciel/);
      assert.doesNotMatch(history.body, /opublikowano wersję/);
    }
    const history = await page(hostA, `/dashboard/${A}/zmiany-marki`, users.owner);
    assert.equal(history.status, 200);
    assert.match(history.body, /kariera\.firma-a\.pl/);
    assert.match(history.body, /opublikowano wersję/);
    assert.match(history.body, /włączono — właściciel/);
    assert.doesNotMatch(history.body, /jobs\.firma-b\.pl|Beta Marka/);
  });

  await t.test('rollback is visible on the next request (no stale cached brand)', async () => {
    await e.publishBrand(A, 'Alfa Nowa', logoA.assetId);
    assert.match((await page(hostA, `/dashboard/${A}`, users.owner)).body, /Alfa Nowa/);
    await e.as(users.owner);
    await e.one('select public.brand_rollback($1,$2)', [A, firstA]);
    await h.asAdmin();
    const after = await page(hostA, `/dashboard/${A}`, users.recruiter);
    assert.match(after.body, /Alfa Marka/);
    assert.doesNotMatch(after.body, /Alfa Nowa/);
    assert.match(after.headers['cache-control'], /no-store/);
    assert.match((await page(hostA, `/dashboard/${A}/zmiany-marki`, users.owner)).body, /przywrócono wcześniejszą wersję — Ty/);
  });

  await t.test('session cookies refreshed on a customer domain stay host-only', async () => {
    const res = await get(port, `/dashboard/${A}`, { host: hostA, 'x-forwarded-host': hostA, cookie: cookieFor(users.owner, true) });
    const cookies = [res.headers['set-cookie'] ?? []].flat();
    assert.ok(cookies.some(c => c.startsWith('sb-127-auth-token')), `refreshed session cookie set: ${JSON.stringify(cookies)}`);
    for (const cookie of cookies) assert.doesNotMatch(cookie, /;\s*domain=/i, cookie);
    assert.match(res.headers['cache-control'], /no-store/);
  });

  await t.test('lookup failure on a customer domain fails closed (503), never as the unrestricted platform', async () => {
    state.resolveDown = true;
    try {
      for (const path of ['/operator/billing', `/dashboard/${B}`, '/login']) {
        const res = await page(hostA, path, users.otherOwner);
        assert.equal(res.status, 503, path);
        assert.match(res.headers['cache-control'], /no-store/);
      }
      assert.equal((await page(platform, '/login', null)).status, 200, 'platform host does not depend on the lookup');
    } finally { state.resolveDown = false; }
  });

  await t.test('stale or revoked domain: the host stops pointing at the company', async () => {
    assert.equal((await page(hostA, `/dashboard/${B}`, users.otherOwner)).status, 404);
    await db.query("update tenant_domains.domains set last_verified_at = clock_timestamp() - interval '31 days' where hostname=$1 and status='active'", [hostA]);
    const stale = await page(hostA, '/dashboard', users.otherOwner);
    assert.equal(stale.status, 200);
    assert.match(stale.body, /Firma B/, 'stale host is no longer pinned to company A');
    await e.as(users.otherOwner);
    const domain = (await e.one('select public.tenant_domain_state($1)', [B])).domains.find(d => d.hostname === hostB && d.status === 'active');
    await e.one('select public.tenant_domain_revoke($1,$2)', [B, domain.id]);
    await h.asAdmin();
    const revoked = await page(hostB, '/dashboard', users.owner);
    assert.equal(revoked.status, 200);
    assert.match(revoked.body, /Firma A/, 'revoked host is no longer pinned to company B');
    assert.equal(await e.resolve(hostB), null);
    await h.asAdmin();
  });

  // Every data request went through the real database; nothing unexpected was asked of the stub.
  assert.deepEqual(state.errors.filter(line => !/42501|P0002|stub_down|brand_forbidden|tenant_domain_forbidden/.test(line)), [], state.errors.join('\n'));
});
