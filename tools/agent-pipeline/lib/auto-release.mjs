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
// Migrations qualify ONLY if every statement matches an explicitly recognised
// narrow additive shape. Anything else (including things a denylist never
// thought of: DROP VIEW, DO $$, function calls, NOT NULL adds, new tables whose
// RLS/policies are not recognised) is NOT proven safe and is refused.
const ID = '(?:"?[a-z_][a-z0-9_]*"?\\.)?"?[a-z_][a-z0-9_]*"?';
const TYPE = '(?:text|integer|int|bigint|smallint|boolean|uuid|timestamptz|timestamp|date|jsonb|real|double precision|numeric(?:\\(\\d{1,3}(?:,\\d{1,3})?\\))?|varchar\\(\\d{1,4}\\)|text\\[\\])';
const LIT = "(?:-?\\d+(?:\\.\\d+)?|true|false|null|'[^'$\\\;]*')";
const ADD_COLUMN = new RegExp(`^alter table (?:if exists )?${ID} add column (?:if not exists )?"?[a-z_][a-z0-9_]*"? ${TYPE}(?: default ${LIT})?$`, 'i');
const ADD_INDEX = new RegExp(`^create index (?:if not exists )?"?[a-z_][a-z0-9_]*"? on ${ID} \\("?[a-z_][a-z0-9_]*"?(?:, ?"?[a-z_][a-z0-9_]*"?)*\\)$`, 'i');
export function isRecognisedAdditiveSql(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 100000) return false;
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  if (text.includes('$') || text.includes('\\') || /\/\*|\*\//.test(text)) return false;
  const statements = text.split(';').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!statements.length) return false;
  return statements.every(st => ADD_COLUMN.test(st) || ADD_INDEX.test(st));
}
const SHA = /^[0-9a-f]{40}$/;

export function classifyReleaseFiles(files, migrations = []) {
  const reasons = [];
  if (!Array.isArray(files) || files.some(f => typeof f !== 'string' || !f)) return { reasons: ['INVALID_FILES'], hasMigrations: false };
  const list = Array.isArray(migrations) ? migrations : null;
  if (!list) reasons.push('INVALID_MIGRATIONS');
  for (const file of files) {
    for (const [code, re] of OWNER_CONSENT_PATHS) if (re.test(file)) reasons.push(`${code}:${file}`);
  }
  const migrationFiles = files.filter(f => /^supabase\/migrations\//.test(f));
  for (const f of migrationFiles) {
    const m = (list ?? []).find(x => x && typeof x === 'object' && x.path === f);
    if (!m || typeof m.sql !== 'string' || !m.sql.trim()) { reasons.push(`MIGRATION_UNREADABLE:${f}`); continue; }
    if (!isRecognisedAdditiveSql(m.sql)) reasons.push(`MIGRATION_NOT_PROVEN_ADDITIVE:${f}`);
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
function evaluateUnsafe(input) {
  const deny = [];
  const { promotion, current, trusted, ci, review, codex, lock } = input;
  if (trusted?.p24Hold !== false) deny.push('P24_HOLD');
  if (!current || !SHA.test(current.integrationSha ?? '') || !SHA.test(current.mainSha ?? '')) deny.push('CURRENT_STATE_UNKNOWN');
  if (!promotion) deny.push('NO_PROMOTION_MANIFEST');
  else {
    if (promotion.blockedReason) deny.push(`MANIFEST_${promotion.blockedReason}`);
    const m = promotion.manifest;
    if (!Array.isArray(m?.tasks) || !m.tasks.length) deny.push('NO_TASKS');
    else if (m.tasks.some(t => !t || typeof t !== 'object' || typeof t.task_id !== 'string')) deny.push('INVALID_TASKS');
    if (current && (m?.integration_sha !== current.integrationSha || m?.main_sha !== current.mainSha)) deny.push('SHA_CHANGED');
    for (const t of Array.isArray(m?.tasks) ? m.tasks : []) {
      if (!t || typeof t !== 'object') continue;
      if (t.integration_source !== 'verified_ci_review') deny.push(`UNVERIFIED_TASK:${t.task_id}`);
    }
    const scope = classifyReleaseFiles(m?.files, input.migrations);
    deny.push(...scope.reasons);
    if (!Array.isArray(m?.files) || !m.files.length) deny.push('EMPTY_FILE_LIST');
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
  // Independent semantic verdict for the WHOLE release, bound to repo/base/head/manifest.
  // Must come from a trusted independent reader, never from builder JSON/labels.
  const v = input.scopeVerdict;
  const expectedHash = promotion?.manifest && current ? sha256(promotion.manifest) : null;
  const verdictOk = v && typeof v === 'object' && v.source === 'trusted_independent_scope_reader'
    && v.verdict === 'LOW_RISK_COMPATIBLE' && expectedHash
    && v.repository === current.repository && v.base_sha === current.mainSha
    && v.head_sha === current.integrationSha && v.manifest_hash === expectedHash;
  if (!v) deny.push('SCOPE_VERDICT_MISSING');
  else if (!verdictOk) deny.push('SCOPE_VERDICT_MISMATCH_OR_UNTRUSTED');
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

export function evaluateAutoRelease(input) {
  try {
    if (!input || typeof input !== 'object') return { decision: 'DENY', reasons: ['INVALID_INPUT'], binding: null };
    return evaluateUnsafe(input);
  } catch {
    return { decision: 'DENY', reasons: ['INVALID_INPUT'], binding: null };
  }
}
