// SC-AUTO-RELEASE (#369): the automatic publisher.
//
// One release per run, serialized by the workflow's concurrency group. A release is ONE pull
// request already merged into `integration` (green CI + independent PASS on its exact head
// SHA), cherry-picked onto `main` as `release/auto-pr-<N>`, checked for an identical patch,
// merged after the required checks pass on the exact release SHA, then confirmed on Vercel
// Production and smoke-tested. A failure rolls the code back (revert PR) and freezes every
// later release until a human closes the freeze issue.
//
// Everything remote is injected (deps) so the whole flow is tested offline.
import {
  SHA, evaluateCandidate, ciGate, afterDeploy, REQUIRED_CHECKS,
} from './policy.mjs';

export const FREEZE_TITLE = '[auto-release-freeze]';
const RELEASE_PREFIX = 'release/auto-';
const MARKER = 'sc-auto-release:v1';
const HELD = 'sc-auto-release-held:v1';
const TRAILER_PR = /^Auto-Release-Source-PR: #(\d+)$/gm;

export async function runPublisher(d) {
  const { config } = d;
  const log = d.log ?? (() => {});
  if (config?.enabled !== true) return { status: 'DISABLED', codes: ['PUBLISHER_DISABLED'] };
  if (!Number.isInteger(config.min_pr) || config.min_pr < 1) return { status: 'BLOCKED', codes: ['CONFIG_MIN_PR_INVALID'] };

  // In-flight PRs first: an interrupted ROLLBACK must be finished even while frozen.
  const openReleases = (await d.gh.paginate('/pulls?state=open&base=main'))
    .filter(p => p.head?.ref?.startsWith(RELEASE_PREFIX));
  const freeze = await openFreezeIssues(d);
  if (openReleases.length > 1) return freeze.length ? { status: 'FROZEN', codes: ['RELEASE_FROZEN', 'RELEASE_NOT_SERIALIZED'] } : freezeWith(d, ['RELEASE_NOT_SERIALIZED'], openReleases.map(p => `#${p.number}`).join(', '));
  if (openReleases.length === 1) {
    const meta = readMarker(openReleases[0].body);
    if (meta?.kind === 'rollback' || !freeze.length) return resume(d, openReleases[0], freeze);
  }
  // Runs EVEN WHILE FROZEN (C4): a release left unchecked or half rolled back by a killed job is
  // finished here before anything else, so production never stays on an unverified release.
  const unchecked = await verifyLastRelease(d);
  if (unchecked?.reverted) {
    await doneMarker(d, unchecked.pr, unchecked.merge, 'cofnięte (zapis uzupełniony po przerwanym przebiegu)');
    if (!freeze.length) return freezeWith(d, ['ROLLBACK_RECORD_INCOMPLETE'], `release ${unchecked.merge} (source #${unchecked.pr})`);
  } else if (unchecked) {
    const check = await verifyProduction(d, unchecked.merge);
    if (check.ok) await doneMarker(d, unchecked.pr, unchecked.merge, 'wydane, sprawdzone po przerwanym przebiegu, smoke OK');
    else {
      const pr = await d.gh.get(`/pulls/${unchecked.pr}`);
      return finishAfterDeploy(d, pr, { releasePr: null }, { ...check, mergeSha: unchecked.merge });
    }
  }
  if (freeze.length) return { status: 'FROZEN', codes: ['RELEASE_FROZEN'], freeze: freeze.map(i => i.number) };

  const released = releasedFromMain(d.git('log', 'origin/main', '--format=%B'));
  const held = [];
  for (const pr of await candidates(d)) {
    if (released.has(pr.number)) continue;
    if (d.git.ok('merge-base', '--is-ancestor', pr.merge_commit_sha, 'origin/main')) continue;
    const comments = await d.gh.paginate(`/issues/${pr.number}/comments`);
    if (heldFor(comments, pr.head.sha, d.appBotLogin)) { held.push({ pr: pr.number, reasons: ['HELD_EARLIER'] }); continue; }
    const decision = await evaluate(d, pr, comments);
    if (decision.decision !== 'ALLOW') { held.push({ pr: pr.number, reasons: decision.reasons }); continue; }
    log(`ALLOW #${pr.number} ${pr.head.sha}`);
    const started = await startRelease(d, pr);
    if (started.hold) { await hold(d, pr, started.hold); held.push({ pr: pr.number, reasons: [started.hold] }); continue; }
    const result = await finish(d, pr, started);
    return { ...result, held };
  }
  return { status: 'NOTHING_TO_RELEASE', codes: [], held };
}

