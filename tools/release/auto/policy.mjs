// SC-AUTO-RELEASE (#369): pure, fail-closed gates of the automatic publisher.
// Every function here only DECIDES from data handed in by the trusted caller.
// No network, no git, no clock reads (the caller passes `now`). Missing or
// malformed evidence always means DENY with an explicit reason code.

export const SHA = /^[0-9a-f]{40}$/;

// Release scope that never ships automatically. Path based; a denylist on top of the
// evidence checks, never proof of safety by itself.
// The payment-path freeze (PAYMENT_PATH_FREEZE / PAYMENT_CONTENT_FREEZE, owner 2026-11-15) was
// lifted by the owner on 2026-11-19 (docs/DECYZJE.md: "1. Zdjąć zamrożenie płatności w core…"
// -> "1 tak"). Purchase flow, prices, package catalog, order states and Stripe now release like
// other reviewed work. PAYMENTS below is the older, separate rule for code that moves money or
// issues invoices (billing, P24, Fakturownia).
export const OWNER_CONSENT_PATHS = [
  // Tokens match a whole path segment or any -/_/. delimited part of one (lib/sc19-payment-http.ts).
  ['PAYMENTS', /(^|[/._-])(p24|przelewy24|billing|payments?|fakturownia|invoices?|platnosci)([/._-]|$)/i],
  ['OUTBOUND_SENDS', /(^|[/._-])(mail|email|sms|voice|retell|voip|notifications?|leads?|digest|resend)([/._-]|$)/i],
  // Senders whose names say nothing about sending (bulk CV upload notifies by e-mail).
  ['OUTBOUND_SENDS', /^lib\/cv-bulk(-runner)?\.ts$/],
  // The publisher never ships changes to itself, workflows, env files or Supabase config:
  // those change who can do what, so they need a human merge. `tools/db-migrate/` is the executor
  // that runs with the production database credential (db-migrate-production and #491 auto-migrate).
  ['SECRETS_OR_PIPELINE', /^(\.github\/|\.env|vercel\.json$|tools\/agent-pipeline\/|tools\/release\/|tools\/db-migrate\/|supabase\/config)/i],
];

// Single-pass SQL lexer (#491 review fix). Comments, string literals and quoted identifiers are
// recognised TOGETHER, left to right, as PostgreSQL reads them, so a `--` or `/*` inside a literal
// cannot hide the statement after it (and a quote inside a comment cannot hide one either).
// Handles: '…' with '' escapes, E'…' with backslash escapes, $$…$$ / $tag$…$tag$, "…" identifiers
// with "" escapes, -- line comments and NESTED /* */ block comments.
// Output: `text` with every comment replaced by a space, every literal by '' and every dollar body
// by $$ (so `;` splits statements correctly); `dollar` when a dollar-quoted body was seen.
// Anything it cannot read cleanly (unterminated literal, identifier, dollar body or comment; a
// backslash in a plain literal, whose meaning depends on standard_conforming_strings) => ok:false.
const IDENT_CHAR = /[\w$\u0080-￿]/;
export function lexSql(sql) {
  if (typeof sql !== 'string') return { ok: false, code: 'UNREADABLE', text: '', dollar: false };
  let out = ''; let i = 0; let dollar = false;
  const fail = code => ({ ok: false, code, text: out, dollar });
  while (i < sql.length) {
    const c = sql[i]; const next = sql[i + 1]; const prev = i > 0 ? sql[i - 1] : '';
    if (c === '-' && next === '-') {
      // PostgreSQL ends a `--` comment at \n OR a lone \r (a CR-only line break counts).
      const m = /[\r\n]/.exec(sql.slice(i + 2));
      out += ' '; i = m ? i + 2 + m.index + 1 : sql.length; continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth) return fail('UNTERMINATED_COMMENT');
      out += ' '; continue;
    }
    if (c === "'") {
      // E'…' (escape string): the E must be a token of its own, not the end of an identifier.
      const escape = /[eE]/.test(prev) && !IDENT_CHAR.test(i > 1 ? sql[i - 2] : '');
      if (escape) out = out.slice(0, -1);
      let j = i + 1; let closed = false;
      while (j < sql.length) {
        if (sql[j] === '\\') { if (!escape) return fail('AMBIGUOUS_LITERAL'); j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } closed = true; break; }
        j++;
      }
      if (!closed) return fail('UNTERMINATED_LITERAL');
      out += "''"; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let closed = false; let name = '';
      while (j < sql.length) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { name += '"'; j += 2; continue; } closed = true; break; }
        name += sql[j]; j++;
      }
      if (!closed) return fail('UNTERMINATED_IDENTIFIER');
      // A plain name keeps its spelling; anything else (spaces, ';', '--', quotes) becomes a neutral one.
      out += /^[A-Za-z_][\w$]*$/.test(name) ? `"${name}"` : '"q"'; i = j + 1; continue;
    }
    if (c === '$' && !IDENT_CHAR.test(prev)) {
      const m = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) return fail('UNTERMINATED_DOLLAR_QUOTE');
        dollar = true; out += '$$'; i = end + m[0].length; continue;
      }
    }
    out += c; i++;
  }
  return { ok: true, code: null, text: out, dollar };
}

