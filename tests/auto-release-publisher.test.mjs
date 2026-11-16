// SC-AUTO-RELEASE (#369) point 4: the publisher end to end, offline.
// Real git (temporary repositories) + an in-memory GitHub; no network, no remote effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createGit } from '../tools/release/auto/git.mjs';
import { runPublisher, releasedFromMain, readMarker, FREEZE_TITLE } from '../tools/release/auto/publisher.mjs';
import { createWorkerDeployer } from '../tools/release/auto/worker-deploy.mjs';

const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
Object.assign(process.env, ENV);

function write(dir, file, text) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); }

// origin (bare) with main; integration = main + merged PR branches.
function fixture(prFiles) {
  const root = mkdtempSync(join(tmpdir(), 'auto-release-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  createGit(root)('init', '--bare', '-b', 'main', origin);
  createGit(root)('clone', origin, work);
  const g = createGit(work);
  g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  write(work, 'README.md', 'hello\n'); write(work, 'app/page.tsx', 'export default 1;\n');
  // The hand-deployed worker and the module it shares with the app: the publisher computes its
  // import closure from the tree, so every fixture needs it exactly as the repository has it.
  write(work, 'lib/screening-hmac.ts', 'export const HEADER = "x-sig";\n');
  write(work, 'lib/screening-dispatch.ts', 'import { HEADER } from "./screening-hmac.ts";\nexport const send = () => HEADER;\n');
  write(work, 'supabase/functions/screening-worker/index.ts', 'import { HEADER } from "../../../lib/screening-hmac.ts";\nexport default HEADER;\n');
  g('add', '.'); g('commit', '-m', 'init'); g('push', 'origin', 'main');
  g('checkout', '-b', 'integration'); g('push', 'origin', 'integration');
  const prs = [];
  prFiles.forEach((files, i) => {
    const n = 100 + i;
    g('checkout', '-b', `pr-${n}`, 'integration');
    for (const [f, t] of Object.entries(files)) if (f !== '__evil') write(work, f, t);
    g('add', '.'); g('commit', '-m', `change ${n}`);
    const head = g('rev-parse', 'HEAD').trim();
    g('checkout', 'integration');
    if (files.__evil) { // merge commit carrying an extra file that the reviewed head does not have
      g('merge', '--no-ff', '--no-commit', `pr-${n}`); write(work, files.__evil, 'x\n'); g('add', '.'); g('commit', '-m', `Merge pull request #${n}`);
    } else g('merge', '--no-ff', '-m', `Merge pull request #${n}`, `pr-${n}`);
    const merge = g('rev-parse', 'HEAD').trim();
    g('push', 'origin', 'integration');
    prs.push({ number: n, head, merge, files: Object.keys(files).filter(f => f !== '__evil') });
  });
  // The publisher's own checkout (like the workflow): fresh clone with both branches fetched.
  const runner = join(root, 'runner');
  createGit(root)('clone', origin, runner);
  const rg = createGit(runner);
  rg('config', 'user.name', 'bot'); rg('config', 'user.email', 'b@b');
  rg('fetch', 'origin', 'main', 'integration');
  return { origin, runner, git: rg, prs, originGit: createGit(origin) };
}

const pass = sha => ({ author_association: 'OWNER', created_at: '2026-11-16T10:00:00Z', user: { login: 'owner' },
  body: `<!-- sc-review-verdict:v1 ${JSON.stringify({ verdict: 'PASS', head_sha: sha, reviewer: 'session_REVIEWER01', builder: 'session_BUILDER001' })} -->` });
const green = sha => ['verify', 'Agent contract / scope gate'].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success', started_at: 'x' }));

// In-memory GitHub; state lets each test steer CI, deployments, merges.
function fakeGithub({ fx, comments = {}, ci = {}, deploy = 'success', mergeRefused = false, issues = [] }) {
  // reviews / threads: empty by default (nothing unresolved); a test may fill them per PR number.
  const state = { pulls: [], issues: [...issues], comments: structuredClone(comments), merged: [], closed: [], reviews: {}, threads: {} };
  const sourcePr = p => ({ number: p.number, title: `PR ${p.number}`, merged: true, merged_at: `2026-11-16T0${p.number - 99}:00:00Z`, merge_commit_sha: p.merge, head: { sha: p.head }, base: { ref: 'integration' }, changed_files: p.files.length });
  const route = (method, path, body) => {
    let m;
    if (method === 'GET' && path.startsWith('/issues?state=open')) return state.issues;
    if (method === 'GET' && path.startsWith('/pulls?state=open&base=main')) return state.pulls.filter(p => p.state === 'open');
    if (method === 'GET' && path.startsWith('/pulls?state=closed&base=integration')) return fx.prs.map(sourcePr);
    if (method === 'GET' && (m = /^\/issues\/(\d+)\/comments/.exec(path))) return state.comments[m[1]] ?? [];
    if (method === 'GET' && (m = /^\/pulls\/(\d+)\/files/.exec(path))) return fx.prs.find(p => p.number === +m[1]).files.map(filename => ({ filename }));
    if (method === 'GET' && (m = /^\/pulls\/(\d+)\/reviews$/.exec(path))) return state.reviews[m[1]] ?? [];
    if (method === 'GET' && (m = /^\/pulls\/(\d+)$/.exec(path))) return sourcePr(fx.prs.find(p => p.number === +m[1]));
    if (method === 'GET' && (m = /^\/commits\/([0-9a-f]{40})\/check-runs/.exec(path))) return { check_runs: ci[m[1]] ?? green(m[1]) };
    if (method === 'GET' && (m = /^\/deployments\?sha=([0-9a-f]{40})/.exec(path))) return state.merged.includes(m[1]) ? [{ id: 1, environment: 'Production – skillcheck-core' }] : [];
    if (method === 'GET' && path.startsWith('/deployments/1/statuses')) return [{ state: deploy, environment_url: 'https://x.vercel.app' }];
    if (method === 'POST' && path === '/pulls') { const pr = { number: 900 + state.pulls.length, state: 'open', user: { login: 'app[bot]', type: 'Bot' }, ...body, head: { ref: body.head, sha: readMarker(body.body).release_head } }; state.pulls.push(pr); return pr; }
    if (method === 'PUT' && (m = /^\/pulls\/(\d+)\/merge$/.exec(path))) {
      if (mergeRefused) { const e = new Error('refused'); e.status = 405; throw e; }
      const pr = state.pulls.find(p => p.number === +m[1]);
      assert.equal(body.sha, pr.head.sha, 'merge must pin the exact release SHA');
      // A real merge commit (main + release head), as GitHub's "merge" method makes.
      const merge = fx.originGit('commit-tree', `${body.sha}^{tree}`, '-p', 'main', '-p', body.sha, '-m', `Merge pull request #${pr.number}`).trim();
      fx.originGit('update-ref', 'refs/heads/main', merge);
      pr.state = 'closed'; state.merged.push(merge); if (state.stopAfterMerge?.(pr)) throw new Error('job killed');
      return { sha: merge };
    }
    if (method === 'PATCH' && (m = /^\/pulls\/(\d+)$/.exec(path))) { state.pulls.find(p => p.number === +m[1]).state = body.state; state.closed.push(+m[1]); return {}; }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(path))) { (state.comments[m[1]] ??= []).push({ ...body, user: { login: 'app[bot]' } }); return {}; }
    if (method === 'POST' && path === '/issues') { const i = { number: 800 + state.issues.length, ...body }; state.issues.push(i); return i; }
    throw new Error(`unrouted ${method} ${path}`);
  };
  const gh = {
    get: async p => route('GET', p), post: async (p, b) => route('POST', p, b), put: async (p, b) => route('PUT', p, b),
    patch: async (p, b) => route('PATCH', p, b), paginate: async p => route('GET', p),
    reviewThreads: async n => state.threads[n] ?? [],
  };
  return { gh, state };
}

