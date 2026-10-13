import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isSalesReleaseBranch, validateSalesRelease } from './lib/sales-release.mjs';

const PRODUCT_FRONTEND = /^(app\/(?!api\/)|components\/|public\/|styles\/).+|\.css$/;
const PRODUCT_BACKEND = /^(app\/api\/|lib\/|supabase\/|scripts\/)/;
const OPERATIONS = /^(tools\/agent-pipeline\/|tests\/agent-pipeline\/|\.github\/agent-pipeline\/|\.github\/workflows\/agent-|docs\/sc-ops-002|docs\/AGENT_PIPELINE\.md|docs\/AGENT_WORKFLOW\.md|AGENTS\.md|\.cursor\/rules\/skillcheck-agent-pipeline\.mdc)/;

export function classify({ files, body, base, headRef, statuses = null, modes = null }) {
  const metadata = parseMetadata(body);
  const missing = ['TASK', 'SCOPE', 'LEVEL', 'OWNER_APPROVAL', 'PRODUCTION_APPROVAL', 'REVIEW_VERDICT', 'PROMOTION']
    .filter(field => !metadata[field]);
  if (missing.length > 0) return { ok: false, errors: missing.map(field => `Missing PR metadata field: ${field}`) };

  let frontend = false;
  let backend = false;
  let operations = false;
  let database = false;
  let security = false;
  for (const file of files) {
    if (PRODUCT_BACKEND.test(file)) backend = true;
    else if (PRODUCT_FRONTEND.test(file)) frontend = true;
    if (OPERATIONS.test(file)) operations = true;
    if (file.startsWith('supabase/migrations/')) {
      database = true;
      security = true;
    }
    if (/auth|rls|billing|screening-worker|security/i.test(file)) security = true;
  }

  let detected = 'OPERATIONS';
  if (frontend && backend) detected = 'FULLSTACK';
  else if (backend) detected = 'BACKEND';
  else if (frontend) detected = 'FRONTEND';

  const errors = [];
  if (metadata.SCOPE !== detected) errors.push(`Declared SCOPE=${metadata.SCOPE} but changed files classify as ${detected}`);
  if ((database || security || operations) && metadata.LEVEL !== 'L3') errors.push('DB, security, or controller changes require LEVEL: L3');
  if (base === 'main' && (headRef !== 'integration' || metadata.PROMOTION !== 'YES')) {
    if (isSalesReleaseBranch(headRef) || metadata.RELEASE_KIND === 'SALES_MVP_INTAKE') {
      const policy = validateSalesRelease({ files, statuses, modes, base, headRef, metadata });
      errors.push(...policy.errors);
    } else {
      errors.push('Only integration -> main or a separately approved, guarded sales intake release may target main');
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    detected,
    operations,
    database,
    security,
    level: metadata.LEVEL,
    scope: metadata.SCOPE,
  };
}

function parseMetadata(body) {
  const fields = {};
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = /^([A-Z_]+):\s*(\S.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function changedFiles(base) {
  // -z + --no-renames exposes deleted source paths, odd filenames, type
  // changes and symlink attempts rather than silently hiding rename sources.
  const args = ['diff', '--no-renames', '--name-status', '-z', `origin/${base}...HEAD`];
  let result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    result = spawnSync('git', ['diff', '--no-renames', '--name-status', '-z', `${base}...HEAD`], { encoding: 'utf8' });
  }
  if (result.status !== 0) throw new Error('Cannot verify changed files: ' + result.stderr);
  const parts = result.stdout.split('\0').filter(Boolean);
  if (parts.length % 2 !== 0) throw new Error('Malformed git name-status output');
  const files = [], statuses = [], modes = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i], path = parts[i+1];
    if (!/^[A-Z]+$/.test(status)) throw new Error('Unexpected git status: ' + status);
    files.push(path);
    statuses.push(status);
    const out = spawnSync('git', ['ls-files', '--stage', '--', path], { encoding: 'utf8' });
    if (out.status !== 0) throw new Error('Cannot verify file mode for ' + path);
    const match = /^([0-9]{6}) [0-9a-f]{40,64} [0-9]+\t/.exec(out.stdout);
    modes.push(match ? match[1] : null);
  }
  return { files, statuses, modes };
}

function main() {
  const args = process.argv.slice(2);
  const readArg = name => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  let body = '';
  let files = [];
  let statuses = null;
  let modes = null;
  let base = 'integration';
  let headRef = '';
  if (readArg('--body-file')) {
    body = readFileSync(readArg('--body-file'), 'utf8');
    files = readFileSync(readArg('--files-file'), 'utf8').split('\n').filter(Boolean);
    if (readArg('--statuses-file')) statuses = readFileSync(readArg('--statuses-file'), 'utf8').split('\n').filter(Boolean);
    if (readArg('--modes-file')) modes = readFileSync(readArg('--modes-file'), 'utf8').split('\n').filter(Boolean);
    base = readArg('--base') ?? base;
    headRef = readArg('--head') ?? '';
  } else if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    body = event.pull_request?.body ?? '';
    base = event.pull_request?.base?.ref ?? 'integration';
    headRef = event.pull_request?.head?.ref ?? '';
    ({ files, statuses, modes } = changedFiles(base));
  } else {
    throw new Error('Missing pull request event');
  }
  const result = classify({ files, body, base, headRef, statuses, modes });
  if (!result.ok) {
    for (const error of result.errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ detected: result.detected, operations: result.operations, level: result.level }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
