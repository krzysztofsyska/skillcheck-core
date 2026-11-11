import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCurrentInventory, bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

// SC-019 offer publication on the complete checked-in chain, real PostgreSQL.
//
// The offer a customer is shown must agree with the price catalog, with the
// quota that will actually be granted, and with the legal text reviewed in the
// migration. A drift between any two of those is the failure these tests exist
// to make impossible: private.sc19_payment_offers rows are immutable once
// issued, so a wrong price or CV count cannot be corrected afterwards.
const operator = users.outsider;

// The reviewed revision, as 20261111090000_sc19_offer_publication.sql issues it.
// Repeated here on purpose: a test that read the constants from the function it
// tests would accept any change to them.
const REVISION = Object.freeze({
  offerId: 'preselekcja-60-2026-11-r2',
  revision: 'preselekcja-60-v2',
  termsRevision: 'preselekcja-terms-2026-11-v2',
  amountMinor: 30000,
  credits: 60,
  currency: 'PLN',
  validUntilMs: 1830297599000n,
  // The legal text, byte for byte, as published on the TEST project
  // skillcheck-preview (row read 2026-11-11). Diacritics included: terms that
  // silently lose Polish letters are not the terms that were reviewed.
  termsMd5: 'a535d6098abdc3240e12eca8e22ad46e',
  termsLength: 750,
});

const code = expected => error => error.code === expected;
const message = expected => error => error.message.includes(expected);

// Checksum-valid synthetic NIP, as in tests/sc-019-operator-fulfillment.test.mjs.
function nip(prefix) {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = [...prefix].reduce((acc, digit, i) => acc + Number(digit) * weights[i], 0) % 11;
  assert.notEqual(sum, 10, `${prefix} has no valid NIP checksum`);
  return `${prefix}${sum}`;
}

async function ready(t, options = {}) {
  const env = await bootMigrationDatabase(t);
  const h = await setupRankingDatabase(env.db, { throughMigration: null, ...options });
  const { db } = env;
  await h.asAdmin();
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);
  const company = await h.seed(users.owner);
  await h.asAdmin();
  return { db, h, company };
}

const rows = (db, sql, params) => db.query(sql, params).then(r => r.rows);
const publish = db => rows(db, 'select * from public.sc19_operator_publish_offer()');
const panel = db => rows(db, 'select * from public.sc19_operator_published_offer()').then(r => r[0]);
const purchasable = db => rows(db, `select id, revision, plan, amount_minor, currency, credits,
  terms_revision, valid_until_ms, md5(terms_text) terms_md5, length(terms_text) terms_length
  from private.sc19_payment_offers
  where approved and active and valid_until_ms > (extract(epoch from now())*1000)::bigint
  order by id`);

// The quota the offer sells must be the quota the grant hands out, so every
// publishing test sets it the way the operator would in /operator/billing.
const setQuota = async (db, h, credits) => {
  await h.asUser(operator);
  await db.query('select public.sc19_operator_set_package_policy($1,$2)', ['PRESELEKCJA', credits]);
  await h.asAdmin();
};

test('the migration chain itself publishes no offer and sets no quota', async t => {
  const { db } = await ready(t);
  // This is the guard tests/sc-019-migrations-production-history.test.mjs enforces
  // over every accounting table. If this migration ever seeds commercial state,
  // it fails here first, with a message that says which table.
  for (const table of ['sc19_payment_offers', 'sc19_package_policy', 'sc19_payment_orders',
    'sc19_payment_grants', 'sc19_balances', 'sc19_credit_journal']) {
    assert.deepEqual((await rows(db, `select to_jsonb(t) row from private.${table} t`)), [],
      `the chain leaves private.${table} empty`);
  }
  // Functions only: the erasure inventory and the relation allowlist are untouched.
  await assertCurrentInventory(db);
});

test('both RPCs refuse anon, ordinary users and non-operators', async t => {
  const { db, h } = await ready(t);
  const attempts = [
    'select * from public.sc19_operator_published_offer()',
    'select * from public.sc19_operator_publish_offer()',
  ];
  for (const who of [users.owner, users.recruiter, users.otherOwner]) {
    await h.asUser(who);
    for (const sql of attempts) await assert.rejects(db.query(sql), code('42501'), `${who}: ${sql}`);
  }
  await h.asUser(null, 'anon');
  for (const sql of attempts) await assert.rejects(db.query(sql), code('42501'), `anon: ${sql}`);
  // Revoking the operator revokes publication, including for an open session.
  await h.asAdmin();
  await db.query('delete from public.platform_operators where user_id=$1', [operator]);
  await h.asUser(operator);
  for (const sql of attempts) await assert.rejects(db.query(sql), code('42501'), `revoked: ${sql}`);
  await h.asAdmin();
  assert.deepEqual(await purchasable(db), [], 'no refused attempt published anything');
});

