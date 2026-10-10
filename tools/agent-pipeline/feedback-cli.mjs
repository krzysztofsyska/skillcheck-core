import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createGitHubClient, createInstallationToken, decodeGithubContent } from './lib/github.mjs';
import { createCursorClient } from './lib/cursor.mjs';
import { evaluatePreflight } from './lib/merge.mjs';
import { runFeedback, validateBinding, REPOSITORY, REPOSITORY_ID } from './feedback.mjs';

// Reuse the existing controller's API clients and protection preflight, but keep
// feedback records outside its task projection. No second writer for a managed PR.
export function feedbackStore(github, pr) {
  const path = `/repos/${REPOSITORY}/contents/feedback/${pr}.json`;
  return {
    async read() {
      try {
        const file = await github.request(`${path}?ref=agent-feedback-state`);
        return { value: JSON.parse(decodeGithubContent(file)), revision: file.sha };
      } catch (e) { if (e.status === 404) return { value: null, revision: null }; throw e; }
    },
    async save(value, revision) {
      const response = await github.request(path, { method: 'PUT', body: {
        branch: 'agent-feedback-state', message: `feedback PR ${pr}: ${value.phase}`,
        content: Buffer.from(JSON.stringify(value)).toString('base64'), ...(revision ? { sha: revision } : {}),
      } });
      return response.content.sha;
    },
  };
}

export async function verifyFeedbackProtection(github, appId) {
  const root = `/repos/${REPOSITORY}`;
  const rules = await github.request(`${root}/rules/branches/agent-feedback-state`);
  // This endpoint returns rules applicable to the exact branch. Check each
  // source ruleset as well: effective rules alone do not expose bypass actors.
  if (!Array.isArray(rules) || !rules.length) throw new Error('STATE_PROTECTION_MISSING');
  const sets = await Promise.all([...new Set(rules.map(r => r.ruleset_id))]
    .map(id => github.request(`${root}/rulesets/${id}`)));
  const active = sets.filter(s => s.enforcement === 'active' && s.target === 'branch');
  const integrity = active.filter(s => s.bypass_actors?.length === 0).flatMap(s => s.rules ?? []);
  const writers = active.some(s => s.rules?.some(r => r.type === 'update')
    && s.bypass_actors?.length === 1 && s.bypass_actors[0].actor_type === 'Integration'
    && s.bypass_actors[0].actor_id === appId && s.bypass_actors[0].bypass_mode === 'always');
  if (!writers || !['deletion', 'non_fast_forward'].every(t => integrity.some(r => r.type === t))) throw new Error('STATE_PROTECTION_MISSING');
  const environment = await github.request(`${root}/environments/agent-control`);
  const branches = await github.request(`${root}/environments/agent-control/deployment-branch-policies`);
  if (environment.deployment_branch_policy?.custom_branch_policies !== true
      || branches.total_count !== 1 || branches.branch_policies?.[0]?.name !== 'main'
      || branches.branch_policies[0].type !== 'branch') throw new Error('CONTROL_ENVIRONMENT_UNPROTECTED');
}

