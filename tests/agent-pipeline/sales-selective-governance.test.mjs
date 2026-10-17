import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { inspectSalesReleaseGit, REVIEWED_SALES_BLOBS } from '../../tools/agent-pipeline/lib/sales-release-verified.mjs';

const meta=(scope,kind)=>['TASK: SC-SALES-RELEASE','SCOPE: '+scope,'LEVEL: L3',
  'OWNER_APPROVAL: PENDING','PRODUCTION_APPROVAL: NO','REVIEW_VERDICT: PENDING',
  'PROMOTION: YES','RELEASE_KIND: '+kind].join('\n');
const sourceFiles=["app/preselekcja/page.tsx","app/components/marketing/home-page.tsx","app/components/marketing/site-header.tsx","app/components/marketing/package-comparison.tsx","tests/marketing-http.test.mjs"];
const seedFiles=[".github/workflows/sales-selective-scope.yml","AGENTS.md","docs/sales-selective-governance-install.md","tests/agent-pipeline/sales-selective-governance.test.mjs","tools/agent-pipeline/classify-pr.mjs","tools/agent-pipeline/lib/sales-release-verified.mjs","tools/agent-pipeline/lib/sales-trusted-runner.mjs"];
const source='release/sales-mvp-intake-20261013';
const seed='governance/sales-selective-main-gate-20261016';
const main='76760b7ffb7e95231fc7af313cc67bc8d36fefe1';
test('one-time governance installation is pinned to old main and exact seven files',()=>{
  const input={files:seedFiles,body:meta('OPERATIONS','GOVERNANCE_SEED'),
    base:'main',headRef:seed,baseSha:main,prNumber:128};
  assert.equal(classify(input).ok,true);
  for(const patch of [{baseSha:'a'.repeat(40)},{prNumber:129},{headRef:'feat/other'},
    {files:[...seedFiles,'app/api/payments/route.ts']},
    {files:seedFiles.slice(1)},{body:meta('OPERATIONS','NO')},
    {files:[...seedFiles.slice(1),seedFiles[1]]}])
    assert.equal(classify({...input,...patch}).ok,false,JSON.stringify(patch));
});
test('only the five reviewed intake paths classify as special promotion',()=>{
  const input={files:sourceFiles,body:meta('FRONTEND','SALES_MVP_INTAKE'),
    base:'main',headRef:source,baseSha:main,prNumber:120};
  assert.equal(classify(input).ok,true);
  for(const patch of [{prNumber:129},{headRef:'release/other'},{files:['app/preselekcja/page.tsx']},
    {files:[...sourceFiles,'supabase/migrations/0001.sql']},
    {files:[...sourceFiles.slice(1),sourceFiles[1]]},
    {body:meta('FRONTEND','NO')},{body:meta('OPERATIONS','SALES_MVP_INTAKE')},
    {base:'integration',files:['app/api/payment.ts']}])
    assert.equal(classify({...input,...patch}).ok,false,JSON.stringify(patch));
});
test('standard integration promotion stays unchanged, and untrusted metadata never authorizes production',()=>{
  assert.equal(classify({files:['app/page.tsx'],body:meta('FRONTEND','STANDARD'),
    base:'main',headRef:'integration'}).ok,true);
  assert.equal(inspectSalesReleaseGit({baseSha:main,headSha:'a'.repeat(40)}).authorizedForProduction,false);
  assert.equal(Object.keys(REVIEWED_SALES_BLOBS).length,5);
});
test('trusted workflow never checks out, imports or executes candidate code',()=>{
  const y=readFileSync('.github/workflows/sales-selective-scope.yml','utf8');
  assert.match(y,/pull_request_target:/);
  assert.match(y,/persist-credentials: false/);
  assert.match(y,/ref: .*github.event.pull_request.base.sha/);
  assert.doesNotMatch(y,/ref: .*github.event.pull_request.head.sha/);
  assert.ok(y.includes('node tools/agent-pipeline/lib/sales-trusted-runner.mjs'));
  assert.equal(y.includes('secrets.'),false);
  assert.doesNotMatch(y,/git checkout .*release/);
});

// Regression tests exercise the actual read-only entrypoint. No live GitHub
// credential, external request, approval, agent run or deployment is performed.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { checkTrustedSalesRelease } from '../../tools/agent-pipeline/lib/sales-trusted-runner.mjs';

function protectionFixture(t, mutate = () => {}) {
  const contexts = ['verify', 'Agent contract / scope gate', 'Sales selective scope verified',
    'Sales owner acceptance', 'Sales production approval'];
  const rule = {
    id: 17, enforcement: 'active', target: 'branch', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: {
        required_approving_review_count: 1, dismiss_stale_reviews_on_push: true,
        require_last_push_approval: true, required_review_thread_resolution: true,
      } },
      { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: contexts.map(context => ({ context, integration_id: context.startsWith('Sales ')?8888:15368 })),
      } },
    ],
  };
  const pr = { number: 120, state: 'open', draft: false,
    base: { ref: 'main', sha: main },
    head: { ref: source, sha: 'c'.repeat(40), repo: { full_name: 'krzysztofsyska/skillcheck-core' } },
  };
  mutate(rule);
  let liveReads = 0;
  const token = process.env.GITHUB_TOKEN;
  const publisher = process.env.SALES_RELEASE_PUBLISHER_APP_ID;
  process.env.SALES_RELEASE_PUBLISHER_APP_ID = '8888';
  process.env.GITHUB_TOKEN = 'synthetic-read-only-test-token';
  t.after(() => {
    if (publisher === undefined) delete process.env.SALES_RELEASE_PUBLISHER_APP_ID;
    else process.env.SALES_RELEASE_PUBLISHER_APP_ID = publisher;
    if (token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = token;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.github.com');
    const prefix = '/repos/krzysztofsyska/skillcheck-core/';
    assert.ok(target.pathname.startsWith(prefix));
    const path = target.pathname.slice(prefix.length);
    if (path === 'branches/main') return Response.json({ protected: true });
    if (path === 'rulesets') return Response.json([{ id: 17, enforcement: 'active' }]);
    if (path === 'rulesets/17') return Response.json(rule);
    if (path === 'pulls/120') { liveReads++; return Response.json(pr); }
    assert.fail('Unexpected API request: ' + path);
  });
  return { event: { repository: { full_name: 'krzysztofsyska/skillcheck-core' }, pull_request: pr },
    // The fixture intentionally has no valid Git repository: a correct
    // protection snapshot reaches (but does not pass) the separate Git audit.
    cwd: new URL('./absent-sales-release-fixture', import.meta.url).pathname,
    liveReads: () => liveReads,
  };
}

