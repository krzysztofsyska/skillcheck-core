// R7 (owner decision 19.11.2026, confirmed 20.11.2026: „wyrzucamy całkowicie P24”):
// the Przelewy24 adapter is removed. This file keeps its name because
// .github/workflows/sc19-payments.yml runs it by path; it now guards the removal so
// that no Przelewy24 code path, route or environment reader comes back unnoticed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const removed = [
  'lib/sc19-przelewy24-provider.ts',
  'lib/sc19-payment-preview-runtime.ts',
  'lib/sc19-p24-diagnostic.ts',
  'app/operator/billing/p24-diagnostic.tsx',
  'app/api/billing/webhook/route.ts',
];

test('the Przelewy24 adapter, its runtime, diagnostic and notification route are gone', () => {
  for (const file of removed) assert.equal(existsSync(new URL(file, root)), false, file);
});

test('no application code imports, calls or reads Przelewy24', () => {
  const files = execFileSync('git', ['ls-files', 'app', 'lib', 'components'],
    { cwd: fileURLToPath(root), encoding: 'utf8' }).split('\n').filter(f => /\.(ts|tsx|js|mjs)$/.test(f));
  assert.ok(files.length > 50, 'the application files are listed');
  const offenders = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(new URL(file, root), 'utf8'); } catch { continue; }
    // Executable references only: imports of the removed modules, the P24 hosts,
    // the P24 environment variables and the P24 resolver. Comments that record the
    // removal and the historical database role names (sc19_p24_*) stay allowed.
    if (/sc19-przelewy24-provider|sc19-payment-preview-runtime|sc19-p24-diagnostic|p24-diagnostic'|przelewy24\.pl|\bP24_(SANDBOX|MERCHANT_ID|POS_ID|CRC|API_KEY)\b|resolveSc19P24Runtime|sc19SandboxPayment|checkP24/.test(text))
      offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('every payment route resolves the Stripe runtime only', () => {
  const runtime = readFileSync(new URL('lib/sc19-payment-runtime.ts', root), 'utf8');
  assert.match(runtime, /export async function resolveSc19PaymentRuntime\([^)]*\)[^{]*\{\s*return resolveSc19StripeRuntime\(request\);\s*\}/);
  assert.doesNotMatch(runtime, /sc19-payment-preview|previewRuntime/);
  const http = readFileSync(new URL('lib/sc19-payment-http.ts', root), 'utf8');
  // The webhook signature always comes from the configured header; there is no
  // provider that signs inside the body any more.
  assert.match(http, /signatureHeader: string;/);
  assert.match(http, /const signature = request\.headers\.get\(runtime\.signatureHeader\) \?\? '';/);
});
