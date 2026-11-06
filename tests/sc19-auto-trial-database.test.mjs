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

/**
 * The window public.sc19_daily_digest is asked about, READ FROM THE DATABASE
 * CLOCK at the database's own resolution.
 *
 * WHY NOT new Date(). Every timestamp the digest counts is stamped by now(),
 * which keeps MICROSECONDS; new Date() in Node only has MILLISECONDS. Taking
 * the window end from Node therefore rounds it DOWN to a whole millisecond,
 * while the row written a moment earlier sits somewhere inside that same
 * millisecond — so `checked_at < window_end` is false and the row the test just
 * created falls outside the window it is supposed to be in. Measured against
 * this database: when the two land in the same millisecond, the row is dropped
 * 276 times out of 300. Whether they land in the same millisecond is decided by
 * how long the RPC happens to take, which is why the same test passes locally
 * and fails on a faster CI runner (it did, on 2026-11-03, run 41682917726, on
 * PostgreSQL 16 and 17 alike).
 *
 * This is a limit of the harness, not of the count. The half-open window
 * [start, end) is correct and is NOT widened here: consecutive daily windows
 * tile without a gap and without counting anything twice, and the boundary
 * itself is asserted explicitly further down with rows stamped by hand.
 *
 * Both bounds come from one `now()` in one statement, so they cannot drift
 * apart, and both are returned as canonical UTC text with microseconds, which
 * is also what Node must not reparse into a Date (that would truncate again).
 */
async function digestWindow(db, { hours = 24 } = {}) {
  const row = (await call(db,
    `select to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' as window_end,
            to_char((now() - make_interval(hours => $1)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'
              as window_start`, [hours])).at(0);
  // Guards the whole point of this helper. toISOString() writes three fractional
  // digits; the database writes six, and a window end rounded down to a whole
  // millisecond is exactly the failure described above. A bound that arrives
  // with millisecond precision means somebody has put a Node clock back in.
  for (const bound of [row.window_start, row.window_end]) {
    assert.match(bound, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
      'the digest window must keep the database clock\'s microseconds');
  }
  return { start: row.window_start, end: row.window_end };
}
/** The second-truncated spelling the database rebuilds the signed payload with
 * (to_char(..,'YYYY-MM-DD"T"HH24:MI:SS')), taken off the text above. */
const digestPayload = ({ start, end }) => [start.slice(0, 19), end.slice(0, 19)].join('\n');

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
  return { db, h, a, b, env };
}

/** A second, independent connection acting as `userId`, for the tests that must
 * run two calls AT THE SAME TIME: the shared fixture client is one session and
 * would serialize them by itself, proving nothing. */
async function sessionFor(env, userId) {
  const client = await env.connect();
  await client.query('set role authenticated');
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
  return client;
}

/** The four extra arguments public.marketing_consent_grant_registration needs —
 * the declared time, a request id, the request time and the HMAC — built exactly
 * as signRegistrationConsentGrant() in lib/marketing-consent-signing.ts builds
 * them, so the test proves the two sides agree on the payload, not just that
 * each is self-consistent. `declaredAt` is the canonical UTC spelling the
 * database rebuilds with to_char(); null means "no usable declared time". */
function registrationGrant(companyId, version, declaredAt = null) {
  const requestId = randomUUID(), issuedAtMs = Date.now();
  const payload = [companyId.toLowerCase(), version, declaredAt ?? '-'].join('\n');
  return [declaredAt, requestId, issuedAtMs, signTrialAuto('consent_registration', requestId, issuedAtMs, payload, SECRET)];
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
  // one NIP, so it is still this company's own NIP and still allowed. (It is
  // allowed only once in a row, because an allowed precheck reserves the attempt
  // — see the parallel-submissions test; the point here is the reason it gives,
  // which is never ANOTHER_NIP_TRIED or NIP_TAKEN for the same digits.)
  assert.deepEqual(await precheck(db, a.companyId, formatted), { allowed: true, reason: null });
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'COOLDOWN' });
  // A different NIP from the same account is refused for a different reason, and
  // that reason is checked before the cooldown, so the two cannot be confused.
  assert.deepEqual(await precheck(db, a.companyId, nipB), { allowed: false, reason: 'ANOTHER_NIP_TRIED' });
  await h.asAdmin();
  // The formatted spelling is stored and compared as the canonical digits.
  assert.deepEqual((await call(db, 'select distinct nip from private.sc19_trial_auto_checks where company_id=$1', [a.companyId])).map(r => r.nip).sort(),
    [nipA, nipB].sort());
  await h.asUser(users.owner);
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

