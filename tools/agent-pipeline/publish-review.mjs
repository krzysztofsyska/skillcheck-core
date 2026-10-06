import { readFileSync } from 'node:fs';
import { validateReview } from './lib/review.mjs';
import { loadPolicy } from './lib/policy.mjs';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const artifact = JSON.parse(readFileSync(value('--artifact'), 'utf8'));
const packet = JSON.parse(process.env.REVIEW_PACKET);
const policy = loadPolicy();
const result = validateReview(artifact, {
  workflowId: policy.workflow_ids.review, workflowPath: policy.workflows.review,
  runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  policySha: packet.policy_sha, requestId: packet.request_id, repositoryId: packet.repository_id,
  prNumber: packet.pr_number, headSha: packet.head_sha, baseSha: packet.base_sha,
  contractHash: packet.contract_hash, requiredChecks: packet.required_checks,
});
if (!result.ok) { console.error(result.reason); process.exit(1); }
// This isolated job validates only. The App controller independently verifies
// GitHub run provenance and upserts its required check in live-ports.mjs.
console.log(JSON.stringify({ ok: true, verdict: result.payload.verdict, next: 'controller-provenance-validation' }));
