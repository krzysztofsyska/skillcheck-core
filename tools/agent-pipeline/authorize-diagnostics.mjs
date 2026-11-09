import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertPolicyExecution } from './lib/control-plane.mjs';

const REPOSITORY = 'krzysztofsyska/skillcheck-core';
const REPOSITORY_ID = 1043384454;
const BRANCH = 'agent-control-runtime';
const WORKFLOW = '.github/workflows/agent-diagnostics.yml';
const WORKFLOW_ID = 396343951;
// Diagnostic source descriptor only. Never loaded by reconcile or written to
// the active policy. It grants neither controller activation nor updates.
const DESCRIPTOR = Object.freeze({ repository: REPOSITORY,
  control_plane: Object.freeze({ branch: BRANCH, mode: 'integration-only' }) });

export async function authorizeRulesetVisibility(env, fetchImpl = fetch) {
  try {
    const valid = env.AGENT_DIAGNOSTIC_MODE === 'ruleset_visibility'
      && env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REPOSITORY_ID === String(REPOSITORY_ID)
      && env.GITHUB_REF === `refs/heads/${BRANCH}` && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      && env.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')
      && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA
      && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@refs/heads/${BRANCH}`
      && typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0
      && ['AGENT_PIPELINE_ENABLED', 'AGENT_PIPELINE_MERGE_ENABLED', 'AGENT_FEEDBACK_ENABLED']
        .every(key => env[key] === 'false');
    if (!valid) throw new Error();
    async function read(path) {
      const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error();
      return response.json();
    }
    const run = await read(`/actions/runs/${env.GITHUB_RUN_ID}`);
    if (String(run?.id) !== env.GITHUB_RUN_ID || run.workflow_id !== WORKFLOW_ID
        || run.path !== WORKFLOW || run.event !== 'workflow_dispatch' || run.run_attempt !== 1
        || run.head_branch !== BRANCH || run.head_sha !== env.GITHUB_SHA
        || run.repository?.id !== REPOSITORY_ID || run.head_repository?.id !== REPOSITORY_ID) throw new Error();
    await assertPolicyExecution({ policy: DESCRIPTOR, env,
      github: { readBranch: () => read(`/branches/${BRANCH}`) } });
    return true;
  } catch {
    // Do not propagate service response/error text to the Actions log.
    throw new Error('DIAGNOSTIC_SOURCE_UNVERIFIED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await authorizeRulesetVisibility(process.env);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'allowed=true\n');
  } catch {
    console.error('DIAGNOSTIC_SOURCE_UNVERIFIED');
    process.exitCode = 1;
  }
}