// Destructive SQL: hard refusal, explicit code per kind. Scans the RAW text (comments and
// literals included, so nothing can be hidden there) AND the lexed text (where a `;` inside a
// literal or a comment between keywords can no longer break a pattern); the union is refused.
// A false positive only means "not automatic".
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
  const lexed = lexSql(sql).text;
  return DESTRUCTIVE.filter(([, re]) => re.test(sql) || re.test(lexed)).map(([code]) => code);
}

// #491 (review fix): ALLOWLIST of additive statements, an extra gate beside DESTRUCTIVE. Anything
// not clearly additive is refused (NON_ADDITIVE_SQL) and waits for the owner via db-migrate-production.
// The text is read by `lexSql` first (comments and literals in one pass); input it cannot read
// cleanly is refused (UNPARSEABLE_*), dollar quoting (function bodies, DO blocks) is refused
// outright, as are policies, grants, functions, views, triggers, types and extensions.
const NAME = String.raw`"?[a-z_][\w$]*"?`;
const IDENT = `(${NAME}\\.)?${NAME}`;
// PR #499 review fix: every rule checks the WHOLE statement shape, never a prefix. A prefix rule let
// `create table t (x) as select private.purge_closed_sales_leads()` through: additive-looking
// start, data-deleting function call after it. Bodies of CREATE TABLE / ADD COLUMN are checked
// element by element by `safeDefinition`; CREATE INDEX accepts plain column lists only.
const INDEX_COL = `${NAME}( [a-z_]\\w*)?( (asc|desc))?( nulls (first|last))?`;
const ADDITIVE = [
  ['CREATE_SCHEMA', new RegExp(`^create schema (if not exists )?${NAME}$`)],
  ['CREATE_TABLE', st => createTableOk(st)],
  // no CONCURRENTLY: migrations run inside a transaction, where PostgreSQL rejects it.
  // plain column lists only: no WHERE (partial), INCLUDE, WITH, TABLESPACE or expression columns
  ['CREATE_INDEX', new RegExp(`^create (unique )?index (if not exists )?(${NAME} )?on (only )?${IDENT}( using (btree|gin|gist|brin|hash))? ?\\(${INDEX_COL}(,${INDEX_COL})*\\)$`)],
  ['ENABLE_RLS', new RegExp(`^alter table (if exists )?${IDENT} enable row level security$`)],
  ['COMMENT', new RegExp(`^comment on (table|column|schema|index) (${NAME}\\.){0,2}${NAME} is (''|null)$`)],
  // only ADD COLUMN actions, each one a safe column definition
  ['ADD_COLUMN', st => addColumnOk(st)],
];

