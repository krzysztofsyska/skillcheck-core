import './preview-freeze.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const yml = readFileSync(new URL('../.github/workflows/preview-db-migrate.yml', import.meta.url), 'utf8');
const transport = readFileSync(new URL('../scripts/preview-migration-stream.mjs', import.meta.url), 'utf8');
const list = readFileSync(new URL('../supabase/preview-migrations.txt', import.meta.url), 'utf8');

test('preview migrations run only against skillcheck-preview, never production', () => {
  assert.match(yml, /PREVIEW_REF: orbyscrupgnupifzlqxp/);
  assert.match(yml, /PRODUCTION_REF: wsvjawuikxfzjyivxgsu/);
  assert.match(yml, /\*"\$PRODUCTION_REF"\*\) echo "::error::Refusing/);
  assert.match(yml, /\*"\$PREVIEW_REF"\*\) ;; \*\) echo "::error::Refusing/);
  assert.match(yml, /^\s+environment: preview-db$/m);
  assert.doesNotMatch(yml, /production-approval|db push|supabase link|secrets set/);
  assert.equal(yml.match(/secrets\./g).length, 1);
  assert.doesNotMatch(yml, /echo[^\n]*DATABASE_URL\b(?!:-}|" in| is not set)/);
});

test('large migration regression is required by native PostgreSQL CI', () => {
  const checks = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  assert.match(checks, /run: node --test tests\/preview-db-migrate-workflow\.test\.mjs\n\s+env:\n\s+PREVIEW_MIGRATE_TEST_DATABASE_URL:/);
  const native = readFileSync(new URL('../.github/workflows/sc19-migrations.yml', import.meta.url), 'utf8');
  assert.match(native, /postgres: \['16', '17'\]/);
  assert.match(native, /tests\/preview-db-migrate-workflow\.test\.mjs \\/);
  assert.match(native, /PREVIEW_MIGRATE_TEST_DATABASE_URL: postgres:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres/);
});

test('trigger is limited to integration and preview-db/** pushes with read-only token', () => {
  const triggers = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.match(triggers, /- integration\n\s+- 'preview-db\/\*\*'/);
  assert.doesNotMatch(triggers, /pull_request|schedule|workflow_run|repository_dispatch|main/);
  assert.match(yml, /^permissions: \{\}$/m);
  assert.doesNotMatch(yml, /: write/);
  assert.match(yml, /persist-credentials: false/);
  for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
});

test('every listed migration exists and is a checked-in file name', () => {
  const entries = list.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry, /^[0-9]{14}_[a-z0-9_]+\.sql$/);
    assert.ok(existsSync(new URL(`../supabase/migrations/${entry}`, import.meta.url)), entry);
  }
  assert.deepEqual([...entries].sort(), entries, 'listed in migration order');
});

