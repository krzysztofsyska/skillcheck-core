import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSc19OfferCatalog, sc19OfferFromRow, sc19OffersFromRows } from '../lib/sc19-offer-catalog.ts';
import { SC19_VAT_BASIS_POINTS, sc19OfferAmounts } from '../lib/sc19-offer-amounts.ts';

const future = Date.now() + 86_400_000;
const row = (extra = {}) => ({
  id: 'preselekcja-60-2026-11-r2', revision: 'preselekcja-60-v2', plan: 'PRESELEKCJA',
  amount_minor: 30000, currency: 'PLN', credits: 60,
  terms_revision: 'preselekcja-terms-2026-11-v2', terms_text: 'Warunki: ą, ć, ę, ł, ń, ó, ś, ź, ż.',
  valid_until_ms: future, ...extra,
});

test('the owner-approved 300 zł gross splits into exactly 243,90 zł net + 56,10 zł VAT', () => {
  assert.equal(SC19_VAT_BASIS_POINTS, 2300);
  assert.deepEqual({ ...sc19OfferAmounts(30_000) },
    { grossMinor: 30_000, netMinor: 24_390, vatMinor: 5_610, vatBasisPoints: 2300 });
  // Gross is authoritative: net + VAT must reproduce it for every amount, and the
  // net half-up value must match the internal pricing calculator's netFromGross.
  for (const gross of [0, 1, 2, 3, 99, 100, 123, 12_345, 30_000, 61_500, 149_900, 100_000_000]) {
    const a = sc19OfferAmounts(gross);
    assert.equal(a.netMinor + a.vatMinor, gross, `net + VAT must equal gross at ${gross}`);
    assert.equal(a.netMinor, Math.floor((gross * 10_000 * 2 + 12_300) / 24_600), `net at ${gross}`);
  }
  // No invented price for an out-of-range input.
  for (const bad of [-1, 1.5, Number.NaN, 100_000_001]) assert.equal(sc19OfferAmounts(bad), null);
  assert.equal(sc19OfferAmounts(30_000, 10_001), null);
});

test('only a reviewed, approved, unexpired PRESELEKCJA row becomes a displayable offer', () => {
  const offer = sc19OfferFromRow(row());
  assert.equal(offer.amountMinor, 30000);
  assert.equal(offer.credits, 60);
  assert.equal(offer.plan, 'PRESELEKCJA');
  assert.equal(offer.currency, 'PLN');
  assert.match(offer.termsText, /[ąćęłńóśźż]/, 'the accepted terms carry Polish diacritics');
  for (const bad of [
    { plan: 'WERYFIKACJA' }, { plan: null }, { currency: 'EUR' },
    { amount_minor: 0 }, { amount_minor: -1 }, { amount_minor: 1.5 }, { amount_minor: '30000' },
    { credits: 0 }, { credits: 100_001 }, { credits: 1.5 },
    { id: '' }, { revision: '' }, { terms_revision: '' }, { terms_text: '' },
    { terms_text: 'x'.repeat(20_001) }, { valid_until_ms: Date.now() - 1 }, { valid_until_ms: 0 },
  ]) {
    assert.equal(sc19OfferFromRow(row(bad)), null, JSON.stringify(bad));
  }
  assert.equal(sc19OfferFromRow(null), null);
  // An unusable row is dropped, never shown as an unverified price.
  assert.deepEqual(sc19OffersFromRows([row({ currency: 'EUR' }), row()]).map(o => o.id), [row().id]);
  assert.deepEqual(sc19OffersFromRows(null), []);
});

test('the catalog maps an authorization refusal to FORBIDDEN and never leaks database detail', async () => {
  const forbidden = composeSc19OfferCatalog({
    authenticate: async () => ({ userId: 'u' }),
    readOffers: async () => ({ rows: null, code: '42501' }),
  });
  await assert.rejects(forbidden.listOffers('company'), /SC19_PAYMENT_FORBIDDEN/);
  const broken = composeSc19OfferCatalog({
    authenticate: async () => ({ userId: 'u' }),
    readOffers: async () => ({ rows: null, code: 'XX000', message: 'database password' }),
  });
  await assert.rejects(broken.listOffers('company'), error =>
    error.code === 'SC19_PAYMENT_RETRY' && !/password/.test(error.message));
  // No rows and no error code is still a failure, not an empty catalog.
  const empty = composeSc19OfferCatalog({
    authenticate: async () => ({ userId: 'u' }), readOffers: async () => ({ rows: null }),
  });
  await assert.rejects(empty.listOffers('company'), /SC19_PAYMENT_RETRY/);
  const ok = composeSc19OfferCatalog({
    authenticate: async () => ({ userId: 'u' }), readOffers: async () => ({ rows: [row()] }),
  });
  assert.deepEqual((await ok.listOffers('company')).map(o => o.credits), [60]);
  // The catalog exposes reads only: it has no way to create an order.
  assert.deepEqual(Object.keys(ok).sort(), ['authenticate', 'listOffers']);
});
