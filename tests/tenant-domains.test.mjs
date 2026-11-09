// SC-020-B — reguły domen bez sieci i bazy: walidacja hosta, podszywanie się
// pod Host/X-Forwarded-Host, rozpoznanie firmy, ograniczenie tras do własnej
// firmy, ciasteczka tylko dla hosta, adresy zwrotne logowania, weryfikacja
// DNS/TLS przez atrapy. Dwie syntetyczne firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TENANT_TRUSTED_PATH_PREFIXES, checkClaim, checkDnsOwnership, decideTenant, hostOnlyCookieOptions,
  isReservedHostname, isValidHostname, normalizeHostnameInput, parseRequestHost, platformHostnames,
  tenantDomainsEnabled, tenantOriginFromHeader, tenantRoute, verificationRecord,
} from '../lib/tenant-domains.ts';
import { checkDomain } from '../lib/tenant-domain-verifier.ts';
import { isPublicAddress, verifierDatabaseTls, verifierStoreFromEnv } from '../lib/tenant-domain-network.ts';
import { appOrigin, authCallbackUrl } from '../lib/auth-url.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64);
const preview = { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'skillcheck-core-git-x.vercel.app', VERCEL_URL: 'skillcheck-core-abc.vercel.app' };
const domains = { 'kariera.firma-a.pl': A, 'jobs.firma-b.pl': B };
const resolve = async host => domains[host] ?? null;
const decide = (host, pathname = '/dashboard', forwardedHost = host, env = preview, resolver = resolve) =>
  decideTenant({ host, forwardedHost, pathname, env, resolve: resolver });

test('hostname rules match the database rules', () => {
  for (const ok of ['kariera.firma-a.pl', 'a1.b2.co', 'xn--bcher-kva.example.de']) assert.ok(isValidHostname(ok), ok);
  for (const bad of ['Kariera.pl', 'kariera.pl.', '-a.pl', 'a-.pl', '10.0.0.1', 'localhost', 'a..pl', 'a_b.pl', 'x'.repeat(64) + '.pl', 'a.1pl'])
    assert.ok(!isValidHostname(bad), bad);
  for (const reserved of ['skillcheck.pl', 'app.skillcheck.pl', 'x.vercel.app', 'db.supabase.co', 'host.local', 'example.com'])
    assert.ok(isReservedHostname(reserved), reserved);
  assert.equal(normalizeHostnameInput('  Kariera.Firma-A.PL. '), 'kariera.firma-a.pl');
  assert.equal(normalizeHostnameInput('bücher.de'), 'xn--bcher-kva.de');
  for (const bad of ['https://kariera.pl', 'kariera.pl/path', 'kariera.pl:443', 'user@kariera.pl', 'kar iera.pl', '127.0.0.1', '[::1]', ''])
    assert.equal(normalizeHostnameInput(bad), null, bad);
  assert.deepEqual(checkClaim('app.skillcheck.pl', 'custom', null), { ok: false, reason: 'reserved' });
  assert.deepEqual(checkClaim('acme', 'subdomain', null), { ok: false, reason: 'subdomains_disabled' });
  assert.deepEqual(checkClaim('www', 'subdomain', 'klienci.skillcheck.pl'), { ok: false, reason: 'reserved' });
  assert.deepEqual(checkClaim('acme', 'subdomain', 'klienci.skillcheck.pl'), { ok: true, hostname: 'acme.klienci.skillcheck.pl' });
  assert.deepEqual(checkClaim('x.klienci.skillcheck.pl', 'custom', 'klienci.skillcheck.pl'), { ok: false, reason: 'reserved' });
  assert.deepEqual(verificationRecord('kariera.firma-a.pl', TOKEN),
    { name: '_skillcheck-challenge.kariera.firma-a.pl', value: 'skillcheck-domain-verification=' + TOKEN });
  assert.throws(() => verificationRecord('kariera.firma-a.pl', 'short'));
});

