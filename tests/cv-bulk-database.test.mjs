import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  applyMigration, bootMigrationDatabase, installSource, paymentUsers, seedSyntheticPolicy,
} from './helpers/sc19-migration-fixture.mjs';
import { setupExecutionLedger } from './helpers/erasure-execution-fixture.mjs';
import { retentionHarness } from './helpers/retention-scheduler-fixture.mjs';

// Real checked-in migrations on disposable native PostgreSQL (CI: PG 16/17).
const chain = [
  '20261026220100_sc_step3_evidence_extensions.sql', '20261026220200_sc_step3_evidence_worker.sql',
  '20261028120000_sc_step3_erasure_inventory_r7.sql', '20261029100000_sc019_operator_fulfillment.sql',
  '20261030120000_sc_step3_matrix_change_invalidates_approval.sql', '20261030160000_sc_step4_interview_decision.sql',
  '20261030160100_sc_step4_erasure_inventory_r8.sql',
];
const bulk = '20261101130000_cv_bulk_intake.sql';
const r9 = '20261101130100_cv_bulk_erasure_inventory_r9.sql';
const fixes = '20261101130200_cv_bulk_review_fixes.sql';
const r10 = '20261101130300_cv_bulk_erasure_inventory_r10.sql';
const bulkTables = ['private.application_preselection_group_events', 'private.application_preselection_groups',
  'private.cv_bulk_batches', 'private.cv_bulk_items', 'private.cv_bulk_settings'];
const contract = { payload_schema_version: 1, result_schema_version: 1, prompt_version: 'screening-v1', provider: 'openai', model: 'ranking-test-model', model_revision: 'test-rev' };
const pricing = { input_per_mtok: '0.75', cached_input_per_mtok: '0.075', output_per_mtok: '4.5', currency: 'USD', version: 'test-pricing' };
const migration = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const rollback = name => readFile(new URL(`../supabase/rollbacks/${name}`, import.meta.url), 'utf8');
const code = c => error => error.code === c;
async function run(db, sql) {
  try { await db.query(sql); } catch (error) { await db.query('rollback'); throw error; }
}

async function install(t, variant = 'legacy', { withBulk = true, withR9 = true } = {}) {
  const env = await installSource(await bootMigrationDatabase(t), `r4_${variant}`);
  await applyMigration(env.db);
  for (const name of chain) await run(env.db, await migration(name));
  if (withBulk) await run(env.db, await migration(bulk));
  if (withBulk && withR9) for (const name of [r9, fixes, r10]) await run(env.db, await migration(name));
  await seedSyntheticPolicy(env.db);
  return env;
}

