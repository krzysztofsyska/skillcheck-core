// R6-2 (#538): the voice interview limit is checked when an interview is ordered,
// without packages. Runs the real trusted-server preparation module
// (lib/voice/offline-preparation.ts) and the R20 dispatch claim on the full
// checked-in migration chain (R19 pool, operator grant, R20 dispatch, R21
// settlement, R22 resolution and later steps):
//  - no pool: the order is refused with a recruiter-readable code, nothing is reserved, no claim exists;
//  - pool 1: one order, a second one refused until the first is settled or released;
//  - parallel orders never hold more units than the pool has;
//  - an interview that did not take place (no answer, refused request, cancelled draft) gives the unit back;
//  - another company's pool is never used and its data never appears in the error;
//  - a pool that comes from a package (PRESELEKCJA = 10, owner 20.11.2026) goes
//    through the same order / settle / refund path: ten interviews, the eleventh
//    refused, a call that did not take place gives its unit back.
// Native disposable PostgreSQL only; synthetic data; no provider, no network, no API grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { voiceInterviewPermissionHarness } from './helpers/voice-interview-permission-fixture.mjs';
import { syntheticRetellProof } from './helpers/voice-preparation-provider-fixture.mjs';
import { behaviorGuideDefinitions } from '../lib/behavior-guide.ts';
import { canonicalVoiceSourceSnapshot } from '../lib/voice/plan-persistence-contract.ts';
import { trustedVoiceTemplateDigest } from '../lib/voice/template-registry.ts';
import { reconstructTrustedVoiceSource } from '../lib/voice/trusted-source-verifier.ts';
import {
  prepareOfflineVoiceDraft, cancelOfflineVoicePreparation, OfflineVoicePreparationError,
  VOICE_PREPARATION_RECRUITER_MESSAGES, voicePreparationRecruiterMessage,
} from '../lib/voice/offline-preparation.ts';
import { ensurePackageVoicePool } from '../lib/voice/package-pools.ts';

const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const digest = value => createHash('sha256').update(value).digest('hex');
const agentId = 'agent_' + 'b'.repeat(24);
const callId = () => 'call_' + randomBytes(12).toString('hex');
const code = (...codes) => e => codes.includes(e.code);
const message = (c, m) => e => e.code === c && e.message === m;
const refused = (expected, ...forbidden) => error => {
  assert.ok(error instanceof OfflineVoicePreparationError, String(error));
  assert.equal(error.code, 'VOICE_PREPARATION_' + expected);
  assert.equal(error.message, error.code, 'the error carries only its code');
  for (const value of forbidden) assert.ok(!error.message.includes(String(value)), 'no foreign data in the error');
  return true;
};
function pauseAfter(client, predicate) {
  let reached, release, used = false;
  const entered = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  return { entered, release, client: { query: async (sql, params) => {
    const result = await client.query(sql, params);
    if (!used && predicate(sql)) { used = true; reached(); await resume; }
    return result;
  } } };
}

