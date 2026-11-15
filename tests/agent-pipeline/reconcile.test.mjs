import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { defaultPorts, loadWorkFromClients, reconcile, reconcileFromEnv } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { contractBody, loadedPolicy, observation, taskRecord, HEAD, BASE } from './helpers.mjs';
import { createGitHubClient } from '../../tools/agent-pipeline/lib/github.mjs';
import { configuredPolicy, protectionFixtures } from './http-world.mjs';
import { protectionFromRulesets } from '../../tools/agent-pipeline/lib/protection.mjs';

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

test('configured reconcile invokes the controller only with confirmed protection', async () => {
  const { policy } = loadedPolicy();
  const fixturePolicy = configuredPolicy();
  const fixture = protectionFixtures(fixturePolicy);
  const verifiedProtection = protectionFromRulesets(fixture.rules, fixturePolicy, fixture.environments);
  const executed = [];
  const result = await reconcile({
    flags: { enabled: true, mergeEnabled: false },
    configuration: { ok: true, missing: [], mode: 'live' },
    policy,
    journal: { async save() {} },
    loadWork: async () => ({ items: [armedItem()] }),
    ports: {
      async readProtection() { return verifiedProtection; },
      async execute(effect) {
        executed.push(effect.type);
        if (effect.payload && Object.prototype.hasOwnProperty.call(effect.payload, 'envVars')) throw new Error('envVars forbidden');
        return { agent: { id: effect.agentId }, run: { id: 'run-1', status: 'CREATING' } };
      },
    },
  });
  assert.equal(result.status, 'RECONCILED');
  assert.equal(result.preflight.ok, true);
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('disabled reconciliation treats hidden bypass actors as unknown protection', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/rulesets')) return jsonResponse([{ id: 1 }]);
    if (path.endsWith('/rulesets/1')) return jsonResponse({ id: 1, enforcement: 'active', target: 'branch', rules: [{ type: 'deletion' }] });
    throw new Error(`unexpected ${path}`);
  };
  try {
    const ports = await defaultPorts(
      { GITHUB_TOKEN: 'metadata-only', GITHUB_REPOSITORY: 'krzysztofsyska/skillcheck-core' },
      { repository: 'krzysztofsyska/skillcheck-core', environments: {} },
      { ok: true },
      { enabled: false, mergeEnabled: false },
    );
    assert.equal(await ports.readProtection(), null);
    await assert.rejects(ports.execute({ type: 'cursor.create' }), /effects are blocked/);
  } finally { globalThis.fetch = previous; }
});

test('work loading treats hidden bypass actors as unknown protection', async () => {
  const { policy } = loadedPolicy();
  const github = {
    async readBranch(name) {
      return { commit: { sha: name === 'main' ? 'd'.repeat(40) : 'c'.repeat(40) } };
    },
    async readIssues() {
      return [{ number: 7, body: contractBody(), user: { id: policy.owner.id, login: policy.owner.login } }];
    },
    async readPulls() { return []; },
    async readProjection() { return { tasks: {}, mergeLock: null, head: null }; },
    async readProtection() { throw new Error('RULESET_BYPASS_UNVERIFIABLE'); },
    async listWorkflowRuns() { return []; },
    async listArtifacts() { return []; },
    async readJobs() { return []; },
    async readApprovals() { return []; },
  };
  const work = await loadWorkFromClients({
    policy, now: '2026-10-06T12:00:00.000Z', secrets: { cursor: true, openai: false, githubApp: true }, github,
  });
  assert.equal(work.items[0].observation.github.protection, null);
  github.readProtection = async () => { const error = new Error('boom'); error.status = 500; throw error; };
  await assert.rejects(loadWorkFromClients({
    policy, now: '2026-10-06T12:00:00.000Z', secrets: { cursor: true, openai: false, githubApp: true }, github,
  }), /boom/);
});

test('live protection read still fails when bypass actors are hidden', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/access_tokens')) {
      const requested = JSON.parse(init.body);
      return jsonResponse({ token: 'scoped', repository_selection: 'selected', repositories: [{ id: requested.repository_ids[0] }],
        permissions: { metadata: 'read', ...requested.permissions } });
    }
    if (path.endsWith('/rulesets')) return jsonResponse([{ id: 1 }]);
    if (path.endsWith('/rulesets/1')) return jsonResponse({ id: 1, enforcement: 'active', target: 'branch', rules: [{ type: 'deletion' }] });
    throw new Error(`unexpected ${path}`);
  };
  try {
    const ports = await defaultPorts({
      GITHUB_REPOSITORY: 'krzysztofsyska/skillcheck-core',
      AGENT_PIPELINE_APP_ID: '1', AGENT_PIPELINE_APP_INSTALLATION_ID: '2',
      AGENT_PIPELINE_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      CURSOR_API_KEY: 'cursor',
    }, { repository: 'krzysztofsyska/skillcheck-core', repository_id: 1043384454, environments: {}, cursor_api_base: 'https://api.cursor.com' },
    { ok: true }, { enabled: true, mergeEnabled: false });
    await assert.rejects(ports.readProtection(), /RULESET_BYPASS_UNVERIFIABLE/);
  } finally { globalThis.fetch = previous; }
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
    assert.equal(missing.missing.includes('SUBSCRIPTION_CLAUDE_WORKFLOW_UNCONFIGURED'), true);
    assert.equal(missing.missing.includes('SUBSCRIPTION_OAUTH_BUDGET_ADAPTER_NOT_WIRED'), true);
    assert.equal(missing.missing.includes('SUBSCRIPTION_INDEPENDENT_REVIEW_NOT_WIRED'), true);
    assert.equal(missing.missing.includes('CURSOR_API_KEY'), false);
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

