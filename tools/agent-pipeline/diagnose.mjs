import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { verifyStateBootstrap } from './lib/ruleset-evidence.mjs';
import { githubAppJwt } from './lib/github.mjs';
import { verifyFeedbackProtection } from './feedback-cli.mjs';
import { REPOSITORY, REPOSITORY_ID } from './feedback.mjs';
import { authorizeRulesetVisibility } from './authorize-diagnostics.mjs';
import { probeRulesetVisibility } from './probe-ruleset-visibility.mjs';

// Identity confirmed by the owner in GitHub settings. Never accept an arbitrary
// API host, repository or installation from workflow inputs.
const APP_ID = 5216184;
const INSTALLATION_ID = 168649570;
const ROOT = `/repos/${REPOSITORY}`;
const READ_PERMISSIONS = Object.freeze({ contents: 'read', administration: 'read', actions: 'read' });
// Matches the existing controller's requested scope in lib/reconcile.mjs.
// A write-capable token used only for reads, NOT a read-only token or activation.
const CONTROLLER_PERMISSIONS = Object.freeze({ administration: 'read', actions: 'write', checks: 'write',
  contents: 'write', issues: 'write', pull_requests: 'write' });

export async function diagnose(env, fetchImpl = fetch, policy = {}) {
  const checks = [];
  let token;
  async function check(name, action) {
    try { await action(); checks.push({ check: name, status: 'PASS' }); return true; }
    catch { checks.push({ check: name, status: 'FAIL' }); return false; }
  }
  function requireThat(value) { if (!value) throw new Error('CHECK_FAILED'); }
  async function request(host, path, authorization, method = 'GET', body) {
    const response = await fetchImpl(`${host}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization, accept: 'application/json', 'content-type': 'application/json',
        ...(host === 'https://api.github.com' ? { 'x-github-api-version': '2022-11-28' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requireThat(response.ok);
    return response.status === 204 ? null : response.json();
  }
  const github = (path, authorization, method, body) => request('https://api.github.com', path, authorization, method, body);
  async function issueToken(permissions, { beforeIssue, requireExpiry = false } = {}) {
    requireThat(env.AGENT_PIPELINE_APP_ID === String(APP_ID)
      && env.AGENT_PIPELINE_APP_INSTALLATION_ID === String(INSTALLATION_ID));
    const jwt = githubAppJwt({ appId: APP_ID, privateKey: env.AGENT_PIPELINE_APP_PRIVATE_KEY });
    const app = await github('/app', `Bearer ${jwt}`);
    requireThat(app.id === APP_ID && app.slug === 'skillcheck-agent-ks');
    const installation = await github(`/app/installations/${INSTALLATION_ID}`, `Bearer ${jwt}`);
    requireThat(installation.id === INSTALLATION_ID && installation.app_id === APP_ID
      && installation.account?.id === 222297538 && installation.suspended_at === null);
    await beforeIssue?.();
    const issuedAt = Date.now();
    const issued = await github(`/app/installations/${INSTALLATION_ID}/access_tokens`, `Bearer ${jwt}`, 'POST', {
      repository_ids: [REPOSITORY_ID], permissions,
    });
    // Retain a known token for finally/revocation even if scope validation fails.
    token = typeof issued?.token === 'string' && issued.token ? issued.token : undefined;
    requireThat(token);
    const granted = issued.permissions ?? {};
    const allowed = { metadata: 'read', ...permissions };
    requireThat(Object.entries(permissions).every(([key, value]) => granted[key] === value)
      && Object.entries(granted).every(([key, value]) => allowed[key] === value));
    requireThat(issued.repository_selection === 'selected'
      && Array.isArray(issued.repositories) && issued.repositories.length === 1
      && issued.repositories[0]?.id === REPOSITORY_ID);
    if (requireExpiry) {
      const expires = typeof issued.expires_at === 'string' ? Date.parse(issued.expires_at) : NaN;
      requireThat(Number.isFinite(expires) && expires > Date.now() && expires <= issuedAt + 3660000);
    }
    return { permissions: { ...granted }, ...(requireExpiry ? { expires_at: new Date(issued.expires_at).toISOString() } : {}) };
  }
  async function revoke(name = 'temporary_token_revoked') {
    if (!token) return false;
    const knownToken = token;
    token = undefined;
    return check(name, () => github('/installation/token', `Bearer ${knownToken}`, 'DELETE'));
  }
  const mode = env.AGENT_DIAGNOSTIC_MODE ?? 'connections';
  if (mode === 'ruleset_visibility') {
    const result = { mode, checks, profiles: [], liveE2E: 'NOT_RUN',
      protection_authorized: false, controller_activation_authorized: false };
    const guard = () => authorizeRulesetVisibility(env, fetchImpl);
    if (!await check('diagnostic_source_before_credentials', guard)) return result;
    result.source_sha = env.GITHUB_SHA;
    result.workflow_run_id = env.GITHUB_RUN_ID;
    for (const [profile, permissions] of [['app-read', READ_PERMISSIONS], ['controller-existing-scope', CONTROLLER_PERMISSIONS]]) {
      const entry = { profile, requested_permissions: { ...permissions }, verified_permissions: null,
        token_identity_and_permissions_verified: false, token_cleanup: 'not-issued', observation: null };
      result.profiles.push(entry);
      try {
        const connected = await check(`${profile}:identity_and_scope`, async () => {
          const grant = await issueToken(permissions, { requireExpiry: true, beforeIssue: async () => {
            await guard(); // Immediately before issuing each token, not only before environment entry.
            entry.token_cleanup = 'unconfirmed';
          } });
          entry.verified_permissions = grant.permissions;
          entry.expires_at = grant.expires_at;
          entry.token_identity_and_permissions_verified = true;
        });
        if (!connected) return result;
        const observed = await check(`${profile}:probe_and_source_recheck`, async () => {
          let observation;
          try { observation = await probeRulesetVisibility({ token, tokenSource: 'existing-app-token', fetchImpl }); }
          finally { await guard(); }
          // A stale source cannot retain a successful capability observation.
          entry.observation = observation;
        });
        if (!observed) return result;
      } finally {
        if (token && await revoke(`${profile}:temporary_token_revoked`)) entry.token_cleanup = 'revoked';
      }
      if (entry.token_cleanup !== 'revoked') return result;
    }
    return result;
  }
  if (mode !== 'connections') return { checks: [{ check: 'diagnostic_mode', status: 'FAIL' }], liveE2E: 'NOT_RUN' };
  if (!await check('trusted_context', async () => {
    requireThat(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main'
      && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''));
    requireThat(['AGENT_PIPELINE_ENABLED', 'AGENT_PIPELINE_MERGE_ENABLED', 'AGENT_FEEDBACK_ENABLED']
      .every(key => env[key] === 'false'));
  })) return { checks, liveE2E: 'NOT_RUN' };

  const connected = await check('github_identity_and_read_token', () => issueToken(READ_PERMISSIONS));
  try {
    if (connected) {
      const client = { request: path => github(path, `Bearer ${token}`) };
      await check('repository_and_trusted_head', async () => {
        const repo = await client.request(ROOT);
        const main = await client.request(`${ROOT}/branches/main`);
        requireThat(repo.id === REPOSITORY_ID && repo.default_branch === 'main' && main.commit?.sha === env.GITHUB_SHA);
      });
      await check('feedback_state_exists', async () => {
        const branch = await client.request(`${ROOT}/branches/agent-feedback-state`);
        requireThat(branch.name === 'agent-feedback-state');
      });
      await check('feedback_protection_and_environment', () => verifyFeedbackProtection(client, APP_ID, policy));
      await check('feedback_bootstrap_provenance', () => verifyStateBootstrap(client, policy));
    }
    await check('cursor_agent_read', async () => {
      requireThat(env.CURSOR_API_KEY && /^bc-[a-zA-Z0-9-]{1,100}$/.test(env.CURSOR_DIAGNOSTIC_AGENT_ID ?? ''));
      const result = await request('https://api.cursor.com', `/v1/agents/${env.CURSOR_DIAGNOSTIC_AGENT_ID}`,
        `Basic ${Buffer.from(`${env.CURSOR_API_KEY}:`).toString('base64')}`);
      requireThat(result.id === env.CURSOR_DIAGNOSTIC_AGENT_ID);
    });
  } finally {
    await revoke();
  }
  // No response bodies, provider messages, tokens, agent names or input values.
  // A diagnostic PASS does not prove agent target/signing compatibility or E2E.
  return { checks, liveE2E: 'NOT_RUN' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const policy = process.env.AGENT_DIAGNOSTIC_MODE === 'ruleset_visibility' ? {}
      : JSON.parse(readFileSync('.github/agent-pipeline/policy.json', 'utf8'));
    const result = await diagnose(process.env, fetch, policy);
    console.log(JSON.stringify(result));
    if (result.checks.some(check => check.status !== 'PASS')) process.exitCode = 1;
  } catch { console.error('DIAGNOSTIC_FAILED'); process.exitCode = 1; }
}
