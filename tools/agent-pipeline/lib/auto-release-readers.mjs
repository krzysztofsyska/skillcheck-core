// SC-AUTO-RELEASE (#369) stage 4a: GitHub-backed READ-ONLY readers for the collector.
// Only GET requests through an injected client (plus the one fixed read-only GraphQL query
// used for review threads). The signed scope-verdict requirement (stage 4j) was removed by
// the owner on 2026-11-16 (#369): no separate issuer App is built. The released ledger is derived from `main` (stage 4g);
// task records come from the protected `agent-state` branch (stage 4i).
import { decodeGithubContent } from './github.mjs';
import { withRulesetEvidence } from './ruleset-evidence.mjs';
import { createCodexEvidenceReader } from './codex-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;
// Lock snapshot: runs are read from ONE unfiltered listing and only 'completed' (terminal)
// runs are dropped locally; any other or unknown status holds the lock. Bounded pagination.
const LOCK_PAGE = 100;
const LOCK_MAX_PAGES = 10;
// Stage 4i: task records come only from the protected `agent-state` branch, all files read
// at ONE pinned commit. Keys must already be filesystem-safe (no safeTaskId collisions).
const STATE_REF = 'agent-state';
const TASK_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RECORDS = 500;
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param codexReviewerId  numeric GitHub id of the Codex reviewer, pinned by the TRUSTED caller
 *   (the same value it passes to evaluateAutoRelease as trusted.codexReviewerId). Never read
 *   from PR text, labels or candidate code. Unpinned => readCodexEvidence throws => DENY.
 */