function deps(fx, gh, extra = {}) {
  let t = Date.parse('2026-11-16T12:00:00Z');
  return {
    config: { enabled: true, min_pr: 100, ci_timeout_min: 1, deploy_timeout_min: 1 },
    gh, git: fx.git, appBotLogin: 'app[bot]', detectScope: () => 'FRONTEND',
    now: () => new Date(t), sleep: async ms => { t += ms; },
    smoke: async () => ({ ok: true, failures: [] }), log: () => {}, error: () => {},
    ...extra,
  };
}

test('disabled publisher does nothing', async () => {
  assert.equal((await runPublisher({ config: { enabled: false } })).status, 'DISABLED');
});

test('small reviewed change ships: exact patch on main, trailer recorded, deployment + smoke confirmed', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'regulamin v2\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'RELEASED', JSON.stringify(r));
  assert.equal(r.source_pr, 100);
  const pr = state.pulls[0];
  assert.equal(pr.base, 'main'); assert.equal(pr.head.ref, 'release/auto-pr-100');
  assert.match(pr.body, /^PROMOTION: YES$/m); assert.match(pr.body, /^LEVEL: L3$/m);
  const mainLog = fx.originGit('log', 'main', '--format=%B');
  assert.ok(releasedFromMain(mainLog).has(100));
  assert.equal(fx.originGit('show', 'main:app/regulamin/page.tsx'), 'regulamin v2\n');
  // Idempotent: the next run finds nothing new.
  fx.git('fetch', 'origin', 'main');
  assert.equal((await runPublisher(deps(fx, gh))).status, 'NOTHING_TO_RELEASE');
});

test('payment-path change is held; an unrelated later change still ships alone', async () => {
  const fx = fixture([{ 'app/kup/page.tsx': 'pay\n' }, { 'app/regulamin/page.tsx': 'v3\n' }]);
  const { gh } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)], 101: [pass(fx.prs[1].head)] } });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'RELEASED'); assert.equal(r.source_pr, 101);
  assert.deepEqual(r.held[0], { pr: 100, reasons: ['PAYMENT_PATH_FREEZE:app/kup/page.tsx'] });
  assert.equal(fx.originGit('cat-file', '-t', 'main:app/regulamin/page.tsx').trim(), 'blob');
  assert.throws(() => fx.originGit('cat-file', '-t', 'main:app/kup/page.tsx'));
});

test('no independent PASS or no green CI on the exact SHA: nothing ships', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const a = await runPublisher(deps(fx, fakeGithub({ fx }).gh));
  assert.equal(a.status, 'NOTHING_TO_RELEASE'); assert.ok(a.held[0].reasons.includes('REVIEW_PASS_MISSING'));
  const failed = green(fx.prs[0].head); failed[0].conclusion = 'failure';
  const b = await runPublisher(deps(fx, fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] }, ci: { [fx.prs[0].head]: failed } }).gh));
  assert.ok(b.held[0].reasons.includes('CI_FAILED:verify'));
});