for (const strict of [false, undefined, 'true']) {
  test(`required status policy rejects non-boolean strict=${String(strict)}`, async t => {
    const f = protectionFixture(t, r => { r.rules[3].parameters.strict_required_status_checks_policy = strict; });
    await assert.rejects(checkTrustedSalesRelease(f), /main does not require Checks CI/);
    assert.equal(f.liveReads(), 0);
  });
}
for (const index of [0, 1, 2]) {
  for (const integration of [undefined, null, 0, 123, '15368']) {
    test(`required context ${index} rejects untrusted integration ${String(integration)}`, async t => {
      const f = protectionFixture(t, r => { r.rules[3].parameters.required_status_checks[index].integration_id = integration; });
      await assert.rejects(checkTrustedSalesRelease(f), /main does not require/);
      assert.equal(f.liveReads(), 0);
    });
  }
}
for (const excluded of ['refs/heads/*', 'refs/**', '~ALL', 'refs/heads/main', '~DEFAULT_BRANCH']) {
  test(`main policy rejects exclusion ${excluded}`, async t => {
    const f = protectionFixture(t, r => { r.conditions.ref_name.exclude = [excluded]; });
    await assert.rejects(checkTrustedSalesRelease(f), /main ruleset missing/);
    assert.equal(f.liveReads(), 0);
  });
}
for (const bypass of [undefined, null, {}, [{ actor_type: 'RepositoryRole', actor_id: 5 }]]) {
  test(`main policy rejects absent, malformed or nonempty bypass ${JSON.stringify(bypass)}`, async t => {
    const f = protectionFixture(t, r => { r.bypass_actors = bypass; });
    await assert.rejects(checkTrustedSalesRelease(f), /main ruleset.*bypass/);
    assert.equal(f.liveReads(), 0);
  });
}
for (const approved of [false, undefined, 'true']) {
  test(`review policy requires independent latest push approval ${String(approved)}`, async t => {
    const f = protectionFixture(t, r => { r.rules[2].parameters.require_last_push_approval = approved; });
    await assert.rejects(checkTrustedSalesRelease(f), /main lacks independent approval/);
    assert.equal(f.liveReads(), 0);
  });
}
for (const resolution of [false, undefined, 'true']) {
  test(`protection requires thread resolution exactly true, received ${String(resolution)}`, async t => {
    const f = protectionFixture(t, r => { r.rules[2].parameters.required_review_thread_resolution = resolution; });
    await assert.rejects(checkTrustedSalesRelease(f), /main lacks independent approval/);
    assert.equal(f.liveReads(), 0);
  });
}
test('strict, pinned, non-bypassable protection reaches but cannot replace the Git audit', async t => {
  const f = protectionFixture(t);
  await assert.rejects(checkTrustedSalesRelease(f), /Git history\/blobs rejected/);
  assert.equal(f.liveReads(), 1);
});

// Git command doubles reproduce a clean final tree with an unreviewed object
// in an earlier commit. This is deterministic contract coverage, not LIVE E2E.
function historyFixture(t, unreviewed = false) {
  const baseSha = 'a'.repeat(40), middle = 'b'.repeat(40), headSha = 'c'.repeat(40);
  const firstPath = sourceFiles[0];
  const original = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'rev-parse') return args.includes('refs/remotes/origin/main') ? baseSha : headSha;
    if (args[0] === 'merge-base') return baseSha;
    if (args[0] === 'rev-list') return `${middle} ${baseSha}\n${headSha} ${middle}\n`;
    if (args[0] === 'diff-tree') {
      const paths = args.at(-1) === middle ? [firstPath] : unreviewed ? sourceFiles : sourceFiles.slice(1);
      return paths.map(path => `M\0${path}\0`).join('');
    }
    if (args[0] === 'diff') return sourceFiles.map(path => `M\0${path}\0`).join('');
    if (args[0] === 'ls-tree') {
      const path = args.at(-1);
      assert.ok(Object.hasOwn(REVIEWED_SALES_BLOBS, path));
      const blob = unreviewed && args[2] === middle ? 'd'.repeat(40) : REVIEWED_SALES_BLOBS[path];
      return `100644 blob ${blob}\t${path}\n`;
    }
    if (args[0] === 'show') return 'synthetic content not matching any secret heuristic\n';
    assert.fail('Unexpected Git operation: ' + args[0]);
  });
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  return { baseSha, headSha, headRef: source };
}
test('only reviewed historical blobs pass, and scope never authorizes Production', t => {
  const result = inspectSalesReleaseGit(historyFixture(t));
  assert.deepEqual(result, { ok: true, authorizedForProduction: false, errors: [] });
});
test('restoring a reviewed final blob cannot hide unreviewed historical contents', t => {
  const result = inspectSalesReleaseGit(historyFixture(t, true));
  assert.equal(result.ok, false);
  assert.equal(result.authorizedForProduction, false);
  assert.ok(result.errors.some(error => error.includes('Unreviewed historical content: ' + sourceFiles[0])));
  assert.equal(result.errors.some(error => error.includes('Unreviewed final content')), false);
  assert.equal(result.errors.some(error => error.includes('Potential embedded credential')), false,
    'hash-pinned history must reject content even when secret regexes do not match');
});

