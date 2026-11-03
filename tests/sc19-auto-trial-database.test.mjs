import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertCurrentInventory, bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';
import { signTrialAuto, trialAutoClaimPayload } from '../lib/sc19-trial-auto.ts';

// SC-FREE-AUTO-001 / SC-CONSENT-001 on the complete checked-in migration chain,
// real PostgreSQL. The HMAC is produced by the same application code the server
// action uses, so the test proves the two sides agree.
const operator = users.outsider;
const SECRET = 'a-32-byte-or-longer-test-secret!!';

function nip(prefix) {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = [...prefix].reduce((acc, digit, i) => acc + Number(digit) * weights[i], 0) % 11;
  assert.notEqual(sum, 10, `${prefix} has no valid NIP checksum`);
  return `${prefix}${sum}`;
}
const nipA = nip('526025099'), nipB = nip('951000001');
const code = expected => error => error.code === expected;
const call = (db, sql, params) => db.query(sql, params).then(r => r.rows);

async function ready(t, { enabled = true, secret = SECRET } = {}) {
  const env = await bootMigrationDatabase(t);
  const h = await setupRankingDatabase(env.db, { throughMigration: null });
  const { db } = env;
  await h.asAdmin();
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);
  const a = await h.seed(users.owner), b = await h.seed(users.otherOwner);
  await h.asAdmin();
  // FREE must have a policy, exactly as in production.
  await db.query("insert into private.sc19_package_policy(plan,credits) values('FREE',5)");
  await db.query('update private.sc19_trial_auto_settings set request_secret=$1, auto_free_enabled=$2 where singleton',
    [secret, enabled]);
  return { db, h, a, b };
}

/** Calls the RPC the way lib/sc19-trial-auto-flow.ts does. */
function autoClaim(db, companyId, nipValue, mf = {}) {
  const requestId = randomUUID(), issuedAtMs = Date.now();
  const evidence = { mfRequestId: 'req-synthetic-1', mfStatus: 'Czynny', mfName: 'FIRMA TESTOWA SP Z OO', ...mf };
  const signature = signTrialAuto('auto_claim', requestId, issuedAtMs, trialAutoClaimPayload({
    requestId, issuedAtMs, companyId, nip: nipValue, ...evidence,
  }), SECRET);
  return db.query(`select * from public.sc19_auto_claim_trial($1,$2,$3,$4,$5,$6,$7,$8)`,
    [companyId, nipValue, evidence.mfRequestId, evidence.mfStatus, evidence.mfName, requestId, issuedAtMs, signature])
    .then(r => r.rows[0]);
}

test('a confirmed ACTIVE taxpayer gets FREE without any operator action', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  // Without automation the reviewed path refuses: no verified company.
  await assert.rejects(db.query('select public.sc19_claim_trial($1,$2)', [a.companyId, nipA]), code('42501'));

  const result = await autoClaim(db, a.companyId, nipA);
  assert.deepEqual(result, { outcome: 'granted', available: 5, reason: null });
  assert.equal((await call(db, 'select * from public.sc19_get_balance($1)', [a.companyId]))[0].available, 5);

  await h.asAdmin();
  // The approval records the registry as its source, never an operator id.
  const approval = (await call(db, 'select nip,proof_reference from private.sc19_trial_approvals where company_id=$1', [a.companyId]))[0];
  assert.equal(approval.nip, nipA);
  assert.match(approval.proof_reference, /^mf-biala-lista:req-synthetic-1:Czynny$/);
  assert.doesNotMatch(approval.proof_reference, /operator/, 'an automatic grant does not pose as an operator decision');
  // The audit row says where the decision came from and what the registry said.
  const audit = (await call(db, 'select * from private.sc19_trial_auto_checks where company_id=$1', [a.companyId]))[0];
  assert.equal(audit.source, 'mf_whitelist');
  assert.equal(audit.outcome, 'granted');
  assert.equal(audit.mf_status, 'Czynny');
  assert.equal(audit.mf_request_id, 'req-synthetic-1');
  assert.equal(audit.mf_name, 'FIRMA TESTOWA SP Z OO');
  assert.equal(audit.granted_credits, 5);
  // The reviewed journal entry still exists; nothing was granted around it.
  const journal = (await call(db, "select reason,delta,reference from private.sc19_credit_journal where company_id=$1", [a.companyId]));
  assert.deepEqual(journal, [{ reason: 'trial', delta: 5, reference: `trial:${nipA}` }]);
  // The audit trail is append-only.
  await assert.rejects(db.query('update private.sc19_trial_auto_checks set outcome=$1', ['refused']), /Immutable/i);
  await assert.rejects(db.query('delete from private.sc19_trial_auto_checks'), /Immutable/i);
});