test('a company that asks again a day later is a fresh request, not a suppressed duplicate', async t => {
  // THE BUG (bot review finding 4460319655, 2026-11-03). The refusal row was
  // written "once per (company, NIP, reason), ever", to stop a company clicking
  // the form from inflating the audit. But the operator's queue in the daily
  // summary is built from exactly those rows over the LAST DAY, so a company
  // that asked on Monday, was not dealt with, and asked again on Wednesday wrote
  // no new row — and from Tuesday evening onwards appeared in no summary at all,
  // while still waiting. The audit protection was quietly deleting real requests
  // from the one number the owner acts on.
  const { db, h, a } = await ready(t, { enabled: false });
  const rows = async () => (await call(db,
    "select count(*)::int n from private.sc19_trial_auto_checks where company_id=$1 and error_code='AUTO_DISABLED'",
    [a.companyId]))[0].n;

  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'AUTO_DISABLED' });
  await h.asAdmin();
  assert.equal(await rows(), 1);

  // Clicking again straight away is still one row: that is what the suppression
  // is for, and it has not been given up.
  await h.asUser(users.owner);
  await precheck(db, a.companyId, nipA);
  await precheck(db, a.companyId, nipA);
  await h.asAdmin();
  assert.equal(await rows(), 1, 'hammering the form does not inflate the audit');

  // Now age the existing row past the refusal window — the same thing the
  // calendar does while nobody deals with the company — and ask again. (Written
  // with an explicit interval rather than a sleep, so the test does not depend
  // on wall-clock time passing. The audit table refuses an UPDATE, so the row is
  // re-inserted at an older time and the fresh one removed; this is the fixture
  // acting as the schema owner, not a path any RPC can take.)
  const aged = (await call(db,
    `select checked_at - (private.sc19_auto_free_refusal_window() + interval '1 minute') v
     from private.sc19_trial_auto_checks where company_id=$1`, [a.companyId]))[0].v;
  await db.query('alter table private.sc19_trial_auto_checks disable trigger immutable_history');
  await db.query('delete from private.sc19_trial_auto_checks where company_id=$1', [a.companyId]);
  await db.query(
    `insert into private.sc19_trial_auto_checks(company_id,nip,outcome,error_code,checked_at)
     values($1,$2,'refused','AUTO_DISABLED',$3)`, [a.companyId, nipA, aged]);
  await db.query('alter table private.sc19_trial_auto_checks enable trigger immutable_history');

  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'AUTO_DISABLED' });
  await h.asAdmin();
  assert.equal(await rows(), 2, 'asking again after the window is a new request the operator must see');

  // And it is back in the operator's queue, which is the point of all of this.
  const window = await digestWindow(db);
  const id = randomUUID(), at = Date.now();
  await h.asUser(null, 'anon');
  assert.equal((await call(db, 'select * from public.sc19_daily_digest($1,$2,$3,$4,$5)',
    [window.start, window.end, id, at,
      signTrialAuto('digest', id, at, digestPayload(window), SECRET)])).at(0).awaiting_manual, 1);

  // The window must stay far shorter than any period the summary is asked about,
  // or a company re-asking just inside it can still fall between two mails.
  await h.asAdmin();
  assert.equal((await call(db,
    "select private.sc19_auto_free_refusal_window() < interval '1 hour' v"))[0].v, true);
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

  // The first attempt is open: nothing has been asked yet. Being allowed also
  // RESERVES the attempt, so the next submission is already throttled even
  // before the registry has answered this one.
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null });
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'COOLDOWN' });

  // AN OLD ATTEMPT DOES NOT THROTTLE: the cooldown expires, so neither a failed
  // registry call nor a reservation can become a permanent block. The audit
  // table is append-only (an UPDATE raises 'Immutable contact history'), so the
  // aged row is inserted aged, and it is put on the OTHER company because this
  // one is already inside its own cooldown window.
  await h.asAdmin();
  await db.query(`insert into private.sc19_trial_auto_checks(company_id,nip,outcome,error_code,checked_at)
    values($1,$2,'unavailable','WHITELIST_TIMEOUT', now() - private.sc19_auto_free_cooldown() - interval '1 minute')`,
    [b.companyId, nipB]);
  // Another company is unaffected anyway: the cooldown is per account, not
  // global, so one company's retry loop cannot stop anybody else activating FREE.
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipB), { allowed: true, reason: null },
    'an attempt older than the cooldown is retryable');

  // A FRESH registry failure keeps the next submission throttled, so the registry
  // is not asked again — for an outage and for a registry refusal alike.
  await h.asUser(users.owner);
  await fail('refused', 'NIP_NOT_FOUND');
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'COOLDOWN' });
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'COOLDOWN' });

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

test('parallel submissions from one owner reach the registry once, not N times', async t => {
  // THE ATTACK (bot review finding 4453447868, 2026-11-03). The cooldown above
  // throttled only SEQUENTIAL retries. public.sc19_auto_free_precheck returned
  // "allowed" BEFORE it took the company lock and wrote no row at all, so N
  // submissions sent at the same time — N browser tabs, or a loop straight
  // against the Data API, which every signed-in owner can call — each saw an
  // empty audit table, each was allowed, and each spent its own call against the
  // public, keyless Ministry of Finance quota that every other company shares.
  const { db, h, a, env } = await ready(t);
  const parallel = 6;
  const sessions = await Promise.all(Array.from({ length: parallel }, () => sessionFor(env, users.owner)));
  const results = await Promise.all(sessions.map(client =>
    client.query('select * from public.sc19_auto_free_precheck($1,$2)', [a.companyId, nipA]).then(r => r.rows[0])));

  // Exactly one caller may go on to the registry; the rest are told to wait.
  const allowed = results.filter(row => row.allowed === true);
  assert.equal(allowed.length, 1, `only one of ${parallel} simultaneous submissions may ask the registry`);
  assert.deepEqual(new Set(results.filter(row => !row.allowed).map(row => row.reason)), new Set(['COOLDOWN']));

  await h.asAdmin();
  // One reservation, and the refusals deduplicated to one row: a burst cannot
  // inflate the audit table either.
  const rows = await call(db, `select outcome,error_code,count(*)::int n from private.sc19_trial_auto_checks
    where company_id=$1 group by 1,2 order by 2`, [a.companyId]);
  assert.deepEqual(rows, [
    { outcome: 'refused', error_code: 'COOLDOWN', n: 1 },
    { outcome: 'unavailable', error_code: 'IN_FLIGHT', n: 1 },
  ]);
  // THE RESERVATION COSTS THE COMPANY NOTHING IT IS ENTITLED TO. It is not a
  // grant, it does not claim the one-NIP-per-account slot (the request can still
  // stop before the registry — a missing server secret, a dead process — and no
  // quota is spent then), and it expires with the cooldown, so an outage delays
  // the company by minutes instead of blocking it.
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances'))[0].n, 0);
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_approvals'))[0].n, 0);
  assert.equal((await call(db, 'select private.sc19_auto_free_other_nip_tried($1,$2) v', [a.companyId, nipB]))[0].v, false,
    'a reservation does not burn the account on that NIP');
  // Shortening the cooldown to nothing stands in for waiting it out: the same
  // company is allowed again, so the reservation is a delay and not a lock.
  await db.query(`create or replace function private.sc19_auto_free_cooldown()
    returns interval language sql immutable set search_path='' as $$ select interval '0 seconds' $$`);
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null },
    'after the cooldown the company may try again');
  assert.ok(nipC, 'the third synthetic NIP stays unused here');
});

test('parallel submissions under REPEATABLE READ cannot ask the registry twice', async t => {
  // WHAT THE SERIALIZATION ABOVE REALLY RESTS ON (fourth review, U1). The
  // reservation only reaches the next caller because READ COMMITTED gives it a
  // fresh snapshot after it waits for the row lock — not because the function is
  // `volatile`, which has nothing to do with snapshots. Reproduced by the
  // reviewer: under REPEATABLE READ the queued caller waits for the lock and
  // then still reads its own transaction-wide snapshot, in which no reservation
  // exists, so four simultaneous prechecks all answered "allowed" and the whole
  // finding came back. `select ... for update` raises nothing there either,
  // because the company row is never UPDATED.
  //
  // Nothing in the repository runs this path at another level today (PostgREST
  // uses READ COMMITTED), so this is a guard against a future default, a pool
  // setting or a caller's own transaction. The function fails closed instead.
  const { db, h, a, env } = await ready(t);
  const parallel = 4;
  const sessions = await Promise.all(Array.from({ length: parallel }, () => sessionFor(env, users.owner)));
  const results = await Promise.all(sessions.map(async client => {
    await client.query('begin isolation level repeatable read');
    try {
      const row = (await client.query('select * from public.sc19_auto_free_precheck($1,$2)', [a.companyId, nipA])).rows[0];
      await client.query('commit');
      return { allowed: row.allowed === true, error: null };
    } catch (error) {
      await client.query('rollback');
      return { allowed: false, error: error.code };
    }
  }));

  // Never "all allowed", which is the failure the reviewer reproduced. Here the
  // guard refuses every one of them, with the same errcode the erasure guards
  // use for the same condition.
  assert.equal(results.filter(row => row.allowed).length, 0,
    'no caller may be allowed at an isolation level where the reservation is invisible');
  assert.deepEqual(new Set(results.map(row => row.error)), new Set(['PT409']),
    'the precheck refuses outright instead of silently letting a second registry call through');

  await h.asAdmin();
  // No reservation was written, so nothing was spent and nothing has to age out.
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_auto_checks where company_id=$1',
    [a.companyId]))[0].n, 0, 'a refused precheck writes no audit row at all');
  // READ COMMITTED, the level this path actually runs at, is untouched by the
  // guard: the normal first submission is still allowed.
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null },
    'the guard does not change the behaviour of the normal path');
});