export async function readSnapshot(github, cursor, binding, state) {
  const root = `/repos/${REPOSITORY}`;
  async function pages(path) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await github.request(`${root}${path}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('INVALID_COLLECTION');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error('INCOMPLETE_COLLECTION');
  }
  const pull = await github.readPull(binding.pr);
  const [files, reviews, comments, agent, origin, initial, projection] = await Promise.all([
    github.readChangedFiles(pull.base.sha, pull.head.sha),
    pages(`/pulls/${binding.pr}/reviews`), pages(`/pulls/${binding.pr}/comments`),
    cursor.getAgent(binding.agentId),
    github.request(`${root}/compare/${binding.originIntegration}...${binding.initialHead}`),
    github.request(`${root}/compare/${binding.initialHead}...${pull.head.sha}`),
    github.readProjection(),
  ]);
  if (Object.values(projection.tasks).some(t => t.pr_number === binding.pr || t.binding?.branch === binding.branch)) throw new Error('MANAGED_BY_CONTROLLER');
  let repair = null;
  if (['FIXING', 'REVIEW_PENDING'].includes(state?.phase) && state.repairHead && state.repairHead !== pull.head.sha) {
    const comparison = await github.request(`${root}/compare/${state.repairHead}...${pull.head.sha}?per_page=100`);
    const complete = comparison.status === 'ahead' && comparison.base_commit?.sha === state.repairHead
      && Number.isInteger(comparison.total_commits) && comparison.total_commits > 0 && comparison.total_commits <= 100
      && comparison.commits?.length === comparison.total_commits;
    const commits = complete ? await Promise.all(comparison.commits.map(c => github.request(`${root}/commits/${c.sha}`))) : [];
    repair = { base: state.repairHead, head: pull.head.sha, status: comparison.status, complete, commits };
  }
  return {
    pull, files, reviews, comments, agent, repair,
    originVerified: ['ahead', 'identical'].includes(origin.status),
    initialHeadVerified: ['ahead', 'identical'].includes(initial.status),
    run: state?.runId ? await cursor.getRun(binding.agentId, state.runId) : null,
    reactions: state?.reviewCommentId ? await pages(`/issues/comments/${state.reviewCommentId}/reactions`) : [],
  };
}

export async function reconcileBindings(bindings, processBinding) {
  const result = [];
  for (const binding of bindings) {
    try { result.push({ pr: binding.pr, status: await processBinding(binding) }); }
    catch { result.push({ pr: binding.pr, status: 'BLOCKED_BINDING' }); }
  }
  // Never copy exception messages, response bodies or credentials into results.
  return result;
}

export async function main(env = process.env) {
  const config = JSON.parse(readFileSync('.github/agent-pipeline/feedback.json', 'utf8'));
  if (env.AGENT_FEEDBACK_ENABLED !== 'true' || config.enabled !== true) return ['DISABLED'];
  if (env.AGENT_PIPELINE_ENABLED === 'true') throw new Error('CONTROLLER_MUST_BE_DISABLED');
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main') throw new Error('UNTRUSTED_WORKFLOW_REF');
  for (const key of ['CURSOR_API_KEY', 'AGENT_PIPELINE_APP_ID', 'AGENT_PIPELINE_APP_PRIVATE_KEY', 'AGENT_PIPELINE_APP_INSTALLATION_ID']) {
    if (!env[key]) throw new Error('MISSING_CONFIGURATION');
  }
  const policy = JSON.parse(readFileSync('.github/agent-pipeline/policy.json', 'utf8'));
  if (!Number.isInteger(policy.controller_actor_id) || !Number.isInteger(policy.controller_app_id)
      || policy.controller_app_id !== Number(env.AGENT_PIPELINE_APP_ID)) throw new Error('APP_IDENTITY_UNCONFIGURED');
  if (!Array.isArray(config.bindings) || !config.bindings.length
      || new Set(config.bindings.map(b => b.pr)).size !== config.bindings.length
      || new Set(config.bindings.map(b => b.agentId)).size !== config.bindings.length) throw new Error('INVALID_BINDINGS');
  config.bindings.forEach(validateBinding);
  const token = await createInstallationToken({ fetch, appId: env.AGENT_PIPELINE_APP_ID,
    privateKey: env.AGENT_PIPELINE_APP_PRIVATE_KEY, installationId: env.AGENT_PIPELINE_APP_INSTALLATION_ID, repository: REPOSITORY });
  const github = createGitHubClient({ fetch, token, repository: REPOSITORY, policy });
  const repository = await github.request(`/repos/${REPOSITORY}`);
  if (repository.id !== REPOSITORY_ID || repository.default_branch !== 'main'
      || (await github.readBranch('main')).commit.sha !== env.GITHUB_SHA) throw new Error('TRUSTED_CODE_MOVED');
  if (!evaluatePreflight(await github.readProtection()).ok) throw new Error('PROTECTION_UNCONFIRMED');
  await verifyFeedbackProtection(github, policy.controller_app_id);
  // Bootstrap this dedicated state branch with no force/delete and controller-only
  // writers before activation. Never silently recreate a deleted journal.
  await github.readBranch('agent-feedback-state');
  const cursor = createCursorClient({ fetch, apiKey: env.CURSOR_API_KEY });
  return reconcileBindings(config.bindings, binding => runFeedback({ binding, store: feedbackStore(github, binding.pr),
      readSnapshot: state => readSnapshot(github, cursor, binding, state), cursor,
      postReview: body => github.request(`/repos/${REPOSITORY}/issues/${binding.pr}/comments`, { method: 'POST', body: { body } }),
    }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await main();
    console.log(JSON.stringify(results));
    if (results.some(r => r.status?.startsWith('BLOCKED'))) process.exitCode = 1;
  }
  catch { console.error('FEEDBACK_BLOCKED: inspect configuration and durable phase; provider payloads are intentionally omitted.'); process.exitCode = 1; }
}