function bulkHarness(env) {
  const { db, h } = env;
  const balance = async company => { await h.asAdmin(); return (await db.query('select available from private.sc19_balances where company_id=$1', [company])).rows[0]?.available ?? 0; };
  const setBalance = async (company, n) => {
    await h.asAdmin();
    await db.query('select private.sc19_grant_paid($1,$2)', [company, `synthetic-bulk-${company}`]);
    await db.query('update private.sc19_balances set available=$2 where company_id=$1', [company, n]);
  };
  const tenant = async (owner = paymentUsers.owner, credits = 10) => {
    const f = await h.seed(owner);
    await setBalance(f.companyId, credits);
    await h.asUser(f.owner);
    return f;
  };
  const files = (n, prefix = 'cv') => Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${i + 1}.pdf`, kind: 'pdf', size: 1000 + i }));
  const create = async (f, n, key = randomUUID(), user = f.owner) => {
    await h.asUser(user);
    return (await db.query('select public.cv_bulk_create_batch($1,$2,$3::jsonb) r', [f.recruitment.id, key, JSON.stringify(files(n))])).rows[0].r;
  };
  const items = async batchId => { await h.asAdmin(); return (await db.query('select * from private.cv_bulk_items where batch_id=$1 order by position', [batchId])).rows; };
  const extraction = (overrides = {}) => ({ first_name: 'Anna', last_name: `Nowak${randomUUID().slice(0, 6)}`, email: null, phone: null,
    source_text: 'SQL reports, Anna Nowak', redacted_text: 'SQL reports, [DANE OSOBOWE]', name_detected: true, ocr_used: false, ...overrides });
  const register = async (f, itemId, extracted = extraction()) => {
    await h.asUser(f.owner);
    return (await db.query('select public.cv_bulk_register_item($1,$2::jsonb) r', [itemId, JSON.stringify(extracted)])).rows[0].r;
  };
  const pump = async (f, batchId, withContract = true) => {
    await h.asUser(f.owner);
    return (await db.query('select public.cv_bulk_pump($1,$2::jsonb,$3::jsonb) r', [batchId, withContract ? JSON.stringify(contract) : null, JSON.stringify(pricing)])).rows[0].r;
  };
  const finishAnalysis = async (attemptId, ratings) => {
    await h.asWorker();
    const claimed = (await db.query('select * from public.claim_screening_attempt($1)', [attemptId])).rows[0];
    assert.ok(claimed, 'worker claims dispatched attempt');
    const findings = claimed.criteria_snapshot.map((c, i) => ({ criterion_id: c.id, rating: ratings[i] ?? 'meets',
      evidence: (ratings[i] ?? 'meets') === 'insufficient_data' ? [] : [{ start: 0, end: 3, quote: 'SQL' }], explanation: 'Synthetic.' }));
    await db.query('select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb,null,null,1000,200,100,null,null)',
      [attemptId, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, JSON.stringify(findings)]);
  };
  const failAnalysis = async attemptId => {
    await h.asWorker();
    const claimed = (await db.query('select * from public.claim_screening_attempt($1)', [attemptId])).rows[0];
    await db.query("select public.fail_screening_attempt($1,$2,$3,$4,'provider_error','Synthetic failure')", [attemptId, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash]);
  };
  // Replace the fixture CV so ratings line up with the default 5 criteria.
  return { balance, setBalance, tenant, create, items, extraction, register, pump, finishAnalysis, failAnalysis };
}

test('SC-BULK-001 bulk intake on the full migration chain', async t => {
  const env = await install(t);
  const { db, h } = env;
  const b = bulkHarness(env);

  await t.test('tables are private, RLS-on and unreachable through the Data API', async () => {
    await h.asAdmin();
    for (const table of [...bulkTables, 'private.cv_bulk_worker_nonces']) {
      const row = (await db.query(`select c.relrowsecurity rls, has_table_privilege('authenticated',c.oid,'select') a, has_table_privilege('anon',c.oid,'select') n
        from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname||'.'||c.relname=$1`, [table])).rows[0];
      assert.deepEqual(row, { rls: true, a: false, n: false }, table);
    }
    const fns = (await db.query(`select p.proname, p.prosecdef, has_function_privilege('anon',p.oid,'execute') anon, has_function_privilege('authenticated',p.oid,'execute') auth
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'cv_bulk%' or p.proname like '%preselection_group%' or p.proname='cv_ai_usage_stats')`)).rows;
    for (const fn of fns) {
      assert.equal(fn.prosecdef, true, fn.proname);
      assert.equal(fn.anon, ['cv_bulk_worker_pump', 'cv_bulk_finish_notification'].includes(fn.proname), `${fn.proname} anon`);
      assert.equal(fn.auth, fn.proname !== 'cv_bulk_worker_pump', `${fn.proname} authenticated`);
    }
    const priv = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='private' and p.proname like 'cv_bulk%' and (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute'))`)).rows[0].n;
    assert.equal(priv, 0, 'private helpers (incl. identity switch) are never granted');
  });

  await t.test('reservation caps the batch at the package balance; surplus is not processed; replay is idempotent', async () => {
    const f = await b.tenant(paymentUsers.owner, 3);
    const key = randomUUID();
    const result = await b.create(f, 5, key);
    assert.deepEqual([result.reserved_slots, result.over_limit, result.available_before], [3, 2, 3]);
    assert.equal(await b.balance(f.companyId), 0);
    const again = await b.create(f, 5, key);
    assert.equal(again.batch_id, result.batch_id);
    assert.equal(await b.balance(f.companyId), 0, 'replay reserves nothing more');
    const rows = await b.items(result.batch_id);
    assert.deepEqual(rows.map(r => [r.phase, r.error_reason, r.slot_state]), [
      ['awaiting_upload', null, 'held'], ['awaiting_upload', null, 'held'], ['awaiting_upload', null, 'held'],
      ['error', 'over_limit', 'none'], ['error', 'over_limit', 'none']]);
    await h.asAdmin();
    const journal = (await db.query("select reason, delta from private.sc19_credit_journal where company_id=$1 and reason like 'bulk%'", [f.companyId])).rows;
    assert.deepEqual(journal, [{ reason: 'bulk_reserve', delta: -3 }]);
    // An empty package reserves nothing and every file is surplus.
    const empty = await b.create(f, 2);
    assert.deepEqual([empty.reserved_slots, empty.over_limit], [0, 2]);
    await assert.rejects(b.create(f, 101), code('22023'));
  });

  await t.test('concurrent batches never reserve more than the balance', async () => {
    const f = await b.tenant(paymentUsers.owner, 5);
    await h.asAdmin();
    const pool = env.pool();
    const one = async () => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query("select set_config('request.jwt.claim.sub',$1,true)", [f.owner]);
        const files = JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ name: `c${i}.pdf`, kind: 'pdf', size: 10 })));
        const r = (await c.query('select public.cv_bulk_create_batch($1,$2,$3::jsonb) r', [f.recruitment.id, randomUUID(), files])).rows[0].r;
        await c.query('commit');
        return r.reserved_slots;
      } catch (error) { await c.query('rollback'); throw error; } finally { c.release(); }
    };
    const reserved = await Promise.all(Array.from({ length: 6 }, one));
    assert.equal(reserved.reduce((a, n) => a + n, 0), 5);
    assert.equal(await b.balance(f.companyId), 0);
  });

  await t.test('register creates candidate, reviewed document and application; duplicates and failures return the slot', async () => {
    const f = await b.tenant(paymentUsers.owner, 4);
    const batch = await b.create(f, 4);
    const [i1, i2, i3, i4] = await b.items(batch.batch_id);
    const ok = await b.register(f, i1.id, b.extraction({ first_name: 'Jan', last_name: 'Kowalski', email: 'Jan@Example.com', phone: '+48 601 222 333' }));
    assert.equal(ok.status, 'queued');
    await h.asAdmin();
    const doc = (await db.query('select status, reviewed_by, source_text from public.candidate_documents where candidate_id=$1', [ok.candidate_id])).rows[0];
    assert.equal(doc.status, 'reviewed'); assert.equal(doc.reviewed_by, f.owner);
    const app = (await db.query('select status, recruitment_id from public.applications where id=$1', [ok.application_id])).rows[0];
    assert.deepEqual(app, { status: 'new', recruitment_id: f.recruitment.id });
    const before = await b.balance(f.companyId);
    const dupMail = await b.register(f, i2.id, b.extraction({ email: 'jan@example.com' }));
    assert.deepEqual([dupMail.status, dupMail.error_reason, dupMail.duplicate_of_application], ['error', 'duplicate', ok.application_id]);
    const dupPhone = await b.register(f, i3.id, b.extraction({ phone: '601-222-333' }));
    assert.equal(dupPhone.error_reason, 'duplicate');
    assert.equal(await b.balance(f.companyId), before + 2, 'duplicate slots return to the package');
    await h.asUser(f.owner);
    await assert.rejects(db.query("select public.cv_bulk_fail_item($1,'duplicate')", [i4.id]), code('22023'), 'only extraction reasons');
    assert.equal((await db.query("select public.cv_bulk_fail_item($1,'protected_pdf') r", [i4.id])).rows[0].r, true);
    assert.equal((await db.query("select public.cv_bulk_fail_item($1,'protected_pdf') r", [i4.id])).rows[0].r, false, 'idempotent');
    assert.equal(await b.balance(f.companyId), before + 3);
    // Same name without contact data is a duplicate only when the name was detected.
    const f2 = await b.tenant(paymentUsers.owner, 3);
    const batch2 = await b.create(f2, 3);
    const [a, c, d] = await b.items(batch2.batch_id);
    await b.register(f2, a.id, b.extraction({ first_name: 'Ewa', last_name: 'Lis' }));
    assert.equal((await b.register(f2, c.id, b.extraction({ first_name: 'Ewa', last_name: 'Lis' }))).error_reason, 'duplicate');
    assert.equal((await b.register(f2, d.id, b.extraction({ first_name: 'Ewa', last_name: 'Lis', name_detected: false }))).status, 'queued');
    // A detected name with different contact data is a different person (e.g. a job title read as a name).
    const f4 = await b.tenant(paymentUsers.owner, 2);
    const [m1, m2] = await b.items((await b.create(f4, 2)).batch_id);
    await b.register(f4, m1.id, b.extraction({ first_name: 'Operator', last_name: 'Maszyn', email: 'jeden@example.com' }));
    assert.equal((await b.register(f4, m2.id, b.extraction({ first_name: 'Operator', last_name: 'Maszyn', email: 'dwa@example.com' }))).status, 'queued');
    await h.asAdmin();
    assert.equal((await db.query('select status from private.cv_bulk_batches where id=$1', [batch2.batch_id])).rows[0].status, 'processing');
    // Invalid extraction is refused before anything is written.
    const f3 = await b.tenant(paymentUsers.owner, 1);
    const [x] = await b.items((await b.create(f3, 1)).batch_id);
    await assert.rejects(b.register(f3, x.id, b.extraction({ email: 'not-an-email' })), code('22023'));
  });

  await t.test('pump starts within parallel limits, consumes only completed analyses, retries and groups', async () => {
    await h.asAdmin();
    // Pricing is DB-held (written by the signed worker pump); the user pump's pricing argument is ignored.
    await db.query('update private.cv_bulk_settings set max_parallel_company=2, max_analysis_retries=1, pricing=$1::jsonb', [JSON.stringify(pricing)]);
    const f = await b.tenant(paymentUsers.owner, 4);
    const batch = await b.create(f, 4);
    for (const item of await b.items(batch.batch_id)) await b.register(f, item.id);
    const startBalance = await b.balance(f.companyId);
    assert.equal(startBalance, 0);
    const idle = await b.pump(f, batch.batch_id, false);
    assert.deepEqual(idle.dispatch, [], 'no contract (AI disabled): nothing starts');
    const first = await b.pump(f, batch.batch_id);
    assert.equal(first.dispatch.length, 2, 'company parallel limit');
    assert.equal(await b.balance(f.companyId), 0, 'held slot handed to the SC-019 charge, no double charge');
    await h.asAdmin();
    const journal = (await db.query("select reason, sum(delta)::int s from private.sc19_credit_journal where company_id=$1 group by reason order by reason", [f.companyId])).rows;
    assert.deepEqual(journal.filter(r => r.reason !== 'paid_grant'), [
      { reason: 'analysis_reserve', s: -2 }, { reason: 'bulk_reserve', s: -4 }, { reason: 'bulk_transfer', s: 2 }]);
    // 5 criteria: above, meets, meets, above, insufficient -> 75 / coverage 0.8 -> passed
    await b.finishAnalysis(first.dispatch[0], ['above', 'meets', 'meets', 'above', 'insufficient_data']);
    await b.failAnalysis(first.dispatch[1]);
    const second = await b.pump(f, batch.batch_id);
    assert.equal(second.dispatch.length, 2, 'one retry + one new start');
    let rows = await b.items(batch.batch_id);
    assert.deepEqual(rows.map(r => r.phase), ['done', 'analyzing', 'analyzing', 'queued']);
    assert.equal(rows[0].input_tokens, '1000');
    // (900*0.75 + 100*0.075 + 200*4.5) / 1e6 = 0.0015825 -> numeric half-up
    assert.equal(rows[0].cost_amount, '0.001583');
    await h.asAdmin();
    const group = (await db.query('select group_key, source, raw_score, coverage from private.application_preselection_groups where application_id=$1', [rows[0].application_id])).rows[0];
    assert.deepEqual([group.group_key, group.source, Number(group.raw_score), Number(group.coverage)], ['passed', 'auto', 75, 0.8]);
    // Retry fails again: retries exhausted -> error, credit refunded by SC-019.
    const retryAttempt = second.dispatch.find(id => id !== undefined);
    const retryItem = rows[1];
    await h.asAdmin();
    const retryId = (await db.query("select id from public.screening_analysis_attempts where analysis_id=$1 and status='pending'", [retryItem.analysis_id])).rows[0].id;
    assert.ok(second.dispatch.includes(retryId), retryAttempt);
    await b.failAnalysis(retryId);
    const third = await b.pump(f, batch.batch_id);
    rows = await b.items(batch.batch_id);
    assert.deepEqual([rows[1].phase, rows[1].error_reason], ['error', 'analysis_failed']);
    assert.equal(third.dispatch.length, 1, 'freed parallel slot starts the last queued file');
    // Finish the rest: below everywhere -> rejected proposal.
    for (const id of [...second.dispatch.filter(x => x !== retryId), ...third.dispatch]) await b.finishAnalysis(id, ['below', 'below', 'below', 'below', 'meets']);
    const done = await b.pump(f, batch.batch_id);
    assert.equal(done.notify.files, 4); assert.equal(done.notify.done, 3); assert.equal(done.notify.errors, 1);
    assert.equal(done.notify.passed, 1); assert.equal(done.notify.rejected, 2);
    assert.equal(await b.balance(f.companyId), 1, 'only completed analyses consumed credits');
    await h.asAdmin();
    assert.equal((await db.query("select count(*)::int n from public.applications where id=any($1) and status<>'new'", [rows.map(r => r.application_id)])).rows[0].n, 0, 'groups never change application status');
    assert.equal((await db.query('select count(*)::int n from public.recruitment_shortlist_entries where recruitment_id=$1', [f.recruitment.id])).rows[0].n, 0, 'no automatic shortlist entry');
    // Notification is claimed once; failure re-queues it.
    assert.equal((await b.pump(f, batch.batch_id)).notify, null);
    await h.asUser(f.owner);
    assert.equal((await db.query("select public.cv_bulk_finish_notification($1,'failed') r", [batch.batch_id])).rows[0].r, true);
    assert.ok((await b.pump(f, batch.batch_id)).notify, 'failed notification is retried');
    await h.asUser(f.owner);
    assert.equal((await db.query("select public.cv_bulk_finish_notification($1,'sent') r", [batch.batch_id])).rows[0].r, true);
    await h.asAdmin();
    await db.query('update private.cv_bulk_settings set max_parallel_company=4, max_analysis_retries=2, pricing=null');
  });

  await t.test('manual moves are recorded, never overwritten by automation, and need write access', async () => {
    const f = await b.tenant(paymentUsers.owner, 1);
    const batch = await b.create(f, 1);
    const [item] = await b.items(batch.batch_id);
    await b.register(f, item.id);
    const started = await b.pump(f, batch.batch_id);
    await b.finishAnalysis(started.dispatch[0], ['below', 'below', 'below', 'below', 'below']);
    await b.pump(f, batch.batch_id);
    await h.asUser(f.owner);
    const groups = (await db.query('select public.get_preselection_groups($1) r', [f.recruitment.id])).rows[0].r;
    assert.equal(groups.length, 1);
    assert.deepEqual([groups[0].group_key, groups[0].has_phone], ['rejected', false]);
    await assert.rejects(db.query("select public.move_preselection_group($1,'passed',$2,null)", [groups[0].application_id, '2000-01-01T00:00:00Z']), code('PT409'));
    const stamp = (await db.query("select public.move_preselection_group($1,'passed',$2,'Doświadczenie z innej branży') r", [groups[0].application_id, groups[0].updated_at])).rows[0].r;
    assert.ok(stamp);
    const history = (await db.query('select public.get_preselection_group_history($1) r', [groups[0].application_id])).rows[0].r;
    assert.deepEqual(history.map(e => [e.from_group, e.to_group, e.source]), [[null, 'rejected', 'auto'], ['rejected', 'passed', 'manual']]);
    assert.equal(history[1].actor_id, f.owner);
    // Re-grouping after a new analysis keeps the manual placement.
    await h.asAdmin();
    const app = (await db.query('select * from private.application_preselection_groups where application_id=$1', [groups[0].application_id])).rows[0];
    await db.query('select private.cv_bulk_apply_auto_group($1,$2)', [app.application_id, app.analysis_id]);
    assert.equal((await db.query('select group_key from private.application_preselection_groups where application_id=$1', [app.application_id])).rows[0].group_key, 'passed');
    await assert.rejects(db.query('update private.application_preselection_group_events set note=null'), code('42501'));
    // Outsiders and anonymous callers see nothing.
    await h.asUser(paymentUsers.outsider);
    await assert.rejects(db.query('select public.get_preselection_groups($1)', [f.recruitment.id]), code('PT404'));
    await assert.rejects(db.query('select public.cv_bulk_batch_status($1)', [batch.batch_id]), code('PT404'));
    await assert.rejects(db.query("select public.move_preselection_group($1,'review',$2,null)", [groups[0].application_id, stamp]), code('PT404'));
    await h.asUser(null, 'anon');
    await assert.rejects(db.query('select public.cv_bulk_pump($1,null,null)', [batch.batch_id]), code('42501'));
  });

  await t.test('evidence-matrix (v2) results are grouped by verdict, not by the neutral legacy rating', async () => {
    const f = await b.tenant(paymentUsers.owner, 2);
    const batch = await b.create(f, 2);
    for (const item of await b.items(batch.batch_id)) await b.register(f, item.id);
    await h.asUser(f.owner);
    const v2 = { ...contract, result_schema_version: 2, prompt_version: 'screening-evidence-v2' };
    const started = (await db.query('select public.cv_bulk_pump($1,$2::jsonb,null) r', [batch.batch_id, JSON.stringify(v2)])).rows[0].r;
    assert.equal(started.dispatch.length, 2);
    const plans = [['supported', 'supported', 'supported', 'partial', 'missing'], ['missing', 'missing', 'missing', 'partial', 'contradicted']];
    for (const [n, attempt] of started.dispatch.entries()) {
      await h.asWorker();
      const claimed = (await db.query('select * from public.claim_screening_attempt_v2($1)', [attempt])).rows[0];
      const rows = claimed.criteria_snapshot.map((c, i) => {
        const verdict = plans[n][i];
        const cited = verdict === 'supported' || verdict === 'partial' || verdict === 'contradicted';
        return { criterion_id: c.id, verdict, evidence: cited ? [{ start: 0, end: 3, quote: 'SQL', document_id: claimed.candidate_document_id }] : [],
          missing_info: cited ? '' : 'Brak informacji', suggested_question: '', explanation: 'Synthetic.' };
      });
      await db.query('select public.complete_screening_evidence($1,$2,$3,$4,$5::jsonb)', [attempt, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, JSON.stringify(rows)]);
    }
    await h.asUser(f.owner);
    await db.query('select public.cv_bulk_pump($1,$2::jsonb,null) r', [batch.batch_id, JSON.stringify(v2)]);
    const status = (await db.query('select public.cv_bulk_batch_status($1) r', [batch.batch_id])).rows[0].r;
    // (100*3+50+0)/5 = 70 -> passed; (0+0+0+50+0)/5 = 10 -> rejected
    assert.deepEqual(status.items.map(i => [i.phase, i.group_key, Number(i.raw_score), Number(i.coverage)]), [['done', 'passed', 70, 1], ['done', 'rejected', 10, 1]]);
  });

  await t.test('closing the upload releases unsent slots; status read hides nothing it should show', async () => {
    const f = await b.tenant(paymentUsers.owner, 3);
    const batch = await b.create(f, 3);
    const [first] = await b.items(batch.batch_id);
    await b.register(f, first.id, b.extraction({ phone: '+48 700 100 200' }));
    await h.asUser(f.owner);
    assert.equal((await db.query('select public.cv_bulk_close_upload($1) n', [batch.batch_id])).rows[0].n, 2);
    assert.equal(await b.balance(f.companyId), 2);
    await h.asUser(f.owner);
    const status = (await db.query('select public.cv_bulk_batch_status($1) r', [batch.batch_id])).rows[0].r;
    assert.deepEqual(status.items.map(i => [i.phase, i.error_reason, i.has_phone]), [['queued', null, true], ['error', 'not_uploaded', null], ['error', 'not_uploaded', null]]);
    assert.equal(status.batch.status, 'processing');
    const list = (await db.query('select public.cv_bulk_recruitment_batches($1) r', [f.recruitment.id])).rows[0].r;
    assert.ok(list.some(x => x.id === batch.batch_id));
  });

  await t.test('signed background pump acts for the batch operator; unsigned or replayed calls are refused', async () => {
    const secret = 'w'.repeat(40);
    await h.asAdmin();
    await db.query('update private.cv_bulk_settings set worker_secret=$1', [secret]);
    const f = await b.tenant(paymentUsers.owner, 1);
    const batch = await b.create(f, 1);
    const [item] = await b.items(batch.batch_id);
    await b.register(f, item.id);
    const sign = (op, id, stamp, target, extra) => createHmac('sha256', secret).update(['cv-bulk-v1', op, id, String(stamp), target ?? '-', extra ?? '-'].join('\n')).digest('hex');
    const md5 = (await db.query("select md5($1::jsonb::text || '|' || $2::jsonb::text) m", [JSON.stringify(contract), JSON.stringify(pricing)])).rows[0].m;
    await h.asUser(null, 'anon');
    const id = randomUUID(), stamp = Date.now();
    await assert.rejects(db.query('select public.cv_bulk_worker_pump($1,$2,$3,$4::jsonb,$5::jsonb)', [id, stamp, 'bad', JSON.stringify(contract), JSON.stringify(pricing)]), code('42501'));
    await assert.rejects(db.query('select public.cv_bulk_worker_pump($1,$2,$3,$4::jsonb,$5::jsonb)', [id, stamp - 120000, sign('pump', id, stamp - 120000, null, md5), JSON.stringify(contract), JSON.stringify(pricing)]), code('42501'));
    // Signature binds the contract: a different contract is refused.
    await assert.rejects(db.query('select public.cv_bulk_worker_pump($1,$2,$3,$4::jsonb,$5::jsonb)', [id, stamp, sign('pump', id, stamp, null, md5), JSON.stringify({ ...contract, model: 'other' }), JSON.stringify(pricing)]), code('42501'));
    const result = (await db.query('select public.cv_bulk_worker_pump($1,$2,$3,$4::jsonb,$5::jsonb) r', [id, stamp, sign('pump', id, stamp, null, md5), JSON.stringify(contract), JSON.stringify(pricing)])).rows[0].r;
    const mine = result.find(r => r.batch_id === batch.batch_id);
    assert.equal(mine.dispatch.length, 1);
    await h.asAdmin();
    const analysis = (await db.query('select a.* from public.screening_analysis_versions a join private.cv_bulk_items i on i.analysis_id=a.id where i.id=$1', [item.id])).rows[0];
    assert.ok(analysis, 'started on behalf of the operator');
    // Signed pricing becomes the DB-held pricing every pump uses.
    assert.deepEqual((await db.query('select pricing from private.cv_bulk_settings')).rows[0].pricing, pricing);
    // Replay of the same signed request (same request_id) is refused within the time window.
    await h.asUser(null, 'anon');
    await assert.rejects(db.query('select public.cv_bulk_worker_pump($1,$2,$3,$4::jsonb,$5::jsonb)', [id, stamp, sign('pump', id, stamp, null, md5), JSON.stringify(contract), JSON.stringify(pricing)]), code('42501'));
    // sha256 digest of the bound contract/pricing is accepted (md5 above stays accepted until the app switches).
    const bad = { ...pricing, input_per_mtok: 'NaN' };
    await h.asAdmin();
    const sha = (await db.query("select encode(extensions.digest($1::jsonb::text || '|' || $2::jsonb::text, 'sha256'), 'hex') d", [JSON.stringify(contract), JSON.stringify(bad)])).rows[0].d;
    const id2 = randomUUID(), stamp2 = Date.now();
    await h.asUser(null, 'anon');
    await db.query('select public.cv_bulk_worker_pump($1,$2,$3,$4::jsonb,$5::jsonb)', [id2, stamp2, sign('pump', id2, stamp2, null, sha), JSON.stringify(contract), JSON.stringify(bad)]);
    await h.asAdmin();
    assert.equal((await db.query('select pricing from private.cv_bulk_settings')).rows[0].pricing, null, 'invalid signed pricing is stored as unknown');
    assert.equal((await db.query('select count(*)::int n from private.cv_bulk_worker_nonces where request_id = any($1::uuid[])', [[id, id2]])).rows[0].n, 2);
    // Signed notification outcomes are single-use too.
    await db.query("update private.cv_bulk_batches set status='completed', completed_at=now(), notify_state='sending', notify_attempts=1, notify_lease_until=now()+interval '1 minute' where id=$1", [batch.batch_id]);
    await h.asUser(null, 'anon');
    const nid = randomUUID(), nstamp = Date.now(), nsig = sign('notify', nid, nstamp, batch.batch_id, 'sent');
    assert.equal((await db.query('select public.cv_bulk_finish_notification($1,$2,$3,$4,$5) r', [batch.batch_id, 'sent', nid, nstamp, nsig])).rows[0].r, true);
    await assert.rejects(db.query('select public.cv_bulk_finish_notification($1,$2,$3,$4,$5) r', [batch.batch_id, 'sent', nid, nstamp, nsig]), code('42501'));
    await h.asAdmin();
    await db.query('update private.cv_bulk_settings set worker_secret=null, pricing=null');
  });

  await t.test('signed pump isolates batches: a failing batch rolls back alone, a busy company is skipped', async () => {
    const secret = 'w'.repeat(40);
    await h.asAdmin();
    await db.query('update private.cv_bulk_settings set worker_secret=$1', [secret]);
    const tenants = [await b.tenant(paymentUsers.owner, 1), await b.tenant(paymentUsers.owner, 1), await b.tenant(paymentUsers.owner, 1)];
    const batches = [];
    for (const f of tenants) {
      const batch = await b.create(f, 1);
      const [item] = await b.items(batch.batch_id);
      await h.asUser(f.owner);
      await db.query("select public.cv_bulk_fail_item($1,'bad_format')", [item.id]);
      batches.push(batch.batch_id);
    }
    const [badBatch, busyBatch, goodBatch] = batches;
    await h.asAdmin();
    await db.query("update private.cv_bulk_batches set updated_at='2000-01-01' where id=any($1::uuid[])", [batches]);
    await db.query(`alter table private.cv_bulk_batches add constraint synthetic_refuse_completion check (id <> '${badBatch}' or status <> 'completed')`);
    const other = await env.pool().connect();
    try {
      await other.query('begin');
      await other.query('select 1 from public.companies where id=$1 for update', [tenants[1].companyId]);
      const sign = (op, id, stamp, extra) => createHmac('sha256', secret).update(['cv-bulk-v1', op, id, String(stamp), '-', extra].join('\n')).digest('hex');
      const id = randomUUID(), stamp = Date.now(), extra = createHash('sha256').update('|').digest('hex');
      await h.asUser(null, 'anon');
      const result = (await db.query('select public.cv_bulk_worker_pump($1,$2,$3,null,null) r', [id, stamp, sign('pump', id, stamp, extra)])).rows[0].r;
      assert.equal(result.find(r => r.batch_id === badBatch)?.error, '23514', 'failing batch reported, not raised');
      assert.equal(result.find(r => r.batch_id === busyBatch), undefined, 'locked company skipped without waiting');
      assert.equal(result.find(r => r.batch_id === goodBatch)?.notify?.batch_id, goodBatch);
      await h.asAdmin();
      const status = Object.fromEntries((await db.query('select id, status from private.cv_bulk_batches where id=any($1::uuid[])', [batches])).rows.map(r => [r.id, r.status]));
      assert.deepEqual([status[badBatch], status[busyBatch], status[goodBatch]], ['processing', 'processing', 'completed']);
    } finally {
      await other.query('rollback'); other.release();
      await h.asAdmin();
      await db.query('alter table private.cv_bulk_batches drop constraint synthetic_refuse_completion');
      await db.query('update private.cv_bulk_settings set worker_secret=null');
    }
  });

  await t.test('stuck analyses are re-dispatched a bounded number of times, then cancelled and refunded', async () => {
    await h.asAdmin();
    await db.query('update private.cv_bulk_settings set max_redispatches=2');
    const f = await b.tenant(paymentUsers.owner, 2);
    const batch = await b.create(f, 2);
    for (const item of await b.items(batch.batch_id)) await b.register(f, item.id);
    const started = await b.pump(f, batch.batch_id);
    assert.equal(started.dispatch.length, 2);
    assert.equal(await b.balance(f.companyId), 0);
    // First attempt: the worker claims it and dies. Second: the dispatch is lost (never claimed).
    await h.asWorker();
    await db.query('select * from public.claim_screening_attempt($1)', [started.dispatch[0]]);
    const age = async () => {
      await h.asAdmin();
      await db.query("update public.screening_analysis_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1 and status='processing'", [started.dispatch[0]]);
      await db.query("update private.cv_bulk_items set dispatched_at=now()-interval '4 minutes' where batch_id=$1", [batch.batch_id]);
    };
    await age();
    for (const n of [1, 2]) {
      const again = await b.pump(f, batch.batch_id);
      assert.deepEqual([...again.dispatch].sort(), [...started.dispatch].sort(), `re-dispatch ${n}`);
      await age();
    }
    const last = await b.pump(f, batch.batch_id);
    assert.deepEqual(last.dispatch, []);
    const rows = await b.items(batch.batch_id);
    assert.deepEqual(rows.map(r => [r.phase, r.error_reason]), [['error', 'analysis_failed'], ['error', 'analysis_failed']]);
    await h.asAdmin();
    const analyses = (await db.query('select execution_status from public.screening_analysis_versions where id=any($1::uuid[])', [rows.map(r => r.analysis_id)])).rows;
    assert.deepEqual(analyses.map(a => a.execution_status), ['cancelled', 'cancelled']);
    assert.equal(await b.balance(f.companyId), 2, 'SC-019 refunded both credits');
    assert.equal((await db.query('select status from private.cv_bulk_batches where id=$1', [batch.batch_id])).rows[0].status, 'completed');
    assert.equal((await db.query("select count(*)::int n from private.cv_bulk_items where company_id=$1 and phase='analyzing'", [f.companyId])).rows[0].n, 0, 'parallel slots freed');
    await db.query('update private.cv_bulk_settings set max_redispatches=3');
  });

  await t.test('cost data comes only from DB-held, validated pricing', async () => {
    const f = await b.tenant(paymentUsers.owner, 1);
    const batch = await b.create(f, 1);
    const [item] = await b.items(batch.batch_id);
    await b.register(f, item.id);
    await h.asUser(f.owner);
    const poisoned = { input_per_mtok: 'NaN', output_per_mtok: 'NaN', currency: 'XXX', version: 'poison' };
    const started = (await db.query('select public.cv_bulk_pump($1,$2::jsonb,$3::jsonb) r', [batch.batch_id, JSON.stringify(contract), JSON.stringify(poisoned)])).rows[0].r;
    await b.finishAnalysis(started.dispatch[0], Array(5).fill('meets'));
    await h.asUser(f.owner);
    await db.query('select public.cv_bulk_pump($1,$2::jsonb,$3::jsonb) r', [batch.batch_id, JSON.stringify(contract), JSON.stringify({ ...pricing, input_per_mtok: '999' })]);
    const [row] = await b.items(batch.batch_id);
    assert.equal(row.phase, 'done');
    assert.deepEqual([row.cost_amount, row.cost_currency, row.pricing_version], [null, null, null], 'user-supplied pricing is never written');
    await h.asAdmin();
    const valid = async p => (await db.query('select private.cv_bulk_valid_pricing($1::jsonb) v', [p === null ? null : JSON.stringify(p)])).rows[0].v;
    for (const good of [null, pricing, { input_per_mtok: 0.75, output_per_mtok: 4.5 }, { ...pricing, input_per_mtok: '1000' }]) assert.equal(await valid(good), true, JSON.stringify(good));
    for (const bad of [poisoned, { ...pricing, input_per_mtok: 'Infinity' }, { ...pricing, output_per_mtok: '-1' }, { ...pricing, input_per_mtok: '1e3' },
      { ...pricing, input_per_mtok: '1000.5' }, { ...pricing, output_per_mtok: 5000 }, { ...pricing, cached_input_per_mtok: 'NaN' }, { ...pricing, currency: 'usd' },
      { ...pricing, version: '' }, { ...pricing, version: 'x'.repeat(81) }, { output_per_mtok: '1' }, [pricing], 'x']) {
      assert.equal(await valid(bad), false, JSON.stringify(bad));
    }
    await assert.rejects(db.query("update private.cv_bulk_items set cost_amount='NaN' where id=$1", [item.id]), code('23514'));
  });

  await t.test('transient lock errors keep the item (and its slot) for the next pump', async () => {
    const f = await b.tenant(paymentUsers.owner, 1);
    const batch = await b.create(f, 1);
    const [item] = await b.items(batch.batch_id);
    const reg = await b.register(f, item.id);
    const other = await env.pool().connect();
    const lock = async () => { await other.query('begin'); await other.query('select 1 from public.candidates where id=$1 for update', [reg.candidate_id]); };
    try {
      await lock();
      assert.deepEqual((await b.pump(f, batch.batch_id)).dispatch, []);
      let [row] = await b.items(batch.batch_id);
      assert.deepEqual([row.phase, row.error_reason, row.slot_state], ['queued', null, 'held'], 'busy candidate is not marked not_eligible');
      await other.query('rollback');
      const started = await b.pump(f, batch.batch_id);
      assert.equal(started.dispatch.length, 1);
      await b.failAnalysis(started.dispatch[0]);
      await lock();
      assert.deepEqual((await b.pump(f, batch.batch_id)).dispatch, []);
      [row] = await b.items(batch.batch_id);
      assert.deepEqual([row.phase, row.error_reason, row.analysis_retries], ['analyzing', null, 0], 'busy retry is not marked analysis_failed');
      await other.query('rollback');
      assert.equal((await b.pump(f, batch.batch_id)).dispatch.length, 1);
      [row] = await b.items(batch.batch_id);
      assert.deepEqual([row.phase, row.analysis_retries], ['analyzing', 1]);
    } finally { await other.query('rollback').catch(() => {}); other.release(); }
  });

  await t.test('with AI switched off, queued files return their slots after 24 hours', async () => {
    const f = await b.tenant(paymentUsers.owner, 2);
    const batch = await b.create(f, 2);
    for (const item of await b.items(batch.batch_id)) await b.register(f, item.id);
    const before = await b.balance(f.companyId);
    assert.deepEqual((await b.pump(f, batch.batch_id, false)).dispatch, []);
    assert.deepEqual((await b.items(batch.batch_id)).map(r => r.phase), ['queued', 'queued'], 'fresh queue waits for AI');
    await h.asAdmin();
    await db.query("update private.cv_bulk_items set updated_at=now()-interval '25 hours' where batch_id=$1 and position=1", [batch.batch_id]);
    await b.pump(f, batch.batch_id, false);
    const rows = await b.items(batch.batch_id);
    assert.deepEqual(rows.map(r => [r.phase, r.error_reason, r.slot_state]),
      [['error', 'analysis_failed', 'released'], ['queued', null, 'held']]);
    assert.equal(await b.balance(f.companyId), before + 1, 'the slot returned to the package');
  });

  await t.test('a retry that resolves to another analysis moves the item to it', async () => {
    const f = await b.tenant(paymentUsers.owner, 2);
    const batch = await b.create(f, 1);
    const [item] = await b.items(batch.batch_id);
    const reg = await b.register(f, item.id);
    const started = await b.pump(f, batch.batch_id);
    await b.failAnalysis(started.dispatch[0]);
    const [failed] = await b.items(batch.batch_id);
    await h.asAdmin();
    const fp = (await db.query("select private.screening_material($1,false)->>'input_fingerprint' fp", [reg.application_id])).rows[0].fp;
    // The recruiter starts the same CV again from the single-CV screen.
    await h.asUser(f.owner);
    const peer = (await db.query('select * from public.start_screening_analysis($1,$2,1,1,$3,$4,$5,$6,$7)',
      [reg.application_id, fp, contract.prompt_version, contract.provider, contract.model, contract.model_revision, randomUUID()])).rows[0];
    assert.notEqual(peer.analysis_id, failed.analysis_id);
    const resumed = await b.pump(f, batch.batch_id);
    assert.deepEqual(resumed.dispatch, [peer.attempt_id]);
    let [row] = await b.items(batch.batch_id);
    assert.equal(row.analysis_id, peer.analysis_id);
    await b.finishAnalysis(peer.attempt_id, Array(5).fill('meets'));
    await b.pump(f, batch.batch_id);
    [row] = await b.items(batch.batch_id);
    assert.deepEqual([row.phase, row.error_reason], ['done', null]);
  });

  await t.test('any pump clears file names of never-candidate files after 30 days; expired last notification claim fails', async () => {
    const f = await b.tenant(paymentUsers.owner, 1);
    const batch = await b.create(f, 2);
    const [first] = await b.items(batch.batch_id);
    await h.asUser(f.owner);
    await db.query("select public.cv_bulk_fail_item($1,'ocr_timeout')", [first.id]);
    await h.asAdmin();
    assert.equal((await db.query('select error_reason from private.cv_bulk_items where id=$1', [first.id])).rows[0].error_reason, 'ocr_timeout');
    await db.query("update private.cv_bulk_items set created_at=now()-interval '31 days' where batch_id=$1", [batch.batch_id]);
    const claimed = await b.pump(f, batch.batch_id, false);
    assert.deepEqual((await b.items(batch.batch_id)).map(r => r.file_name), [null, null], 'ocr_timeout and over_limit names cleared without a worker');
    assert.equal(claimed.notify.batch_id, batch.batch_id);
    await h.asAdmin();
    await db.query("update private.cv_bulk_batches set notify_attempts=5, notify_lease_until=now()-interval '1 minute' where id=$1", [batch.batch_id]);
    assert.equal((await b.pump(f, batch.batch_id, false)).notify, null);
    await h.asAdmin();
    assert.equal((await db.query('select notify_state from private.cv_bulk_batches where id=$1', [batch.batch_id])).rows[0].notify_state, 'failed');
  });

  await t.test('viewer cannot upload; usage stats are operator-only', async () => {
    const f = await b.tenant(paymentUsers.owner, 2);
    await h.asAdmin();
    const viewer = randomUUID();
    await db.query('insert into auth.users values($1)', [viewer]);
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer')", [f.companyId, viewer]);
    await h.asUser(viewer);
    await assert.rejects(db.query('select public.cv_bulk_create_batch($1,$2,$3::jsonb)', [f.recruitment.id, randomUUID(), JSON.stringify([{ name: 'a.pdf', kind: 'pdf', size: 1 }])]), code('PT404'));
    await assert.rejects(db.query('select public.cv_ai_usage_stats(30)'));
  });
});

