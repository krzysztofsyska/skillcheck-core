import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePolicy, selectModel, usageCostMicroUsd, usdMicroToPlnGrosze, packageMargin,
} from '../lib/ai-gateway/core.ts';
import { runMeteredOperation } from '../lib/ai-gateway/runtime.ts';

const model = {
  provider: 'openai', model: 'pinned-screening-model', revision: '2026-10-12',
  priceVersion: 'pricing-1', inputMicroUsdPerMillion: 250_000,
  cachedInputMicroUsdPerMillion: 25_000, outputMicroUsdPerMillion: 2_000_000,
};
const policy = validatePolicy({
  version: 'policy-v1',
  tasks: { cv_screening: 'screening' },
  models: { screening: model },
});
const ctx = {
  companyId: '11111111-1111-4111-8111-111111111111',
  requestKey: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  processId: null, candidatePseudonym: 'candidate_123', task: 'cv_screening',
};
const usage = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 };

function store() {
  const calls = { reservations: [], settles: [], unknown: [] };
  let seen = false;
  return {
    calls,
    ledger: {
      async reserve(req) {
        calls.reservations.push(req);
        if (seen) return { usageId: 'u1', created: false, warning: true };
        seen = true;
        return { usageId: 'u1', created: true, warning: true };
      },
      async settle(req) { calls.settles.push(req); return true; },
      async markUnknown(req) { calls.unknown.push(req); return true; },
    },
  };
}

test('strict versioned policy rejects unknown tasks, unpriced models and client-sized settings', () => {
  assert.equal(selectModel(policy, 'cv_screening').model, model.model);
  assert.throws(() => selectModel(policy, 'voice_analysis'), /SC021_ROUTE_DISABLED/);
  for (const raw of [
    { version: 'x', tasks: { bad_task: 'screening' }, models: { screening: model } },
    { version: 'x', tasks: { cv_screening: 'missing' }, models: { screening: model } },
    { version: 'x', tasks: { cv_screening: 'screening' }, models: { screening: { ...model, provider: 'arbitrary' } } },
    { version: 'x', tasks: { cv_screening: 'screening' }, models: { screening: { ...model, cachedInputMicroUsdPerMillion: 500_000 } } },
    { version: 'x', tasks: { cv_screening: 'screening' }, models: { screening: { ...model, secret: 'bad' } } },
  ]) assert.throws(() => validatePolicy(raw));
  const rollback = validatePolicy({ ...policy, version: 'policy-v0', tasks: { cv_screening: 'screening' } });
  assert.equal(selectModel(rollback, 'cv_screening').model, model.model);
  assert.equal(rollback.version, 'policy-v0');
});

test('usage is exact integer micro-USD with cached token separation and ceiling', () => {
  assert.equal(usageCostMicroUsd(model, usage), 405); // 800*.25 + 200*.025 + 100*2
  assert.equal(usageCostMicroUsd(model, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }), 1);
  for (const invalid of [
    { inputTokens: 3, cachedInputTokens: 4, outputTokens: 0 },
    { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 },
    { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0 },
  ]) assert.throws(() => usageCostMicroUsd(model, invalid), /SC021_INVALID_USAGE/);
  assert.throws(() => usageCostMicroUsd({ ...model, outputMicroUsdPerMillion: Number.MAX_SAFE_INTEGER },
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER }), /SC021_COST_OVERFLOW/);
});

test('contribution margin separates net PLN sales, provider spend, voice and other costs', () => {
  assert.equal(usdMicroToPlnGrosze(1_000_000, 400), 400);
  assert.equal(usdMicroToPlnGrosze(1, 400), 1);
  assert.deepEqual(packageMargin({
    revenueNetPlnGrosze: 30_000, aiCostPlnGrosze: 300,
    voiceAndTelephonyPlnGrosze: 500, otherVariablePlnGrosze: 1000,
  }), { known: true, marginPlnGrosze: 28_200, marginPercent: 94 });
  assert.deepEqual(packageMargin({
    revenueNetPlnGrosze: 30_000, aiCostPlnGrosze: null,
    voiceAndTelephonyPlnGrosze: 0, otherVariablePlnGrosze: 0,
  }), { known: false, marginPlnGrosze: null, marginPercent: null });
  assert.throws(() => packageMargin({
    revenueNetPlnGrosze: 500, aiCostPlnGrosze: -1,
    voiceAndTelephonyPlnGrosze: 0, otherVariablePlnGrosze: 0,
  }));
});

test('a provider call happens only after budget reservation and settles real usage', async () => {
  const f = store();
  let providerCalls = 0;
  const run = () => runMeteredOperation({
    context: ctx, policy, maxExpectedUsage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 400 },
    ledger: f.ledger,
    invoke: async (rate, correlationId) => {
      providerCalls++;
      assert.equal(rate.model, model.model);
      assert.match(correlationId, /^[0-9a-f-]{36}$/);
      return { data: { safe: true }, usage, providerRequestId: 'response-1' };
    },
  });
  const one = await run();
  assert.deepEqual(one.data, { safe: true });
  assert.equal(one.costMicroUsd, 405);
  assert.equal(one.warning, true);
  assert.equal(f.calls.reservations[0].estimatedMicroUsd, 1050);
  assert.equal(f.calls.reservations[0].priceVersion, 'pricing-1');
  assert.equal(f.calls.settles[0].costMicroUsd, 405);
  await assert.rejects(run(), /SC021_DUPLICATE_ATTEMPT/);
  assert.equal(providerCalls, 1);
});

test('fail closed on budget exhaustion, invalid tenant and unpriced operations', async () => {
  const f = store();
  let invoked = false;
  f.ledger.reserve = async () => { throw new Error('SC021_BUDGET_EXHAUSTED'); };
  await assert.rejects(runMeteredOperation({
    context: ctx, policy, maxExpectedUsage: usage, ledger: f.ledger,
    invoke: async () => { invoked = true; throw new Error('SHOULD_NOT_RUN'); },
  }), /SC021_BUDGET_EXHAUSTED/);
  assert.equal(invoked, false);
  await assert.rejects(runMeteredOperation({
    context: { ...ctx, companyId: 'forged' }, policy, maxExpectedUsage: usage,
    ledger: f.ledger, invoke: async () => { invoked = true; throw Error('SHOULD_NOT_RUN'); },
  }), /SC021_INVALID_CONTEXT/);
  assert.equal(invoked, false);
});

test('missing response usage or uncertain provider failure preserves reserved budget', async () => {
  for (const isNetworkFailure of [false, true]) {
    const f = store();
    await assert.rejects(runMeteredOperation({
      context: ctx, policy, maxExpectedUsage: usage, ledger: f.ledger,
      invoke: async () => {
        if (isNetworkFailure) throw new Error('contains sensitive provider body');
        return { data: 'unsafe', usage: null, providerRequestId: null };
      },
    }), new RegExp(isNetworkFailure ? 'SC021_PROVIDER_FAILURE' : 'SC021_USAGE_UNAVAILABLE'));
    assert.equal(f.calls.settles.length, 0);
    assert.equal(f.calls.unknown.length, 1);
  }
});

test('failed settlement never exposes unbooked result', async () => {
  const f = store();
  f.ledger.settle = async () => { throw new Error('SC021_SETTLEMENT_UNAVAILABLE'); };
  await assert.rejects(runMeteredOperation({
    context: ctx, policy, maxExpectedUsage: usage, ledger: f.ledger,
    invoke: async () => ({ data: { mustNotLeak: true }, usage, providerRequestId: null }),
  }), /SC021_SETTLEMENT_UNAVAILABLE/);
});