test('destructive migration is refused before anything is pushed', async () => {
  const fx = fixture([{ 'supabase/migrations/20261116_x.sql': 'drop table public.companies;\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'NOTHING_TO_RELEASE');
  assert.ok(r.held[0].reasons.includes('DESTRUCTIVE_SQL:DROP:supabase/migrations/20261116_x.sql'));
  assert.ok(r.held[0].reasons.includes('MIGRATION_EXECUTOR_UNAVAILABLE'));
  assert.equal(state.pulls.length, 0);
});

test('failed smoke: release is reverted, freeze issue opened, later runs stop', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'broken\n' }, { 'app/regulamin/inne.tsx': 'x\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)], 101: [pass(fx.prs[1].head)] } });
  let calls = 0;
  const errors = [];
  const r = await runPublisher(deps(fx, gh, { smoke: async () => (++calls === 1 ? { ok: false, failures: ['/:STATUS_500'] } : { ok: true, failures: [] }), error: c => errors.push(c) }));
  assert.equal(r.status, 'ROLLED_BACK', JSON.stringify(r));
  assert.deepEqual(errors, ['SMOKE_FAILED']);
  assert.ok(state.issues[0].title.startsWith(FREEZE_TITLE));
  assert.equal(state.pulls[1].head.ref, 'release/auto-revert-pr-100');
  assert.throws(() => fx.originGit('cat-file', '-t', 'main:app/regulamin/page.tsx'), 'release content reverted on main');
  fx.git('fetch', 'origin', 'main');
  assert.equal((await runPublisher(deps(fx, gh))).status, 'FROZEN');
});

test('deployment not confirmed is treated as a failure (rollback + freeze)', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] }, deploy: 'failure' });
  const r = await runPublisher(deps(fx, gh));
  assert.ok(r.codes.includes('DEPLOYMENT_NOT_CONFIRMED'));
  assert.ok(state.issues.length === 1);
});

test('red CI on the release PR closes it and holds the source PR (no endless retry)', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const ci = new Proxy({}, { get: (_, sha) => (sha === fx.prs[0].head ? green(sha) : green(sha).map(x => ({ ...x, conclusion: 'failure' }))) });
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] }, ci });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'HELD'); assert.deepEqual(state.closed, [900]);
  const again = await runPublisher(deps(fx, gh));
  assert.deepEqual(again.held, [{ pr: 100, reasons: ['HELD_EARLIER'] }]);
});

test('merge refused by protection freezes instead of retrying', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] }, mergeRefused: true });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'FROZEN'); assert.deepEqual(r.codes, ['MERGE_REFUSED:405']);
  assert.equal(state.issues.length, 1);
});

test('open freeze issue or two in-flight releases block every release', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const frozen = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] }, issues: [{ number: 1, title: `${FREEZE_TITLE} SMOKE_FAILED` }] });
  assert.equal((await runPublisher(deps(fx, frozen.gh))).status, 'FROZEN');
  const two = fakeGithub({ fx });
  two.state.pulls.push({ number: 1, state: 'open', head: { ref: 'release/auto-pr-1' } }, { number: 2, state: 'open', head: { ref: 'release/auto-pr-2' } });
  assert.deepEqual((await runPublisher(deps(fx, two.gh))).codes, ['RELEASE_NOT_SERIALIZED']);
});

test('an in-flight release PR whose head moved is treated as tampering and freezes', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx });
  state.pulls.push({ number: 5, state: 'open', head: { ref: 'release/auto-pr-100', sha: 'c'.repeat(40) },
    body: `<!-- sc-auto-release:v1 ${JSON.stringify({ source_pr: 100, source_head: fx.prs[0].head, release_head: 'd'.repeat(40), kind: 'release' })} -->` });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'FROZEN'); assert.deepEqual(r.codes, ['RELEASE_PR_TAMPERED_OR_UNREADABLE']);
});

test('F2: an open release/auto-* PR not opened by the App is never merged, even with a valid-looking marker', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx });
  const head = fx.git('rev-parse', 'origin/main').trim();
  state.pulls.push({ number: 5, state: 'open', user: { login: 'someone', type: 'User' }, head: { ref: 'release/auto-revert-pr-1', sha: head },
    body: `<!-- sc-auto-release:v1 ${JSON.stringify({ source_pr: 1, source_head: head, release_head: head, kind: 'rollback', reverts_pr: 1 })} -->` });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'FROZEN'); assert.ok(r.codes.includes('RELEASE_PR_TAMPERED_OR_UNREADABLE'));
  assert.equal(state.merged.length, 0);
});

test('F2: an App-authored release PR whose content differs from the reviewed patch is refused', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  fx.git('checkout', '-B', 'release/auto-pr-100', 'origin/main');
  writeFileSync(join(fx.git('rev-parse', '--show-toplevel').trim(), 'app/evil.ts'), 'x\n');
  fx.git('add', '.'); fx.git('commit', '-m', 'evil');
  fx.git('push', '--force', 'origin', 'HEAD:refs/heads/release/auto-pr-100');
  const head = fx.git('rev-parse', 'HEAD').trim();
  state.pulls.push({ number: 6, state: 'open', user: { login: 'app[bot]', type: 'Bot' }, head: { ref: 'release/auto-pr-100', sha: head },
    body: `<!-- sc-auto-release:v1 ${JSON.stringify({ source_pr: 100, source_head: fx.prs[0].head, release_head: head, kind: 'release' })} -->` });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'FROZEN'); assert.ok(r.codes.includes('RELEASE_PR_TAMPERED_OR_UNREADABLE'));
  assert.equal(state.merged.length, 0);
});

