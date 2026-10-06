import { readFileSync, writeFileSync } from 'node:fs';
import { buildReviewEnvelope } from './lib/review.mjs';
import { loadPolicy } from './lib/policy.mjs';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const payload = JSON.parse(readFileSync(value('--payload'), 'utf8'));
const policy = loadPolicy(process.env.AGENT_POLICY_PATH);
const envelope = buildReviewEnvelope({
  policy,
  policySha: process.env.POLICY_SHA || value('--policy-sha'),
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  payload,
});
writeFileSync(value('--out'), `${JSON.stringify(envelope)}\n`);
console.log(JSON.stringify({ ok: true, wrapped: true }));