// PR #128 re-review regressions: protect the ordinary modification path,
// literal main targeting and one-command read authentication after checkout.
import * as trustedRunner from '../../tools/agent-pipeline/lib/sales-trusted-runner.mjs';
const trustedWorkflow = '.github/workflows/sales-selective-scope.yml';
for (const level of ['L1', 'L2', 'L3']) {
  test(`ordinary trusted workflow edit requires L3, declared ${level}`, () => {
    const result = classify({
      files: [trustedWorkflow], body: meta('OPERATIONS', 'STANDARD').replace('LEVEL: L3', `LEVEL: ${level}`),
      base: 'integration', headRef: 'fix/sales-workflow', prNumber: 999,
    });
    assert.equal(result.operations, true);
    assert.equal(result.security, true);
    assert.equal(result.ok, level === 'L3');
    if (level !== 'L3') assert.ok(result.errors.some(error => error.includes('require LEVEL: L3')));
  });
}
test('adding a frontend path cannot downgrade the trusted workflow edit', () => {
  const result = classify({
    files: [trustedWorkflow, 'app/page.tsx'],
    body: meta('FRONTEND', 'STANDARD').replace('LEVEL: L3', 'LEVEL: L1'),
    base: 'integration', headRef: 'fix/sales-workflow', prNumber: 999,
  });
  assert.equal(result.ok, false);
  assert.equal(result.operations, true);
  assert.equal(result.security, true);
});
for (const include of [['~DEFAULT_BRANCH'], ['refs/heads/integration', '~DEFAULT_BRANCH']]) {
  test(`nonliteral main protection is rejected: ${include.join(',')}`, async t => {
    const f = protectionFixture(t, rule => { rule.conditions.ref_name.include = include; });
    await assert.rejects(checkTrustedSalesRelease(f), /main ruleset missing/);
    assert.equal(f.liveReads(), 0);
  });
}
test('an explicit main selector remains valid alongside an unrelated default selector', async t => {
  const f = protectionFixture(t, rule => { rule.conditions.ref_name.include = ['refs/heads/main', '~DEFAULT_BRANCH']; });
  await assert.rejects(checkTrustedSalesRelease(f), /Git history\/blobs rejected/);
  assert.equal(f.liveReads(), 1);
});
test('release fetch uses ephemeral URL-scoped authentication with no credential persistence', t => {
  const env = { PATH: process.env.PATH, GITHUB_TOKEN: 'synthetic-read-only-fetch-token',
    GIT_TRACE: '/tmp/not-used', GIT_CURL_VERBOSE: '1', GIT_CONFIG_PARAMETERS: 'not-used' };
  const before = { ...env };
  const original = childProcess.execFileSync;
  let call;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    call = { command, args, options };
    return '';
  });
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  trustedRunner.fetchTrustedRelease({ env, cwd: '/synthetic/trusted-checkout' });
  assert.deepEqual(env, before, 'do not mutate environment for later steps');
  assert.equal(call.command, 'git');
  assert.deepEqual(call.args, ['fetch', '--no-tags', '--no-recurse-submodules', '--',
    'https://github.com/krzysztofsyska/skillcheck-core.git',
    '+refs/heads/release/sales-mvp-intake-20261013:refs/heads/release/sales-mvp-intake-20261013']);
  assert.equal(call.options.cwd, '/synthetic/trusted-checkout');
  assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(call.options.timeout, 60000);
  assert.equal(JSON.stringify(call.args).includes(env.GITHUB_TOKEN), false);
  assert.equal(call.options.env.GIT_CONFIG_COUNT, '3');
  assert.equal(call.options.env.GIT_CONFIG_KEY_0,
    'http.https://github.com/krzysztofsyska/skillcheck-core.git.extraheader');
  assert.equal(call.options.env.GIT_CONFIG_VALUE_0,
    'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + env.GITHUB_TOKEN).toString('base64'));
  assert.equal(call.options.env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(call.options.env.GIT_CONFIG_VALUE_1, '');
  assert.equal(call.options.env.GIT_CONFIG_KEY_2, 'http.followRedirects');
  assert.equal(call.options.env.GIT_CONFIG_VALUE_2, 'false');
  assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(call.options.env.GIT_TRACE, undefined);
  assert.equal(call.options.env.GIT_CURL_VERBOSE, undefined);
  assert.equal(call.options.env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(call.options.env.GITHUB_TOKEN, undefined, 'Git receives only the scoped header');
  const configEnv = { ...call.options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  // CI's application checkout may retain its own host-wide auth header.
  // Test this command's config in a fresh repository, never read the runner's
  // credential-bearing .git/config and never delete its authentication.
  const configCwd = mkdtempSync(join(tmpdir(), 'skillcheck-git-config-'));
  t.after(() => rmSync(configCwd, { recursive: true, force: true }));
  const init = childProcess.spawnSync('git', ['init', '--quiet', configCwd],
    { env: configEnv, encoding: 'utf8' });
  assert.equal(init.status, 0, 'isolated Git configuration fixture must initialize');
  const matched = childProcess.spawnSync('git', ['config', '--get-urlmatch', 'http.extraheader',
    'https://github.com/krzysztofsyska/skillcheck-core.git'], { cwd: configCwd, env: configEnv, encoding: 'utf8' });
  assert.equal(matched.status, 0);
  assert.equal(matched.stdout.trim(), call.options.env.GIT_CONFIG_VALUE_0);
  const unrelated = childProcess.spawnSync('git', ['config', '--get-urlmatch', 'http.extraheader',
    'https://github.com/unrelated/repository.git'], { cwd: configCwd, env: configEnv, encoding: 'utf8' });
  assert.equal(unrelated.status, 1);
  assert.equal(unrelated.stdout, '');
});
test('release fetch refuses missing credentials before invoking git', t => {
  const original = childProcess.execFileSync;
  let calls = 0;
  t.mock.method(childProcess, 'execFileSync', () => { calls++; });
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  for (const token of [undefined, '', 'short']) {
    assert.throws(() => trustedRunner.fetchTrustedRelease({ env: { GITHUB_TOKEN: token } }),
      /read-only GitHub token missing/);
  }
  assert.equal(calls, 0);
});
test('failed authenticated fetch never reflects git output or credentials', t => {
  const original = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('private-git-output-with-synthetic-read-only-fetch-token');
  });
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  assert.throws(() => trustedRunner.fetchTrustedRelease({
    env: { GITHUB_TOKEN: 'synthetic-read-only-fetch-token' },
  }), error => error.message === 'SALES_RELEASE_SCOPE_DENIED: authenticated release fetch failed');
});
test('workflow uses trusted fetch and permits only check publication, not approval or repository writes', () => {
  const y = readFileSync(trustedWorkflow, 'utf8');
  assert.match(y, /run: node tools\/agent-pipeline\/lib\/sales-trusted-runner\.mjs --fetch-release-ref/);
  const fetchStep = y.slice(y.indexOf('- name: Fetch exact release ref'), y.indexOf('- name: Verify live main rules'));
  assert.match(fetchStep, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(y, /(?:contents|pull-requests|statuses|actions|administration|deployments): write/);
  assert.doesNotMatch(y, /persist-credentials: true|git config --(?:global|local)|run: git fetch/);
});

// P1 release-gate composition. These use actual adapters and cryptographic
// verification with synthetic GitHub HTTP responses; no live service is used.
import { createHash, generateKeyPairSync, sign as signToken, verify as verifyToken, createPublicKey } from 'node:crypto';
const REPO = 'krzysztofsyska/skillcheck-core';
const REPO_ID = 1043384454, OWNER_ID = 222297538;
const WF = '.github/workflows/sales-selective-scope.yml';
const T = Date.parse('2026-10-17T13:00:00Z');
const bindingFor = () => ({ version: 1, repositoryId: REPO_ID, pr: 120,
  head: 'c'.repeat(40), base: main, runId: 7001, attempt: 1, event: 'pull_request_target', publisherAppId: 8888 });
const hashObject = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function liveFixture(binding = bindingFor()) {
  const checks = new Map(), writes = [], reads = [];
  let serial = 1000;
  const repo = { id: REPO_ID, full_name: REPO, fork: false };
  const pull = { number: 120, state: 'open', draft: false, merged: false,
    base: { ref: 'main', sha: binding.base, repo }, head: { ref: source, sha: binding.head, repo } };
  const branch = { name: 'main', protected: true, commit: { sha: binding.base } };
  const run = { id: binding.runId, run_attempt: binding.attempt, event: binding.event,
    path: `${WF}@main`, workflow_id: 901, head_sha: binding.base, repository: repo, status: 'in_progress' };
  const environments = Object.fromEntries(['owner-acceptance', 'production-approval'].map((name, index) => [name, {
    id: 51 + index, name, protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { id: OWNER_ID, login: 'krzysztofsyska', type: 'User' } }] }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  }]));
  const policies = { total_count: 1, branch_policies: [{ id: 1, name: 'main', type: 'branch' }] };
  const fixture = { binding, checks, writes, reads, pull, branch, run, environments, policies, history: [] };
  fixture.api = async (path, options = {}) => {
    if (!options.method || options.method === 'GET') {
      reads.push(path);
      if (path === 'pulls/120') return structuredClone(pull);
      if (path === 'branches/main') return structuredClone(branch);
      if (path === `actions/runs/${binding.runId}`) return structuredClone(run);
      if (path === 'actions/workflows/sales-selective-scope.yml') return {id:901,path:WF,state:'active'};
      if (path === `actions/runs/${binding.runId}/approvals`) return structuredClone(fixture.history);
      if (path.startsWith('environments/')) {
        const name = path.split('/')[1];
        if (!environments[name]) assert.fail('Unknown environment');
        return structuredClone(path.includes('/deployment-branch-policies') ? policies : environments[name]);
      }
      if (/^check-runs\/[0-9]+$/.test(path)) return structuredClone(checks.get(Number(path.split('/')[1])));
      assert.fail('Unexpected GET: ' + path);
    }
    writes.push({ path, ...structuredClone(options) });
    if (path === 'check-runs' && options.method === 'POST') {
      const check = { ...structuredClone(options.body), id: ++serial, app: { id: binding.publisherAppId }, conclusion: null };
      checks.set(check.id, check); return structuredClone(check);
    }
    if (/^check-runs\/[0-9]+$/.test(path) && options.method === 'PATCH') {
      const check = checks.get(Number(path.split('/')[1]));
      assert.ok(check);Object.assign(check, structuredClone(options.body));return structuredClone(check);
    }
    assert.fail('Unexpected mutation: ' + path);
  };
  fixture.approve = name => ({ state: 'approved', user: { id: OWNER_ID, login: 'krzysztofsyska', type: 'User' },
    environments: [{ id: environments[name].id, name }], comment: 'synthetic owner decision' });
  fixture.env = { GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: binding.base,
    GITHUB_WORKFLOW_SHA: binding.base, GITHUB_WORKFLOW_REF: `${REPO}/${WF}@refs/heads/main`,
    SALES_RELEASE_PUBLISHER_APP_ID: String(binding.publisherAppId), GITHUB_RUN_ID: String(binding.runId), GITHUB_RUN_ATTEMPT: String(binding.attempt), GITHUB_EVENT_NAME: binding.event };
  fixture.event = { repository: repo, pull_request: pull, inputs: { expected_head: binding.head, expected_base: binding.base } };
  return fixture;
}
function stageArgs(f, ids, stage, overrides = {}) {
  return { binding: f.binding, ids, stage, api: f.api,
    protectionCheck: async () => ({ fresh: true }),
    scopeCheck: async () => ({ scopeVerified: true, authorizedForProduction: false }), ...overrides };
}

