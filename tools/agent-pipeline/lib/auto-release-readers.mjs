// SC-AUTO-RELEASE (#369) stage 4a: GitHub-backed READ-ONLY readers for the collector.
// Only GET requests through an injected client. Evidence readers (CI/review/Codex),
// scope-verdict issuer, lock and ledger are deliberately NOT provided here: the
// collector then records COLLECT:* errors and the decision is DENY (fail closed).
import { decodeGithubContent } from './github.mjs';
import { withRulesetEvidence } from './ruleset-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

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
    async readMigrationSql(path, ref) {
      if (!SAFE_PATH.test(path) || path.includes('..') || !SHA.test(ref ?? '')) throw new Error('MIGRATION_REF_INVALID');
      const file = await get(`${root}/contents/${path}?ref=${ref}`);
      if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('MIGRATION_UNREADABLE');
      return decodeGithubContent(file);
    },
  };
}
