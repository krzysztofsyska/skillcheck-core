import { controlPlane } from './control-plane.mjs';
import { builderConfiguration } from './claude-builder.mjs';
export function assessConfiguration(env, flags, policy = {}) {
  controlPlane(policy);
  if (!flags.enabled) return { ok: true, mode: 'read-only', missing: [] };
  const missing = [];
  if (policy.builder_provider === 'claude-code') {
    try { builderConfiguration(policy); } catch(error) { missing.push(error.code); }
  } else if (!env.CURSOR_API_KEY) missing.push('CURSOR_API_KEY');
  const hasApp = Boolean(env.AGENT_PIPELINE_APP_ID && env.AGENT_PIPELINE_APP_PRIVATE_KEY);
  const hasToken = Boolean(env.AGENT_PIPELINE_GITHUB_TOKEN || env.GITHUB_TOKEN);
  if (!hasApp) missing.push('GITHUB_CREDENTIALS');
  if (!env.GITHUB_REPOSITORY && !env.AGENT_PIPELINE_REPOSITORY) missing.push('GITHUB_REPOSITORY');
  return { ok: missing.length === 0, mode: 'live', missing, hasApp, hasToken };
}