test('initialize explicitly creates all three blocking checks on candidate, never base SHA', async () => {
  const f = liveFixture();
  assert.deepEqual(await trustedRunner.captureSalesBinding({ event: f.event, env: f.env, api: f.api }), f.binding);
  const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);
  assert.equal(new Set(Object.values(ids)).size, 3);
  assert.equal(f.writes.length, 3);
  for (const [stage, id] of Object.entries(ids)) {
    const check = f.checks.get(id);
    assert.equal(check.name, trustedRunner.SALES_CHECKS[stage]);
    assert.equal(check.head_sha, f.binding.head);
    assert.notEqual(check.head_sha, f.binding.base);
    assert.equal(check.status, 'in_progress');
    assert.equal(check.external_id, `sc-sales-v1:${hashObject(f.binding)}:${stage}`);
    assert.ok(check.output.summary.includes(f.binding.base));
  }
});

test('lost check creation response never blindly issues a second POST', async () => {
  const f = liveFixture();let calls = 0;
  const api = async (path, options) => {
    if (options?.method === 'POST') { calls++; await f.api(path, options); throw new Error('lost response'); }
    return f.api(path, options);
  };
  await assert.rejects(trustedRunner.initializeSalesChecks(f.binding, api), /lost response/);
  assert.equal(calls, 1);
  assert.equal(f.checks.size, 1);
  assert.equal([...f.checks.values()][0].status, 'in_progress');
});

for (const change of [
  f => { f.pull.head.sha = 'd'.repeat(40); },
  f => { f.branch.commit.sha = 'd'.repeat(40); },
  f => { f.pull.base.sha = 'd'.repeat(40); },
  f => { f.pull.draft = true; },
  f => { f.pull.head.repo.fork = true; },
  f => { f.run.run_attempt = 2; },
  f => { f.run.path = '.github/workflows/evil.yml'; },
  f => { f.run.head_sha = f.binding.head; },
  f => { f.run.status = 'completed'; },
]) test('moved or untrusted target cannot initialize green candidate checks: ' + change.toString(), async () => {
  const f = liveFixture();change(f);
  await assert.rejects(trustedRunner.initializeSalesChecks(f.binding, f.api));
  assert.equal(f.writes.length, 0);
});

test('manual retry requires fresh run and exact explicit HEAD/base, not rerun reuse', async () => {
  const binding = { ...bindingFor(), event: 'workflow_dispatch' }, f = liveFixture(binding);
  assert.deepEqual(await trustedRunner.captureSalesBinding({ event: f.event, env: f.env, api: f.api }), binding);
  f.event.inputs.expected_head = 'e'.repeat(40);
  await assert.rejects(trustedRunner.captureSalesBinding({ event: f.event, env: f.env, api: f.api }), /Dispatch target moved/);
  const rerun = liveFixture({ ...bindingFor(), attempt: 2 });
  const ids = await trustedRunner.initializeSalesChecks(rerun.binding, rerun.api);
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(rerun, ids, 'scope')), /Fresh workflow run/);
  assert.equal(rerun.checks.get(ids.scope).conclusion, 'failure');
});

test('composed workflow requires scope then two separate native owner decisions', async () => {
  const f = liveFixture();const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);
  let proofs = 0;
  const protectionCheck = async () => { proofs++; };
  await trustedRunner.runSalesStage(stageArgs(f, ids, 'scope', { protectionCheck }));
  assert.equal(f.checks.get(ids.scope).conclusion, 'success');
  assert.equal(f.checks.get(ids.owner).status, 'in_progress');
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(f, ids, 'owner', { protectionCheck })), /Missing or ambiguous/);
  assert.notEqual(f.checks.get(ids.owner).conclusion, 'success');
  // A fresh independent fixture represents the successful, non-rerun sequence.
  const g = liveFixture();const goodIds = await trustedRunner.initializeSalesChecks(g.binding, g.api);
  await trustedRunner.runSalesStage(stageArgs(g, goodIds, 'scope', { protectionCheck }));
  g.history.push(g.approve('owner-acceptance'));
  await trustedRunner.runSalesStage(stageArgs(g, goodIds, 'owner', { protectionCheck }));
  assert.equal(g.checks.get(goodIds.production).status, 'in_progress');
  g.history.push(g.approve('production-approval'));
  await trustedRunner.runSalesStage(stageArgs(g, goodIds, 'production', { protectionCheck }));
  assert.equal([...g.checks.values()].every(check => check.conclusion === 'success'), true);
  assert.ok(proofs >= 8, 'fresh protection is requested before every success publication');
  assert.ok(g.writes.every(write => /^check-runs(?:\/[0-9]+)?$/.test(write.path)));
  assert.ok(g.reads.includes(`actions/runs/${g.binding.runId}/approvals`));
});

for (const mutation of [
  history => { history[0].user.id = 77; },
  history => { history[0].user.login = 'other'; },
  history => { history[0].user.type = 'Bot'; },
  history => { history[0].state = 'rejected'; },
  history => { history[0].environments[0].id = 99; },
  history => { history[0].environments.push({ id: 52, name: 'production-approval' }); },
  history => { history.push(structuredClone(history[0])); },
  history => { history.length = 0; },
]) test('native approval evidence rejects wrong/rejected/ambiguous decisions: ' + mutation.toString(), async () => {
  const f = liveFixture();f.history = [f.approve('owner-acceptance')];mutation(f.history);
  await assert.rejects(trustedRunner.verifySalesApprovals({ binding: f.binding, stage: 'owner', api: f.api }));
});

test('a single combined approval cannot stand for both owner decisions', async () => {
  const f = liveFixture();const approval = f.approve('owner-acceptance');
  approval.environments.push(f.approve('production-approval').environments[0]);f.history = [approval];
  await assert.rejects(trustedRunner.verifySalesApprovals({ binding: f.binding, stage: 'production', api: f.api }));
});
for (const mutation of [
  f => { f.environments['owner-acceptance'].protection_rules = []; },
  f => { f.environments['owner-acceptance'].protection_rules[0].reviewers[0].reviewer.id = 99; },
  f => { f.environments['production-approval'].deployment_branch_policy.custom_branch_policies = false; },
  f => { f.policies.branch_policies[0].name = '*'; },
  f => { f.policies.branch_policies[0].type = 'tag'; },
  f => { f.policies.total_count = 2; },
  f => { f.environments['production-approval'].id = 51; },
]) test('environment verifier refuses weak or unobserved protection: ' + mutation.toString(), async () => {
  const f = liveFixture();mutation(f);
  await assert.rejects(trustedRunner.verifySalesEnvironments(f.api));
});

test('old-run green check cannot unlock this run owner approval', async () => {
  const f = liveFixture();const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);
  Object.assign(f.checks.get(ids.scope), { status: 'completed', conclusion: 'success', external_id: 'sc-sales-v1:old-run:scope' });
  f.history = [f.approve('owner-acceptance')];
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(f, ids, 'owner')), /Check provenance mismatch/);
  assert.equal(f.checks.get(ids.owner).conclusion, 'failure');
});

test('base drift immediately before publication fails the check instead of reusing green', async () => {
  const f = liveFixture();const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);let proofs = 0;
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(f, ids, 'scope', {
    protectionCheck: async () => { if (++proofs === 2) f.branch.commit.sha = 'd'.repeat(40); },
  })), /Candidate head\/base/);
  assert.equal(f.checks.get(ids.scope).conclusion, 'failure');
  assert.equal(f.writes.some(write => write.body?.conclusion === 'success'), false);
});

test('check updates reject foreign app, wrong SHA, wrong ID and wrong external binding', async () => {
  for (const patch of [{ app: { id: 99 } }, { head_sha: main }, { id: 99999 }, { external_id: 'forged' }]) {
    const f = liveFixture();const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);
    Object.assign(f.checks.get(ids.scope), patch);
    await assert.rejects(trustedRunner.publishSalesCheck({ binding: f.binding, ids, stage: 'scope', conclusion: 'success', api: f.api }), /Check provenance/);
    assert.equal(f.writes.length, 3);
  }
});