test('publishing issues exactly one purchasable offer that matches the catalog and the quota', async t => {
  const { db, h } = await ready(t);
  await setQuota(db, h, 60);
  await h.asUser(operator);
  const published = await publish(db);
  assert.equal(published.length, 1);
  assert.equal(published[0].offer_id, REVISION.offerId);
  assert.equal(published[0].withdrawn, 0, 'nothing had to be withdrawn on a first publication');

  await h.asAdmin();
  const live = await purchasable(db);
  assert.equal(live.length, 1, 'exactly one purchasable offer');
  assert.deepEqual({ ...live[0], valid_until_ms: BigInt(live[0].valid_until_ms) }, {
    id: REVISION.offerId, revision: REVISION.revision, plan: 'PRESELEKCJA',
    amount_minor: REVISION.amountMinor, currency: REVISION.currency, credits: REVISION.credits,
    terms_revision: REVISION.termsRevision, valid_until_ms: REVISION.validUntilMs,
    terms_md5: REVISION.termsMd5, terms_length: REVISION.termsLength,
  });

  // The published offer agrees with pricing.package_prices, which is the single
  // source of truth for what a customer pays and gets (SC-PRICING-W2).
  const [catalog] = await rows(db, `select p.gross_minor, p.cv_included, p.sellable
    from pricing.package_prices p join pricing.catalog_versions v on v.id=p.version_id
    where v.status='PUBLISHED' and p.package_code='PRESELEKCJA'`);
  assert.equal(live[0].amount_minor, catalog.gross_minor, 'offer price equals the catalog price');
  assert.equal(live[0].credits, catalog.cv_included, 'offer CV count equals the catalog CV count');
  assert.equal(catalog.sellable, true);
  // And with the quota that private.sc19_grant_paid() will actually grant.
  const [policy] = await rows(db, "select credits from private.sc19_package_policy where plan='PRESELEKCJA'");
  assert.equal(live[0].credits, policy.credits, 'offer CV count equals the granted quota');
});

test('publishing twice changes nothing', async t => {
  const { db, h } = await ready(t);
  await setQuota(db, h, 60);
  await h.asUser(operator);
  const first = await publish(db);
  const second = await publish(db);
  assert.deepEqual(second, first, 'the second publication returns the same row');
  await h.asAdmin();
  assert.equal((await purchasable(db)).length, 1);
  assert.equal((await rows(db, 'select id from private.sc19_payment_offers')).length, 1,
    'no second row was inserted');
});

test('a competing active offer is withdrawn, never left alongside the new one', async t => {
  const { db, h } = await ready(t);
  await setQuota(db, h, 60);
  // An older revision, as a preview database that received the earlier ASCII
  // revision would hold it.
  await db.query(`insert into private.sc19_payment_offers(id,revision,plan,active,approved,
    amount_minor,currency,credits,terms_revision,terms_text,valid_until_ms)
    values('preselekcja-60-2026-11','preselekcja-60-v1','PRESELEKCJA',true,true,
      30000,'PLN',60,'preselekcja-terms-2026-11-v1','Stare warunki',$1)`, [String(REVISION.validUntilMs)]);
  assert.equal((await purchasable(db)).length, 1);

  await h.asUser(operator);
  const published = await publish(db);
  assert.equal(published[0].withdrawn, 1, 'the previous revision was withdrawn');

  await h.asAdmin();
  const live = await purchasable(db);
  assert.equal(live.length, 1, 'never two purchasable offers');
  assert.equal(live[0].id, REVISION.offerId);
  // The withdrawn row stays: it is undeletable and a paid order references it.
  const [old] = await rows(db, `select active, approved from private.sc19_payment_offers
    where id='preselekcja-60-2026-11'`);
  assert.deepEqual(old, { active: false, approved: false });
});