test('a NIP the register does not confirm as Czynny grants nothing', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  for (const mf of [
    { mfStatus: 'Zwolniony' },          // exists, but not an active taxpayer
    { mfStatus: '' },                   // no status
    { mfRequestId: '' },                // no registry request id
    { mfName: '' },                     // no company name
  ]) {
    const result = await autoClaim(db, a.companyId, nipA, mf);
    assert.equal(result.outcome, 'refused', JSON.stringify(mf));
    assert.equal(result.available, null);
  }
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0, 'no balance exists');
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_approvals'))[0].n, 0, 'no approval exists');
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_credit_journal'))[0].n, 0, 'nothing in the journal');
  // Refusals are still recorded, so the operator can see who is waiting.
  assert.equal((await call(db, "select count(*)::int n from private.sc19_trial_auto_checks where outcome='refused'"))[0].n, 4);
});

test('a forged confirmation is refused: the signature is the gate', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  const requestId = randomUUID(), stamp = Date.now();
  const unsigned = (signature, id = requestId, at = stamp) => db.query(
    'select * from public.sc19_auto_claim_trial($1,$2,$3,$4,$5,$6,$7,$8)',
    [a.companyId, nipA, 'req-forged', 'Czynny', 'FIRMA', id, at, signature]);

  // No signature, a wrong one, and one made with the wrong secret.
  await assert.rejects(unsigned('0'.repeat(64)), code('42501'), 'wrong signature');
  await assert.rejects(unsigned(signTrialAuto('auto_claim', requestId, stamp,
    trialAutoClaimPayload({ requestId, issuedAtMs: stamp, companyId: a.companyId, nip: nipA, mfRequestId: 'req-forged', mfStatus: 'Czynny', mfName: 'FIRMA' }),
    'b'.repeat(32))), code('42501'), 'wrong secret');
  // A signature over a different registry answer cannot be reused for this one.
  await assert.rejects(unsigned(signTrialAuto('auto_claim', requestId, stamp,
    trialAutoClaimPayload({ requestId, issuedAtMs: stamp, companyId: a.companyId, nip: nipA, mfRequestId: 'req-forged', mfStatus: 'Czynny', mfName: 'INNA FIRMA' }),
    SECRET)), code('42501'), 'name substituted');
  // A digest signature is not a claim signature.
  await assert.rejects(unsigned(signTrialAuto('digest', requestId, stamp,
    trialAutoClaimPayload({ requestId, issuedAtMs: stamp, companyId: a.companyId, nip: nipA, mfRequestId: 'req-forged', mfStatus: 'Czynny', mfName: 'FIRMA' }),
    SECRET)), code('42501'), 'wrong operation');
  // Stale timestamps are outside the replay window.
  const old = stamp - 10 * 60 * 1000;
  await assert.rejects(unsigned(signTrialAuto('auto_claim', requestId, old,
    trialAutoClaimPayload({ requestId, issuedAtMs: old, companyId: a.companyId, nip: nipA, mfRequestId: 'req-forged', mfStatus: 'Czynny', mfName: 'FIRMA' }),
    SECRET), requestId, old), code('42501'), 'stale stamp');

  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0);
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_approvals'))[0].n, 0);
});

test('a valid request cannot be replayed', async t => {
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  const requestId = randomUUID(), stamp = Date.now();
  const payload = trialAutoClaimPayload({ requestId, issuedAtMs: stamp, companyId: a.companyId, nip: nipA, mfRequestId: 'r1', mfStatus: 'Czynny', mfName: 'F' });
  const signature = signTrialAuto('auto_claim', requestId, stamp, payload, SECRET);
  const args = [a.companyId, nipA, 'r1', 'Czynny', 'F', requestId, stamp, signature];
  assert.equal((await call(db, 'select * from public.sc19_auto_claim_trial($1,$2,$3,$4,$5,$6,$7,$8)', args))[0].outcome, 'granted');
  await assert.rejects(db.query('select * from public.sc19_auto_claim_trial($1,$2,$3,$4,$5,$6,$7,$8)', args),
    code('42501'), 'the same request id is accepted once');
  assert.ok(b.companyId);
});

