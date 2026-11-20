// R7: monthly cost cap for voice interviews (50 zł, owner decision 19.11.2026)
// as a real migration (20261121120000_r7_voice_cost_cap.sql) on the full
// checked-in chain. Covers: under the cap a call is ordered; at/over the cap the
// database refuses a new dispatch claim (PT429 VOICE_COST_CAP_REACHED) and the
// worker turns it into a plain recruiter message without any HTTP request;
// parallel dispatches cannot both take the last room; the month boundary is the
// Polish calendar month; one owner alert per month (also when a recorded provider
// cost crosses the cap); the default reservation is a per-call upper bound and a
// recorded cost above it stops new calls for the month (cause reserve_exceeded);
// a rejected/abandoned claim is released on the ledger itself, so an SC-010
// erasure of the claim leaves the month's sum unchanged; another company can
// neither read nor change a charge;
// API roles see nothing; the manual rollback restores the R20 claim guard.
// Native disposable PostgreSQL only; synthetic data; no provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { voiceInterviewPermissionHarness } from './helpers/voice-interview-permission-fixture.mjs';
import { syntheticRetellProof } from './helpers/voice-preparation-provider-fixture.mjs';
import { behaviorGuideDefinitions } from '../lib/behavior-guide.ts';
import { canonicalVoiceSourceSnapshot } from '../lib/voice/plan-persistence-contract.ts';
import { trustedVoiceTemplateDigest } from '../lib/voice/template-registry.ts';
import { reconstructTrustedVoiceSource } from '../lib/voice/trusted-source-verifier.ts';
import { prepareOfflineVoiceDraft } from '../lib/voice/offline-preparation.ts';
import {
  dispatchRetellCall, RetellDispatchError, retellDispatchRecruiterMessage, dispatchClaimErrorCode,
} from '../lib/voice/retell-dispatch-worker.ts';
import {
  VOICE_CALL_RESERVE_GROSZE, VOICE_COST_CAP_RECRUITER_MESSAGE, VOICE_MONTHLY_COST_CAP_GROSZE, isVoiceCostCapRefusal,
} from '../lib/voice/cost-cap.ts';

const migration = new URL('../supabase/migrations/20261121120000_r7_voice_cost_cap.sql', import.meta.url);
const rollback = new URL('../supabase/rollbacks/20261121120000_r7_voice_cost_cap_down.sql', import.meta.url);
const r20Guard = 'e5404e835bbead0b47dbc9a686d8d8f6302e9f3ddc3498f4e6b7d57009b62a7f';
const r7Guard = '3e2933f68d3bac861ea364d52099b6b3d18a956c7c1c73eae2b3714032441f34';
const r7Added = "  -- R7 (20261121120000): the monthly voice cost cap reserves this call's upper bound\n" +
  "  -- or refuses the new claim (PT429 VOICE_COST_CAP_REACHED) before it exists.\n" +
  '  perform voice_budget.reserve_dispatch(new.company_id,new.preparation_id);\n';
const r7Release = " -- R7 (20261121120000): a refused or abandoned claim releases its reservation on the\n" +
  " -- cost ledger itself, so a later erasure of this claim cannot bring it back.\n" +
  " if new.state in ('rejected','abandoned') and new.state is distinct from old.state then\n" +
  '  perform voice_budget.release_dispatch(new.company_id,new.preparation_id);\n' +
  ' end if;\n';
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const sha = value => createHash('sha256').update(value).digest('hex');
const message = (c, m) => e => e.code === c && e.message === m;
const capped = message('PT429', 'VOICE_COST_CAP_REACHED');
const apiKey = 'key_synthetic_never_real_0123456789';

