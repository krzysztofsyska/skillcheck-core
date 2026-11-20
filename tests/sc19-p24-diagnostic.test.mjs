// R7: the Przelewy24 operator diagnostic (SC-P24-DIAG-001) is removed together with
// the adapter. This file keeps its name because .github/workflows/sc19-payments.yml
// runs it by path. It keeps the one rule of that work that still applies to every
// payment provider: a billing route must outlive the provider call it makes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the operator billing panel has no Przelewy24 diagnostic', async () => {
  const page = await read('app/operator/billing/page.tsx');
  const actions = await read('app/operator/billing/actions.ts');
  assert.doesNotMatch(page, /P24Diagnostic|p24-diagnostic|p24\?: string/);
  assert.doesNotMatch(actions, /checkP24|sc19-p24-diagnostic|Przelewy24/);
});

// A Supabase auth round trip, a pooler connect (6 s), a query budget (12 s) and one
// provider API call must fit, or the platform kills the invocation and the client
// gets an HTML 503 instead of our JSON error code.
test('every billing route declares a duration above the platform default and within the plan limit', async () => {
  for (const route of ['checkout', 'offers', 'orders/[orderId]', 'stripe/webhook']) {
    const source = await read(`app/api/billing/${route}/route.ts`);
    const declared = Number(/export const maxDuration ?= ?([0-9]+);/.exec(source)?.[1]);
    assert.ok(declared >= 30, `${route} declares maxDuration ${declared}`);
    assert.ok(declared <= 60, `${route} must stay within the plan limit`);
  }
});
