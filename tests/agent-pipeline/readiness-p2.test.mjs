import test from 'node:test';
import assert from 'node:assert/strict';
import { tick, guardEffects } from '../../tools/agent-pipeline/lib/controller.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';
import { evaluatePreflight } from '../../tools/agent-pipeline/lib/merge.mjs';
import { reconcileFromEnv } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { observation, taskRecord } from './helpers.mjs';
import { configuredPolicy, protectionFixtures, httpWorld } from './http-world.mjs';

// Offline regressions for PR41 findings 4302627260 and 4302627263.
// Real decision/controller modules; only journal/transport effects are synthetic.
function fixture() {
  const policy = configuredPolicy();
  return { policy, ...protectionFixtures(policy) };
}
function preflight(f) {
  return evaluatePreflight(protectionFromRulesets(f.rules, f.policy, f.environments));
}
function armed() {
  const obs = observation({ flags: { enabled: true, mergeEnabled: false } });
  let record = plan(null, obs).record;
  record = plan(record, obs).record;
  assert.equal(record.binding.dispatch.phase, 'armed');
  obs.simulation = false;
  obs.preflight = { ok: false, reason: 'ENVIRONMENTS_UNCONFIRMED' };
  return { record, obs };
}
function portsAndJournal() {
  const calls = [], saves = [];
  return {
    calls, saves,
    journal: { async save(record) { saves.push(structuredClone(record)); } },
    ports: { async execute(effect) {
      calls.push(effect.type);
      return { agent: { id: effect.agentId }, run: { id: 'run-1', status: 'CREATING' } };
    } },
  };
}

const forbiddenRules = [
  [{ type: 'required_reviewers', reviewers: [] }],
  [{ type: 'wait_timer', wait_timer: 30 }],
  [{ type: 'branch_policy' }, { type: 'required_reviewers', reviewers: [] }],
  [{ type: 'branch_policy' }, { type: 'wait_timer', wait_timer: 1 }],
  [{ type: 'custom_deployment_protection_rule' }],
  [null], [{}], ['branch_policy'], null, undefined, {},
];

test('unattended review allows empty evidence or the documented branch_policy rule, never an approval gate', () => {
  for (const protection_rules of [[], [{ id: 17, type: 'branch_policy' }]]) {
    const f = fixture();
    f.environments['agent-review'].protection_rules = protection_rules;
    assert.equal(preflight(f).ok, true);
    const e = f.environments['agent-review'];
    e.branch_policies = [{ name: 'integration', type: 'branch' }];
    assert.equal(preflight(f).ok, false, 'branch_policy metadata does not replace the exact main restriction');
  }
});

test('reviewer, timer, unknown and missing protection-rule evidence block paid effects', () => {
  for (const protection_rules of forbiddenRules) {
    const f = fixture();
    f.environments['agent-review'].protection_rules = protection_rules;
    const proof = preflight(f);
    assert.equal(proof.ok, false, JSON.stringify(protection_rules));
    const guarded = guardEffects([{ type: 'github.dispatch', workflow: 'review', external: true }], {
      simulation: false, flags: { enabled: true, mergeEnabled: true }, preflight: proof,
    });
    assert.deepEqual(guarded.allowed, []);
  }
});

test('unattended review does not remove owner review from the separate approval environments', () => {
  for (const name of ['owner-acceptance', 'production-approval']) {
    const f = fixture();
    assert.equal(preflight(f).ok, true);
    f.environments[name].protection_rules = [{ type: 'branch_policy' }];
    assert.equal(preflight(f).ok, false, name);
  }
});

