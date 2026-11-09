import { appendFileSync } from 'node:fs';
import { loadPolicy } from './lib/policy.mjs';
import { createGitHubClient } from './lib/github.mjs';
import { assertPolicyExecution } from './lib/control-plane.mjs';

const policy = loadPolicy();
const github = createGitHubClient({ fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN,
  repository: policy.repository, policy });
await assertPolicyExecution({ policy, github, env: process.env,
  policySha: process.env.POLICY_SHA || process.env.GITHUB_SHA });
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'allowed=true\n');