// The list is an allowlist, so an existing migration that nobody added is simply
// never applied to preview: the objects it creates are missing there and the
// feature fails at runtime with no failing check anywhere. The test above only
// proves that listed entries exist, which cannot catch that.
//
// The set to check is therefore the CHAIN TAIL — every migration ordered after
// M13 — and not migrations matching a name token. A name pattern (/sc019_|sc19_/)
// silently misses the next migration of this very chain if it is named anything
// else: `20261110000000_p24_provider_keys.sql` (the Przelewy24 adapter and its
// keys, the likely next step) matches nothing and would never reach preview with
// every check still green. The tail is derived from the file names, so a new
// migration is in scope the moment it is checked in, whatever it is called.
const previewChainTail = '20261021084732_sc019_credits_payments_inventory.sql';
const previewExempt = new Map([
  // M13 and everything up to it was applied to preview before this list existed;
  // the preview ledger already holds them (checked 2026-11-03 against
  // supabase_migrations.schema_migrations on orbyscrupgnupifzlqxp).
  ['20261026220100_sc_step3_evidence_extensions.sql', 'already in the preview ledger'],
  ['20261026220200_sc_step3_evidence_worker.sql', 'already in the preview ledger'],
  ['20261028120000_sc_step3_erasure_inventory_r7.sql', 'already in the preview ledger'],
  ['20261029100000_sc019_operator_fulfillment.sql', 'already in the preview ledger'],
  ['20261030160000_sc_step4_interview_decision.sql', 'already in the preview ledger (as 20261031111326_sc_step4_interview_decision)'],
  // Not yet applied to preview on purpose:
  ['20261030120000_sc_step3_matrix_change_invalidates_approval.sql',
    'routines only, not needed for the SC-P24 checkout walk; list it with the Step 3 preview work'],
  ['20261102090000_sales_leads_enable.sql',
    'data switch that is deliberately a no-op on preview (no request signing secret there), and the contact form stays off on preview'],
]);
test('every migration after the chain tail reaches preview, or is exempted with a reason', () => {
  const entries = new Set(list.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean));
  const all = readdirSync(new URL('../supabase/migrations/', import.meta.url))
    .filter(name => name.endsWith('.sql')).sort();
  assert.ok(all.includes(previewChainTail), `the chain tail ${previewChainTail} must exist`);
  const tail = all.filter(name => name > previewChainTail);
  assert.ok(tail.length >= 3, 'the chain tail must be discoverable');
  const missing = tail.filter(name => !entries.has(name) && !previewExempt.has(name));
  assert.deepEqual(missing, [],
    `these migrations would never be applied to skillcheck-preview: ${missing.join(', ')}`);
  // The SC-P24 read-only checkout RPC is what the checkout page needs to show an
  // offer at all, so it must reach preview. The commercial seed that fills the
  // offer is NOT a migration (see the preview-seeds test below).
  assert.ok(entries.has('20261103130000_sc019_checkout_offers_read.sql'),
    '20261103130000_sc019_checkout_offers_read.sql must be listed for preview');
  // An exemption may only name a migration that exists and is actually in the
  // tail, so the map cannot rot into a blanket excuse.
  for (const name of previewExempt.keys()) {
    assert.ok(all.includes(name), `stale exemption: ${name}`);
    assert.ok(name > previewChainTail, `exemption outside the chain tail: ${name}`);
  }
  // Every listed entry is itself in the tail or an acknowledged pre-list gap, so
  // the list cannot quietly grow entries the tail check never looks at.
  const preListed = new Set(['20261008155657_sc005_allow_postgres_set_screening_worker.sql',
    '20261008155719_sc005_keep_worker_role_explicit_only.sql']);
  for (const name of entries) {
    assert.ok(name > previewChainTail || preListed.has(name), `listed outside the checked tail: ${name}`);
  }
});

