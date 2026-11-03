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
const nipA = nip('526025099'), nipB = nip('951000001'), nipC = nip('118000002');
const code = expected => error => error.code === expected;
const call = (db, sql, params) => db.query(sql, params).then(r => r.rows);
const precheck = (db, companyId, nipValue) =>
  call(db, 'select * from public.sc19_auto_free_precheck($1,$2)', [companyId, nipValue]).then(rows => rows[0]);

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

/** The three extra arguments public.marketing_consent_grant_registration needs,
 * built exactly as signRegistrationConsentGrant() in
 * lib/marketing-consent-signing.ts builds them — so the test proves the two
 * sides agree on the payload, not just that each is self-consistent. */
function registrationGrant(companyId, version) {
  const requestId = randomUUID(), issuedAtMs = Date.now();
  const payload = [companyId.toLowerCase(), version].join('\n');
  return [requestId, issuedAtMs, signTrialAuto('consent_registration', requestId, issuedAtMs, payload, SECRET)];
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

test('a register answer without a granting status grants nothing', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  for (const mf of [
    { mfStatus: 'Wykreślony' },         // in the register, but not a granting status
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

test('a VAT-exempt company gets FREE too (owner decision 2026-11-03)', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  const result = await autoClaim(db, a.companyId, nipA, { mfStatus: 'Zwolniony' });
  assert.deepEqual(result, { outcome: 'granted', available: 5, reason: null });
  await h.asAdmin();
  assert.match((await call(db, 'select proof_reference from private.sc19_trial_approvals where company_id=$1', [a.companyId]))[0].proof_reference,
    /:Zwolniony$/, 'the approval records the exempt status it was granted on');
});

test('a NIP typed with separators is accepted by the same signature the client makes', async t => {
  // The activation field accepts separators, and the RPC normalizes before it
  // rebuilds the signed payload. Signing the raw input made every formatted NIP
  // fail with sc19_auto_forbidden; the client now signs the canonical digits.
  const { db, h, a } = await ready(t);
  const formatted = `${nipA.slice(0, 3)}-${nipA.slice(3, 6)}-${nipA.slice(6, 8)}-${nipA.slice(8)}`;
  await h.asUser(users.owner);
  // Signed over the canonical digits, passed in formatted: this is what the
  // server action now does, and the database must accept it.
  const requestId = randomUUID(), issuedAtMs = Date.now();
  const signature = signTrialAuto('auto_claim', requestId, issuedAtMs, trialAutoClaimPayload({
    requestId, issuedAtMs, companyId: a.companyId, nip: nipA,
    mfRequestId: 'r', mfStatus: 'Czynny', mfName: 'F',
  }), SECRET);
  const row = (await call(db, 'select * from public.sc19_auto_claim_trial($1,$2,$3,$4,$5,$6,$7,$8)',
    [a.companyId, formatted, 'r', 'Czynny', 'F', requestId, issuedAtMs, signature]))[0];
  assert.deepEqual(row, { outcome: 'granted', available: 5, reason: null });
  // The precheck normalizes the same way: the same NIP in either spelling is
  // one NIP, so it is still this company's own NIP and still allowed.
  assert.deepEqual(await precheck(db, a.companyId, formatted), { allowed: true, reason: null });
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null });
  // A different NIP from the same account is not.
  assert.deepEqual(await precheck(db, a.companyId, nipB), { allowed: false, reason: 'ANOTHER_NIP_TRIED' });
  await h.asAdmin();
  assert.equal((await call(db, 'select nip from private.sc19_trial_nips where company_id=$1', [a.companyId]))[0].nip, nipA);
});

test('one account may only try one NIP automatically, and the database enforces it', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  // First NIP: refused by the register, but recorded — the attempt is spent.
  assert.equal((await autoClaim(db, a.companyId, nipA, { mfStatus: 'Wykreślony' })).outcome, 'refused');

  // A second, different NIP is refused BEFORE the register is consulted, and
  // again inside the signed RPC for a caller that skips the precheck.
  const gate = await precheck(db, a.companyId, nipB);
  assert.deepEqual(gate, { allowed: false, reason: 'ANOTHER_NIP_TRIED' });
  const direct = await autoClaim(db, a.companyId, nipB);
  assert.equal(direct.outcome, 'refused');
  assert.equal(direct.reason, 'ANOTHER_NIP_TRIED');

  // The SAME NIP is not burned by the mistaken second one — an outage, or a NIP
  // that bounced off this very rule, must not cost the one attempt the account
  // is entitled to. What it does get is the short cooldown, because the registry
  // was just asked about this company (see the cooldown test for the whole
  // story): the reason is COOLDOWN, never ANOTHER_NIP_TRIED or NIP_TAKEN.
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'COOLDOWN' });

  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0);
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_approvals'))[0].n, 0);
  // The refusal row is written once per reason, so repeated submissions cannot
  // inflate the audit table.
  for (let i = 0; i < 3; i++) await h.asUser(users.owner), await precheck(db, a.companyId, nipB);
  await h.asAdmin();
  assert.equal((await call(db,
    "select count(*)::int n from private.sc19_trial_auto_checks where error_code='ANOTHER_NIP_TRIED' and nip=$1", [nipB]))[0].n,
    2, 'one row from the precheck, one from the signed RPC; the repeats add nothing');
});

