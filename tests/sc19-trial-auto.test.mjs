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

const record = (overrides = {}) => ({
  nip: NIP, name: 'FIRMA TESTOWA SP Z OO', statusVat: 'Czynny',
  street: 'ul. Testowa 1', postCode: '00-001', city: 'Warszawa',
  requestId: 'req-synthetic-0001', ...overrides,
});

/** A store that records calls and answers as told. */
function store(answers = {}) {
  const calls = [];
  return {
    calls,
    async claim(companyId, nip) {
      calls.push(['claim', companyId, nip]);
      return { error: answers.claim ?? null };
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
    ['VAT-exempt, not czynny', { result: { subject: { ...record({ statusVat: 'Zwolniony' }), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-x' } }],
    ['nonsense payload', { result: {} }],
    ['another company\'s NIP in the answer', { result: { subject: { ...record({ nip: '5260250274' }), workingAddress: 'ul. Testowa 1, 00-001 Warszawa' }, requestId: 'req-x' } }],
  ]) {
    const s = store({ claim: NEEDS_VERIFICATION });
    const result = await activateFreeWithWhitelist({ store: s, companyId: COMPANY, nip: NIP, env: env(), fetchImpl: fetchOk(body) });
    assert.equal(result.status, 'manual', label);
    assert.equal(s.calls.some(call => call[0] === 'autoClaim'), false, `${label}: nothing is claimed`);
  }
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
    assert.deepEqual(s.calls.map(call => call[0]), ['claim'], 'the register is never called');
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

test('only Czynny qualifies; the decision records what the register returned', () => {
  assert.deepEqual({ ...decideTrialAuto(record()) }, {
    outcome: 'granted', mfRequestId: 'req-synthetic-0001', mfStatus: 'Czynny',
    mfName: 'FIRMA TESTOWA SP Z OO', errorCode: null,
  });
  assert.equal(decideTrialAuto(record({ statusVat: 'Zwolniony' })).outcome, 'refused');
  assert.equal(decideTrialAuto(record({ statusVat: 'Zwolniony' })).errorCode, 'STATUS_NOT_ACTIVE');
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
  assert.notEqual(signTrialAuto('auto_claim', id, 1, payload, SECRET), signTrialAuto('digest', id, 1, payload, SECRET));
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
