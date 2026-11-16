// SC-AUTO-RELEASE (#369) point 5: nightly restore drill.
//
// production (READ ONLY) --pg_dump--> runner file --pg_restore--> disposable Postgres in this
// runner --> completeness check (every table, exact row counts from the SAME snapshot) -->
// pending migrations from the repository applied on top --> report. The disposable database
// and the dump die with the runner. Nothing is restored into any Supabase project.
//
// Privacy: no row data is ever printed. Errors are reported as counts / SQLSTATE codes only.
// Data of tables that hold secrets, tokens or passwords (and live auth sessions) is excluded
// from the dump by design and listed as such in the report.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const INTERNAL_SCHEMAS = [
  'pg_catalog', 'information_schema', 'extensions', 'graphql', 'graphql_public', 'pgbouncer', 'pgsodium',
  'pgsodium_masks', 'realtime', '_realtime', 'storage', 'supabase_functions', 'vault', 'net', 'cron', '_analytics',
];
// Columns whose content is a secret/credential: the table's DATA is not dumped.
export const SECRET_COLUMN = '(secret|token|password|api_?key|private_?key|crc|signature_key|pseudonym)';

export function validateSourceUrl(url) {
  let u;
  try { u = new URL(url); } catch { return 'SOURCE_URL_INVALID'; }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) return 'SOURCE_URL_INVALID';
  if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return 'SOURCE_URL_LOCAL';
  if (!['require', 'verify-ca', 'verify-full'].includes(u.searchParams.get('sslmode') ?? '')) return 'SOURCE_URL_TLS_REQUIRED';
  return null;
}

const internalList = INTERNAL_SCHEMAS.map(s => `'${s}'`).join(',');
export const SCHEMAS_SQL = `select nspname from pg_namespace where nspname not in (${internalList}) and nspname not like 'pg\\_%' order by 1`;
export const EXCLUDED_SQL = `select distinct table_schema||'.'||table_name from information_schema.columns
  where table_schema not in (${internalList}) and table_schema not like 'pg\\_%'
    and (column_name ~* '${SECRET_COLUMN}' or (table_schema = 'auth' and table_name in
      ('sessions','refresh_tokens','one_time_tokens','flow_state','mfa_challenges','mfa_factors','mfa_amr_claims','saml_relay_states','audit_log_entries')))
  order by 1`;
export const COUNTS_SQL = `select schemaname||'.'||tablename||'='||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text
  from pg_tables where schemaname not in (${internalList}) and schemaname not like 'pg\\_%' order by 1`;

export function parseCounts(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([^=\s]+)=(\d+)$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

export function compareCounts(source, target, excluded = []) {
  const skip = new Set(excluded);
  const missing = []; const mismatched = [];
  let rows = 0;
  for (const [table, n] of Object.entries(source)) {
    if (skip.has(table)) continue;
    rows += n;
    if (!(table in target)) missing.push(table);
    else if (target[table] !== n) mismatched.push(`${table}:${n}->${target[table]}`);
  }
  return { tables: Object.keys(source).length - [...skip].filter(t => t in source).length, rows, missing, mismatched };
}

// pg_restore errors, without ever returning their text (it can carry row values). Expected:
// "schema public already exists" and foreign keys to tables whose DATA is excluded by design.
// Everything else is unexpected and fails the drill.
export function classifyRestoreErrors(stderr, excluded = []) {
  const names = new Set(excluded.map(t => t.split('.').pop()));
  const blocks = String(stderr).split(/^(?=pg_restore: error:)/m).filter(b => b.startsWith('pg_restore: error:'));
  let expected = 0; let unexpected = 0;
  for (const b of blocks) {
    const fk = /violates foreign key constraint/.test(b) && /is not present in table "([^"]+)"/.exec(b);
    if (/schema "public" already exists/.test(b) || (fk && names.has(fk[1]))) expected++; else unexpected++;
  }
  return { expected, unexpected };
}

export function pendingMigrations(files, ledger) {
  const have = new Set(ledger);
  const versions = files.filter(f => /^\d{14}_.+\.sql$/.test(f)).sort();
  return versions.filter(f => !have.has(f.slice(0, 14)));
}

// ---- runtime (GitHub Actions only) ----------------------------------------------------
const IMAGE = process.env.PG_IMAGE ?? 'postgres:17.6-bookworm';
const DUMP_DIR = process.env.DUMP_DIR ?? '/tmp/drill';
const dockerPg = (cmd, env = {}) => ['run', '--rm', '-i', '--network', 'host', '-v', `${DUMP_DIR}:/drill`,
  ...Object.keys(env).flatMap(k => ['-e', k]), IMAGE, 'sh', '-c', cmd];