test('publication is refused when the quota is missing or disagrees with the offer', async t => {
  const { db, h } = await ready(t);
  await h.asUser(operator);
  await assert.rejects(publish(db), message('sc19_offer_policy_missing'));

  await h.asAdmin();
  await setQuota(db, h, 50);
  await h.asUser(operator);
  await assert.rejects(publish(db), message('sc19_offer_policy_mismatch'),
    'selling 60 analyses while the package grants 50 is refused');
  const refusal = await panel(db);
  assert.equal(refusal.publishable, false);
  assert.equal(refusal.refusal, 'policy_mismatch');
  assert.equal(refusal.policy_credits, 50);

  await h.asAdmin();
  assert.deepEqual(await purchasable(db), [], 'a refused publication publishes nothing');
  await setQuota(db, h, 60);
  await h.asUser(operator);
  assert.equal((await publish(db))[0].credits, 60, 'correcting the quota makes it publishable');
});

test('publication is refused when the catalog disagrees, is missing or is not sellable', async t => {
  const cases = [
    ['sc19_offer_catalog_mismatch', 'catalog_mismatch',
      "update pricing.package_prices set gross_minor=29900 where package_code='PRESELEKCJA'"],
    ['sc19_offer_catalog_mismatch', 'catalog_mismatch',
      "update pricing.package_prices set cv_included=50, cv_max=50 where package_code='PRESELEKCJA'"],
    ['sc19_offer_catalog_not_sellable', 'catalog_not_sellable',
      "update pricing.package_prices set sellable=false where package_code='PRESELEKCJA'"],
    ['sc19_offer_catalog_missing', 'catalog_missing',
      "delete from pricing.package_prices where package_code='PRESELEKCJA'"],
    ['sc19_offer_catalog_missing', 'catalog_missing',
      "update pricing.catalog_versions set status='SUPERSEDED', published_at=null"],
  ];
  for (const [error, refusal, damage] of cases) {
    await t.test(refusal + ': ' + damage, async t2 => {
      const { db, h } = await ready(t2);
      await setQuota(db, h, 60);
      await db.query(damage);
      await h.asUser(operator);
      await assert.rejects(publish(db), message(error));
      assert.equal((await panel(db)).refusal, refusal);
      await h.asAdmin();
      assert.deepEqual(await purchasable(db), [], 'nothing is published while the catalog disagrees');
    });
  }
});

test('a row already stored under this id with other terms is never activated', async t => {
  const { db, h } = await ready(t);
  await setQuota(db, h, 60);
  // Same id, different price: only possible if the reviewed constants changed
  // without a new id. The row is immutable, so publishing it would sell the old
  // price under the new revision's name.
  await db.query(`insert into private.sc19_payment_offers(id,revision,plan,active,approved,
    amount_minor,currency,credits,terms_revision,terms_text,valid_until_ms)
    values($1,$2,'PRESELEKCJA',false,false,19900,'PLN',60,$3,'Inne warunki',$4)`,
    [REVISION.offerId, REVISION.revision, REVISION.termsRevision, String(REVISION.validUntilMs)]);
  await h.asUser(operator);
  await assert.rejects(publish(db), message('sc19_offer_stored_revision_differs'));
  await h.asAdmin();
  assert.deepEqual(await purchasable(db), [], 'the mismatched row stays withdrawn');
});

test('the panel reports no offer, then the published one, and warns before it expires', async t => {
  const { db, h } = await ready(t);
  await setQuota(db, h, 60);
  await h.asUser(operator);
  const before = await panel(db);
  assert.equal(before.published_offer_id, null, 'nothing published yet');
  assert.equal(before.publishable, true);
  assert.equal(before.refusal, null);
  // What publication WOULD issue is shown before it is issued, so the operator
  // publishes a known price and a known contract revision.
  assert.equal(before.revision_offer_id, REVISION.offerId);
  assert.equal(before.revision_amount_minor, REVISION.amountMinor);
  assert.equal(before.revision_credits, REVISION.credits);
  assert.equal(before.revision_terms_revision, REVISION.termsRevision);
  assert.equal(BigInt(before.revision_valid_until_ms), REVISION.validUntilMs);
  assert.equal(before.catalog_gross_minor, REVISION.amountMinor);
  assert.equal(before.catalog_cv_included, REVISION.credits);
  assert.equal(before.policy_credits, REVISION.credits);

  await publish(db);
  const after = await panel(db);
  assert.equal(after.published_offer_id, REVISION.offerId);
  assert.equal(after.published_amount_minor, REVISION.amountMinor);
  assert.equal(after.published_credits, REVISION.credits);
  assert.equal(after.published_terms_revision, REVISION.termsRevision);
  assert.ok(after.published_at, 'the publication time is recorded');
  // 2027-12-31 is far enough away that the warning must stay off today.
  assert.ok(after.expires_in_days > 30, `expected a long horizon, got ${after.expires_in_days}`);
  assert.equal(after.expiring_soon, false);
});

