import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { diagnose } from '../../tools/agent-pipeline/diagnose.mjs';
import { authorizeRulesetVisibility } from '../../tools/agent-pipeline/authorize-diagnostics.mjs';
import { RULESET_VISIBILITY_QUERY } from '../../tools/agent-pipeline/probe-ruleset-visibility.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ROOT = '/repos/krzysztofsyska/skillcheck-core';
const SHA = 'a'.repeat(40);
const WORKFLOW = '.github/workflows/agent-diagnostics.yml';
const READ = { contents: 'read', administration: 'read', actions: 'read' };
const CONTROLLER = { administration: 'read', actions: 'write', checks: 'write', contents: 'write', issues: 'write', pull_requests: 'write' };
const ISSUE = '/app/installations/168649570/access_tokens';
function fixture(change = {}) {
  const env = { AGENT_DIAGNOSTIC_MODE: 'ruleset_visibility', GITHUB_REPOSITORY: 'krzysztofsyska/skillcheck-core',
    GITHUB_REPOSITORY_ID: '1043384454', GITHUB_REF: 'refs/heads/agent-control-runtime',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: SHA, GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_WORKFLOW_REF: `krzysztofsyska/skillcheck-core/${WORKFLOW}@refs/heads/agent-control-runtime`,
    GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'private-actions-token',
    AGENT_PIPELINE_ENABLED: 'false', AGENT_PIPELINE_MERGE_ENABLED: 'false', AGENT_FEEDBACK_ENABLED: 'false',
    AGENT_PIPELINE_APP_ID: '5216184', AGENT_PIPELINE_APP_INSTALLATION_ID: '168649570',
    AGENT_PIPELINE_APP_PRIVATE_KEY: privateKey, ...change };
  const state = { issued: 0, branchReads: 0, staleAt: Infinity, queryCount: 0 };
  const calls = [];
  const run = { id: 12345, workflow_id: 396343951, path: WORKFLOW, event: 'workflow_dispatch', run_attempt: 1,
    head_branch: 'agent-control-runtime', head_sha: SHA, repository: { id: 1043384454 }, head_repository: { id: 1043384454 } };
  const app = { id: 5216184, slug: 'skillcheck-agent-ks' };
  const installation = { id: 168649570, app_id: 5216184, account: { id: 222297538 }, suspended_at: null };
  async function fetchMock(url, init) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    const path = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, authorization: init.headers.authorization });
    if (state.failPath === path) throw new Error('private-provider-error private-token');
    if (path === `${ROOT}/actions/runs/12345`) return Response.json(run);
    if (path === `${ROOT}/branches/agent-control-runtime`) {
      state.branchReads++;
      return Response.json({ commit: { sha: state.branchReads >= state.staleAt ? 'b'.repeat(40) : SHA } });
    }
    if (path === '/app') return Response.json(app);
    if (path === '/app/installations/168649570') return Response.json(installation);
    if (path === ISSUE) {
      state.issued++;
      const grant = { token: `private-app-token-${state.issued}`, repository_selection: 'selected',
        repositories: [{ id: 1043384454 }], permissions: { metadata: 'read', ...body.permissions },
        expires_at: new Date(Date.now() + 3500000).toISOString() };
      state.alterGrant?.(grant, state.issued);
      return Response.json(grant);
    }
    if (path === '/installation/token') return new Response(null, { status: 204 });
    if (path === '/graphql') {
      state.queryCount++;
      assert.equal(body.query, RULESET_VISIBILITY_QUERY);
      const writer = body.variables.rulesetId === 26864086;
      const nodes = writer ? (state.hiddenFirst && state.issued === 1 ? [null]
        : [{ id: 'actor', bypassMode: 'ALWAYS', actor: { __typename: 'App', databaseId: 5216184 } }]) : [];
      return Response.json({ data: { repository: { nameWithOwner: env.GITHUB_REPOSITORY,
        ruleset: { databaseId: body.variables.rulesetId,
          bypassActors: { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    throw new Error(`Unexpected endpoint: ${path}`);
  }
  return { env, calls, state, workflowRun: run, app, installation, fetchMock,
    run: async () => {
      const result = await diagnose(env, fetchMock, { repository: 'untrusted/policy', control_plane: { branch: 'main', mode: 'full' } });
      assert.doesNotMatch(JSON.stringify(result), /private-/);
      assert.equal(result.controller_activation_authorized, false);
      assert.equal(result.protection_authorized, false);
      assert.equal(result.liveE2E, 'NOT_RUN');
      return result;
    } };
}

test('two fixed App profiles use the same probe, scoped issuance and sequential revocation', async () => {
  const f = fixture(); const result = await f.run();
  assert.ok(result.checks.every(check => check.status === 'PASS'));
  assert.deepEqual(result.profiles.map(p => p.profile), ['app-read', 'controller-existing-scope']);
  for (const [index, permissions] of [READ, CONTROLLER].entries()) {
    const profile = result.profiles[index];
    assert.equal(profile.token_identity_and_permissions_verified, true);
    assert.equal(profile.token_cleanup, 'revoked');
    assert.deepEqual(profile.requested_permissions, permissions);
    assert.deepEqual(profile.verified_permissions, { metadata: 'read', ...permissions });
    assert.ok(Date.parse(profile.expires_at) > Date.now());
    assert.equal(profile.observation.capability, true);
    assert.equal(profile.observation.controller_activation_authorized, false);
  }
  const nonReads = f.calls.filter(call => call.method !== 'GET');
  assert.deepEqual(nonReads.map(call => [call.method, call.path]), [
    ['POST', ISSUE], ['POST', '/graphql'], ['POST', '/graphql'], ['DELETE', '/installation/token'],
    ['POST', ISSUE], ['POST', '/graphql'], ['POST', '/graphql'], ['DELETE', '/installation/token'],
  ]);
  assert.deepEqual(f.calls.filter(c => c.path === ISSUE).map(c => c.body),
    [READ, CONTROLLER].map(permissions => ({ repository_ids: [1043384454], permissions })));
  assert.equal(f.state.branchReads, 5);
  for (const call of f.calls.filter(c => c.path.startsWith(ROOT))) assert.equal(call.authorization, 'Bearer private-actions-token');
});

test('hidden actors in app-read do not imply the same result for the existing controller scope', async () => {
  const f = fixture(); f.state.hiddenFirst = true;
  const result = await f.run();
  assert.equal(result.profiles[0].observation.capability, null);
  assert.equal(result.profiles[0].observation.observations[0].detail_code, 'node:null');
  assert.equal(result.profiles[1].observation.capability, true);
});

test('source authorizer rejects unsafe or incomplete contexts before any network or credentials', async () => {
  for (const change of [
    { AGENT_DIAGNOSTIC_MODE: undefined }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/heads/integration' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_RUN_ID: '../other' }, { GITHUB_RUN_ID: undefined },
    { GITHUB_SHA: 'bad' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }, { GITHUB_WORKFLOW_REF: `${WORKFLOW}@refs/heads/main` },
    { GITHUB_WORKFLOW_SHA: undefined }, { GITHUB_WORKFLOW_REF: undefined }, { GITHUB_TOKEN: undefined },
    { AGENT_PIPELINE_ENABLED: 'true' }, { AGENT_PIPELINE_MERGE_ENABLED: 'true' }, { AGENT_FEEDBACK_ENABLED: undefined },
  ]) {
    const f = fixture(change);
    await assert.rejects(authorizeRulesetVisibility(f.env, f.fetchMock), /^Error: DIAGNOSTIC_SOURCE_UNVERIFIED$/);
    assert.equal(f.calls.length, 0);
  }
});

test('remote provenance must match the current run, workflow and repository before credentials', async () => {
  for (const change of [{ id: 1 }, { workflow_id: 1 }, { path: 'other.yml' }, { event: 'push' }, { run_attempt: 2 },
    { head_branch: 'main' }, { head_sha: 'b'.repeat(40) }, { repository: null }, { head_repository: { id: 1 } }]) {
    const f = fixture(); Object.assign(f.workflowRun, change);
    const result = await f.run();
    assert.equal(result.checks[0].status, 'FAIL');
    assert.equal(result.profiles.length, 0);
    assert.ok(f.calls.every(call => call.method === 'GET' && call.path.startsWith(ROOT)));
  }
});

test('stale initial source or immediately-before-issuance source cannot issue a token', async () => {
  for (const staleAt of [1, 2]) {
    const f = fixture(); f.state.staleAt = staleAt;
    const result = await f.run();
    assert.ok(result.checks.some(check => check.status === 'FAIL'));
    assert.equal(f.state.issued, 0);
    assert.equal(f.state.queryCount, 0);
  }
});

test('source movement after probe discards the observation and still revokes the token', async () => {
  const f = fixture(); f.state.staleAt = 3;
  const result = await f.run();
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].observation, null);
  assert.equal(result.profiles[0].token_cleanup, 'revoked');
  assert.equal(f.calls.at(-1).path, '/installation/token');
  assert.ok(result.checks.some(check => check.status === 'FAIL'));
});

test('wrong App or installation identity cannot issue either profile', async () => {
  for (const mutate of [f => { f.app.id = 1; }, f => { f.installation.account.id = 1; }, f => { f.installation.suspended_at = 'now'; }]) {
    const f = fixture(); mutate(f); const result = await f.run();
    assert.equal(f.state.issued, 0);
    assert.ok(result.checks.some(check => check.status === 'FAIL'));
  }
});

test('missing, excessive and mismatched grants are rejected and revoked before the probe', async () => {
  for (const alterGrant of [
    grant => { delete grant.permissions.actions; }, grant => { grant.permissions.administration = 'write'; },
    grant => { grant.permissions.secrets = 'read'; }, grant => { grant.repository_selection = 'all'; },
    grant => { grant.repositories.push({ id: 1 }); }, grant => { grant.repositories[0].id = 1; },
    grant => { delete grant.repositories; }, grant => { delete grant.expires_at; },
    grant => { grant.expires_at = 'private-invalid'; }, grant => { grant.expires_at = new Date(Date.now() - 1).toISOString(); },
    grant => { grant.expires_at = new Date(Date.now() + 7200000).toISOString(); },
  ]) {
    const f = fixture(); f.state.alterGrant = alterGrant;
    const result = await f.run();
    assert.equal(result.profiles.length, 1);
    assert.equal(result.profiles[0].token_identity_and_permissions_verified, false);
    assert.equal(result.profiles[0].verified_permissions, null);
    assert.equal(result.profiles[0].token_cleanup, 'revoked');
    assert.equal(f.state.queryCount, 0);
  }
});

test('controller profile also rejects missing or elevated permissions and revokes', async () => {
  const f = fixture(); f.state.alterGrant = (grant, issued) => { if (issued === 2) delete grant.permissions.pull_requests; };
  const result = await f.run();
  assert.equal(result.profiles[1].token_identity_and_permissions_verified, false);
  assert.equal(result.profiles[1].token_cleanup, 'revoked');
  assert.equal(f.state.queryCount, 2);
});

test('lost issuance response is not retried or falsely reported revoked', async () => {
  const f = fixture(); f.state.failPath = ISSUE;
  const result = await f.run();
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].token_cleanup, 'unconfirmed');
  assert.equal(f.calls.filter(call => call.path === ISSUE).length, 1);
  assert.equal(f.calls.some(call => call.path === '/installation/token'), false);
});

test('revoke failure is redacted, reports unconfirmed cleanup, and prevents issuing the second profile', async () => {
  const f = fixture(); f.state.failPath = '/installation/token';
  const result = await f.run();
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].token_cleanup, 'unconfirmed');
  assert.equal(result.checks.at(-1).status, 'FAIL');
  assert.equal(f.state.issued, 1);
});

