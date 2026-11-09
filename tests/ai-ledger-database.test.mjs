// SC-021-B: durable ledger of physical AI attempts. Native PostgreSQL (CI: PG16), full migration chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
import { createExerciseLedgerWriter } from '../lib/ai-ledger-writer.ts';

const migration = '20261109200000_sc021_ai_ledger.sql';
const r15 = '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44';
const denied = (...codes) => error => codes.includes(error.code);
const MODEL = 'gpt-5.4-mini-2026-03-17';

function attempt(operationId, companyId, overrides = {}) {
  return {
    attempt_id: randomUUID(), operation_id: operationId, company_id: companyId, task: 'cv_screening', attempt: 1,
    provider: 'openai', model: MODEL, model_revision: null, model_key: 'openai-screening',
    policy_version: 'sc021-a2-2026-11-09', outcome: 'completed', billing: 'billed',
    input_tokens: 3, cached_input_tokens: 1, output_tokens: 1, provider_request_id: null, latency_ms: 120,
    ...overrides,
  };
}

async function boot(t) {
  const e = await activeBoot(t, { fullChain: true, throughMigration: migration });
  const { db, h } = e;
  await h.asAdmin();
  assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value, r15, 'SC-010 signature unchanged');
  const screeningAttempt = async f => { await h.asAdmin(); return (await db.query(`select t.id from public.screening_analysis_attempts t
    join public.screening_analysis_versions v on v.id=t.analysis_id where v.application_id=$1 order by t.created_at desc limit 1`,
  [f.application.id])).rows[0].id; };
  const asWorker = () => h.asWorker();
  const screening = async (payload, client = db) => (await client.query('select public.record_screening_ai_attempt($1::jsonb) r', [JSON.stringify(payload)])).rows[0].r;
  // The server-only writer path: role ai_ledger_writer in its own transaction (as lib/ai-ledger-writer.ts).
  const exercise = async (f, payload, client = db) => {
    await client.query('reset role');
    await client.query('begin');
    try {
      await client.query('set local role ai_ledger_writer');
      const r = (await client.query('select ai_ledger.record_exercise_attempt($1,$2,$3::jsonb) r',
        [f.companyId, f.recruitment.id, JSON.stringify(payload)])).rows[0].r;
      await client.query('commit'); return r;
    } catch (error) { await client.query('rollback'); throw error; }
  };
  const rows = async (where = 'true', params = []) => { await h.asAdmin(); return (await db.query(`select * from ai_ledger.attempts where ${where} order by id`, params)).rows; };
  return { ...e, screeningAttempt, asWorker, screening, exercise, rows };
}

