import { appendFileSync } from 'node:fs';
import { loadPolicy } from './lib/policy.mjs';
import { createGitHubClient } from './lib/github.mjs';
import { assertPolicyExecution } from './lib/control-plane.mjs';
import { reviewDispatchDecision } from './lib/review-dispatch.mjs';

const policy = loadPolicy();
const decision = reviewDispatchDecision({
  actorId: process.env.ACTOR_ID ?? '',
  pipelineEnabled: process.env.PIPELINE_ENABLED ?? '',
  controllerActorId: policy.controller_actor_id,
  runAttempt: process.env.RUN_ATTEMPT ?? '',
});
if (decision.ok) {
  const github = createGitHubClient({ fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN, repository: policy.repository, policy });
  await assertPolicyExecution({ policy, github, env: process.env, policySha: process.env.POLICY_SHA });
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${decision.ok ? 'true' : 'false'}\n`);
}
if (!decision.ok) {
  console.error(`review dispatch denied: ${decision.reason}`);
  process.exit(1);
}