test('the precheck refuses before the register is asked, and audits why', async t => {
  const off = await ready(t, { enabled: false });
  await off.h.asUser(users.owner);
  assert.deepEqual(await precheck(off.db, off.a.companyId, nipA), { allowed: false, reason: 'AUTO_DISABLED' });
  await off.h.asAdmin();
  // The row the operator needs: this company tried, and nothing happened.
  const row = (await call(off.db, 'select outcome,error_code,nip from private.sc19_trial_auto_checks where company_id=$1',
    [off.a.companyId]))[0];
  assert.deepEqual(row, { outcome: 'refused', error_code: 'AUTO_DISABLED', nip: nipA });

  // No secret in the database is the same refusal, for the same reason.
  const bare = await ready(t, { secret: null });
  await bare.h.asUser(users.owner);
  assert.deepEqual(await precheck(bare.db, bare.a.companyId, nipA), { allowed: false, reason: 'AUTO_DISABLED' });

  // A NIP already taken by another company is refused without a register call.
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipA), { allowed: false, reason: 'NIP_TAKEN' });

  // Only the owner may ask, and a malformed NIP is refused outright.
  for (const who of [users.recruiter, users.viewer, users.owner]) {
    await h.asUser(who);
    await assert.rejects(db.query('select * from public.sc19_auto_free_precheck($1,$2)', [b.companyId, nipA]), code('42501'), who);
  }
  await h.asUser(users.otherOwner);
  await assert.rejects(db.query('select * from public.sc19_auto_free_precheck($1,$2)', [b.companyId, '123']), code('22023'));
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select * from public.sc19_auto_free_precheck($1,$2)', [b.companyId, nipA]), code('42501'), 'anon');
});

test('a registry refusal and an outage are both recorded, under their own op label', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  const record = (outcome, failureCode, op = 'auto_failure') => {
    const requestId = randomUUID(), issuedAtMs = Date.now();
    const payload = [a.companyId.toLowerCase(), nipA, outcome, failureCode].join('\n');
    return db.query('select public.sc19_auto_record_failure($1,$2,$3,$4,$5,$6,$7)',
      [a.companyId, nipA, outcome, failureCode, requestId, issuedAtMs,
        signTrialAuto(op, requestId, issuedAtMs, payload, SECRET)]);
  };
  await record('refused', 'NIP_NOT_FOUND');
  await record('unavailable', 'WHITELIST_TIMEOUT');
  // An auto_claim signature is no longer accepted here: the two RPCs used to
  // share one label and were kept apart only by their payload's line count.
  await assert.rejects(record('refused', 'NIP_NOT_FOUND', 'auto_claim'), code('42501'), 'wrong op label');
  await assert.rejects(record('granted', 'NIP_NOT_FOUND'), code('22023'), 'this RPC cannot record a grant');
  await assert.rejects(record('', 'NIP_NOT_FOUND'), code('22023'));

  await h.asAdmin();
  const rows = await call(db, 'select outcome,error_code from private.sc19_trial_auto_checks where company_id=$1 order by checked_at, id', [a.companyId]);
  assert.deepEqual(rows, [
    { outcome: 'refused', error_code: 'NIP_NOT_FOUND' },
    { outcome: 'unavailable', error_code: 'WHITELIST_TIMEOUT' },
  ]);
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0, 'nothing was granted');
});