test('only the company owner can trigger an automatic grant', async t => {
  const { db, h, a } = await ready(t);
  for (const who of [users.recruiter, users.viewer, users.otherOwner]) {
    await h.asUser(who);
    await assert.rejects(autoClaim(db, a.companyId, nipA), code('42501'), who);
  }
  await h.asUser(null, 'anon');
  await assert.rejects(autoClaim(db, a.companyId, nipA), code('42501'), 'anon');
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0);
});

test('one FREE per NIP survives the automatic path', async t => {
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');

  // A second company, same NIP, confirmed by the register: still refused.
  await h.asUser(users.otherOwner);
  const second = await autoClaim(db, b.companyId, nipA);
  assert.equal(second.outcome, 'refused');
  assert.equal(second.reason, 'NIP_TAKEN');

  // The same company asking again gets no second pack.
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).available, 5, 'idempotent, not doubled');

  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_nips'))[0].n, 1);
  assert.equal((await call(db, 'select sum(delta)::int s from private.sc19_credit_journal'))[0].s, 5, 'five credits in total');
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances'))[0].n, 1);
});

test('no FREE after a paid pack, even with a confirmed register answer', async t => {
  const { db, h, a } = await ready(t);
  await h.asAdmin();
  await db.query("insert into private.sc19_package_policy(plan,credits) values('PRESELEKCJA',60)");
  await db.query('select private.sc19_grant_paid($1,$2)', [a.companyId, 'FV/1/2026/TEST']);
  await h.asUser(users.owner);
  await assert.rejects(autoClaim(db, a.companyId, nipA), /sc19_trial_after_payment/);
  await h.asAdmin();
  const balance = (await call(db, 'select plan,available from private.sc19_balances where company_id=$1', [a.companyId]))[0];
  assert.deepEqual(balance, { plan: 'PRESELEKCJA', available: 60 }, 'the paid pack is untouched, no FREE bonus');
});