test('F3: a rollback cut off mid-way is finished by the next run although releases are frozen', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'broken\n' }]);
  const pendingRevert = new Set();
  const ci = new Proxy({}, { get: (_, sha) => (pendingRevert.has(sha) ? green(sha).map(x => ({ ...x, status: 'in_progress' })) : green(sha)) });
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] }, ci });
  let smokeCalls = 0;
  const first = deps(fx, gh, { smoke: async () => (++smokeCalls === 1 ? { ok: false, failures: ['/:STATUS_500'] } : { ok: true, failures: [] }) });
  // The revert PR's CI never finishes in the first job (stands in for the job being killed).
  const post = gh.post;
  gh.post = async (p, b) => { const r = await post(p, b); if (p === '/pulls' && /revert/.test(b.head)) pendingRevert.add(r.head.sha); return r; };
  const r1 = await runPublisher(first);
  assert.equal(r1.status, 'ROLLBACK_FAILED');
  assert.equal(state.pulls.filter(p => p.state === 'open').length, 1);
  pendingRevert.clear();
  fx.git('fetch', 'origin', 'main');
  const r2 = await runPublisher(deps(fx, gh));
  assert.equal(r2.status, 'ROLLED_BACK', JSON.stringify(r2));
  assert.throws(() => fx.originGit('cat-file', '-t', 'main:app/regulamin/page.tsx'), 'broken release reverted on main');
  fx.git('fetch', 'origin', 'main');
  assert.equal((await runPublisher(deps(fx, gh))).status, 'FROZEN', 'still frozen until a human closes the issue');
});

test('F2b: an App rollback PR with an extra commit under the revert is refused', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'broken\n' }]);
  const pending = new Set();
  const ci = new Proxy({}, { get: (_, sha) => (pending.has(sha) ? green(sha).map(x => ({ ...x, status: 'in_progress' })) : green(sha)) });
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] }, ci });
  let n = 0;
  const post = gh.post;
  gh.post = async (p, b) => { const r = await post(p, b); if (p === '/pulls' && /revert/.test(b.head)) pending.add(r.head.sha); return r; };
  await runPublisher(deps(fx, gh, { smoke: async () => (++n === 1 ? { ok: false, failures: ['x'] } : { ok: true, failures: [] }) }));
  const pr = state.pulls.find(p => p.state === 'open');
  // Rewrite the branch: an extra commit below the (re-applied) revert.
  const root = fx.git('rev-parse', '--show-toplevel').trim();
  fx.git('fetch', 'origin', 'main');
  fx.git('checkout', '-B', 'tamper', 'origin/main');
  writeFileSync(join(root, 'app/evil.ts'), 'x\n'); fx.git('add', '.'); fx.git('commit', '-m', 'evil');
  fx.git('revert', '-m', '1', '--no-edit', state.merged[0]);
  fx.git('push', '--force', 'origin', `HEAD:refs/heads/${pr.head.ref}`);
  const head = fx.git('rev-parse', 'HEAD').trim();
  const meta = readMarker(pr.body);
  pr.head.sha = head; pr.body = pr.body.replace(meta.release_head, head);
  pending.clear();
  const r = await runPublisher(deps(fx, gh));
  assert.ok(r.codes.includes('RELEASE_PR_TAMPERED_OR_UNREADABLE'), JSON.stringify(r));
  assert.equal(state.merged.length, 1, 'only the original release was ever merged');
});

test('C1: an error while checking the deployment after the merge rolls back and freezes', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  const get = gh.get;
  let broken = true;
  gh.get = async p => { if (broken && p.startsWith('/deployments')) { broken = false; const e = new Error('boom'); e.status = 502; throw e; } return get(p); };
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'ROLLED_BACK', JSON.stringify(r));
  assert.ok(r.codes.includes('DEPLOYMENT_NOT_CONFIRMED'));
  assert.equal(state.issues.length, 1);
});

test('C1: a release merged by a run that was killed before its check is verified by the next run', async () => {
  for (const smokeOk of [true, false]) {
    const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
    const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
    assert.equal((await runPublisher(deps(fx, gh))).status, 'RELEASED');
    // Simulate the kill: the App's "done" marker was never written.
    state.comments[100] = state.comments[100].filter(c => !/sc-auto-release-done/.test(c.body));
    fx.git('fetch', 'origin', 'main');
    let calls = 0; // when failing: only the first check fails (the reverted version is healthy)
    const r = await runPublisher(deps(fx, gh, { smoke: async () => ((smokeOk || ++calls > 1) ? { ok: true, failures: [] } : { ok: false, failures: ['/:STATUS_500'] }) }));
    if (smokeOk) {
      assert.equal(r.status, 'NOTHING_TO_RELEASE');
      assert.ok(state.comments[100].some(c => /sc-auto-release-done/.test(c.body)));
    } else {
      assert.equal(r.status, 'ROLLED_BACK', JSON.stringify(r));
      assert.equal(state.issues.length, 1);
    }
  }
});

