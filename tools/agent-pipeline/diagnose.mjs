import { pathToFileURL } from 'node:url';
import { githubAppJwt } from './lib/github.mjs';
import { verifyFeedbackProtection } from './feedback-cli.mjs';
import { REPOSITORY, REPOSITORY_ID } from './feedback.mjs';

// Identity confirmed by the owner in GitHub settings. Never accept an arbitrary
// API host, repository or installation from workflow inputs.
const APP_ID = 5216184;
const INSTALLATION_ID = 168649570;
const ROOT = `/repos/${REPOSITORY}`;

export async function diagnose(env, fetchImpl = fetch) {
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
  if (!await check('trusted_context', async () => {
    requireThat(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main'
      && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''));
    requireThat(['AGENT_PIPELINE_ENABLED', 'AGENT_PIPELINE_MERGE_ENABLED', 'AGENT_FEEDBACK_ENABLED']
      .every(key => env[key] === 'false'));
  })) return { checks, liveE2E: 'NOT_RUN' };

  const connected = await check('github_identity_and_read_token', async () => {
    requireThat(env.AGENT_PIPELINE_APP_ID === String(APP_ID)
      && env.AGENT_PIPELINE_APP_INSTALLATION_ID === String(INSTALLATION_ID));
    const jwt = githubAppJwt({ appId: APP_ID, privateKey: env.AGENT_PIPELINE_APP_PRIVATE_KEY });
    const app = await github('/app', `Bearer ${jwt}`);
    requireThat(app.id === APP_ID && app.slug === 'skillcheck-agent-ks');
    const installation = await github(`/app/installations/${INSTALLATION_ID}`, `Bearer ${jwt}`);
    requireThat(installation.id === INSTALLATION_ID && installation.app_id === APP_ID
      && installation.account?.id === 222297538 && installation.suspended_at === null);
    const issued = await github(`/app/installations/${INSTALLATION_ID}/access_tokens`, `Bearer ${jwt}`, 'POST', {
      repository_ids: [REPOSITORY_ID], permissions: { contents: 'read', administration: 'read' },
    });
    token = issued.token;
    requireThat(typeof token === 'string' && token.length > 0);
    requireThat(issued.permissions?.contents === 'read' && issued.permissions?.administration === 'read'
      && Object.values(issued.permissions).every(value => value === 'read'));
  });
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
      await check('feedback_protection_and_environment', () => verifyFeedbackProtection(client, APP_ID));
    }
    await check('cursor_agent_read', async () => {
      requireThat(env.CURSOR_API_KEY && /^bc-[a-zA-Z0-9-]{1,100}$/.test(env.CURSOR_DIAGNOSTIC_AGENT_ID ?? ''));
      const result = await request('https://api.cursor.com', `/v1/agents/${env.CURSOR_DIAGNOSTIC_AGENT_ID}`,
        `Basic ${Buffer.from(`${env.CURSOR_API_KEY}:`).toString('base64')}`);
      requireThat(result.id === env.CURSOR_DIAGNOSTIC_AGENT_ID);
    });
  } finally {
    if (token) await check('temporary_token_revoked', () => github('/installation/token', `Bearer ${token}`, 'DELETE'));
  }
  // No response bodies, provider messages, tokens, agent names or input values.
  // A diagnostic PASS does not prove agent target/signing compatibility or E2E.
  return { checks, liveE2E: 'NOT_RUN' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await diagnose(process.env);
    console.log(JSON.stringify(result));
    if (result.checks.some(check => check.status !== 'PASS')) process.exitCode = 1;
  } catch { console.error('DIAGNOSTIC_FAILED'); process.exitCode = 1; }
}