test('default HTTP adapters reject blocking review rules before any agent creation or dispatch', async () => {
  const previous = globalThis.fetch;
  try {
    for (const protection_rules of forbiddenRules.slice(0, 5)) {
      const world = httpWorld();
      world.protection.environments['agent-review'].protection_rules = protection_rules;
      globalThis.fetch = world.fetch;
      for (let i = 0; i < 6; i++) {
        const result = await reconcileFromEnv(world.env, { policy: world.policy });
        assert.equal(result.preflight.ok, false);
        assert.deepEqual(result.effects, []);
      }
      assert.ok(world.calls.some(c => c.url.endsWith('/environments/agent-review')));
      assert.deepEqual(world.calls.filter(c => c.method === 'POST' &&
        (c.url.startsWith('https://api.cursor.com/') || c.url.includes('/dispatches'))), []);
      assert.equal(world.mergeCount, 0);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test('1000 five-minute denials across serialized restarts persist one suppression and preserve the reservation', async () => {
  let { record, obs } = armed();
  const initial = structuredClone(record), io = portsAndJournal();
  let serialized;
  for (let i = 0; i < 1000; i++) {
    obs.now = new Date(Date.parse('2026-10-06T12:00:00Z') + i * 300000).toISOString();
    const result = await tick({ record, observation: obs, journal: io.journal, ports: io.ports });
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.executed, []);
    assert.equal(result.suppressed[0].type, 'cursor.create');
    const current = JSON.stringify(result.record);
    if (i === 0) serialized = current;
    else assert.equal(current, serialized, 'no timestamp/history growth on an identical denial');
    record = JSON.parse(current);
  }
  assert.equal(io.saves.length, 1);
  assert.deepEqual(io.calls, []);
  assert.equal(record.binding.suppressed.length, 1);
  assert.deepEqual(record.binding.dispatch, initial.binding.dispatch);
  assert.equal(record.state_revision, initial.state_revision);
  assert.equal(record.last_transition_at, initial.last_transition_at);
  assert.match(record.binding.suppressed[0].effect_key, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(record.binding.suppressed[0]).sort(), ['at', 'effect_key', 'reason', 'type']);
});

test('a later confirmed preflight executes the preserved intent once, not once per past denial', async () => {
  let { record, obs } = armed();
  const io = portsAndJournal();
  for (let i = 0; i < 20; i++) {
    const result = await tick({ record, observation: obs, journal: io.journal, ports: io.ports });
    record = JSON.parse(JSON.stringify(result.record));
  }
  obs.preflight = { ok: true };
  const resumed = await tick({ record, observation: obs, journal: io.journal, ports: io.ports });
  assert.equal(resumed.record.state, 'BUILDING');
  assert.deepEqual(io.calls, ['cursor.create']);
  await tick({ record: resumed.record, observation: obs, journal: io.journal, ports: io.ports });
  assert.deepEqual(io.calls, ['cursor.create']);
});

test('distinct pending effects keep distinct evidence while legacy entries are preserved', async () => {
  let { record, obs } = armed();
  const legacy = { type: 'cursor.create', reason: 'SUPPRESSED', at: '2026-10-01T00:00:00Z' };
  record.binding.suppressed.push(legacy);
  const io = portsAndJournal();
  record = (await tick({ record, observation: obs, journal: io.journal, ports: io.ports })).record;
  const firstKey = record.binding.suppressed.at(-1).effect_key;
  assert.equal(record.binding.suppressed.length, 2);
  // A synthetic lost-response reservation requires a different external read,
  // not another create. Both remain suppressed until protection is confirmed.
  record.binding.dispatch.phase = 'awaiting_confirmation';
  record = (await tick({ record, observation: obs, journal: io.journal, ports: io.ports })).record;
  assert.equal(record.binding.suppressed.length, 3);
  assert.equal(record.binding.suppressed.at(-1).type, 'cursor.get');
  assert.notEqual(record.binding.suppressed.at(-1).effect_key, firstKey);
  const bytes = JSON.stringify(record);
  const repeat = await tick({ record: JSON.parse(bytes), observation: obs, journal: io.journal, ports: io.ports });
  assert.equal(JSON.stringify(repeat.record), bytes);
  assert.deepEqual(repeat.record.binding.suppressed[0], legacy);
  assert.equal(io.saves.length, 2);
  assert.deepEqual(io.calls, []);
});

test('repeated workflow-dispatch suppression does not grow records or invent a dispatched request', async () => {
  const obs = observation({ simulation: false, flags: { enabled: true, mergeEnabled: false }, preflight: { ok: false } });
  let record = taskRecord({ state: 'PR_REVIEW', technical_state: 'WAITING_CI' });
  const io = portsAndJournal();
  let bytes;
  for (let i = 0; i < 100; i++) {
    obs.now = new Date(Date.parse('2026-10-06T12:00:00Z') + i * 300000).toISOString();
    const result = await tick({ record, observation: obs, journal: io.journal, ports: io.ports });
    assert.equal(result.suppressed[0].type, 'github.dispatch');
    assert.equal(result.suppressed[0].workflow, 'verify');
    assert.equal(result.record.review_request_id, null);
    const current = JSON.stringify(result.record);
    if (i === 0) bytes = current;
    else assert.equal(current, bytes);
    record = JSON.parse(current);
  }
  assert.equal(io.saves.length, 1);
  assert.deepEqual(io.calls, []);
});