test('subscription work loader injects authenticated Codex evidence and keeps failed reads fail-closed', async () => {
  const { policy } = loadedPolicy();
  policy.execution_mode = 'SUBSCRIPTION_ONLY';
  policy.builder_provider = 'claude-code';
  const record = taskRecord({ state: 'PR_REVIEW', review_request_id: 'e'.repeat(64) });
  const comments = [{ id: 18, user: { id: 199175422, login: 'chatgpt-codex-connector[bot]' },
    body: '<!-- codex-pull-request-review-summary -->\\n<!-- codex-review-state:v1 {} -->' }];
  const threads = [{ id: 'PRRT_1', isResolved: false, comments: [
    { body: 'Guard against stale head', author: { login: 'chatgpt-codex-connector' }, path: 'lib/a.mjs', line: 7 },
  ] }];
  let reads = 0;
  let fail = false;
  const github = {
    async readBranch(name) { return { commit: { sha: name === 'main' ? 'f'.repeat(40) : name === 'integration' ? BASE : 'd'.repeat(40) } }; },
    async readIssues() { return [{ number: 7, body: contractBody(), user: { id: policy.owner.id, login: policy.owner.login } }]; },
    async readIssue() { return { number: 7, body: contractBody(), user: { id: policy.owner.id, login: policy.owner.login } }; },
    async readPulls() { return []; },
    async readPull() { return { number: 50, user: { id: policy.owner.id },
      head: { ref: record.binding.branch, sha: HEAD, repo: { id: policy.repository_id } },
      base: { ref: 'integration', sha: BASE, repo: { id: policy.repository_id } } }; },
    async readProjection() { return { tasks: { [record.task_id]: record } }; },
    async readProtection() { return null; },
    async readChangedFiles() { return []; },
    async listWorkflowRuns() { return []; },
    async readComments(n) { reads++; assert.equal(n, 50); return comments; },
    async readReviewThreads(n, options) {
      reads++; assert.equal(n, 50); assert.deepEqual(options, { includeComments: true });
      if (fail) throw new Error('READ_FORBIDDEN');
      return threads;
    },
  };
  const load = () => loadWorkFromClients({ policy, github, secrets: {}, now: '2026-10-06T12:00:00.000Z' });
  const good = await load();
  assert.equal(good.items.length, 1);
  assert.deepEqual(good.items[0].observation.github.codexReview, { comments, threads });
  assert.equal(reads, 2);
  fail = true;
  const denied = await load();
  assert.deepEqual(denied.items[0].observation.github.codexReview.comments, null);
  assert.deepEqual(denied.items[0].observation.github.codexReview.threads, null);
  assert.equal(denied.items[0].observation.github.codexReview.readError, 'READ_FORBIDDEN');
  policy.execution_mode = 'LEGACY';
  reads = 0;
  const legacy = await load();
  assert.equal(legacy.items[0].observation.github.codexReview, null);
  assert.equal(reads, 0);
});

test('subscription thread reader returns Codex finding text and rejects truncated comments', async () => {
  let incomplete = false;
  const fetchMock = async (url, init) => {
    assert.match(String(url), /\\/graphql$/);
    assert.equal(init.method, 'POST');
    assert.match(JSON.parse(init.body).query, /comments\\(first:100\\)/);
    return jsonResponse({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: 'PRRT_1', isResolved: false, isOutdated: false,
        comments: { pageInfo: { hasNextPage: incomplete }, nodes: [
          { body: 'Fix stale SHA', path: 'a.mjs', line: 11, author: { login: 'chatgpt-codex-connector' } },
        ] } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } } });
  };
  const gh = createGitHubClient({ fetch: fetchMock, token: 'fixture', repository: 'o/r' });
  const threads = await gh.readReviewThreads(50, { includeComments: true });
  assert.equal(threads[0].comments[0].body, 'Fix stale SHA');
  assert.equal(threads[0].comments[0].line, 11);
  incomplete = true;
  await assert.rejects(gh.readReviewThreads(50, { includeComments: true }), /REVIEW_THREAD_COMMENTS_INCOMPLETE/);
});