test('migration and library share the same reserved lists', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261109200000_sc020_customer_domains.sql', import.meta.url), 'utf8');
  const source = await readFile(new URL('../lib/tenant-domains.ts', import.meta.url), 'utf8');
  const list = (text, start) => [...text.slice(text.indexOf(start)).split(/\]/)[0].matchAll(/'([a-z0-9.-]+)'/g)].map(m => m[1]);
  assert.deepEqual(list(sql, "select 1 from unnest(array["), list(source, 'const RESERVED_SUFFIXES = Object.freeze(['));
  assert.deepEqual(list(sql, "select value = any (array["), list(source, 'const RESERVED_LABELS = new Set(['));
});

test('spoofed or malformed Host / X-Forwarded-Host headers are rejected', async () => {
  assert.deepEqual(await decide('kariera.firma-a.pl', '/dashboard', 'jobs.firma-b.pl'), { kind: 'bad_host' });
  assert.deepEqual(await decide('evil.example.org', '/dashboard', 'kariera.firma-a.pl'), { kind: 'bad_host' });
  for (const host of [null, '', 'kariera.firma-a.pl, jobs.firma-b.pl', 'kariera.firma-a.pl.', 'user@kariera.firma-a.pl',
    'kariera.firma-a.pl:99999', 'kariera.firma-a.pl:abc', 'kari era.pl', '[::1]:3000', 'kariera.firma-a.pl/x'])
    assert.deepEqual(await decide(host), { kind: 'bad_host' }, String(host));
  assert.ok(parseRequestHost('Kariera.Firma-A.pl', null).ok, 'case is normalised');
  assert.equal(parseRequestHost('kariera.firma-a.pl:443', 'kariera.firma-a.pl:443').hostname, 'kariera.firma-a.pl');
  assert.deepEqual(parseRequestHost('kariera.firma-a.pl', 'KARIERA.FIRMA-A.PL'), { ok: true, hostname: 'kariera.firma-a.pl', authority: 'kariera.firma-a.pl' });
});

test('host -> tenant: only active resolved hosts pick a company; everything else falls back to the platform', async () => {
  const a = await decide('kariera.firma-a.pl', `/dashboard/${A}`);
  assert.deepEqual(a, { kind: 'tenant', companyId: A, hostname: 'kariera.firma-a.pl', route: { kind: 'continue' } });
  assert.deepEqual(await decide('unknown.firma-c.pl'), { kind: 'platform' });
  assert.deepEqual(await decide('skillcheck-core-git-x.vercel.app'), { kind: 'platform' });
  let calls = 0;
  await decide('skillcheck-core-abc.vercel.app', '/dashboard', 'skillcheck-core-abc.vercel.app', preview, async () => { calls += 1; return A; });
  assert.equal(calls, 0, 'platform hosts never consult the database');
  // SC-020-D: a failed or malformed lookup fails closed (503), never as the unrestricted platform.
  assert.deepEqual(await decide('kariera.firma-a.pl', '/dashboard', 'kariera.firma-a.pl', preview, async () => { throw new Error('db down'); }), { kind: 'unavailable' });
  assert.deepEqual(await decide('kariera.firma-a.pl', '/dashboard', 'kariera.firma-a.pl', preview, async () => 'not-a-uuid'), { kind: 'unavailable' });
  assert.deepEqual(await decide('kariera.firma-a.pl', '/dashboard', 'kariera.firma-a.pl', preview, async () => undefined), { kind: 'platform' });
  // A platform subdomain of a company (<label>.<subdomain_base>) is a tenant like any customer domain: restricted
  // routes when resolved, 503 when the lookup fails — never the unrestricted platform.
  const sub = 'acme.klienci.skillcheck.pl';
  assert.deepEqual(await decide(sub, '/operator', sub, preview, async () => A), { kind: 'tenant', companyId: A, hostname: sub, route: { kind: 'not_found' } });
  assert.deepEqual(await decide(sub, '/login', sub, preview, async () => { throw new Error('db down'); }), { kind: 'unavailable' });
  assert.deepEqual(await decide('kariera.firma-a.pl', '/dashboard', null), (await decide('kariera.firma-a.pl')), 'missing X-Forwarded-Host is fine');
  // Production: disabled until the owner switches it on; nothing resolves.
  assert.deepEqual(await decide('kariera.firma-a.pl', '/dashboard', 'kariera.firma-a.pl', { VERCEL_ENV: 'production' }), { kind: 'disabled' });
  assert.equal(tenantDomainsEnabled({ VERCEL_ENV: 'production', WHITE_LABEL_ENABLED: 'true' }), true);
  assert.equal(tenantDomainsEnabled({ VERCEL_ENV: 'preview', WHITE_LABEL_ENABLED: 'false' }), false);
  assert.ok(platformHostnames({}).has('localhost'));
  assert.ok(!platformHostnames(preview).has('localhost'));
});