test('with the switch off, or without a secret, nothing is granted', async t => {
  const off = await ready(t, { enabled: false });
  await off.h.asUser(users.owner);
  await assert.rejects(autoClaim(off.db, off.a.companyId, nipA), /sc19_auto_disabled/);
  await off.h.asAdmin();
  assert.equal((await call(off.db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0);

  const bare = await ready(t, { secret: null });
  await bare.h.asUser(users.owner);
  await assert.rejects(autoClaim(bare.db, bare.a.companyId, nipB), code('42501'), 'no secret means no signature can pass');
  await bare.h.asAdmin();
  assert.equal((await call(bare.db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0);
});

test('the operator path still works and is still the fallback', async t => {
  const { db, h, a } = await ready(t, { enabled: false });
  await h.asUser(operator);
  await db.query('select public.sc19_operator_approve_trial($1,$2,$3)', [a.companyId, nipA, 'KRS extract checked 2026-11-03']);
  await h.asUser(users.owner);
  assert.equal(await db.query('select public.sc19_claim_trial($1,$2)', [a.companyId, nipA]).then(r => r.rows[0].sc19_claim_trial), 5);
  await h.asAdmin();
  assert.match((await call(db, 'select proof_reference from private.sc19_trial_approvals where company_id=$1', [a.companyId]))[0].proof_reference,
    /\[operator:/, 'a manual approval still records the operator');
  // The operator list shows exactly the automatic grants, and this is not one.
  await h.asUser(operator);
  assert.deepEqual(await call(db, 'select * from public.sc19_operator_auto_free_grants()'), []);
});

test('the operator sees the automatic grants with granted and used counts', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  await autoClaim(db, a.companyId, nipA);
  await h.asAdmin();
  // Spend two analyses through the reviewed journal reasons.
  await db.query(`insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values($1,'analysis_reserve',-1,'t1'),($1,'analysis_reserve',-1,'t2')`, [a.companyId]);
  await h.asUser(operator);
  const rows = await call(db, 'select * from public.sc19_operator_auto_free_grants()');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_id, a.companyId);
  assert.equal(rows[0].nip, nipA);
  assert.equal(rows[0].granted_credits, 5);
  assert.equal(rows[0].used_credits, 2);
  assert.equal(rows[0].mf_status, 'Czynny');
  assert.ok(rows[0].granted_at instanceof Date);
  // Ordinary users and anon cannot read it.
  for (const who of [users.owner, users.recruiter]) {
    await h.asUser(who);
    await assert.rejects(db.query('select * from public.sc19_operator_auto_free_grants()'), code('42501'), who);
  }
});

test('consent is granted, withdrawn and granted again, and history is never rewritten', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  const first = (await call(db, "select public.marketing_consent_grant($1,'marketing-1.0','registration') at", [a.companyId]))[0].at;
  assert.ok(first instanceof Date);
  let state = (await call(db, 'select * from public.marketing_consent_state($1)', [a.companyId]))[0];
  assert.equal(state.event, 'granted');
  assert.equal(state.consent_version, 'marketing-1.0');
  assert.ok(state.consent_text.includes('kontakt handlowy'), 'the database supplies the wording');

  // Re-granting an active consent appends nothing.
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]);
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.marketing_consent_events where company_id=$1', [a.companyId]))[0].n, 1);

  await h.asUser(users.owner);
  const withdrawn = (await call(db, 'select public.marketing_consent_withdraw($1) at', [a.companyId]))[0].at;
  assert.ok(withdrawn instanceof Date);
  state = (await call(db, 'select * from public.marketing_consent_state($1)', [a.companyId]))[0];
  assert.equal(state.event, 'withdrawn');
  // Withdrawing twice is refused rather than appending a second withdrawal.
  await assert.rejects(db.query('select public.marketing_consent_withdraw($1)', [a.companyId]), /marketing_consent_not_active/);

  await h.asAdmin();
  const history = await call(db, 'select event,consent_version,consent_text,source from private.marketing_consent_events where company_id=$1 order by occurred_at, id', [a.companyId]);
  assert.deepEqual(history.map(row => row.event), ['granted', 'withdrawn'], 'both rows are kept');
  assert.equal(history[0].source, 'registration');
  assert.equal(history[1].source, 'company_panel');
  assert.equal(history[0].consent_text, history[1].consent_text, 'the withdrawal records the wording in force');
  // The ledger is append-only in the database, not only in the UI.
  await assert.rejects(db.query('update private.marketing_consent_events set event=$1', ['granted']), /Immutable/i);
  await assert.rejects(db.query('delete from private.marketing_consent_events'), /Immutable/i);

  // Granting again after a withdrawal appends a third row.
  await h.asUser(users.owner);
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]);
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.marketing_consent_events where company_id=$1', [a.companyId]))[0].n, 3);
});

test('consent wording cannot be supplied by the caller, and unknown versions are refused', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  // There is no parameter for the text at all, and an unknown version is refused.
  await assert.rejects(db.query("select public.marketing_consent_grant($1,'marketing-9.9')", [a.companyId]), code('22023'));
  await assert.rejects(db.query("select public.marketing_consent_grant($1,'')", [a.companyId]), code('22023'));
  await assert.rejects(db.query("select public.marketing_consent_grant($1,'marketing-1.0','operator')", [a.companyId]), code('22023'));
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.marketing_consent_events'))[0].n, 0);
});

test('only the owner changes consent; members may read it; outsiders may not', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]);
  // The fixture seeds the owner only; add the other two as real members, so
  // "members may read, only the owner may change" is actually exercised.
  await h.asAdmin();
  await db.query(`insert into public.company_members(company_id,user_id,role)
    values($1,$2,'recruiter'),($1,$3,'viewer')`, [a.companyId, users.recruiter, users.viewer]);
  for (const who of [users.recruiter, users.viewer]) {
    await h.asUser(who);
    await assert.rejects(db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]), code('42501'), who);
    await assert.rejects(db.query('select public.marketing_consent_withdraw($1)', [a.companyId]), code('42501'), who);
    // Reading is allowed for company members.
    assert.equal((await call(db, 'select * from public.marketing_consent_state($1)', [a.companyId]))[0].event, 'granted', who);
  }
  await h.asUser(users.otherOwner);
  await assert.rejects(db.query('select * from public.marketing_consent_state($1)', [a.companyId]), code('42501'), 'another company');
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select * from public.marketing_consent_state($1)', [a.companyId]), code('42501'), 'anon');
});