test('R6-2: ordering a voice interview checks the package-free pool', async t => {
  const env = await activeBoot(t, { fullChain: true });
  const { db, h } = env;
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const asServer = async (actor, client = db) => {
    await client.query('reset role');
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
  };
  const server = async actor => { const client = await env.connect(); await asServer(actor, client); return client; };
  let policySeeded = false;
  // One company per owner: each new synthetic company gets its own synthetic owner.
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
  // The reviewed operator grant (PR #532): trial_single = 1, operator_manual = N.
  const grant = async (f, kind, interviews) => {
    await h.asAdmin();
    return one(`select entitlement_id as v from private.sc19_voice_grant_interviews($1,$2,$3,$4,
      clock_timestamp()+interval '30 days',$5,clock_timestamp()+interval '30 days')`,
    [f.companyId, kind, interviews, kind === 'trial_single' ? null : randomUUID(), randomUUID()]);
  };
  const balance = async f => { await h.asAdmin(); return (await db.query('select * from private.sc19_voice_interview_balance($1)', [f.companyId])).rows[0]; };
  const quota = async id => { await h.asAdmin(); return (await db.query('select total,used,reserved from private.sc19_voice_entitlements where id=$1', [id])).rows[0]; };
  const preparations = async f => { await h.asAdmin(); return one(
    "select count(*)::int as v from private.sc010c_voice_preparations where company_id=$1 and state='prepared_offline'", [f.companyId]); };

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true) on conflict do nothing',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const proof = await syntheticRetellProof();
  const vaultKey = randomBytes(32);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('External network forbidden'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  // One "order" = the trusted server preparation that holds a pool unit.
  const order = async (f, entitlementId, client = db) => {
    if (client === db) await asServer(f.owner);
    return prepareOfflineVoiceDraft(client, { companyId: f.companyId }, {
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
      values($1,$2,$3,$4) on conflict do nothing`, [f.companyId, operationId, keyDigest, digest('synthetic-payload')]);
  };
  const placed = async (f, operationId) => {
    await claim(f, operationId);
    await asServer(f.owner);
    await db.query("update private.sc011b_voice_dispatches set state='accepted' where preparation_id=$1", [operationId]);
    return one(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5) returning id as v`, [f.companyId, operationId, f.candidate.id, agentId, callId()]);
  };
  const finish = async (f, attempt, status, outcome) => {
    await asServer(f.owner);
    await db.query('update private.sc011b_voice_attempts set status=$2,outcome=$3 where id=$1', [attempt, status, outcome]);
  };

  const a = await company();
  const other = await company();
  assert.notEqual(other.companyId, a.companyId, 'two separate companies');
  const otherPool = await grant(other, 'operator_manual', 3);

  await t.test('no pool: the order is refused with a readable code, nothing is reserved and nothing can be dispatched', async () => {
    assert.deepEqual(await balance(a), { granted: 0, used: 0, reserved: 0, available: 0 });
    // Any entitlement id, even another company's real one, is refused the same way.
    for (const entitlementId of [randomUUID(), otherPool])
      await assert.rejects(order(a, entitlementId), refused('QUOTA_EXHAUSTED', otherPool, other.companyId));
    assert.equal(await preparations(a), 0);
    assert.deepEqual(await quota(otherPool), { total: 3, used: 0, reserved: 0 }, 'the other company pool is untouched');
    // Without a held unit there is no preparation, so no dispatch claim can exist.
    await asServer(a.owner);
    await assert.rejects(db.query(`insert into private.sc011b_voice_dispatches(company_id,preparation_id,provider_key_digest,payload_sha256)
      values($1,$2,$3,$4)`, [a.companyId, randomUUID(), digest('k'), digest('p')]), code('PT409'));
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_dispatches where company_id=$1', [a.companyId]), 0);
    assert.equal(voicePreparationRecruiterMessage(new OfflineVoicePreparationError('QUOTA_EXHAUSTED')),
      'Brak wolnych rozmów w puli firmy. Rozmowa nie została zlecona.');
  });

  await t.test('pool 1: one order, a second one refused until the first is settled or released', async () => {
    const pool = await grant(a, 'trial_single', 1);
    assert.equal(await grant(a, 'trial_single', 1), pool, 'the single trial interview is granted once');
    const [c1, c2, c3] = [await ready(a), await ready(a), await ready(a)];
    const first = await order(c1, pool);
    assert.equal(first.state, 'prepared_offline');
    await claim(c1, first.operationId);
    assert.deepEqual(await balance(a), { granted: 1, used: 0, reserved: 1, available: 0 });
    await assert.rejects(order(c2, pool), refused('QUOTA_EXHAUSTED'));
    assert.equal(await preparations(a), 1);
    // Ordered and dispatched: it can no longer be cancelled offline to free the unit.
    await asServer(c1.owner);
    await assert.rejects(cancelOfflineVoicePreparation(db, { companyId: a.companyId }, first.operationId), refused('CONFLICT'));

    // The candidate did not answer: the interview did not take place and the unit comes back.
    await asServer(c1.owner);
    await db.query("update private.sc011b_voice_dispatches set state='accepted' where preparation_id=$1", [first.operationId]);
    const attempt = await one(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5) returning id as v`, [a.companyId, first.operationId, c1.candidate.id, agentId, callId()]);
    await finish(c1, attempt, 'failed', 'no_answer');
    assert.deepEqual(await balance(a), { granted: 1, used: 0, reserved: 0, available: 1 }, 'a call that did not take place uses nothing');

    // Now the second order goes through, and this interview takes place: the unit is used.
    const second = await order(c2, pool);
    const held = await placed(c2, second.operationId);
    await assert.rejects(order(c3, pool), refused('QUOTA_EXHAUSTED'));
    await finish(c2, held, 'completed', 'completed');
    assert.deepEqual(await balance(a), { granted: 1, used: 1, reserved: 0, available: 0 });
    await assert.rejects(order(c3, pool), refused('QUOTA_EXHAUSTED'));
    assert.deepEqual(await quota(pool), { total: 1, used: 1, reserved: 0 });
  });

  await t.test('a refused request and a cancelled draft both return the unit; a revoked pool blocks the dispatch', async () => {
    const b = await company();
    const pool = await grant(b, 'operator_manual', 1);
    const [c1, c2, c3] = [b, await ready(b), await ready(b)];
    // The provider refused the request as invalid: it never left, the unit returns.
    const first = await order(c1, pool);
    await claim(c1, first.operationId);
    await asServer(c1.owner);
    await db.query("update private.sc011b_voice_dispatches set state='rejected',rejection='invalid_request' where preparation_id=$1", [first.operationId]);
    assert.deepEqual(await quota(pool), { total: 1, used: 0, reserved: 0 });
    // A draft cancelled before dispatch returns the unit too.
    const second = await order(c2, pool);
    await assert.rejects(order(c3, pool), refused('QUOTA_EXHAUSTED'));
    await asServer(c2.owner);
    await cancelOfflineVoicePreparation(db, { companyId: b.companyId }, second.operationId);
    assert.deepEqual(await quota(pool), { total: 1, used: 0, reserved: 0 });
    // The operator revokes the pool after an order: the dispatch claim is refused at COMMIT.
    const third = await order(c3, pool);
    await h.asAdmin();
    await db.query('update private.sc19_voice_entitlements set active=false,revoked_at=clock_timestamp() where id=$1', [pool]);
    await assert.rejects(claim(c3, third.operationId), message('PT409', 'VOICE_PREPARATION_UNAVAILABLE'));
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_dispatches where preparation_id=$1', [third.operationId]), 0);
    await asServer(c3.owner);
    await cancelOfflineVoicePreparation(db, { companyId: b.companyId }, third.operationId);
    assert.deepEqual(await quota(pool), { total: 1, used: 0, reserved: 0 });
    assert.deepEqual(await balance(b), { granted: 0, used: 0, reserved: 0, available: 0 });
  });

  await t.test('parallel orders never hold more units than the pool', async () => {
    const tenant = await company();
    const pool = await grant(tenant, 'operator_manual', 1);
    const rival = await ready(tenant);
    // Deterministic overlap: the first order holds its unit uncommitted while the second one runs.
    const [left, right] = [await server(tenant.owner), await server(rival.owner)];
    const gate = pauseAfter(left, sql => sql.startsWith('update private.sc19_voice_entitlements set reserved=reserved+1'));
    const winner = order(tenant, pool, gate.client);
    await gate.entered;
    try { await assert.rejects(order(rival, pool, right), refused('CONFLICT')); }
    finally { gate.release(); }
    assert.equal((await winner).state, 'prepared_offline');
    await assert.rejects(order(rival, pool, right), refused('QUOTA_EXHAUSTED'));
    assert.deepEqual(await quota(pool), { total: 1, used: 0, reserved: 1 });

    // Unsynchronised burst: four orders for a pool of two, each on its own connection.
    const burst = await company();
    const pair = await grant(burst, 'operator_manual', 2);
    const candidates = [burst, await ready(burst), await ready(burst), await ready(burst)];
    const clients = await Promise.all(candidates.map(f => server(f.owner)));
    const results = await Promise.allSettled(candidates.map((f, i) => order(f, pair, clients[i])));
    for (const r of results) if (r.status === 'rejected')
      assert.ok(['VOICE_PREPARATION_QUOTA_EXHAUSTED', 'VOICE_PREPARATION_CONFLICT'].includes(r.reason?.code), String(r.reason));
    const won = results.filter(r => r.status === 'fulfilled').length;
    assert.ok(won >= 1 && won <= 2, `won ${won}`);
    assert.equal((await quota(pair)).reserved, won);
    // Losers retry one by one: the pool fills to exactly two, never more.
    for (const [i, r] of results.entries()) if (r.status === 'rejected') {
      await asServer(candidates[i].owner, clients[i]);
      await order(candidates[i], pair, clients[i]).catch(e => assert.equal(e.code, 'VOICE_PREPARATION_QUOTA_EXHAUSTED'));
    }
    assert.deepEqual(await quota(pair), { total: 2, used: 0, reserved: 2 });
    assert.equal(await preparations(burst), 2);

    // The database guard alone (no module): two sessions reserve the last unit, the waiting one gets PT402.
    const raw = await company();
    const last = await grant(raw, 'operator_manual', 1);
    const [s1, s2] = [await server(raw.owner), await server(raw.owner)];
    await s1.query('begin');
    await s1.query('update private.sc19_voice_entitlements set reserved=reserved+1 where id=$1', [last]);
    const waiting = s2.query('update private.sc19_voice_entitlements set reserved=reserved+1 where id=$1', [last]);
    const blocked = waiting.then(() => 'done', e => e);
    for (let i = 0; i < 100; i++) {
      if (await one("select count(*)::int as v from pg_locks where not granted and locktype='transactionid'") > 0) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await s1.query('commit');
    const outcome = await blocked;
    assert.ok(outcome instanceof Error, 'the second reservation must fail');
    assert.ok(message('PT402', 'voice_entitlement_unavailable')(outcome), `${outcome.code} ${outcome.message}`);
    assert.deepEqual(await quota(last), { total: 1, used: 0, reserved: 1 });
  });

  await t.test('package pool (PRESELEKCJA = 10): last unit, refusal, refund, parallel orders, other company', async () => {
    const tenant = await company(); // every company here has a PRESELEKCJA package (sc19_grant_paid)
    const rivalTenant = await company();
    const next = async () => { await h.asAdmin(); return ensurePackageVoicePool(db, tenant.companyId); };
    const first = await next();
    assert.equal(first.created, 1);
    assert.equal(first.available, 10, 'PRESELEKCJA gives 10 interviews');
    const pool = first.entitlementId;
    assert.deepEqual(await quota(pool), { total: 10, used: 0, reserved: 0 });
    // The other company's own package pool is separate and cannot be used by this company.
    await h.asAdmin();
    const rivalPool = (await ensurePackageVoicePool(db, rivalTenant.companyId)).entitlementId;
    assert.notEqual(rivalPool, pool);
    const extra = await ready(tenant);
    // This company has its own pool, so a foreign pool id is simply unavailable.
    await assert.rejects(order(extra, rivalPool), refused('UNAVAILABLE', rivalPool, rivalTenant.companyId));
    assert.deepEqual(await quota(rivalPool), { total: 10, used: 0, reserved: 0 });

    const candidates = [tenant, extra];
    while (candidates.length < 11) candidates.push(await ready(tenant));
    const orders = [];
    for (const f of candidates.slice(0, 8)) {
      const picked = await next();
      assert.equal(picked.entitlementId, pool);
      orders.push(await order(f, picked.entitlementId));
    }
    // Three orders at once for the last two units: never more than two held.
    const burst = candidates.slice(8, 11);
    const clients = await Promise.all(burst.map(f => server(f.owner)));
    const results = await Promise.allSettled(burst.map((f, i) => order(f, pool, clients[i])));
    for (const r of results) if (r.status === 'rejected')
      assert.ok(['VOICE_PREPARATION_QUOTA_EXHAUSTED', 'VOICE_PREPARATION_CONFLICT'].includes(r.reason?.code), String(r.reason));
    for (const [i, r] of results.entries()) if (r.status === 'rejected') {
      await asServer(burst[i].owner, clients[i]);
      await order(burst[i], pool, clients[i]).then(x => orders.push(x), e => assert.equal(e.code, 'VOICE_PREPARATION_QUOTA_EXHAUSTED'));
    } else orders.push(r.value);
    assert.equal(orders.length, 10, 'exactly ten interviews ordered');
    assert.deepEqual(await quota(pool), { total: 10, used: 0, reserved: 10 });
    // The last unit is taken: the next order is refused and the helper offers no pool.
    const eleventh = await ready(tenant);
    await assert.rejects(order(eleventh, pool), refused('QUOTA_EXHAUSTED'));
    const empty = await next();
    assert.equal(empty.entitlementId, null);
    assert.equal(empty.available, 0);
    assert.equal(empty.created, 0, 'syncing again never refills a used package');

    // Interview 1 takes place (used); interview 2 does not (unit back).
    const byOperation = new Map(orders.map((o, i) => [o.operationId, i]));
    assert.equal(byOperation.size, 10);
    const [done, missed] = [orders[0], orders[1]];
    const held = await placed(tenant, done.operationId);
    await finish(tenant, held, 'completed', 'completed');
    const noShow = await placed(candidates[1], missed.operationId);
    await finish(candidates[1], noShow, 'failed', 'no_answer');
    assert.deepEqual(await quota(pool), { total: 10, used: 1, reserved: 8 });
    const refunded = await next();
    assert.equal(refunded.entitlementId, pool);
    assert.equal(refunded.available, 1);
    assert.equal((await order(eleventh, pool)).state, 'prepared_offline', 'the returned unit can be ordered again');
    await assert.rejects(order(await ready(tenant), pool), refused('QUOTA_EXHAUSTED'));
    assert.deepEqual(await quota(pool), { total: 10, used: 1, reserved: 9 });
    assert.deepEqual(await quota(rivalPool), { total: 10, used: 0, reserved: 0 }, 'the other company is untouched');
  });

  await t.test('every refusal code has plain recruiter text without internal detail', () => {
    assert.deepEqual(Object.keys(VOICE_PREPARATION_RECRUITER_MESSAGES).sort(), ['VOICE_PREPARATION_CONFLICT',
      'VOICE_PREPARATION_QUOTA_EXHAUSTED', 'VOICE_PREPARATION_REJECTED', 'VOICE_PREPARATION_UNAVAILABLE']);
    for (const text of Object.values(VOICE_PREPARATION_RECRUITER_MESSAGES)) {
      assert.match(text, /^[A-ZŻŹĆĄŚĘŁÓŃ]/);
      assert.doesNotMatch(text, /[0-9a-f]{8}-|PT4|sc19|entitlement|VOICE_|select|private\./i);
    }
    assert.equal(voicePreparationRecruiterMessage(new Error('raw database error')),
      VOICE_PREPARATION_RECRUITER_MESSAGES.VOICE_PREPARATION_REJECTED, 'an unknown error never shows its text');
    assert.equal(networkCalls, 0, 'no provider is called');
  });
});
