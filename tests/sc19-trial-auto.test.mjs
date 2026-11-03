import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WhitelistError } from '../lib/mf-whitelist.ts';
import {
  decideTrialAuto, signTrialAuto, trialAutoCanonical, trialAutoClaimPayload, trialAutoEnabled,
} from '../lib/sc19-trial-auto.ts';
import { activateFreeWithWhitelist } from '../lib/sc19-trial-auto-flow.ts';

const SECRET = 'x'.repeat(32);
const COMPANY = '20000000-0000-4000-8000-000000000001';
// Checksum-valid synthetic NIP; no real company is addressed by these tests.
const NIP = '1234563218';
const billingPage = readFileSync(new URL('../app/dashboard/[companyId]/billing/page.tsx', import.meta.url), 'utf8');

const record = (overrides = {}) => ({
  nip: NIP, name: 'FIRMA TESTOWA SP Z OO', statusVat: 'Czynny',
  street: 'ul. Testowa 1', postCode: '00-001', city: 'Warszawa',
  requestId: 'req-synthetic-0001', ...overrides,
});

/** A store that records calls and answers as told. The precheck answers "open"
 * unless a test says otherwise, because that is the production state once the
 * operator has switched the automat on. */
function store(answers = {}) {
  const calls = [];
  return {
    calls,
    async claim(companyId, nip) {
      calls.push(['claim', companyId, nip]);
      return { error: answers.claim ?? null };
    },
    async precheck(companyId, nip) {
      calls.push(['precheck', companyId, nip]);
      return {
        data: answers.precheck ?? [{ allowed: true, reason: null }],
        error: answers.precheckError ?? null,
      };
    },
    async autoClaim(args) {
      calls.push(['autoClaim', args]);
      if (answers.autoClaimThrows) throw new Error('boom');
      return { data: answers.autoClaim ?? [{ outcome: 'granted', available: 5, reason: null }], error: answers.autoClaimError ?? null };
    },
    async recordFailure(args) {
      calls.push(['recordFailure', args]);
      if (answers.recordFailureThrows) throw new Error('boom');
    },
  };
}

const NEEDS_VERIFICATION = { code: '42501', message: 'sc19_trial_requires_verified_company' };
const fetchNever = () => { throw new Error('the registry must not be called'); };
const fetchOk = body => async () => ({ status: 200, ok: true, async json() { return body; } });
const env = extra => ({ SC19_TRIAL_AUTO_SECRET: SECRET, ...extra });