// The reviewed validity, moved to 10 days away in an isolated database. The
// constant itself is not changed: a silent expiry is what stops sales without a
// signal, so the warning is tested on the real function.
const moveValidity = ms => (sql, name) => {
  if (!name.startsWith('20261111090000_')) return sql;
  const replaced = sql.replace('1830297599000::bigint', `${ms}::bigint`);
  assert.notEqual(replaced, sql, 'the offer validity constant must be substitutable');
  return replaced;
};

test('the panel warns when the published offer expires within 30 days', async t => {
  const soon = Date.now() + 10 * 86400000;
  const { db, h } = await ready(t, { transformSql: moveValidity(soon) });
  await setQuota(db, h, 60);
  await h.asUser(operator);
  await publish(db);
  const state = await panel(db);
  assert.equal(state.expiring_soon, true, 'an offer 10 days from expiry is flagged');
  assert.ok(state.expires_in_days <= 10 && state.expires_in_days >= 9, state.expires_in_days);
});

test('an expired revision is refused, not published dead', async t => {
  const past = Date.now() - 86400000;
  const { db, h } = await ready(t, { transformSql: moveValidity(past) });
  await setQuota(db, h, 60);
  await h.asUser(operator);
  await assert.rejects(publish(db), message('sc19_offer_revision_expired'));
  assert.equal((await panel(db)).refusal, 'revision_expired');
  await h.asAdmin();
  assert.deepEqual(await purchasable(db), [], 'an expired revision is never purchasable');
});

test('the rollback removes the three functions and touches no data', async t => {
  const { db, h } = await ready(t);
  await setQuota(db, h, 60);
  await h.asUser(operator);
  await publish(db);
  await h.asAdmin();
  const before = await purchasable(db);
  assert.equal(before.length, 1);

  const down = await readFile(new URL('../supabase/rollbacks/20261111090000_sc19_offer_publication_down.sql',
    import.meta.url), 'utf8');
  await db.exec(down);
  for (const signature of ['public.sc19_operator_publish_offer()', 'public.sc19_operator_published_offer()',
    'private.sc19_offer_revision()']) {
    assert.equal((await rows(db, 'select to_regprocedure($1) value', [signature]))[0].value, null,
      `${signature} is gone`);
  }
  // Re-runnable, and the published offer is NOT withdrawn: that is a billing
  // action, done by the operator before the rollback, never by this script.
  await db.exec(down);
  assert.deepEqual(await purchasable(db), before, 'the published offer is untouched');
});

test('a verified company sees the published offer through the checkout read path', async t => {
  const { db, h, company } = await ready(t);
  await setQuota(db, h, 60);
  await h.asUser(operator);
  // The checkout RPC shows an offer only to the owner of a verified company.
  await db.query('select public.sc19_operator_approve_trial($1,$2,$3)',
    [company.companyId, nip('526025099'), 'KRS 0000000000 sprawdzony 2026-11-11']);
  await publish(db);

  await h.asUser(users.owner);
  const offers = await rows(db, 'select * from public.sc19_checkout_offers($1)', [company.companyId]);
  assert.equal(offers.length, 1, 'the customer is shown exactly one offer');
  assert.equal(offers[0].amount_minor, REVISION.amountMinor);
  assert.equal(offers[0].credits, REVISION.credits);
  assert.equal(offers[0].terms_revision, REVISION.termsRevision);
  assert.match(offers[0].terms_text, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/,
    'the terms the customer accepts keep their Polish letters');

  // An unverified company still sees nothing: publication grants no access.
  await h.asUser(users.otherOwner);
  const other = await h.seed(users.otherOwner);
  await assert.rejects(db.query('select * from public.sc19_checkout_offers($1)', [other.companyId]),
    code('42501'), 'an unverified company is still refused');
});
