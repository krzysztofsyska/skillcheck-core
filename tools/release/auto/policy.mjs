// SC-AUTO-RELEASE (#369): pure, fail-closed gates of the automatic publisher.
// Every function here only DECIDES from data handed in by the trusted caller.
// No network, no git, no clock reads (the caller passes `now`). Missing or
// malformed evidence always means DENY with an explicit reason code.

export const SHA = /^[0-9a-f]{40}$/;

// Release scope that never ships automatically. Path based; a denylist on top of the
// evidence checks, never proof of safety by itself.
// PAYMENT_PATH_FREEZE: owner decision 2026-11-15 (#369), confirmed 2026-11-16: no automatic
// release may change the payment path (integration, purchase flow, prices, package catalog,
// order states) until Stripe works in test mode and the owner lifts the freeze. Always on.
export const OWNER_CONSENT_PATHS = [
  // Tokens match a whole path segment or any -/_/. delimited part of one (lib/sc19-payment-http.ts).
  ['PAYMENTS', /(^|[/._-])(p24|przelewy24|billing|payments?|pricing|fakturownia|invoices?|platnosci)([/._-]|$)/i],
  ['OUTBOUND_SENDS', /(^|[/._-])(mail|email|sms|voice|retell|voip|notifications?|leads?|digest|resend)([/._-]|$)/i],
  // Senders whose names say nothing about sending (bulk CV upload notifies by e-mail).
  ['OUTBOUND_SENDS', /^lib\/cv-bulk(-runner)?\.ts$/],
  // Files whose names say nothing about money but hold customer-facing prices / package copy.
  ['PAYMENT_PATH_FREEZE', /^(app\/components\/marketing\/(content\.ts|package-comparison\.tsx)|app\/preselekcja\/|lib\/public-future-offers\.ts$)/],
  ['PAYMENT_PATH_FREEZE', /(^|[/._-])(kup|buy|checkout|orders?|catalogs?|offers?|packages?|cennik|prices?|purchases?|stripe|zakupy?|zamowieni[ae])([/._-]|$)/i],
  // The publisher never ships changes to itself, workflows, env files or Supabase config:
  // those change who can do what, so they need a human merge.
  ['SECRETS_OR_PIPELINE', /^(\.github\/|\.env|vercel\.json$|tools\/agent-pipeline\/|tools\/release\/|supabase\/config)/i],
];

const NPM_MANIFEST = /^(package|package-lock)\.json$/;

// Destructive SQL: hard refusal, explicit code per kind. Scans the RAW text (comments and
// literals included) so nothing can be hidden; a false positive only means "not automatic".
const DESTRUCTIVE = [
  ['DROP', /\bdrop\s+(table|schema|column|view|materialized\s+view|function|procedure|type|index|sequence|trigger|policy|constraint|extension|role|owned|database|publication|rule)\b/i],
  ['DELETE', /\bdelete\s+from\b/i],
  ['TRUNCATE', /\btruncate\b/i],
  ['ALTER_DROP', /\balter\s+table\b[^;]*\bdrop\b/i],
  ['ALTER_TYPE', /\balter\s+(table\b[^;]*\balter\s+(column\s+)?\S+\s+(set\s+data\s+)?type|type\b)/i],
  ['RENAME', /\brename\s+(to|column|constraint)\b/i],
  ['UPDATE_ROWS', /\bupdate\s+(only\s+)?[a-z_"][\w".]*\s+set\b/i],
];

export function destructiveSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return ['UNREADABLE'];
  return DESTRUCTIVE.filter(([, re]) => re.test(sql)).map(([code]) => code);
}

/**
 * Scope of one candidate change.
 * @param files       changed paths (strings)
 * @param migrations  [{ path, sql }] for every changed supabase/migrations/* file
 * @returns { reasons: string[], migrations: string[] }
 */