test('a merge commit that adds anything beyond the reviewed head is refused (evil merge)', async () => {
  const fx = fixture([{ 'docs/x.md': 'ok\n', __evil: '.github/workflows/extra.yml' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'NOTHING_TO_RELEASE');
  assert.ok(r.held[0].reasons.includes('MERGE_NOT_CLEAN'), JSON.stringify(r.held));
  assert.ok(r.held[0].reasons.includes('SECRETS_OR_PIPELINE:.github/workflows/extra.yml'));
  assert.equal(state.pulls.length, 0);
});

test('C4: a job dying before the revert PR exists: next run rolls back although frozen', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'broken\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  let smoke = 0; let pushes = 0;
  const d = deps(fx, gh, {
    smoke: async () => (++smoke <= 2 ? { ok: false, failures: ['/:STATUS_500'] } : { ok: true, failures: [] }),
    // 1: release push, 2: fetch of the merged release for the worker step (#461), 3: revert push.
    beforePush: async () => { if (++pushes === 3) throw new Error('job killed before the revert branch was pushed'); },
  });
  const r1 = await runPublisher(d);
  assert.equal(r1.status, 'ROLLBACK_FAILED');
  assert.equal(state.issues.length, 1, 'frozen');
  assert.equal(state.pulls.filter(p => p.state === 'open').length, 0, 'no revert PR was created');
  fx.git('fetch', 'origin', 'main');
  const r2 = await runPublisher({ ...d, beforePush: async () => {} });
  assert.equal(r2.status, 'ROLLED_BACK', JSON.stringify(r2));
  assert.throws(() => fx.originGit('cat-file', '-t', 'main:app/regulamin/page.tsx'), 'reverted on main');
});

test('C4/C7: a job dying right after the rollback merge (before the freeze record): next run checks the revert, freezes, then records', async () => {
  for (const healthy of [true, false]) {
    const fx = fixture([{ 'app/regulamin/page.tsx': 'broken\n' }]);
    const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
    let smoke = 0;
    const post = gh.post;
    let killed = false;
    gh.post = async (p, b) => { if (!killed && p === '/issues') { killed = true; throw new Error('job killed'); } return post(p, b); };
    await assert.rejects(runPublisher(deps(fx, gh, { smoke: async () => (++smoke === 1 ? { ok: false, failures: ['x'] } : { ok: true, failures: [] }) })));
    assert.equal(state.issues.length, 0, 'the kill happened before the freeze record');
    assert.ok(!(state.comments[100] ?? []).some(c => /sc-auto-release-done/.test(c.body)), 'no done marker before the freeze');
    fx.git('fetch', 'origin', 'main');
    const r = await runPublisher(deps(fx, gh, { smoke: async () => ({ ok: healthy, failures: healthy ? [] : ['/:STATUS_500'] }) }));
    assert.equal(r.status, 'FROZEN');
    assert.equal(state.issues.length, 1);
    if (healthy) {
      assert.deepEqual(r.codes, ['ROLLBACK_RECORD_INCOMPLETE']);
      assert.ok(state.comments[100].some(c => /sc-auto-release-done/.test(c.body)));
    } else {
      assert.equal(r.codes[0], 'ROLLBACK_NOT_HEALTHY', 'C6: the revert itself is checked');
      assert.ok(!state.comments[100].some(c => /sc-auto-release-done/.test(c.body)), 'never recorded as done while unhealthy');
    }
  }
});

test('C8: authorization is re-checked right before the merge (verdict changed while CI ran)', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const comments = { 100: [pass(fx.prs[0].head)] };
  const { gh, state } = fakeGithub({ fx, comments });
  const get = gh.get;
  gh.get = async p => {
    const r = await get(p);
    if (/^\/commits\/[0-9a-f]{40}\/check-runs/.test(p) && state.pulls.length && !state.flipped) {
      state.flipped = true; // a reviewer posts FAIL on the same SHA while the release PR's CI runs
      state.comments[100].push({ ...pass(fx.prs[0].head), body: pass(fx.prs[0].head).body.replace('"PASS"', '"FAIL"') });
    }
    return r;
  };
  const r = await runPublisher(deps(fx, gh));
  assert.equal(r.status, 'HELD', JSON.stringify(r));
  assert.ok(r.codes.includes('REVIEW_NOT_PASS:FAIL'));
  assert.equal(state.merged.length, 0); assert.deepEqual(state.closed, [900]);
});

test('C5: the App installation token is refreshed before it expires (runs can outlast one token)', async () => {
  const { generateKeyPairSync, createVerify } = await import('node:crypto');
  const { createAppTokenProvider } = await import('../tools/release/auto/app-token.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let t = Date.parse('2026-11-16T10:00:00Z'); let minted = 0;
  const fetchImpl = async (url, opts) => {
    const jwt = opts.headers.authorization.replace('Bearer ', '');
    const [h, b, sig] = jwt.split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, sig, 'base64url'), 'JWT signed by the App key');
    assert.equal(JSON.parse(Buffer.from(b, 'base64url')).iss, '42');
    if (url.endsWith('/app')) return { ok: true, status: 200, json: async () => ({ slug: 'skillcheck-agent-ks' }) };
    assert.match(url, /\/app\/installations\/7\/access_tokens$/);
    minted++;
    return { ok: true, status: 201, json: async () => ({ token: `tok${minted}`, expires_at: new Date(t + 3600000).toISOString() }) };
  };
  const app = createAppTokenProvider({ appId: '42', installationId: '7', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl, now: () => t });
  assert.equal(await app.slug(), 'skillcheck-agent-ks');
  assert.equal(await app.token(), 'tok1');
  t += 30 * 60000; assert.equal(await app.token(), 'tok1', 'reused while fresh');
  t += 20 * 60000; assert.equal(await app.token(), 'tok2', 'refreshed 15 min before expiry');
  assert.throws(() => createAppTokenProvider({ appId: '', installationId: '7', privateKey: 'x' }), /APP_CONFIG_MISSING/);
});