test('the operator sees the consent state per company, without the wording', async t => {
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]);
  await h.asUser(operator);
  const rows = await call(db, 'select * from public.sc19_operator_marketing_consents(null)');
  assert.equal(rows.length, 1, 'only companies with a consent event appear');
  assert.equal(rows[0].company_id, a.companyId);
  assert.equal(rows[0].event, 'granted');
  assert.equal(rows[0].consent_version, 'marketing-1.0');
  assert.equal('consent_text' in rows[0], false, 'the wording is not exposed to the operator listing');
  assert.ok(b.companyId);
  for (const who of [users.owner, users.recruiter]) {
    await h.asUser(who);
    await assert.rejects(db.query('select * from public.sc19_operator_marketing_consents(null)'), code('42501'), who);
  }
});

test('the daily digest returns counts only, and only to a signed caller', async t => {
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  await autoClaim(db, a.companyId, nipA);
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]);

  const end = new Date(), start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const stamp = value => value.toISOString().replace(/\.\d+Z$/, '');
  const run = (signature, id, at) => db.query('select * from public.sc19_daily_digest($1,$2,$3,$4,$5)',
    [start.toISOString(), end.toISOString(), id, at, signature]).then(r => r.rows[0]);

  const requestId = randomUUID(), issuedAtMs = Date.now();
  const payload = [stamp(start), stamp(end)].join('\n');
  // Unsigned and wrongly signed callers get nothing, including the operator.
  await assert.rejects(run('0'.repeat(64), requestId, issuedAtMs), code('42501'));
  await assert.rejects(run(signTrialAuto('auto_claim', requestId, issuedAtMs, payload, SECRET), requestId, issuedAtMs),
    code('42501'), 'a claim signature is not a digest signature');

  await h.asUser(null, 'anon');
  const counts = await run(signTrialAuto('digest', requestId, issuedAtMs, payload, SECRET), requestId, issuedAtMs);
  assert.deepEqual(Object.keys(counts).sort(), ['auto_free', 'awaiting_manual', 'marketing_consents', 'registered']);
  assert.equal(counts.registered, 2, 'both seeded companies');
  assert.equal(counts.auto_free, 1);
  assert.equal(counts.awaiting_manual, 1, 'the company with no approval');
  assert.equal(counts.marketing_consents, 1);
  assert.ok(b.companyId);

  // A nonsense window is refused before anything is read.
  const bad = randomUUID(), badAt = Date.now();
  await assert.rejects(db.query('select * from public.sc19_daily_digest($1,$2,$3,$4,$5)',
    [end.toISOString(), start.toISOString(), bad, badAt, 'x'.repeat(64)]), code('22023'), 'reversed window');
});

test('the erasure inventory still matches after the new tables', async t => {
  const env = await bootMigrationDatabase(t);
  await setupRankingDatabase(env.db, { throughMigration: null });
  // R11 must cover the four new tables, or every erasure preview fails closed.
  await assertCurrentInventory(env.db);
  await env.db.query('reset role');
  const baseline = (await call(env.db, `select schema_signature, known_tables from private.erasure_inventory_baseline_r11 where singleton`))[0];
  for (const table of ['private.marketing_consent_events', 'private.sc19_trial_auto_checks',
    'private.sc19_trial_auto_nonces', 'private.sc19_trial_auto_settings']) {
    assert.ok(baseline.known_tables.includes(table), table);
  }
  assert.equal((await call(env.db, 'select private.erasure_schema_signature() v'))[0].v, baseline.schema_signature);
  // Automatic FREE ships switched off: installing the migration grants nothing.
  const settings = (await call(env.db, 'select auto_free_enabled, request_secret from private.sc19_trial_auto_settings'))[0];
  assert.equal(settings.auto_free_enabled, false);
  assert.equal(settings.request_secret, null);
  assert.equal((await call(env.db, 'select count(*)::int n from private.marketing_consent_events'))[0].n, 0);
  assert.equal((await call(env.db, 'select count(*)::int n from private.sc19_trial_auto_checks'))[0].n, 0);
});