test('SC-021-B screening ledger: trusted tenant, idempotency, retries, status mapping, prices, grants and tenant-isolated reads', async t => {
  const e = await boot(t), { db, h } = e;
  const a = await e.seed(), b = await e.seed({ owner: users.otherOwner });
  const opA = await e.screeningAttempt(a), opB = await e.screeningAttempt(b);
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer')", [a.companyId, users.viewer]);

  await e.asWorker();
  assert.equal((await db.query('select public.screening_attempt_tenant($1) v', [opA])).rows[0].v, a.companyId);
  await assert.rejects(db.query('select public.screening_attempt_tenant($1)', [randomUUID()]), denied('42501'));

  // Settled on placeholder rates; integer arithmetic rounded up: (2·1e6 + 1·5e5 + 1·2e6)/1e6 = 4.5 → 5.
  const first = attempt(opA, a.companyId, { provider_request_id: 'req_synthetic_1' });
  const r1 = await e.screening(first);
  assert.deepEqual({ ...r1, ledger_id: undefined }, { ledger_id: undefined, attempt_id: first.attempt_id, status: 'settled',
    cost_micros: 5, priced: true, price_placeholder: true, replayed: false });
  // Retry of the same write: the existing row, never a double count.
  const replay = await e.screening(first);
  assert.equal(replay.ledger_id, r1.ledger_id); assert.equal(replay.replayed, true);
  assert.equal((await e.rows('attempt_id=$1', [first.attempt_id])).length, 1);
  await e.asWorker();
  // Same attempt_id, different content: conflict, the stored row is not overwritten.
  await assert.rejects(e.screening({ ...first, output_tokens: 999 }), denied('PT409'));
  await assert.rejects(e.screening({ ...first, attempt: 2 }), denied('PT409'));

  // A second physical call (retry) has its own attempt_id: two rows sharing one operation_id.
  await e.screening(attempt(opA, a.companyId, { attempt: 2, outcome: 'timeout', billing: 'maybe_billed',
    input_tokens: null, cached_input_tokens: null, output_tokens: null }));
  await e.screening(attempt(opA, a.companyId, { attempt: 3, outcome: 'rate_limit', billing: 'not_billed',
    input_tokens: null, cached_input_tokens: null, output_tokens: null }));
  await e.screening(attempt(opA, a.companyId, { attempt: 4, outcome: 'incomplete', input_tokens: null, cached_input_tokens: null, output_tokens: null }));
  await e.screening(attempt(opA, a.companyId, { attempt: 5, model: 'synthetic-unpriced-model', input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 }));
  await h.asAdmin();
  const opRows = await e.rows('operation_id=$1', [opA]);
  assert.deepEqual(opRows.map(r => [r.attempt_no, r.status, r.billing, r.cost_micros === null ? null : Number(r.cost_micros), r.price_version, r.price_placeholder]), [
    [1, 'settled', 'billed', 5, 'placeholder-test-2026-11-09', true],
    [2, 'unknown', 'maybe_billed', null, null, null],
    [3, 'released', 'not_billed', 0, null, null],
    [4, 'unknown', 'billed', null, null, null],
    [5, 'settled', 'billed', null, null, null],
  ]);
  for (const row of opRows) {
    assert.equal(row.company_id, a.companyId); assert.equal(row.process_id, a.recruitment.id);
    assert.equal(row.candidate_ref, a.application.id);
    // Never stored for screening (would point at the provider-side record of the CV request).
    assert.equal(row.provider_request_id, null);
  }

  // Invalid content and tenant mismatch fail closed; nothing is written.
  await e.asWorker();
  await assert.rejects(e.screening(attempt(opA, b.companyId)), denied('42501'));
  await assert.rejects(e.screening(attempt(randomUUID(), a.companyId)), denied('42501'));
  for (const bad of [{ task: 'exercise_generation' }, { billing: 'billed', outcome: 'timeout' }, { cached_input_tokens: 9 },
    { input_tokens: 1.5 }, { output_tokens: null }, { billing: 'not_billed', outcome: 'auth_error' }, { prompt: 'x' },
    { provider: 'other' }, { latency_ms: -1 }, { model: 'bad model' }]) {
    await assert.rejects(e.screening(attempt(opA, a.companyId, bad)), denied('22023'), JSON.stringify(bad));
  }
  const noKey = attempt(opA, a.companyId); delete noKey.latency_ms;
  await assert.rejects(e.screening(noKey), denied('22023'));

  // An approved rate wins over the placeholder for new rows; old rows keep their price version.
  await h.asAdmin();
  await db.query(`insert into ai_ledger.prices(provider,model,price_version,currency,input_per_mtok_micros,cached_input_per_mtok_micros,
    output_per_mtok_micros,placeholder,approved,valid_from) values('openai',$1,'synthetic-approved-v1','USD',2000000,0,0,false,true,now()-interval '1 minute')`, [MODEL]);
  await assert.rejects(db.query("update ai_ledger.prices set approved=false where price_version='synthetic-approved-v1'"), denied('42501'));
  await assert.rejects(db.query('delete from ai_ledger.attempts where operation_id=$1', [opA]), denied('42501'));
  await assert.rejects(db.query('update ai_ledger.attempts set cost_micros=0 where operation_id=$1', [opA]), denied('42501'));
  await e.asWorker();
  const approved = await e.screening(attempt(opB, b.companyId, { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 }));
  assert.equal(approved.cost_micros, 2); assert.equal(approved.price_placeholder, false);
  await h.asAdmin();
  assert.equal((await e.rows('operation_id=$1', [opB]))[0].price_version, 'synthetic-approved-v1');
  assert.equal(Number((await e.rows('attempt_id=$1', [first.attempt_id]))[0].cost_micros), 5);

  // Writes only through the worker RPC; reads only through RLS for members of the company.
  for (const role of [['authenticated', users.owner], ['anon', null]]) {
    await h.asUser(role[1], role[0]);
    await assert.rejects(e.screening(attempt(opA, a.companyId)), denied('42501'));
    await assert.rejects(db.query('select public.screening_attempt_tenant($1)', [opA]), denied('42501'));
    await assert.rejects(db.query('select ai_ledger.record_attempt($1,null,null,$2,$3::jsonb,true,true,16)',
      [a.companyId, 'cv_screening', JSON.stringify(attempt(opA, a.companyId))]), denied('42501'));
    await assert.rejects(db.query('select * from ai_ledger.prices'), denied('42501'));
  }
  await h.asUser(users.owner);
  await assert.rejects(db.query(`insert into ai_ledger.attempts(attempt_id,operation_id,company_id,task,attempt_no,provider,model,model_key,
    policy_version,outcome,billing,status,latency_ms,content_hash) values($1,$1,$2,'report_summary',1,'openai','m','k','v','timeout','maybe_billed','unknown',1,$3)`,
  [randomUUID(), a.companyId, 'a'.repeat(64)]), denied('42501'));
  assert.deepEqual(new Set((await db.query('select company_id from ai_ledger.attempts')).rows.map(r => r.company_id)), new Set([a.companyId]));
  await h.asUser(users.viewer);
  assert.equal((await db.query('select count(*)::int n from ai_ledger.attempts')).rows[0].n, opRows.length);
  await h.asUser(users.otherOwner);
  assert.deepEqual((await db.query('select company_id from ai_ledger.attempts')).rows.map(r => r.company_id), [b.companyId]);
  await h.asUser(users.outsider);
  assert.equal((await db.query('select count(*)::int n from ai_ledger.attempts')).rows[0].n, 0);
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select * from ai_ledger.attempts'), denied('42501'));
  await e.asWorker();
  await assert.rejects(db.query('select * from ai_ledger.attempts'), denied('42501'));
  await assert.rejects(db.query('select ai_ledger.record_exercise_attempt($1,$2,$3::jsonb)',
    [a.companyId, a.recruitment.id, JSON.stringify(attempt(opA, a.companyId, { task: 'exercise_generation' }))]), denied('42501'));

  // Per-operation cap bounds what any writer can add to one operation.
  await h.asAdmin();
  const used = (await e.rows('operation_id=$1', [opA])).length;
  await e.asWorker();
  for (let n = used; n < 16; n++) await e.screening(attempt(opA, a.companyId, { attempt: 6 }));
  await assert.rejects(e.screening(attempt(opA, a.companyId, { attempt: 6 })), denied('PT429'));
  assert.equal((await e.screening(first)).replayed, true, 'an existing attempt still replays at the cap');
});