test('lost success PATCH response produces failure, never an automatic success retry', async () => {
  const f = liveFixture();const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);let successCalls = 0;
  const api = async (path, options) => {
    const result = await f.api(path, options);
    if (options?.body?.conclusion === 'success') { successCalls++;throw new Error('lost PATCH response'); }
    return result;
  };
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(f, ids, 'scope', { api })), /lost PATCH/);
  assert.equal(successCalls, 1);
  assert.equal(f.checks.get(ids.scope).conclusion, 'failure');
});

test('GitHub adapter forbids merge, ruleset, approval and repository writes or another origin', async () => {
  let calls = 0;
  const api = trustedRunner.createSalesGitHub({ token: 'synthetic-gh-token', fetchImpl: async () => { calls++;return Response.json({}); } });
  for (const [path, method] of [['pulls/120/merge', 'PUT'], ['rulesets/25301984', 'PUT'],
    ['actions/runs/7001/pending_deployments', 'POST'], ['git/refs/heads/main', 'PATCH'],
    ['https://evil.test/check-runs', 'GET'], ['../elsewhere', 'GET']]) {
    await assert.rejects(api(path, { method }));
  }
  assert.equal(calls, 0);
});

const signing = generateKeyPairSync('ed25519');
const oidcKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const brokerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pemPublic = signing.publicKey.export({ type: 'spki', format: 'pem' });
const pemPrivate = signing.privateKey.export({ type: 'pkcs8', format: 'pem' });
function completeRule() {
  return { id: 25301984, source: REPO, source_type: 'Repository', target: 'branch', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } }, rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true,
        require_last_push_approval: true, required_review_thread_resolution: true } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
        required_status_checks: ['verify', 'Agent contract / scope gate', ...Object.values(trustedRunner.SALES_CHECKS)]
          .map(context => ({ context, integration_id: context.startsWith('Sales ')?8888:15368 })) } },
    ] };
}
const proofFor = request => ({ version: 1, publisherAppId: request.binding.publisherAppId, requestDigest: hashObject(request), observedAt: T, expiresAt: T + 60000,
  branch: { protected: true, commit: { sha: request.binding.base } }, rules: [completeRule()] });
function envelopeFor(proof, key = signing.privateKey) {
  const bytes = Buffer.from(JSON.stringify(proof));
  return { payload: bytes.toString('base64url'), signature: signToken(null, bytes, key).toString('base64url') };
}
function oidcClaims(request) {
  const b = request.binding;
  return { iss: 'https://token.actions.githubusercontent.com', aud: `skillcheck-sales-protection:${hashObject(request)}`,
    repository_id: String(REPO_ID), repository_owner_id: String(OWNER_ID), repository: REPO,
    workflow_ref: `${REPO}/${WF}@refs/heads/main`, workflow_sha: b.base, ref: 'refs/heads/main', sha: b.base,
    event_name: b.event, run_id: String(b.runId), run_attempt: String(b.attempt),
    iat: Math.floor(T / 1000), nbf: Math.floor(T / 1000), exp: Math.floor(T / 1000) + 300 };
}
function oidcJwt(claims, header = { alg: 'RS256', kid: 'synthetic-oidc-key' }) {
  const text = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${text}.${signToken('RSA-SHA256', Buffer.from(text), oidcKey.privateKey).toString('base64url')}`;
}
const oidcJwks = () => ({ keys: [{ ...oidcKey.publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'synthetic-oidc-key' }] });
const requestFor = () => ({ version: 1, binding: bindingFor(), nonce: 'e'.repeat(64) });

test('signed protection proof validates the exact fresh nonce and candidate binding', () => {
  const request = requestFor(), proof = proofFor(request);
  assert.deepEqual(trustedRunner.verifyProtectionEnvelope({ envelope: envelopeFor(proof), request,
    publicKey: pemPublic, startedAt: T, now: () => T }), proof);
});
for (const mutate of [
  p => { p.requestDigest = 'a'.repeat(64); }, p => { p.observedAt -= 60001; p.expiresAt -= 60001; },
  p => { p.branch.commit.sha = 'd'.repeat(40); }, p => { p.rules[0].id = 9; },
  p => { p.rules[0].source = 'other/repo'; }, p => { p.expiresAt += 1; },
]) test('signed but stale, replayed or misbound protection proof is rejected: ' + mutate.toString(), () => {
  const request = requestFor(), proof = proofFor(request);mutate(proof);
  assert.throws(() => trustedRunner.verifyProtectionEnvelope({ envelope: envelopeFor(proof), request,
    publicKey: pemPublic, startedAt: T, now: () => T }), /stale\/replayed\/misbound/);
});

test('protection proof cannot be forged with another signing key', () => {
  const request = requestFor(), other = generateKeyPairSync('ed25519');
  assert.throws(() => trustedRunner.verifyProtectionEnvelope({ envelope: envelopeFor(proofFor(request), other.privateKey), request,
    publicKey: pemPublic, startedAt: T, now: () => T }), /signature invalid/);
});
for (const [field, value] of Object.entries({ aud: 'wrong', repository_id: '9', repository_owner_id: '9', repository: 'elsewhere/repo',
  workflow_ref: `${REPO}/.github/workflows/other.yml@refs/heads/main`, workflow_sha: 'b'.repeat(40),
  ref: 'refs/heads/evil', sha: 'b'.repeat(40), event_name: 'pull_request', run_id: '999', run_attempt: '2',
  exp: Math.floor(T / 1000) - 1, nbf: Math.floor(T / 1000) + 60 })) {
  test(`OIDC rejects a signed wrong ${field} claim before privileged access`, async () => {
    const request = requestFor(), claims = { ...oidcClaims(request), [field]: value };
    await assert.rejects(trustedRunner.verifyEvidenceOidc({ jwt: oidcJwt(claims), request, now: () => T,
      fetchImpl: async url => { assert.equal(url, 'https://token.actions.githubusercontent.com/.well-known/jwks');return Response.json(oidcJwks()); } }), /OIDC identity\/binding/);
  });
}

test('unsigned or algorithm-substituted OIDC cannot authorize evidence', async () => {
  const request = requestFor();let reads = 0;
  await assert.rejects(trustedRunner.verifyEvidenceOidc({ jwt: oidcJwt(oidcClaims(request), { alg: 'none', kid: 'synthetic-oidc-key' }),
    request, now: () => T, fetchImpl: async () => { reads++;return Response.json(oidcJwks()); } }), /algorithm/);
  assert.equal(reads, 0);
});

function brokerFixture() {
  const f = liveFixture();const calls = [];
  const config = { appId: 8888, installationId: 9999, signingPrivateKey: pemPrivate,
    appPrivateKey: brokerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const env = { SALES_RELEASE_PUBLISHER_APP_ID: '8888', SALES_EVIDENCE_URL: 'https://evidence.example.test/evidence', SALES_EVIDENCE_PUBLIC_KEY: pemPublic,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.synthetic.actions.githubusercontent.com/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request-token', GITHUB_TOKEN: 'synthetic-workflow-token-never-to-broker' };
  const state = { rule: completeRule(), grant: { administration: 'write', contents: 'read', pull_requests: 'read', actions: 'read', metadata: 'read' },
    scope: { total_count: 1, repositories: [{ id: REPO_ID }] }, claimsPatch: {}, calls, f, env, config };
  const brokerFetch = async (url, options = {}) => {
    url = String(url);calls.push({ url, method: options.method ?? 'GET' });
    assert.equal(options.redirect, 'error');
    if (url === 'https://token.actions.githubusercontent.com/.well-known/jwks') return Response.json(oidcJwks());
    if (url === 'https://api.github.com/app') return Response.json({ id: config.appId, owner: { id: OWNER_ID } });
    if (url.endsWith(`/app/installations/${config.installationId}/access_tokens`)) {
      assert.equal(options.method, 'POST');
      const requested = JSON.parse(options.body);
      const publish = requested.permissions.checks === 'write';
      assert.deepEqual(requested, { repository_ids: [REPO_ID], permissions: {
        administration: 'write', contents: 'read', pull_requests: 'read', actions: 'read', ...(publish?{checks:'write'}:{}) } });
      const jwt = options.headers.Authorization.slice(7).split('.');
      assert.ok(verifyToken('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), brokerKey.publicKey, Buffer.from(jwt[2], 'base64url')));
      return Response.json({ token: 'synthetic-broker-installation-token', repository_selection: 'selected', permissions: {...state.grant, ...(publish?{checks:'write'}:{})} });
    }
    if (url === 'https://api.github.com/installation/repositories?per_page=100') return Response.json(state.scope);
    if (url === 'https://api.github.com/installation/token') { assert.equal(options.method, 'DELETE');return new Response(null, { status: 204 }); }
    if (url.startsWith(`https://api.github.com/repos/${REPO}/`)) {
      const path = url.split(`/repos/${REPO}/`)[1];
      if ((options.method ?? 'GET') !== 'GET') assert.match(path,/^check-runs(?:\/[0-9]+)?$/, 'external publisher never changes code, rules or decisions');
      if (path === 'rulesets/25301984') return Response.json(state.rule);
      return Response.json(await f.api(path, {method:options.method??'GET', ...(options.body?{body:JSON.parse(options.body)}:{})}));
    }
    assert.fail('Unexpected evidence network target: ' + url);
  };
  state.brokerFetch = brokerFetch;
  state.clientFetch = async (url, options = {}) => {
    const target = new URL(String(url));
    assert.equal(options.redirect, 'error');
    if (target.hostname === 'api.github.com') {
      assert.equal(options.method,'GET','workflow token must not publish checks');
      return Response.json(await f.api(target.pathname.split(`/repos/${REPO}/`)[1]));
    }
    if (target.hostname === 'pipelines.synthetic.actions.githubusercontent.com') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-oidc-request-token');
      // OIDC server signs exactly the audience requested by the Actions job.
      const claims = { ...oidcClaims(requestFor()), aud: target.searchParams.get('audience'), ...state.claimsPatch };
      return Response.json({ value: oidcJwt(claims) });
    }
    assert.equal(target.href, env.SALES_EVIDENCE_URL);
    assert.equal(options.method, 'POST');
    assert.equal(JSON.stringify(options).includes(env.GITHUB_TOKEN), false);
    const request = JSON.parse(options.body);
    const envelope = await trustedRunner.handleProtectionEvidence({ request, authorization: options.headers.Authorization.slice(7),
      config, fetchImpl: brokerFetch, now: () => T });
    assert.equal(JSON.stringify(envelope).includes('installation-token'), false);
    assert.equal(JSON.stringify(envelope).includes('PRIVATE KEY'), false);
    return Response.json(envelope);
  };
  return state;
}