test('C5: workflow passes only the App credentials to the publisher; no one-hour action token', async () => {
  const { readFileSync } = await import('node:fs');
  const wf = readFileSync(new URL('../.github/workflows/auto-release.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(wf, /create-github-app-token/);
  assert.match(wf, /APP_PRIVATE_KEY: \$\{\{ secrets\.AGENT_PIPELINE_APP_PRIVATE_KEY \}\}/);
});

// C9/C10 (#369), end to end: the two gates that the Codex review of #456/#458 found missing.
test('C10: a change to a module shared with the hand-deployed worker is held, not released', async () => {
  const fx = fixture([{ 'lib/screening-hmac.ts': 'export const HEADER = "x-sig-2";\n' }, { 'app/regulamin/page.tsx': 'v3\n' }]);
  const { gh } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)], 101: [pass(fx.prs[1].head)] } });
  const r = await runPublisher(deps(fx, gh));
  // the unrelated change still ships; the worker-contract change waits for a worker deploy
  assert.equal(r.status, 'RELEASED'); assert.equal(r.source_pr, 101);
  assert.equal(r.held[0].pr, 100);
  assert.ok(r.held[0].reasons.some(x => x.startsWith('WORKER_DEPLOY_REQUIRED:')), r.held[0].reasons.join(','));
  assert.equal(fx.originGit('show', 'main:lib/screening-hmac.ts').trim(), 'export const HEADER = "x-sig";');
});

test('C9: an unresolved review conversation holds the release; resolving it lets the same change ship', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const a = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  a.state.threads[100] = [{ resolved: false, outdated: true, path: 'app/regulamin/page.tsx' }];
  const held = await runPublisher(deps(fx, a.gh));
  assert.equal(held.status, 'NOTHING_TO_RELEASE');
  assert.ok(held.held[0].reasons.some(x => x.startsWith('REVIEW_THREADS_UNRESOLVED:')), held.held[0].reasons.join(','));
  assert.throws(() => fx.originGit('cat-file', '-e', 'main:app/regulamin/page.tsx'));

  // a standing change request blocks the same way
  const b = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  b.state.reviews[100] = [{ user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: fx.prs[0].head, submitted_at: '2026-11-16T09:00:00Z' }];
  const cr = await runPublisher(deps(fx, b.gh));
  assert.ok(cr.held[0].reasons.some(x => x.startsWith('REVIEW_CHANGES_REQUESTED:')), cr.held[0].reasons.join(','));

  // nothing unresolved: the very same change goes out
  const c = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  c.state.threads[100] = [{ resolved: true, path: 'app/regulamin/page.tsx' }];
  const ok = await runPublisher(deps(fx, c.gh));
  assert.equal(ok.status, 'RELEASED');
});

// C12 (#460 runda 3): nieudany odczyt dowodu tuż przed scaleniem jest ponawiany, ale ograniczoną
// liczbę razy. Ten test musi padać zarówno gdy przejściowe wstrzymanie zaczyna blokować PR, jak i
// gdy ograniczenie prób zniknie — brak takiego testu przepuścił wcześniej błąd w tej samej ścieżce.
test('C12: przejściowy brak dowodu jest ponawiany do granicy prób, potem wstrzymuje trwale', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  const { TRANSIENT_ATTEMPTS } = await import('../tools/release/auto/publisher.mjs');
  // domknięcie workera staje się nieczytelne dopiero w ponownym sprawdzeniu przed scaleniem:
  // pierwsze przejście przez evaluate musi dać ALLOW, żeby doszło do etapu recheck
  let evaluated = 0;
  gh.reviewThreads = async () => { evaluated += 1; if (evaluated > 1) throw new Error('GRAPHQL_DOWN'); return []; };

  const runs = [];
  for (let i = 0; i < TRANSIENT_ATTEMPTS; i++) {
    evaluated = 0; // każdy przebieg zaczyna od czytelnego odczytu w evaluate
    runs.push(await runPublisher(deps(fx, gh)));
  }
  for (const [i, r] of runs.entries()) {
    assert.equal(r.status, 'HELD', `przebieg ${i + 1}: ${JSON.stringify(r)}`);
    assert.ok(r.codes.some(c => c.endsWith('_UNKNOWN')), `przebieg ${i + 1}: ${r.codes.join(',')}`);
  }
  assert.equal(state.merged.length, 0, 'nic nie zostało scalone');

  // znaczniki: TRANSIENT_ATTEMPTS-1 przejściowych, a ostatni trwały
  const held = state.comments[100].filter(c => /sc-auto-release-held:v1/.test(c.body ?? ''));
  assert.equal(held.length, TRANSIENT_ATTEMPTS, `po jednym znaczniku na przebieg: ${held.length}`);
  const transientMarks = held.filter(c => /"kind":"transient"/.test(c.body));
  assert.equal(transientMarks.length, TRANSIENT_ATTEMPTS - 1, 'ostatnia próba zapisuje wstrzymanie trwałe');

  // po trwałym wstrzymaniu kolejny przebieg nie podejmuje już nawet próby wydania
  const before = state.pulls.length;
  evaluated = 0;
  const after = await runPublisher(deps(fx, gh));
  assert.equal(after.status, 'NOTHING_TO_RELEASE', JSON.stringify(after));
  assert.deepEqual(after.held, [{ pr: 100, reasons: ['HELD_EARLIER'] }]);
  assert.equal(state.pulls.length, before, 'żaden nowy PR wydania nie powstał');
});

