import { controlPlane } from './control-plane.mjs';
import { builderConfiguration } from './claude-builder.mjs';
export function assessConfiguration(env, flags, policy = {}) {
  controlPlane(policy);
  if (!flags.enabled) return { ok: true, mode: 'read-only', missing: [] };
  const missing = [];
  // Subscription-only must never silently reuse the legacy Cursor/API-key
  // builder or the billed openai/codex-action reviewer. Until the trusted
  // subscription runtime and independent review are wired, enabling LIVE
  // is an explicit configuration failure (even when paid API keys exist).
  if (policy.execution_mode === 'SUBSCRIPTION_ONLY') {
    // Report the actual missing pieces instead of a generic permanent block.
    // These checks are diagnostics, NOT a bypass of controller.guardEffects.
    if (policy.builder_provider !== 'claude-code' || policy.claude_builder?.enabled !== true)
      missing.push('SUBSCRIPTION_CLAUDE_BUILDER_DISABLED');
    if (!Number.isSafeInteger(policy.claude_builder?.workflow_id) || policy.claude_builder.workflow_id <= 0
        || policy.claude_builder.workflow_path !== '.github/workflows/claude-code-dispatch.yml')
      missing.push('SUBSCRIPTION_CLAUDE_WORKFLOW_UNCONFIGURED');
    // The current adapter still requires paid-budget reservations; never
    // report LIVE ready until it supports bounded OAuth-only dispatch.
    missing.push('SUBSCRIPTION_OAUTH_BUDGET_ADAPTER_NOT_WIRED');
    // The legacy reviewer calls openai/codex-action with OPENAI_API_KEY.
    // A connector evidence reader alone does not authorize review dispatch.
    missing.push('SUBSCRIPTION_INDEPENDENT_REVIEW_NOT_WIRED');
  } else if (policy.execution_mode && policy.execution_mode !== 'LEGACY') {
    missing.push('EXECUTION_MODE_UNRECOGNIZED');
  }
  if (policy.execution_mode === 'SUBSCRIPTION_ONLY') {
    // Do not inspect or select paid provider credentials as a fallback.
  } else if (policy.builder_provider === 'claude-code') {
    try { builderConfiguration(policy); } catch(error) { missing.push(error.code); }
  } else if (!env.CURSOR_API_KEY) missing.push('CURSOR_API_KEY');
  const hasApp = Boolean(env.AGENT_PIPELINE_APP_ID && env.AGENT_PIPELINE_APP_PRIVATE_KEY);
  const hasToken = Boolean(env.AGENT_PIPELINE_GITHUB_TOKEN || env.GITHUB_TOKEN);
  if (!hasApp) missing.push('GITHUB_CREDENTIALS');
  if (!env.GITHUB_REPOSITORY && !env.AGENT_PIPELINE_REPOSITORY) missing.push('GITHUB_REPOSITORY');
  return { ok: missing.length === 0, mode: 'live', missing, hasApp, hasToken };
}