export function classifyRelease(files, migrations = []) {
  if (!Array.isArray(files) || !files.length || files.some(f => typeof f !== 'string' || !f)) {
    return { reasons: ['INVALID_OR_EMPTY_FILE_LIST'], migrations: [] };
  }
  const reasons = [];
  for (const file of files) {
    for (const [code, re] of OWNER_CONSENT_PATHS) {
      // npm manifests are not the package catalog ("pakiety"); only the freeze token "package" hits them.
      if (code === 'PAYMENT_PATH_FREEZE' && NPM_MANIFEST.test(file)) continue;
      if (re.test(file)) reasons.push(`${code}:${file}`);
    }
  }
  const migrationFiles = files.filter(f => /^supabase\/migrations\//.test(f));
  const list = Array.isArray(migrations) ? migrations : [];
  for (const path of migrationFiles) {
    const m = list.find(x => x && x.path === path);
    for (const kind of destructiveSql(m?.sql)) reasons.push(`DESTRUCTIVE_SQL:${kind}:${path}`);
  }
  return { reasons, migrations: migrationFiles };
}

// Changed LINES (added or removed) that touch payments or prices, whatever the file is called:
// a payment change hidden in an innocently named file is still caught. Fail-closed by design.
// `zł` without \b: ł is not a word character for the regex engine, so \bzł\b would miss "300 zł".
const PAYMENT_CONTENT = /przelewy24|\bp24[_A-Za-z]|P24_|sc19[-_]payment|fakturownia|stripe|checkout|zł|\bPLN\b|grosz|price|cennik|\bcen[ay]\b|amount_(gross|net)|orders?_status/iu;
// Changed lines that touch real outbound sending (e-mail provider, voice provider).
const OUTBOUND_CONTENT = /api\.resend\.com|RESEND_API_KEY|\bretell|sendBulkEmail|sendMail|twilio/i;
export function paymentContentFindings(patches) {
  if (!Array.isArray(patches)) return ['PAYMENT_CONTENT_UNREADABLE'];
  const out = [];
  for (const p of patches) {
    if (!p || typeof p.path !== 'string' || typeof p.patch !== 'string') { out.push('PAYMENT_CONTENT_UNREADABLE'); continue; }
    const changed = p.patch.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (changed.some(l => PAYMENT_CONTENT.test(l))) out.push(`PAYMENT_CONTENT_FREEZE:${p.path}`);
    if (changed.some(l => OUTBOUND_CONTENT.test(l))) out.push(`OUTBOUND_CONTENT:${p.path}`);
  }
  return out;
}

/**
 * Fresh database copy before every production migration.
 * @param backups  [{ status, inserted_at }] from the Supabase Management API (trusted reader)
 * @param now      Date of the decision
 * @param maxAgeHours  freshness limit
 */
export function backupGate({ backups, now, maxAgeHours = 24 } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return ['BACKUP_CLOCK_INVALID'];
  if (!Array.isArray(backups)) return ['BACKUP_EVIDENCE_MISSING'];
  const done = backups
    .filter(b => b && String(b.status).toUpperCase() === 'COMPLETED')
    .map(b => new Date(b.inserted_at))
    .filter(d => !Number.isNaN(d.getTime()) && d.getTime() <= now.getTime());
  if (!done.length) return ['BACKUP_NOT_COMPLETED'];
  const newest = Math.max(...done.map(d => d.getTime()));
  if (now.getTime() - newest > maxAgeHours * 3600 * 1000) return ['BACKUP_STALE'];
  return [];
}

// Machine-readable independent review verdict, posted as a PR comment by the reviewer:
// <!-- sc-review-verdict:v1 {"verdict":"PASS","head_sha":"<40 hex>","reviewer":"session_…","builder":"session_…"} -->
const VERDICT_RE = /<!--\s*sc-review-verdict:v1\s+(\{[^<>]{1,600}\})\s*-->/g;
const SESSION = /^session_[A-Za-z0-9]{8,64}$/;
const TRUSTED_ASSOCIATION = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function parseReviewVerdicts(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!c || typeof c.body !== 'string' || !TRUSTED_ASSOCIATION.has(c.author_association)) continue;
    for (const m of c.body.matchAll(VERDICT_RE)) {
      let v;
      try { v = JSON.parse(m[1]); } catch { continue; }
      if (!v || typeof v !== 'object') continue;
      out.push({ verdict: v.verdict, head_sha: v.head_sha, reviewer: v.reviewer, builder: v.builder, at: c.created_at });
    }
  }
  return out;
}

/** PASS from a reviewer session other than the builder, on the exact head SHA, not superseded. */
export function reviewGate(comments, headSha) {
  if (!SHA.test(headSha ?? '')) return ['REVIEW_HEAD_INVALID'];
  const forHead = parseReviewVerdicts(comments).filter(v => v.head_sha === headSha);
  if (!forHead.length) return ['REVIEW_PASS_MISSING'];
  const last = forHead[forHead.length - 1];
  if (last.verdict !== 'PASS') return [`REVIEW_NOT_PASS:${String(last.verdict).slice(0, 30)}`];
  if (!SESSION.test(last.reviewer ?? '') || !SESSION.test(last.builder ?? '')) return ['REVIEW_IDENTITY_INVALID'];
  if (last.reviewer === last.builder) return ['REVIEW_NOT_INDEPENDENT'];
  return [];
}

