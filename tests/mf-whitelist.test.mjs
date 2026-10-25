import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNip, parsePolishAddress, lookupCompanyByNip, whitelistMessages } from '../lib/mf-whitelist.ts';

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
const subject = (extra = {}) => ({ name: 'FIRMA TESTOWA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', nip: '5260250274', statusVat: 'Czynny',
  workingAddress: 'UL. TESTOWA 1/2, 00-001 WARSZAWA', residenceAddress: null, pesel: '00000000000',
  representatives: [{ firstName: 'JAN', lastName: 'KOWALSKI' }], accountNumbers: ['00000000000000000000000000'], ...extra });
const ok = s => async () => reply(200, { result: { subject: s, requestId: 'req-123' } });

test('NIP normalization validates the checksum', () => {
  assert.equal(normalizeNip('526-025-02-74'), '5260250274');
  assert.equal(normalizeNip('PL5260250274'), '5260250274');
  assert.equal(normalizeNip(' 526 025 02 74 '), '5260250274');
  for (const bad of ['5260250275', '0000000000', '123', '52602502741', 'abcdefghij', null, 5260250274]) assert.equal(normalizeNip(bad), null, String(bad));
});

test('address parsing', () => {
  assert.deepEqual(parsePolishAddress('UL. MICHAŁA KAJKI 10-12, 10-547 OLSZTYN'), { street: 'UL. MICHAŁA KAJKI 10-12', postCode: '10-547', city: 'OLSZTYN' });
  assert.equal(parsePolishAddress('OLSZTYN'), null);
  assert.equal(parsePolishAddress(null), null);
});

test('lookup returns only invoice data, never PESEL, representatives or bank accounts', async () => {
  let called;
  const rec = await lookupCompanyByNip('526-025-02-74', async (url, init) => { called = url; assert.equal(init.method, 'GET'); return ok(subject())(); },
    { now: new Date('2026-10-25T22:30:00Z') });
  assert.equal(called, 'https://wl-api.mf.gov.pl/api/search/nip/5260250274?date=2026-10-25');
  assert.deepEqual(rec, { nip: '5260250274', name: 'FIRMA TESTOWA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', statusVat: 'Czynny',
    street: 'UL. TESTOWA 1/2', postCode: '00-001', city: 'WARSZAWA', requestId: 'req-123' });
  assert.ok(!JSON.stringify(rec).includes('KOWALSKI'));
});

test('falls back to residence address; exempt taxpayers accepted', async () => {
  const rec = await lookupCompanyByNip('5260250274', ok(subject({ statusVat: 'Zwolniony', workingAddress: null, residenceAddress: 'RYNEK 5, 30-001 KRAKÓW' })));
  assert.equal(rec.city, 'KRAKÓW'); assert.equal(rec.statusVat, 'Zwolniony');
});

test('error mapping fails closed', async () => {
  const cases = [
    ['5260250275', ok(subject()), 'NIP_INVALID'],
    ['5260250274', ok(null), 'NIP_NOT_FOUND'],
    ['5260250274', ok(subject({ statusVat: 'Podmiot niezarejestrowany do VAT' })), 'NIP_NOT_ACTIVE'],
    ['5260250274', ok(subject({ nip: '1234563218' })), 'WHITELIST_RESPONSE_INVALID'],
    ['5260250274', ok(subject({ workingAddress: 'BEZ KODU', residenceAddress: null })), 'WHITELIST_ADDRESS_UNPARSEABLE'],
    ['5260250274', async () => reply(429, {}), 'WHITELIST_RATE_LIMITED'],
    ['5260250274', async () => reply(400, { code: 'WL-113' }), 'NIP_INVALID'],
    ['5260250274', async () => reply(503, {}), 'WHITELIST_UNAVAILABLE'],
    ['5260250274', async () => reply(200, { nothing: true }), 'WHITELIST_RESPONSE_INVALID'],
    ['5260250274', async (u) => { throw new Error(u); }, 'WHITELIST_UNAVAILABLE'],
  ];
  for (const [nip, fetchImpl, code] of cases) {
    await assert.rejects(lookupCompanyByNip(nip, fetchImpl), e => e.code === code, code);
    assert.ok(whitelistMessages[code].length > 10);
  }
});

test('timeout covers a stalled body', async () => {
  const stalled = async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) });
  await assert.rejects(lookupCompanyByNip('5260250274', stalled, { timeoutMs: 20 }), e => e.code === 'WHITELIST_TIMEOUT');
});