test('one automatic check is one row in the operator report', async t => {
  // Every successful FREE writes TWO append-only rows: the reservation the
  // precheck makes before it calls the registry, and the registry's answer. The
  // operator used to see both, so each success stood next to a line that reads
  // like an outage (fourth review, U2). The audit table is unchanged and nothing
  // is deleted from it — the report just hides a reservation once a later row
  // for the same company and NIP says how the attempt ended.
  const { db, h, a, b } = await ready(t);
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null });
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');
  await h.asAdmin();
  // Both rows are really in the audit table; only the report collapses them.
  assert.deepEqual(await call(db, `select outcome,error_code from private.sc19_trial_auto_checks
    where company_id=$1 order by checked_at, id`, [a.companyId]), [
    { outcome: 'unavailable', error_code: 'IN_FLIGHT' },
    { outcome: 'granted', error_code: null },
  ], 'the reservation stays in the append-only audit table');
  await h.asUser(operator);
  let rows = await call(db, 'select * from public.sc19_operator_auto_free_grants()');
  assert.deepEqual(rows.map(row => [row.outcome, row.error_code]), [['granted', null]],
    'one event, one row');

  // A reservation with NO answer yet is exactly what the operator must see, so
  // it is still listed. Company B reserves and stops there.
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipB), { allowed: true, reason: null });
  await h.asUser(operator);
  rows = await call(db, 'select * from public.sc19_operator_auto_free_grants()');
  assert.deepEqual(rows.map(row => [row.company_id, row.outcome, row.error_code]), [
    [b.companyId, 'unavailable', 'IN_FLIGHT'],
    [a.companyId, 'granted', null],
  ], 'an unresolved attempt is still shown');

  // AND A COOLDOWN DOES NOT COUNT AS AN ANSWER. Company B submits again while
  // its first attempt is still in flight, which writes a locally decided
  // COOLDOWN row — nothing was asked of the registry to produce it. Before the
  // report excluded the local refusal codes, that row settled the reservation
  // and the company waiting for the register was listed as a refusal instead.
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipB), { allowed: false, reason: 'COOLDOWN' });
  await h.asUser(operator);
  rows = await call(db, 'select * from public.sc19_operator_auto_free_grants()');
  assert.deepEqual(rows.filter(row => row.company_id === b.companyId).map(row => [row.outcome, row.error_code]), [
    ['refused', 'COOLDOWN'],
    ['unavailable', 'IN_FLIGHT'],
  ], 'the attempt in flight is still reported next to the cooldown it caused');
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
  const taken = await call(db, 'select * from public.sc19_operator_taken_trial_nips(null)');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].nip, nipA);
  assert.equal(taken[0].company_id, a.companyId);
  assert.equal(taken[0].free_claimed, true);
  assert.equal(taken[0].source, 'wykaz VAT');

  // AND IT IS SEARCHABLE (bot review finding 4460505084, 2026-11-03). The
  // listing is capped at 200 rows and the release form is rendered from them, so
  // without a search the 201st occupied NIP has no release form anywhere in the
  // panel and the real company keeps being refused its FREE. Reachable by NIP,
  // by company name and by company id; a NIP typed with separators still finds
  // its row, and a needle that matches nothing returns nothing rather than
  // everything.
  const foundBy = async needle =>
    (await call(db, 'select nip from public.sc19_operator_taken_trial_nips($1)', [needle])).map(r => r.nip);
  assert.deepEqual(await foundBy(nipA), [nipA], 'by NIP');
  assert.deepEqual(await foundBy(`${nipA.slice(0, 3)}-${nipA.slice(3, 6)}-${nipA.slice(6)}`), [nipA],
    'by a NIP typed with separators');
  assert.deepEqual(await foundBy(a.companyId), [nipA], 'by company id');
  assert.deepEqual(await foundBy(nipB), [], 'a NIP nobody holds matches nothing, not everything');
  assert.deepEqual(await foundBy('firma-ktorej-nie-ma'), []);
  await assert.rejects(db.query('select * from public.sc19_operator_taken_trial_nips($1)', ['x'.repeat(201)]),
    code('22023'), 'an oversized needle is refused, as in the other operator reports');

  // A reason is mandatory, and an unoccupied NIP cannot be released.
  const release = (nipValue, reasonText, company) =>
    db.query('select * from public.sc19_operator_release_trial_nip($1,$2,$3)', [nipValue, reasonText, company]);
  await assert.rejects(release(nipA, 'krótko', a.companyId), /sc19_release_reason_required/);
  await assert.rejects(release(nipC, 'KRS sprawdzony 2026-11-03', a.companyId), /sc19_trial_nip_not_taken/);
  await assert.rejects(release('123', 'KRS sprawdzony 2026-11-03', a.companyId), code('22023'));
  // The company must be named: the NIP alone would release whoever holds it now.
  await assert.rejects(release(nipA, 'KRS sprawdzony 2026-11-03', null), /sc19_release_company_required/);
  // And it must be the company that really holds it.
  await assert.rejects(release(nipA, 'KRS sprawdzony 2026-11-03', b.companyId), /sc19_trial_nip_holder_changed/);
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_nip_releases'))[0].n, 0,
    'a refused release writes nothing');
  await h.asUser(operator);

  const released = (await call(db, 'select * from public.sc19_operator_release_trial_nip($1,$2,$3)',
    [nipA, 'KRS sprawdzony 2026-11-03: NIP nalezy do innej firmy', a.companyId]))[0];
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
    await assert.rejects(db.query('select * from public.sc19_operator_release_trial_nip($1,$2,$3)',
      [nipA, 'proba nieuprawniona', a.companyId]), code('42501'), who);
    await assert.rejects(db.query('select * from public.sc19_operator_taken_trial_nips(null)'), code('42501'), who);
    await assert.rejects(db.query('select * from public.sc19_operator_trial_nip_releases()'), code('42501'), who);
  }
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select * from public.sc19_operator_taken_trial_nips(null)'), code('42501'), 'anon');
});