test('SC-021-B exercise ledger: only the server writer role, bound to a live reservation, allowlisted route, cap 1, token bounds', async t => {
  const e = await boot(t), { db, h } = e;
  const f = await e.seed(), foreign = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
    [f.companyId, users.recruiter, users.viewer]);
  const writer = (await db.query("select rolcanlogin, rolinherit, rolsuper, rolbypassrls from pg_roles where rolname='ai_ledger_writer'")).rows[0];
  assert.deepEqual(writer, { rolcanlogin: false, rolinherit: false, rolsuper: false, rolbypassrls: false });
  const stamp = (await db.query('select updated_at::text from public.company_profiles where company_id=$1', [f.companyId])).rows[0]?.updated_at ?? null;
  const fingerprint = 'a'.repeat(64);
  const reserve = async key => { await h.asUser(users.recruiter);
    assert.equal((await e.call('public.reserve_exercise_ai_generation', [f.companyId, f.recruitment.id, key, f.position.updated_at, stamp, fingerprint])).claimed, true); };
  const key = randomUUID(); await reserve(key);
  const ex = (op, over = {}) => attempt(op, f.companyId, { task: 'exercise_generation', model_key: 'openai-exercise', provider_request_id: 'req_ex_1', ...over });
  const payload = ex(key);

  // No API role can execute it any more: not the recruiter's session, not anon, not the worker.
  for (const [role, id] of [['authenticated', users.recruiter], ['authenticated', users.owner], ['anon', null], ['screening_worker', null]]) {
    await h.asUser(id, role);
    await assert.rejects(db.query('select ai_ledger.record_exercise_attempt($1,$2,$3::jsonb)', [f.companyId, f.recruitment.id, JSON.stringify(payload)]),
      denied('42501'), role);
  }
  await h.asAdmin();
  assert.equal((await db.query("select to_regprocedure('public.record_exercise_ai_attempt(uuid,uuid,jsonb)') v")).rows[0].v, null);

  // Bound to the reservation: wrong company/recruitment pairing, unknown key, payload tenant mismatch.
  await assert.rejects(e.exercise({ ...f, companyId: foreign.companyId }, payload), denied('PT404'));
  await assert.rejects(e.exercise({ ...f, companyId: foreign.companyId, recruitment: foreign.recruitment }, payload), denied('PT404'));
  await assert.rejects(e.exercise(f, ex(randomUUID())), denied('PT404'));
  await assert.rejects(e.exercise(f, { ...payload, company_id: foreign.companyId }), denied('42501'));
  await assert.rejects(e.exercise(f, { ...payload, task: 'cv_screening' }), denied('22023'));
  // Allowlisted route entry only; tokens bounded by the route's request and output limits.
  for (const bad of [{ model: 'gpt-other' }, { model_key: 'openai-screening' }, { policy_version: 'forged-1' }, { provider: 'anthropic' },
    { model_revision: 'r1' }, { input_tokens: 48001, cached_input_tokens: 0 }, { output_tokens: 4001 }, { input_tokens: 2147483647, cached_input_tokens: 0 }]) {
    await assert.rejects(e.exercise(f, ex(key, bad)), denied('22023'), JSON.stringify(bad));
  }

  // Through the real server-only writer (lib/ai-ledger-writer.ts) on its own connection.
  const own = await e.connect();
  const write = createExerciseLedgerWriter(async () => ({ query: (sql, v) => own.query(sql, v), release: () => {} }), f.companyId, f.recruitment.id);
  await write(payload);
  await write(payload); // replay
  const [row] = await e.rows('attempt_id=$1', [payload.attempt_id]);
  assert.equal(row.status, 'settled'); assert.equal(Number(row.cost_micros), 5);
  assert.equal(row.company_id, f.companyId); assert.equal(row.process_id, f.recruitment.id);
  assert.equal(row.candidate_ref, null); assert.equal(row.provider_request_id, 'req_ex_1');
  assert.equal((await e.rows('operation_id=$1', [key])).length, 1);
  // Database text never leaves the writer.
  await assert.rejects(write({ ...payload, output_tokens: 6 }), error => error.message === 'SC021_LEDGER_WRITE_FAILED');

  // Cap = route maxAttempts (1): a second physical attempt for the same generation is refused.
  await assert.rejects(e.exercise(f, ex(key, { attempt: 2 })), denied('PT429'));
  // Expired reservation: no new rows (a replay still answers).
  const late = randomUUID(); await reserve(late);
  await h.asAdmin();
  await db.query("update exercise_ai.recruitment_settings set generation_requests=jsonb_set(generation_requests,array[$1,'expires_at'],to_jsonb('2000-01-01T00:00:00Z'::text)) where recruitment_id=$2",
    [late, f.recruitment.id]);
  await assert.rejects(e.exercise(f, ex(late)), denied('PT409'));
  // Finished reservation: no new rows; the recorded one still replays.
  const done = randomUUID(); await reserve(done);
  const doneAttempt = ex(done);
  await e.exercise(f, doneAttempt);
  await h.asUser(users.recruiter);
  await e.call('public.finish_exercise_ai_generation', [f.companyId, f.recruitment.id, done, fingerprint, null, null, 'exercise_ai_network_error']);
  assert.equal((await e.exercise(f, doneAttempt)).replayed, true);
  const after = randomUUID(); await reserve(after);
  await h.asUser(users.recruiter);
  await e.call('public.finish_exercise_ai_generation', [f.companyId, f.recruitment.id, after, fingerprint, null, null, 'exercise_ai_network_error']);
  await assert.rejects(e.exercise(f, ex(after)), denied('PT409'));

  // A client-chosen request key cannot target a screening operation.
  const op = await e.screeningAttempt(f);
  await reserve(op);
  await assert.rejects(e.exercise(f, ex(op)), denied('PT409'));
  await e.asWorker(); await e.screening(attempt(op, f.companyId));
  await assert.rejects(e.exercise(f, ex(op)), denied('PT409'));

  // Reads stay tenant-scoped.
  await h.asUser(users.viewer);
  assert.equal((await db.query("select count(*)::int n from ai_ledger.attempts where task='exercise_generation'")).rows[0].n, 2);
  await h.asUser(users.otherOwner);
  assert.equal((await db.query('select count(*)::int n from ai_ledger.attempts')).rows[0].n, 0);
});