export function createAutoReleaseReaders({ client, repository, policy = {}, codexReviewerId } = {}) {
  if (!client?.request || !client.readComparison || !client.readReleasePlan) throw new Error('READERS_CLIENT_INVALID');
  const root = `/repos/${repository}`;
  const get = path => client.request(path); // GET only: no method passed
  // Stage 4e: Codex evidence (stage 4b reader). Built lazily so a missing pin or client method
  // is an explicit per-read error (COLLECT:READ_CODEX_FAILED), never an omitted check.
  let codexReader = null;
  const codex = () => {
    if (!Number.isInteger(codexReviewerId) || codexReviewerId <= 0) throw new Error('CODEX_REVIEWER_NOT_PINNED');
    codexReader ??= createCodexEvidenceReader({ client, repository, reviewerId: codexReviewerId });
    return codexReader;
  };
  return {
    repository,
    async readBranchSha(name) {
      const b = await client.readBranch(name);
      const sha = b?.commit?.sha;
      if (!SHA.test(sha ?? '')) throw new Error('BRANCH_SHA_INVALID');
      return sha;
    },
    async readComparisonComplete(base, head) {
      // completeComparison throws on any truncated/inconsistent result.
      const c = await client.readComparison(base, head);
      return { ...c, complete: true };
    },
    readReleasePlan: ref => client.readReleasePlan(ref),
    // Stage 4i (#369): task records for preparePromotion, read-only from the protected
    // `agent-state` branch (the controller's journal projection; protection is checked
    // separately by evaluateAutoRelease via agentStateProtected). The ref is resolved once,
    // the index and every task file are read at that exact commit, and the ref is re-read
    // at the end: a moved ref, a missing/oversized/non-JSON file, a key that is not already
    // safe, a record whose task_id or state_revision disagrees with the index, or more than
    // MAX_RECORDS tasks throws, so the collector records READ_RECORDS_FAILED and DENIES.
    // A missing branch is an error too (never "no records"). Never written, never PR text.
    async readRecords() {
      const resolve = async () => {
        const ref = await get(`${root}/git/ref/heads/${STATE_REF}`);
        const sha = ref?.object?.sha;
        if (ref?.ref !== `refs/heads/${STATE_REF}` || ref.object.type !== 'commit' || !SHA.test(sha ?? '')) throw new Error('RECORDS_REF_INVALID');
        return sha;
      };
      const readJson = async (path, head) => {
        const file = await get(`${root}/contents/${path}?ref=${head}`);
        if (file?.type !== 'file' || file.path !== path || file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('RECORDS_FILE_UNREADABLE');
        try { return JSON.parse(decodeGithubContent(file)); } catch { throw new Error('RECORDS_FILE_INVALID'); }
      };
      const head = await resolve();
      const index = await readJson('state/index.json', head);
      if (!plainObject(index) || index.schema_version !== 1 || !plainObject(index.tasks)) throw new Error('RECORDS_INDEX_INVALID');
      const keys = Object.keys(index.tasks);
      if (keys.length > MAX_RECORDS) throw new Error('RECORDS_TOO_MANY');
      const records = Object.create(null);
      for (const key of keys) {
        if (!TASK_KEY.test(key) || RESERVED_KEYS.has(key)) throw new Error('RECORDS_TASK_ID_INVALID');
        const entry = index.tasks[key];
        const record = await readJson(`state/tasks/${key}.json`, head);
        if (!plainObject(record) || record.task_id !== key || !plainObject(entry)
            || !Number.isSafeInteger(entry.revision) || record.state_revision !== entry.revision) throw new Error('RECORDS_INCONSISTENT');
        records[key] = record;
      }
      if (await resolve() !== head) throw new Error('RECORDS_RACE');
      return records;
    },
    async readRulesets() {
      const listed = await get(`${root}/rulesets?per_page=100`);
      if (!Array.isArray(listed) || listed.length >= 100) throw new Error('RULESETS_INCOMPLETE');
      const out = [];
      for (const item of listed) out.push(withRulesetEvidence(await get(`${root}/rulesets/${item.id}`), policy));
      return out;
    },
    async readEnvironments() {
      const out = {};
      const names = [policy.environments?.owner_acceptance, policy.environments?.production_approval, policy.environments?.agent_review]
        .map(e => e?.name).filter(Boolean);
      for (const name of names) {
        const path = `${root}/environments/${encodeURIComponent(name)}`;
        const env = await get(path);
        const bp = await get(`${path}/deployment-branch-policies?per_page=100`);
        if (!Array.isArray(bp?.branch_policies) || bp.branch_policies.length >= 100) throw new Error('ENV_POLICIES_INCOMPLETE');
        out[name] = { ...env, branch_policies: bp.branch_policies };
      }
      return out;
    },
    // Stage 4c: CI evidence for the exact SHA. Accepts only the check run named in policy
    // (default sc-agent/ci) created by the pinned controller App; anything partial,
    // duplicated, foreign or for another SHA yields no `completed:true/success` evidence.
    async readCiEvidence(sha) {
      if (!SHA.test(sha ?? '')) throw new Error('CI_REF_INVALID');
      const appId = policy.controller_app_id;
      if (!Number.isInteger(appId)) throw new Error('CI_APP_NOT_PINNED');
      const name = policy.required_checks?.integration?.[0] ?? 'sc-agent/ci';
      const res = await get(`${root}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`);
      if (!Array.isArray(res?.check_runs) || res.total_count !== res.check_runs.length || res.check_runs.length >= 100) throw new Error('CI_INCOMPLETE');
      const mine = res.check_runs.filter(c => c.name === name && c.app?.id === appId && c.head_sha === sha);
      if (mine.length !== 1) throw new Error('CI_NOT_UNIQUE');
      const c = mine[0];
      return { head_sha: c.head_sha, completed: c.status === 'completed', conclusion: c.conclusion ?? null };
    },
    // Stage 4f (#369): consume only the controller App's exact-SHA review gate.
    // This is the controller's validated review check, NOT the per-task Codex
    // evidence or independent whole-release scope verdict; both are mandatory
    // separate gates in evaluateAutoRelease. A foreign, missing, stale or
    // ambiguous check can never produce PASS.
    async readReviewEvidence(sha) {
      if (!SHA.test(sha ?? '')) throw new Error('REVIEW_REF_INVALID');
      const appId = policy.controller_app_id;
      if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('REVIEW_APP_NOT_PINNED');
      const name = 'sc-agent/review';
      if (!Array.isArray(policy.required_checks?.integration)
          || !policy.required_checks.integration.includes(name)) throw new Error('REVIEW_CHECK_NOT_REQUIRED');
      const res = await get(`${root}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`);
      if (!Array.isArray(res?.check_runs) || res.total_count !== res.check_runs.length
          || res.check_runs.length >= 100) throw new Error('REVIEW_INCOMPLETE');
      if (res.check_runs.length !== 1) throw new Error('REVIEW_NOT_UNIQUE');
      const check = res.check_runs[0];
      if (check?.name !== name || check.app?.id !== appId || check.head_sha !== sha) {
        throw new Error('REVIEW_PROVENANCE_MISMATCH');
      }
      const completed = check.status === 'completed';
      const conclusion = completed ? check.conclusion ?? null : null;
      return { head_sha: sha, completed, conclusion, verdict: completed && conclusion === 'success' ? 'PASS' : null };
    },
    // Stage 4d: release serialization. Takes ONE unfiltered snapshot of the pinned promote
    // workflow's runs (all pages) and counts every run whose status is not 'completed'.
    // Per-status queries are not used: a run moving between statuses between two such
    // queries could appear in none of them. Unpinned id, malformed/truncated/duplicated
    // pages, a total_count that changes during the read, more than LOCK_MAX_PAGES pages or
    // a run of another workflow throw, so the collector records READ_LOCK_FAILED → DENY.
    async readLock() {
      const workflowId = policy.workflow_ids?.promote;
      if (!Number.isInteger(workflowId)) throw new Error('LOCK_WORKFLOW_NOT_PINNED');
      const page = async n => {
        const res = await get(`${root}/actions/workflows/${workflowId}/runs?per_page=${LOCK_PAGE}&page=${n}&exclude_pull_requests=true`);
        const runs = res?.workflow_runs;
        if (!Array.isArray(runs) || !Number.isSafeInteger(res.total_count) || res.total_count < 0) throw new Error('LOCK_INCOMPLETE');
        if (runs.some(run => run?.workflow_id !== workflowId || !Number.isSafeInteger(run.id) || typeof run.status !== 'string')) throw new Error('LOCK_FOREIGN_RUN');
        return { total: res.total_count, runs };
      };
      const first = await page(1);
      const pages = Math.ceil(first.total / LOCK_PAGE);
      if (pages > LOCK_MAX_PAGES) throw new Error('LOCK_INCOMPLETE');
      const seen = new Map();
      for (let n = 1; n <= Math.max(pages, 1); n += 1) {
        const p = n === 1 ? first : await page(n);
        if (p.total !== first.total) throw new Error('LOCK_INCOMPLETE');
        if (p.runs.length !== (n < pages ? LOCK_PAGE : first.total - LOCK_PAGE * (pages - 1)) && first.total > 0) throw new Error('LOCK_INCOMPLETE');
        for (const run of p.runs) {
          if (seen.has(run.id)) throw new Error('LOCK_INCOMPLETE');
          seen.set(run.id, run.status);
        }
      }
      if (seen.size !== first.total) throw new Error('LOCK_INCOMPLETE');
      // Re-read page 1: a run created or deleted during pagination shifts pages; refuse.
      const again = await page(1);
      if (again.total !== first.total || again.runs.some(run => !seen.has(run.id))) throw new Error('LOCK_INCOMPLETE');
      // A completed run can be re-run (same id, active again): a run is active if ANY read saw it active.
      for (const run of again.runs) if (run.status !== 'completed') seen.set(run.id, run.status);
      let inflight = 0;
      for (const status of seen.values()) if (status !== 'completed') inflight += 1;
      return { held: inflight > 0, inflight };
    },
    async readCodexEvidence(args) {
      return codex()(args);
    },
    // Stage 4g: release ledger (idempotency) without any new write path or state store.
    // `main` is the production source branch, so a candidate is already released exactly
    // when it is reachable from `main`. One compare main...candidate bound to both exact
    // SHAs: 'identical'/'behind' => released, 'ahead'/'diverged' => not yet. An unknown
    // status, counts inconsistent with the status, or a response bound to other commits
    // throws, so the collector records READ_RELEASED_FAILED and the decision is DENY.
    async readReleased({ base, head } = {}) {
      if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) throw new Error('RELEASED_REF_INVALID');
      const res = await get(`${root}/compare/${base}...${head}?per_page=1`);
      const ahead = res?.ahead_by, behind = res?.behind_by;
      if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) throw new Error('RELEASED_UNREADABLE');
      if (res.base_commit?.sha !== base) throw new Error('RELEASED_BINDING_MISMATCH');
      const expected = { identical: ahead === 0 && behind === 0, behind: ahead === 0 && behind > 0,
        ahead: ahead > 0 && behind === 0, diverged: ahead > 0 && behind > 0 };
      if (!Object.hasOwn(expected, res.status) || expected[res.status] !== true) throw new Error('RELEASED_STATUS_INCONSISTENT');
      const released = res.status === 'identical' || res.status === 'behind';
      // Reachable from main means the merge base IS the candidate itself.
      if (released && res.merge_base_commit?.sha !== head) throw new Error('RELEASED_BINDING_MISMATCH');
      return released ? [head] : [];
    },
    async readMigrationSql(path, ref) {
      if (!SAFE_PATH.test(path) || path.includes('..') || !SHA.test(ref ?? '')) throw new Error('MIGRATION_REF_INVALID');
      const file = await get(`${root}/contents/${path}?ref=${ref}`);
      if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('MIGRATION_UNREADABLE');
      return decodeGithubContent(file);
    },
  };
}
