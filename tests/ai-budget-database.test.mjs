// SC-021-C: AI-cost budgets. Native PostgreSQL (CI: PG16), full migration chain, two synthetic companies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { createExerciseBudgetClient } from '../lib/ai-ledger-writer.ts';

const migration = '20261109220000_sc021_ai_budgets.sql';
const r15 = '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44';
const denied = (...codes) => error => codes.includes(error.code);
const MODEL = 'gpt-5.4-mini-2026-03-17';
// Placeholder rates (SC-021-B): 1 micro per input token, 2 per output token.
const SCREENING_ATTEMPT = 120000 + 2 * 4000; // 128 000
const SCREENING_OP = 3 * SCREENING_ATTEMPT; // 384 000
const EXERCISE_OP = 48000 + 2 * 4000; // 56 000
const REASON = 'Synthetic budget for tests';

function attempt(operationId, companyId, overrides = {}) {
  return {
    attempt_id: randomUUID(), operation_id: operationId, company_id: companyId, task: 'cv_screening', attempt: 1,
    provider: 'openai', model: MODEL, model_revision: null, model_key: 'openai-screening',
    policy_version: 'sc021-a2-2026-11-09', outcome: 'completed', billing: 'billed',
    input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, provider_request_id: null, latency_ms: 120,
    ...overrides,
  };
}

