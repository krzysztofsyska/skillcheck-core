// SC-AUTO-RELEASE (#369): pure, fail-closed qualification of a whole release.
// It only DECIDES. It performs no remote effect, never forges the owner
// attestation and never reads candidate code as authorization.
import { sha256 } from './canonical.mjs';
import { protectionFromRulesets } from './protection.mjs';

// Release scope that always needs separate owner consent (path based; it is a
// denylist on top of the evidence checks, never proof of safety by itself).
const OWNER_CONSENT_PATHS = [
  ['PAYMENTS', /(^|\/)(p24|przelewy24|billing|payments?|pricing|fakturownia|invoices?)(\/|\.|-|_|$)/i],
  ['OUTBOUND_SENDS', /(^|\/)(mail|email|sms|voice|retell|voip|notifications?|sales-leads?)(\/|\.|-|_|$)/i],
  ['SECRETS_OR_PIPELINE', /^(\.github\/|\.env|vercel\.json$|tools\/agent-pipeline\/|supabase\/config)/i],
];
const DESTRUCTIVE_SQL = /\b(drop\s+(table|column|schema|policy|function|index|type|trigger)|truncate|delete\s+from|alter\s+table[^;]*\b(drop|rename|alter\s+column[^;]*type)|update\s+[\w."]+\s+set)\b/i;
const ACCESS_SQL = /\b(grant|revoke|create\s+policy|alter\s+policy|enable\s+row\s+level|disable\s+row\s+level|security\s+definer|alter\s+default\s+privileges)\b/i;
const SHA = /^[0-9a-f]{40}$/;

export function classifyReleaseFiles(files, migrations = []) {
  const reasons = [];
  for (const file of files) {
    for (const [code, re] of OWNER_CONSENT_PATHS) if (re.test(file)) reasons.push(`${code}:${file}`);
  }
  const migrationFiles = files.filter(f => /^supabase\/migrations\//.test(f));
  for (const f of migrationFiles) {
    const m = migrations.find(x => x?.path === f);
    if (!m || typeof m.sql !== 'string' || !m.sql.trim()) { reasons.push(`MIGRATION_UNREADABLE:${f}`); continue; }
    const sql = m.sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (DESTRUCTIVE_SQL.test(sql)) reasons.push(`DESTRUCTIVE_DB:${f}`);
    if (ACCESS_SQL.test(sql)) reasons.push(`ACCESS_CHANGE_DB:${f}`);
  }
  return { reasons, hasMigrations: migrationFiles.length > 0 };
}

/**
 * @param input.promotion  result of preparePromotion() built from trusted records
 * @param input.current    { repository, integrationSha, mainSha } freshly read by the trusted caller
 * @param input.trusted    { p24Hold } from trusted configuration; ONLY literal false releases the hold
 * @param input.rulesets / input.policy / input.environments  raw evidence for protectionFromRulesets
 * @param input.ci / input.review  per-SHA evidence { head_sha, conclusion, completed }
 * @param input.codex      automatic review state { completed, open_findings } for the head SHA
 * @param input.migrations [{ path, sql }] read by the trusted caller
 * @param input.lock       { held, inflight } release serialization state
 * @param input.released   array of integration SHAs already released (idempotency)
 */
export function evaluateAutoRelease(input = {}) {
  const deny = [];
  const { promotion, current, trusted, ci, review, codex, lock } = input;
  if (trusted?.p24Hold !== false) deny.push('P24_HOLD');
  if (!current || !SHA.test(current.integrationSha ?? '') || !SHA.test(current.mainSha ?? '')) deny.push('CURRENT_STATE_UNKNOWN');
  if (!promotion) deny.push('NO_PROMOTION_MANIFEST');
  else {
    if (promotion.blockedReason) deny.push(`MANIFEST_${promotion.blockedReason}`);
    const m = promotion.manifest;
    if (!m?.tasks?.length) deny.push('NO_TASKS');
    if (current && (m?.integration_sha !== current.integrationSha || m?.main_sha !== current.mainSha)) deny.push('SHA_CHANGED');
    for (const t of m?.tasks ?? []) {
      if (t.integration_source !== 'verified_ci_review') deny.push(`UNVERIFIED_TASK:${t.task_id}`);
    }
    const scope = classifyReleaseFiles(m?.files ?? [], input.migrations);
    deny.push(...scope.reasons);
    if (!m?.files?.length) deny.push('EMPTY_FILE_LIST');
    if (scope.hasMigrations) {
      const rb = promotion.runbook;
      if (!rb || typeof rb.backup !== 'string' || !rb.backup || rb.rollback_db_compatible !== true) deny.push('MIGRATION_RECOVERY_OR_ROLLBACK_INCOMPATIBLE');
    }
    if (!(promotion.smokeTests?.length > 0) || !promotion.rollback) deny.push('MISSING_SMOKE_OR_ROLLBACK');
  }
  const fresh = e => e && e.completed === true && e.conclusion === 'success' && current && e.head_sha === current.integrationSha;
  if (!fresh(ci)) deny.push('CI_MISSING_OR_STALE');
  if (!fresh(review) || review.verdict !== 'PASS') deny.push('REVIEW_MISSING_OR_STALE');
  if (!(codex && codex.completed === true && codex.head_sha === current?.integrationSha && codex.open_findings === 0)) deny.push('AUTO_REVIEW_PENDING_OR_FINDINGS');
  let protection = null;
  try { protection = protectionFromRulesets(input.rulesets, input.policy, input.environments); } catch { protection = null; }
  if (!protection) deny.push('PROTECTION_UNREADABLE');
  else {
    const p = protection;
    const ok = p.exclusiveWritersConfirmed && p.mainProtected && p.integrationProtected && p.agentStateProtected
      && p.requiredChecksPinnedToApp && p.environmentsConfirmed && !p.qualityGatesBypass && !p.scOps001Exception;
    if (!ok) deny.push('PROTECTION_WEAK');
  }
  if (!lock || lock.held !== false || lock.inflight !== 0) deny.push('RELEASE_NOT_SERIALIZED');
  if (!Array.isArray(input.released) || input.released.includes(current?.integrationSha)) deny.push('DUPLICATE_OR_UNKNOWN_RELEASE_STATE');
  const reasons = [...new Set(deny)];
  const binding = current && promotion?.manifest ? sha256({ repository: current.repository, base: current.mainSha, head: current.integrationSha, manifest: promotion.manifest }) : null;
  return reasons.length ? { decision: 'DENY', reasons, binding: null }
    : { decision: 'ALLOW', reasons: [], binding, note: 'Qualification only; publishing needs the trusted publisher (activation stage).' };
}