async function openFreezeIssues(d) {
  const issues = await d.gh.paginate('/issues?state=open');
  return issues.filter(i => !i.pull_request && typeof i.title === 'string' && i.title.startsWith(FREEZE_TITLE));
}

export function releasedFromMain(log) {
  const out = new Set();
  for (const m of String(log).matchAll(TRAILER_PR)) out.add(Number(m[1]));
  return out;
}

async function candidates(d) {
  const all = await d.gh.paginate('/pulls?state=closed&base=integration&sort=created&direction=desc');
  return all
    .filter(p => p.merged_at && p.number >= d.config.min_pr && p.base?.ref === 'integration')
    .sort((a, b) => String(a.merged_at).localeCompare(String(b.merged_at)));
}

function heldFor(comments, headSha, botLogin) {
  if (!botLogin) return false;
  const re = new RegExp(`<!--\\s*${HELD}\\s+(\\{[^<>]{1,400}\\})\\s*-->`);
  return comments.some(c => {
    if (c?.user?.login !== botLogin) return false;
    const m = re.exec(c.body ?? ''); if (!m) return false;
    try { return JSON.parse(m[1]).head_sha === headSha; } catch { return false; }
  });
}

async function evaluate(d, pr, comments) {
  const full = await d.gh.get(`/pulls/${pr.number}`);
  const files = await d.gh.paginate(`/pulls/${pr.number}/files`);
  const paths = [...new Set(files.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)))];
  if (typeof full.changed_files !== 'number' || files.length < full.changed_files) {
    return { decision: 'DENY', reasons: ['FILE_LIST_TRUNCATED'] };
  }
  const migrations = paths.filter(p => p.startsWith('supabase/migrations/'))
    .map(p => ({ path: p, sql: d.git.ok('cat-file', '-e', `${full.merge_commit_sha}:${p}`) ? d.git('show', `${full.merge_commit_sha}:${p}`) : null }));
  const checks = await d.gh.get(`/commits/${full.head.sha}/check-runs?per_page=100`);
  let patches = null; let unreleasedMigrations = null; let provenance = null;
  try {
    // The patch that will be copied must be exactly the reviewed head merged without extra edits:
    // two parents, second parent = reviewed head SHA, merge tree = git's automatic merge tree.
    const [, parent, second, ...more] = d.git('rev-list', '--parents', '-n', '1', full.merge_commit_sha).trim().split(/\s+/);
    provenance = [];
    if (!second || more.length) provenance.push('MERGE_SHAPE_UNSUPPORTED');
    else if (second !== full.head.sha) provenance.push('MERGE_PARENT_NOT_REVIEWED_HEAD');
    else {
      const auto = d.git.ok('merge-tree', '--write-tree', parent, second) ? d.git('merge-tree', '--write-tree', parent, second).trim().split('\n')[0] : null;
      if (!auto || auto !== d.git('rev-parse', `${full.merge_commit_sha}^{tree}`).trim()) provenance.push('MERGE_NOT_CLEAN');
    }
    // Classify what is actually copied, not only what the API lists.
    for (const f of d.git('diff', '--name-only', parent, full.merge_commit_sha).split('\n').filter(Boolean)) if (!paths.includes(f)) paths.push(f);
    patches = paths.filter(p => d.git.ok('cat-file', '-e', `${full.merge_commit_sha}:${p}`) || d.git.ok('cat-file', '-e', `${parent}:${p}`))
      .map(p => ({ path: p, patch: d.git('diff', parent, full.merge_commit_sha, '--', p) }));
    unreleasedMigrations = d.git('diff', '--name-only', 'origin/main', parent, '--', 'supabase/migrations').split('\n').filter(Boolean);
  } catch { /* left null: the policy denies */ }
  return evaluateCandidate({
    patches, unreleasedMigrations, provenance,
    pr: { number: full.number, merged: full.merged === true, head_sha: full.head.sha, merge_commit_sha: full.merge_commit_sha, base_ref: full.base.ref },
    files: paths, migrations, checkRuns: checks?.check_runs, comments,
    migrationExecutor: false, backups: d.backups ?? null, now: d.now(),
  });
}