test('a company that just failed at the registry waits before it may ask again', async t => {
  // THE PROBLEM (bot review finding, 2026-11-03). The Ministry of Finance
  // registry is public, keyless and has a low daily quota shared by every
  // company. Before this, an owner whose NIP the registry refused — or who hit
  // an outage — could resubmit the form endlessly, and every submission spent
  // another call, so one company could drain the day's quota for all the others.
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  const fail = (outcome, failureCode) => {
    const requestId = randomUUID(), issuedAtMs = Date.now();
    const payload = [a.companyId.toLowerCase(), nipA, outcome, failureCode].join('\n');
    return db.query('select public.sc19_auto_record_failure($1,$2,$3,$4,$5,$6,$7)',
      [a.companyId, nipA, outcome, failureCode, requestId, issuedAtMs,
        signTrialAuto('auto_failure', requestId, issuedAtMs, payload, SECRET)]);
  };

  // The first attempt is open: nothing has been asked yet.
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null });

  // AN OLD FAILURE DOES NOT THROTTLE: the cooldown expires, so it can never
  // become a permanent block. The audit table is append-only (an UPDATE raises
  // 'Immutable contact history'), so the aged row is inserted aged.
  await h.asAdmin();
  await db.query(`insert into private.sc19_trial_auto_checks(company_id,nip,outcome,error_code,checked_at)
    values($1,$2,'unavailable','WHITELIST_TIMEOUT', now() - private.sc19_auto_free_cooldown() - interval '1 minute')`,
    [a.companyId, nipA]);
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null },
    'an attempt older than the cooldown is retryable');

  // A FRESH registry failure throttles the next submission, so the registry is
  // not asked again — for an outage and for a registry refusal alike.
  await fail('refused', 'NIP_NOT_FOUND');
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'COOLDOWN' });
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'COOLDOWN' });

  // Another company is unaffected: the cooldown is per account, not global, so
  // one company's retry loop cannot stop anybody else activating FREE.
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipB), { allowed: true, reason: null });

  // AND NOTHING WAS BURNED. The one-NIP-per-account slot is still this NIP, so
  // the company is only slowed down, never locked out — and the cooldown gates
  // the registry call, never the grant: a confirmed answer still activates FREE.
  await h.asAdmin();
  assert.equal((await call(db, 'select private.sc19_auto_free_other_nip_tried($1,$2) v', [a.companyId, nipA]))[0].v, false);
  assert.equal((await call(db, 'select private.sc19_auto_free_other_nip_tried($1,$2) v', [a.companyId, nipB]))[0].v, true);
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');

  // The COOLDOWN audit row is written once per (company, NIP), not once per
  // resubmission, so a retry loop cannot inflate the audit table either.
  await h.asAdmin();
  assert.equal((await call(db,
    "select count(*)::int n from private.sc19_trial_auto_checks where company_id=$1 and error_code='COOLDOWN'",
    [a.companyId]))[0].n, 1, 'repeats do not inflate the audit table');
  assert.ok(nipC, 'the third synthetic NIP stays unused here');
});

