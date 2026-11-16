// SC-AUTO-RELEASE (#369) stage 4a: GitHub-backed READ-ONLY readers for the collector.
// Only GET requests through an injected client. Evidence readers (review/Codex),
// scope-verdict issuer and the released ledger are deliberately NOT provided here: the
// collector then records COLLECT:* errors and the decision is DENY (fail closed).
import { decodeGithubContent } from './github.mjs';
import { withRulesetEvidence } from './ruleset-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;
// Lock snapshot: runs are read from ONE unfiltered listing and only 'completed' (terminal)
// runs are dropped locally; any other or unknown status holds the lock. Bounded pagination.
const LOCK_PAGE = 100;
const LOCK_MAX_PAGES = 10;

export function createAutoReleaseReaders({ client, repository, policy = {} }) {
  if (!client?.request || !client.readComparison || !client.readReleasePlan) throw new Error('READERS_CLIENT_INVALID');
  const root = `/repos/${repository}`;
  const get = path => client.request(path); // GET only: no method passed
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
    async readMigrationSql(path, ref) {
      if (!SAFE_PATH.test(path) || path.includes('..') || !SHA.test(ref ?? '')) throw new Error('MIGRATION_REF_INVALID');
      const file = await get(`${root}/contents/${path}?ref=${ref}`);
      if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('MIGRATION_UNREADABLE');
      return decodeGithubContent(file);
    },
  };
}