test('REAL adapter composition: OIDC -> scoped App -> live rules -> signed proof -> release gate', async () => {
  const b = brokerFixture();
  const proof = await trustedRunner.requestProtectionEvidence({ binding: b.f.binding, env: b.env, fetchImpl: b.clientFetch, now: () => T });
  assert.equal(proof.rules[0].bypass_actors.length, 0);
  assert.equal(proof.branch.commit.sha, b.f.binding.base);
  assert.equal(b.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(b.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(b.calls.at(-1).url, 'https://api.github.com/installation/token');
});
for (const bypass of [undefined, null, {}, [{ actor_type: 'RepositoryRole', actor_id: 5 }]]) {
  test('composed external read cannot mask omitted/malformed/nonempty bypass ' + JSON.stringify(bypass), async () => {
    const b = brokerFixture();b.rule.bypass_actors = bypass;
    await assert.rejects(trustedRunner.requestProtectionEvidence({ binding: b.f.binding, env: b.env, fetchImpl: b.clientFetch, now: () => T }), /bypass/);
    assert.equal(b.calls.at(-1).method, 'DELETE');
  });
}
for (const context of ['Sales owner acceptance', 'Sales production approval']) {
  test('actual proof validator rejects absent mandatory approval context ' + context, async () => {
    const b = brokerFixture();const r = b.rule.rules[3].parameters;
    r.required_status_checks = r.required_status_checks.filter(c => c.context !== context);
    await assert.rejects(trustedRunner.requestProtectionEvidence({ binding: b.f.binding, env: b.env, fetchImpl: b.clientFetch, now: () => T }), /main does not require/);
    assert.equal(b.calls.at(-1).method, 'DELETE');
  });
}
for (const alter of [b => { b.grant.contents = 'write'; }, b => { b.grant.checks = 'write'; },
  b => { b.scope.total_count = 2; }, b => { b.scope.repositories[0].id = 77; }]) {
  test('external installation token is revoked on excess grants or repository scope ' + alter.toString(), async () => {
    const b = brokerFixture();alter(b);
    await assert.rejects(trustedRunner.requestProtectionEvidence({ binding: b.f.binding, env: b.env, fetchImpl: b.clientFetch, now: () => T }), /grant mismatch|scope mismatch/);
    assert.equal(b.calls.at(-1).method, 'DELETE');
    assert.equal(b.calls.some(call => call.url.includes('rulesets/')), false);
  });
}

test('forged workflow claim is rejected before the broker mints an installation token', async () => {
  const b = brokerFixture();b.claimsPatch.ref = 'refs/heads/evil';
  await assert.rejects(trustedRunner.requestProtectionEvidence({ binding: b.f.binding, env: b.env, fetchImpl: b.clientFetch, now: () => T }), /OIDC identity/);
  assert.equal(b.calls.length, 1);
  assert.ok(b.calls[0].url.endsWith('/.well-known/jwks'));
});

test('missing runtime configuration is a real refusal, never a synthetic proof or auto provision', async () => {
  let requests = 0;
  await assert.rejects(trustedRunner.requestProtectionEvidence({ binding: bindingFor(), env: {}, fetchImpl: async () => { requests++; } }), /unconfigured/);
  assert.equal(requests, 0);
  assert.throws(() => trustedRunner.serveProtectionEvidence({ GITHUB_ACTIONS: 'true' }), /outside Actions/);
  assert.throws(() => trustedRunner.serveProtectionEvidence({}), /credentials unconfigured/);
  await assert.rejects(trustedRunner.salesGateCli({ event: {}, env: {} }), /not activated/);
});

test('actual workflow wires trusted code, sequential native gates, cleanup and narrow publish rights', () => {
  const text = readFileSync(trustedWorkflow, 'utf8');
  assert.match(text, /push:\n\s+branches: \[main\]/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /cancel-in-progress: true/);
  assert.match(text, /environment: owner-acceptance/);
  assert.match(text, /environment: production-approval/);
  assert.match(text, /needs: \[initialize, scope, owner\]/);
  assert.match(text, /always\(\) && needs.initialize.result == 'success'/);
  assert.equal((text.match(/checks: write/g) ?? []).length, 0);
  assert.equal((text.match(/id-token: write/g) ?? []).length, 5);
  assert.equal((text.match(/persist-credentials: false/g) ?? []).length, 5);
  assert.doesNotMatch(text, /secrets\.|administration:|contents: write|pull-requests: write|deployments: write|statuses: write/);
  assert.doesNotMatch(text, /name: Sales selective scope verified|name: Sales owner acceptance|name: Sales production approval/,
    'base-only automatic job checks must not impersonate required candidate checks');
  const code = readFileSync('tools/agent-pipeline/lib/sales-trusted-runner.mjs', 'utf8');
  assert.match(code, /protectionCheck:\(\)=>requestProtectionEvidence\(\{binding,env\}\)/);
  assert.match(code, /const result=inspectSalesReleaseGit\(\{cwd,baseSha:binding.base,headSha:binding.head,headRef:releaseRef\}\)/);
  assert.match(code, /await runSalesStage\(/);
  assert.match(code, /requestDigest:digest\(request\)/);
});

test('composed release stages use the real signed evidence client/broker and native GitHub history', async () => {
  const b = brokerFixture();const ids = await trustedRunner.initializeSalesChecks(b.f.binding, b.f.api);
  const protectionCheck = () => trustedRunner.requestProtectionEvidence({ binding: b.f.binding,
    env: b.env, fetchImpl: b.clientFetch, now: () => T });
  await trustedRunner.runSalesStage(stageArgs(b.f, ids, 'scope', { protectionCheck }));
  b.f.history.push(b.f.approve('owner-acceptance'));
  await trustedRunner.runSalesStage(stageArgs(b.f, ids, 'owner', { protectionCheck }));
  b.f.history.push(b.f.approve('production-approval'));
  await trustedRunner.runSalesStage(stageArgs(b.f, ids, 'production', { protectionCheck }));
  assert.ok([...b.f.checks.values()].every(check => check.conclusion === 'success'));
  assert.equal(b.calls.filter(call => call.method === 'POST').length, 6);
  assert.equal(b.calls.filter(call => call.method === 'DELETE').length, 6);
  assert.equal(b.f.writes.filter(write => write.method === 'PATCH').length, 3);
});

test('a missing real proof blocks scope success even when every synthetic Git object passes', async () => {
  const f = liveFixture();const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(f, ids, 'scope', {
    protectionCheck: () => trustedRunner.requestProtectionEvidence({ binding: f.binding, env: {} }),
  })), /unconfigured/);
  assert.equal(f.checks.get(ids.scope).conclusion, 'failure');
  assert.equal(f.writes.some(write => write.body?.conclusion === 'success'), false);
});

test('all approval/check state remains pending if scope fails; output cannot grant production', async () => {
  const f = liveFixture();const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(f, ids, 'scope', {
    scopeCheck: async () => ({ scopeVerified: true, authorizedForProduction: true }),
  })), /Scope audit failed/);
  assert.equal(f.checks.get(ids.scope).conclusion, 'failure');
  assert.equal(f.checks.get(ids.owner).conclusion, null);
  assert.equal(f.checks.get(ids.production).conclusion, null);
});