test('the operator can release an occupied NIP so the real company can use FREE', async t => {
  const { db, h, a, b } = await ready(t);
  // Company A occupies the NIP; it is NOT the company that holds it.
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');
  // Company B, which really holds that NIP, is refused: one FREE per NIP.
  await h.asUser(users.otherOwner);
  assert.equal((await autoClaim(db, b.companyId, nipA)).reason, 'NIP_TAKEN');

  // The operator sees the occupied NIP and who occupied it.
  await h.asUser(operator);
  const taken = await call(db, 'select * from public.sc19_operator_taken_trial_nips()');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].nip, nipA);
  assert.equal(taken[0].company_id, a.companyId);
  assert.equal(taken[0].free_claimed, true);
  assert.equal(taken[0].source, 'wykaz VAT');

  // A reason is mandatory, and an unoccupied NIP cannot be released.
  await assert.rejects(db.query('select * from public.sc19_operator_release_trial_nip($1,$2)', [nipA, 'krótko']), /sc19_release_reason_required/);
  await assert.rejects(db.query('select * from public.sc19_operator_release_trial_nip($1,$2)', [nipC, 'KRS sprawdzony 2026-11-03']), /sc19_trial_nip_not_taken/);
  await assert.rejects(db.query('select * from public.sc19_operator_release_trial_nip($1,$2)', ['123', 'KRS sprawdzony 2026-11-03']), code('22023'));

  const released = (await call(db, 'select * from public.sc19_operator_release_trial_nip($1,$2)',
    [nipA, 'KRS sprawdzony 2026-11-03: NIP nalezy do innej firmy']))[0];
  assert.equal(released.released_company_id, a.companyId);
  assert.ok(released.released_at instanceof Date);

  // The audit says who released what, when and why; it is append-only.
  const audit = await call(db, 'select * from public.sc19_operator_trial_nip_releases()');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].nip, nipA);
  assert.match(audit[0].reason, /^KRS sprawdzony/);
  await h.asAdmin();
  assert.equal((await call(db, 'select operator_id from private.sc19_trial_nip_releases'))[0].operator_id, operator);
  await assert.rejects(db.query('update private.sc19_trial_nip_releases set reason=$1', ['inny']), /Immutable/i);
  await assert.rejects(db.query('delete from private.sc19_trial_nip_releases'), /Immutable/i);

  // A release frees the NIP and changes NO balance: taking analyses back is a
  // billing action and belongs to the owner.
  assert.equal((await call(db, 'select available from private.sc19_balances where company_id=$1', [a.companyId]))[0].available, 5,
    'the occupying company keeps the analyses it was granted');
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_approvals where nip=$1', [nipA]))[0].n, 0);
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_nips where nip=$1', [nipA]))[0].n, 0);
  // The record of the original occupation survives the release.
  assert.equal((await call(db, "select count(*)::int n from private.sc19_trial_auto_checks where outcome='granted' and nip=$1", [nipA]))[0].n, 1);
  // The trial journal row is KEPT, with its company, amount and time; only the
  // reference — the "this NIP's one FREE" idempotency key, which
  // private.sc19_credit_journal holds UNIQUE — is re-keyed to the release. The
  // first version of this function left it alone, and the real company's claim
  // then failed on that unique constraint: the release did nothing.
  const journal = (await call(db, "select company_id,reason,delta,reference from private.sc19_credit_journal where reason='trial'"))[0];
  assert.equal(journal.company_id, a.companyId);
  assert.equal(journal.delta, 5);
  assert.match(journal.reference, new RegExp(`^trial:${nipA}:zwolniony:[0-9a-f-]{36}$`));

  // And now the real company can actually activate FREE.
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipA), { allowed: true, reason: null });
  assert.deepEqual(await autoClaim(db, b.companyId, nipA), { outcome: 'granted', available: 5, reason: null });
  await h.asAdmin();
  assert.equal((await call(db, "select count(*)::int n from private.sc19_credit_journal where reference=$1", [`trial:${nipA}`]))[0].n, 1,
    'the real company now holds the NIP key');
  assert.equal((await call(db, 'select available from private.sc19_balances where company_id=$1', [b.companyId]))[0].available, 5);
  await h.asUser(operator);

  // Only an operator may release or list.
  for (const who of [users.owner, users.otherOwner, users.recruiter]) {
    await h.asUser(who);
    await assert.rejects(db.query('select * from public.sc19_operator_release_trial_nip($1,$2)', [nipA, 'proba nieuprawniona']), code('42501'), who);
    await assert.rejects(db.query('select * from public.sc19_operator_taken_trial_nips()'), code('42501'), who);
    await assert.rejects(db.query('select * from public.sc19_operator_trial_nip_releases()'), code('42501'), who);
  }
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select * from public.sc19_operator_taken_trial_nips()'), code('42501'), 'anon');
});

