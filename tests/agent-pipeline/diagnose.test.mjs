import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { diagnose } from '../../tools/agent-pipeline/diagnose.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const root = '/repos/krzysztofsyska/skillcheck-core';
function fixture(change = {}) {
  const env = { GITHUB_REPOSITORY: 'krzysztofsyska/skillcheck-core', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
    AGENT_PIPELINE_ENABLED: 'false', AGENT_PIPELINE_MERGE_ENABLED: 'false', AGENT_FEEDBACK_ENABLED: 'false',
    AGENT_PIPELINE_APP_ID: '5216184', AGENT_PIPELINE_APP_INSTALLATION_ID: '168649570',
    AGENT_PIPELINE_APP_PRIVATE_KEY: privateKey, CURSOR_API_KEY: 'private-cursor', CURSOR_DIAGNOSTIC_AGENT_ID: 'bc-test', ...change };
  const calls = [];
  const data = {
    '/app': { id: 5216184, slug: 'skillcheck-agent-ks' },
    '/app/installations/168649570': { id: 168649570, app_id: 5216184, account: { id: 222297538 }, suspended_at: null },
    '/app/installations/168649570/access_tokens': { token: 'private-token', permissions: { contents: 'read', administration: 'read' } },
    [root]: { id: 1043384454, default_branch: 'main' },
    [root + '/branches/main']: { commit: { sha: env.GITHUB_SHA } },
    [root + '/branches/agent-feedback-state']: { name: 'agent-feedback-state' },
    [root + '/rules/branches/agent-feedback-state']: [{ ruleset_id: 1 }, { ruleset_id: 2 }],
    [root + '/rulesets/1']: { enforcement: 'active', target: 'branch', bypass_actors: [], rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] },
    [root + '/rulesets/2']: { enforcement: 'active', target: 'branch', bypass_actors: [{ actor_type: 'Integration', actor_id: 5216184, bypass_mode: 'always' }], rules: [{ type: 'update' }] },
    [root + '/environments/agent-control']: { deployment_branch_policy: { custom_branch_policies: true } },
    [root + '/environments/agent-control/deployment-branch-policies']: { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] },
    '/v1/agents/bc-test': { id: 'bc-test', name: 'private-provider-content' },
  };
  async function fetchMock(url, init) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, body: init.body });
    if (path === '/installation/token') return new Response(null, { status: 204 });
    assert.ok(Object.hasOwn(data, path), path);
    if (data[path] instanceof Error) throw data[path];
    return new Response(JSON.stringify(data[path]));
  }
  return { env, calls, data, run: () => diagnose(env, fetchMock) };
}

test('diagnostic only reads services and issues/revokes a scoped read token', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.checks.length, 7);
  assert.ok(result.checks.every(c => c.status === 'PASS'));
  assert.equal(result.liveE2E, 'NOT_RUN');
  assert.deepEqual(f.calls.filter(c => c.method !== 'GET').map(c => [c.method, c.path]), [
    ['POST', '/app/installations/168649570/access_tokens'], ['DELETE', '/installation/token'],
  ]);
  assert.deepEqual(JSON.parse(f.calls.find(c => c.method === 'POST').body), {
    repository_ids: [1043384454], permissions: { contents: 'read', administration: 'read' },
  });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

for (const change of [{ GITHUB_REF: 'refs/heads/integration' }, { GITHUB_EVENT_NAME: 'pull_request' },
  { AGENT_PIPELINE_ENABLED: 'true' }, { AGENT_PIPELINE_MERGE_ENABLED: 'true' },
  { AGENT_FEEDBACK_ENABLED: '' }, { GITHUB_REPOSITORY: 'other/repo' }]) {
  test(`reject unsafe context before network: ${JSON.stringify(change)}`, async () => {
    const f = fixture(change); const result = await f.run();
    assert.deepEqual(result.checks, [{ check: 'trusted_context', status: 'FAIL' }]);
    assert.equal(f.calls.length, 0);
  });
}

test('failed provider read is redacted, other checks continue and token is revoked', async () => {
  const f = fixture(); f.data[root + '/rulesets/1'] = new Error('private-token private-provider-content');
  const result = await f.run();
  assert.ok(result.checks.some(c => c.check === 'feedback_protection_and_environment' && c.status === 'FAIL'));
  assert.ok(result.checks.some(c => c.check === 'cursor_agent_read' && c.status === 'PASS'));
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test('reject mismatched installation before issuing a token', async () => {
  const f = fixture(); f.data['/app/installations/168649570'].app_id = 123;
  const result = await f.run();
  assert.ok(result.checks.some(c => c.status === 'FAIL'));
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('unexpected write token is rejected and revoked', async () => {
  const f = fixture(); f.data['/app/installations/168649570/access_tokens'].permissions.contents = 'write';
  const result = await f.run();
  assert.ok(result.checks.some(c => c.check === 'github_identity_and_read_token' && c.status === 'FAIL'));
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.some(c => c.path === root), false);
});

test('invalid agent path cannot redirect credentialed requests', async () => {
  const f = fixture({ CURSOR_DIAGNOSTIC_AGENT_ID: 'bc-../../other' });
  const result = await f.run();
  assert.ok(result.checks.some(c => c.check === 'cursor_agent_read' && c.status === 'FAIL'));
  assert.equal(f.calls.some(c => c.path.startsWith('/v1/')), false);
});