test('a released NIP cannot be reoccupied by the company it was taken from', async t => {
  // THE BUG (bot review finding 4454171268, 2026-11-03). The operator releases a
  // NIP precisely when an account with no right to it has occupied another
  // company's single FREE — and he normally gets there BEFORE that account has
  // claimed. The release deleted the approval row and left no trace that this
  // NIP had been taken away from THIS company, so the former holder could submit
  // the very same NIP again, recreate the approval and take the FREE before the
  // real company got there. The release remedied nothing.
  const { db, h, a, b } = await ready(t);

  // Company A occupies the NIP it does not hold, and the operator catches it
  // before the owner has pressed the button: the approval exists, the claim does
  // not. That is the state the release is actually made in.
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');
  await h.asAdmin();
  await db.query('delete from private.sc19_trial_nips where company_id=$1', [a.companyId]);
  await db.query('delete from private.sc19_balances where company_id=$1', [a.companyId]);
  await db.query("delete from private.sc19_credit_journal where company_id=$1 and reason='trial'", [a.companyId]);

  await h.asUser(operator);
  await db.query('select * from public.sc19_operator_release_trial_nip($1,$2,$3)',
    [nipA, 'KRS sprawdzony 2026-11-03: NIP nalezy do innej firmy', a.companyId]);

  // THE REOCCUPATION IS NOW REFUSED, in BOTH automatic admission paths.
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'NIP_RELEASED' });
  assert.deepEqual(await autoClaim(db, a.companyId, nipA),
    { outcome: 'refused', available: null, reason: 'NIP_RELEASED' },
    'and refused when the RPC is called straight through the Data API');
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_approvals where nip=$1', [nipA]))[0].n, 0,
    'no approval row was recreated');
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_trial_nips where nip=$1', [nipA]))[0].n, 0);
  assert.equal((await call(db, 'select count(*)::int n from private.sc19_balances where company_id=$1', [a.companyId]))[0].n, 0,
    'and no FREE was granted a second time');
  // The refusal is audited, so the operator can see the attempt.
  assert.equal((await call(db, "select count(*)::int n from private.sc19_trial_auto_checks where company_id=$1 and error_code='NIP_RELEASED'", [a.companyId]))[0].n, 2);

  // THE REAL COMPANY IS NOT AFFECTED: the guard binds a (NIP, company) pair.
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipA), { allowed: true, reason: null });
  assert.deepEqual(await autoClaim(db, b.companyId, nipA), { outcome: 'granted', available: 5, reason: null });

  // A NIP_RELEASED refusal is decided locally, BEFORE the registry, so it spends
  // no quota and must behave like the other local refusals: it does not start a
  // cooldown and it does not claim the account's one-NIP slot. The proof is
  // above — A's second submission came back 'NIP_RELEASED' and not 'COOLDOWN',
  // which is what a registry-reaching attempt would have produced — plus the
  // shared list both readers consult. (Read as the schema owner: these helpers
  // are deliberately unreachable from anon and authenticated.)
  await h.asAdmin();
  assert.deepEqual((await call(db, 'select private.sc19_auto_free_local_refusal_codes() c'))[0].c,
    ['AUTO_DISABLED', 'NIP_TAKEN', 'ANOTHER_NIP_TRIED', 'COOLDOWN', 'NIP_RELEASED']);
  // A's one-NIP slot is still the NIP it really asked the registry about, and the
  // refusals did not move it.
  assert.equal((await call(db, 'select private.sc19_auto_free_other_nip_tried($1,$2) v', [a.companyId, nipA]))[0].v, false);
  assert.equal((await call(db, 'select private.sc19_auto_free_other_nip_tried($1,$2) v', [a.companyId, nipC]))[0].v, true);
});

test('a stale release form cannot free the NIP of the company that rightfully took it', async t => {
  // THE BUG (bot review finding 4458164495, 2026-11-03). The release took the
  // NIP alone and looked the holder up itself, so it released "whoever holds
  // this NIP right now". The operator panel, though, shows the NIP next to the
  // company holding it, and he submits that line possibly minutes later. In
  // between, a second operator can release the NIP and the company that really
  // owns it can activate FREE on it. The stale submission then hit THAT company:
  // its approval and its claimed FREE deleted, the key of its journal entry
  // rewritten and a NIP_RELEASED block placed on it — the remedy turned against
  // the victim. Nothing in the old signature could tell the two apart.
  const { db, h, a, b } = await ready(t);

  // Company A occupies a NIP it does not hold; the operator opens the page and
  // sees the NIP listed against A. (This is the state his form was rendered in.)
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');
  await h.asUser(operator);
  const page = (await call(db, 'select * from public.sc19_operator_taken_trial_nips(null)'))[0];
  assert.equal(page.company_id, a.companyId, 'the page he is looking at says A holds it');

  // Meanwhile: a second operator releases it, and company B — the real owner —
  // activates FREE on it.
  await db.query('select * from public.sc19_operator_release_trial_nip($1,$2,$3)',
    [page.nip, 'zwolnione przez drugiego operatora 2026-11-03', a.companyId]);
  await h.asUser(users.otherOwner);
  assert.deepEqual(await autoClaim(db, b.companyId, nipA), { outcome: 'granted', available: 5, reason: null });
  await h.asAdmin();
  const before = (await call(db,
    `select (select count(*)::int from private.sc19_trial_nips where company_id=$1) nips,
            (select count(*)::int from private.sc19_trial_approvals where company_id=$1) approvals,
            (select available from private.sc19_balances where company_id=$1) available,
            (select count(*)::int from private.sc19_credit_journal
               where company_id=$1 and reason='trial' and reference=$2) journal`,
    [b.companyId, `trial:${nipA}`]))[0];
  assert.deepEqual(before, { nips: 1, approvals: 1, available: 5, journal: 1 }, 'B holds it properly');

  // NOW the first operator presses "Zwolnij NIP" on his stale page.
  await h.asUser(operator);
  await assert.rejects(db.query('select * from public.sc19_operator_release_trial_nip($1,$2,$3)',
    [page.nip, 'KRS sprawdzony 2026-11-03: NIP nalezy do innej firmy', page.company_id]),
    /sc19_trial_nip_holder_changed/, 'the company he verified no longer holds the NIP');

  // B is untouched in every respect the release would have changed.
  await h.asAdmin();
  assert.deepEqual((await call(db,
    `select (select count(*)::int from private.sc19_trial_nips where company_id=$1) nips,
            (select count(*)::int from private.sc19_trial_approvals where company_id=$1) approvals,
            (select available from private.sc19_balances where company_id=$1) available,
            (select count(*)::int from private.sc19_credit_journal
               where company_id=$1 and reason='trial' and reference=$2) journal`,
    [b.companyId, `trial:${nipA}`]))[0], before, 'nothing of B was taken away or renamed');
  assert.equal((await call(db,
    'select count(*)::int n from private.sc19_trial_nip_releases where released_company_id=$1', [b.companyId]))[0].n, 0,
    'and no NIP_RELEASED block was written against B');
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipA), { allowed: true, reason: null },
    'B carries no NIP_RELEASED block: asking again for the NIP it already holds stays idempotent');
});