test('the request secret can be installed and rotated without a raw UPDATE', async t => {
  // Without this the column could be set only by a raw UPDATE, which the owner
  // cannot run and an agent session must not run against production, so Part A
  // could never be switched on at all.
  const { db, h, a } = await ready(t, { secret: null });
  await h.asAdmin();
  assert.equal((await call(db, 'select request_secret from private.sc19_trial_auto_settings'))[0].request_secret, null);
  // With no secret nothing can be signed, so nothing is granted.
  await h.asUser(users.owner);
  await assert.rejects(autoClaim(db, a.companyId, nipA), code('42501'));

  await h.asAdmin();
  for (const bad of [null, '', 'short', 'y'.repeat(31)]) {
    await assert.rejects(db.query('select private.rotate_sc19_trial_auto_secret($1)', [bad]), code('22023'), String(bad));
  }
  await db.query('select private.rotate_sc19_trial_auto_secret($1)', [SECRET]);
  let row = (await call(db, 'select request_secret, updated_at from private.sc19_trial_auto_settings'))[0];
  assert.equal(row.request_secret, SECRET);
  assert.ok(row.updated_at instanceof Date);
  // And now the same client-side signature is accepted: this is the whole
  // point — without this function the column could be set only by a raw UPDATE.
  await h.asUser(users.owner);
  assert.deepEqual(await autoClaim(db, a.companyId, nipA), { outcome: 'granted', available: 5, reason: null });

  // The operator panel reports that a secret exists, and never the secret.
  await h.asUser(operator);
  const settings = (await call(db, 'select * from public.sc19_operator_auto_free_settings()'))[0];
  assert.equal(settings.secret_configured, true);
  assert.equal('request_secret' in settings, false);
  await h.asAdmin();

  // Rotating replaces the value and clears the replay nonces.
  await db.query('insert into private.sc19_trial_auto_nonces(request_id) values($1)', [randomUUID()]);
  await db.query('select private.rotate_sc19_trial_auto_secret($1)', ['z'.repeat(40)]);
  row = (await call(db, 'select request_secret from private.sc19_trial_auto_settings'))[0];
  assert.equal(row.request_secret, 'z'.repeat(40));
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_auto_nonces'))[0].n, 0);
  // It is private: no Data API role may call it.
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await call(db, 'select has_function_privilege($1,$2,$3) v',
      [role, 'private.rotate_sc19_trial_auto_secret(text)', 'execute']))[0].v, false, role);
  }
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
  // The operator list shows the automatic checks, and there were none here.
  await h.asUser(operator);
  assert.deepEqual(await call(db, 'select * from public.sc19_operator_auto_free_grants()'), []);
});