async function boot(t) {
  const e = await activeBoot(t, { fullChain: true, throughMigration: migration });
  const { db, h } = e;
  await h.asAdmin();
  assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value, r15, 'SC-010 signature unchanged');
  const operator = randomUUID();
  await db.query('insert into auth.users values($1)', [operator]);
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);
  const asOperator = () => h.asUser(operator);
  const op = async (name, args) => { await asOperator(); return e.callAny(name, args); };
  const callAny = async (name, args = [], client = db) => (await client.query(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as result`, args)).rows[0].result;
  e.callAny = callAny;
  // A screening attempt the worker holds (status 'processing'): a new application, started and claimed.
  const processing = async f => {
    const c = await h.candidate(f);
    const started = await h.start(c);
    await h.claim(started);
    await h.asAdmin();
    return { ...c, started, attemptId: started.attempt_id };
  };
  const reserveScreening = async (opId, client = db) => {
    if (client === db) await h.asWorker();
    return callAny('public.reserve_screening_ai_budget', [opId], client);
  };
  const record = async payload => { await h.asWorker(); return callAny('public.record_screening_ai_attempt', [JSON.stringify(payload)]); };
  const status = async (company, user) => { await h.asUser(user); return callAny('ai_ledger.company_budget_status', [company]); };
  const asWriter = async (fn, client = db) => {
    await client.query('reset role'); await client.query('begin');
    try { await client.query('set local role ai_ledger_writer'); const r = await fn(client); await client.query('commit'); return r; }
    catch (error) { await client.query('rollback'); throw error; }
  };
  const rows = async (table, where = 'true', params = []) => { await h.asAdmin(); return (await db.query(`select * from ai_ledger.${table} where ${where} order by 1`, params)).rows; };
  return { ...e, operator, asOperator, op, callAny, processing, reserveScreening, record, status, asWriter, rows };
}

const num = v => (v === null || v === undefined ? v : Number(v));
const usage = s => ({ state: s.state, limit: num(s.limit_micros), settled: num(s.settled_micros), unknown: num(s.unknown_micros),
  reserved: num(s.reserved_micros), committed: num(s.committed_micros) });

test('SC-021-C screening budget: fail closed without budget, plan default, 80% warning, 100% block, in-flight not cut off, tenant isolation', async t => {
  const e = await boot(t), { db, h } = e;
  const a = await e.seed(), b = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer')", [a.companyId, users.viewer]);
  assert.equal((await db.query('select plan from private.sc19_balances where company_id=$1', [a.companyId])).rows[0].plan, 'PRESELEKCJA');

  // No budget anywhere: fail closed, nothing reserved.
  const p1 = await e.processing(a);
  assert.deepEqual(await e.reserveScreening(p1.attemptId), { allowed: false, code: 'budget_unconfigured', reason: 'no_budget' });
  assert.equal((await e.status(a.companyId, users.owner)).state, 'unconfigured');
  assert.equal((await e.rows('budget_reservations')).length, 0);

  // Plan default (PRESELEKCJA) for every company on the plan; company b gets its own lower limit.
  await e.op('ai_ledger.operator_set_plan_budget', ['PRESELEKCJA', 900000, 'USD', REASON]);
  await e.op('ai_ledger.operator_set_company_budget', [b.companyId, 400000, 'USD', REASON]);

  const r1 = await e.reserveScreening(p1.attemptId);
  assert.equal(r1.allowed, true); assert.equal(r1.created, true);
  // Idempotent per operation: a worker retry finds the reservation.
  assert.deepEqual({ ...(await e.reserveScreening(p1.attemptId)), reservation_id: undefined }, { allowed: true, created: false, reservation_id: undefined });
  assert.deepEqual(usage(await e.status(a.companyId, users.owner)), { state: 'ok', limit: 900000, settled: 0, unknown: 0, reserved: SCREENING_OP, committed: SCREENING_OP });
  const [res] = await e.rows('budget_reservations');
  assert.equal(res.company_id, a.companyId); assert.equal(res.process_id, a.recruitment.id);
  assert.equal(num(res.per_attempt_micros), SCREENING_ATTEMPT); assert.equal(res.attempts, 3);

  // Second operation crosses 80%: state warning and one durable warning event.
  const p2 = await e.processing(a);
  assert.equal((await e.reserveScreening(p2.attemptId)).allowed, true);
  assert.equal((await e.status(a.companyId, users.viewer)).state, 'warning');
  let events = await e.rows('budget_events', 'company_id=$1', [a.companyId]);
  assert.deepEqual(events.map(r => [r.kind, num(r.committed_micros)]), [['warning_80', 2 * SCREENING_OP]]);

  // Attempt settled against the reservation: it holds only the remainder (no double count).
  await e.record(attempt(p1.attemptId, a.companyId)); // 1000 + 200 = 1 200
  assert.deepEqual(usage(await e.status(a.companyId, users.owner)), { state: 'warning', limit: 900000, settled: 1200, unknown: 0,
    reserved: 2 * SCREENING_OP - 1200, committed: 2 * SCREENING_OP });
  // The analysis ends: the reservation stops holding (implicit release); actual cost stays.
  await h.asAdmin();
  await db.query("update public.screening_analysis_attempts set status='failed', finished_at=clock_timestamp() where id=$1", [p1.attemptId]);
  assert.deepEqual(usage(await e.status(a.companyId, users.owner)), { state: 'ok', limit: 900000, settled: 1200, unknown: 0,
    reserved: SCREENING_OP, committed: SCREENING_OP + 1200 });

  // An unknown (maybe billed) attempt counts at the worst case of one attempt.
  await e.record(attempt(p2.attemptId, a.companyId, { outcome: 'timeout', billing: 'maybe_billed', input_tokens: null, cached_input_tokens: null, output_tokens: null }));
  assert.deepEqual(usage(await e.status(a.companyId, users.owner)), { state: 'ok', limit: 900000, settled: 1200, unknown: SCREENING_ATTEMPT,
    reserved: SCREENING_OP - SCREENING_ATTEMPT, committed: SCREENING_OP + 1200 });

  // Third operation fits (769 200 ≤ 900 000), fourth would cross 100%: refused, one blocked event.
  const p3 = await e.processing(a), p4 = await e.processing(a);
  assert.equal((await e.reserveScreening(p3.attemptId)).allowed, true);
  assert.deepEqual(await e.reserveScreening(p4.attemptId), { allowed: false, code: 'budget_exceeded' });
  assert.deepEqual(await e.reserveScreening(p4.attemptId), { allowed: false, code: 'budget_exceeded' });
  events = await e.rows('budget_events', 'company_id=$1', [a.companyId]);
  assert.deepEqual(events.map(r => r.kind), ['warning_80', 'blocked_100']);

  // The operator lowers the company's limit below what is committed: state exceeded, new work blocked,
  // but operations that already hold a reservation continue (retries and their ledger rows).
  await e.op('ai_ledger.operator_set_company_budget', [a.companyId, 500000, 'USD', REASON]);
  assert.equal((await e.status(a.companyId, users.owner)).state, 'exceeded');
  assert.equal((await e.reserveScreening(p2.attemptId)).allowed, true);
  assert.equal((await e.reserveScreening(p3.attemptId)).allowed, true);
  assert.equal((await e.record(attempt(p3.attemptId, a.companyId))).status, 'settled');
  assert.equal((await e.reserveScreening(p4.attemptId)).allowed, false);

  // Company limit NULL = inherit the plan default again.
  await e.op('ai_ledger.operator_set_company_budget', [a.companyId, null, null, REASON]);
  assert.equal(num((await e.status(a.companyId, users.owner)).limit_micros), 900000);
  assert.equal((await e.status(a.companyId, users.owner)).source, 'plan');

  // Tenant isolation: b's budget and usage are its own; a's reservations never count for b.
  assert.deepEqual(usage(await e.status(b.companyId, users.otherOwner)), { state: 'ok', limit: 400000, settled: 0, unknown: 0, reserved: 0, committed: 0 });
  const pb = await e.processing(b);
  assert.equal((await e.reserveScreening(pb.attemptId)).allowed, true);
  assert.equal((await e.status(b.companyId, users.otherOwner)).state, 'warning'); // 384 000 / 400 000
  const pb2 = await e.processing(b);
  assert.deepEqual(await e.reserveScreening(pb2.attemptId), { allowed: false, code: 'budget_exceeded' });
  // Reads are tenant-scoped: members only (any role), plus platform operators.
  for (const [company, user] of [[a.companyId, users.otherOwner], [b.companyId, users.owner], [a.companyId, users.outsider], [b.companyId, users.viewer]]) {
    await assert.rejects(e.status(company, user), denied('42501'));
  }
  await e.asOperator();
  assert.equal((await e.callAny('ai_ledger.company_budget_status', [b.companyId])).state, 'warning');
  await h.asUser(users.viewer);
  assert.deepEqual(new Set((await db.query('select company_id from ai_ledger.budget_events')).rows.map(r => r.company_id)), new Set([a.companyId]));
  await h.asUser(users.otherOwner);
  assert.deepEqual(new Set((await db.query('select company_id from ai_ledger.budget_events')).rows.map(r => r.company_id)), new Set([b.companyId]));
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select * from ai_ledger.budget_events'), denied('42501'));
  await assert.rejects(e.callAny('ai_ledger.company_budget_status', [a.companyId]), denied('42501'));

  // Only a processing attempt can reserve; unknown ids and finished attempts are refused.
  await assert.rejects(e.reserveScreening(randomUUID()), denied('42501'));
  await assert.rejects(e.reserveScreening(p1.attemptId), denied('42501'));
  // The worker cannot reach the core, the exercise path or operator functions; members cannot reserve.
  await h.asWorker();
  for (const [sql, args] of [['select ai_ledger.reserve_budget($1,$2,$3,$4,$5)', ['cv_screening', a.companyId, a.recruitment.id, randomUUID(), '1 hour']],
    ['select ai_ledger.reserve_exercise_budget($1,$2,$3)', [a.companyId, a.recruitment.id, randomUUID()]],
    ['select ai_ledger.operator_set_company_budget($1,$2,$3,$4)', [a.companyId, 1, 'USD', REASON]],
    ['select * from ai_ledger.budget_reservations', []]]) {
    await assert.rejects(db.query(sql, args), denied('42501'), sql);
  }
  await h.asUser(users.owner);
  await assert.rejects(db.query('select public.reserve_screening_ai_budget($1)', [p3.attemptId]), denied('42501'));
});

test('SC-021-C operator path: only platform operators, audited overrides (raise, bypass, revoke, expiry), append-only config', async t => {
  const e = await boot(t), { db, h } = e;
  const a = await e.seed(), b = await e.seed({ owner: users.otherOwner });
  await e.op('ai_ledger.operator_set_company_budget', [a.companyId, SCREENING_OP, 'USD', REASON]);
  const p1 = await e.processing(a), p2 = await e.processing(a), p3 = await e.processing(a), p4 = await e.processing(a);
  assert.equal((await e.reserveScreening(p1.attemptId)).allowed, true); // exactly 100%
  assert.equal((await e.reserveScreening(p2.attemptId)).allowed, false);

  // Company members (owner included) and other roles cannot configure budgets or overrides.
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  for (const [user, role] of [[users.owner, 'authenticated'], [users.otherOwner, 'authenticated'], [null, 'anon']]) {
    await h.asUser(user, role);
    for (const [name, args] of [['ai_ledger.operator_set_company_budget', [a.companyId, 10 ** 9, 'USD', REASON]],
      ['ai_ledger.operator_set_plan_budget', ['PRESELEKCJA', 10 ** 9, 'USD', REASON]],
      ['ai_ledger.operator_grant_override', [a.companyId, 'bypass', null, null, tomorrow, REASON]],
      ['ai_ledger.operator_budget_audit', [a.companyId, 10]]]) {
      await assert.rejects(e.callAny(name, args), denied('42501'), `${role}:${name}`);
    }
    for (const sql of ['insert into ai_ledger.company_budgets(company_id,limit_micros,currency,created_by,reason) values(gen_random_uuid(),1,\'USD\',gen_random_uuid(),\'xxxxxxxxxx\')',
      'select * from ai_ledger.budget_overrides', 'select * from ai_ledger.budget_audit', 'select * from ai_ledger.company_budgets']) {
      await assert.rejects(db.query(sql), denied('42501'), sql);
    }
  }
  // Invalid input is refused.
  for (const [name, args] of [['ai_ledger.operator_set_company_budget', [a.companyId, -1, 'USD', REASON]],
    ['ai_ledger.operator_set_company_budget', [a.companyId, 1, 'GBP', REASON]],
    ['ai_ledger.operator_set_company_budget', [a.companyId, 1, null, REASON]],
    ['ai_ledger.operator_set_company_budget', [a.companyId, 1, 'USD', 'short']],
    ['ai_ledger.operator_set_plan_budget', ['preselekcja', 1, 'USD', REASON]],
    ['ai_ledger.operator_grant_override', [a.companyId, 'raise', null, null, tomorrow, REASON]],
    ['ai_ledger.operator_grant_override', [a.companyId, 'bypass', 5, 'USD', tomorrow, REASON]],
    ['ai_ledger.operator_grant_override', [a.companyId, 'bypass', null, null, new Date(Date.now() + 40 * 86400000).toISOString(), REASON]],
    ['ai_ledger.operator_grant_override', [a.companyId, 'bypass', null, null, new Date(Date.now() - 1000).toISOString(), REASON]]]) {
    await assert.rejects(e.op(name, args), denied('23514', '22023', '22P02'), JSON.stringify(args));
  }
  await assert.rejects(e.op('ai_ledger.operator_set_company_budget', [randomUUID(), 1, 'USD', REASON]), denied('PT404'));

  // Raise: the limit grows while the override is active, in the budget currency only.
  const raise = await e.op('ai_ledger.operator_grant_override', [a.companyId, 'raise', SCREENING_OP, 'USD', tomorrow, 'Klient czeka na fakturę']);
  // A raise in another currency than the budget (or without a budget) would change nothing: refused.
  await assert.rejects(e.op('ai_ledger.operator_grant_override', [a.companyId, 'raise', 10 ** 9, 'PLN', tomorrow, 'Inna waluta nie działa']), denied('22023'));
  await assert.rejects(e.op('ai_ledger.operator_grant_override', [b.companyId, 'raise', 10 ** 9, 'USD', tomorrow, 'Brak budżetu firmy']), denied('22023'));
  const s = await e.status(a.companyId, users.owner);
  assert.equal(num(s.limit_micros), 2 * SCREENING_OP); assert.equal(num(s.raise_micros), SCREENING_OP);
  assert.equal((await e.reserveScreening(p2.attemptId)).allowed, true);
  assert.equal((await e.reserveScreening(p3.attemptId)).allowed, false);
  // Revoke (once): the raise stops counting; a second revoke is refused.
  await e.op('ai_ledger.operator_revoke_override', [raise, 'Faktura nieopłacona']);
  await assert.rejects(e.op('ai_ledger.operator_revoke_override', [raise, 'Faktura nieopłacona']), denied('PT409'));
  assert.equal(num((await e.status(a.companyId, users.owner)).limit_micros), SCREENING_OP);
  // Bypass: lifts the 100% block (not the warning) and is recorded on the reservation it let through.
  const bypass = await e.op('ai_ledger.operator_grant_override', [a.companyId, 'bypass', null, null, tomorrow, 'Pilna rekrutacja klienta']);
  const through = await e.reserveScreening(p3.attemptId);
  assert.equal(through.allowed, true); assert.equal(through.bypass, true);
  assert.equal((await e.rows('budget_reservations', 'operation_id=$1', [p3.attemptId]))[0].bypass_override_id, bypass);
  assert.equal((await e.status(a.companyId, users.owner)).bypass_active, true);
  assert.equal((await e.status(a.companyId, users.owner)).state, 'exceeded');
  // Expired overrides stop counting (moved into the past by the database owner; triggers bypassed only here).
  await h.asAdmin();
  await db.query('set session_replication_role = replica');
  await db.query("update ai_ledger.budget_overrides set valid_from=now()-interval '2 days', expires_at=now()-interval '1 day' where id=$1", [bypass]);
  await db.query('set session_replication_role = origin');
  assert.equal((await e.reserveScreening(p4.attemptId)).allowed, false);
  assert.equal((await e.status(b.companyId, users.otherOwner)).state, 'unconfigured', 'overrides of a never reach b');

  // Every change is one audit row with actor, reason and details; the audit is append-only.
  await e.asOperator();
  const audit = await e.callAny('ai_ledger.operator_budget_audit', [a.companyId, 50]);
  void audit;
  const auditRows = await e.rows('budget_audit', 'company_id=$1', [a.companyId]);
  assert.deepEqual(auditRows.map(r => r.action), ['set_company_budget', 'grant_override', 'revoke_override', 'grant_override']);
  for (const row of auditRows) { assert.equal(row.actor, e.operator); assert.ok(row.reason.length >= 8); }
  await h.asAdmin();
  for (const sql of ['update ai_ledger.budget_audit set reason=\'changed reason\'', 'delete from ai_ledger.budget_audit',
    'update ai_ledger.company_budgets set limit_micros=1', 'delete from ai_ledger.company_budgets', 'delete from ai_ledger.budget_events',
    'update ai_ledger.budget_estimates set max_input_tokens=1', `update ai_ledger.budget_overrides set reason='changed reason' where id='${bypass}'`,
    `update ai_ledger.budget_overrides set revoked_at=now(), revoked_by=gen_random_uuid(), revoke_reason='xxxxxxxxxx' where id='${raise}'`,
    'update ai_ledger.budget_reservations set reserved_micros=0', 'delete from ai_ledger.budget_reservations']) {
    await assert.rejects(db.query(sql), denied('42501'), sql);
  }
});

test('SC-021-C exercise budget: server writer only, before the generation slot, release, expiry, completed generations skipped', async t => {
  const e = await boot(t), { db, h } = e;
  const f = await e.seed(), foreign = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [f.companyId, users.recruiter]);
  const own = await e.connect();
  const client = createExerciseBudgetClient(async () => ({ query: (sql, v) => own.query(sql, v), release: () => {} }), f.companyId, f.recruitment.id);
  const key = randomUUID();

  // Unconfigured: refused before any generation slot exists.
  assert.deepEqual(await client.reserve(key), { allowed: false, code: 'budget_unconfigured', reason: 'no_budget' });
  await e.op('ai_ledger.operator_set_company_budget', [f.companyId, 2 * EXERCISE_OP, 'USD', REASON]);
  // A company budget in a currency without rates is unusable: still fail closed.
  await e.op('ai_ledger.operator_set_company_budget', [foreign.companyId, 10 ** 9, 'PLN', REASON]);
  const foreignClient = createExerciseBudgetClient(async () => ({ query: (sql, v) => own.query(sql, v), release: () => {} }), foreign.companyId, foreign.recruitment.id);
  assert.deepEqual(await foreignClient.reserve(randomUUID()), { allowed: false, code: 'budget_unconfigured', reason: 'no_price_in_budget_currency' });

  const r = await client.reserve(key);
  assert.equal(r.allowed, true); assert.equal(r.created, true);
  assert.equal((await client.reserve(key)).created, false);
  assert.deepEqual(usage(await e.status(f.companyId, users.owner)), { state: 'ok', limit: 2 * EXERCISE_OP, settled: 0, unknown: 0, reserved: EXERCISE_OP, committed: EXERCISE_OP });
  // The generation slot is reserved afterwards; the attempt is recorded (SC-021-B) and settles against it.
  const stamp = (await db.query('select updated_at::text from public.company_profiles where company_id=$1', [f.companyId])).rows[0]?.updated_at ?? null;
  await h.asUser(users.recruiter);
  await e.call('public.reserve_exercise_ai_generation', [f.companyId, f.recruitment.id, key, f.position.updated_at, stamp, 'a'.repeat(64)]);
  await e.asWriter(c => c.query('select ai_ledger.record_exercise_attempt($1,$2,$3::jsonb)', [f.companyId, f.recruitment.id,
    JSON.stringify(attempt(key, f.companyId, { task: 'exercise_generation', model_key: 'openai-exercise' }))]));
  assert.deepEqual(usage(await e.status(f.companyId, users.owner)), { state: 'ok', limit: 2 * EXERCISE_OP, settled: 1200, unknown: 0,
    reserved: EXERCISE_OP - 1200, committed: EXERCISE_OP });
  // As in the action: the generation finishes, then the budget is released.
  await h.asUser(users.recruiter);
  await e.call('public.finish_exercise_ai_generation', [f.companyId, f.recruitment.id, key, 'a'.repeat(64), null, null, 'exercise_ai_network_error']);
  await client.release(key);
  assert.deepEqual(usage(await e.status(f.companyId, users.owner)), { state: 'ok', limit: 2 * EXERCISE_OP, settled: 1200, unknown: 0, reserved: 0, committed: 1200 });
  assert.ok((await e.rows('budget_reservations', 'operation_id=$1', [key]))[0].released_at);
  // A finished generation needs no reservation (no provider call will follow).
  assert.deepEqual(await client.reserve(key), { allowed: true, created: false, skipped: true });
  const done = randomUUID();
  await h.asUser(users.recruiter);
  await e.call('public.reserve_exercise_ai_generation', [f.companyId, f.recruitment.id, done, f.position.updated_at, stamp, 'a'.repeat(64)]);
  await e.call('public.finish_exercise_ai_generation', [f.companyId, f.recruitment.id, done, 'a'.repeat(64), null, null, 'exercise_ai_network_error']);
  assert.deepEqual(await client.reserve(done), { allowed: true, created: false, skipped: true });

  // A released reservation without attempts (e.g. the request failed before the slot) is re-armed only
  // after a full budget check: a new version of the hold, never a free pass.
  const k4 = randomUUID();
  assert.equal((await client.reserve(k4)).created, true);
  await client.release(k4);
  const rearmed = await client.reserve(k4);
  assert.equal(rearmed.created, true); assert.equal(rearmed.arm, 2);
  assert.deepEqual((await e.rows('budget_reservations', 'operation_id=$1', [k4])).map(r => [r.arm, r.released_at !== null]), [[1, true], [2, false]]);
  await client.release(k4);

  // A concurrent duplicate of the same key that lost the draft slot cannot free the winner's hold:
  // release is refused while the generation of that key is still 'reserved'.
  const k5 = randomUUID();
  assert.equal((await client.reserve(k5)).created, true);
  await h.asUser(users.recruiter);
  await e.call('public.reserve_exercise_ai_generation', [f.companyId, f.recruitment.id, k5, f.position.updated_at, stamp, 'a'.repeat(64)]);
  await client.release(k5);
  await h.asAdmin();
  assert.equal((await db.query('select released_at from ai_ledger.budget_reservations where operation_id=$1', [k5])).rows[0].released_at, null);
  assert.equal(num((await e.status(f.companyId, users.owner)).reserved_micros), EXERCISE_OP);
  // ... and once that generation finishes, the hold stops counting (implicit release).
  await h.asUser(users.recruiter);
  await e.call('public.finish_exercise_ai_generation', [f.companyId, f.recruitment.id, k5, 'a'.repeat(64), null, null, 'exercise_ai_network_error']);
  assert.equal(num((await e.status(f.companyId, users.owner)).reserved_micros), 0);

  // Room for one more operation only.
  const k2 = randomUUID(), k3 = randomUUID();
  assert.equal((await client.reserve(k2)).allowed, true);
  assert.deepEqual(await client.reserve(k3), { allowed: false, code: 'budget_exceeded' });
  const expire = async key => {
    await h.asAdmin();
    await db.query('set session_replication_role = replica');
    await db.query("update ai_ledger.budget_reservations set expires_at=created_at+interval '1 millisecond' where operation_id=$1", [key]);
    await db.query('set session_replication_role = origin');
  };
  // Crash without release: the reservation stops holding once it expires.
  await expire(k2);
  assert.equal((await client.reserve(k3)).allowed, true);
  // The expired key without attempts gets no free pass: full check, refused over budget (no re-use of
  // released or expired keys past the 100% block).
  assert.deepEqual(await client.reserve(k2), { allowed: false, code: 'budget_exceeded' });
  // An operation with attempts in the ledger is in flight: never cut off, even expired and over budget.
  await h.asUser(users.recruiter);
  await e.call('public.reserve_exercise_ai_generation', [f.companyId, f.recruitment.id, k3, f.position.updated_at, stamp, 'a'.repeat(64)]);
  await e.asWriter(c => c.query('select ai_ledger.record_exercise_attempt($1,$2,$3::jsonb)', [f.companyId, f.recruitment.id,
    JSON.stringify(attempt(k3, f.companyId, { task: 'exercise_generation', model_key: 'openai-exercise' }))]));
  await expire(k3);
  await e.op('ai_ledger.operator_set_company_budget', [f.companyId, 1000, 'USD', REASON]);
  assert.equal((await e.status(f.companyId, users.owner)).state, 'exceeded');
  assert.deepEqual({ ...(await client.reserve(k3)), reservation_id: undefined }, { allowed: true, created: false, reservation_id: undefined });
  assert.deepEqual(await client.reserve(k2), { allowed: false, code: 'budget_exceeded' });

  // Bound to the company's recruitment; keys of screening operations are refused.
  const wrong = createExerciseBudgetClient(async () => ({ query: (sql, v) => own.query(sql, v), release: () => {} }), f.companyId, foreign.recruitment.id);
  await assert.rejects(wrong.reserve(randomUUID()), /SC021_BUDGET_CALL_FAILED/);
  await assert.rejects(e.asWriter(c => c.query('select ai_ledger.reserve_exercise_budget($1,$2,$3)', [f.companyId, foreign.recruitment.id, randomUUID()])), denied('PT404'));
  const p = await e.processing(f);
  await assert.rejects(e.asWriter(c => c.query('select ai_ledger.reserve_exercise_budget($1,$2,$3)', [f.companyId, f.recruitment.id, p.attemptId])), denied('PT409'));
  // Never through the recruiter's session, anon or the worker.
  for (const [id, role] of [[users.recruiter, 'authenticated'], [users.owner, 'authenticated'], [null, 'anon'], [null, 'screening_worker']]) {
    await h.asUser(id, role);
    await assert.rejects(db.query('select ai_ledger.reserve_exercise_budget($1,$2,$3)', [f.companyId, f.recruitment.id, randomUUID()]), denied('42501'), role);
    await assert.rejects(db.query('select ai_ledger.release_exercise_budget($1,$2,$3)', [f.companyId, f.recruitment.id, k2]), denied('42501'), role);
  }
  // The writer role cannot read or configure anything else.
  await assert.rejects(e.asWriter(c => c.query('select * from ai_ledger.budget_reservations')), denied('42501'));
  await assert.rejects(e.asWriter(c => c.query('select ai_ledger.company_budget_status($1)', [f.companyId])), denied('42501'));
});

test('SC-021-C concurrency: two connections cannot both take the last room in a budget', async t => {
  const e = await boot(t), { h } = e;
  const f = await e.seed();
  await e.op('ai_ledger.operator_set_company_budget', [f.companyId, SCREENING_OP + 1000, 'USD', REASON]);
  const p1 = await e.processing(f), p2 = await e.processing(f), p3 = await e.processing(f), p4 = await e.processing(f);
  const a = await e.connect(), b = await e.connect();
  for (const c of [a, b]) await c.query('set role screening_worker');
  // Two different operations racing for room for one.
  const race = await Promise.all([e.reserveScreening(p1.attemptId, a), e.reserveScreening(p2.attemptId, b)]);
  assert.deepEqual(race.map(r => r.allowed).sort(), [false, true]);
  assert.equal(race.find(r => !r.allowed).code, 'budget_exceeded');
  assert.equal((await e.rows('budget_reservations')).length, 1);
  // The same operation from two sessions: one reservation, the other answer is "existing".
  await e.op('ai_ledger.operator_set_company_budget', [f.companyId, 10 * SCREENING_OP, 'USD', REASON]);
  const same = await Promise.all([e.reserveScreening(p3.attemptId, a), e.reserveScreening(p3.attemptId, b)]);
  assert.deepEqual(same.map(r => r.created).sort(), [false, true]);
  assert.equal((await e.rows('budget_reservations', 'operation_id=$1', [p3.attemptId])).length, 1);
  // Repeatable read would hide a concurrent reservation from the sum: refused.
  await a.query('begin isolation level repeatable read');
  await assert.rejects(e.reserveScreening(p4.attemptId, a), denied('PT409'));
  await a.query('rollback');
  assert.equal((await e.rows('budget_reservations', 'operation_id=$1', [p4.attemptId])).length, 0);
  void h;
});

test('SC-021-C price close: one-time valid_to by an operator, audited; rates stay immutable', async t => {
  const e = await boot(t), { db, h } = e;
  await h.asAdmin();
  const [price] = (await db.query("select id, valid_from from ai_ledger.prices where price_version='placeholder-test-2026-11-09'")).rows;
  const later = new Date(Date.now() + 3600000).toISOString();
  for (const [user, role] of [[users.owner, 'authenticated'], [null, 'anon']]) {
    await h.asUser(user, role);
    await assert.rejects(e.callAny('ai_ledger.operator_close_price', [price.id, later, REASON]), denied('42501'));
  }
  await assert.rejects(e.op('ai_ledger.operator_close_price', [price.id, new Date(Date.now() - 60000).toISOString(), REASON]), denied('22023'));
  await assert.rejects(e.op('ai_ledger.operator_close_price', [price.id, later, 'short']), denied('22023'));
  await assert.rejects(e.op('ai_ledger.operator_close_price', [randomUUID(), later, REASON]), denied('PT404'));
  await e.op('ai_ledger.operator_close_price', [price.id, later, 'Nowa wersja stawek zatwierdzona']);
  await assert.rejects(e.op('ai_ledger.operator_close_price', [price.id, later, 'Nowa wersja stawek zatwierdzona']), denied('PT409'));
  await h.asAdmin();
  assert.equal(new Date((await db.query('select valid_to from ai_ledger.prices where id=$1', [price.id])).rows[0].valid_to).toISOString(), later);
  // Even the database owner cannot change rates, re-open or move the close date, or delete a price.
  for (const sql of ['update ai_ledger.prices set input_per_mtok_micros=1 where id=$1', 'update ai_ledger.prices set valid_to=null where id=$1',
    "update ai_ledger.prices set valid_to=valid_to+interval '1 day' where id=$1", 'delete from ai_ledger.prices where id=$1']) {
    await assert.rejects(db.query(sql, [price.id]), denied('42501'), sql);
  }
  const [row] = await e.rows('budget_audit', "action='close_price'");
  assert.equal(row.target_id, price.id); assert.equal(row.actor, e.operator); assert.equal(row.details.price_version, 'placeholder-test-2026-11-09');
  // Pricing still uses the closed rate until valid_to (recorded rows keep their price version).
  const f = await e.seed(), p = await e.processing(f);
  assert.equal((await e.record(attempt(p.attemptId, f.companyId))).cost_micros, 1200);
});

test('SC-021-C migration: refuses a second install; rollback refuses non-empty budgets and restores the SC-021-B price lock', async t => {
  const e = await boot(t), { db, h } = e;
  const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  const down = await readFile(new URL(`../supabase/rollbacks/${migration.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8');
  await h.asAdmin();
  await assert.rejects(db.exec(sql), error => error.code === '55000' && /sc021c_already_installed/.test(error.message));
  await db.exec('rollback');
  await db.exec(down);
  assert.equal((await db.query("select to_regclass('ai_ledger.budget_reservations') v")).rows[0].v, null);
  assert.equal((await db.query("select to_regprocedure('public.reserve_screening_ai_budget(uuid)') v")).rows[0].v, null);
  await assert.rejects(db.query("update ai_ledger.prices set valid_to=now()+interval '1 day'"), denied('42501'));
  assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value, r15);
  await db.exec(sql);
  await e.op('ai_ledger.operator_set_plan_budget', ['FREE', 1000, 'USD', REASON]);
  await h.asAdmin();
  await assert.rejects(db.exec(down), error => error.code === '55000' && /sc021c_rollback_budgets_not_empty/.test(error.message));
  await db.exec('rollback');
  assert.equal((await e.rows('plan_budgets')).length, 1);
});

