import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { communicationHarness } from './helpers/candidate-communication-fixture.mjs';

// R0 SC-010 part A (issue #612) on the full current migration chain.
// Fictitious candidates only. No message is sent: the contact layer only prepares
// unsent drafts, and nothing in this file calls a provider or network.
const code = (...codes) => error => codes.includes(error.code);
const SCHEMAS = ['public', 'private', 'report_audit'];

// Production access rule 6 (AGENTS.md): an agent-run query never reads a secret column. The scan
// therefore never runs to_jsonb(t) over a whole row. It reads information_schema.columns first and
// projects only columns that cannot hold a key, secret, token or password; tables that are settings
// or key stores are skipped entirely. The erasure proof is unaffected: candidate data lives in
// ordinary tables (candidates, applications, documents, contact_audit, ...), not in those.
const SECRET_COLUMN = /secret|token|key|passw|credential|salt|hmac|signature|bearer|auth/i;
const SECRET_TABLE = /settings|pseudonym_key|secret|credential|api_key/i;
const isSecretColumn = name => SECRET_COLUMN.test(name);
const isSecretTable = name => SECRET_TABLE.test(name);

// Every non-secret column of the schemas that can hold candidate data, as JSON text.
async function scan(db, h, needles) {
  await h.asAdmin();
  const tables = (await db.query(
    `select schemaname, tablename from pg_tables where schemaname = any($1) order by 1, 2`, [SCHEMAS])).rows;
  const hits = {};
  for (const { schemaname, tablename } of tables) {
    if (isSecretTable(tablename)) continue;
    const cols = (await db.query(
      `select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`,
      [schemaname, tablename])).rows.map(r => r.column_name).filter(c => !isSecretColumn(c));
    if (!cols.length) continue;
    const projection = cols.map(c => `'${c.replaceAll("'", "''")}', t."${c.replaceAll('"', '""')}"`).join(', ');
    const rows = (await db.query(
      `select coalesce(jsonb_agg(jsonb_build_object(${projection})),'[]')::text v from "${schemaname}"."${tablename}" t`)).rows[0].v;
    for (const needle of needles) if (rows.includes(needle)) (hits[`${schemaname}.${tablename}`] ??= []).push(needle);
  }
  return hits;
}

test('SC-010 A: the scan helper never projects secret columns', () => {
  for (const c of ['request_secret', 'request_secret_current', 'request_secret_previous', 'worker_secret', 'secret', 'api_token', 'password_hash'])
    assert.ok(isSecretColumn(c), c);
  for (const tb of ['sales_lead_settings', 'sales_mail_settings', 'cv_bulk_settings', 'sc19_trial_auto_settings', 'pseudonym_key'])
    assert.ok(isSecretTable(tb), tb);
  for (const c of ['id', 'candidate_id', 'application_id']) assert.ok(!isSecretColumn(c), c);
});