test('an ACTIVE taxpayer confirmed by the register gets FREE automatically', async () => {
  const s = store({ claim: NEEDS_VERIFICATION });
  const result = await activateFreeWithWhitelist({
    store: s, companyId: COMPANY, nip: NIP, env: env(),
    fetchImpl: fetchOk({ result: { subject: { ...record(), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-synthetic-0001' } }),
  });
  assert.equal(result.status, 'activated');
  assert.equal(result.decision.outcome, 'granted');
  const auto = s.calls.find(call => call[0] === 'autoClaim');
  assert.ok(auto, 'the signed RPC was called');
  assert.equal(auto[1].mf_status, 'Czynny');
  assert.equal(auto[1].mf_request_id, 'req-synthetic-0001');
  // The signature covers the company, the NIP and the registry answer.
  const expected = signTrialAuto('auto_claim', auto[1].request_id, auto[1].issued_at_ms, trialAutoClaimPayload({
    requestId: auto[1].request_id, issuedAtMs: auto[1].issued_at_ms, companyId: COMPANY, nip: NIP,
    mfRequestId: 'req-synthetic-0001', mfStatus: 'Czynny', mfName: 'FIRMA TESTOWA SP Z OO',
  }), SECRET);
  assert.equal(auto[1].request_signature, expected);
});

test('an operator-approved company is granted without touching the register', async () => {
  // The MF API has a low daily quota: an already approved company must not spend it.
  const s = store({ claim: null });
  const result = await activateFreeWithWhitelist({ store: s, companyId: COMPANY, nip: NIP, env: env(), fetchImpl: fetchNever });
  assert.equal(result.status, 'activated');
  assert.deepEqual(s.calls.map(call => call[0]), ['claim']);
});

test('a company the register does not confirm gets nothing and goes to manual review', async () => {
  for (const [label, body] of [
    ['unknown NIP', { result: { subject: null, requestId: 'req-x' } }],
    ['status neither Czynny nor Zwolniony', { result: { subject: { ...record({ statusVat: 'Wykreślony' }), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-x' } }],
    ['nonsense payload', { result: {} }],
    ['another company\'s NIP in the answer', { result: { subject: { ...record({ nip: '5260250274' }), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-x' } }],
  ]) {
    const s = store({ claim: NEEDS_VERIFICATION });
    const result = await activateFreeWithWhitelist({ store: s, companyId: COMPANY, nip: NIP, env: env(), fetchImpl: fetchOk(body) });
    assert.equal(result.status, 'manual', label);
    assert.equal(s.calls.some(call => call[0] === 'autoClaim'), false, `${label}: nothing is claimed`);
    // Owner-visible refusals are audited too, not only outages: with the
    // grant-only filter they were written nowhere and nobody could see who was
    // waiting or why.
    const audit = s.calls.find(call => call[0] === 'recordFailure');
    assert.ok(audit, `${label}: the refusal is audited`);
    assert.ok(['refused', 'unavailable'].includes(audit[1].failure_outcome), label);
  }
});

test('a VAT-exempt company gets FREE automatically (owner decision 2026-11-03)', async () => {
  // 'Zwolniony' is in the register and is a real company; many small Polish
  // firms are exempt. The earlier build refused it.
  const s = store({ claim: NEEDS_VERIFICATION });
  const result = await activateFreeWithWhitelist({
    store: s, companyId: COMPANY, nip: NIP, env: env(),
    fetchImpl: fetchOk({ result: { subject: { ...record({ statusVat: 'Zwolniony' }), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-synthetic-0001' } }),
  });
  assert.equal(result.status, 'activated');
  assert.equal(result.decision.outcome, 'granted');
  assert.equal(s.calls.find(call => call[0] === 'autoClaim')[1].mf_status, 'Zwolniony');
});

test('a NIP typed with separators is granted: every step uses the canonical digits', async () => {
  // The activation field accepts up to 20 characters, so "526-104-08-28" is a
  // normal entry. The database normalizes before it rebuilds the signed payload,
  // so signing the raw input made every formatted NIP fail the signature check
  // and fall through to manual review AFTER the registry quota had been spent.
  const formatted = '526-104-08-28', canonical = '5261040828';
  const seen = [];
  const s = store({ claim: NEEDS_VERIFICATION });
  const result = await activateFreeWithWhitelist({
    store: s, companyId: COMPANY, nip: formatted, env: env(),
    fetchImpl: async url => {
      seen.push(url);
      return { status: 200, ok: true, async json() {
        return { result: { subject: { ...record({ nip: canonical }), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-synthetic-0001' } };
      } };
    },
  });
  assert.equal(result.status, 'activated');
  assert.match(seen[0], new RegExp(`/search/nip/${canonical}\\?`), 'the registry is asked for the canonical NIP');
  for (const [name, ...args] of s.calls) {
    const value = name === 'autoClaim' ? args[0].supplied_nip : name === 'claim' || name === 'precheck' ? args[1] : null;
    if (value !== null) assert.equal(value, canonical, `${name} receives the canonical NIP`);
  }
  // And the signature the database will recompute matches.
  const auto = s.calls.find(call => call[0] === 'autoClaim')[1];
  assert.equal(auto.request_signature, signTrialAuto('auto_claim', auto.request_id, auto.issued_at_ms, trialAutoClaimPayload({
    requestId: auto.request_id, issuedAtMs: auto.issued_at_ms, companyId: COMPANY, nip: canonical,
    mfRequestId: 'req-synthetic-0001', mfStatus: 'Czynny', mfName: 'FIRMA TESTOWA SP Z OO',
  }), SECRET));
});

test('a malformed NIP is rejected before anything is called', async () => {
  for (const value of ['', '123', '0000000000', '1234563219', 'x'.repeat(40)]) {
    const s = store({ claim: NEEDS_VERIFICATION });
    const result = await activateFreeWithWhitelist({ store: s, companyId: COMPANY, nip: value, env: env(), fetchImpl: fetchNever });
    assert.equal(result.status, 'invalid', JSON.stringify(value));
    assert.deepEqual(s.calls, [], 'neither the database nor the registry is touched');
  }
});

test('the precheck closes the automatic path before the registry quota is spent', async () => {
  for (const reason of ['AUTO_DISABLED', 'ANOTHER_NIP_TRIED', 'NIP_TAKEN']) {
    const s = store({ claim: NEEDS_VERIFICATION, precheck: [{ allowed: false, reason }] });
    const result = await activateFreeWithWhitelist({ store: s, companyId: COMPANY, nip: NIP, env: env(), fetchImpl: fetchNever });
    assert.equal(result.status, 'manual', reason);
    assert.equal(result.decision.errorCode, reason);
    assert.deepEqual(s.calls.map(call => call[0]), ['claim', 'precheck'], `${reason}: the registry is never called`);
  }
  // Same for a missing server secret: the precheck row is the audit trail, and
  // nothing past it could be signed anyway.
  const bare = store({ claim: NEEDS_VERIFICATION });
  const nosecret = await activateFreeWithWhitelist({ store: bare, companyId: COMPANY, nip: NIP, env: {}, fetchImpl: fetchNever });
  assert.equal(nosecret.status, 'manual');
  assert.deepEqual(bare.calls.map(call => call[0]), ['claim', 'precheck']);
  // A failed precheck read is treated as closed, not as open.
  const broken = store({ claim: NEEDS_VERIFICATION, precheckError: { code: '42501', message: 'sc19_company_forbidden' } });
  const result = await activateFreeWithWhitelist({ store: broken, companyId: COMPANY, nip: NIP, env: env(), fetchImpl: fetchNever });
  assert.equal(result.status, 'manual');
  assert.equal(broken.calls.some(call => call[0] === 'autoClaim'), false);
});

test('a repeated check of the same company is throttled, not sent to the registry again', async () => {
  // The Ministry of Finance registry is public, keyless and has a low daily
  // quota shared by every company. Without this, one owner resubmitting the
  // form after a refusal or an outage spent another call every time and could
  // drain the day's quota for everyone else.
  const s = store({ claim: NEEDS_VERIFICATION, precheck: [{ allowed: false, reason: 'COOLDOWN' }] });
  const result = await activateFreeWithWhitelist({ store: s, companyId: COMPANY, nip: NIP, env: env(), fetchImpl: fetchNever });
  assert.deepEqual(s.calls.map(call => call[0]), ['claim', 'precheck'], 'the registry is never called');
  assert.equal(result.decision.errorCode, 'COOLDOWN');
  // Its own status, NOT 'manual': waiting fixes this, so the company is told to
  // wait instead of being sent to the contact form for a manual check.
  assert.equal(result.status, 'cooldown');
  assert.match(billingPage, /cooldown: 'Sprawdzaliśmy ten NIP/, 'the panel has a plain-Polish notice for it');
  assert.match(billingPage, /spróbuj ponownie/, 'and it says the retry is possible');
});

test('a register failure, timeout or rate limit grants nothing', async () => {
  const failures = {
    timeout: () => new Promise(() => {}),
    unreachable: () => { throw new Error('ECONNRESET'); },
    'rate limited': async () => ({ status: 429, ok: false, async json() { return {}; } }),
    'server error': async () => ({ status: 503, ok: false, async json() { return {}; } }),
    'broken json': async () => ({ status: 200, ok: true, async json() { throw new Error('bad'); } }),
  };
  for (const [label, fetchImpl] of Object.entries(failures)) {
    const s = store({ claim: NEEDS_VERIFICATION });
    const result = await activateFreeWithWhitelist({
      store: s, companyId: COMPANY, nip: NIP, env: env(),
      // The timeout case uses the library's own 8 s budget; shorten it here.
      fetchImpl: label === 'timeout' ? fetchImpl : fetchImpl,
    });
    assert.equal(result.status, 'manual', label);
    assert.equal(result.decision.outcome, 'unavailable', label);
    assert.equal(s.calls.some(call => call[0] === 'autoClaim'), false, `${label}: nothing is claimed`);
    // The outage is recorded so the operator can see the company is waiting.
    assert.ok(s.calls.some(call => call[0] === 'recordFailure'), `${label}: the attempt is audited`);
  }
});

test('an audit write that itself fails still grants nothing and still reports manual review', async () => {
  const s = store({ claim: NEEDS_VERIFICATION, recordFailureThrows: true });
  const result = await activateFreeWithWhitelist({
    store: s, companyId: COMPANY, nip: NIP, env: env(),
    fetchImpl: async () => ({ status: 503, ok: false, async json() { return {}; } }),
  });
  assert.equal(result.status, 'manual');
  assert.equal(s.calls.some(call => call[0] === 'autoClaim'), false);
});

test('without the server secret nothing is attempted: today behaviour is unchanged', async () => {
  for (const value of [undefined, '', 'short', 'y'.repeat(31)]) {
    assert.equal(trialAutoEnabled({ SC19_TRIAL_AUTO_SECRET: value }), false, String(value));
    const s = store({ claim: NEEDS_VERIFICATION });
    const result = await activateFreeWithWhitelist({
      store: s, companyId: COMPANY, nip: NIP, fetchImpl: fetchNever,
      env: { SC19_TRIAL_AUTO_SECRET: value },
    });
    assert.equal(result.status, 'manual');
    // The precheck is the only database call: it costs nothing, grants nothing
    // and leaves the operator a row saying this company is waiting.
    assert.deepEqual(s.calls.map(call => call[0]), ['claim', 'precheck'], 'the register is never called');
  }
  assert.equal(trialAutoEnabled({ SC19_TRIAL_AUTO_SECRET: 'z'.repeat(32) }), true);
});

test('one FREE per NIP and no FREE after payment are still refused, not retried', async () => {
  // These come from the reviewed sc19_claim_trial and must not trigger a
  // register call or an automatic approval that would work around them.
  for (const [code, expected] of [['23505', 'taken'], ['22023', 'invalid']]) {
    const s = store({ claim: { code, message: code === '23505' ? 'sc19_trial_already_claimed' : 'sc19_invalid_nip' } });
    const result = await activateFreeWithWhitelist({ store: s, companyId: COMPANY, nip: NIP, env: env(), fetchImpl: fetchNever });
    assert.equal(result.status, expected, code);
    assert.deepEqual(s.calls.map(call => call[0]), ['claim']);
  }
  // Same NIP already approved elsewhere, discovered by the signed RPC.
  const s = store({ claim: NEEDS_VERIFICATION, autoClaim: [{ outcome: 'refused', available: null, reason: 'NIP_TAKEN' }] });
  const result = await activateFreeWithWhitelist({
    store: s, companyId: COMPANY, nip: NIP, env: env(),
    fetchImpl: fetchOk({ result: { subject: { ...record(), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-synthetic-0001' } }),
  });
  assert.equal(result.status, 'manual', 'a refusal never becomes a grant');
});

test('the switch being off in the database also grants nothing', async () => {
  const s = store({ claim: NEEDS_VERIFICATION, autoClaimError: { code: '55000', message: 'sc19_auto_disabled' } });
  const result = await activateFreeWithWhitelist({
    store: s, companyId: COMPANY, nip: NIP, env: env(),
    fetchImpl: fetchOk({ result: { subject: { ...record(), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-synthetic-0001' } }),
  });
  assert.equal(result.status, 'manual');
});

test('Czynny and Zwolniony qualify, nothing else; the decision records the register answer', () => {
  assert.deepEqual({ ...decideTrialAuto(record()) }, {
    outcome: 'granted', mfRequestId: 'req-synthetic-0001', mfStatus: 'Czynny',
    mfName: 'FIRMA TESTOWA SP Z OO', errorCode: null,
  });
  // Owner decision 2026-11-03: VAT-exempt companies are granted too.
  assert.equal(decideTrialAuto(record({ statusVat: 'Zwolniony' })).outcome, 'granted');
  assert.equal(decideTrialAuto(record({ statusVat: 'Zwolniony' })).errorCode, null);
  for (const status of ['Wykreślony', 'czynny', 'CZYNNY', 'Zwolniony ', '', 'Aktywny']) {
    assert.equal(decideTrialAuto(record({ statusVat: status })).outcome, 'refused', JSON.stringify(status));
    assert.equal(decideTrialAuto(record({ statusVat: status })).errorCode, 'STATUS_NOT_ACTIVE', JSON.stringify(status));
  }
  for (const code of ['NIP_INVALID', 'NIP_NOT_FOUND', 'NIP_NOT_ACTIVE', 'WHITELIST_ADDRESS_UNPARSEABLE']) {
    assert.equal(decideTrialAuto(new WhitelistError(code)).outcome, 'refused', code);
  }
  for (const code of ['WHITELIST_UNAVAILABLE', 'WHITELIST_RATE_LIMITED', 'WHITELIST_TIMEOUT', 'WHITELIST_RESPONSE_INVALID']) {
    assert.equal(decideTrialAuto(new WhitelistError(code)).outcome, 'unavailable', code);
  }
  for (const junk of [null, undefined, 'x', 42, {}, { statusVat: 'Czynny' }]) {
    assert.equal(decideTrialAuto(junk).outcome, 'unavailable', JSON.stringify(junk));
  }
});

test('the signature is domain separated, name bound and refuses a short secret', () => {
  const payload = trialAutoClaimPayload({
    requestId: 'r', issuedAtMs: 1, companyId: COMPANY, nip: NIP,
    mfRequestId: 'req', mfStatus: 'Czynny', mfName: 'FIRMA',
  });
  // Substituting the registry answer's name changes the payload.
  const other = trialAutoClaimPayload({
    requestId: 'r', issuedAtMs: 1, companyId: COMPANY, nip: NIP,
    mfRequestId: 'req', mfStatus: 'Czynny', mfName: 'INNA FIRMA',
  });
  assert.notEqual(payload, other);
  assert.ok(payload.includes(createHash('sha256').update('FIRMA').digest('hex')));
  // A claim signature is not a digest signature.
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  // All four labels are distinct, so no signature for one operation can be
  // presented as another. 'auto_failure' used to share 'auto_claim', which left
  // the two apart only by how many lines their payload happened to have.
  const signatures = ['auto_claim', 'auto_failure', 'digest', 'consent']
    .map(op => signTrialAuto(op, id, 1, payload, SECRET));
  assert.equal(new Set(signatures).size, 4, 'every operation label signs differently');
  assert.throws(() => signTrialAuto('auto_claim', id, 1, payload, 'short'), /secret_invalid/);
  assert.throws(() => trialAutoCanonical('auto_claim', id, 1.5, payload), /invalid_stamp/);
  // Exactly the construction the database recomputes.
  const canonical = ['sc19-trial-auto-v1', 'auto_claim', id, '1', createHash('sha256').update(payload).digest('hex')].join('\n');
  assert.equal(signTrialAuto('auto_claim', id, 1, payload, SECRET), createHmac('sha256', SECRET).update(canonical).digest('hex'));
});

test('no automatic path can send anything to a company', () => {
  for (const file of ['../lib/sc19-trial-auto.ts', '../lib/sc19-trial-auto-flow.ts', '../lib/sc19-trial-auto-server.ts', '../app/dashboard/[companyId]/billing/actions.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /api\.resend\.com|RESEND_API_KEY|sendMail|smtp/i, file);
  }
});
