import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function allowPreviewWrites(text) {
  const policy = JSON.parse(text);
  if (!policy || Array.isArray(policy)
    || Object.keys(policy).sort().join(',') !== 'baselineSha,enabled'
    || typeof policy.enabled !== 'boolean'
    || typeof policy.baselineSha !== 'string'
    || !/^[a-f0-9]{40}$/.test(policy.baselineSha)) {
    throw new Error('Invalid preview freeze policy');
  }
  return policy.enabled === false;
}

export function runGuard({ read = readFileSync, output = process.env.GITHUB_OUTPUT } = {}) {
  // No branch argument or environment override: this script and policy must be
  // checked out together from the trusted integration branch by the preflight.
  let allow = false;
  let valid = false;
  try {
    allow = allowPreviewWrites(read(new URL('../config/preview-freeze.json', import.meta.url), 'utf8'));
    valid = true;
  } catch {
    console.error('::error::Preview freeze policy unavailable or invalid; writes denied.');
  }
  if (output) appendFileSync(output, `allow=${allow}\n`);
  console.log(allow ? 'Preview writes permitted by trusted policy.' : 'Preview writes held by trusted policy.');
  return valid ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runGuard();
}