test('SC-010 A: consents (channels, hours, history) are stored and respected', async t => {
  const { db, h, seed } = await activeBoot(t, { fullChain: true });
  const c = communicationHarness(h);
  const f = await seed();
  const other = await seed({ owner: users.otherOwner });
  const audit = async () => { await h.asAdmin(); return (await db.query(
    'select action, revision from private.contact_audit where candidate_id=$1 order by created_at, id', [f.candidate.id])).rows; };

  await t.test('hours and blocked channels are stored; invalid hours are refused', async () => {
    await h.asUser(f.owner);
    await c.preferences(f, 0, undefined, ['sms']);
    await h.asAdmin();
    const pref = (await db.query('select timezone, weekday_windows, blocked_channels, revision from public.candidate_contact_preferences where candidate_id=$1', [f.candidate.id])).rows[0];
    assert.equal(pref.timezone, 'Europe/Warsaw');
    assert.deepEqual(pref.weekday_windows, [{ weekday: 1, start_minute: 540, end_minute: 1020 }]);
    assert.deepEqual(pref.blocked_channels, ['sms']);
    assert.equal(Number(pref.revision), 1);
    await h.asUser(f.owner);
    for (const bad of [[{ weekday: 8, start_minute: 0, end_minute: 60 }], [{ weekday: 1, start_minute: 600, end_minute: 600 }], [{ weekday: 1, start_minute: 0, end_minute: 1441 }]])
      await assert.rejects(c.preferences(f, 1, undefined, [], 'Europe/Warsaw', bad), code('PT422'));
    await assert.rejects(c.preferences(f, 0, undefined, []), code('PT409'), 'stale revision');
  });

  await t.test('a channel the candidate blocked is not prepared; an allowed channel is, as an unsent draft', async () => {
    await h.asUser(f.owner);
    await assert.rejects(c.prepare(f, undefined, 'sms'), code('PT409'));
    const id = await c.prepare(f, undefined, 'email');
    await h.asAdmin();
    const row = (await db.query('select state, channel from public.candidate_communications where id=$1', [id])).rows[0];
    assert.deepEqual(row, { state: 'draft', channel: 'email' });
    assert.equal((await db.query("select count(*)::int n from public.candidate_communications where state not in ('draft','cancelled')")).rows[0].n, 0, 'nothing is ever sent');
  });

  await t.test('revocation is recorded in history, cancels drafts, and cannot be undone by a claim', async () => {
    await h.asUser(f.owner);
    await c.permission(f, 'unverified', 0);
    await c.permission(f, 'revoked', 1);
    assert.deepEqual((await audit()).map(r => r.action), ['preferences_changed', 'unverified', 'revoked']);
    await h.asAdmin();
    const comm = (await db.query("select id, state from public.candidate_communications where candidate_id=$1 and channel='email'", [f.candidate.id])).rows[0];
    assert.equal(comm.state, 'cancelled');
    const events = (await db.query('select event_type from public.candidate_communication_events where communication_id=$1 order by created_at, id', [comm.id])).rows.map(r => r.event_type);
    assert.deepEqual(events, ['draft_created', 'permission_denied']);
    await h.asUser(f.owner);
    await assert.rejects(c.prepare(f, undefined, 'email'), code('PT409'));
    await assert.rejects(c.permission(f, 'unverified', 2), code('PT409'), 'a claim cannot clear a deny');
    await assert.rejects(c.permission(f, 'revoked', 1), code('PT409'), 'stale revision');
  });

  await t.test('history is immutable and other tenants cannot read or change consents', async () => {
    await h.asAdmin();
    await assert.rejects(db.query("update private.contact_audit set action='unverified' where candidate_id=$1", [f.candidate.id]));
    await assert.rejects(db.query('delete from private.contact_audit where candidate_id=$1', [f.candidate.id]));
    await h.asUser(users.otherOwner);
    await assert.rejects(c.permission(f, 'revoked', 2), code('PT404'));
    await assert.rejects(c.preferences(f, 1), code('PT404'));
    await assert.rejects(db.query('select * from private.contact_audit'));
    assert.equal((await db.query('select count(*)::int n from public.candidate_contact_permissions where candidate_id=$1', [f.candidate.id])).rows[0].n, 0);
    assert.ok(other.candidate.id);
  });
});

