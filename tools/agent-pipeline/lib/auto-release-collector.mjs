// SC-AUTO-RELEASE (#369) stage 3: READ-ONLY collector for evaluateAutoRelease().
// It only reads through injected readers and returns { input, collectErrors }.
// It never writes, never dispatches, never reads secret values and never takes
// evidence from PR prose, labels or candidate code. Anything missing, partial,
// truncated or racing is left undefined/flagged so evaluateAutoRelease() denies.
import { preparePromotion } from './promotion.mjs';
import { evaluateAutoRelease } from './auto-release.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MIGRATION = /^supabase\/migrations\/[^/]+\.sql$/;
const MAX_MIGRATIONS = 200;

async function attempt(errors, code, fn) {
  try { return await fn(); } catch { errors.push(code); return undefined; }
}

/**
 * @param readers  injected, read-only:
 *   repository, readBranchSha(name), readRecords(), readComparisonComplete(base, head) -> {status, commits, files, complete},
 *   readReleasePlan(ref), readRulesets(), readEnvironments(), readMigrationSql(path, ref),
 *   readCiEvidence(sha), readReviewEvidence(sha), readCodexEvidence(sha), readScopeVerdict({base, head, manifest}),
 *   readLock(), readReleased()
 * @param trusted  { p24Hold } from trusted configuration; passed through untouched
 * @param policy   pipeline policy (for protection evaluation)
 */
export async function collectAutoReleaseInput({ readers, trusted, policy }) {
  const errors = [];
  const r = readers ?? {};
  const integrationSha = await attempt(errors, 'READ_INTEGRATION_FAILED', () => r.readBranchSha('integration'));
  const mainSha = await attempt(errors, 'READ_MAIN_FAILED', () => r.readBranchSha('main'));
  const current = { repository: r.repository, integrationSha, mainSha };
  const input = { trusted, policy, current };
  if (!SHA.test(integrationSha ?? '') || !SHA.test(mainSha ?? '')) return { input, collectErrors: errors };

  const records = await attempt(errors, 'READ_RECORDS_FAILED', () => r.readRecords());
  if (records && typeof records === 'object') {
    // Full production->candidate range; any non-complete comparison is refused.
    const github = {
      async readComparison(base, head) {
        const c = await r.readComparisonComplete(base, head);
        if (!c || c.complete !== true || !Array.isArray(c.commits) || !Array.isArray(c.files)) throw new Error('COMPARISON_INCOMPLETE');
        return c;
      },
      readReleasePlan: ref => r.readReleasePlan(ref),
    };
    input.promotion = await attempt(errors, 'PROMOTION_MANIFEST_FAILED', () => preparePromotion(github, policy, records, integrationSha, mainSha)) ?? undefined;
  }
  input.rulesets = await attempt(errors, 'READ_RULESETS_FAILED', () => r.readRulesets());
  input.environments = await attempt(errors, 'READ_ENVIRONMENTS_FAILED', () => r.readEnvironments());

  const files = input.promotion?.manifest?.files;
  const migrationPaths = Array.isArray(files) ? files.filter(f => MIGRATION.test(f)) : [];
  if (migrationPaths.length > MAX_MIGRATIONS) errors.push('TOO_MANY_MIGRATIONS');
  else {
    const migrations = [];
    for (const path of migrationPaths) {
      const sql = await attempt(errors, 'READ_MIGRATION_FAILED', () => r.readMigrationSql(path, integrationSha));
      migrations.push({ path, sql });
    }
    input.migrations = migrations;
  }

  input.ci = await attempt(errors, 'READ_CI_FAILED', () => r.readCiEvidence(integrationSha));
  input.review = await attempt(errors, 'READ_REVIEW_FAILED', () => r.readReviewEvidence(integrationSha));
  input.codex = await attempt(errors, 'READ_CODEX_FAILED', () => r.readCodexEvidence(integrationSha));
  if (input.promotion?.manifest) {
    input.scopeVerdict = await attempt(errors, 'READ_SCOPE_VERDICT_FAILED',
      () => r.readScopeVerdict({ base: mainSha, head: integrationSha, manifest: input.promotion.manifest }));
  }
  input.lock = await attempt(errors, 'READ_LOCK_FAILED', () => r.readLock());
  input.released = await attempt(errors, 'READ_RELEASED_FAILED', () => r.readReleased());

  // SHA race: both refs must still point at the SHAs the whole decision was bound to.
  const again = await attempt(errors, 'RECHECK_FAILED', async () => [await r.readBranchSha('integration'), await r.readBranchSha('main')]);
  if (!again || again[0] !== integrationSha || again[1] !== mainSha) errors.push('SHA_RACE');
  return { input, collectErrors: errors };
}

/** Collect, then decide. Any collection error forces DENY with explicit reason codes. */
export async function qualifyRelease(args) {
  const { input, collectErrors } = await collectAutoReleaseInput(args);
  const decision = evaluateAutoRelease(input);
  if (!collectErrors.length) return { ...decision, audit: { collectErrors: [] } };
  return { decision: 'DENY', reasons: [...new Set([...collectErrors.map(e => `COLLECT:${e}`), ...decision.reasons])],
    binding: null, audit: { collectErrors } };
}