// Codex connector: not required, but unresolved findings on the exact SHA block.
const CODEX_BOT_ID = 199175422;
const CODEX_STATE_RE = /<!--\s*codex-review-state:v1\s+(\{[^<>]{1,2000}\})\s*-->/;
export function codexGate(comments, headSha) {
  const reasons = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (c?.user?.id !== CODEX_BOT_ID || typeof c.body !== 'string') continue;
    const m = CODEX_STATE_RE.exec(c.body);
    if (!m) continue;
    let s; try { s = JSON.parse(m[1]); } catch { reasons.push('CODEX_STATE_UNREADABLE'); continue; }
    for (const k of ['code_review', 'security_review']) {
      const r = s?.[k];
      if (r?.commit_sha === headSha && r.has_unresolved_findings === true) reasons.push(`CODEX_UNRESOLVED_FINDINGS:${k}`);
    }
  }
  return reasons;
}

export const REQUIRED_CHECKS = ['verify', 'Agent contract / scope gate'];

/** Green CI on the exact SHA: the newest run of every required check completed with success. */
export function ciGate(checkRuns, sha, required = REQUIRED_CHECKS) {
  if (!SHA.test(sha ?? '')) return ['CI_HEAD_INVALID'];
  const runs = Array.isArray(checkRuns) ? checkRuns.filter(r => r && r.head_sha === sha) : [];
  const reasons = [];
  for (const name of required) {
    const mine = runs.filter(r => r.name === name).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    if (!mine.length) reasons.push(`CI_MISSING:${name}`);
    else if (mine[0].status !== 'completed') reasons.push(`CI_PENDING:${name}`);
    else if (mine[0].conclusion !== 'success') reasons.push(`CI_FAILED:${name}`);
  }
  return reasons;
}

/**
 * Whole decision for one candidate PR (already merged into integration).
 * @param input.pr          { number, merged, head_sha, merge_commit_sha, base_ref }
 * @param input.files / input.migrations / input.checkRuns / input.comments
 * @param input.migrationExecutor  true only if the trusted workflow holds an unattended
 *                                 production migration credential (today: never)
 * @param input.backups / input.now  backup evidence for migration releases
 */
export function evaluateCandidate(input) {
  try {
    if (!input || typeof input !== 'object') return deny(['INVALID_INPUT']);
    const { pr } = input;
    const reasons = [];
    if (!pr || pr.merged !== true || pr.base_ref !== 'integration') reasons.push('PR_NOT_MERGED_INTO_INTEGRATION');
    if (!SHA.test(pr?.head_sha ?? '') || !SHA.test(pr?.merge_commit_sha ?? '')) reasons.push('PR_SHA_INVALID');
    const scope = classifyRelease(input.files, input.migrations);
    reasons.push(...scope.reasons);
    reasons.push(...paymentContentFindings(input.patches));
    if (!Array.isArray(input.provenance)) reasons.push('MERGE_PROVENANCE_UNKNOWN');
    else reasons.push(...input.provenance);
    // Migrations already on integration but not yet on production: product code may depend on
    // them, so only changes outside product code (docs, tests) may ship before they do.
    if (!Array.isArray(input.unreleasedMigrations)) reasons.push('UNRELEASED_MIGRATIONS_UNKNOWN');
    else if (input.unreleasedMigrations.length && input.files?.some?.(f => PRODUCT_CODE.test(f))) reasons.push('UNRELEASED_MIGRATIONS_PRECEDE');
    if (scope.migrations.length) {
      reasons.push(...backupGate({ backups: input.backups, now: input.now }));
      if (input.migrationExecutor !== true) reasons.push('MIGRATION_EXECUTOR_UNAVAILABLE');
    }
    reasons.push(...ciGate(input.checkRuns, pr?.head_sha));
    reasons.push(...reviewGate(input.comments, pr?.head_sha));
    reasons.push(...codexGate(input.comments, pr?.head_sha));
    const unique = [...new Set(reasons)];
    return unique.length ? deny(unique) : { decision: 'ALLOW', reasons: [], migrations: scope.migrations };
  } catch {
    return deny(['INVALID_INPUT']);
  }
}
const PRODUCT_CODE = /^(app|lib|components|scripts|supabase|db|public|middleware\.ts|next\.config)/;
const deny = reasons => ({ decision: 'DENY', reasons, migrations: [] });

/** What to do after the production deployment was checked. */
export function afterDeploy({ deployed, smokeOk, migrationsApplied }) {
  const codes = [];
  if (deployed === true && smokeOk === true) return { action: 'DONE', freeze: false, codes };
  codes.push(deployed === true ? 'SMOKE_FAILED' : 'DEPLOYMENT_NOT_CONFIRMED');
  // Rolling code back does not undo data changes made by a migration.
  if (Array.isArray(migrationsApplied) && migrationsApplied.length) codes.push('ROLLBACK_INSUFFICIENT_DATA_CHANGED');
  return { action: 'ROLLBACK', freeze: true, codes };
}