test('the operator sees every automatic check, not only the grants', async t => {
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  await autoClaim(db, a.companyId, nipA);
  // A refusal for the other company, which must also be visible: with the
  // grant-only filter these rows were written and shown nowhere, so nobody
  // could see which company was waiting or why.
  await h.asUser(users.otherOwner);
  await autoClaim(db, b.companyId, nipB, { mfStatus: 'Wykreślony' });
  await h.asAdmin();
  // Spend two analyses through the reviewed journal reasons.
  await db.query(`insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values($1,'analysis_reserve',-1,'t1'),($1,'analysis_reserve',-1,'t2')`, [a.companyId]);
  await h.asUser(operator);
  const rows = await call(db, 'select * from public.sc19_operator_auto_free_grants()');
  assert.equal(rows.length, 2);
  const granted = rows.find(row => row.outcome === 'granted');
  assert.equal(granted.company_id, a.companyId);
  assert.equal(granted.nip, nipA);
  assert.equal(granted.granted_credits, 5);
  assert.equal(granted.used_credits, 2, 'lifetime consumption from the credit journal');
  assert.equal(granted.mf_status, 'Czynny');
  assert.equal(granted.error_code, null);
  assert.ok(granted.checked_at instanceof Date);
  const refused = rows.find(row => row.outcome === 'refused');
  assert.equal(refused.company_id, b.companyId);
  assert.equal(refused.nip, nipB);
  assert.equal(refused.error_code, 'STATUS_NOT_ACTIVE');
  assert.equal(refused.granted_credits, null);
  assert.equal(refused.used_credits, null, 'consumption is reported only for a grant');
  // Ordinary users and anon cannot read it.
  for (const who of [users.owner, users.recruiter]) {
    await h.asUser(who);
    await assert.rejects(db.query('select * from public.sc19_operator_auto_free_grants()'), code('42501'), who);
  }
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select * from public.sc19_operator_auto_free_grants()'), code('42501'), 'anon');
});

test('consent is granted, withdrawn and granted again, and history is never rewritten', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  const first = (await call(db, "select public.marketing_consent_grant_registration($1,'marketing-1.0',$2,$3,$4) at",
    [a.companyId, ...registrationGrant(a.companyId, 'marketing-1.0')]))[0].at;
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
  // And no parameter for the SOURCE either: the three-argument form that used to
  // accept one does not exist (42883 = undefined_function).
  await assert.rejects(db.query("select public.marketing_consent_grant($1,'marketing-1.0','operator')", [a.companyId]), code('42883'));
  await assert.rejects(db.query("select public.marketing_consent_grant($1,'marketing-1.0','registration')", [a.companyId]), code('42883'));
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.marketing_consent_events'))[0].n, 0);
});

