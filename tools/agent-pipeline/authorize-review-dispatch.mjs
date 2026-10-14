import { appendFileSync } from 'node:fs';
import { loadPolicy } from './lib/policy.mjs';
import { reviewDispatchDecision } from './lib/review-dispatch.mjs';

const decision = reviewDispatchDecision({
  actorId: process.env.ACTOR_ID ?? '',
  pipelineEnabled: process.env.PIPELINE_ENABLED ?? '',
  controllerActorId: loadPolicy().controller_actor_id,
});
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${decision.ok ? 'true' : 'false'}\n`);
}
if (!decision.ok) {
  console.error(`review dispatch denied: ${decision.reason}`);
  process.exit(1);
}