test('SC-021-B concurrency: two connections cannot double-write one attempt or exceed a cap', async t => {
  const e = await boot(t), { db, h } = e;
  const f = await e.seed(), op = await e.screeningAttempt(f);
  const a = await e.connect(), b = await e.connect();
  for (const c of [a, b]) await c.query('set role screening_worker');
  const write = (client, payload) => client.query('select public.record_screening_ai_attempt($1::jsonb) r', [JSON.stringify(payload)]).then(r => r.rows[0].r);
  // Same attempt_id from two sessions at once: exactly one row, the other is a replay.
  const same = attempt(op, f.companyId);
  const both = await Promise.all([write(a, same), write(b, same)]);
  assert.equal(both[0].ledger_id, both[1].ledger_id);
  assert.deepEqual(both.map(r => r.replayed).sort(), [false, true]);
  assert.equal((await e.rows('attempt_id=$1', [same.attempt_id])).length, 1);
  // Fill to one below the cap, then race two new attempts: the cap holds.
  await e.asWorker();
  for (let n = 1; n < 15; n++) await e.screening(attempt(op, f.companyId, { attempt: 2 }));
  const race = await Promise.allSettled([write(a, attempt(op, f.companyId, { attempt: 3 })), write(b, attempt(op, f.companyId, { attempt: 3 }))]);
  assert.deepEqual(race.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(race.find(r => r.status === 'rejected').reason.code, 'PT429');
  assert.equal((await e.rows('operation_id=$1', [op])).length, 16);

  // Exercise cap (1) under a race, through two writer-role sessions.
  const stamp = (await db.query('select updated_at::text from public.company_profiles where company_id=$1', [f.companyId])).rows[0]?.updated_at ?? null;
  const key = randomUUID();
  await h.asUser(f.owner);
  await e.call('public.reserve_exercise_ai_generation', [f.companyId, f.recruitment.id, key, f.position.updated_at, stamp, 'a'.repeat(64)]);
  await h.asAdmin();
  for (const c of [a, b]) await c.query('reset role');
  const ex = () => attempt(key, f.companyId, { task: 'exercise_generation', model_key: 'openai-exercise' });
  const exRace = await Promise.allSettled([e.exercise(f, ex(), a), e.exercise(f, ex(), b)]);
  assert.deepEqual(exRace.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(exRace.find(r => r.status === 'rejected').reason.code, 'PT429');
  assert.equal((await e.rows('operation_id=$1', [key])).length, 1);
});

test('SC-021-B erasure: purge keeps the cost row and leaves nothing that maps it to the candidate', async t => {
  const e = await boot(t), { db, h, x } = e;
  const f = await e.seed(), other = await e.seed();
  const op = await e.screeningAttempt(f);
  await h.asAdmin();
  const analysis = (await db.query('select analysis_id from public.screening_analysis_attempts where id=$1', [op])).rows[0].analysis_id;
  await e.asWorker();
  const recorded = await e.screening(attempt(op, f.companyId));
  await h.asUser(f.owner);
  const preview = await x.preview(f);
  assert.ok(!preview.blockers.includes('schema_dependency_unknown'), 'ledger is outside the SC-010 inventory by design');
  await x.policy(f, 0, lifecycleRules); f.resolutionId = await x.resolve(f); await x.configure();
  const state = await x.freeze(f);
  await x.transition(state.request_id, 0, 'authorized'); await x.transition(state.request_id, 1, 'erasing'); await x.purge(state.request_id, 2);
  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1', [f.candidate.id])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1', [other.candidate.id])).rows[0].n, 1);
  // The company's cost record survives erasure.
  const [row] = await e.rows('id=$1', [recorded.ledger_id]);
  assert.equal(row.operation_id, op); assert.equal(row.candidate_ref, f.application.id);
  // No table outside the ledger still holds the attempt or application id: the ledger's references
  // are dangling pseudonyms that no longer map to a person. The analysis id survives only in the
  // reviewed SC-019 accounting tables (company-level credit records without candidate data, the same
  // precedent as R11), never next to the attempt or application id.
  const tables = (await db.query(`select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema','ai_ledger','pg_toast')`)).rows;
  assert.ok(tables.length > 50);
  const analysisHolders = [];
  for (const { nspname, relname } of tables) {
    const name = `${JSON.stringify(nspname)}.${JSON.stringify(relname)}`;
    const hits = (await db.query(`select count(*)::int n from ${name} t
      where strpos(to_jsonb(t)::text,$1)>0 or strpos(to_jsonb(t)::text,$2)>0`, [op, f.application.id])).rows[0].n;
    assert.equal(hits, 0, `${nspname}.${relname} still maps a ledger reference to the erased candidate`);
    if ((await db.query(`select count(*)::int n from ${name} t where strpos(to_jsonb(t)::text,$1)>0`, [analysis])).rows[0].n)
      analysisHolders.push(`${nspname}.${relname}`);
  }
  for (const holder of analysisHolders) assert.match(holder, /^private\.sc19_(credit_journal|analysis_spend)$/);
  assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value, r15);
});

