import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePolicy, selectModel, usageCostMicroUsd, usdMicroToPlnGrosze, packageMargin,
} from '../lib/ai-gateway/core.ts';
import { runMeteredOperation } from '../lib/ai-gateway/runtime.ts';
import { postgresAiLedger } from '../lib/ai-gateway/postgres.ts';
import { createOpenAiResponsesAdapter } from '../lib/ai-gateway/openai.ts';
import { summarizeAiCosts } from '../lib/ai-gateway/reports.ts';

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


test('Postgres adapter passes only positional, typed worker metadata and validates returned row', async () => {
  const calls = [];
  const ledger = postgresAiLedger(async (sql, values) => {
    calls.push({sql, values});
    if (sql.includes('ai_gateway_reserve')) return [{ usage_id: ctx.requestKey, created: true, warning: false }];
    if (sql.includes('ai_gateway_settle')) return [{ settled: true }];
    if (sql.includes('ai_gateway_mark_unknown')) return [{ marked: true }];
    return [];
  });
  assert.deepEqual(await ledger.reserve({
    ...ctx, provider: 'openai', model: 'pinned-screening-model',
    policyVersion: 'policy-v1', priceVersion: 'pricing-1', estimatedMicroUsd: 300,
  }), { usageId: ctx.requestKey, created: true, warning: false });
  assert.equal(await ledger.settle({
    companyId: ctx.companyId, requestKey: ctx.requestKey, costMicroUsd: 123,
    usage, providerRequestId: 'resp_123',
  }), true);
  assert.equal(await ledger.markUnknown({companyId: ctx.companyId, requestKey:ctx.requestKey}), true);
  assert.equal(calls[0].values[0], ctx.companyId);
  assert.equal(calls[0].values[4], ctx.candidatePseudonym);
  assert.equal(calls[1].values[2], 123);
  assert.ok(calls.every(call => !call.sql.includes(ctx.companyId)));
  assert.ok(calls.every(call => !call.sql.includes('resp_123')));
  await assert.rejects(postgresAiLedger(async () => [{ settled: 'true' }]).settle({
    companyId: ctx.companyId, requestKey: ctx.requestKey,
    costMicroUsd: 12, usage, providerRequestId:null,
  }), /SC021_LEDGER_INVALID_RESPONSE/);
});


test('OpenAI adapter enforces store:false, pinned route, no tools, correlation ID and extracts usage', async () => {
  let requests = 0;
  const adapter = createOpenAiResponsesAdapter({
    apiKey: 'not-real-secret-test-only', input: [{role:'user',content:'redacted data'}],
    maxOutputTokens: 400,
    parseResult: body => body.output_text,
    fetchImpl: async (url, init) => {
      requests++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init.headers.authorization, 'Bearer not-real-secret-test-only');
      assert.equal(init.headers['X-Client-Request-Id'], ctx.requestKey);
      const payload = JSON.parse(init.body);
      assert.deepEqual(Object.keys(payload).sort(), ['input','max_output_tokens','model','store']);
      assert.equal(payload.store, false);
      assert.equal(payload.model, model.model);
      assert.equal(payload.max_output_tokens, 400);
      return {
        ok: true, async json() { return {
          id:'response-123',status:'completed',output_text:'OK',
          usage: {input_tokens:11, output_tokens:2, input_tokens_details:{cached_tokens:3}},
        }; },
      };
    },
  });
  assert.deepEqual(await adapter(model, ctx.requestKey), {
    data: 'OK', providerRequestId:'response-123',
    usage: { inputTokens: 11, cachedInputTokens: 3, outputTokens: 2 },
  });
  assert.equal(requests, 1);
  await assert.rejects(adapter({...model,provider:'other'},ctx.requestKey), /SC021_OPENAI_INVALID_ROUTE/);
  assert.equal(requests, 1);
});

test('OpenAI adapter rejects absent server secret and exposes unknown usage without forged zero-cost', async () => {
  assert.throws(() => createOpenAiResponsesAdapter({
    apiKey:'',input:[],maxOutputTokens:400,parseResult:()=>null,
  }), /SC021_OPENAI_CONFIGURATION_MISSING/);
  const adapter = createOpenAiResponsesAdapter({
    apiKey:'test-only',input:[],maxOutputTokens:100,parseResult:()=>'OK',
    fetchImpl:async()=>({ok:true,json:async()=>({
      id:'resp', status:'completed', usage:{input_tokens:10,output_tokens:1,input_tokens_details:{cached_tokens:11}},
    })}),
  });
  assert.equal((await adapter(model,ctx.requestKey)).usage,null);
  const refused = createOpenAiResponsesAdapter({
    apiKey:'test-only',input:[],maxOutputTokens:100,parseResult:()=>'NEVER',
    fetchImpl:async()=>({ok:false,status:429}),
  });
  await assert.rejects(refused(model,ctx.requestKey), /SC021_OPENAI_PROVIDER_ERROR/);
});


