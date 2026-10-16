// Production rule change: an exception is only a scope classification, never an approval.
// The Sales selective scope verified status MUST come from a trusted, protected
// main-side pull_request_target workflow; the candidate PR cannot attest itself.
const SALES_INTAKE_BRANCH = 'release/sales-mvp-intake-20261013';
const SEED_BRANCH = 'governance/sales-selective-main-gate-20261016';
const SEED_BASE_SHA = '76760b7ffb7e95231fc7af313cc67bc8d36fefe1';
const SALES_INTAKE_FILES = Object.freeze(["app/preselekcja/page.tsx","app/components/marketing/home-page.tsx","app/components/marketing/site-header.tsx","app/components/marketing/package-comparison.tsx","tests/marketing-http.test.mjs"]);
const SEED_FILES = Object.freeze([".github/workflows/sales-selective-scope.yml","AGENTS.md","docs/sales-selective-governance-install.md","tests/agent-pipeline/sales-selective-governance.test.mjs","tools/agent-pipeline/classify-pr.mjs","tools/agent-pipeline/lib/sales-release-verified.mjs","tools/agent-pipeline/lib/sales-trusted-runner.mjs"]);
function exactFiles(files,allowed) {
  return Array.isArray(files) && files.length === allowed.length &&
    new Set(files).size === allowed.length && files.every(f => allowed.includes(f));
}
function allowedMainException({base,headRef,baseSha,metadata,files}) {
  if(base !== 'main' || metadata.PROMOTION !== 'YES' || metadata.LEVEL !== 'L3') return false;
  if(headRef === SALES_INTAKE_BRANCH)
    return metadata.SCOPE === 'FRONTEND' && metadata.RELEASE_KIND === 'SALES_MVP_INTAKE' &&
      exactFiles(files,SALES_INTAKE_FILES);
  // Single-use governance seed, pinned to the original main SHA. After main
  // advances this exception becomes unreachable, even on a reused branch.
  if(headRef === SEED_BRANCH)
    return baseSha === SEED_BASE_SHA && metadata.SCOPE === 'OPERATIONS' &&
      metadata.RELEASE_KIND === 'GOVERNANCE_SEED' && exactFiles(files,SEED_FILES);
  return false;
}

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PRODUCT_FRONTEND = /^(app\/(?!api\/)|components\/|public\/|styles\/).+|\.css$/;
const PRODUCT_BACKEND = /^(app\/api\/|lib\/|supabase\/|scripts\/)/;
const OPERATIONS = /^(tools\/agent-pipeline\/|tests\/agent-pipeline\/|\.github\/agent-pipeline\/|\.github\/workflows\/agent-|docs\/sc-ops-002|docs\/AGENT_PIPELINE\.md|docs\/AGENT_WORKFLOW\.md|AGENTS\.md|\.cursor\/rules\/skillcheck-agent-pipeline\.mdc)/;

export function classify({ files, body, base, headRef, baseSha }) {
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
  if (base === 'main' && (headRef !== 'integration' || metadata.PROMOTION !== 'YES') &&
      !allowedMainException({base,headRef,baseSha,metadata,files})) {
    errors.push('Only an integration -> main promotion may target main (approval is validated separately)');
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
  const diff = spawnSync('git', ['diff', '--name-only', `origin/${base}...HEAD`], { encoding: 'utf8' });
  if (diff.status !== 0) {
    const fallback = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
    if (fallback.status !== 0) throw new Error(diff.stderr || fallback.stderr);
    return fallback.stdout.split('\n').filter(Boolean);
  }
  return diff.stdout.split('\n').filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const readArg = name => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  let body = '';
  let files = [];
  let base = 'integration';
  let headRef = '';
  let baseSha = '';
  if (readArg('--body-file')) {
    body = readFileSync(readArg('--body-file'), 'utf8');
    files = readFileSync(readArg('--files-file'), 'utf8').split('\n').filter(Boolean);
    base = readArg('--base') ?? base;
    headRef = readArg('--head') ?? '';
    baseSha = readArg('--base-sha') ?? '';
  } else if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    body = event.pull_request?.body ?? '';
    base = event.pull_request?.base?.ref ?? 'integration';
    headRef = event.pull_request?.head?.ref ?? '';
    baseSha = event.pull_request?.base?.sha ?? '';
    files = changedFiles(base);
  } else {
    throw new Error('Missing pull request event');
  }
  const result = classify({ files, body, base, headRef, baseSha });
  if (!result.ok) {
    for (const error of result.errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ detected: result.detected, operations: result.operations, level: result.level }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
