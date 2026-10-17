import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const contexts = ['verify', 'Agent contract / scope gate', 'Sales selective scope verified'];
  const rule = {
    id: 17, enforcement: 'active', target: 'branch', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: {
        required_approving_review_count: 1, dismiss_stale_reviews_on_push: true,
        require_last_push_approval: true,
      } },
      { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: contexts.map(context => ({ context, integration_id: 15368 })),
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
  process.env.GITHUB_TOKEN = 'synthetic-read-only-test-token';
  t.after(() => {
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