test('cleanup marks only its own run checks failed after HEAD moves, not a newer run', async t => {
  t.mock.method(Date, 'now', () => T);
  const b = brokerFixture(), f = b.f;const ids = await trustedRunner.initializeSalesChecks(f.binding, f.api);
  for (const check of f.checks.values()) { check.status = 'completed'; check.conclusion = 'success'; }
  const newer = { id: 9999, name: 'Sales production approval', status: 'in_progress', head_sha: 'd'.repeat(40), app: { id: 15368 } };
  f.checks.set(newer.id, newer);f.pull.head.sha = 'd'.repeat(40);f.run.status = 'completed';
  t.mock.method(globalThis, 'fetch', b.clientFetch);
  const original = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', () => f.binding.base);
  syncBuiltinESMExports();t.after(() => { childProcess.execFileSync = original;syncBuiltinESMExports(); });
  const result = await trustedRunner.salesGateCli({ event: f.event, env: { ...f.env, ...b.env,
    GITHUB_TOKEN: 'synthetic-cleanup-token', SALES_RELEASE_GATES_ENABLED: 'true', SALES_GATE_STAGE: 'invalidate',
    SALES_GATE_BINDING: JSON.stringify(f.binding), SALES_GATE_CHECKS: JSON.stringify(ids) } });
  assert.deepEqual(result, { invalidated: true, authorizedForProduction: false });
  for (const id of Object.values(ids)) assert.equal(f.checks.get(id).conclusion, 'failure');
  assert.deepEqual(f.checks.get(9999), newer);
});

test('unknown release-binding fields cannot be injected into an authenticated request', () => {
  assert.throws(() => trustedRunner.validateSalesBinding({ ...bindingFor(), route: '/admin' }), /Invalid release binding/);
});

// Independent review 5558129801: dedicated producer, documented run paths,
// and best-effort invalidation that attempts every owned check.
for (const path of [WF, `${WF}@main`]) {
  test(`workflow path ${path} is accepted only with independently matching workflow metadata`, async () => {
    const f=liveFixture();f.run.path=path;
    await trustedRunner.assertLiveSalesBinding(f.binding,f.api);
    assert.ok(f.reads.includes('actions/workflows/sales-selective-scope.yml'));
    f.run.workflow_id=777;
    await assert.rejects(trustedRunner.assertLiveSalesBinding(f.binding,f.api),/Workflow identity mismatch/);
  });
}
for (const path of [`${WF}@integration`, `${WF}@refs/heads/main`, `${WF}@main-extra`, `${WF}@${main}`]) {
  test(`workflow identity refuses unapproved qualified path ${path}`, async () => {
    const f=liveFixture();f.run.path=path;
    await assert.rejects(trustedRunner.initializeSalesChecks(f.binding,f.api),/Workflow identity/);
    assert.equal(f.writes.length,0);
  });
}
for (const stage of ['scope','owner','production']) {
  test(`Actions App cannot impersonate dedicated ${stage} publisher`, async () => {
    const f=liveFixture();const ids=await trustedRunner.initializeSalesChecks(f.binding,f.api);
    f.checks.get(ids[stage]).app.id=15368;
    await assert.rejects(trustedRunner.publishSalesCheck({binding:f.binding,ids,stage,conclusion:'success',api:f.api}),/Check provenance/);
    assert.equal(f.writes.length,3);
  });
  test(`required ${stage} context cannot be pinned to repository-wide Actions App`, async () => {
    const b=brokerFixture();
    b.rule.rules[3].parameters.required_status_checks.find(c=>c.context===trustedRunner.SALES_CHECKS[stage]).integration_id=15368;
    await assert.rejects(trustedRunner.requestProtectionEvidence({binding:b.f.binding,env:b.env,fetchImpl:b.clientFetch,now:()=>T}),/main does not require/);
  });
}

test('dedicated broker publishes all three checks while workflow token performs reads only', async () => {
  const b=brokerFixture();
  const readApi=async(path,options={})=>{assert.equal(options.method??'GET','GET');return b.f.api(path,options);};
  const initialApi=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,env:b.env,readApi,fetchImpl:b.clientFetch});
  const ids=await trustedRunner.initializeSalesChecks(b.f.binding,initialApi);
  const api=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,ids,env:b.env,readApi,fetchImpl:b.clientFetch});
  const protectionCheck=()=>trustedRunner.requestProtectionEvidence({binding:b.f.binding,env:b.env,fetchImpl:b.clientFetch,now:()=>T});
  await trustedRunner.runSalesStage(stageArgs(b.f,ids,'scope',{api,protectionCheck}));
  b.f.history.push(b.f.approve('owner-acceptance'));b.claimsPatch.sub=`repo:${REPO}:environment:owner-acceptance`;
  await trustedRunner.runSalesStage(stageArgs(b.f,ids,'owner',{api,protectionCheck}));
  b.f.history.push(b.f.approve('production-approval'));b.claimsPatch.sub=`repo:${REPO}:environment:production-approval`;
  await trustedRunner.runSalesStage(stageArgs(b.f,ids,'production',{api,protectionCheck}));
  for(const id of Object.values(ids)) {
    assert.equal(b.f.checks.get(id).app.id,8888);
    assert.equal(b.f.checks.get(id).conclusion,'success');
  }
  const checkWrites=b.calls.filter(call=>call.url.includes('/check-runs')&&['POST','PATCH'].includes(call.method));
  assert.equal(checkWrites.length,6);
  assert.equal(b.calls.filter(call=>call.url.includes('/access_tokens')).length,12);
  assert.equal(b.calls.filter(call=>call.method==='DELETE').length,12);
  const lastPatch=b.calls.findLastIndex(call=>call.method==='PATCH');
  assert.ok(b.calls.findLastIndex(call=>call.method==='DELETE')>lastPatch,'token must be revoked AFTER awaiting the publication, not before');
});