test('on company A\'s domain only company A\'s panel is reachable', async () => {
  assert.deepEqual(tenantRoute(`/dashboard/${A}/positions/x`, A), { kind: 'continue' });
  assert.deepEqual(tenantRoute(`/dashboard/${B}`, A), { kind: 'not_found' });
  assert.deepEqual(tenantRoute(`/DASHBOARD/${B.toUpperCase()}/candidates`, A), { kind: 'not_found' });
  assert.deepEqual(tenantRoute('/dashboard', A), { kind: 'continue' }, 'company list (own company + logout) stays reachable');
  assert.deepEqual(tenantRoute('/onboarding', A), { kind: 'redirect', location: `/dashboard/${A}` });
  for (const path of ['/operator', '/operator/billing', '/Operator/x']) assert.deepEqual(tenantRoute(path, A), { kind: 'not_found' }, path);
  for (const path of ['/login', '/auth/callback', '/register', '/kup/preselekcja']) assert.deepEqual(tenantRoute(path, A), { kind: 'continue' }, path);
  const b = await decide('jobs.firma-b.pl', `/dashboard/${A}`);
  assert.deepEqual(b.route, { kind: 'not_found' }, 'B\'s host never serves A');
});

test('session cookies are host-only; auth redirects accept only configured or verified tenant origins', () => {
  assert.deepEqual(hostOnlyCookieOptions({ domain: '.firma-a.pl', path: '/', httpOnly: true }), { path: '/', httpOnly: true });
  assert.deepEqual(hostOnlyCookieOptions({ path: '/' }), { path: '/' });
  assert.equal(hostOnlyCookieOptions(undefined), undefined);
  const env = { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'skillcheck-core-git-x.vercel.app' };
  const tenant = tenantOriginFromHeader('kariera.firma-a.pl');
  assert.equal(tenant, 'https://kariera.firma-a.pl');
  assert.equal(appOrigin('https://kariera.firma-a.pl', env, tenant), 'https://kariera.firma-a.pl');
  assert.equal(authCallbackUrl('recovery', 'https://kariera.firma-a.pl', env, undefined, tenant), 'https://kariera.firma-a.pl/auth/callback?flow=recovery');
  // Without the proxy header (unverified host) or with another company's origin: refused.
  assert.throws(() => appOrigin('https://kariera.firma-a.pl', env));
  assert.throws(() => appOrigin('https://jobs.firma-b.pl', env, tenant));
  assert.throws(() => appOrigin('http://kariera.firma-a.pl', env, tenant));
  for (const bad of [null, '', 'kariera.firma-a.pl:443', 'evil.pl/x', 'Kariera.pl']) assert.equal(tenantOriginFromHeader(bad), null, String(bad));
  assert.equal(appOrigin(undefined, env, tenant), 'https://skillcheck-core-git-x.vercel.app', 'email links default to the platform');
});