// Characters a column / table-constraint definition may contain. Leaves out operators that could
// name a user-defined operator function (~ | & # @ % ^ ?) and anything else unusual.
const SAFE_DEF_CHARS = /^[\w$ '",.()=<>!+\-*/:[\]]+$/;
// Words that never belong in a plain column definition: subqueries, CTAS, LIKE/INHERITS/PARTITION
// OF copies, generated expressions (AS), storage clauses, partial-index style clauses.
const DEF_FORBIDDEN = /\b(select|like|ilike|similar|as|inherits|partition|of|exists|with|using|tablespace|execute|include|where|from|into|values|returning|lateral|over|filter|within|nextval|setval)\b/;
// `word(` is allowed only for type modifiers, constraint keywords and a few harmless built-ins.
const PAREN_KEYWORDS = new Set(['check', 'key', 'unique', 'in', 'and', 'or', 'not', 'any', 'all',
  'numeric', 'decimal', 'varchar', 'char', 'character', 'varying', 'bit', 'time', 'timestamp', 'timestamptz', 'interval', 'float']);
const SAFE_CALLS = new Set(['now', 'gen_random_uuid', 'length', 'char_length', 'octet_length', 'lower', 'upper', 'btrim', 'coalesce', 'jsonb_typeof', 'cardinality', 'array_length']);
const QUALIFIED_CALLS = new Set(['extensions.gen_random_uuid', ...[...SAFE_CALLS].map(f => `pg_catalog.${f}`)]);
const CALL = /(references )?((?:"?[a-z_][\w$]*"?\.)*"?[a-z_][\w$]*"?)\(/g;
// DEFAULT only with a literal or one of the allowlisted value functions (optionally cast).
const SAFE_DEFAULT = /\bdefault (''|-?\d+(\.\d+)?|true|false|null|(pg_catalog\.)?now\(\)|((extensions|pg_catalog)\.)?gen_random_uuid\(\)|current_timestamp|current_date|array\[\])(::[a-z_]\w*(\[\])?)?(?=[ ,)]|$)/g;

function safeDefinition(def) {
  if (typeof def !== 'string' || !def.trim() || !SAFE_DEF_CHARS.test(def)) return false;
  const s = def.replace(/\bwith(out)? time zone\b/g, 'tz').replace(/\bgenerated (always|by default) as identity\b/g, 'identity');
  if (DEF_FORBIDDEN.test(s)) return false;
  for (const [, ref, name] of s.matchAll(CALL)) {
    if (ref) continue; // references <table>(<column>)
    if (name.includes('"')) return false; // a quoted callee is a function name, never a keyword
    if (name.includes('.') ? !QUALIFIED_CALLS.has(name) : !(PAREN_KEYWORDS.has(name) || SAFE_CALLS.has(name))) return false;
  }
  return (s.match(/\bdefault\b/g) ?? []).length === [...s.matchAll(SAFE_DEFAULT)].length;
}

// Splits at commas outside parentheses; null when the parentheses do not balance.
function splitTopLevel(text) {
  const parts = []; let depth = 0; let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth < 0) return null; }
    else if (text[i] === ',' && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(from));
  return parts.map(p => p.trim());
}

const CREATE_TABLE_HEAD = new RegExp(`^create table (if not exists )?${IDENT} ?\\(`);
function createTableOk(st) {
  const m = CREATE_TABLE_HEAD.exec(st);
  if (!m || !st.endsWith(')')) return false;
  // the paren opened after the name must be the one that closes the statement: nothing after it
  const inner = st.slice(m[0].length, -1);
  const parts = splitTopLevel(inner);
  return Array.isArray(parts) && parts.every(safeDefinition);
}

const ALTER_TABLE_HEAD = new RegExp(`^alter table (if exists )?${IDENT} (?=add column )`);
const ADD_COLUMN_ACTION = new RegExp(`^add column (if not exists )?${NAME} `);
function addColumnOk(st) {
  const m = ALTER_TABLE_HEAD.exec(st);
  if (!m) return false;
  const parts = splitTopLevel(st.slice(m[0].length));
  return Array.isArray(parts) && parts.every(p => {
    const a = ADD_COLUMN_ACTION.exec(p);
    return Boolean(a) && safeDefinition(p.slice(a[0].length));
  });
}
export const TXN_CONTROL = /^(begin|start|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|commit\s+prepared|rollback\s+prepared)\b/;
export function nonAdditiveSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return ['UNREADABLE'];
  const lexed = lexSql(sql);
  if (!lexed.ok) return [`UNPARSEABLE_${lexed.code}`];
  if (lexed.dollar) return ['DOLLAR_QUOTING'];
  const bad = [];
  // One space between words, none around ( ) and , — so every rule sees one canonical shape.
  const stmts = lexed.text.split(';').map(raw => raw.replace(/\s+/g, ' ').replace(/ ?([(),]) ?/g, '$1').trim().toLowerCase()).filter(Boolean);
  stmts.forEach((st, idx) => {
    // Only the OUTER frame: `begin` as the first and `commit` as the last statement. Any other
    // transaction control (a COMMIT in the middle persists earlier statements and leaves the rest
    // un-undoable) is refused wherever it stands.
    if (st === 'begin' && idx === 0) return;
    if (st === 'commit' && idx === stmts.length - 1) return;
    if (TXN_CONTROL.test(st)) { bad.push('TXN_CONTROL'); return; }
    if (!ADDITIVE.some(([, rule]) => (typeof rule === 'function' ? rule(st) : rule.test(st)))) bad.push(st.split(' ').slice(0, 2).join('_').toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 30) || 'STATEMENT');
  });
  return [...new Set(bad)];
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
      if (re.test(file)) reasons.push(`${code}:${file}`);
    }
  }
  const migrationFiles = files.filter(f => /^supabase\/migrations\//.test(f));
  const list = Array.isArray(migrations) ? migrations : [];
  for (const path of migrationFiles) {
    const m = list.find(x => x && x.path === path);
    const destructive = destructiveSql(m?.sql);
    for (const kind of destructive) reasons.push(`DESTRUCTIVE_SQL:${kind}:${path}`);
    if (!destructive.length) for (const kind of nonAdditiveSql(m?.sql)) reasons.push(`NON_ADDITIVE_SQL:${kind}:${path}`);
  }
  return { reasons, migrations: migrationFiles };
}