test('a listed migration edited after reaching preview fails unless its resync is acknowledged', () => {
  assert.match(yml, /ledger_sha" = "\$body_sha" \]; then echo "skip/);
  assert.match(yml, /grep -qxF "\$body_sha  \$file  \$ledger_sha" supabase\/preview-resynced\.txt/);
  assert.match(yml, /::error::\$file changed after it was applied to preview/);
  const acks = readFileSync(new URL('../supabase/preview-resynced.txt', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#'));
  for (const line of acks) {
    assert.match(line, /^[0-9a-f]{64} {2}[0-9]{14}_[a-z0-9_]+\.sql {2}[0-9a-f]{64}$/);
    const [sha, file] = line.split('  ');
    // Same text the job hashes: the file without trailing newlines ($(cat file)).
    const text = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').replace(/\n+$/, '');
    assert.equal(createHash('sha256').update(text).digest('hex'), sha, `${file}: acknowledged hash must match the file`);
  }
  assert.match(transport, /where version = \(select max\(version\)/, 'resync rewrites only the newest ledger row');
  assert.match(yml, /preview-migration-stream\.mjs resync \"\$path\" \| psql/);
  assert.doesNotMatch(yml, /-v (?:ledger_)?body=/, 'no migration text in process arguments');
});

test('each migration and its ledger row are applied in one transaction', () => {
  const step = yml.slice(yml.indexOf('echo "apply  $file"'), yml.indexOf('applied=$((applied+1))'));
  assert.match(transport, /insert into supabase_migrations\.schema_migrations/);
  assert.match(step, /preview-migration-stream\.mjs apply \"\$path\" \| psql/);
  assert.equal(step.match(/\| psql /g)?.length, 1, 'migration body and ledger insert go through a single psql call');
  assert.doesNotMatch(step, /psql "\$DATABASE_URL"[^|\n]*-f "\$path"/, 'no separate psql run of the migration file');
  assert.match(step, /must open exactly one top-level begin;/);
  assert.match(step, /must end with its only top-level commit;/);
  // Every preview-listed migration fits the shape the workflow requires.
  for (const entry of list.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)) {
    const lines = readFileSync(new URL(`../supabase/migrations/${entry}`, import.meta.url), 'utf8').split('\n');
    assert.equal(lines.filter(l => /^begin;\s*$/.test(l)).length, 1, entry);
    const commits = lines.flatMap((l, i) => /^commit;\s*$/.test(l) ? [i] : []);
    const last = lines.findLastIndex(l => l.trim() !== '');
    assert.deepEqual(commits, [last], `${entry}: single top-level commit; as the last statement`);
  }
});

// Commercial activation is owner-gated (/operator/billing, CLAUDE.md; "billing
// and charge actions" in AGENTS.md). A migration runs wherever the chain runs,
// production included, so no migration may write package quotas or publish a
// purchasable offer.
//
// WHAT THIS CHECK IS WORTH. It is a BEST-EFFORT LINT over migration text, not a
// proof. It reads SQL with regular expressions, so it cannot decide what a
// migration really does: SQL assembled at runtime from values in another table,
// a write hidden behind a trigger or a view's `instead of` rule, a rename that
// makes a different table the commercial one, or simply a form nobody thought of
// will pass it. Treating a green run here as "no migration can activate
// commerce" is the mistake this paragraph exists to prevent.
//
// THE AUTHORITATIVE GUARD IS tests/sc-019-migrations-production-history.test.mjs.
// That one replays the real chain against a production-shaped database and then
// asserts the FINAL TABLE STATE — no package policy rows, no balances, no
// journal, no grants, no active approved offer — which is the property that
// actually matters and which no amount of SQL phrasing can talk its way around.
// This lint exists only to fail fast and locally, with a readable message, for
// the ordinary shapes a new migration is likely to use. If the two ever
// disagree, the runtime one is right.
test('no migration writes package quotas or publishes a purchasable offer (best-effort lint)', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  // Verb coverage: `insert into`, `copy ... from` and `merge into` all write.
  // The `private.` schema prefix is OPTIONAL because `set local search_path` (or
  // a routine without `set search_path = ''`) makes the bare name resolve to the
  // same table, and each part may be quoted ("private"."sc19_balances").
  const commercialTables = [
    ['sc19_package_policy', 'writes private.sc19_package_policy'],
    ['sc19_payment_offers', 'inserts a private.sc19_payment_offers row'],
    ['sc19_balances', 'writes private.sc19_balances'],
    ['sc19_credit_journal', 'writes private.sc19_credit_journal'],
    ['sc19_payment_grants', 'writes private.sc19_payment_grants'],
  ];
  const commercial = commercialTables.map(([table, what]) => [new RegExp(
    `(?:insert\\s+into|merge\\s+into|copy)\\s+(?:"?private"?\\s*\\.\\s*)?"?${table}"?(?![A-Za-z0-9_])`,
    'i'), what]);

  // `'insert into private.' || 'sc19_balances...'` is one statement written as two
  // literals. Fold adjacent literals back together before matching, so splitting a
  // table name across a `||` buys nothing.
  const joinLiterals = sql => {
    let out = sql, previous;
    do { previous = out; out = out.replace(/'\s*\|\|\s*'/g, ''); } while (out !== previous);
    return out;
  };

  // Splits a migration into the code that runs AT MIGRATION TIME and the routine
  // bodies it installs. A `create function` body runs only when somebody calls
  // it, which is how the operator sets a quota at all
  // (public.sc19_operator_set_package_policy, installed by
  // 20261029100000_sc019_operator_fulfillment.sql), so a body on its own is not
  // activation. A `do` block, a bare statement and a string literal do run now.
  const split = sql => {
    let migrationTime = '', calls = '', index = 0;
    const bodies = [];
    for (const match of sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$/g)) {
      if (match.index < index) continue;
      const close = sql.indexOf(match[0], match.index + match[0].length);
      if (close === -1) break;
      const before = sql.slice(index, match.index);
      const quoted = sql.slice(match.index, close + match[0].length);
      const header = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\b[\s\S]*$/i.exec(before);
      index = close + match[0].length;
      if (!header || /\bdo\s*$/i.test(before)) {
        // A `do` block, or a dollar-quoted string: it runs now.
        migrationTime += before + quoted;
        calls += before + quoted;
        continue;
      }
      // A routine body. Its text does not run now, but remember it and the name
      // it is installed under; the signature itself is not a call, so it is kept
      // out of the text searched for calls.
      migrationTime += before;
      calls += before.slice(0, header.index);
      const named = /(?:function|procedure)\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(header[0]);
      bodies.push({ routine: named?.[1] ?? null, text: quoted });
    }
    return { migrationTime: migrationTime + sql.slice(index), calls: calls + sql.slice(index), bodies };
  };

  // Is `routine` invoked by code that runs at migration time? Only the forms that
  // actually execute something count, so `drop function f(...)`,
  // `grant execute on function f(...)` and the signature itself are not calls.
  // A routine name inside a string literal is usually not a call: M13 lists its
  // own routines as `array['public.sc19_claim_trial(uuid,text)', ...]::regprocedure[]`
  // in a postflight ownership check. A literal handed to `execute` IS run, so that
  // one keeps its content and everything else is blanked.
  const literalsForCalls = sql => sql.replace(/'((?:[^']|'')*)'/g, (whole, inner, at, text) =>
    /\bexecute\s*$/i.test(text.slice(Math.max(0, at - 200), at)) ? ` ${inner} ` : ' ');

  const invokedAtMigrationTime = (calls, routine) => new RegExp(
    `\\b(?:select|perform|call)\\b[^;]{0,600}?(?<![A-Za-z0-9_])(?:"?[A-Za-z_][A-Za-z0-9_]*"?\\s*\\.\\s*)?"?${routine}"?\\s*\\(`,
    'i').test(literalsForCalls(calls));

  const findings = sql => {
    const { migrationTime, calls, bodies } = split(joinLiterals(sql));
    const found = [];
    for (const [pattern, what] of commercial) {
      if (pattern.test(migrationTime)) found.push(what);
      // Defining a routine that writes these tables is fine; defining it AND
      // running it in the same file is activation with extra steps.
      for (const body of bodies) {
        if (!pattern.test(body.text) || !body.routine) continue;
        if (invokedAtMigrationTime(calls, body.routine)) {
          found.push(`${what} through ${body.routine}(), which the same migration calls`);
        }
      }
    }
    return found;
  };
  // Comments carry the reasoning above and name these tables on purpose.
  const strip = text => text.replace(/^\s*--.*$/gm, '');

  let checked = 0;
  for (const name of readdirSync(dir).filter(file => file.endsWith('.sql'))) {
    const found = findings(strip(readFileSync(new URL(name, dir), 'utf8')));
    checked += 1;
    assert.deepEqual(found, [],
      `${name} ${found.join('; ')}: commercial activation is an owner action in /operator/billing, not a migration. Put it in supabase/preview-seeds/ if it is only needed on preview.`);
  }
  assert.ok(checked > 25, 'the whole migration directory must be scanned');

  // Self-checks. These prove the lint still sees the two shapes it was written
  // for; they do NOT prove it sees every shape (see the paragraph above).
  // The preview seed does exactly what this test forbids, inside a `do` block.
  const seedFindings = findings(strip(readFileSync(
    new URL('../supabase/preview-seeds/sc19-preselekcja-offer.sql', import.meta.url), 'utf8')));
  assert.deepEqual(seedFindings.slice(0, 2),
    ['writes private.sc19_package_policy', 'inserts a private.sc19_payment_offers row'],
    'self-check: the preview seed must still be detected');
  // And the legitimate migrations stay clean: the operator RPC only installs a
  // body (nothing calls it here), and M13 backfills private.sc19_payment_requests
  // from orders that already exist, which is not commercial activation.
  for (const name of ['20261029100000_sc019_operator_fulfillment.sql',
    '20261021084732_sc019_credits_payments_inventory.sql']) {
    assert.deepEqual(findings(readFileSync(new URL(name, dir), 'utf8')), [],
      `self-check: ${name} is legitimate and must not be flagged`);
  }
});