test('a signed-in owner cannot pass his own consent off as given at registration', async t => {
  // THE ATTACK (bot review finding, 2026-11-03). Verifying the sign-up snapshot
  // in Node was not enough: public.marketing_consent_grant is executable by every
  // signed-in user through the Data API, and while it took the source as a
  // parameter and only whitelisted the string, an owner could call it with
  // consent_source='registration' with no snapshot at all. The append-only
  // ledger is the proof of WHERE the customer gave the consent (art. 7(1) GDPR),
  // so a forgeable provenance destroys the whole record.
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  const signed = registrationGrant(a.companyId, 'marketing-1.0');

  // Without a valid server signature, 'registration' cannot be written at all.
  const unsigned = [
    ['no signature', [randomUUID(), Date.now(), '0'.repeat(64)]],
    ['an invented signature', [randomUUID(), Date.now(), 'f'.repeat(64)]],
    ['an empty signature', [randomUUID(), Date.now(), '']],
    // A signature for another operation sharing the same secret is not this one.
    ['a claim signature', (() => { const id = randomUUID(), at = Date.now();
      return [id, at, signTrialAuto('auto_claim', id, at, [a.companyId, 'marketing-1.0'].join('\n'), SECRET)]; })()],
    // The snapshot label is deliberately outside the database's whitelist.
    ['a snapshot signature', (() => { const id = randomUUID(), at = Date.now();
      return [id, at, signTrialAuto('consent', id, at, [a.companyId, 'marketing-1.0'].join('\n'), SECRET)]; })()],
    // Valid signature, but for a different company and a different version.
    ['another company', registrationGrant(randomUUID(), 'marketing-1.0')],
    ['another version', registrationGrant(a.companyId, 'marketing-9.9')],
    // Outside the 60 s window.
    ['an expired request', (() => { const id = randomUUID(), at = Date.now() - 10 * 60 * 1000;
      return [id, at, signTrialAuto('consent_registration', id, at, [a.companyId, 'marketing-1.0'].join('\n'), SECRET)]; })()],
  ];
  for (const [label, args] of unsigned) {
    await assert.rejects(db.query('select public.marketing_consent_grant_registration($1,$2,$3,$4,$5)',
      [a.companyId, 'marketing-1.0', ...args]), code('42501'), label);
  }
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.marketing_consent_events'))[0].n, 0,
    'not one forged provenance reached the ledger');

  // A signature is not a substitute for being the owner either.
  for (const who of [users.recruiter, users.otherOwner]) {
    await h.asUser(who);
    await assert.rejects(db.query('select public.marketing_consent_grant_registration($1,$2,$3,$4,$5)',
      [a.companyId, 'marketing-1.0', ...registrationGrant(a.companyId, 'marketing-1.0')]), code('42501'), who);
  }
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select public.marketing_consent_grant_registration($1,$2,$3,$4,$5)',
    [a.companyId, 'marketing-1.0', ...signed]), code('42501'), 'anon');

  // THE LEGITIMATE PATH STILL WORKS: owner plus a fresh server signature.
  await h.asUser(users.owner);
  const at = (await call(db, 'select public.marketing_consent_grant_registration($1,$2,$3,$4,$5) at',
    [a.companyId, 'marketing-1.0', ...registrationGrant(a.companyId, 'marketing-1.0')]))[0].at;
  assert.ok(at instanceof Date);
  await h.asAdmin();
  const rows = await call(db, 'select event,source from private.marketing_consent_events where company_id=$1', [a.companyId]);
  assert.deepEqual(rows, [{ event: 'granted', source: 'registration' }]);
  assert.ok(signed.length === 3, 'the signed request is three values: id, time, HMAC');
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
    'private.sc19_trial_auto_nonces', 'private.sc19_trial_auto_settings', 'private.sc19_trial_nip_releases']) {
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

/** Every public RPC this migration adds, with who may execute it. anon appears
 * exactly once on purpose: the daily digest has no session (a scheduler calls
 * it), and it is protected by the HMAC instead, returning counts only. */
const PUBLIC_RPCS = Object.freeze({
  'public.sc19_auto_claim_trial(uuid,text,text,text,text,uuid,bigint,text)': ['authenticated'],
  'public.sc19_auto_record_failure(uuid,text,text,text,uuid,bigint,text)': ['authenticated'],
  'public.sc19_auto_free_precheck(uuid,text)': ['authenticated'],
  'public.sc19_operator_set_auto_free(boolean)': ['authenticated'],
  'public.sc19_operator_auto_free_settings()': ['authenticated'],
  'public.sc19_operator_auto_free_grants()': ['authenticated'],
  'public.sc19_operator_taken_trial_nips()': ['authenticated'],
  'public.sc19_operator_release_trial_nip(text,text)': ['authenticated'],
  'public.sc19_operator_trial_nip_releases()': ['authenticated'],
  'public.marketing_consent_grant(uuid,text)': ['authenticated'],
  'public.marketing_consent_grant_registration(uuid,text,uuid,bigint,text)': ['authenticated'],
  'public.marketing_consent_withdraw(uuid)': ['authenticated'],
  'public.marketing_consent_state(uuid)': ['authenticated'],
  'public.sc19_operator_marketing_consents(text)': ['authenticated'],
  'public.sc19_daily_digest(timestamptz,timestamptz,uuid,bigint,text)': ['anon', 'authenticated'],
});

test('the grants on every new public RPC are exactly the reviewed ones', async t => {
  const { db, h } = await ready(t);
  await h.asAdmin();
  for (const [fn, allowed] of Object.entries(PUBLIC_RPCS)) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await call(db, 'select has_function_privilege($1,$2,$3) v', [role, fn, 'execute']))[0].v,
        allowed.includes(role), `${role} execute ${fn}`);
    }
    // PUBLIC is revoked, so no future role inherits execute by accident.
    assert.equal((await call(db, 'select has_function_privilege($1,$2,$3) v', ['public', fn, 'execute']))[0].v,
      false, `PUBLIC execute ${fn}`);
  }
  // The one that anon may call deliberately, and the one it must never call.
  assert.equal((await call(db, 'select has_function_privilege($1,$2,$3) v',
    ['anon', 'public.sc19_auto_claim_trial(uuid,text,text,text,text,uuid,bigint,text)', 'execute']))[0].v, false,
    'anon can never mint a FREE pack');
  assert.equal((await call(db, 'select has_function_privilege($1,$2,$3) v',
    ['anon', 'public.sc19_daily_digest(timestamptz,timestamptz,uuid,bigint,text)', 'execute']))[0].v, true,
    'the scheduler has no session, so anon may call the signed digest');
});

