import { readFileSync } from 'node:fs';
import { validateReview } from './lib/review.mjs';
import { loadPolicy } from './lib/policy.mjs';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const artifact = JSON.parse(readFileSync(value('--artifact'), 'utf8'));
const policy = loadPolicy();
const result = validateReview(artifact, {
  workflowId: policy.workflow_ids.review,
  workflowPath: policy.workflows.review,
  runId: artifact.run_id,
  runAttempt: artifact.run_attempt,
  policySha: value('--policy-sha'),
  requestId: value('--request-id'),
  repositoryId: artifact.payload?.repository_id,
  prNumber: artifact.payload?.pr_number,
  headSha: artifact.payload?.head_sha,
  baseSha: artifact.payload?.base_sha,
  contractHash: artifact.payload?.contract_hash,
  requiredChecks: [],
});
if (!result.ok) {
  console.error(result.reason);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, verdict: result.payload.verdict, publish: false }));