test('R7: the monthly voice cost cap refuses new dispatches in the database and records one owner alert', async t => {
  const env = await activeBoot(t, { fullChain: true });
  const { db, h } = env;
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const asServer = async (actor, client = db) => {
    await client.query('reset role');
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
  };
  let policySeeded = false;
  let nextOwner = users.owner;
  const credited = { ...h, seed: async (owner = nextOwner, ...rest) => {
    const f = await h.seed(owner, ...rest);
    await h.asAdmin();
    if (!policySeeded) { await seedSyntheticPolicy(db); policySeeded = true; }
    await db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-voice-${randomUUID()}`]);
    await h.asUser(owner);
    return f;
  } };
  const permission = voiceInterviewPermissionHarness(credited);
  // Shortlisted candidate with contact evidence, interview permission and a released plan (R18/R19).
  const ready = async tenant => {
    let f = await permission.ready({ tenant, requiredBehaviors: [...behaviors], ratings: [...ratings] });
    const permissionReceiptId = await permission.ingest(f, permission.receipt(f));
    f = { ...f, permissionReceiptId };
    await asServer(f.owner);
    const source = await reconstructTrustedVoiceSource(db, { companyId: f.companyId, applicationId: f.application.id,
      analysisId: f.analysis_id, reviewId: f.reviewId, shortlistEntryId: f.shortlistId });
    const planId = await one(`insert into public.voice_plan_versions
      (company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,shortlist_entry_id,
       plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,template_version,created_by,
       retention_policy_version,retention_deadline)
      values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,'skillcheck-voice-plan-v1',$12,'synthetic-v1',
       clock_timestamp()+interval '30 days') returning id as v`,
    [f.companyId, f.recruitment.id, f.application.id, f.position.id, f.analysis_id, f.reviewId, f.shortlistId,
      source.sourceHash, source.planContractHash,
      JSON.stringify(canonicalVoiceSourceSnapshot(source.sourceBinding, source.planSourceFingerprint)), JSON.stringify(source), f.owner]);
    const reviewId = await one('select private.sc012b_review_plan($1,0,$2,$3,null,$4) as v', [planId, source.sourceHash, 'approved', randomUUID()]);
    const releaseId = await one('select private.sc012b_release_plan($1,$2,$3,null,null,$4) as v', [planId, reviewId, source.sourceHash, randomUUID()]);
    const pointerVersion = await one(`select pointer_version as v from private.voice_plan_current_releases
      where company_id=$1 and application_id=$2`, [f.companyId, f.application.id]);
    return { ...f, planId, releaseId, pointerVersion: Number(pointerVersion) };
  };
  const company = async () => {
    if (policySeeded) {
      nextOwner = randomUUID();
      await h.asAdmin();
      await db.query('insert into auth.users(id) values($1)', [nextOwner]);
    }
    return ready();
  };
  const grant = async (f, interviews) => {
    await h.asAdmin();
    return one(`select entitlement_id as v from private.sc19_voice_grant_interviews($1,'operator_manual',$2,$3,
      clock_timestamp()+interval '30 days',$4,clock_timestamp()+interval '30 days')`,
    [f.companyId, interviews, randomUUID(), randomUUID()]);
  };

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true) on conflict do nothing',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const proof = await syntheticRetellProof();
  const vaultKey = randomBytes(32);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('External network forbidden'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  // The trusted server preparation that holds a pool unit (R19/R6-2).
  const order = async (f, entitlementId) => {
    await asServer(f.owner);
    return prepareOfflineVoiceDraft(db, { companyId: f.companyId }, {
      communicationId: f.communicationId, approvalId: f.approvalId, permissionReceiptId: f.permissionReceiptId,
      planId: f.planId, releaseId: f.releaseId, pointerVersion: f.pointerVersion,
      entitlementId, requestKey: randomUUID(),
    }, { retell: proof.retell, verifiedAgent: proof.verifiedAgent, contactVault: structuredClone(f.contactConfig),
      idempotencyVault: { keyId: 'synthetic-offline-provider-key-v1', encryptionKey: vaultKey } });
  };
  // The R20 once-only dispatch claim, as the dispatch worker writes it.
  const claim = async (f, operationId) => {
    await h.asAdmin();
    const keyDigest = await one('select provider_key_digest as v from private.sc010c_voice_preparations where id=$1', [operationId]);
    await asServer(f.owner);
    return db.query(`insert into private.sc011b_voice_dispatches(company_id,preparation_id,provider_key_digest,payload_sha256)
      values($1,$2,$3,$4) on conflict do nothing`, [f.companyId, operationId, keyDigest, sha('synthetic-payload')]);
  };
  const setCap = async (cap, reserve) => {
    await h.asAdmin();
    await db.query('update voice_budget.settings set monthly_cap_grosze=$1,call_reserve_grosze=$2 where singleton', [cap, reserve]);
  };
  const status = async at => { await h.asAdmin(); return (await db.query('select * from voice_budget.month_status($1)', [at])).rows[0]; };
  const alerts = async () => { await h.asAdmin(); return (await db.query('select * from voice_budget.list_owner_alerts(120)')).rows; };
  const reserveAt = (companyId, preparationId, at, client = db) =>
    client.query('select voice_budget.reserve_at($1,$2,$3) as v', [companyId, preparationId, at]).then(r => r.rows[0].v);
  const guardHash = () => one(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as v from pg_proc
    where oid='private.sc011b_dispatch_guard()'::regprocedure`);
  const signature = await one('select private.erasure_schema_signature() as v');

  await t.test('installed closed: cap 50 zł, R20 guard plus two statements, erasure signature unchanged, no API role access', async () => {
    await h.asAdmin();
    assert.equal(VOICE_MONTHLY_COST_CAP_GROSZE, 5000);
    assert.equal(VOICE_CALL_RESERVE_GROSZE, 1500);
    assert.deepEqual((await db.query('select monthly_cap_grosze,call_reserve_grosze from voice_budget.settings')).rows,
      [{ monthly_cap_grosze: 5000, call_reserve_grosze: 1500 }]);
    // 600 s at the highest published all-in Retell rate (USD 0.31/min) at 4.50 zł/USD = 13.95 zł <= 15 zł.
    assert.ok(Math.ceil(10 * 0.31 * 4.5 * 100) <= VOICE_CALL_RESERVE_GROSZE);
    assert.equal(await guardHash(), r7Guard);
    const body = await one(`select prosrc as v from pg_proc where oid='private.sc011b_dispatch_guard()'::regprocedure`);
    assert.equal(body.split(r7Added).length, 2, 'exactly one added reservation statement');
    assert.equal(body.split(r7Release).length, 2, 'exactly one added release statement');
    assert.equal(sha(body.replace(r7Added, '').replace(r7Release, '')), r20Guard, 'otherwise the R20 body byte for byte');
    assert.equal(await one(`select count(*)::int as v from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private') and c.relname like '%budget%'`), 0, 'nothing new in public/private');
    const fns = (await db.query(`select p.oid::regprocedure::text sig,p.prosecdef,p.proconfig,p.proacl::text acl,
      p.prorettype='trigger'::regtype trig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='voice_budget'`)).rows;
    assert.equal(fns.length, 13);
    for (const f of fns) {
      assert.deepEqual(f.proconfig, ['search_path=""'], f.sig);
      assert.ok(f.trig || f.prosecdef, `${f.sig} is security definer`);
      assert.ok(f.acl === null || f.acl === '{postgres=X/postgres}', `${f.sig} owner only: ${f.acl}`);
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one("select has_schema_privilege($1,'voice_budget','usage') as v", [role]), false, role);
      for (const table of ['settings', 'charges', 'owner_alerts'])
        assert.equal(await one('select has_table_privilege($1,$2,$3) as v', [role, `voice_budget.${table}`, 'select,insert,update,delete']), false);
      assert.equal(await one("select has_function_privilege($1,'private.sc011b_dispatch_guard()','execute') as v", [role]), false);
    }
    await h.asUser(users.owner);
    for (const sql of ['select * from voice_budget.owner_alerts', 'select voice_budget.month_status()',
      `select voice_budget.reserve_at('${randomUUID()}','${randomUUID()}',now())`, 'update voice_budget.settings set monthly_cap_grosze=999999'])
      await assert.rejects(db.query(sql), e => e.code === '42501', sql);
    await h.asAdmin();
  });

  await t.test('rollback on an empty ledger restores the R20 guard and removes the schema; the migration then reinstalls once', async () => {
    await h.asAdmin();
    await db.query(await readFile(rollback, 'utf8'));
    assert.equal(await guardHash(), r20Guard);
    assert.equal(await one("select to_regnamespace('voice_budget') is null as v"), true);
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    await db.query(await readFile(rollback, 'utf8'));
    assert.equal(await guardHash(), r20Guard, 'a second rollback changes nothing');
    await db.query(await readFile(migration, 'utf8'));
    assert.equal(await guardHash(), r7Guard);
    await assert.rejects(db.query(await readFile(migration, 'utf8')), message('55000', 'voice_cost_cap_already_installed'));
    await db.query('rollback');
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
  });

  const a = await company();
  const b = await company();
  assert.notEqual(a.companyId, b.companyId);
  const poolA = await grant(a, 5);
  const [a1, a2, a3, a4] = [await ready(a), await ready(a), await ready(a), await ready(a)];
  const o1 = await order(a1, poolA), o2 = await order(a2, poolA), o3 = await order(a3, poolA), o4 = await order(a4, poolA);
  const thisMonth = (await status(new Date())).month;
  const charges = async () => { await h.asAdmin(); return one('select count(*)::int as v from voice_budget.charges'); };

  await t.test('under the cap a call is dispatched; at the cap the next new claim is refused before it exists', async () => {
    await setCap(1000, 500); // room for two calls at the conservative estimate
    await claim(a1, o1.operationId);
    assert.equal(await charges(), 1);
    assert.deepEqual(await alerts(), [], 'room for one more call: no alert');
    await claim(a1, o1.operationId); // replay of an existing claim reserves nothing again
    assert.equal(await charges(), 1);
    await claim(a2, o2.operationId);
    let s = await status(new Date());
    assert.equal(Number(s.month_to_date_grosze), 1000);
    assert.equal(Number(s.in_flight_grosze), 1000);
    assert.equal(Number(s.remaining_grosze), 0);
    assert.equal(s.new_calls_blocked, true);
    const recorded = await alerts();
    assert.equal(recorded.length, 1, 'the cap is reached: one owner alert');
    assert.equal(recorded[0].cause, 'dispatch');
    assert.equal(Number(recorded[0].month_to_date_grosze), 1000);

    // The real worker: the database refuses, nothing is sent, the recruiter gets a plain message.
    await asServer(a3.owner);
    let posts = 0;
    const http = async () => { posts++; throw new Error('must not be called'); };
    let caught;
    await assert.rejects(dispatchRetellCall(db, { companyId: a.companyId, operationId: o3.operationId, draft: o3.draft, apiKey },
      http, o3.draft.verifiedAtMs + 1), e => { caught = e; return e instanceof RetellDispatchError && e.code === 'VOICE_DISPATCH_COST_CAP'; });
    assert.equal(posts, 0);
    assert.equal(retellDispatchRecruiterMessage(caught), VOICE_COST_CAP_RECRUITER_MESSAGE);
    assert.match(VOICE_COST_CAP_RECRUITER_MESSAGE, /limit rozmów głosowych/);
    // A direct claim insert gets the same database refusal.
    let raw;
    await assert.rejects(claim(a3, o3.operationId), e => { raw = e; return capped(e); });
    assert.equal(isVoiceCostCapRefusal(raw), true);
    assert.equal(dispatchClaimErrorCode(raw), 'VOICE_DISPATCH_COST_CAP');
    assert.equal(dispatchClaimErrorCode({ code: '42501' }), 'VOICE_DISPATCH_REJECTED');
    assert.equal(dispatchClaimErrorCode({ code: 'PT409', message: 'VOICE_DISPATCH_UNAVAILABLE' }), 'VOICE_DISPATCH_UNAVAILABLE');
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_dispatches where preparation_id=$1', [o3.operationId]), 0);
    assert.equal(await one('select state as v from private.sc010c_voice_preparations where id=$1', [o3.operationId]), 'prepared_offline');
    assert.equal(await charges(), 2);
  });

  await t.test('a refused provider request frees its estimate; recorded cost replaces it; still one alert this month', async () => {
    await asServer(a1.owner);
    await db.query("update private.sc011b_voice_dispatches set state='rejected',rejection='invalid_request' where preparation_id=$1", [o1.operationId]);
    assert.equal(Number((await status(new Date())).month_to_date_grosze), 500);
    await h.asAdmin();
    assert.equal(await one('select released_at is not null as v from voice_budget.charges where preparation_id=$1', [o1.operationId]), true,
      'the release is written on the charge itself');
    await claim(a3, o3.operationId);
    assert.equal(Number((await status(new Date())).month_to_date_grosze), 1000);
    await assert.rejects(claim(a4, o4.operationId), capped);
    // The provider's real cost of call 2 is lower than the estimate: room for call 4.
    await h.asAdmin();
    assert.equal(await one('select voice_budget.record_call_cost($1,$2,300) as v', [a.companyId, o2.operationId]), 'recorded');
    assert.equal(await one('select voice_budget.record_call_cost($1,$2,300) as v', [a.companyId, o2.operationId]), 'replayed');
    await assert.rejects(db.query('select voice_budget.record_call_cost($1,$2,301)', [a.companyId, o2.operationId]),
      message('PT409', 'VOICE_COST_ALREADY_RECORDED'));
    for (const bad of [-1, 1000001, null])
      await assert.rejects(db.query('select voice_budget.record_call_cost($1,$2,$3)', [a.companyId, o2.operationId, bad]),
        message('PT422', 'VOICE_COST_CAP_INVALID'));
    const s = await status(new Date());
    assert.equal(Number(s.recorded_cost_grosze), 300);
    assert.equal(Number(s.month_to_date_grosze), 800, '0 (refused) + 300 (recorded) + 500 (estimate)');
    await assert.rejects(claim(a4, o4.operationId), capped, '800 + 500 would exceed 1000');
    await h.asAdmin();
    await db.query('select voice_budget.record_call_cost($1,$2,100)', [a.companyId, o3.operationId]);
    await claim(a4, o4.operationId);
    assert.equal(Number((await status(new Date())).month_to_date_grosze), 900);
    const recorded = await alerts();
    assert.equal(recorded.length, 1, 'one alert per month, never a second');
    assert.equal(String(recorded[0].month), String(thisMonth));
  });

  await t.test('a recorded provider cost that leaves no room records the month alert (cause call_cost)', async () => {
    await setCap(1000, 500);
    await h.asAdmin();
    const p = randomUUID();
    assert.equal(await reserveAt(b.companyId, p, '2030-01-15T10:00:00Z'), 'reserved');
    assert.equal(await one("select count(*)::int as v from voice_budget.owner_alerts where month='2030-01-01'"), 0);
    // A cost within the reservation only lowers the sum, so this needs a cap lowered by a later migration.
    await setCap(900, 500);
    await db.query('select voice_budget.record_call_cost($1,$2,450)', [b.companyId, p]);
    const row = (await db.query("select cause,month_to_date_grosze from voice_budget.owner_alerts where month='2030-01-01'")).rows;
    assert.deepEqual(row.map(r => [r.cause, Number(r.month_to_date_grosze)]), [['call_cost', 450]]);
    await assert.rejects(reserveAt(b.companyId, randomUUID(), '2030-01-20T10:00:00Z'), capped);
  });

  await t.test('the month boundary is the Polish calendar month and resets the room', async () => {
    await setCap(1000, 500);
    await h.asAdmin();
    await reserveAt(a.companyId, randomUUID(), '2030-04-02T08:00:00Z');
    await reserveAt(a.companyId, randomUUID(), '2030-04-30T21:59:59Z'); // 23:59:59 in Warsaw (CEST)
    await assert.rejects(reserveAt(a.companyId, randomUUID(), '2030-04-30T21:59:59Z'), capped);
    // 22:00 UTC on 30 April is already 1 May in Warsaw: a new month with full room.
    const first = randomUUID();
    assert.equal(await reserveAt(a.companyId, first, '2030-04-30T22:00:00Z'), 'reserved');
    assert.equal(await one('select month::text as v from voice_budget.charges where preparation_id=$1', [first]), '2030-05-01');
    assert.equal(await reserveAt(a.companyId, randomUUID(), '2030-05-31T12:00:00Z'), 'reserved');
    await assert.rejects(reserveAt(a.companyId, randomUUID(), '2030-05-31T12:00:00Z'), capped);
    assert.deepEqual((await db.query(`select month::text m from voice_budget.owner_alerts
      where month between '2030-04-01' and '2030-05-31' order by month`)).rows.map(r => r.m), ['2030-04-01', '2030-05-01'],
    'one alert for April and one for May');
  });

  await t.test('parallel dispatches cannot both take the last room', async () => {
    await setCap(1000, 500);
    await h.asAdmin();
    await reserveAt(a.companyId, randomUUID(), '2030-06-01T08:00:00Z');
    // Deterministic overlap: the first holds the settings lock, the second waits and then sees the first.
    const [c1, c2] = [await env.connect(), await env.connect()];
    await c1.query('begin');
    await c2.query('begin');
    assert.equal(await reserveAt(a.companyId, randomUUID(), '2030-06-10T08:00:00Z', c1), 'reserved');
    const waiting = reserveAt(b.companyId, randomUUID(), '2030-06-10T08:00:01Z', c2);
    await new Promise(resolve => setTimeout(resolve, 200));
    await c1.query('commit');
    await assert.rejects(waiting, capped);
    await c2.query('rollback');
    // Free-for-all: twelve parallel transactions for one remaining slot.
    await reserveAt(a.companyId, randomUUID(), '2030-07-01T08:00:00Z');
    const pool = env.pool();
    const results = await Promise.allSettled(Array.from({ length: 12 }, async (_, i) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const v = await reserveAt(i % 2 ? a.companyId : b.companyId, randomUUID(), '2030-07-15T08:00:00Z', c);
        await c.query('commit');
        return v;
      } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    }));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.ok(capped(r.reason), String(r.reason));
    assert.equal(Number((await status('2030-07-20T08:00:00Z')).month_to_date_grosze), 1000);
    assert.equal(await one("select count(*)::int as v from voice_budget.owner_alerts where month='2030-07-01'"), 1);
  });

  await t.test('the default reservation is a per-call upper bound: at most three calls a month fit under 50 zł', async () => {
    await setCap(5000, 1500);
    await h.asAdmin();
    for (let i = 0; i < 3; i++) assert.equal(await reserveAt(a.companyId, randomUUID(), '2030-09-10T08:00:00Z'), 'reserved');
    await assert.rejects(reserveAt(b.companyId, randomUUID(), '2030-09-10T08:00:00Z'), capped, '4500 + 1500 > 5000');
    const s = await status('2030-09-20T08:00:00Z');
    assert.equal(Number(s.month_to_date_grosze), 4500, 'with no cost ever recorded the real spend is at most 3 × 15 zł');
    assert.equal(s.new_calls_blocked, true);
    assert.equal(s.reserve_exceeded, false);
    assert.equal(await one("select cause as v from voice_budget.owner_alerts where month='2030-09-01'"), 'dispatch');
  });

  await t.test('a recorded cost above its reservation fails the month closed and records the alert as reserve_exceeded', async () => {
    await setCap(5000, 500);
    await h.asAdmin();
    const p = randomUUID();
    assert.equal(await reserveAt(a.companyId, p, '2030-10-05T08:00:00Z'), 'reserved');
    let s = await status('2030-10-06T08:00:00Z');
    assert.equal(s.new_calls_blocked, false);
    assert.equal(await one('select voice_budget.record_call_cost($1,$2,600) as v', [a.companyId, p]), 'recorded');
    s = await status('2030-10-06T08:00:00Z');
    assert.equal(Number(s.month_to_date_grosze), 600, 'the real cost counts, not the lower reservation');
    assert.equal(s.reserve_exceeded, true);
    assert.equal(s.new_calls_blocked, true, 'room is left under the cap, but the upper bound proved wrong');
    await assert.rejects(reserveAt(b.companyId, randomUUID(), '2030-10-07T08:00:00Z'), capped);
    const row = (await db.query("select cause,month_to_date_grosze from voice_budget.owner_alerts where month='2030-10-01'")).rows;
    assert.deepEqual(row.map(r => [r.cause, Number(r.month_to_date_grosze)]), [['reserve_exceeded', 600]]);
    // The next month starts with full room again.
    assert.equal(await reserveAt(b.companyId, randomUUID(), '2030-11-02T08:00:00Z'), 'reserved');
  });

  await t.test('SC-010 erasure of dispatch claims leaves the month sum unchanged: releases live on the ledger', async () => {
    await setCap(100000, 500);
    const pool2 = await grant(a, 5);
    const [a6, a7, a8] = [await ready(a), await ready(a), await ready(a)];
    const o6 = await order(a6, pool2), o7 = await order(a7, pool2), o8 = await order(a8, pool2);
    const mtd = async () => Number((await status(new Date())).month_to_date_grosze);
    const before = await mtd();
    await claim(a6, o6.operationId);
    await claim(a7, o7.operationId);
    await claim(a8, o8.operationId);
    assert.equal(await mtd(), before + 1500);
    // Provider refused call 6; call 7 went unknown and the operator confirmed it never left.
    await asServer(a6.owner);
    await db.query("update private.sc011b_voice_dispatches set state='rejected',rejection='invalid_request' where preparation_id=$1", [o6.operationId]);
    await db.query("update private.sc011b_voice_dispatches set state='unknown' where preparation_id=$1", [o7.operationId]);
    await db.query('begin');
    await db.query("select set_config('skillcheck.sc011b_resolution','on',true)");
    await db.query("update private.sc011b_voice_dispatches set state='abandoned' where preparation_id=$1", [o7.operationId]);
    await db.query('commit');
    assert.equal(await mtd(), before + 500, 'only call 8 (in flight) still counts');
    await h.asAdmin();
    assert.deepEqual((await db.query(`select preparation_id::text p,released_at is not null r from voice_budget.charges
      where preparation_id = any($1::uuid[]) order by released_at nulls last`, [[o6.operationId, o7.operationId, o8.operationId]])).rows
      .map(r => r.r), [true, true, false]);
    // A release is written once and cannot be undone or combined with a cost.
    await assert.rejects(db.query('update voice_budget.charges set released_at=null where preparation_id=$1', [o6.operationId]),
      message('42501', 'VOICE_COST_CHARGE_IMMUTABLE'));
    await assert.rejects(db.query('update voice_budget.charges set released_at=now() where preparation_id=$1', [o6.operationId]),
      message('42501', 'VOICE_COST_CHARGE_IMMUTABLE'));
    await assert.rejects(db.query('update voice_budget.charges set released_at=now(),cost_grosze=1 where preparation_id=$1', [o8.operationId]),
      message('42501', 'VOICE_COST_CHARGE_IMMUTABLE'));
    assert.equal(await one('select voice_budget.release_dispatch($1,$2) as v', [a.companyId, o6.operationId]), 'unchanged');
    // The SC-010 purge deletes the claim rows (here: the rows disappear without the
    // purge owner's bookkeeping); the cost ledger is not touched by erasure.
    await db.query("set session_replication_role='replica'");
    try {
      await db.query('delete from private.sc011b_voice_dispatches where preparation_id = any($1::uuid[])',
        [[o6.operationId, o7.operationId, o8.operationId]]);
    } finally { await db.query("set session_replication_role='origin'"); }
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_dispatches where preparation_id = any($1::uuid[])',
      [[o6.operationId, o7.operationId, o8.operationId]]), 0);
    assert.equal(await mtd(), before + 500, 'released stay 0, the unreleased call keeps counting');
  });

  await t.test('tenant isolation: another company can neither take over nor price a charge, and learns nothing', async () => {
    await h.asAdmin();
    const before = await one('select cost_grosze as v from voice_budget.charges where preparation_id=$1', [o3.operationId]);
    await assert.rejects(db.query('select voice_budget.record_call_cost($1,$2,1)', [b.companyId, o3.operationId]),
      e => message('PT404', 'VOICE_COST_CHARGE_UNKNOWN')(e) && !e.message.includes(a.companyId));
    await assert.rejects(db.query('select voice_budget.record_call_cost($1,$2,1)', [b.companyId, randomUUID()]),
      message('PT404', 'VOICE_COST_CHARGE_UNKNOWN'));
    await assert.rejects(reserveAt(b.companyId, o3.operationId, new Date().toISOString()),
      e => message('PT409', 'VOICE_COST_CAP_CONFLICT')(e) && !e.message.includes(a.companyId));
    assert.equal(await one('select cost_grosze as v from voice_budget.charges where preparation_id=$1', [o3.operationId]), before);
    assert.equal(await one('select company_id::text as v from voice_budget.charges where preparation_id=$1', [o3.operationId]), a.companyId);
    // The company's owner (an API role) cannot read the ledger, the alerts or the month status at all.
    await h.asUser(b.owner);
    await assert.rejects(db.query('select company_id from voice_budget.charges'), e => e.code === '42501');
    await h.asAdmin();
  });

  await t.test('settings, charges and alerts cannot be deleted or rewritten', async () => {
    await h.asAdmin();
    await assert.rejects(db.query('delete from voice_budget.settings'), message('42501', 'VOICE_COST_SETTINGS_IMMUTABLE'));
    await assert.rejects(db.query('truncate voice_budget.charges'), message('42501', 'VOICE_COST_CHARGE_IMMUTABLE'));
    await assert.rejects(db.query('delete from voice_budget.charges where preparation_id=$1', [o2.operationId]),
      message('42501', 'VOICE_COST_CHARGE_IMMUTABLE'));
    await assert.rejects(db.query('update voice_budget.charges set reserved_grosze=1 where preparation_id=$1', [o3.operationId]),
      message('42501', 'VOICE_COST_CHARGE_IMMUTABLE'));
    await assert.rejects(db.query('update voice_budget.owner_alerts set cap_grosze=1'), message('42501', 'VOICE_COST_ALERT_IMMUTABLE'));
    await assert.rejects(db.query('update voice_budget.settings set monthly_cap_grosze=-1'), e => e.code === '23514');
  });

  await t.test('rollback with records keeps them, switches the cap off and restores the R20 guard', async () => {
    await h.asAdmin();
    await setCap(0, 500);
    const a5 = await ready(a);
    const o5 = await order(a5, poolA);
    await assert.rejects(claim(a5, o5.operationId), capped);
    await h.asAdmin();
    const kept = await charges();
    await db.query(await readFile(rollback, 'utf8'));
    assert.equal(await guardHash(), r20Guard);
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await charges(), kept, 'recorded costs are not deleted by a rollback');
    assert.equal(await one("select count(*)::int as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='voice_budget' and p.prorettype<>'trigger'::regtype"), 0);
    await claim(a5, o5.operationId);
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_dispatches where preparation_id=$1', [o5.operationId]), 1);
    await assert.rejects(db.query(await readFile(migration, 'utf8')), message('55000', 'voice_cost_cap_already_installed'));
    await db.query('rollback');
  });

  assert.equal(networkCalls, 0, 'no network call was made');
});