test('preview-only seeds live outside the migration chain and are applied to preview only', () => {
  const seedDir = new URL('../supabase/preview-seeds/', import.meta.url);
  const seeds = readdirSync(seedDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(seeds.includes('sc19-preselekcja-offer.sql'),
    'the PRESELEKCJA offer seed must exist, or the Przelewy24 checkout walk has no offer on preview');
  // Nothing in the migration chain, and nothing the production runner reads, may
  // name a seed file: supabase/preview-seeds/** is not a migration directory.
  const migrations = readdirSync(new URL('../supabase/migrations/', import.meta.url));
  for (const seed of seeds) assert.ok(!migrations.includes(seed), `${seed} must not also be a migration`);
  assert.doesNotMatch(readFileSync(new URL('../tools/db-migrate/apply.mjs', import.meta.url), 'utf8'),
    /preview-seeds/, 'the production migration runner must not know about preview seeds');
  assert.doesNotMatch(readFileSync(new URL('../.github/workflows/db-migrate-production.yml', import.meta.url), 'utf8'),
    /preview-seeds/, 'the production workflow must not apply preview seeds');
  // The seed step runs after the refusal checks, inside the one step that holds
  // the secret, and writes no ledger row (a seed is not a migration).
  const seedStep = yml.slice(yml.indexOf('seeded=0'));
  assert.match(seedStep, /supabase\/preview-seeds\/\*\.sql/);
  assert.doesNotMatch(seedStep, /schema_migrations/, 'a seed gets no ledger row');
  assert.ok(yml.indexOf('Refusing: connection string points at production') < yml.indexOf('seeded=0'),
    'the seed loop runs after the production refusal check');
  // Each seed is a single transaction, as the step requires, and says in its own
  // text that it is preview-only.
  for (const seed of seeds) {
    const text = readFileSync(new URL(seed, seedDir), 'utf8');
    const lines = text.split('\n');
    assert.equal(lines.filter(l => /^begin;\s*$/.test(l)).length, 1, seed);
    const commits = lines.flatMap((l, i) => /^commit;\s*$/.test(l) ? [i] : []);
    assert.deepEqual(commits, [lines.findLastIndex(l => l.trim() !== '')],
      `${seed}: single top-level commit; as the last statement`);
    assert.match(text, /PREVIEW-ONLY|preview-only/, `${seed} must state that it is preview-only`);
    // The guard is a declared project identity, not a count of rows: ordinary
    // preview testing leaves balances, journal entries, orders and grants behind,
    // and this file is re-applied on top of them on every run. So a seed takes
    // the target ref from psql and refuses anything but skillcheck-preview, and
    // never refuses because the database has been used.
    assert.match(text, /:'sc19_seed_target_ref'/, `${seed} must take its target project ref from psql`);
    assert.match(text, /sc19_preview_seed_refuses_production_project/, `${seed} must refuse the production project`);
    assert.doesNotMatch(text.replace(/^\s*--.*$/gm, ''),
      /count\(\*\)[^\n]*sc19_(balances|credit_journal|payment_orders|payment_grants)/,
      `${seed} must not refuse a database merely because it carries preview activity`);
  }
  // The job hands each seed the ref it verified against the connection string.
  assert.match(seedStep, /-v sc19_seed_target_ref="\$PREVIEW_REF" -f "\$path"/,
    'the seed step must declare the verified target project');
});

// Runs the unchanged allowlist/hash/acknowledgement loop from the real workflow.
// Only the fixture database is local; no project guard or production target is bypassed.
const pgUrl = process.env.PREVIEW_MIGRATE_TEST_DATABASE_URL;
test('apply step streams >128 KiB atomically, skips identical bodies and resyncs only acknowledged newest rows', { skip: !pgUrl && 'PREVIEW_MIGRATE_TEST_DATABASE_URL not set' }, async t => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const url = new URL(pgUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only disposable loopback databases');
  const command = (target, sql) => execFileSync('psql', [target, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
  const admin = sql => command(pgUrl, sql);
  const database = `preview_migrate_wf_${process.pid}`;
  admin(`create database ${database}`);
  t.after(() => admin(`drop database ${database} with (force)`));
  url.pathname = `/${database}`;
  const dbUrl = url.toString(), psql = sql => command(dbUrl, sql);
  psql(`create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);`);
  const dir = mkdtempSync(join(tmpdir(), 'preview-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('../scripts/preview-migration-stream.mjs', import.meta.url), join(dir, 'scripts/preview-migration-stream.mjs'));
  const canonical = value => Buffer.from(value).subarray(0, Buffer.from(value).length - (value.match(/\n+$/)?.[0].length ?? 0));
  const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
  const goodName = '20990101000000_good.sql', badName = '20990101000100_bad.sql';
  // Quotes, dollar tags, backslashes, psql-looking text and Unicode must remain
  // literal ledger data. Internal CRLF and the final CR are deliberately kept.
  const tricky = String.raw`O'Brien \server\file $$ $ledger_body$ :'ledger_name' \copy Żółć 😀`;
  const padding = '-- ' + 'a'.repeat(180_000) + '\r\n';
  const good = padding + `begin;\r\ncreate schema wf_app;\r\ncreate table wf_app.t(value text);\r\ninsert into wf_app.t values ($payload$${tricky}$payload$);\r\ncommit;\r\n\n\n`;
  const bad = padding + 'begin;\ncreate table wf_app.u(x int);\nselect 1/0;\ncommit;\n';
  const file = (name, value) => writeFileSync(join(dir, 'supabase/migrations', name), value);
  const allow = names => writeFileSync(join(dir, 'supabase/preview-migrations.txt'), names.join('\n') + '\n');
  file(goodName, good); file(badName, bad); allow([goodName, badName]);
  if (process.platform === 'linux') {
    const old = spawnSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'ledger_body=' + canonical(good).toString('utf8')], { encoding: 'utf8' });
    assert.equal(old.error?.code, 'E2BIG', 'old -v body transport fails before psql starts');
  }
  const script = yml.slice(yml.indexOf('applied=0'), yml.indexOf('done < supabase/preview-migrations.txt') + 'done < supabase/preview-migrations.txt'.length)
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const run = () => spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: dir, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 3, first.stderr); // psql ON_ERROR_STOP, not execve exit 126.
  assert.match(first.stderr, /division by zero/);
  assert.equal(psql('select string_agg(name, \',\' order by name) from supabase_migrations.schema_migrations'), 'good');
  assert.equal(psql("select count(*) from pg_tables where schemaname='wf_app'"), '1', 'failed DDL and ledger both rolled back');
  assert.equal(psql('select value from wf_app.t'), tricky);
  const ledger = version => psql(`select encode(convert_to(statements[1],'UTF8'),'hex') from supabase_migrations.schema_migrations where version='${version}'`);
  const shellBody = execFileSync('bash', ['-c', 'printf \"%s\" \"$(cat \"$1\")\"', 'canonical-body', join(dir, 'supabase/migrations', goodName)]);
  assert.equal(ledger('20990101000000'), shellBody.toString('hex'), 'exact old Bash body bytes including CRLF/final CR');
  assert.equal(psql("select encode(sha256(convert_to(statements[1],'UTF8')),'hex') from supabase_migrations.schema_migrations where name='good'"), digest(good));
  const collisionName = '20990101000000_collision.sql';
  file(collisionName, padding + 'begin;\ncreate table wf_app.rollback_on_ledger_failure(x int);\ncommit;\n'); allow([collisionName]);
  const collision = run(); assert.equal(collision.status, 3, collision.stderr);
  assert.match(collision.stderr, /duplicate key/);
  assert.equal(psql("select count(*) from pg_tables where schemaname='wf_app'"), '1', 'ledger insert failure also rolls back migration DDL');
  allow([goodName]);
  const skip = run(); assert.equal(skip.status, 0, skip.stderr); assert.match(skip.stdout, /skip/);
  assert.equal(psql('select count(*) from supabase_migrations.schema_migrations'), '1');
  // Resync is a ledger acknowledgement, never another execution of the body.
  // Retain an older row with the same name to prove only max(version) changes.
  psql("insert into supabase_migrations.schema_migrations values('20980101000000',array['older literal'],'good')");
  const changed = good.replace('a'.repeat(100), 'b'.repeat(100)); file(goodName, changed);
  assert.equal(run().status, 1, 'changed body without acknowledgement is refused');
  assert.equal(ledger('20990101000000'), canonical(good).toString('hex'));
  writeFileSync(join(dir, 'supabase/preview-resynced.txt'), `${digest(changed)}  ${goodName}  ${digest(good)}\n`);
  const resync = run(); assert.equal(resync.status, 0, resync.stderr); assert.match(resync.stdout, /resync/);
  assert.equal(ledger('20990101000000'), canonical(changed).toString('hex'));
  assert.equal(ledger('20980101000000'), Buffer.from('older literal').toString('hex'));
  assert.equal(psql('select count(*) from wf_app.t'), '1', 'resync never reruns DDL/data writes');
  assert.equal(run().status, 0, 'resynced body is idempotently skipped');
  const stale = good.replace('a'.repeat(100), 'c'.repeat(100)); file(goodName, stale);
  writeFileSync(join(dir, 'supabase/preview-resynced.txt'), `${digest(stale)}  ${goodName}  ${digest(good)}\n`);
  assert.equal(run().status, 1, 'acknowledgement of an older ledger hash is refused');
  assert.equal(ledger('20990101000000'), canonical(changed).toString('hex'));
});