// C13 (#460, uwaga Codexa): wstrzymanie z powodu stanu review musi być ponownie oceniane.
// Wątek pojawia się dopiero w trakcie CI PR-a wydaniowego, więc trafia na ponowne sprawdzenie
// przed scaleniem. Po zamknięciu wątku ta sama, już scalona do integration zmiana musi wyjść —
// zamknięty PR nie dostanie nowego SHA, więc trwałe wstrzymanie znaczyłoby "nigdy".
test('C13: wstrzymanie z powodu review jest ponawiane po zamknięciu wątku', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  let calls = 0; let open = true;
  // pierwszy odczyt w przebiegu (evaluate) jest czysty, drugi (recheck przed scaleniem) widzi wątek
  gh.reviewThreads = async () => {
    calls += 1;
    return open && calls > 1 ? [{ resolved: false, outdated: false, path: 'app/regulamin/page.tsx' }] : [];
  };

  calls = 0;
  const first = await runPublisher(deps(fx, gh));
  assert.equal(first.status, 'HELD', JSON.stringify(first));
  assert.ok(first.codes.some(c => c.includes('REVIEW_THREADS_UNRESOLVED')), first.codes.join(','));
  assert.equal(state.merged.length, 0);
  const held = state.comments[100].filter(c => /sc-auto-release-held:v1/.test(c.body ?? ''));
  assert.equal(held.length, 1);
  assert.match(held[0].body, /"kind":"review"/);

  // wątek zamknięty: kolejny przebieg ocenia tę samą wersję ponownie i wydaje ją
  open = false; calls = 0;
  const second = await runPublisher(deps(fx, gh));
  assert.equal(second.status, 'RELEASED', JSON.stringify(second));
  assert.equal(second.source_pr, 100);
  assert.equal(fx.originGit('show', 'main:app/regulamin/page.tsx').trim(), 'v2');
});

// #461 stage 1: the worker deploy step. `workerGate` still refuses every worker release before the
// merge, so these tests reach the step through the path that runs whatever is already on main: a
// publisher release merged by a run that was killed before its check (C1). Same code as a fresh
// release: verifyProduction -> afterDeploy -> rollback.
function workerReleaseOnMain(fx, state, sourcePr = 100) {
  const g = fx.git;
  g('fetch', 'origin', 'main'); g('checkout', '-B', 'tmp-release', 'origin/main');
  write(fx.runner, 'lib/screening-hmac.ts', 'export const HEADER = "x-sig-2";\n');
  g('add', '.'); g('commit', '-m', `worker contract\n\nAuto-Release-Source-PR: #${sourcePr}\nAuto-Release-Source-Head: ${fx.prs[0].head}`);
  const head = g('rev-parse', 'HEAD').trim();
  g('push', 'origin', `HEAD:refs/heads/release/auto-pr-${sourcePr}`);
  const merge = fx.originGit('commit-tree', `${head}^{tree}`, '-p', 'main', '-p', head, '-m', 'Merge pull request #950').trim();
  fx.originGit('update-ref', 'refs/heads/main', merge);
  state.merged.push(merge);
  g('fetch', 'origin', 'main');
  return merge;
}
const released = state => (state.comments[100] ?? []).filter(c => /sc-auto-release-done/.test(c.body) && /wydane/.test(c.body));

test('#461: worker release is deployed from the exact merge SHA, after the merge and before smoke', async () => {
  const fx = fixture([{ 'docs/x.md': 'x\n' }]);
  const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  const merge = workerReleaseOnMain(fx, state);
  const order = [];
  const r = await runPublisher(deps(fx, gh, {
    deployWorker: async ({ sha }) => { order.push(`deploy:${sha}`); return { ok: true, sha }; },
    smoke: async () => { order.push('smoke'); return { ok: true, failures: [] }; },
  }));
  assert.equal(r.status, 'NOTHING_TO_RELEASE', JSON.stringify(r));
  assert.deepEqual(order, [`deploy:${merge}`, 'smoke']);
  assert.equal(released(state).length, 1);
  assert.equal(state.issues.length, 0);
});

test('#461: a failed or unconfirmed worker deploy rolls back, redeploys the worker from the reverted main, freezes, never marks released', async () => {
  for (const answer of [{ ok: false, code: 'X' }, { ok: true }, { ok: true, sha: 'f'.repeat(40) }, 'throw']) {
    const fx = fixture([{ 'docs/x.md': 'x\n' }]);
    const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
    const merge = workerReleaseOnMain(fx, state);
    const calls = []; let smoke = 0;
    const r = await runPublisher(deps(fx, gh, {
      deployWorker: async ({ sha }) => {
        calls.push(sha);
        if (calls.length > 1) return { ok: true, sha }; // the redeploy of the reverted main works
        if (answer === 'throw') throw new Error('boom');
        return answer;
      },
      smoke: async () => { smoke++; return { ok: true, failures: [] }; },
    }));
    assert.equal(r.status, 'ROLLED_BACK', JSON.stringify(r));
    assert.ok(r.codes.includes('WORKER_DEPLOY_FAILED'), r.codes.join(','));
    assert.equal(calls[0], merge);
    assert.equal(calls.length, 2, 'worker redeployed from the reverted main');
    assert.equal(calls[1], fx.originGit('rev-parse', 'main').trim());
    assert.equal(smoke, 1, 'smoke runs only for the revert, never after a failed worker deploy');
    assert.equal(fx.originGit('show', 'main:lib/screening-hmac.ts').trim(), 'export const HEADER = "x-sig";');
    assert.equal(state.issues.length, 1); assert.match(state.issues[0].body, /WORKER_DEPLOY_FAILED/);
    assert.equal(released(state).length, 0);
  }
});