test('the new private tables are unreachable from the Data API roles', async t => {
  const { db, h } = await ready(t);
  await h.asAdmin();
  for (const table of ['marketing_consent_events', 'sc19_trial_auto_checks', 'sc19_trial_auto_nonces', 'sc19_trial_auto_settings']) {
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        assert.equal((await call(db, 'select has_table_privilege($1,$2,$3) v', [role, `private.${table}`, privilege]))[0].v,
          false, `${role} ${privilege} ${table}`);
      }
    }
    assert.equal((await call(db, 'select relrowsecurity v from pg_class where oid=$1::regclass', [`private.${table}`]))[0].v,
      true, `RLS on ${table}`);
  }
  // The private helpers stay private.
  for (const fn of ['private.marketing_consent_text(text)', 'private.sc19_trial_auto_verify_signature(text,uuid,bigint,text,text)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await call(db, 'select has_function_privilege($1,$2,$3) v', [role, fn, 'execute']))[0].v, false, `${role} ${fn}`);
    }
  }
});

const rollback = name => readFileSync(new URL(`../supabase/rollbacks/${name}`, import.meta.url), 'utf8');
const forward = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('both rollbacks run in order, restore the reviewed R10 state and re-apply', async t => {
  const env = await bootMigrationDatabase(t);
  await setupRankingDatabase(env.db, { throughMigration: null });
  const { db } = env;
  await db.query('reset role');

  // The order is enforced, not just documented: dropping the four tables while
  // R11 still reads them would leave erasure fail-closed with no way back.
  await assert.rejects(db.query(rollback('20261103090000_sc19_auto_trial_marketing_consent_down.sql')),
    /sc19_auto_down_requires_r11_rollback/);
  await db.query('rollback').catch(() => {});

  await db.query(rollback('20261103090100_sc_erasure_inventory_r11_down.sql'));
  assert.equal((await call(db, "select to_regclass('private.erasure_inventory_baseline_r11') v"))[0].v, null);
  await db.query(rollback('20261103090000_sc19_auto_trial_marketing_consent_down.sql'));
  for (const table of ['marketing_consent_events', 'sc19_trial_auto_checks', 'sc19_trial_auto_nonces', 'sc19_trial_auto_settings']) {
    assert.equal((await call(db, 'select to_regclass($1) v', [`private.${table}`]))[0].v, null, table);
  }

  // Back at R10 exactly: erasure previews work again on the reviewed signature.
  await assertCurrentInventory(db);
  const r10 = (await call(db, 'select schema_signature from private.erasure_inventory_baseline_r10 where singleton'))[0];
  assert.equal((await call(db, 'select private.erasure_schema_signature() v'))[0].v, r10.schema_signature);

  // And the pair re-applies cleanly on top of the rolled-back database.
  await db.query(forward('20261103090000_sc19_auto_trial_marketing_consent.sql'));
  await db.query(forward('20261103090100_sc_erasure_inventory_r11.sql'));
  await assertCurrentInventory(db);
});

test('the forward pair refuses to run twice and refuses a wrong order', async t => {
  const env = await bootMigrationDatabase(t);
  await setupRankingDatabase(env.db, { throughMigration: null });
  const { db } = env;
  await db.query('reset role');
  await assert.rejects(db.query(forward('20261103090000_sc19_auto_trial_marketing_consent.sql')),
    /sc19_auto_already_installed/);
  await db.query('rollback').catch(() => {});
  await assert.rejects(db.query(forward('20261103090100_sc_erasure_inventory_r11.sql')),
    /sc_r11_already_installed/);
  await db.query('rollback').catch(() => {});
  // R11 on a database that never got the four tables is refused too.
  await db.query(rollback('20261103090100_sc_erasure_inventory_r11_down.sql'));
  await db.query(rollback('20261103090000_sc19_auto_trial_marketing_consent_down.sql'));
  await assert.rejects(db.query(forward('20261103090100_sc_erasure_inventory_r11.sql')),
    /sc_r11_requires_auto_trial_consent/);
});