test('SC-021-C periods follow Europe/Warsaw months (DST included); a jump from under 80% past 100% records both events', async t => {
  const e = await boot(t), { db, h } = e;
  await h.asAdmin();
  const bounds = async at => { const r = (await db.query('select * from ai_ledger.period_bounds($1::timestamptz)', [at])).rows[0];
    return [r.period_start.toISOString(), r.period_end.toISOString()]; };
  // Mid-March (CET) → March ends at the CEST switch-over month boundary.
  assert.deepEqual(await bounds('2026-03-15T12:00:00Z'), ['2026-02-28T23:00:00.000Z', '2026-03-31T22:00:00.000Z']);
  // 22:30 UTC on 31 March is already 1 April in Warsaw (CEST, +2).
  assert.deepEqual(await bounds('2026-03-31T22:30:00Z'), ['2026-03-31T22:00:00.000Z', '2026-04-30T22:00:00.000Z']);
  assert.deepEqual(await bounds('2026-03-31T21:30:00Z'), ['2026-02-28T23:00:00.000Z', '2026-03-31T22:00:00.000Z']);
  // October (CEST) ends at 23:00 UTC because November starts in CET (+1).
  assert.deepEqual(await bounds('2026-10-31T22:30:00Z'), ['2026-09-30T22:00:00.000Z', '2026-10-31T23:00:00.000Z']);
  assert.deepEqual(await bounds('2026-10-31T23:30:00Z'), ['2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z']);

  const f = await e.seed();
  await e.op('ai_ledger.operator_set_company_budget', [f.companyId, 300000, 'USD', REASON]);
  const p = await e.processing(f);
  assert.deepEqual(await e.reserveScreening(p.attemptId), { allowed: false, code: 'budget_exceeded' });
  assert.deepEqual((await e.rows('budget_events', 'company_id=$1', [f.companyId])).map(r => r.kind).sort(), ['blocked_100', 'warning_80']);
  assert.equal((await e.status(f.companyId, users.owner)).state, 'ok');
});