test('SC-010 A: after an erasure request no candidate data remains in the database, documents, reports and exports', async t => {
  const { db, h, x, seed } = await activeBoot(t, { fullChain: true });
  const c = communicationHarness(h);
  await x.configure();
  // The full chain meters CV analyses: give each fictitious company a synthetic paid package.
  const bystander = await seed({ owner: users.otherOwner }); // also installs the synthetic policy once
  await h.asAdmin();
  const seedCompany = h.seed;
  h.seed = async (...args) => {
    const company = await seedCompany(...args);
    await h.asAdmin();
    await db.query('select private.sc19_grant_paid($1,$2)', [company.companyId, `synthetic-sc010a-${randomUUID()}`]);
    await h.asUser(company.owner);
    return company;
  };
  const f = await x.ready({ rich: true });
  await h.asUser(f.owner);
  // Extra consent history and a report export entry for the erased candidate.
  await c.permission(f, 'revoked', 0, undefined, f.recruitment.id, 'sms');
  const exported = (await db.query("select public.record_candidate_report_export($1,$2,$3,'candidate_report_csv',1) id",
    [f.companyId, f.recruitment.id, f.application.id])).rows[0].id;
  // A second candidate of the same company and recruitment, and a candidate of another company,
  // each with their own export log entry: erasure must leave both untouched.
  const neighbour = await h.candidate(f, 'sc010a-neighbour');
  await h.asUser(f.owner);
  const neighbourExport = (await db.query("select public.record_candidate_report_export($1,$2,$3,'candidate_report_csv',null) id",
    [f.companyId, f.recruitment.id, neighbour.application.id])).rows[0].id;
  await h.asUser(bystander.owner);
  const bystanderExport = (await db.query("select public.record_candidate_report_export($1,$2,$3,'candidate_report_csv',null) id",
    [bystander.companyId, bystander.recruitment.id, bystander.application.id])).rows[0].id;
  await h.asAdmin();
  const doc = (await db.query('select id from public.candidate_documents where candidate_id=$1', [f.candidate.id])).rows;
  const ids = [f.candidate.id, f.application.id, ...doc.map(d => d.id), f.communicationId, f.receiptId, exported];
  const markers = ['PRIVATE behavioral evidence', 'PRIVATE assessment note', 'PRIVATE work sample', 'PRIVATE shortlist note', 'PRIVATE correction'];

  const before = await scan(db, h, ids);
  for (const table of ['public.candidates', 'public.applications', 'public.candidate_documents', 'public.candidate_contact_permissions',
    'public.candidate_contact_preferences', 'public.candidate_communications', 'private.contact_audit', 'report_audit.candidate_report_exports'])
    assert.ok(before[table], `${table} must hold the fictitious candidate before erasure`);
  assert.ok(doc.length > 0, 'CV document exists before erasure');

  await h.asUser(f.owner);
  const state = await x.freeze(f);
  await x.transition(state.request_id, 0, 'authorized');
  await x.transition(state.request_id, 1, 'erasing');
  await x.purge(state.request_id, 2);

  const after = await scan(db, h, [...ids, ...markers]);
  // By design: the tombstone keeps only the retired UUID so it can never be re-created (tested in
  // erasure-execution-database.test.mjs). These two tables hold no name, contact or CV text.
  for (const table of ['private.erasure_executions', 'private.retired_candidate_ids']) {
    assert.deepEqual(after[table], [f.candidate.id], `${table} keeps only the retired candidate id`);
    delete after[table];
  }
  // SC-010a-1 (issue #619, migration 20261127130000): the report export log rows of the erased
  // application are deleted in the same purge transaction; nothing of the candidate is left.
  assert.deepEqual(after, {});

  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int n from public.candidate_documents where candidate_id=$1', [f.candidate.id])).rows[0].n, 0, 'CV text is gone');
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1', [bystander.candidate.id])).rows[0].n, 1, 'other tenant untouched');
  assert.equal((await db.query('select count(*)::int n from report_audit.candidate_report_exports where application_id=$1', [f.application.id])).rows[0].n, 0, 'export log rows of the erased application are gone');
  assert.deepEqual((await db.query('select id from report_audit.candidate_report_exports where id = any($1::uuid[]) order by id', [[neighbourExport, bystanderExport]])).rows.map(r => r.id).sort(),
    [neighbourExport, bystanderExport].sort(), 'export log of another candidate of the same company and of another company is untouched');
  assert.equal((await db.query("select current_setting('report_audit.purge_company', true) v")).rows[0].v || '', '', 'the company purge exception is not left open');
  // The AC session export log (SC-AC-EXPORT-AUDIT) has no candidate or application column: an AC
  // session is a group event, so there is no per-candidate row to erase there.
  assert.deepEqual((await db.query("select column_name from information_schema.columns where table_schema='report_audit' and table_name='assessment_center_session_exports' order by ordinal_position")).rows.map(r => r.column_name),
    ['id', 'company_id', 'recruitment_id', 'session_id', 'actor_id', 'actor_role', 'export_kind', 'created_at'], 'AC session export log holds no candidate id');
  // Direct use of the helper is closed to every API and worker role.
  for (const role of ['anon', 'authenticated', 'service_role', 'screening_worker', 'erasure_worker']) {
    if (!(await db.query('select to_regrole($1) is not null v', [role])).rows[0].v) continue;
    assert.equal((await db.query("select has_function_privilege($1,'private.sc010a1_erase_report_exports(uuid,uuid[])','execute') v", [role])).rows[0].v, false, role);
  }
  await h.asUser(f.owner);
  await assert.rejects(db.query("select public.record_candidate_report_export($1,$2,$3,'candidate_report_csv',1)", [f.companyId, f.recruitment.id, f.application.id]), code('42501'), 'no report or export can be produced for an erased application');
});

test('SC-010 A: CV files have no storage object, the only bucket is not candidate data', async () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const buckets = new Set();
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql'))) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    for (const m of sql.matchAll(/insert\s+into\s+storage\.buckets[^;]*?values\s*\(\s*'([^']+)'/gi)) buckets.add(m[1]);
  }
  assert.deepEqual([...buckets], ['brand-assets'], 'a new bucket needs an erasure review: add it to this test');
});