function patchId(d, from, to) {
  const diff = d.git('diff', '--binary', from, to);
  if (!diff.trim()) return null;
  return d.git.patchId(diff);
}

async function startRelease(d, pr) {
  const branch = `${RELEASE_PREFIX}pr-${pr.number}`;
  const merge = pr.merge_commit_sha;
  d.git('checkout', '-B', branch, 'origin/main');
  const parents = d.git('rev-list', '--parents', '-n', '1', merge).trim().split(/\s+/).slice(1);
  const pick = parents.length === 2 ? ['cherry-pick', '-x', '-m', '1', merge] : ['cherry-pick', '-x', merge];
  if (!d.git.ok(...pick)) { d.git.ok('cherry-pick', '--abort'); return { hold: 'CHERRY_PICK_CONFLICT_OR_EMPTY' }; }
  const source = patchId(d, parents[0], merge);
  const release = patchId(d, 'origin/main', 'HEAD');
  if (!source || source !== release) return { hold: 'PATCH_MISMATCH' };
  const message = d.git('log', '-1', '--format=%B').trimEnd();
  d.git('commit', '--amend', '-m', `${message}\n\nAuto-Release-Source-PR: #${pr.number}\nAuto-Release-Source-Head: ${pr.head.sha}`);
  const releaseHead = d.git('rev-parse', 'HEAD').trim();
  await d.beforePush?.();
  d.git('push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  const files = d.git('diff', '--name-only', 'origin/main', 'HEAD').split('\n').filter(Boolean);
  const scope = d.detectScope(files);
  const meta = { source_pr: pr.number, source_head: pr.head.sha, release_head: releaseHead, kind: 'release' };
  const created = await d.gh.post('/pulls', {
    base: 'main', head: branch,
    title: `Auto-release: #${pr.number} ${String(pr.title).slice(0, 180)}`,
    body: releaseBody({ meta, scope, pr }),
  });
  return { releasePr: created.number, releaseHead, meta };
}

function releaseBody({ meta, scope, pr }) {
  return [
    `TASK: AUTO-RELEASE #${meta.source_pr}`,
    `SCOPE: ${scope}`,
    'LEVEL: L3',
    'OWNER_APPROVAL: NOT_REQUIRED (continuous release policy, #369)',
    'PRODUCTION_APPROVAL: AUTO (#369; green CI + independent PASS on exact SHA)',
    `REVIEW_VERDICT: PASS ${meta.source_head} (#${meta.source_pr})`,
    'PROMOTION: YES',
    '',
    meta.kind === 'rollback'
      ? `Automatic rollback of #${meta.reverts_pr} after a failed production check.`
      : `Automatic release of #${pr?.number ?? meta.source_pr}: exactly its reviewed patch, cherry-picked onto main.`,
    '',
    `<!-- ${MARKER} ${JSON.stringify(meta)} -->`,
  ].join('\n');
}

export function readMarker(body) {
  const m = new RegExp(`<!--\\s*${MARKER}\\s+(\\{[^<>]{1,600}\\})\\s*-->`).exec(String(body ?? ''));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// An in-flight PR is trusted only if the publisher's own App opened it AND its content is
// exactly what the publisher would have produced (recomputed here, never read from the marker).
async function resume(d, open, freeze = []) {
  const meta = readMarker(open.body);
  const tampered = where => (freeze.length
    ? { status: 'FROZEN', codes: ['RELEASE_FROZEN', 'RELEASE_PR_TAMPERED_OR_UNREADABLE'], where }
    : freezeWith(d, ['RELEASE_PR_TAMPERED_OR_UNREADABLE'], where));
  if (!meta || !SHA.test(meta.release_head ?? '') || open.head?.sha !== meta.release_head
      || !d.appBotLogin || open.user?.login !== d.appBotLogin || open.user?.type !== 'Bot') {
    return tampered(`PR #${open.number}`);
  }
  await d.beforePush?.();
  if (!d.git.ok('fetch', 'origin', `+refs/heads/${open.head.ref}:refs/remotes/origin/${open.head.ref}`)
      || d.git('rev-parse', `origin/${open.head.ref}`).trim() !== meta.release_head) return tampered(`PR #${open.number} (ref)`);
  if (meta.kind === 'rollback') {
    // Must be exactly the revert of a merge on main that carries the publisher's release trailer.
    const merge = meta.source_head;
    const onMain = SHA.test(merge ?? '') && d.git.ok('merge-base', '--is-ancestor', merge, 'origin/main');
    const released = onMain && releasedFromMain(d.git('log', '-1', '--format=%B', `${merge}^2`)).has(meta.reverts_pr);
    // The whole branch (from where it left main) must be exactly the revert: no extra commits.
    const revert = onMain && patchId(d, d.git('merge-base', 'origin/main', meta.release_head).trim(), meta.release_head);
    const expected = onMain && patchId(d, merge, `${merge}^1`);
    if (!released || !revert || revert !== expected) return tampered(`rollback PR #${open.number}`);
    const r = await mergeAndVerify(d, { releasePr: open.number, releaseHead: meta.release_head });
    return { status: r.ok ? 'ROLLED_BACK' : 'ROLLBACK_FAILED', codes: r.codes ?? [], release_pr: open.number };
  }
  const pr = await d.gh.get(`/pulls/${meta.source_pr}`);
  const parent = d.git('rev-list', '--parents', '-n', '1', pr.merge_commit_sha).trim().split(/\s+/)[1];
  const base = d.git('merge-base', 'origin/main', meta.release_head).trim();
  if (!parent || patchId(d, parent, pr.merge_commit_sha) !== patchId(d, base, meta.release_head)) return tampered(`PR #${open.number} (patch)`);
  const comments = await d.gh.paginate(`/issues/${pr.number}/comments`);
  const decision = await evaluate(d, pr, comments);
  if (decision.decision !== 'ALLOW' || pr.head.sha !== meta.source_head) {
    await d.gh.patch(`/pulls/${open.number}`, { state: 'closed' });
    return { status: 'HELD', codes: ['SOURCE_NO_LONGER_ALLOWED', ...decision.reasons], release_pr: open.number };
  }
  return finish(d, pr, { releasePr: open.number, releaseHead: meta.release_head, meta });
}

async function waitForChecks(d, sha) {
  const deadline = d.now().getTime() + (d.config.ci_timeout_min ?? 45) * 60000;
  for (;;) {
    const runs = (await d.gh.get(`/commits/${sha}/check-runs?per_page=100`))?.check_runs;
    const reasons = ciGate(runs, sha, REQUIRED_CHECKS);
    if (!reasons.length) return [];
    if (!reasons.some(r => r.startsWith('CI_PENDING') || r.startsWith('CI_MISSING'))) return reasons;
    if (d.now().getTime() > deadline) return ['CI_TIMEOUT', ...reasons];
    await d.sleep(30000);
  }
}

async function mergeAndVerify(d, { releasePr, releaseHead }) {
  const ci = await waitForChecks(d, releaseHead);
  if (ci.length) return { ok: false, stage: 'ci', codes: ci };
  let merged;
  try {
    merged = await d.gh.put(`/pulls/${releasePr}/merge`, { merge_method: 'merge', sha: releaseHead });
  } catch (e) {
    return { ok: false, stage: 'merge', codes: [`MERGE_REFUSED:${e.status ?? 'ERR'}`] };
  }
  const mergeSha = merged?.sha;
  if (!SHA.test(mergeSha ?? '')) return { ok: false, stage: 'merge', codes: ['MERGE_SHA_UNKNOWN'] };
  return { ...(await verifyProduction(d, mergeSha)), stage: 'deploy', mergeSha, codes: [] };
}

// Deployment + smoke of a commit already on main. Any error counts as a failed check, so a
// merged release can never end up unchecked (C1): the caller then rolls back and freezes.
async function verifyProduction(d, mergeSha) {
  try {
    const deployment = await waitForDeployment(d, mergeSha);
    const smoke = deployment.ok ? await d.smoke() : { ok: false, failures: ['NOT_RUN'] };
    return { ok: deployment.ok && smoke.ok, deployment, smoke };
  } catch (e) {
    return { ok: false, deployment: { ok: false, codes: [`POST_MERGE_CHECK_ERROR:${String(e?.status ?? e?.message ?? 'ERR').slice(0, 40)}`] }, smoke: { ok: false, failures: ['NOT_RUN'] } };
  }
}

const DONE = 'sc-auto-release-done:v1';
async function doneMarker(d, pr, mainSha, outcome) {
  await d.gh.post(`/issues/${pr}/comments`, { body: `Automatyczne wydanie — wynik: ${outcome} (main ${mainSha}).\n\n<!-- ${DONE} ${JSON.stringify({ main_sha: mainSha, outcome })} -->` });
}

// A job killed after a merge leaves a release on main that nobody checked. At start, the newest
// publisher release on main must carry the App's "done" marker; otherwise it is checked now.
async function verifyLastRelease(d) {
  const firstParent = d.git('log', '--first-parent', '--format=%H %P', '-n', '200', 'origin/main').trim().split('\n');
  const reverted = new Set();
  for (const line of firstParent) {
    const [merge, , second] = line.split(' ');
    if (!second) continue;
    const body = d.git('log', '-1', '--format=%B', second);
    for (const m of body.matchAll(/This reverts commit ([0-9a-f]{40})/g)) reverted.add(m[1]);
    const prs = [...releasedFromMain(body)];
    if (!prs.length) continue;
    const comments = await d.gh.paginate(`/issues/${prs[0]}/comments`);
    const done = comments.some(c => c?.user?.login === d.appBotLogin && new RegExp(`<!--\\s*${DONE}\\s+\\{[^<>]*"main_sha":"${merge}"`).test(c.body ?? ''));
    if (done) return null;
    return { merge, pr: prs[0], reverted: reverted.has(merge) };
  }
  return null;
}

export async function waitForDeployment(d, sha) {
  const deadline = d.now().getTime() + (d.config.deploy_timeout_min ?? 25) * 60000;
  for (;;) {
    const list = await d.gh.get(`/deployments?sha=${sha}&per_page=100`);
    const prod = (Array.isArray(list) ? list : []).filter(x => /production/i.test(String(x.environment)) && !/preview/i.test(String(x.environment)));
    for (const dep of prod) {
      const statuses = await d.gh.get(`/deployments/${dep.id}/statuses?per_page=100`);
      const latest = Array.isArray(statuses) ? statuses[0] : null;
      if (latest?.state === 'success') return { ok: true, url: latest.environment_url ?? null, id: dep.id };
      if (latest && ['failure', 'error'].includes(latest.state)) return { ok: false, codes: [`DEPLOYMENT_${latest.state.toUpperCase()}`] };
    }
    if (d.now().getTime() > deadline) return { ok: false, codes: ['DEPLOYMENT_TIMEOUT'] };
    await d.sleep(30000);
  }
}

async function finish(d, pr, started) {
  const migrationsApplied = []; // the publisher never runs migrations today (MIGRATION_EXECUTOR_UNAVAILABLE)
  const r = await mergeAndVerify(d, started);
  if (r.stage === 'ci') {
    await d.gh.patch(`/pulls/${started.releasePr}`, { state: 'closed' });
    await hold(d, pr, `RELEASE_CI_FAILED:${r.codes.join(',')}`);
    return { status: 'HELD', codes: r.codes, release_pr: started.releasePr, source_pr: pr.number };
  }
  if (r.stage === 'merge') {
    return freezeWith(d, r.codes, `release PR #${started.releasePr} (source #${pr.number})`);
  }
  return finishAfterDeploy(d, pr, started, r, migrationsApplied);
}

async function finishAfterDeploy(d, pr, started, r, migrationsApplied = []) {
  const after = afterDeploy({ deployed: r.deployment.ok, smokeOk: r.smoke.ok, migrationsApplied });
  if (after.action === 'DONE') {
    await doneMarker(d, pr.number, r.mergeSha, `wydane, smoke OK (PR #${started.releasePr})`);
    return { status: 'RELEASED', codes: [], source_pr: pr.number, release_pr: started.releasePr, main_sha: r.mergeSha, deployment: r.deployment.url ?? null };
  }
  for (const code of after.codes) (d.error ?? d.log ?? (() => {}))(code);
  // C4: the revert comes first. If this job dies anywhere below, the next run finds either the
  // open revert PR (resumed even while frozen) or the unchecked release (re-verified and rolled
  // back even while frozen); the freeze issue is only the record, opened last.
  let rollback;
  try { rollback = await rollbackRelease(d, { mergeSha: r.mergeSha, sourcePr: pr.number }); }
  catch (e) { rollback = { ok: false, codes: [`ROLLBACK_ERROR:${String(e?.status ?? e?.message ?? 'ERR').slice(0, 40)}`] }; }
  if (rollback.ok) await doneMarker(d, pr.number, r.mergeSha, 'cofnięte');
  const issue = await openFreeze(d, [...after.codes, ...rollback.codes], `release PR #${started.releasePr} (source #${pr.number}), main ${r.mergeSha}`, { deployment: r.deployment, smoke: r.smoke, rollback: rollback.ok ? 'OK — poprzednia wersja działa (smoke OK)' : 'NIEUDANE' });
  return { status: rollback.ok ? 'ROLLED_BACK' : 'ROLLBACK_FAILED', codes: [...after.codes, ...rollback.codes], freeze: issue, source_pr: pr.number };
}

async function rollbackRelease(d, { mergeSha, sourcePr }) {
  const branch = `${RELEASE_PREFIX}revert-pr-${sourcePr}`;
  await d.beforePush?.();
  d.git('fetch', 'origin', 'main');
  d.git('checkout', '-B', branch, 'origin/main');
  if (!d.git.ok('revert', '-m', '1', '--no-edit', mergeSha)) { d.git.ok('revert', '--abort'); return { ok: false, codes: ['ROLLBACK_REVERT_CONFLICT'] }; }
  const releaseHead = d.git('rev-parse', 'HEAD').trim();
  await d.beforePush?.();
  d.git('push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  const files = d.git('diff', '--name-only', 'origin/main', 'HEAD').split('\n').filter(Boolean);
  const meta = { source_pr: sourcePr, source_head: mergeSha, release_head: releaseHead, kind: 'rollback', reverts_pr: sourcePr };
  const pr = await d.gh.post('/pulls', { base: 'main', head: branch, title: `Auto-rollback: #${sourcePr}`, body: releaseBody({ meta, scope: d.detectScope(files) }) });
  const r = await mergeAndVerify(d, { releasePr: pr.number, releaseHead });
  return { ok: r.ok, codes: r.ok ? [] : [`ROLLBACK_${String(r.stage).toUpperCase()}_FAILED`, ...(r.codes ?? [])] };
}

async function hold(d, pr, reason) {
  await d.gh.post(`/issues/${pr.number}/comments`, {
    body: `Automatyczne wydanie wstrzymane: \`${reason}\`. Nowy commit w tym PR (nowy SHA) i nowe review odblokowują ponowną próbę.\n\n<!-- ${HELD} ${JSON.stringify({ head_sha: pr.head.sha, reason: String(reason).slice(0, 200) })} -->`,
  });
}

async function openFreeze(d, codes, where, details = {}) {
  const issue = await d.gh.post('/issues', {
    title: `${FREEZE_TITLE} ${codes[0]}`,
    body: [
      'Automatyczne wydania są ZATRZYMANE do zamknięcia tego zgłoszenia.',
      '',
      `Gdzie: ${where}`,
      `Kody: ${codes.map(c => `\`${c}\``).join(', ')}`,
      codes.includes('ROLLBACK_INSUFFICIENT_DATA_CHANGED')
        ? '\n**UWAGA: cofnięcie kodu NIE wystarczy — migracja zmieniła dane. Potrzebne odtworzenie danych z kopii.**' : '',
      '',
      '```json', JSON.stringify(details, null, 2).slice(0, 4000), '```',
    ].join('\n'),
  });
  return issue.number;
}

async function freezeWith(d, codes, where) {
  const issue = await openFreeze(d, codes, where);
  return { status: 'FROZEN', codes, freeze: issue };
}