test('SC-BULK-001 R9/R10: erasure inventory lists and purges bulk rows', async t => {
  for (const variant of ['legacy', 'voice']) {
    await t.test(variant, async () => {
      const env = await install(t, variant);
      const { db, h } = env;
      await h.asAdmin();
      const row = (await db.query('select schema_signature, known_tables, private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r10')).rows[0];
      assert.equal(row.schema_signature, row.actual);
      for (const table of [...bulkTables, 'private.cv_bulk_worker_nonces']) assert.ok(row.known_tables.includes(table), table);
      const r9Tables = (await db.query('select known_tables from private.erasure_inventory_baseline_r9')).rows[0].known_tables;
      assert.deepEqual([...row.known_tables].sort(), [...r9Tables, 'private.cv_bulk_worker_nonces', 'private.erasure_inventory_baseline_r10'].sort());
      const ledgerDb = await env.connect(await env.createDatabase());
      const originalSeed = h.seed;
      h.seed = async (...args) => {
        if (args[0] === undefined) args[0] = paymentUsers.owner;
        const f = await originalSeed(...args); await h.asAdmin();
        await db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-r9-${f.companyId}`]);
        await h.asUser(f.owner); return f;
      };
      const x = await setupExecutionLedger(retentionHarness(h), ledgerDb); await x.configure();
      const subject = await x.ready({ rich: true });
      // Bulk rows: one file became the subject's duplicate, one group with history.
      const b = bulkHarness(env);
      await h.asUser(subject.owner);
      const batch = (await db.query('select public.cv_bulk_create_batch($1,$2,$3::jsonb) r', [subject.recruitment.id, randomUUID(),
        JSON.stringify([{ name: 'subject-copy.pdf', kind: 'pdf', size: 5 }])])).rows[0].r;
      const [dupItem] = await b.items(batch.batch_id);
      await h.asAdmin();
      const person = (await db.query('select * from public.candidates where id=$1', [subject.candidate.id])).rows[0];
      await b.register(subject, dupItem.id, b.extraction({ first_name: person.first_name, last_name: person.last_name, email: person.email ?? null, name_detected: true }));
      await h.asAdmin();
      await db.query(`insert into private.application_preselection_groups(application_id,company_id,recruitment_id,group_key,source,policy_version)
        values($1,$2,$3,'review','auto','preselection-groups-v1')`, [subject.application.id, subject.companyId, subject.recruitment.id]);
      await db.query(`insert into private.application_preselection_group_events(application_id,company_id,to_group,source) values($1,$2,'review','auto')`, [subject.application.id, subject.companyId]);
      assert.equal((await db.query("select error_reason from private.cv_bulk_items where id=$1", [dupItem.id])).rows[0].error_reason, 'duplicate');
      await assert.rejects(db.query('delete from private.application_preselection_group_events where application_id=$1', [subject.application.id]), code('42501'));
      // Two more bulk candidates erased with the subject: one still queued (slot held, no analysis),
      // one whose analysis completed while the item is still 'analyzing' (no pump since).
      await h.asUser(subject.owner);
      const more = (await db.query('select public.cv_bulk_create_batch($1,$2,$3::jsonb) r', [subject.recruitment.id, randomUUID(),
        JSON.stringify([{ name: 'analyzed.pdf', kind: 'pdf', size: 5 }, { name: 'queued.pdf', kind: 'pdf', size: 5 }])])).rows[0].r;
      const [analyzedItem, queuedItem] = await b.items(more.batch_id);
      const analyzed = await b.register(subject, analyzedItem.id);
      const started = await b.pump(subject, more.batch_id);
      assert.equal(started.dispatch.length, 1);
      await b.finishAnalysis(started.dispatch[0], Array(5).fill('meets'));
      const queued = await b.register(subject, queuedItem.id);
      await h.asAdmin();
      assert.deepEqual((await b.items(more.batch_id)).map(r => [r.phase, r.slot_state]), [['analyzing', 'transferred'], ['queued', 'held']]);
      const resolutionRevision = (await db.query('select max(revision)::int r from private.erasure_subject_resolutions where anchor_candidate_id=$1', [subject.candidate.id])).rows[0].r;
      await h.asUser(subject.owner);
      subject.resolutionId = await x.resolve(subject, [subject.candidate.id, analyzed.candidate_id, queued.candidate_id].sort(), resolutionRevision);
      const balanceBefore = await b.balance(subject.companyId);
      const state = await x.freeze(subject);
      // Duplicate rows pointing to a frozen candidate are hidden like the candidate itself.
      await h.asUser(subject.owner);
      assert.deepEqual((await db.query('select public.cv_bulk_batch_status($1) r', [batch.batch_id])).rows[0].r.items, []);
      await h.asAdmin();
      const manifest = (await db.query("select adapter, count(*)::int n from private.erasure_purge_manifest where request_id=$1 and adapter like 'private.%preselection%' or (request_id=$1 and adapter='private.cv_bulk_items') group by adapter order by adapter", [state.request_id])).rows;
      await x.transition(state.request_id, 0, 'authorized');
      await x.transition(state.request_id, 1, 'erasing');
      await x.purge(state.request_id, 2);
      await x.transition(state.request_id, 2, 'active_data_erased');
      await h.asAdmin();
      assert.equal((await db.query('select count(*)::int n from private.cv_bulk_items where batch_id=$1', [more.batch_id])).rows[0].n, 0);
      assert.equal(await b.balance(subject.companyId), balanceBefore + 1, 'held slot of the erased queued file returned');
      assert.deepEqual((await db.query("select reason, delta from private.sc19_credit_journal where reference=$1", [`cv-bulk-release:${queuedItem.id}`])).rows, [{ reason: 'bulk_release', delta: 1 }]);
      await h.asAdmin();
      for (const [table, where] of [['private.cv_bulk_items', 'id=$1'], ['private.application_preselection_groups', 'application_id=$2'], ['private.application_preselection_group_events', 'application_id=$2']]) {
        assert.equal((await db.query(`select count(*)::int n from ${table} where ${where.includes('$1') ? where : where.replace('$2', '$1')}`, [where.includes('$1') ? dupItem.id : subject.application.id])).rows[0].n, 0, table);
      }
      t.diagnostic(JSON.stringify(manifest));
    });
  }
});

test('SC-BULK-001 rollbacks restore R9, R8 and remove the bulk schema', async t => {
  const env = await install(t);
  const { db } = env;
  await assert.rejects(run(db, await rollback('20261101130100_cv_bulk_erasure_inventory_r9_down.sql')), /sc_r9_down_requires_r10_and_fixes_rollback/);
  await assert.rejects(run(db, await rollback('20261101130200_cv_bulk_review_fixes_down.sql')), /cv_bulk_fixes_down_requires_r10_rollback/);
  await run(db, await rollback('20261101130300_cv_bulk_erasure_inventory_r10_down.sql'));
  await run(db, await rollback('20261101130200_cv_bulk_review_fixes_down.sql'));
  const r9row = (await db.query('select schema_signature, private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r9')).rows[0];
  assert.equal(r9row.actual, r9row.schema_signature, 'schema is the reviewed R9 state again');
  assert.equal((await db.query("select count(*)::int n from pg_proc where prosrc like '%erasure_inventory_baseline_r9%'")).rows[0].n, 4);
  // Forward again under a Supabase-like default ACL: service_role must not keep EXECUTE on the bulk RPCs.
  assert.equal((await db.query("select to_regrole('service_role') v")).rows[0].v, null, 'clean cluster: no pre-existing service_role');
  await db.query('create role service_role nologin');
  try {
    await db.query(`grant execute on all functions in schema public to service_role`);
    await run(db, await migration(fixes));
    // Dropped columns keep their attribute numbers: R10 refuses the re-applied (unreviewed) schema.
    await assert.rejects(run(db, await migration(r10)), /sc_r10_source_schema_unreviewed/);
    const granted = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and (p.proname like 'cv\\_bulk%' or p.proname like '%preselection_group%' or p.proname='cv_ai_usage_stats') and has_function_privilege('service_role',p.oid,'execute')`)).rows;
    assert.deepEqual(granted, []);
  } finally {
    await db.query('reset role; drop owned by service_role; drop role service_role');
  }
  await run(db, await rollback('20261101130200_cv_bulk_review_fixes_down.sql'));
  await run(db, await rollback('20261101130100_cv_bulk_erasure_inventory_r9_down.sql'));
  assert.equal((await db.query("select to_regclass('private.erasure_inventory_baseline_r9') v")).rows[0].v, null);
  await run(db, await rollback('20261101130000_cv_bulk_intake_down.sql'));
  const r8 = (await db.query('select schema_signature, private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r8')).rows[0];
  assert.equal(r8.actual, r8.schema_signature, 'schema is the reviewed R8 state again');
  // And forward again.
  for (const name of [bulk, r9, fixes, r10]) await run(db, await migration(name));
});
