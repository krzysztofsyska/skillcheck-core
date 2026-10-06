import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { loadWorkFromClients, reconcile, reconcileFromEnv } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { contractBody, loadedPolicy, observation } from './helpers.mjs';

function armedItem() {
  const obs = observation();
  obs.simulation = true;
  obs.flags = { enabled: true, mergeEnabled: false };
  obs.secrets = { cursor: true, openai: false, githubApp: false };
  let record = plan(null, obs).record;
  record = plan(record, obs).record;
  assert.equal(record.binding.dispatch.phase, 'armed');
  return { record, observation: obs };
}

test('configured reconcile invokes the controller through substituted adapters', async () => {
  const { policy } = loadedPolicy();
  const executed = [];
  const result = await reconcile({
    flags: { enabled: true, mergeEnabled: false },
    configuration: { ok: true, missing: [], mode: 'live' },
    policy,
    journal: { async save() {} },
    loadWork: async () => ({ items: [armedItem()] }),
    ports: {
      async readProtection() { return null; },
      async execute(effect) {
        executed.push(effect.type);
        if (effect.payload && Object.prototype.hasOwnProperty.call(effect.payload, 'envVars')) throw new Error('envVars forbidden');
        return { agent: { id: effect.agentId }, run: { id: 'run-1', status: 'CREATING' } };
      },
    },
  });
  assert.equal(result.status, 'RECONCILED');
  assert.equal(result.controllerInvoked, true);
  assert.deepEqual(executed, ['cursor.create']);
  assert.deepEqual(result.effects, ['cursor.create']);
  assert.equal(result.results[0].record.state, 'BUILDING');
});

test('missing configuration blocks effects before the controller', async () => {
  let executed = 0;
  let loaded = 0;
  const result = await reconcile({
    flags: { enabled: true, mergeEnabled: true },
    configuration: { ok: false, missing: ['CURSOR_API_KEY'], mode: 'live' },
    policy: loadedPolicy().policy,
    journal: { async save() {} },
    loadWork: async () => { loaded += 1; return { items: [armedItem()] }; },
    ports: {
      async readProtection() { throw new Error('protection read must not run'); },
      async execute() { executed += 1; },
    },
  });
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.equal(result.controllerInvoked, false);
  assert.deepEqual(result.effects, []);
  assert.equal(executed, 0);
  assert.equal(loaded, 0);
});

test('disabled flags invoke the controller and prevent effects', async () => {
  const executed = [];
  const result = await reconcile({
    flags: { enabled: false, mergeEnabled: false },
    configuration: { ok: true, missing: [], mode: 'read-only' },
    policy: loadedPolicy().policy,
    journal: { async save() {} },
    loadWork: async () => ({ items: [armedItem()] }),
    ports: {
      async readProtection() { return null; },
      async execute(effect) { executed.push(effect.type); return {}; },
    },
  });
  assert.equal(result.status, 'READ_ONLY');
  assert.equal(result.controllerInvoked, true);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(executed, []);
  assert.equal(result.flags.enabled, false);
  assert.equal(result.flags.mergeEnabled, false);
  assert.equal(result.results[0].record.binding.suppressed.at(-1).reason, 'PIPELINE_DISABLED');
});

test('reconcileFromEnv does not call the network without configuration', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('network');
  };
  try {
    const missing = await reconcileFromEnv({
      AGENT_PIPELINE_ENABLED: 'true',
      AGENT_PIPELINE_MERGE_ENABLED: 'false',
    });
    assert.equal(missing.status, 'NOT_CONFIGURED');
    assert.equal(missing.controllerInvoked, false);
    assert.deepEqual(missing.effects, []);
    assert.equal(missing.missing.includes('CURSOR_API_KEY'), true);
    const disabled = await reconcileFromEnv({
      AGENT_PIPELINE_ENABLED: 'false',
      AGENT_PIPELINE_MERGE_ENABLED: 'false',
    });
    assert.equal(disabled.status, 'READ_ONLY');
    assert.deepEqual(disabled.effects, []);
    assert.equal(disabled.controllerInvoked, false);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a configured state read reaches the controller without another adapter', async () => {
  const { policy } = loadedPolicy();
  const executed = [];
  const work = await loadWorkFromClients({
    policy,
    now: '2026-10-06T12:00:00.000Z',
    secrets: { cursor: true, openai: false, githubApp: true },
    github: {
      async readBranch(name) {
        return { commit: { sha: name === 'main' ? 'd'.repeat(40) : 'c'.repeat(40) } };
      },
      async readIssues() {
        return [{ number: 7, body: contractBody(), user: { id: policy.owner.id, login: policy.owner.login } }];
      },
      async readPulls() { return []; },
      async readProjection() { return { tasks: {}, mergeLock: null, head: null }; },
      async readProtection() { return null; },
      async listWorkflowRuns() { return []; },
      async listArtifacts() { return []; },
      async readJobs() { return []; },
      async readApprovals() { return []; },
    },
  });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].record, null);
  assert.equal(work.items[0].observation.issue.authorId, policy.owner.id);
  const result = await reconcile({
    flags: { enabled: true, mergeEnabled: false },
    configuration: { ok: true, missing: [], mode: 'live', hasApp: true, hasToken: true },
    policy,
    journal: { async save() {} },
    loadWork: async () => work,
    ports: {
      async readProtection() { return null; },
      async execute(effect) {
        executed.push(effect.type);
        return { agent: { id: effect.agentId }, run: { id: 'run-1', status: 'CREATING' } };
      },
    },
  });
  assert.equal(result.controllerInvoked, true);
  assert.equal(result.status, 'RECONCILED');
  assert.equal(result.results[0].record.state, 'READY');
  assert.equal(result.results[0].record.technical_state, 'DISPATCH_PENDING');
  assert.deepEqual(executed, []);
});

test('the reconcile CLI blocks effects when flags are off or configuration is missing', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const disabled = spawnSync(process.execPath, ['tools/agent-pipeline/cli.mjs', 'reconcile'], {
    env: { ...env, AGENT_PIPELINE_ENABLED: 'false', AGENT_PIPELINE_MERGE_ENABLED: 'false' },
    encoding: 'utf8',
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  const disabledBody = JSON.parse(disabled.stdout);
  assert.equal(disabledBody.status, 'READ_ONLY');
  assert.equal(disabledBody.controllerInvoked, false);
  assert.deepEqual(disabledBody.effects, []);
  const live = spawnSync(process.execPath, ['tools/agent-pipeline/cli.mjs', 'reconcile'], {
    env: { ...env, AGENT_PIPELINE_ENABLED: 'true', AGENT_PIPELINE_MERGE_ENABLED: 'false' },
    encoding: 'utf8',
  });
  assert.equal(live.status, 1, live.stdout);
  const liveBody = JSON.parse(live.stdout);
  assert.equal(liveBody.status, 'NOT_CONFIGURED');
  assert.equal(liveBody.controllerInvoked, false);
  assert.deepEqual(liveBody.effects, []);
});