test('an operator can give a mistakenly released NIP back, and only an operator can', async t => {
  // The reverse of the guard above: a release made in error must be undoable, or
  // the fix would strand an honest company for ever. The way back is a fresh
  // operator approval — a deliberate, audited act with its own written proof.
  // The automatic path can never clear the guard by itself.
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  assert.equal((await autoClaim(db, a.companyId, nipA)).outcome, 'granted');
  await h.asAdmin();
  await db.query('delete from private.sc19_trial_nips where company_id=$1', [a.companyId]);
  await db.query('delete from private.sc19_balances where company_id=$1', [a.companyId]);
  await db.query("delete from private.sc19_credit_journal where company_id=$1 and reason='trial'", [a.companyId]);
  await h.asUser(operator);
  await db.query('select * from public.sc19_operator_release_trial_nip($1,$2,$3)',
    [nipA, 'zwolnione pomylkowo 2026-11-03', a.companyId]);

  // Blocked, as above...
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'NIP_RELEASED' });
  // ...and the company itself cannot lift the block, however it asks.
  await assert.rejects(db.query('select public.sc19_operator_approve_trial($1,$2,$3)',
    [a.companyId, nipA, 'probuje sam sobie zatwierdzic']), code('42501'), 'the owner cannot approve himself');

  // The operator gives it back.
  await h.asUser(operator);
  const approvedAt = (await call(db, 'select public.sc19_operator_approve_trial($1,$2,$3) at',
    [a.companyId, nipA, 'KRS 0000111111 sprawdzony 2026-11-03, zwolnienie bylo pomylka']))[0].at;
  assert.ok(approvedAt instanceof Date);

  // The guard is lifted, and the company gets its FREE through the reviewed path.
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: true, reason: null });
  assert.equal((await call(db, 'select public.sc19_claim_trial($1,$2) credits', [a.companyId, nipA]))[0].credits, 5);
  await h.asAdmin();
  // The restored approval is recognisably the OPERATOR'S, not the automat's — an
  // approval the automatic path writes does not count as a way back, so the
  // guard cannot clear itself.
  const proof = (await call(db, 'select proof_reference from private.sc19_trial_approvals where nip=$1', [nipA]))[0].proof_reference;
  assert.match(proof, /\[operator:/);
  assert.doesNotMatch(proof, /^mf-biala-lista:/);
  assert.equal((await call(db, 'select private.sc19_auto_free_nip_released_from($1,$2) v', [a.companyId, nipA]))[0].v, false);
});

test('the consent ledger is dated when the customer consented, not when we recorded it', async t => {
  // THE BUG (bot review finding 4454171278, 2026-11-03). The verified declared_at
  // from the signed sign-up snapshot was discarded and the row took the column
  // default, so the ledger dated the consent at ONBOARDING — which happens after
  // e-mail confirmation and can be days later. The ledger exists to prove WHEN
  // the customer consented (GDPR art. 7(1)).
  const { db, h, a, b } = await ready(t);
  const stored = async companyId => {
    await h.asAdmin();
    return (await call(db, 'select occurred_at, source from private.marketing_consent_events where company_id=$1', [companyId]))[0];
  };

  // A consent declared four days before the company existed.
  const declared = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  await h.asUser(users.owner);
  const returned = (await call(db, 'select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6) at',
    [a.companyId, 'marketing-1.0', ...registrationGrant(a.companyId, 'marketing-1.0', declared)]))[0].at;
  assert.equal(returned.toISOString(), declared, 'the function returns the time it stored');
  const row = await stored(a.companyId);
  assert.equal(row.occurred_at.toISOString(), declared, 'the ledger keeps the declared moment');
  assert.equal(row.source, 'registration');
  // The panel reads it back unchanged.
  await h.asUser(users.owner);
  assert.equal((await call(db, 'select * from public.marketing_consent_state($1)', [a.companyId]))[0].occurred_at.toISOString(), declared);

  // A panel click is always stamped now(): there is nothing to back-date.
  await h.asUser(users.otherOwner);
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [b.companyId]);
  const panel = await stored(b.companyId);
  assert.equal(panel.source, 'company_panel');
  assert.ok(Math.abs(panel.occurred_at.getTime() - Date.now()) < 60 * 1000);
});

