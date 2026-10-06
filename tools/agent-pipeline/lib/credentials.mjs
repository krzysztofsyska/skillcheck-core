export const CONTROLLER_SECRET_NAMES = [
  'CURSOR_API_KEY',
  'OPENAI_API_KEY',
  'AGENT_PIPELINE_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

const SHARED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_VERSION', 'CI'];

export function environmentFor(job, source = {}) {
  if (job === 'ci') {
    const env = {};
    for (const key of SHARED_ENV) if (source[key] !== undefined) env[key] = source[key];
    return env;
  }
  if (job === 'review') {
    const env = {};
    for (const key of SHARED_ENV) if (source[key] !== undefined) env[key] = source[key];
    return env;
  }
  if (job === 'cursor') {
    const env = {};
    for (const key of SHARED_ENV) if (source[key] !== undefined) env[key] = source[key];
    if (source.CURSOR_API_KEY) env.CURSOR_API_KEY = source.CURSOR_API_KEY;
    return env;
  }
  if (job === 'publish' || job === 'controller') {
    const env = {};
    for (const key of SHARED_ENV) if (source[key] !== undefined) env[key] = source[key];
    if (source.AGENT_PIPELINE_APP_PRIVATE_KEY) env.AGENT_PIPELINE_APP_PRIVATE_KEY = source.AGENT_PIPELINE_APP_PRIVATE_KEY;
    return env;
  }
  throw new Error(`Unknown job ${job}`);
}

export function leakedControllerSecrets(env, secretValues) {
  const haystack = JSON.stringify(env);
  return secretValues.filter(value => value && haystack.includes(value));
}

export function asData(text) {
  return { kind: 'data', text: String(text ?? '') };
}
