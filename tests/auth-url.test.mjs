import test from 'node:test';
import assert from 'node:assert/strict';
import { appOrigin, authCallbackUrl, homeAuthFallback } from '../lib/auth-url.ts';

const preview = { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'branch.example.vercel.app', VERCEL_URL: 'deployment.example.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'production.example', NEXT_PUBLIC_SITE_URL: 'https://production.example' };
test('preview stays on the allowlisted request origin and never falls back to production', () => {
  assert.equal(appOrigin(undefined, preview), 'https://branch.example.vercel.app');
  for (const origin of ['https://branch.example.vercel.app', 'https://deployment.example.vercel.app']) {
    assert.equal(authCallbackUrl('signup', origin, preview), origin + '/auth/callback');
    assert.equal(authCallbackUrl('recovery', origin, preview), origin + '/auth/callback?flow=recovery');
  }
  assert.throws(() => appOrigin('https://production.example', preview));
  assert.throws(() => appOrigin(undefined, { VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: 'production.example' }));
  assert.equal(appOrigin(null, { VERCEL_ENV: 'preview', VERCEL_URL: preview.VERCEL_URL }), 'https://' + preview.VERCEL_URL);
});
test('production and local origins require explicit trusted configuration', () => {
  assert.equal(appOrigin(null, { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'app.example' }), 'https://app.example');
  assert.equal(appOrigin(null, { VERCEL_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://custom.example/' }), 'https://custom.example');
  assert.equal(appOrigin(null, { NODE_ENV: 'development' }), 'http://localhost:3000');
  assert.equal(appOrigin(null, { NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:4567' }), 'http://127.0.0.1:4567');
  assert.throws(() => appOrigin(null, { NODE_ENV: 'production' }));
  assert.throws(() => appOrigin(null, { VERCEL_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' }));
});
test('untrusted origins and malformed environment values cannot supply email destinations', () => {
  for (const origin of ['https://evil.example', 'https://branch.example.vercel.app.evil.example', 'https://branch.example.vercel.app@evil.example', '//branch.example.vercel.app', 'null', '', 'https://branch.example.vercel.app/path', 'https://branch.example.vercel.app?next=evil']) assert.throws(() => appOrigin(origin, preview));
  for (const host of ['https://app.example', 'app.example/path', 'user@app.example', 'app.example\\evil', 'app.example:443', 'app.example?x=y']) assert.throws(() => appOrigin(null, { VERCEL_ENV: 'preview', VERCEL_URL: host }));
  for (const url of ['javascript:alert(1)', 'http://app.example', 'https://user:pass@app.example', 'https://*.example', 'https://app.example#fragment', 'https://app.example?x=y', '']) assert.throws(() => appOrigin(null, { NEXT_PUBLIC_SITE_URL: url }));
});

test('home page finishes Supabase Site URL fallbacks and ignores ordinary visits', () => {
  const at = query => homeAuthFallback(new URLSearchParams(query));
  assert.equal(at(''), null);
  assert.equal(at('utm_source=newsletter'), null);
  assert.equal(at('code=34e770dd-9ff9-416c-87fa-43b31d7ef225'), '/auth/callback?code=34e770dd-9ff9-416c-87fa-43b31d7ef225');
  // Only the code is forwarded; a flow or redirect target from the URL is never trusted.
  assert.equal(at('code=abc&flow=recovery&next=https://evil.example'), '/auth/callback?code=abc');
  for (const query of ['error=access_denied&error_code=otp_expired', 'error_code=otp_expired', 'code=', 'code=%3Cscript%3E', 'code=' + 'a'.repeat(513)])
    assert.equal(at(query), '/login?message=callback', query);
});