function session(url, env, { stopOnError = true } = {}) {
  const stop = stopOnError ? '-v ON_ERROR_STOP=1' : '';
  const child = spawn('docker', dockerPg(`exec psql -X -A -t -q ${stop} -d "$DB_URL"`, { DB_URL: 1, PGOPTIONS: 1 }),
    { env: { ...process.env, DB_URL: url, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let dead = null;
  child.stdout.on('data', d => { buf += d; });
  child.stderr.on('data', () => {}); // never echoed: could carry data
  child.on('exit', code => { dead = code; });
  let n = 0;
  return {
    async ask(sql) {
      const mark = `__drill_${++n}__`;
      child.stdin.write(`${sql};\n\\echo ${mark}\n`);
      for (;;) {
        const i = buf.indexOf(`${mark}\n`);
        if (i >= 0) { const out = buf.slice(0, i); buf = buf.slice(i + mark.length + 1); return out.trim(); }
        if (dead !== null) throw new Error('SQL_SESSION_DIED');
        await new Promise(r => setTimeout(r, 100));
      }
    },
    end() { child.stdin.end('\\q\n'); },
  };
}

function docker(cmd, env) {
  const r = spawnSync('docker', dockerPg(cmd, env), { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stderr: r.stderr, sqlstates: [...new Set(r.stderr.match(/ERROR:\s+[0-9A-Z]{5}/g) ?? [])] };
}

async function main() {
  const report = { started_at: new Date().toISOString(), status: 'FAIL', reasons: [] };
  const finish = () => {
    report.finished_at = new Date().toISOString();
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    writeFileSync(join(DUMP_DIR, '..', 'drill-report.json'), json);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Próba odtworzenia kopii: ${report.status}\n\n\`\`\`json\n${json}\n\`\`\`\n`);
    process.exit(report.status === 'PASS' ? 0 : 1);
  };
  const source = process.env.SOURCE_DATABASE_URL ?? '';
  if (!source) { report.reasons.push('BLOCKED_MISSING_SECRET:BACKUP_DRILL_DATABASE_URL'); return finish(); }
  const bad = validateSourceUrl(source);
  if (bad) { report.reasons.push(bad); return finish(); }
  const target = process.env.TARGET_DATABASE_URL;

  // 1. One read-only REPEATABLE READ snapshot: counts and dump see exactly the same data.
  const ro = { PGOPTIONS: '-c default_transaction_read_only=on' };
  const src = session(source, ro);
  await src.ask('begin isolation level repeatable read read only');
  if ((await src.ask("select current_setting('transaction_read_only')")) !== 'on') { report.reasons.push('SOURCE_NOT_READ_ONLY'); return finish(); }
  const snapshot = await src.ask('select pg_export_snapshot()');
  const schemas = (await src.ask(SCHEMAS_SQL)).split('\n').filter(Boolean);
  const excluded = (await src.ask(EXCLUDED_SQL)).split('\n').filter(Boolean);
  const sourceCounts = parseCounts(await src.ask(COUNTS_SQL));
  const ledger = (await src.ask("select version from supabase_migrations.schema_migrations order by 1")).split('\n').filter(Boolean);
  const nArgs = schemas.map(s => `-n '${s.replace(/'/g, '')}'`).join(' ');
  const xArgs = excluded.map(t => `--exclude-table-data='${t.replace(/'/g, '')}'`).join(' ');
  const dump = docker(`exec pg_dump -d "$DB_URL" --snapshot='${snapshot}' -Fc --no-owner --no-privileges ${nArgs} ${xArgs} -f /drill/prod.dump`, { DB_URL: source, ...ro });
  await src.ask('commit');
  src.end();
  report.source = { schemas, tables: Object.keys(sourceCounts).length, excluded_data_by_design: excluded, ledger_versions: ledger.length };
  if (dump.status !== 0) { report.reasons.push(`DUMP_FAILED:${dump.sqlstates.join(',') || dump.status}`); return finish(); }

  // 2. Restore into the disposable database (Supabase roles/extensions stubbed).
  const prep = [
    ...['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'dashboard_user', 'pgbouncer', 'supabase_read_only_user']
      .map(r => `do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$`),
    'create schema if not exists extensions',
    ...['pgcrypto', 'uuid-ossp', 'pg_trgm', 'citext', 'pg_cron'].map(e => `create extension if not exists "${e}" with schema ${e === 'pg_cron' ? 'pg_catalog' : 'extensions'}`),
  ].join(';\n');
  const tgtPrep = session(target, {}, { stopOnError: false });
  for (const st of prep.split(';\n')) await tgtPrep.ask(st);
  tgtPrep.end();
  const restore = docker('exec pg_restore -d "$DB_URL" --no-owner --no-privileges /drill/prod.dump', { DB_URL: target });
  const restoreErrors = classifyRestoreErrors(restore.stderr, excluded);
  report.restore = { exit: restore.status, expected_errors: restoreErrors.expected, unexpected_errors: restoreErrors.unexpected };
  if (restoreErrors.unexpected) report.reasons.push('RESTORE_ERRORS');

  // 3. Completeness: every table present, exact row counts (excluded-by-design data skipped).
  const tgt = session(target, {});
  const targetCounts = parseCounts(await tgt.ask(COUNTS_SQL));
  report.completeness = compareCounts(sourceCounts, targetCounts, excluded);
  if (report.completeness.missing.length) report.reasons.push('TABLES_MISSING');
  if (report.completeness.mismatched.length) report.reasons.push('ROW_COUNTS_DIFFER');

  // 4. Pending repository migrations must apply on top of the restored production copy.
  const dir = process.env.MIGRATIONS_DIR ?? 'supabase/migrations';
  const pending = pendingMigrations(readdirSync(dir), ledger);
  report.migrations = { pending: pending.length, results: [] };
  for (const f of pending) {
    const r = spawnSync('docker', dockerPg('exec psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -1 -d "$DB_URL"', { DB_URL: 1 }),
      { env: { ...process.env, DB_URL: target }, input: readFileSync(join(dir, f), 'utf8'), encoding: 'utf8' });
    const state = (r.stderr.match(/ERROR:\s+([0-9A-Z]{5})/) ?? [])[1] ?? null;
    report.migrations.results.push({ file: f, ok: r.status === 0, sqlstate: r.status === 0 ? null : state });
    if (r.status !== 0) { report.reasons.push(`MIGRATION_DOES_NOT_APPLY:${f}`); break; }
  }
  tgt.end();
  report.status = report.reasons.length ? 'FAIL' : 'PASS';
  return finish();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch(e => { console.log(`::error::DRILL_CRASHED:${String(e.message).slice(0, 80)}`); process.exit(1); });
}