test('probe network errors remain unknown, recheck the source, and revoke both tokens', async () => {
  const f = fixture(); f.state.failPath = '/graphql';
  const result = await f.run();
  assert.equal(f.state.branchReads, 5);
  assert.ok(result.profiles.every(p => p.token_cleanup === 'revoked' && p.observation.capability === null));
});

test('source network errors are fixed redacted errors, never service text', async () => {
  const f = fixture(); f.state.failPath = `${ROOT}/actions/runs/12345`;
  await assert.rejects(authorizeRulesetVisibility(f.env, f.fetchMock), /^Error: DIAGNOSTIC_SOURCE_UNVERIFIED$/);
  assert.equal((await f.run()).profiles.length, 0);
});

test('workflow separates source authorization from App credentials and has no new trigger or provider key', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/agent-diagnostics.yml', import.meta.url), 'utf8');
  const [, source, probe] = workflow.split(/  authorize_visibility:|  ruleset_visibility:/);
  assert.doesNotMatch(source, /secrets\.|environment:/);
  assert.match(probe, /needs: authorize_visibility/);
  assert.match(probe, /environment: agent-control/);
  assert.match(probe, /github.ref == 'refs\/heads\/agent-control-runtime'/);
  assert.doesNotMatch(probe, /CURSOR|OPENAI|: write\b/);
  assert.doesNotMatch(workflow, /pull_request_target:|schedule:|repository_dispatch:/);
  const policy = JSON.parse(readFileSync(new URL('../../.github/agent-pipeline/policy.json', import.meta.url), 'utf8'));
  assert.equal(policy.control_plane, undefined);
  assert.equal(policy.flags.AGENT_PIPELINE_ENABLED, false);
});