test('the signed functions that write are declared volatile', async t => {
  const { db, h } = await ready(t);
  await h.asAdmin();
  // Verifying a signature prunes and inserts a nonce row, so every function
  // that verifies one WRITES. Declared stable, PostgreSQL may treat it as
  // read-only and the replay protection would fail or be skipped.
  for (const fn of [
    'private.sc19_trial_auto_verify_signature(text,uuid,bigint,text,text)',
    'public.sc19_daily_digest(timestamptz,timestamptz,uuid,bigint,text)',
    'public.sc19_auto_claim_trial(uuid,text,text,text,text,uuid,bigint,text)',
    'public.sc19_auto_record_failure(uuid,text,text,text,uuid,bigint,text)',
    'public.sc19_auto_free_precheck(uuid,text)',
    'public.sc19_operator_release_trial_nip(text,text)',
    'public.marketing_consent_grant_registration(uuid,text,uuid,bigint,text)',
    'private.rotate_sc19_trial_auto_secret(text)',
  ]) {
    assert.equal((await call(db, 'select provolatile from pg_proc where oid=$1::regprocedure', [fn]))[0].provolatile,
      'v', `${fn} must be volatile`);
  }
  // And it really does write: a read-only transaction rejects the digest.
  await h.asUser(null, 'anon');
  await db.query('begin read only');
  const requestId = randomUUID(), issuedAtMs = Date.now();
  const end = new Date(), start = new Date(end.getTime() - 3600_000);
  const stamp = value => value.toISOString().replace(/\.\d+Z$/, '');
  await assert.rejects(db.query('select * from public.sc19_daily_digest($1,$2,$3,$4,$5)',
    [start.toISOString(), end.toISOString(), requestId, issuedAtMs,
      signTrialAuto('digest', requestId, issuedAtMs, [stamp(start), stamp(end)].join('\n'), SECRET)]),
    /read-only transaction/i, 'the nonce insert is a real write');
  await db.query('rollback').catch(() => {});
});

test('the new private tables are unreachable from the Data API roles', async t => {
  const { db, h } = await ready(t);
  await h.asAdmin();
  for (const table of ['marketing_consent_events', 'sc19_trial_auto_checks', 'sc19_trial_auto_nonces',
    'sc19_trial_auto_settings', 'sc19_trial_nip_releases']) {
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
  for (const fn of ['private.marketing_consent_text(text)',
    'private.sc19_trial_auto_verify_signature(text,uuid,bigint,text,text)',
    'private.rotate_sc19_trial_auto_secret(text)',
    'private.marketing_consent_record(uuid,text,text,uuid)',
    'private.sc19_auto_free_cooldown()',
    'private.sc19_auto_free_other_nip_tried(uuid,text)']) {
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
  for (const table of ['marketing_consent_events', 'sc19_trial_auto_checks', 'sc19_trial_auto_nonces',
    'sc19_trial_auto_settings', 'sc19_trial_nip_releases']) {
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