test('SC-021-B migration: refuses a second install and unreviewed sources; rollback refuses a non-empty ledger', async t => {
  const e = await boot(t), { db, h } = e;
  const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  const down = await readFile(new URL(`../supabase/rollbacks/${migration.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8');
  await h.asAdmin();
  await assert.rejects(db.exec(sql), error => error.code === '55000' && /sc021b_already_installed/.test(error.message));
  await db.exec('rollback');
  // Empty ledger: rollback removes everything; the migration then re-applies cleanly.
  await db.exec(down);
  assert.equal((await db.query("select to_regnamespace('ai_ledger') v")).rows[0].v, null);
  assert.equal((await db.query("select to_regprocedure('public.record_screening_ai_attempt(jsonb)') v")).rows[0].v, null);
  await db.exec('begin; create table public.sc021b_drift(id integer)');
  await assert.rejects(db.exec(sql), error => error.code === '55000' && /sc021b_source_schema_unreviewed/.test(error.message));
  await db.exec('rollback');
  await db.exec(sql);
  const f = await e.seed(), op = await e.screeningAttempt(f);
  await e.asWorker(); await e.screening(attempt(op, f.companyId));
  await h.asAdmin();
  await assert.rejects(db.exec(down), error => error.code === '55000' && /sc021b_rollback_ledger_not_empty/.test(error.message));
  await db.exec('rollback');
  assert.equal((await e.rows()).length, 1);
});
