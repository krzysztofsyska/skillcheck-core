// SC-020-B — proxy on a real `next start` (after `npm run build`), with a fake
// Supabase answering public.tenant_domain_resolve. Two synthetic companies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { request } from 'node:http';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const hosts = { 'kariera.firma-a.pl': A, 'jobs.firma-b.pl': B };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('proxy: host spoofing, tenant routing and safe fallback on a real server', async t => {
  const lookups = [];
  const supabase = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url.startsWith('/rest/v1/rpc/tenant_domain_resolve')) {
        const host = JSON.parse(body || '{}').target_host;
        lookups.push(host);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(hosts[host] ?? null));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const supabasePort = await listen(supabase);
  t.after(() => supabase.close());
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VERCEL_ENV: '', WHITE_LABEL_ENABLED: '', NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-only-public-key', NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await get(port, '/login', { host: `127.0.0.1:${port}` })).status === 200; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Next server started');

  // Spoofing: X-Forwarded-Host different from Host, or a malformed Host.
  for (const headers of [
    { host: 'kariera.firma-a.pl', 'x-forwarded-host': 'jobs.firma-b.pl' },
    { host: `127.0.0.1:${port}`, 'x-forwarded-host': 'kariera.firma-a.pl' },
    { host: 'kariera.firma-a.pl.' },
    { host: 'kariera.firma-a.pl,jobs.firma-b.pl' },
  ]) {
    const res = await get(port, '/login', headers);
    assert.equal(res.status, 400, JSON.stringify(headers));
    assert.match(res.headers['cache-control'], /no-store/);
  }

  // Company A's domain: only A's panel; operator panel hidden; /dashboard goes to A.
  const a = { host: 'kariera.firma-a.pl', 'x-forwarded-host': 'kariera.firma-a.pl' };
  assert.equal((await get(port, `/dashboard/${B}`, a)).status, 404);
  assert.equal((await get(port, `/dashboard/${B}/candidates`, a)).status, 404);
  assert.equal((await get(port, '/operator/billing', a)).status, 404);
  const home = await get(port, '/dashboard', a);
  assert.equal(home.status, 307);
  assert.match(home.headers.location, new RegExp(`/dashboard/${A}$`));
  const own = await get(port, `/dashboard/${A}`, a);
  assert.equal(own.status, 307, 'own panel still needs a session');
  assert.match(own.headers.location, /\/login$/);
  assert.equal((await get(port, '/login', a)).status, 200);
  // Company B's domain never serves A.
  assert.equal((await get(port, `/dashboard/${A}`, { host: 'jobs.firma-b.pl' })).status, 404);

  // Unknown / unverified host: platform behaviour, no company picked, forged header ignored.
  const unknown = await get(port, `/dashboard/${B}`, { host: 'unknown.firma-c.pl', 'x-skillcheck-tenant-company': A });
  assert.equal(unknown.status, 307);
  assert.match(unknown.headers.location, /\/login$/);
  assert.ok(lookups.includes('unknown.firma-c.pl'));
  const before = lookups.length;
  await get(port, '/login', { host: `127.0.0.1:${port}` });
  assert.equal(lookups.length, before, 'platform host never queries the database');
});