test('publication proof from a candidate workflow is refused before any privileged token or write', async () => {
  const b=brokerFixture();b.claimsPatch.workflow_ref=`${REPO}/${WF}@refs/pull/120/merge`;
  const api=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,env:b.env,readApi:b.f.api,fetchImpl:b.clientFetch});
  await assert.rejects(trustedRunner.initializeSalesChecks(b.f.binding,api),/OIDC identity/);
  assert.equal(b.calls.filter(call=>call.method==='POST').length,0);
  assert.equal(b.f.writes.length,0);
});

test('broker independently rejects owner publication without the protected environment claim', async () => {
  const b=brokerFixture();const ids=await trustedRunner.initializeSalesChecks(b.f.binding,b.f.api);
  await trustedRunner.runSalesStage(stageArgs(b.f,ids,'scope'));
  b.f.history=[b.f.approve('owner-acceptance')];
  const api=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,ids,env:b.env,readApi:b.f.api,fetchImpl:b.clientFetch});
  await assert.rejects(trustedRunner.runSalesStage(stageArgs(b.f,ids,'owner',{api})),/protected environment identity/);
  assert.equal(b.f.checks.get(ids.owner).conclusion,'failure');
});

test('broker independently rechecks rejected owner approval before completing a dedicated check', async () => {
  const b=brokerFixture();const ids=await trustedRunner.initializeSalesChecks(b.f.binding,b.f.api);
  await trustedRunner.runSalesStage(stageArgs(b.f,ids,'scope'));
  b.f.history=[{...b.f.approve('owner-acceptance'),state:'rejected'}];
  b.claimsPatch.sub=`repo:${REPO}:environment:owner-acceptance`;
  const api=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,ids,env:b.env,readApi:b.f.api,fetchImpl:b.clientFetch});
  // Call the publisher directly to show that main-side orchestration is not the
  // broker's only guard against manufactured approval results.
  await assert.rejects(trustedRunner.publishSalesCheck({binding:b.f.binding,ids,stage:'owner',conclusion:'success',api}),/Invalid owner approval/);
  assert.equal(b.f.checks.get(ids.owner).conclusion,null);
});

test('broker rejects binding to the Actions App or to an unconfigured publisher', () => {
  assert.throws(()=>trustedRunner.validateSalesBinding({...bindingFor(),publisherAppId:15368}),/Invalid release binding/);
  assert.throws(()=>trustedRunner.createBrokeredSalesApi({binding:bindingFor(),env:{},readApi:()=>{}}),/Publisher configuration mismatch/);
});

for(const failedStage of ['scope','owner','production']) {
  test(`cleanup attempts every check when ${failedStage} fails`, async () => {
    const f=liveFixture();const ids=await trustedRunner.initializeSalesChecks(f.binding,f.api);
    const attempted=[];
    const api=async(path,options={})=>{
      if(options.method==='PATCH') {
        attempted.push(Number(path.split('/')[1]));
        if(path===`check-runs/${ids[failedStage]}`)throw new Error('provider-secret-must-not-escape');
      }
      return f.api(path,options);
    };
    await assert.rejects(trustedRunner.invalidateSalesChecks({binding:f.binding,ids,api}),error=>
      error.message===`SALES_RELEASE_SCOPE_DENIED: Check invalidation incomplete: ${failedStage}`);
    assert.deepEqual(attempted,Object.values(ids));
    for(const stage of Object.keys(ids).filter(stage=>stage!==failedStage))assert.equal(f.checks.get(ids[stage]).conclusion,'failure');
  });
}

test('live workflow token has no check writes and every publication goes through the broker', () => {
  const y=readFileSync(trustedWorkflow,'utf8');
  assert.doesNotMatch(y,/(?:checks|statuses|administration|contents|pull-requests|deployments): write/);
  assert.match(y,/SALES_RELEASE_PUBLISHER_APP_ID: \$\{\{ vars.SALES_RELEASE_PUBLISHER_APP_ID \}\}/);
  assert.equal((y.match(/id-token: write/g)??[]).length,5);
  const code=readFileSync('tools/agent-pipeline/lib/sales-trusted-runner.mjs','utf8');
  const cli=code.slice(code.indexOf('export async function salesGateCli'));
  assert.match(cli,/initializeSalesChecks\(binding,createBrokeredSalesApi/);
  assert.match(cli,/const api=createBrokeredSalesApi\(\{binding,ids,env,readApi\}\)/);
  assert.match(cli,/invalidateSalesChecks\(\{binding:prior,ids,api\}\)/);
});


// Independent review 5558272284: default GitHub OIDC binds the environment in
// sub, not a guaranteed top-level environment claim. Immutable subjects also
// include the already-verified numeric owner/repository identities.
for (const immutable of [false, true]) {
  test(`native owner decisions publish with default ${immutable?'immutable':'legacy'} environment subject only`, async () => {
    const b=brokerFixture();
    const init=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,env:b.env,readApi:b.f.api,fetchImpl:b.clientFetch});
    const ids=await trustedRunner.initializeSalesChecks(b.f.binding,init);
    const api=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,ids,env:b.env,readApi:b.f.api,fetchImpl:b.clientFetch});
    const root=immutable?'krzysztofsyska@222297538/skillcheck-core@1043384454':REPO;
    await trustedRunner.runSalesStage(stageArgs(b.f,ids,'scope',{api}));
    for(const [stage,name] of [['owner','owner-acceptance'],['production','production-approval']]) {
      b.f.history.push(b.f.approve(name));
      b.claimsPatch.sub=`repo:${root}:environment:${name}`;
      assert.equal(Object.hasOwn(b.claimsPatch,'environment'),false);
      await trustedRunner.runSalesStage(stageArgs(b.f,ids,stage,{api}));
      assert.equal(b.f.checks.get(ids[stage]).conclusion,'success');
    }
  });
}
for(const subject of [undefined, '', `repo:${REPO}:ref:refs/heads/main`,
  `repo:${REPO}:environment:production-approval`, `repo:other/repo:environment:owner-acceptance`,
  'repo:krzysztofsyska@9/skillcheck-core@1043384454:environment:owner-acceptance',
  'repo:krzysztofsyska@222297538/skillcheck-core@9:environment:owner-acceptance',
  `repo:${REPO}:environment:owner-acceptance:extra`]) {
  test(`a custom environment claim cannot override a missing/wrong subject ${String(subject)}`, async () => {
    const b=brokerFixture();const ids=await trustedRunner.initializeSalesChecks(b.f.binding,b.f.api);
    await trustedRunner.runSalesStage(stageArgs(b.f,ids,'scope'));
    b.f.history=[b.f.approve('owner-acceptance')];
    b.claimsPatch={sub:subject,environment:'owner-acceptance'};
    const api=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,ids,env:b.env,readApi:b.f.api,fetchImpl:b.clientFetch});
    await assert.rejects(trustedRunner.publishSalesCheck({binding:b.f.binding,ids,stage:'owner',conclusion:'success',api}),/protected environment identity/);
    assert.equal(b.f.checks.get(ids.owner).conclusion,null);
  });
}
for(const conflicting of [null,'production-approval',true]) {
  test(`an inconsistent optional environment claim is rejected: ${String(conflicting)}`, async () => {
    const b=brokerFixture();const ids=await trustedRunner.initializeSalesChecks(b.f.binding,b.f.api);
    await trustedRunner.runSalesStage(stageArgs(b.f,ids,'scope'));
    b.f.history=[b.f.approve('owner-acceptance')];
    b.claimsPatch={sub:`repo:${REPO}:environment:owner-acceptance`,environment:conflicting};
    const api=trustedRunner.createBrokeredSalesApi({binding:b.f.binding,ids,env:b.env,readApi:b.f.api,fetchImpl:b.clientFetch});
    await assert.rejects(trustedRunner.publishSalesCheck({binding:b.f.binding,ids,stage:'owner',conclusion:'success',api}),/protected environment identity/);
    assert.equal(b.f.checks.get(ids.owner).conclusion,null);
  });
}
