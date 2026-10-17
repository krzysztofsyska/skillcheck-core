import test from 'node:test';
import assert from 'node:assert/strict';
import { guardEffects } from '../../tools/agent-pipeline/lib/controller.mjs';
import { reconcile, reconcileFromEnv } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';
import { evaluatePreflight } from '../../tools/agent-pipeline/lib/merge.mjs';
import { observation, loadedPolicy } from './helpers.mjs';
import { configuredPolicy, protectionFixtures, httpWorld } from './http-world.mjs';

// Offline unit/adapter regressions. HTTP boundary is mocked; no provider calls.
const external = [
  { type: 'cursor.create', external: true },
  { type: 'cursor.followup', external: true },
  { type: 'github.dispatch', workflow: 'review', external: true },
  { type: 'github.dispatch', workflow: 'verify', external: true },
  { type: 'github.createPr', external: true },
  { type: 'github.merge', external: true },
];
const live = { simulation: false, flags: { enabled: true, mergeEnabled: true } };
function confirmedProtection() {
  const policy = configuredPolicy();
  const fixture = protectionFixtures(policy);
  return protectionFromRulesets(fixture.rules, policy, fixture.environments);
}
function armedItem() {
  const obs = observation();
  obs.flags = { enabled: true, mergeEnabled: false };
  let record = plan(null, obs).record;
  record = plan(record, obs).record;
  assert.equal(record.binding.dispatch.phase, 'armed');
  // These potentially stale fields must not override the fresh trusted read.
  obs.preflight = { ok: true };
  obs.github.protection = confirmedProtection();
  return { record, observation: obs };
}

test('all external effects including paid review need a positive protection preflight', () => {
  for (const preflight of [undefined, null, {}, { ok: false }, { ok: 'true' }, { ok: 1 }]) {
    const decision = guardEffects(external, { ...live, preflight });
    assert.deepEqual(decision.allowed, []);
    assert.deepEqual(decision.suppressed, external);
  }
});

test('a valid preflight is necessary but cannot override either activation switch', () => {
  assert.deepEqual(guardEffects(external, { ...live, preflight: { ok: true } }).allowed, external);
  const disabled = guardEffects(external, { ...live, preflight: { ok: true }, flags: { enabled: false, mergeEnabled: true } });
  assert.deepEqual(disabled.allowed, []);
  const noMerge = guardEffects(external, { ...live, preflight: { ok: true }, flags: { enabled: true, mergeEnabled: false } });
  assert.equal(noMerge.allowed.some(e => e.type === 'github.merge'), false);
  assert.equal(noMerge.allowed.some(e => e.workflow === 'review'), true);
});

test('offline simulations and internal reports remain separate from LIVE permission', () => {
  const report = { type: 'report', external: false };
  assert.deepEqual(guardEffects([report, ...external], { ...live, preflight: { ok: false } }).allowed, [report]);
  const simulated = guardEffects(external, { simulation: true, flags: { enabled: false, mergeEnabled: false } });
  assert.equal(simulated.allowed.some(e => e.workflow === 'review'), true);
  assert.equal(simulated.allowed.some(e => e.type === 'github.merge'), false);
});

test('environment drift and unpinned status sources suppress paid dispatch, not just merge', () => {
  for (const patch of [{ environmentsConfirmed: false }, { requiredChecksPinnedToApp: false },
    { integrationProtected: false }, { exclusiveWritersConfirmed: false }]) {
    const preflight = evaluatePreflight({ ...confirmedProtection(), ...patch });
    assert.equal(preflight.ok, false);
    assert.deepEqual(guardEffects(external, { ...live, preflight }).allowed, []);
  }
});

test('reconcile ignores stale positive evidence and preserves an armed task for a verified retry', async () => {
  let protection = null;
  const calls = [];
  const item = armedItem();
  const before = structuredClone(item.record.binding.dispatch);
  const args = {
    flags: { enabled: true, mergeEnabled: false },
    configuration: { ok: true, missing: [], mode: 'live' },
    policy: loadedPolicy().policy,
    journal: { async save() {} },
    loadWork: async () => ({ items: [item] }),
    ports: {
      async readProtection() { return protection; },
      async execute(effect) {
        calls.push(effect.type);
        return { agent: { id: effect.agentId }, run: { id: 'run-1', status: 'CREATING' } };
      },
    },
  };
  const blocked = await reconcile(args);
  assert.equal(blocked.preflight.ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(blocked.effects, []);
  assert.deepEqual(blocked.results[0].record.binding.dispatch, before);
  item.record = blocked.results[0].record;
  protection = confirmedProtection();
  const resumed = await reconcile(args);
  assert.equal(resumed.preflight.ok, true);
  assert.deepEqual(calls, ['cursor.create']);
  assert.equal(resumed.results[0].record.state, 'BUILDING');
});

test('a failed trusted read aborts before any controller effect', async () => {
  let calls = 0;
  await assert.rejects(reconcile({
    flags: { enabled: true, mergeEnabled: false },
    configuration: { ok: true, missing: [] },
    policy: loadedPolicy().policy,
    journal: { async save() {} },
    loadWork: async () => ({ items: [armedItem()] }),
    ports: {
      async readProtection() { throw new Error('trusted protection timeout'); },
      async execute() { calls++; },
    },
  }), /trusted protection timeout/);
  assert.equal(calls, 0);
});

test('real adapters do not create agents or dispatch workflows after review-environment 403, 404 or drift', async () => {
  const previous = globalThis.fetch;
  try {
    for (const failure of ['403', '404', 'wrong-id', 'extra-branch']) {
      const world = httpWorld();
      let environmentReads = 0;
      globalThis.fetch = async (url, options) => {
        const target = new URL(String(url));
        if (target.pathname.includes('/environments/agent-review')) {
          environmentReads++;
          if (failure === '403' || failure === '404')
            return new Response(JSON.stringify({ message: 'fixture environment unavailable' }), { status: Number(failure) });
          const response = await world.fetch(url, options);
          const data = await response.json();
          if (failure === 'wrong-id' && target.pathname.endsWith('/agent-review')) data.id++;
          if (failure === 'extra-branch' && target.pathname.endsWith('/deployment-branch-policies'))
            data.branch_policies.push({ name: 'integration', type: 'branch' });
          return new Response(JSON.stringify(data), { status: response.status });
        }
        return world.fetch(url, options);
      };
      // Run enough controller iterations to get beyond task registration/arming.
      for (let i = 0; i < 5; i++) {
        const result = await reconcileFromEnv(world.env, { policy: world.policy });
        assert.equal(result.preflight.ok, false, failure);
        assert.deepEqual(result.effects, [], failure);
      }
      assert.ok(environmentReads > 0, failure);
      const paid = world.calls.filter(c => c.method === 'POST' &&
        (c.url.startsWith('https://api.cursor.com/') || c.url.includes('/dispatches')));
      assert.deepEqual(paid, [], failure);
      assert.equal(world.mergeCount, 0, failure);
    }
  } finally {
    globalThis.fetch = previous;
  }
});
