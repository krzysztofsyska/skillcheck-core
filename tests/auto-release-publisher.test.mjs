// SC-AUTO-RELEASE (#369) point 4: the publisher end to end, offline.
// Real git (temporary repositories) + an in-memory GitHub; no network, no remote effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createGit } from '../tools/release/auto/git.mjs';
import { runPublisher, releasedFromMain, readMarker, FREEZE_TITLE } from '../tools/release/auto/publisher.mjs';

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
  g('add', '.'); g('commit', '-m', 'init'); g('push', 'origin', 'main');
  g('checkout', '-b', 'integration'); g('push', 'origin', 'integration');
  const prs = [];
  prFiles.forEach((files, i) => {
    const n = 100 + i;
    g('checkout', '-b', `pr-${n}`, 'integration');
    for (const [f, t] of Object.entries(files)) write(work, f, t);
    g('add', '.'); g('commit', '-m', `change ${n}`);
    const head = g('rev-parse', 'HEAD').trim();
    g('checkout', 'integration'); g('merge', '--no-ff', '-m', `Merge pull request #${n}`, `pr-${n}`);
    const merge = g('rev-parse', 'HEAD').trim();
    g('push', 'origin', 'integration');
    prs.push({ number: n, head, merge, files: Object.keys(files) });
  });
  // The publisher's own checkout (like the workflow): fresh clone with both branches fetched.
  const runner = join(root, 'runner');
  createGit(root)('clone', origin, runner);
  const rg = createGit(runner);
  rg('config', 'user.name', 'bot'); rg('config', 'user.email', 'b@b');
  rg('fetch', 'origin', 'main', 'integration');
  return { origin, git: rg, prs, originGit: createGit(origin) };
}

const pass = sha => ({ author_association: 'OWNER', created_at: '2026-11-16T10:00:00Z', user: { login: 'owner' },
  body: `<!-- sc-review-verdict:v1 ${JSON.stringify({ verdict: 'PASS', head_sha: sha, reviewer: 'session_REVIEWER01', builder: 'session_BUILDER001' })} -->` });
const green = sha => ['verify', 'Agent contract / scope gate'].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success', started_at: 'x' }));

// In-memory GitHub; state lets each test steer CI, deployments, merges.
function fakeGithub({ fx, comments = {}, ci = {}, deploy = 'success', mergeRefused = false, issues = [] }) {
  const state = { pulls: [], issues: [...issues], comments: structuredClone(comments), merged: [], closed: [] };
  const sourcePr = p => ({ number: p.number, title: `PR ${p.number}`, merged: true, merged_at: `2026-11-16T0${p.number - 99}:00:00Z`, merge_commit_sha: p.merge, head: { sha: p.head }, base: { ref: 'integration' }, changed_files: p.files.length });
  const route = (method, path, body) => {
    let m;
    if (method === 'GET' && path.startsWith('/issues?state=open')) return state.issues;
    if (method === 'GET' && path.startsWith('/pulls?state=open&base=main')) return state.pulls.filter(p => p.state === 'open');
    if (method === 'GET' && path.startsWith('/pulls?state=closed&base=integration')) return fx.prs.map(sourcePr);
    if (method === 'GET' && (m = /^\/issues\/(\d+)\/comments/.exec(path))) return state.comments[m[1]] ?? [];
    if (method === 'GET' && (m = /^\/pulls\/(\d+)\/files/.exec(path))) return fx.prs.find(p => p.number === +m[1]).files.map(filename => ({ filename }));
    if (method === 'GET' && (m = /^\/pulls\/(\d+)$/.exec(path))) return sourcePr(fx.prs.find(p => p.number === +m[1]));
    if (method === 'GET' && (m = /^\/commits\/([0-9a-f]{40})\/check-runs/.exec(path))) return { check_runs: ci[m[1]] ?? green(m[1]) };
    if (method === 'GET' && (m = /^\/deployments\?sha=([0-9a-f]{40})/.exec(path))) return state.merged.includes(m[1]) ? [{ id: 1, environment: 'Production – skillcheck-core' }] : [];
    if (method === 'GET' && path.startsWith('/deployments/1/statuses')) return [{ state: deploy, environment_url: 'https://x.vercel.app' }];
    if (method === 'POST' && path === '/pulls') { const pr = { number: 900 + state.pulls.length, state: 'open', ...body, head: { ref: body.head, sha: readMarker(body.body).release_head } }; state.pulls.push(pr); return pr; }
    if (method === 'PUT' && (m = /^\/pulls\/(\d+)\/merge$/.exec(path))) {
      if (mergeRefused) { const e = new Error('refused'); e.status = 405; throw e; }
      const pr = state.pulls.find(p => p.number === +m[1]);
      assert.equal(body.sha, pr.head.sha, 'merge must pin the exact release SHA');
      fx.originGit('update-ref', 'refs/heads/main', body.sha); // fast-forward stands in for the merge commit
      pr.state = 'closed'; state.merged.push(body.sha); return { sha: body.sha };
    }
    if (method === 'PATCH' && (m = /^\/pulls\/(\d+)$/.exec(path))) { state.pulls.find(p => p.number === +m[1]).state = body.state; state.closed.push(+m[1]); return {}; }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(path))) { (state.comments[m[1]] ??= []).push({ ...body, user: { login: 'app[bot]' } }); return {}; }
    if (method === 'POST' && path === '/issues') { const i = { number: 800 + state.issues.length, ...body }; state.issues.push(i); return i; }
    throw new Error(`unrouted ${method} ${path}`);
  };
  const gh = {
    get: async p => route('GET', p), post: async (p, b) => route('POST', p, b), put: async (p, b) => route('PUT', p, b),
    patch: async (p, b) => route('PATCH', p, b), paginate: async p => route('GET', p),
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