test('#461: no token (or no deploy step at all) fails closed: WORKER_DEPLOY_UNAVAILABLE, rollback, freeze', async () => {
  for (const variant of ['no-token', 'no-dependency']) {
    const fx = fixture([{ 'docs/x.md': 'x\n' }]);
    const { gh, state } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
    workerReleaseOnMain(fx, state);
    let spawned = 0;
    const extra = variant === 'no-token'
      ? { deployWorker: createWorkerDeployer({ git: fx.git, env: { SUPABASE_ACCESS_TOKEN: '  ' }, spawn: () => { spawned++; return { status: 0 }; } }) }
      : {};
    const r = await runPublisher(deps(fx, gh, extra));
    assert.equal(r.status, 'ROLLED_BACK', JSON.stringify(r));
    assert.ok(r.codes.includes('WORKER_DEPLOY_UNAVAILABLE'), r.codes.join(','));
    assert.equal(spawned, 0, 'the CLI never runs without a token');
    assert.equal(state.issues.length, 1); assert.match(state.issues[0].body, /WORKER_DEPLOY_UNAVAILABLE/);
    assert.equal(released(state).length, 0);
  }
});

test('#461: a release that does not touch the worker never calls the deploy step', async () => {
  const fx = fixture([{ 'app/regulamin/page.tsx': 'v2\n' }]);
  const { gh } = fakeGithub({ fx, comments: { 100: [pass(fx.prs[0].head)] } });
  let calls = 0;
  const r = await runPublisher(deps(fx, gh, { deployWorker: async () => { calls++; return { ok: false }; } }));
  assert.equal(r.status, 'RELEASED', JSON.stringify(r));
  assert.equal(calls, 0);
});

test('#461: worker deployer runs the CLI on a worktree of the exact main SHA, with the token only, and needs its confirmation', async () => {
  const fx = fixture([{ 'docs/x.md': 'x\n' }]);
  const { state } = fakeGithub({ fx });
  const merge = workerReleaseOnMain(fx, state);
  const TOKEN = 'sbp_secret_token_value';
  const seen = [];
  const deployer = out => createWorkerDeployer({
    git: fx.git, env: { SUPABASE_ACCESS_TOKEN: TOKEN, PATH: '/usr/bin', APP_PRIVATE_KEY: 'k' }, log: l => seen.push(l),
    spawn: (cmd, args, opts) => {
      assert.equal(cmd, 'supabase');
      assert.deepEqual(args, ['functions', 'deploy', 'screening-worker', '--project-ref', 'wsvjawuikxfzjyivxgsu']);
      assert.equal(createGit(opts.cwd)('rev-parse', 'HEAD').trim(), merge, 'deploys the exact SHA');
      assert.notEqual(opts.cwd, fx.runner, 'never the publisher checkout');
      assert.deepEqual(Object.keys(opts.env).sort(), ['PATH', 'SUPABASE_ACCESS_TOKEN']);
      return out;
    },
  });
  const ok = { status: 0, stdout: 'Deployed Functions on project wsvjawuikxfzjyivxgsu: screening-worker\n', stderr: '' };
  assert.deepEqual(await deployer(ok)({ sha: merge }), { ok: true, sha: merge });
  assert.equal((await deployer({ status: 0, stdout: 'done', stderr: '' })({ sha: merge })).code, 'WORKER_DEPLOY_NOT_CONFIRMED');
  assert.equal((await deployer({ status: 1, stdout: '', stderr: `bad token ${TOKEN}\n` })({ sha: merge })).code, 'WORKER_DEPLOY_EXIT_1');
  assert.ok(seen.every(l => !l.includes(TOKEN)), 'token never logged');
  // not on main (an integration-only commit) and not a SHA: refused before anything runs
  assert.equal((await deployer(ok)({ sha: fx.prs[0].merge })).code, 'WORKER_DEPLOY_NOT_ON_MAIN');
  assert.equal((await deployer(ok)({ sha: 'main' })).code, 'WORKER_DEPLOY_SHA_INVALID');
  assert.equal(fx.git('worktree', 'list').trim().split('\n').length, 1, 'worktrees cleaned up');
});

test('#461 stage 1: workflow sets up the pinned Supabase CLI and passes the token to the publisher only', async () => {
  const { readFileSync } = await import('node:fs');
  const wf = readFileSync(new URL('../.github/workflows/auto-release.yml', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.match(wf, /uses: supabase\/setup-cli@1dedf2c611547ede7232d26866dd3c56ab903bbb # v1\.7\.3\n\s+with:\n\s+version: 2\.121\.0/);
  assert.match(wf, /environment: agent-control/);
  assert.doesNotMatch(wf, /production-approval/);
});
