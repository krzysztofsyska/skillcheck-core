// SC-AUTO-RELEASE (#369) stage 4b: trusted, READ-ONLY Codex review evidence for a whole release.
// Per task/PR it binds three DIFFERENT SHAs and never treats them as equal:
//   review.commit_id == review head == task.head_sha   (what Codex reviewed)
//   PR.merge_commit_sha == task.merge_sha              (what landed in integration)
//   integrationSha                                     (release candidate; only the manifest binds it)
// Anything missing, ambiguous, partial or unprovable is an error => the caller DENIES.
import { sha256 } from './canonical.mjs';

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GOOD_STATES = new Set(['COMMENTED', 'APPROVED']);

export const CODEX_SOURCE = 'trusted_codex_reader';

const fail = code => { throw new Error(code); };

/** Pure per-entry check shared by the reader and the evaluator. Returns reason codes. */
export function codexEntryProblems(e, { reviewerId } = {}) {
  const p = [];
  if (!e || typeof e !== 'object') return ['CODEX_ENTRY_INVALID'];
  if (!Number.isInteger(reviewerId) || reviewerId <= 0) p.push('CODEX_REVIEWER_NOT_PINNED');
  else if (e.reviewer_id !== reviewerId) p.push('CODEX_REVIEWER_MISMATCH');
  if (!SHA.test(e.review_head_sha ?? '') || e.review_head_sha !== e.task_head_sha) p.push('CODEX_REVIEW_HEAD_MISMATCH');
  if (!SHA.test(e.merge_commit_sha ?? '') || e.merge_commit_sha !== e.task_merge_sha) p.push('CODEX_MERGE_SHA_MISMATCH');
  if (!Number.isInteger(e.review_id) || !Number.isInteger(e.pr_number)) p.push('CODEX_REVIEW_UNIDENTIFIED');
  if (!GOOD_STATES.has(e.review_state)) p.push('CODEX_REVIEW_STATE_BLOCKS');
  if (e.completed !== true) p.push('CODEX_REVIEW_INCOMPLETE');
  if (e.open_findings !== 0) p.push('CODEX_OPEN_FINDINGS');
  return p;
}

/** Pure validation of the whole aggregate against the freshly collected promotion. */
export function codexAggregateProblems(codex, { current, manifest, reviewerId }) {
  if (!codex || typeof codex !== 'object') return ['CODEX_EVIDENCE_MISSING'];
  const p = [];
  if (codex.source !== CODEX_SOURCE) p.push('CODEX_UNTRUSTED_SOURCE');
  if (!current || !manifest) return [...p, 'CODEX_BINDING_UNKNOWN'];
  if (codex.repository !== current.repository || !REPO.test(codex.repository ?? '')) p.push('CODEX_REPOSITORY_MISMATCH');
  if (codex.base_sha !== current.mainSha || codex.head_sha !== current.integrationSha) p.push('CODEX_RELEASE_SHA_MISMATCH');
  if (codex.manifest_hash !== sha256(manifest)) p.push('CODEX_MANIFEST_MISMATCH');
  if (codex.complete !== true || codex.completed !== true || codex.open_findings !== 0) p.push('CODEX_INCOMPLETE_OR_FINDINGS');
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  const entries = Array.isArray(codex.entries) ? codex.entries : [];
  const commits = new Set(Array.isArray(manifest.commits) ? manifest.commits : []);
  if (!tasks.length || entries.length !== tasks.length) p.push('CODEX_COVERAGE_MISMATCH');
  for (const t of tasks) {
    const matches = entries.filter(e => e?.task_id === t.task_id);
    if (matches.length !== 1) { p.push(`CODEX_COVERAGE_MISMATCH:${t.task_id}`); continue; }
    const e = matches[0];
    if (e.task_head_sha !== t.head_sha || e.task_merge_sha !== t.merge_sha) p.push(`CODEX_TASK_BINDING_MISMATCH:${t.task_id}`);
    if (!commits.has(t.merge_sha)) p.push(`CODEX_MERGE_NOT_IN_RELEASE:${t.task_id}`);
    p.push(...codexEntryProblems(e, { reviewerId }));
  }
  const covered = Array.isArray(codex.covered_commits) ? codex.covered_commits : [];
  const want = tasks.map(t => t.merge_sha).sort();
  if (JSON.stringify([...covered].sort()) !== JSON.stringify(want)) p.push('CODEX_COVERED_COMMITS_MISMATCH');
  return [...new Set(p)];
}

/**
 * @param client  read-only: readPullsForCommit(sha), readPull(n), readCommit(sha),
 *                readReviews(n) (full pagination), readReviewThreads(n) (fixed query, full pagination)
 * @param reviewerId  numeric GitHub id pinned in trusted configuration
 */