test('an implausible declared time does not lose the consent, it only loses the date', async t => {
  // FAIL-SAFE, and the bound the migration header states. The declared time is
  // inside the snapshot's HMAC, so it cannot be tampered with; the range check is
  // a sanity limit on our own clocks (60 s ahead, 90 days behind). A value
  // outside it must NOT drop the consent — the customer really gave it — so the
  // row is written with now() instead and the returned value says so.
  const { db, h, a, b } = await ready(t);
  const cases = [
    ['from the future', new Date(Date.now() + 10 * 60 * 1000).toISOString(), a.companyId, users.owner],
    ['absurdly old', new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(), b.companyId, users.otherOwner],
  ];
  for (const [label, outOfRange, companyId, who] of cases) {
    await h.asUser(who);
    const at = (await call(db, 'select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6) at',
      [companyId, 'marketing-1.0', ...registrationGrant(companyId, 'marketing-1.0', outOfRange)]))[0].at;
    assert.notEqual(at.toISOString(), outOfRange, `${label}: not taken at face value`);
    assert.ok(Math.abs(at.getTime() - Date.now()) < 60 * 1000, `${label}: stamped with our own clock instead`);
    await h.asAdmin();
    const rows = await call(db, 'select occurred_at from private.marketing_consent_events where company_id=$1', [companyId]);
    assert.equal(rows.length, 1, `${label}: the consent is kept, never silently dropped`);
    assert.equal(rows[0].occurred_at.toISOString(), at.toISOString());
  }
  // No declared time at all behaves the same way: recorded, stamped now().
  const { db: db2, h: h2, a: a2 } = await ready(t);
  await h2.asUser(users.owner);
  const undated = (await call(db2, 'select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6) at',
    [a2.companyId, 'marketing-1.0', ...registrationGrant(a2.companyId, 'marketing-1.0', null)]))[0].at;
  assert.ok(Math.abs(undated.getTime() - Date.now()) < 60 * 1000);
  await h2.asAdmin();
  assert.equal((await call(db2, 'select count(*)::int n from private.marketing_consent_events where company_id=$1', [a2.companyId]))[0].n, 1);
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
  const first = (await call(db, "select public.marketing_consent_grant_registration($1,'marketing-1.0',$2,$3,$4,$5) at",
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

test('a withdrawal recorded after a grant wins even when the grant is stamped later', async t => {
  // THE BUG (bot review finding 4458164489, 2026-11-03). occurred_at is the
  // moment the customer declared the consent, and for a registration grant it
  // arrives from the client inside the signed snapshot, so
  // private.marketing_consent_record tolerates up to 60 s AHEAD of the database
  // clock. While every reader picked the current event by
  // `order by occurred_at desc, id desc`, a grant stored with a future time beat
  // a withdrawal made a second later with the database's own now(), and `id` is
  // gen_random_uuid(), so the tiebreak was a coin toss rather than a rescue.
  // Waiting could not clear it: the stored order never changes. GDPR art. 7(3)
  // gives the customer the right to withdraw at any time, so the withdrawal must
  // win whatever the clocks said. The current state is now decided by
  // recorded_seq, the identity column that follows the write order.
  const { db, h, a } = await ready(t);
  await h.asUser(users.owner);
  // 30 s ahead: inside the tolerance, so the row really is stored with it.
  const ahead = new Date(Date.now() + 30_000).toISOString();
  const granted = (await call(db, "select public.marketing_consent_grant_registration($1,'marketing-1.0',$2,$3,$4,$5) at",
    [a.companyId, ...registrationGrant(a.companyId, 'marketing-1.0', ahead)]))[0].at;
  assert.equal(granted.toISOString(), ahead, 'the declared time is stored as declared, not replaced by now()');
  const withdrawn = (await call(db, 'select public.marketing_consent_withdraw($1) at', [a.companyId]))[0].at;
  assert.ok(withdrawn < granted,
    `the withdrawal must be stamped EARLIER than the grant for this test to mean anything (${withdrawn.toISOString()} vs ${ahead})`);

  // The company panel shows the withdrawal, not the newer-looking grant.
  assert.equal((await call(db, 'select * from public.marketing_consent_state($1)', [a.companyId]))[0].event, 'withdrawn',
    'the panel must show the consent as withdrawn');
  // So does the operator report.
  await h.asUser(operator);
  const report = await call(db, 'select * from public.sc19_operator_marketing_consents(null)');
  assert.equal(report.length, 1);
  assert.equal(report[0].event, 'withdrawn', 'the operator report must show the consent as withdrawn');
  // And the withdrawal RPC itself agrees there is nothing left to withdraw.
  await h.asUser(users.owner);
  await assert.rejects(db.query('select public.marketing_consent_withdraw($1)', [a.companyId]),
    /marketing_consent_not_active/, 'a second withdrawal is refused, so the writer sees the same state');

  // The history keeps BOTH timestamps exactly as they happened, and the write
  // order is the strictly increasing column, never the time.
  await h.asAdmin();
  const history = await call(db,
    'select event,occurred_at,recorded_seq from private.marketing_consent_events where company_id=$1 order by recorded_seq',
    [a.companyId]);
  assert.deepEqual(history.map(row => row.event), ['granted', 'withdrawn']);
  assert.equal(history[0].occurred_at.toISOString(), ahead, 'occurred_at is untouched: it is the signed fact');
  assert.ok(history[1].recorded_seq > history[0].recorded_seq, 'recorded_seq follows the write order');

  // Re-granting still works and is seen, even though its now() is EARLIER than
  // the first row's declared time: the write order decides here too.
  await h.asUser(users.owner);
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]);
  assert.equal((await call(db, 'select * from public.marketing_consent_state($1)', [a.companyId]))[0].event, 'granted');
  await h.asAdmin();
  const latest = (await call(db,
    'select event,occurred_at,recorded_seq from private.marketing_consent_events where company_id=$1 order by recorded_seq desc limit 1',
    [a.companyId]))[0];
  assert.equal(latest.event, 'granted');
  assert.ok(latest.occurred_at < history[0].occurred_at, 'the newest row is the OLDEST by occurred_at');
  assert.ok(latest.recorded_seq > history[1].recorded_seq);
});

test('a withdrawn consent cannot be resurrected by replaying the registration grant', async t => {
  // THE ATTACK (bot review finding 4453447875, 2026-11-03). The sign-up snapshot
  // that authorizes a 'registration' row lives in user_metadata, has no expiry
  // and no one-time marker, and public.ensure_initial_company returns the
  // EXISTING company when the Server Action runs again — which Next.js resolves
  // from any route, not only from /onboarding. So the owner could withdraw the
  // consent and then replay that action: before this fix the ledger appended a
  // fresh 'granted' row with source 'registration' and the current time, putting
  // the company back on the marketing list without a new, deliberate act and
  // certifying that the consent was declared "at registration" at a moment when
  // no registration form existed (GDPR art. 7(1), 7(3)).
  const { db, h, a } = await ready(t);
  const replay = () => db.query('select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6) at',
    [a.companyId, 'marketing-1.0', ...registrationGrant(a.companyId, 'marketing-1.0')]).then(r => r.rows[0].at);
  const events = async () => {
    await h.asAdmin();
    return call(db, 'select event,source from private.marketing_consent_events where company_id=$1 order by occurred_at, id', [a.companyId]);
  };

  await h.asUser(users.owner);
  const first = await replay();
  // An honest double submit of the SAME first grant is tolerated: it appends
  // nothing and returns the consent in force, so a double click is not an error.
  assert.deepEqual(await replay(), first);
  assert.deepEqual(await events(), [{ event: 'granted', source: 'registration' }]);

  await h.asUser(users.owner);
  await db.query('select public.marketing_consent_withdraw($1)', [a.companyId]);
  // THE REPLAY IS NOW REFUSED, by the database and not by the route.
  await assert.rejects(replay(), code('22023'), 'the sign-up snapshot is one-shot');
  await assert.rejects(replay(), code('22023'), 'and stays refused');
  assert.deepEqual(await events(), [
    { event: 'granted', source: 'registration' },
    { event: 'withdrawn', source: 'company_panel' },
  ], 'not one new registration row');
  await h.asUser(users.owner);
  assert.equal((await call(db, 'select * from public.marketing_consent_state($1)', [a.companyId]))[0].event, 'withdrawn',
    'the consent stays withdrawn');

  // WITHDRAWAL AND A LATER RE-GRANT STILL WORK — from the panel, under the
  // provenance that is true of them: the company gave it again in the panel.
  await db.query("select public.marketing_consent_grant($1,'marketing-1.0')", [a.companyId]);
  assert.deepEqual(await events(), [
    { event: 'granted', source: 'registration' },
    { event: 'withdrawn', source: 'company_panel' },
    { event: 'granted', source: 'company_panel' },
  ]);
  // And with an active panel consent the registration replay is refused too: a
  // consent given in the panel is never re-labelled as given at sign-up.
  await h.asUser(users.owner);
  await assert.rejects(replay(), code('22023'));

  // The guarantee does not rest on the function body alone. Even a direct insert
  // — which only the schema owner can make — cannot add a second registration row.
  await h.asAdmin();
  await assert.rejects(db.query(`insert into private.marketing_consent_events(company_id,event,consent_version,consent_text,source)
    values($1,'granted','marketing-1.0',private.marketing_consent_text('marketing-1.0'),'registration')`, [a.companyId]),
  code('23505'), 'at most one registration row per company, enforced by a unique index');
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
  const DECLARED = '2026-11-03T08:00:00.000Z';
  const bare = [a.companyId, 'marketing-1.0', '-'].join('\n');
  const unsigned = [
    ['no signature', [null, randomUUID(), Date.now(), '0'.repeat(64)]],
    ['an invented signature', [null, randomUUID(), Date.now(), 'f'.repeat(64)]],
    ['an empty signature', [null, randomUUID(), Date.now(), '']],
    // A signature for another operation sharing the same secret is not this one.
    ['a claim signature', (() => { const id = randomUUID(), at = Date.now();
      return [null, id, at, signTrialAuto('auto_claim', id, at, bare, SECRET)]; })()],
    // The snapshot label is deliberately outside the database's whitelist.
    ['a snapshot signature', (() => { const id = randomUUID(), at = Date.now();
      return [null, id, at, signTrialAuto('consent', id, at, bare, SECRET)]; })()],
    // Valid signature, but for a different company and a different version.
    ['another company', registrationGrant(randomUUID(), 'marketing-1.0')],
    ['another version', registrationGrant(a.companyId, 'marketing-9.9')],
    // THE DECLARED TIME IS INSIDE THE SIGNATURE (bot review finding,
    // 2026-11-03). It reaches the database as a request parameter and it is the
    // fact the ledger exists to prove, so an owner reaching this RPC through the
    // Data API must not be able to choose the date his consent is recorded
    // under. A request signed for one moment, presented with another, is refused.
    ['a time swapped after signing', (() => {
      const [, id, at, sig] = registrationGrant(a.companyId, 'marketing-1.0', DECLARED);
      return ['2026-10-01T08:00:00.000Z', id, at, sig]; })()],
    ['a time added after signing', (() => {
      const [, id, at, sig] = registrationGrant(a.companyId, 'marketing-1.0', null);
      return [DECLARED, id, at, sig]; })()],
    ['a time removed after signing', (() => {
      const [, id, at, sig] = registrationGrant(a.companyId, 'marketing-1.0', DECLARED);
      return [null, id, at, sig]; })()],
    // Outside the 60 s window.
    ['an expired request', (() => { const id = randomUUID(), at = Date.now() - 10 * 60 * 1000;
      return [null, id, at, signTrialAuto('consent_registration', id, at, bare, SECRET)]; })()],
  ];
  for (const [label, args] of unsigned) {
    await assert.rejects(db.query('select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6)',
      [a.companyId, 'marketing-1.0', ...args]), code('42501'), label);
  }
  await h.asAdmin();
  assert.equal((await call(db, 'select count(*)::int n from private.marketing_consent_events'))[0].n, 0,
    'not one forged provenance reached the ledger');

  // A signature is not a substitute for being the owner either.
  for (const who of [users.recruiter, users.otherOwner]) {
    await h.asUser(who);
    await assert.rejects(db.query('select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6)',
      [a.companyId, 'marketing-1.0', ...registrationGrant(a.companyId, 'marketing-1.0')]), code('42501'), who);
  }
  await h.asUser(null, 'anon');
  await assert.rejects(db.query('select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6)',
    [a.companyId, 'marketing-1.0', ...signed]), code('42501'), 'anon');

  // THE LEGITIMATE PATH STILL WORKS: owner plus a fresh server signature.
  await h.asUser(users.owner);
  const at = (await call(db, 'select public.marketing_consent_grant_registration($1,$2,$3,$4,$5,$6) at',
    [a.companyId, 'marketing-1.0', ...registrationGrant(a.companyId, 'marketing-1.0')]))[0].at;
  assert.ok(at instanceof Date);
  await h.asAdmin();
  const rows = await call(db, 'select event,source from private.marketing_consent_events where company_id=$1', [a.companyId]);
  assert.deepEqual(rows, [{ event: 'granted', source: 'registration' }]);
  assert.ok(signed.length === 4, 'the signed request is four values: declared time, id, request time, HMAC');
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

  const window = await digestWindow(db);
  const run = (signature, id, at) => db.query('select * from public.sc19_daily_digest($1,$2,$3,$4,$5)',
    [window.start, window.end, id, at, signature]).then(r => r.rows[0]);

  const requestId = randomUUID(), issuedAtMs = Date.now();
  const payload = digestPayload(window);
  // Unsigned and wrongly signed callers get nothing, including the operator.
  await assert.rejects(run('0'.repeat(64), requestId, issuedAtMs), code('42501'));
  await assert.rejects(run(signTrialAuto('auto_claim', requestId, issuedAtMs, payload, SECRET), requestId, issuedAtMs),
    code('42501'), 'a claim signature is not a digest signature');

  await h.asUser(null, 'anon');
  const counts = await run(signTrialAuto('digest', requestId, issuedAtMs, payload, SECRET), requestId, issuedAtMs);
  assert.deepEqual(Object.keys(counts).sort(), ['auto_free', 'awaiting_manual', 'marketing_consents', 'registered']);
  assert.equal(counts.registered, 2, 'both seeded companies');
  assert.equal(counts.auto_free, 1);
  // COMPANY B NEVER ASKED FOR FREE, so it is not in the manual queue (bot review
  // finding, 2026-11-03). The old count was "every company created in the window
  // with no approval row", which reported it as waiting — and this is the number
  // the owner reads every evening and acts on.
  assert.equal(counts.awaiting_manual, 0, 'a company that never asked is not in the queue');
  assert.equal(counts.marketing_consents, 1);
  assert.ok(b.companyId);

  // A nonsense window is refused before anything is read.
  const bad = randomUUID(), badAt = Date.now();
  await assert.rejects(db.query('select * from public.sc19_daily_digest($1,$2,$3,$4,$5)',
    [window.end, window.start, bad, badAt, 'x'.repeat(64)]), code('22023'), 'reversed window');
});

test('the manual-review count holds only companies that asked and are still waiting', async t => {
  // THE BUG (bot review finding 4454171288, 2026-11-03). The count was "every
  // company created in the window with no approval row", so it swept in a
  // company that never asked for FREE and one that had already bought a paid
  // pack. This is the one number in a mail the owner reads every evening at
  // 19:00 and acts on, so an inflated queue makes the whole mail useless.
  //
  // The automat is OFF here, which is how the owner will actually run it at
  // first: every submission is refused locally with 'AUTO_DISABLED' and is
  // exactly what needs a human.
  const { db, h, a, b } = await ready(t, { enabled: false });
  // The window ends at the database's own `now()`, not at new Date() — see
  // digestWindow() above for why a millisecond is the difference between this
  // test measuring the count and measuring the clock.
  async function digest(window) {
    const asked = window ?? await digestWindow(db);
    const id = randomUUID(), at = Date.now();
    const signature = signTrialAuto('digest', id, at, digestPayload(asked), SECRET);
    await h.asUser(null, 'anon');
    return (await call(db, 'select * from public.sc19_daily_digest($1,$2,$3,$4,$5)',
      [asked.start, asked.end, id, at, signature])).at(0);
  }

  // Two companies exist and NEITHER has asked for anything.
  assert.equal((await digest()).awaiting_manual, 0, 'nobody asked, nobody is waiting');
  assert.equal((await digest()).registered, 2, 'they are still counted as new companies');

  // Company A submits its NIP. The automat is off, so it goes to the manual list.
  await h.asUser(users.owner);
  assert.deepEqual(await precheck(db, a.companyId, nipA), { allowed: false, reason: 'AUTO_DISABLED' });
  assert.equal((await digest()).awaiting_manual, 1, 'a company that asked and has no approval is waiting');
  // Asking twice is one company in the queue, not two.
  await h.asUser(users.owner);
  await precheck(db, a.companyId, nipA);
  assert.equal((await digest()).awaiting_manual, 1, 'counted once per company, not once per submission');

  // The operator verifies it: it leaves the queue.
  await h.asUser(operator);
  await db.query('select public.sc19_operator_approve_trial($1,$2,$3)',
    [a.companyId, nipA, 'KRS 0000111111 sprawdzony 2026-11-03']);
  assert.equal((await digest()).awaiting_manual, 0, 'an approved company is no longer waiting');

  // A company that asked but already has a PAID pack is a customer, not a queue
  // entry — and public.sc19_claim_trial would refuse it a late FREE anyway.
  await h.asUser(users.otherOwner);
  assert.deepEqual(await precheck(db, b.companyId, nipB), { allowed: false, reason: 'AUTO_DISABLED' });
  assert.equal((await digest()).awaiting_manual, 1, 'a company that asked and has not been resolved is waiting');
  await h.asAdmin();
  await db.query("insert into private.sc19_package_policy(plan,credits) values('PRESELEKCJA',60)");
  await h.asUser(operator);
  await db.query('select public.sc19_operator_grant_paid($1,$2)', [b.companyId, 'FV/2026/11/0001']);
  assert.equal((await digest()).awaiting_manual, 0, 'a paying customer is not in the manual queue');

  // THE WINDOW IS HALF-OPEN, [start, end), and the two bounds are asserted here
  // with timestamps written BY HAND instead of being left to whatever the clock
  // happens to do — which is what used to make this test fail on CI and pass
  // locally. It matters beyond tidiness: consecutive daily windows share a
  // bound, so a request stamped exactly on it must be counted by exactly one of
  // the two mails. Counted by both would double the queue; by neither would lose
  // the company entirely.
  // Two more companies, so neither bound needs a row removed afterwards: the
  // audit table is append-only and refuses a delete.
  const onStart = await h.seed(users.recruiter), onEnd = await h.seed(users.viewer);
  await h.asAdmin();
  const bounds = await digestWindow(db);
  for (const [company, at] of [[onStart, bounds.start], [onEnd, bounds.end]]) {
    await db.query(
      `insert into private.sc19_trial_auto_checks(company_id,nip,outcome,error_code,checked_at)
       values($1,$2,'refused','AUTO_DISABLED',$3::timestamptz)`, [company.companyId, nipC, at]);
  }
  assert.equal((await digest(bounds)).awaiting_manual, 1,
    'exactly the request stamped on the start bound is in this window; the one on the end bound is in the next');
});

test('the erasure inventory still matches after the new tables', async t => {
  const env = await bootMigrationDatabase(t);
  // This historical contract compares the exact R11 output. The normal ready()
  // fixture and current competency migration suite still replay the full chain.
  await setupRankingDatabase(env.db, { throughMigration: '20261103090100_sc_erasure_inventory_r11.sql' });
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
  'public.sc19_operator_taken_trial_nips(text)': ['authenticated'],
  'public.sc19_operator_release_trial_nip(text,text,uuid)': ['authenticated'],
  'public.sc19_operator_trial_nip_releases()': ['authenticated'],
  'public.marketing_consent_grant(uuid,text)': ['authenticated'],
  'public.marketing_consent_grant_registration(uuid,text,timestamptz,uuid,bigint,text)': ['authenticated'],
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
    'public.sc19_operator_release_trial_nip(text,text,uuid)',
    'public.marketing_consent_grant_registration(uuid,text,timestamptz,uuid,bigint,text)',
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
    'private.marketing_consent_record(uuid,text,text,uuid,timestamptz)',
    'private.sc19_auto_free_cooldown()',
    'private.sc19_auto_free_local_refusal_codes()',
    'private.sc19_auto_free_other_nip_tried(uuid,text)',
    'private.sc19_auto_free_nip_released_from(uuid,text)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await call(db, 'select has_function_privilege($1,$2,$3) v', [role, fn, 'execute']))[0].v, false, `${role} ${fn}`);
    }
  }
});

const rollback = name => readFileSync(new URL(`../supabase/rollbacks/${name}`, import.meta.url), 'utf8');
const forward = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('both rollbacks run in order, restore the reviewed R10 state and re-apply', async t => {
  const env = await bootMigrationDatabase(t);
  await setupRankingDatabase(env.db, { throughMigration: '20261103090100_sc_erasure_inventory_r11.sql' });
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
  await setupRankingDatabase(env.db, { throughMigration: '20261103090100_sc_erasure_inventory_r11.sql' });
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