test('SC-021-D cost report groups by tenant, task, process and pseudonym without inventing settled cost', () => {
  const base = {
    companyId:ctx.companyId,billingMonth:'2026-10',task:'cv_screening',
    processId:ctx.operationId,candidatePseudonym:'candidate_123',
    status:'settled',reservedMicroUsd:500,actualMicroUsd:405,
    inputTokens:1000,cachedInputTokens:200,outputTokens:100,
  };
  const report = summarizeAiCosts(ctx.companyId,'2026-10',[
    base,{...base,status:'unknown',actualMicroUsd:null,reservedMicroUsd:800,
      inputTokens:null,cachedInputTokens:null,outputTokens:null},
    {...base,status:'reserved',actualMicroUsd:null,reservedMicroUsd:100,
      inputTokens:null,cachedInputTokens:null,outputTokens:null},
    {...base,status:'released',actualMicroUsd:null,reservedMicroUsd:400,
      inputTokens:null,cachedInputTokens:null,outputTokens:null},
  ]);
  assert.equal(report.total.attempts,4);
  assert.equal(report.total.settledMicroUsd,405);
  assert.equal(report.total.unconfirmedMicroUsd,900);
  assert.equal(report.total.unknownAttempts,1);
  assert.equal(report.total.inputTokens,1000);
  assert.equal(report.byTask.cv_screening.settledMicroUsd,405);
  assert.equal(report.byProcess[ctx.operationId].attempts,4);
  assert.equal(report.byCandidate.candidate_123.attempts,4);
  assert.throws(()=>summarizeAiCosts(ctx.companyId,'2026-10',[
    {...base,companyId:'99999999-9999-4999-8999-999999999999'},
  ]),/SC021_REPORT_SCOPE_MISMATCH/);
  assert.throws(()=>summarizeAiCosts(ctx.companyId,'2026-10',[
    {...base,actualMicroUsd:null},
  ]),/SC021_INVALID_REPORT_ROW/);
});


test('Codex P1: correlation ID is always the persisted request key', async () => {
  const f = store();
  let received = '';
  const result = await runMeteredOperation({
    context: ctx, policy, maxExpectedUsage: usage, ledger: f.ledger,
    invoke: async (_rate, correlationId) => {
      received = correlationId;
      return { data: 'ok', usage, providerRequestId: null };
    },
  });
  assert.equal(received, ctx.requestKey);
  assert.equal(result.correlationId, ctx.requestKey);
  assert.equal(f.calls.reservations[0].requestKey, ctx.requestKey);
  const g = store();
  await assert.rejects(runMeteredOperation({
    context: ctx, policy, maxExpectedUsage: usage, ledger: g.ledger,
    correlationId: '44444444-4444-4444-8444-444444444444',
    invoke: async () => { throw new Error('provider should never run'); },
  }), /SC021_INVALID_CONTEXT/);
  assert.equal(g.calls.reservations.length, 0);
});

test('Codex P2: uncertain settlement or invalid priced response is marked unknown', async () => {
  for (const cause of ['settle-throws', 'usage-overflow']) {
    const f = store();
    if (cause === 'settle-throws') {
      f.ledger.settle = async () => { throw new Error('SC021_SETTLEMENT_UNAVAILABLE'); };
    }
    const consumed = cause === 'usage-overflow'
      ? { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER }
      : usage;
    await assert.rejects(runMeteredOperation({
      context: ctx, policy, maxExpectedUsage: usage, ledger: f.ledger,
      invoke: async () => ({ data: 'do not leak', usage: consumed, providerRequestId: null }),
    }), new RegExp(cause === 'usage-overflow' ? 'SC021_COST_OVERFLOW' : 'SC021_SETTLEMENT_UNAVAILABLE'));
    assert.equal(f.calls.unknown.length, 1);
    assert.equal(f.calls.unknown[0].requestKey, ctx.requestKey);
  }
});

test('Codex P2: contribution margin rejects subtraction outside safe integer range', () => {
  assert.throws(() => packageMargin({
    revenueNetPlnGrosze: 0,
    aiCostPlnGrosze: Number.MAX_SAFE_INTEGER,
    voiceAndTelephonyPlnGrosze: Number.MAX_SAFE_INTEGER,
    otherVariablePlnGrosze: Number.MAX_SAFE_INTEGER,
  }), /SC021_COST_OVERFLOW/);
});

test('Codex P2: null candidate aggregation never collides with legitimate unassigned pseudonym', () => {
  const base = {
    companyId: ctx.companyId, billingMonth: '2026-10', task: 'cv_screening',
    processId: null, candidatePseudonym: null, status: 'settled',
    reservedMicroUsd: 5, actualMicroUsd: 5,
    inputTokens: 1, cachedInputTokens: 0, outputTokens: 2,
  };
  const report = summarizeAiCosts(ctx.companyId, '2026-10', [
    base, { ...base, candidatePseudonym: 'unassigned' },
  ]);
  assert.equal(report.total.attempts, 2);
  assert.equal(report.byCandidate['unassigned'].attempts, 1);
  assert.equal(report.byCandidate['\u0000no-candidate'].attempts, 1);
});

test('SC-021 margin percentage uses exact basis point arithmetic and rejects overflow', () => {
  assert.deepEqual(packageMargin({
    revenueNetPlnGrosze: 3, aiCostPlnGrosze: 1,
    voiceAndTelephonyPlnGrosze: 0, otherVariablePlnGrosze: 0,
  }), { known: true, marginPlnGrosze: 2, marginPercent: 66.67 });
  assert.deepEqual(packageMargin({
    revenueNetPlnGrosze: 3, aiCostPlnGrosze: 4,
    voiceAndTelephonyPlnGrosze: 0, otherVariablePlnGrosze: 0,
  }), { known: true, marginPlnGrosze: -1, marginPercent: -33.33 });
  assert.deepEqual(packageMargin({
    revenueNetPlnGrosze: 0, aiCostPlnGrosze: 0,
    voiceAndTelephonyPlnGrosze: 0, otherVariablePlnGrosze: 0,
  }), { known: true, marginPlnGrosze: 0, marginPercent: null });
  assert.throws(() => packageMargin({
    revenueNetPlnGrosze: 1, aiCostPlnGrosze: Number.MAX_SAFE_INTEGER,
    voiceAndTelephonyPlnGrosze: 0, otherVariablePlnGrosze: 0,
  }), /SC021_COST_OVERFLOW/);
});