test('proxy strips forged tenant headers and covers every route that may read them', async () => {
  const proxy = await readFile(new URL('../proxy.ts', import.meta.url), 'utf8');
  assert.match(proxy, /forwarded\.delete\(TENANT_COMPANY_HEADER\);\s*forwarded\.delete\(TENANT_HOST_HEADER\);/);
  assert.ok(proxy.indexOf('forwarded.delete(TENANT_COMPANY_HEADER)') < proxy.indexOf('decideTenant('));
  assert.match(proxy, /hostOnlyCookieOptions\(options\)/);
  const matcher = proxy.slice(proxy.indexOf('matcher: ['));
  for (const prefix of TENANT_TRUSTED_PATH_PREFIXES) {
    const route = prefix === '/dashboard' || prefix === '/operator' || prefix === '/kup' || prefix === '/auth' ? `"${prefix}/:path*"` : `"${prefix}"`;
    assert.ok(matcher.includes(route), `matcher must include ${route}`);
  }
  // Any file that reads the tenant headers must live under a trusted prefix (or be server-only lib code).
  const { execFileSync } = await import('node:child_process');
  const readers = execFileSync('git', ['grep', '-l', '-e', 'TENANT_COMPANY_HEADER', '-e', 'TENANT_HOST_HEADER', '--', 'app'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const file of readers) {
    const route = '/' + file.replace(/^app\//, '').replace(/\/(page|route|actions|layout)\.tsx?$/, '');
    assert.ok(TENANT_TRUSTED_PATH_PREFIXES.some(prefix => route === prefix || route.startsWith(prefix + '/')), `${file} reads tenant headers outside the proxy matcher`);
  }
  const server = await readFile(new URL('../lib/supabase/server.ts', import.meta.url), 'utf8');
  assert.match(server, /hostOnlyCookieOptions\(options\)/);
});

test('DNS ownership check through a fake resolver', async () => {
  const record = verificationRecord('kariera.firma-a.pl', TOKEN);
  const resolver = answers => ({ resolveTxt: async name => { assert.equal(name, record.name); if (answers instanceof Error) throw answers; return answers; } });
  assert.equal(await checkDnsOwnership(resolver([[record.value]]), 'kariera.firma-a.pl', TOKEN), 'ok');
  assert.equal(await checkDnsOwnership(resolver([['skillcheck-domain-verification=', 'a'.repeat(64)]]), 'kariera.firma-a.pl', TOKEN), 'ok', 'chunks are joined');
  assert.equal(await checkDnsOwnership(resolver([['other'], [record.value + 'x']]), 'kariera.firma-a.pl', TOKEN), 'missing');
  assert.equal(await checkDnsOwnership(resolver([['skillcheck-domain-verification=' + 'b'.repeat(64)]]), 'kariera.firma-a.pl', TOKEN), 'missing', 'another company\'s token');
  assert.equal(await checkDnsOwnership(resolver(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'kariera.firma-a.pl', TOKEN), 'missing');
  assert.equal(await checkDnsOwnership(resolver(Object.assign(new Error('x'), { code: 'ESERVFAIL' })), 'kariera.firma-a.pl', TOKEN), 'unavailable');
  const slow = { resolveTxt: () => new Promise(() => {}) };
  assert.equal(await checkDnsOwnership(slow, 'kariera.firma-a.pl', TOKEN, 20), 'unavailable');
});

test('verifier flow: reads host and token from the store, records DNS then TLS, never writes on resolver failure', async () => {
  const calls = [];
  const store = (target, dnsResult = 'verified', tlsResult = 'verified') => ({
    target: async (c, d) => { calls.push(['target', c, d]); return target; },
    recordDns: async (c, d, t, ok, actor) => { calls.push(['dns', c, d, t, ok, actor]); return dnsResult; },
    recordTls: async (c, d, t, ok, actor) => { calls.push(['tls', c, d, t, ok, actor]); return tlsResult; },
  });
  const target = { hostname: 'kariera.firma-a.pl', kind: 'custom', status: 'pending', verification_token: TOKEN };
  const dnsOk = { resolveTxt: async () => [[verificationRecord('kariera.firma-a.pl', TOKEN).value]] };
  const dnsDown = { resolveTxt: async () => { throw Object.assign(new Error('x'), { code: 'ETIMEOUT' }); } };
  const tlsOk = { isReady: async () => true };
  const D = '33333333-3333-4333-8333-333333333333';
  const OWNER = '44444444-4444-4444-8444-444444444444';
  assert.deepEqual(await checkDomain({ store: store(target), dns: dnsOk, tls: tlsOk }, A, D, OWNER), { result: 'checked', status: 'verified', tls: true });
  assert.deepEqual(calls.map(c => c[0]), ['target', 'dns', 'tls']);
  assert.equal(calls[1][3], TOKEN);
  assert.equal(calls[1][5], OWNER);
  assert.deepEqual(await checkDomain({ store: store(target), dns: dnsOk, tls: tlsOk }, A, D, 'nobody'), { result: 'not_found' });
  calls.length = 0;
  assert.deepEqual(await checkDomain({ store: store(target), dns: dnsDown, tls: tlsOk }, A, D, OWNER), { result: 'dns_unavailable', status: 'pending' });
  assert.deepEqual(calls.map(c => c[0]), ['target']);
  assert.deepEqual(await checkDomain({ store: store(target, 'conflict'), dns: dnsOk, tls: tlsOk }, A, D, OWNER), { result: 'conflict' });
  assert.deepEqual(await checkDomain({ store: store(null), dns: dnsOk, tls: tlsOk }, A, D, OWNER), { result: 'not_found' });
  assert.deepEqual(await checkDomain({ store: store(target), dns: dnsOk, tls: tlsOk }, 'x', D, OWNER), { result: 'not_found' });
  const thrower = { isReady: async () => { throw new Error('tls'); } };
  calls.length = 0;
  assert.deepEqual(await checkDomain({ store: store(target, 'verified', 'verified'), dns: dnsOk, tls: thrower }, A, D, OWNER), { result: 'checked', status: 'verified', tls: false });
  assert.equal(calls.at(-1)[4], false);
  // Subdomain: no DNS lookup (platform zone), straight to TLS.
  calls.length = 0;
  await checkDomain({ store: store({ ...target, kind: 'subdomain', status: 'verified' }), dns: dnsDown, tls: tlsOk }, A, D, OWNER);
  assert.deepEqual(calls.map(c => c[0]), ['target', 'tls']);
  assert.equal(verifierStoreFromEnv({}), null, 'no verifier credentials -> verification unavailable');
  assert.equal(verifierStoreFromEnv({ TENANT_DOMAIN_VERIFIER_DATABASE_URL: 'https://x' }), null);
  for (const url of ['postgres://u:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=disable', 'postgres://u:p@h/db#x', 'not a url'])
    assert.equal(verifierStoreFromEnv({ TENANT_DOMAIN_VERIFIER_DATABASE_URL: url }), null, url);
  const hosted = verifierDatabaseTls(new URL('postgres://u:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'));
  assert.equal(hosted.rejectUnauthorized, true);
  assert.match(hosted.ca, /BEGIN CERTIFICATE/, 'hosted Supabase uses the reviewed Supabase roots');
  assert.ok(verifierDatabaseTls(new URL('postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')).ca);
  assert.deepEqual(verifierDatabaseTls(new URL('postgres://u:p@ci.example.org/postgres')), { rejectUnauthorized: true });
});

test('TLS check never connects to private or local addresses', () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::1', 'fec0::1', '::7f00:1', '192.0.0.1', '::ffff:127.0.0.1', '2001:db8::1', '2001:0:4136:e378::1', '::ffff:0:7f00:1', 'not-an-ip'])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '76.76.21.21', '2606:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4001:80b::200e']) assert.equal(isPublicAddress(address), true, address);
});

test('company list on a customer domain shows only that company and keeps the logout button', async () => {
  const { default: ts } = await import('typescript');
  const { createRequire, Module } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const nextPath = await import('../lib/safe-next-path.ts');
  const load = tenant => {
    const path = fileURLToPath(new URL('../app/dashboard/page.tsx', import.meta.url));
    const mod = new Module(path); mod.filename = path;
    mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
    const require = createRequire(path);
    const client = {
      auth: { async getUser() { return { data: { user: { id: 'u1', email: 'a@b.pl' } } }; } },
      from: () => ({ select: () => ({ order: async () => ({ data: [{ id: A, name: 'Firma A' }, { id: B, name: 'Firma B' }], error: null }) }) }),
    };
    const mocks = {
      'next/navigation': { redirect(url) { const e = new Error('REDIRECT'); e.url = url; throw e; } },
      'next/headers': { async headers() { return new Map(tenant ? [['x-skillcheck-tenant-company', tenant]] : []); } },
      'next/link': { default: props => React.createElement('a', { href: props.href }, props.children) },
      '../../lib/supabase/server': { async createClient() { return client; } },
      '../../lib/safe-next-path': nextPath,
      '../../lib/auth-url': { TENANT_COMPANY_HEADER: 'x-skillcheck-tenant-company' },
      '../auth/actions': { logout() {} },
      '../components/submit-button': { SubmitButton: props => React.createElement('button', null, props.children) },
    };
    mod.require = id => id in mocks ? mocks[id] : require(id);
    mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, path);
    return mod.exports.default;
  };
  const render = async (tenant, params = {}) => renderToStaticMarkup(await load(tenant)({ searchParams: Promise.resolve(params) }));
  const onA = await render(A);
  assert.match(onA, /Firma A/);
  assert.doesNotMatch(onA, /Firma B/);
  assert.match(onA, /Wyloguj się/);
  const other = await render('33333333-3333-4333-8333-333333333333');
  assert.doesNotMatch(other, /Firma A|Firma B/);
  assert.match(other, /nie ma dostępu/);
  assert.match(other, /Wyloguj się/);
  const platform = await render(null);
  assert.match(platform, /Firma A/);
  assert.match(platform, /Firma B/);
  // SC-020-D: without access to the tenant company, `next` is not followed on its domain.
  const blocked = await render('33333333-3333-4333-8333-333333333333', { next: '/kup/preselekcja' });
  assert.match(blocked, /nie ma dostępu/);
  await assert.rejects(render(A, { next: '/kup/preselekcja' }), error => error.url === '/kup/preselekcja');
  await assert.rejects(render(null, { next: '/kup/preselekcja' }), error => error.url === '/kup/preselekcja');
});

test('SC-020-D: one white-label flag for brand and domains, same answer in every environment', async () => {
  const { whiteLabelEnabled } = await import('../lib/white-label-flag.ts');
  const { brandingEnabled } = await import('../lib/brand-config.ts');
  const cases = [
    [{}, false], [{ NODE_ENV: 'production' }, false], [{ NODE_ENV: 'test' }, false], [{ NODE_ENV: 'development' }, true],
    [{ VERCEL_ENV: 'preview' }, true], [{ VERCEL_ENV: 'production' }, false], [{ VERCEL_ENV: 'development' }, false],
    [{ VERCEL_ENV: 'production', NODE_ENV: 'development' }, false],
    [{ VERCEL_ENV: 'production', WHITE_LABEL_ENABLED: 'true' }, true], [{ VERCEL_ENV: 'preview', WHITE_LABEL_ENABLED: 'false' }, false],
    [{ NODE_ENV: 'production', WHITE_LABEL_ENABLED: 'true' }, true], [{ NODE_ENV: 'development', WHITE_LABEL_ENABLED: 'false' }, false],
    [{ VERCEL_ENV: 'preview', WHITE_LABEL_ENABLED: 'TRUE' }, true], [{ VERCEL_ENV: 'production', WHITE_LABEL_ENABLED: '1' }, false],
  ];
  for (const [env, expected] of cases) {
    assert.equal(whiteLabelEnabled(env), expected, JSON.stringify(env));
    assert.equal(brandingEnabled(env), expected, 'brand: ' + JSON.stringify(env));
    assert.equal(tenantDomainsEnabled(env), expected, 'domains: ' + JSON.stringify(env));
  }
  // No other module reads the variable directly.
  const { execFileSync } = await import('node:child_process');
  const readers = execFileSync('git', ['grep', '-l', 'WHITE_LABEL_ENABLED', '--', 'app', 'lib', 'proxy.ts'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(readers, ['lib/white-label-flag.ts']);
});