// Changed LINES (added or removed) that call the money-moving or invoicing code covered by
// PAYMENTS, whatever the file is called. Prices, Stripe, checkout and order states are no longer
// frozen (owner 2026-11-19).
const PAYMENT_CONTENT = /przelewy24|\bp24[_A-Za-z]|P24_|sc19[-_]payment|fakturownia/iu;
// Changed lines that touch real outbound sending (e-mail provider, voice provider).
const OUTBOUND_CONTENT = /api\.resend\.com|RESEND_API_KEY|\bretell|sendBulkEmail|sendMail|twilio/i;
export function paymentContentFindings(patches) {
  if (!Array.isArray(patches)) return ['PAYMENT_CONTENT_UNREADABLE'];
  const out = [];
  for (const p of patches) {
    if (!p || typeof p.path !== 'string' || typeof p.patch !== 'string') { out.push('PAYMENT_CONTENT_UNREADABLE'); continue; }
    const changed = p.patch.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (changed.some(l => PAYMENT_CONTENT.test(l))) out.push(`PAYMENTS_CONTENT:${p.path}`);
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

/**
 * The screening worker is a Supabase Edge Function deployed by hand
 * (`deploy-screening-worker.yml` is `workflow_dispatch` only), so merging to `main` updates
 * the Vercel app and leaves the worker on its old version. A change to the worker or to any
 * module it shares with the app (for example the dispatch signature header in
 * `lib/screening-hmac.ts`) would therefore split the two sides: the app sends the new
 * contract, the undeployed worker rejects it, and CV analyses stop — silently, because the
 * production smoke test does not run a real analysis. Such a release is held until the
 * worker is deployed together with it.
 * `workerModules` is the import closure of the worker, computed by the trusted caller from
 * the release commit. Fail closed: not an array means the closure is unknown.
 */
// #461 stage 1: the publisher now carries a worker deploy STEP (`publisher.mjs`
// `deployWorkerStep`, real runner in `worker-deploy.mjs`) that runs after the merge and before
// smoke, and `afterDeploy` refuses DONE without its confirmation. This gate still refuses every
// such release on purpose: the deploy token is not placed in the publisher's environment yet,
// and no automatic worker deploy has been verified for real. #461 stage 2 (a separate commit and
// review) turns this block into the step, once the token is placed and one real deploy has been
// verified.
export const WORKER_PATHS = /^supabase\/functions\//;
export function workerGate(files, workerModules) {
  if (!Array.isArray(files)) return ['WORKER_SCOPE_UNKNOWN'];
  if (!Array.isArray(workerModules) || workerModules.some(m => typeof m !== 'string' || !m)) return ['WORKER_SCOPE_UNKNOWN'];
  const shared = new Set(workerModules);
  const hit = files.filter(f => WORKER_PATHS.test(f) || shared.has(f));
  if (!hit.length) return [];
  return [`WORKER_DEPLOY_REQUIRED:${[...new Set(hit)].slice(0, 3).map(f => f.slice(0, 50)).join(',')}`];
}

/**
 * Real review conversations on the task PR, whoever opened them (Codex connector, a human,
 * another agent). The marker read by `codexGate` is published by nothing today, so it can
 * never be the only source: an inline finding left unresolved must block on its own.
 * Fail closed — the trusted caller hands in the thread list; absence is never silence.
 * An outdated thread still counts: "outdated" means the line moved, not that it was answered.
 * @param threads [{ resolved: boolean, outdated?: boolean, path?: string }]
 */
export function reviewThreadsGate(threads) {
  if (!Array.isArray(threads)) return ['REVIEW_THREADS_UNKNOWN'];
  const open = threads.filter(t => !t || typeof t !== 'object' || t.resolved !== true);
  if (!open.length) return [];
  const where = [...new Set(open.map(t => String(t?.path ?? '?').slice(0, 40)))].slice(0, 3).join(',');
  return [`REVIEW_THREADS_UNRESOLVED:${open.length}:${where}`];
}

// GitHub's own semantics, which this gate follows: a change request stands until its author
// APPROVES or it is DISMISSED. A COMMENTED review is not a decision and must never cancel one —
// otherwise a reply in a thread (GitHub records one as a COMMENTED review) would clear the
// objection, and because agent sessions write with the owner's identity (AGENTS.md rule 5), an
// agent could clear the owner's. PENDING means a review someone started and never submitted.
const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const REVIEW_STATES = new Set([...REVIEW_DECISIONS, 'COMMENTED', 'PENDING']);
/**
 * A submitted review that asks for changes blocks until its author withdraws it, whatever SHA
 * it was made on — pushing a new commit does not answer an objection. Only the newest DECISION
 * per author counts (APPROVED / DISMISSED clear it, COMMENTED does not); on equal timestamps the
 * blocking one wins. An unsubmitted (PENDING) review on the exact head blocks too.
 * Fail closed: a missing list, an unreadable entry, an unknown state or an unparsable timestamp
 * all refuse rather than pass.
 * @param reviews [{ user: { login }, state, commit_id, submitted_at }]
 */
export function reviewStatesGate(reviews, headSha) {
  if (!SHA.test(headSha ?? '')) return ['REVIEW_HEAD_INVALID'];
  if (!Array.isArray(reviews)) return ['REVIEW_STATES_UNKNOWN'];
  const newest = new Map(); const pending = new Set();
  for (const r of reviews) {
    if (!r || typeof r !== 'object' || typeof r.state !== 'string' || !REVIEW_STATES.has(r.state)) return ['REVIEW_STATE_UNREADABLE'];
    const who = String(r.user?.login ?? '?');
    if (r.state === 'PENDING') { if (r.commit_id === headSha) pending.add(who); continue; }
    if (!REVIEW_DECISIONS.has(r.state)) continue;
    const at = Date.parse(r.submitted_at ?? '');
    if (!Number.isFinite(at)) return ['REVIEW_STATE_UNREADABLE'];
    const prev = newest.get(who);
    // equal timestamps: keep whichever blocks, never let a tie decide in favour of releasing
    if (!prev || at > prev.at || (at === prev.at && r.state === 'CHANGES_REQUESTED')) newest.set(who, { at, state: r.state });
  }
  const who = [...newest.entries()].filter(([, r]) => r.state === 'CHANGES_REQUESTED').map(([login]) => login);
  const reasons = [];
  if (who.length) reasons.push(`REVIEW_CHANGES_REQUESTED:${who.map(x => x.slice(0, 30)).join(',')}`);
  if (pending.size) reasons.push(`REVIEW_PENDING_SUBMISSION:${[...pending].map(x => x.slice(0, 30)).join(',')}`);
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
 *                                 production migration credential (#491: AUTO_MIGRATE_DATABASE_URL
 *                                 in the `auto-migrate` environment; absent = refused, as before)
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
    reasons.push(...reviewThreadsGate(input.reviewThreads));
    reasons.push(...reviewStatesGate(input.reviews, pr?.head_sha));
    reasons.push(...workerGate(input.files, input.workerModules));
    const unique = [...new Set(reasons)];
    return unique.length ? deny(unique) : { decision: 'ALLOW', reasons: [], migrations: scope.migrations };
  } catch {
    return deny(['INVALID_INPUT']);
  }
}
const PRODUCT_CODE = /^(app|lib|components|scripts|supabase|db|public|middleware\.ts|next\.config)/;
const deny = reasons => ({ decision: 'DENY', reasons, migrations: [] });

/**
 * What to do after the production deployment was checked.
 * @param worker  result of the worker deploy step (#461): { required, ok, unavailable? }.
 *                Fail closed: anything else is WORKER_SCOPE_UNKNOWN, never a silent skip.
 */
export function afterDeploy({ deployed, smokeOk, migrationsApplied, worker }) {
  const codes = [];
  const workerCode = workerOutcome(worker);
  if (deployed === true && smokeOk === true && !workerCode) return { action: 'DONE', freeze: false, codes };
  if (deployed !== true) codes.push('DEPLOYMENT_NOT_CONFIRMED');
  // A failed worker step means smoke never ran, so it is not reported as a smoke failure.
  else if (workerCode) codes.push(workerCode);
  else codes.push('SMOKE_FAILED');
  // Rolling code back does not undo data changes made by a migration.
  if (Array.isArray(migrationsApplied) && migrationsApplied.length) codes.push('ROLLBACK_INSUFFICIENT_DATA_CHANGED');
  return { action: 'ROLLBACK', freeze: true, codes };
}

function workerOutcome(worker) {
  if (!worker || typeof worker !== 'object' || typeof worker.required !== 'boolean') return 'WORKER_SCOPE_UNKNOWN';
  if (!worker.required) return null;
  if (worker.unavailable === true) return 'WORKER_DEPLOY_UNAVAILABLE';
  return worker.ok === true ? null : 'WORKER_DEPLOY_FAILED';
}
