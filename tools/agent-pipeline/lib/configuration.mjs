export function assessConfiguration(env, flags) {
  if (!flags.enabled) return { ok: true, mode: 'read-only', missing: [] };
  const missing = [];
  if (!env.CURSOR_API_KEY) missing.push('CURSOR_API_KEY');
  const hasApp = Boolean(env.AGENT_PIPELINE_APP_ID && env.AGENT_PIPELINE_APP_PRIVATE_KEY);
  const hasToken = Boolean(env.AGENT_PIPELINE_GITHUB_TOKEN || env.GITHUB_TOKEN);
  if (!hasApp && !hasToken) missing.push('GITHUB_CREDENTIALS');
  if (!env.GITHUB_REPOSITORY && !env.AGENT_PIPELINE_REPOSITORY) missing.push('GITHUB_REPOSITORY');
  return { ok: missing.length === 0, mode: 'live', missing, hasApp, hasToken };
}