export function createCodexEvidenceReader({ client, repository, reviewerId }) {
  if (!client?.readPullsForCommit || !client.readPull || !client.readCommit || !client.readReviews || !client.readReviewThreads) fail('CODEX_CLIENT_INVALID');
  if (!REPO.test(repository ?? '') || !Number.isInteger(reviewerId) || reviewerId <= 0) fail('CODEX_CONFIG_INVALID');
  return async function readCodexEvidence({ repository: repo, base, head, manifest }) {
    if (repo !== repository || !SHA.test(base ?? '') || !SHA.test(head ?? '') || !manifest) fail('CODEX_INPUT_INVALID');
    if (manifest.integration_sha !== head || manifest.main_sha !== base) fail('CODEX_MANIFEST_BINDING_INVALID');
    const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
    if (!tasks.length) fail('CODEX_NO_TASKS');
    const releaseCommits = new Set(manifest.commits ?? []);
    const cache = new Map(); // PR number -> { pull, reviews, threads } (one read per PR per run)
    const entries = [];
    for (const t of tasks) {
      if (!SHA.test(t?.head_sha ?? '') || !SHA.test(t?.merge_sha ?? '') || typeof t.task_id !== 'string') fail('CODEX_TASK_INVALID');
      if (!releaseCommits.has(t.merge_sha)) fail('CODEX_MERGE_NOT_IN_RELEASE');
      const candidates = await client.readPullsForCommit(t.merge_sha);
      if (!Array.isArray(candidates) || candidates.length !== 1 || !Number.isInteger(candidates[0]?.number)) fail('CODEX_PR_AMBIGUOUS');
      const number = candidates[0].number;
      if (!cache.has(number)) {
        const pull = await client.readPull(number);
        const reviews = await client.readReviews(number);
        const threads = await client.readReviewThreads(number);
        cache.set(number, { pull, reviews, threads });
      }
      const { pull, reviews, threads } = cache.get(number);
      if (pull?.number !== number || pull.merged !== true || pull.base?.ref !== 'integration'
          || pull.base?.repo?.full_name !== repository || pull.merge_commit_sha !== t.merge_sha) fail('CODEX_PR_UNCONFIRMED');
      // First version: plain merge commit with a proven parent == reviewed head. Squash/rebase => unconfirmed.
      const commit = await client.readCommit(t.merge_sha);
      const parents = (commit?.parents ?? []).map(x => x?.sha);
      if (commit?.sha !== t.merge_sha || parents.length !== 2 || !parents.includes(t.head_sha)) fail('CODEX_MERGE_PROVENANCE_UNCONFIRMED');
      if (!Array.isArray(reviews) || !Array.isArray(threads)) fail('CODEX_DATA_INCOMPLETE');
      const mine = reviews.filter(r => r?.user?.id === reviewerId);
      // Newest state-changing review by the pinned reviewer (any commit) must not be a standing change request.
      const lastDecision = mine.filter(r => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED' || r.state === 'DISMISSED').at(-1);
      if (lastDecision?.state === 'CHANGES_REQUESTED' || mine.some(r => r.state === 'PENDING')) fail('CODEX_REVIEW_STATE_BLOCKS');
      // Completed = submitted, non-dismissed review on EXACTLY the reviewed head. A bare empty COMMENTED proves nothing.
      const done = mine.filter(r => r.commit_id === t.head_sha && GOOD_STATES.has(r.state) && r.submitted_at
        && (r.state === 'APPROVED' || (typeof r.body === 'string' && r.body.trim().length > 0)));
      if (!done.length) fail('CODEX_REVIEW_MISSING_FOR_HEAD');
      const review = done.at(-1);
      if (!Number.isInteger(review.id) || typeof review.user?.login !== 'string') fail('CODEX_REVIEW_UNIDENTIFIED');
      const open = threads.filter(th => th?.isResolved !== true).length;
      entries.push({ task_id: t.task_id, pr_number: number, task_head_sha: t.head_sha, review_head_sha: review.commit_id,
        task_merge_sha: t.merge_sha, merge_commit_sha: pull.merge_commit_sha, review_id: review.id,
        reviewer_id: review.user.id, reviewer_login: review.user.login, review_state: review.state, completed: true, open_findings: open });
    }
    const covered = entries.map(e => e.merge_commit_sha);
    if (new Set(covered).size !== covered.length) fail('CODEX_COVERAGE_AMBIGUOUS');
    const open = entries.reduce((n, e) => n + e.open_findings, 0);
    return { source: CODEX_SOURCE, repository, base_sha: base, head_sha: head, manifest_hash: sha256(manifest), complete: true,
      completed: entries.every(e => e.completed), open_findings: open, covered_commits: covered, entries };
  };
}
