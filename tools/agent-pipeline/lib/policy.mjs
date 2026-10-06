import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const POLICY_PATH = join(here, '../../../.github/agent-pipeline/policy.json');

export function loadPolicy(path = POLICY_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function flagsFromEnv(env = process.env) {
  return {
    enabled: env.AGENT_PIPELINE_ENABLED === 'true',
    mergeEnabled: env.AGENT_PIPELINE_MERGE_ENABLED === 'true',
  };
}

export function defaultFlags(policy = loadPolicy()) {
  return {
    enabled: policy.flags.AGENT_PIPELINE_ENABLED === true,
    mergeEnabled: policy.flags.AGENT_PIPELINE_MERGE_ENABLED === true,
  };
}
