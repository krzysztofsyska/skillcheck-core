import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { setupRankingDatabase } from './helpers/screening-ranking-fixture.mjs';
import { bootMigrationDatabase, assertCurrentInventory, seedSyntheticPolicy, paymentHarness, paymentUsers } from './helpers/sc19-migration-fixture.mjs';
import { reportDatabaseClient } from './helpers/screening-report-database-client.mjs';
import { loadScreeningReport } from '../lib/screening-report-source.ts';
import { exportScreeningReport } from '../lib/screening-report-export.ts';
import { createSc19PaymentHttp } from '../lib/sc19-payment-http.ts';
// The billing action now goes through the automatic-FREE flow. The flow module
// carries no 'server-only' guard, so the real code runs here; only the thin
// server adapter is substituted, and with no SC19_TRIAL_AUTO_SECRET set the
// flow behaves exactly as before: claim, and otherwise manual review.
import { activateFreeWithWhitelist, trialStore } from '../lib/sc19-trial-auto-flow.ts';

// Synthetic composed integration, NOT a deployed runtime/provider/browser test.
// Auth transport and provider are test doubles; billing, screening, review,
// ranking, shortlist and report execute the actual current SQL/application code.
// The production payment resolver deliberately remains disabled.
function activationAction(access) {
  const path = fileURLToPath(new URL('../app/dashboard/[companyId]/billing/actions.ts', import.meta.url));
  const mod = new Module(path), require = createRequire(path);
  mod.filename = path;
  mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
  const mocks = {
    '../../../../lib/company-access': { companyAccess: access },
    '../../../../lib/sc19-trial-auto-server': { activateFreeWithWhitelist, trialStore },
    'next/cache': { revalidatePath() {} },
    'next/navigation': { redirect(url) { throw Object.assign(new Error('NEXT_REDIRECT'), { url }); } },
  };
  mod.require = name => Object.hasOwn(mocks, name) ? mocks[name] : require(name);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, path);
  return mod.exports.activateSc19Free;
}

test('FREE and signed fake payment feed real screening, human review, shortlist and CSV on full migrated PostgreSQL', async t => {
  const env = await bootMigrationDatabase(t), { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  env.h = h;
  await assertCurrentInventory(db);
  await seedSyntheticPolicy(db);
  for (const id of Object.values(paymentUsers)) await db.query('insert into auth.users values($1)', [id]);
  const first = await h.seed(paymentUsers.owner, 'synthetic-free-paid');
  const second = await h.seed(paymentUsers.otherOwner, 'synthetic-survivor');
  const p = paymentHarness(env);
  await p.seed(first, second);
  const key = randomBytes(32), canonicalPayments = new Map();
  const sign = bytes => createHmac('sha256', key).update(bytes).digest('hex');
  const provider = { ...p.provider,
    async verifyAndRetrieve(bytes, signature) {
      const expected = Buffer.from(sign(bytes), 'hex');
      const actual = /^[a-f0-9]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error('synthetic signature invalid');
      const event = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!Number.isSafeInteger(event.issuedAt) || Math.abs(Date.now() - event.issuedAt) > 60000) throw Error('synthetic timestamp invalid');
      const payment = canonicalPayments.get(event.paymentId);
      if (!payment) throw Error('synthetic payment unavailable');
      return { ...payment, eventId: event.eventId };
    },
  };
  const runtime = (owner = first.owner, extra = {}) => p.runtime(owner, { provider, ...extra });
  const http = (extra = {}) => createSc19PaymentHttp(runtime(first.owner, extra));
  const notify = async (payment, { invalid = false, extra = {} } = {}) => {
    canonicalPayments.set(payment.paymentId, payment);
    const bytes = Buffer.from(JSON.stringify({ paymentId: payment.paymentId, eventId: randomUUID(), issuedAt: Date.now() }));
    return http(extra).webhook(new Request('https://app.fixture.invalid/api/billing/webhook', {
      method: 'POST', headers: { 'synthetic-signature': invalid ? '00'.repeat(32) : sign(bytes) }, body: bytes,
    }));
  };
  const checkout = async input => {
    const response = await http().checkout(new Request('https://app.fixture.invalid/api/billing/checkout', {
      method: 'POST', headers: { origin: 'https://app.fixture.invalid', 'content-type': 'application/json' }, body: JSON.stringify(input),
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    const order = await runtime().readOrder(first.companyId, first.owner, result.orderId);
    return { ...result, sessionId: order.sessionId };
  };
  const audit = async () => (await p.pool.query(`select reason,delta,reference,analysis_id from private.sc19_credit_journal
    where company_id=$1 order by created_at,id`, [first.companyId])).rows;
  const assertBalance = async expected => {
    assert.equal(await p.balance(first.companyId), expected);
    assert.equal((await audit()).reduce((sum, row) => sum + row.delta, 0), expected);
    assert.equal(await p.balance(second.companyId), 0);
  };
  const report = async fixture => {
    await h.asUser(first.owner);
    const client = reportDatabaseClient(db, () => ({ id: first.owner }));
    const before = await loadScreeningReport(client, fixture.companyId, fixture.recruitment.id, '5');
    assert.equal(before.applications.find(a => a.ranking.application_id === fixture.application.id).ranking.eligibility_reason, 'no_human_review');
    await h.review(fixture, fixture.analysis_id);
    assert.equal((await h.row(fixture)).eligibility_reason, 'eligible');
    const selection = await h.add(fixture, 'suggested', undefined, 'PRIVATE synthetic shortlist note', 5);
    const value = await loadScreeningReport(client, fixture.companyId, fixture.recruitment.id, '5');
    const row = value.applications.find(a => a.ranking.application_id === fixture.application.id);
    assert.equal(row.shortlist.entry_id, selection);
    assert.equal(row.shortlist.snapshot_current, true);
    const response = await exportScreeningReport(client, fixture.companyId, fixture.recruitment.id, '5');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const csv = await response.text();
    assert.match(csv, /Wybrano przez człowieka/);
    assert.doesNotMatch(csv, /PRIVATE|original CV/);
    assert.equal((await db.query('select status from public.applications where id=$1', [fixture.application.id])).rows[0].status, 'new');
  };

  await t.test('real FREE server action activates once and rejects another owner', async () => {
    let actor = first.owner;
    const action = activationAction(async companyId => {
      assert.equal(companyId, first.companyId);
      await h.asUser(actor);
      return { company: { owner_id: first.owner }, user: { id: actor }, client: {
        async rpc(name, args) {
          assert.equal(name, 'sc19_claim_trial');
          try { return { data: (await db.query('select public.sc19_claim_trial($1,$2) value', [args.target_company, args.supplied_nip])).rows[0].value, error: null }; }
          catch (error) { return { data: null, error: { code: error.code } }; }
        },
      } };
    });
    const old = process.env.SC19_PACKAGES_ENABLED;
    process.env.SC19_PACKAGES_ENABLED = 'true';
    try {
      const form = new FormData(); form.set('companyId', first.companyId); form.set('nip', '1234563218');
      for (let i = 0; i < 2; i++) await assert.rejects(action(form), e => e.url === `/dashboard/${first.companyId}/billing?status=activated`);
      actor = second.owner;
      await assert.rejects(action(form), e => e.url === `/dashboard/${first.companyId}/billing?status=forbidden`);
    } finally {
      if (old === undefined) delete process.env.SC19_PACKAGES_ENABLED; else process.env.SC19_PACKAGES_ENABLED = old;
    }
    await assertBalance(5);
    assert.equal((await audit()).filter(r => r.reason === 'trial').length, 1);
  });

  await t.test('FREE reserve, failed-attempt replay, retry and completion charge only once', async () => {
    const started = await h.start(first), claim = await h.claim(started);
    await assertBalance(4);
    const fail = () => db.query("select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','Synthetic timeout')", [started.attempt_id, claim.lease_token, claim.input_fingerprint, claim.analysis_contract_hash]);
    await fail(); await fail(); await assertBalance(5);
    await h.asUser(first.owner);
    const retryKey = randomUUID();
    const retry = (await db.query('select * from public.retry_screening_analysis($1,$2)', [started.analysis_id, retryKey])).rows[0];
    const replay = (await db.query('select * from public.retry_screening_analysis($1,$2)', [started.analysis_id, retryKey])).rows[0];
    assert.equal(replay.attempt_id, retry.attempt_id);
    await assertBalance(4);
    const claimed = await h.claim(retry), ratings = Array(claimed.criteria_snapshot.length).fill('meets');
    await h.finishClaim(retry, claimed, ratings); await h.finishClaim(retry, claimed, ratings);
    await assertBalance(4);
    await report({ ...first, ...started });
    const entries = (await audit()).filter(r => r.analysis_id === started.analysis_id);
    assert.equal(entries.filter(r => r.reason === 'analysis_release').length, 1);
    assert.equal(entries.reduce((sum, r) => sum + r.delta, 0), -1);
  });

  await t.test('remaining FREE credits accept four bulk CVs, reject the sixth, and produce a five-CV report', async () => {
    await h.asUser(first.owner);
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `synthetic-${i}.pdf`, kind: 'pdf', size: 100 }));
    const key = randomUUID();
    const create = () => db.query('select public.cv_bulk_create_batch($1,$2,$3::jsonb) value',
      [first.recruitment.id, key, JSON.stringify(files)]);
    const batch = (await create()).rows[0].value;
    assert.equal(batch.reserved_slots, 4);
    assert.equal(batch.over_limit, 1);
    assert.equal((await create()).rows[0].value.batch_id, batch.batch_id, 'upload retry reuses the reservation');
    await assertBalance(0);
    await h.asAdmin();
    const items = (await db.query('select * from private.cv_bulk_items where batch_id=$1 order by position', [batch.batch_id])).rows;
    const accepted = items.filter(item => item.slot_state === 'held');
    assert.equal(accepted.length, 4);
    for (const [i, item] of accepted.entries()) {
      await h.asUser(first.owner);
      const extracted = { first_name: 'Synthetic', last_name: `Person${i}`, email: null, phone: null,
        source_text: 'SQL synthetic CV', redacted_text: 'SQL synthetic CV', name_detected: true, ocr_used: false };
      const registered = (await db.query('select public.cv_bulk_register_item($1,$2::jsonb) value', [item.id, JSON.stringify(extracted)])).rows[0].value;
      assert.equal(registered.status, 'queued');
    }
    const contract = { payload_schema_version: 1, result_schema_version: 1, prompt_version: 'screening-v1',
      provider: 'openai', model: 'ranking-test-model', model_revision: 'test-rev' };
    const pump = async () => {
      await h.asUser(first.owner);
      return (await db.query('select public.cv_bulk_pump($1,$2::jsonb,null) value', [batch.batch_id, JSON.stringify(contract)])).rows[0].value;
    };
    const completed = [];
    for (let round = 0; round < 5 && completed.length < 4; round++) {
      const result = await pump();
      for (const attemptId of result.dispatch) {
        const started = { attempt_id: attemptId };
        const claimed = await h.claim(started);
        await h.finishClaim(started, claimed, Array(claimed.criteria_snapshot.length).fill('meets'));
        completed.push(attemptId);
      }
    }
    assert.equal(completed.length, 4);
    await pump();
    await h.asAdmin();
    const analyses = (await db.query('select application_id,analysis_id from private.cv_bulk_items where batch_id=$1 and analysis_id is not null', [batch.batch_id])).rows;
    for (const row of analyses) await h.review({ ...first, application: { id: row.application_id } }, row.analysis_id);
    await h.asUser(first.owner);
    const value = await loadScreeningReport(reportDatabaseClient(db, () => ({ id: first.owner })), first.companyId, first.recruitment.id, '5');
    assert.equal(value.applications.length, 5);
    assert.equal(value.applications.filter(row => row.ranking.eligibility_reason === 'eligible').length, 5);
    assert.equal(value.groups.length, 4, 'bulk groups reach the same report');
    const sixth = await h.candidate(first, 'synthetic-sixth');
    await assert.rejects(h.start(sixth), /sc19_quota_exhausted/);
    await assertBalance(0);
    // Payment assertions below intentionally start at exhausted FREE.
  });

  await t.test('immutable selected quote, lost response, signed settlement and duplicate webhook', async () => {
    const offers = await http().offers(new Request(`https://app.fixture.invalid/api/billing/offers?companyId=${first.companyId}`));
    assert.equal(offers.status, 200);
    const offer = (await offers.json()).offers[0];
    assert.equal(offer.amountMinor, 12345); assert.equal(offer.currency, 'PLN'); assert.equal(offer.credits, 12);
    const input = p.request(first.companyId);
    await assert.rejects(runtime().service.checkout({ ...input, termsRevision: 'wrong-terms' }));
    p.setLostResponse(true);
    await assert.rejects(runtime().service.checkout(input), /synthetic lost response/);
    p.setLostResponse(false);
    const sessions = p.sessions.size;
    const recovered = await checkout(p.request(first.companyId));
    assert.equal(p.sessions.size, sessions);
    const original = await runtime().readOrder(first.companyId, first.owner, recovered.orderId);
    assert.equal(original.requestId, input.requestId);
    assert.equal(original.buyerId, first.owner); assert.equal(original.companyId, first.companyId);
    assert.deepEqual(original.scope, p.scope); assert.equal(original.offerRevision, offer.revision);
    assert.equal(original.termsRevision, offer.termsRevision); assert.equal(original.amountMinor, 12345);
    assert.equal([...p.sessions.values()][0].paymentKind, 'one_time');
    await assert.rejects(p.pool.query('update private.sc19_payment_orders set credits=99 where id=$1', [original.id]), /immutable/);
    await assert.rejects(p.pool.query('update private.sc19_payment_offers set amount_minor=1 where id=$1', [original.offerId]), /immutable/);
    await p.pool.query("update private.sc19_package_policy set credits=99 where plan='PRESELEKCJA'");
    const payment = p.payment(recovered);
    const before = await audit();
    assert.notEqual((await notify(payment, { invalid: true })).status, 200);
    assert.deepEqual(await audit(), before); await assertBalance(0);
    for (const changed of [
      { amountMinor: 1 }, { currency: 'EUR' },
      { scope: { ...p.scope, account: 'wrong-merchant' } },
      { scope: { ...p.scope, mode: 'live' } },
      { sessionId: 'wrong-session' },
    ]) {
      assert.notEqual((await notify({ ...payment, ...changed })).status, 200);
      await assertBalance(0);
    }
    assert.equal((await notify(payment)).status, 200);
    assert.equal((await (await notify(payment)).json()).state, 'already_applied');
    await assertBalance(12);
    assert.deepEqual(await runtime().service.checkout(input), { orderId: original.id, paid: true });
  });

  await t.test('another session cannot grant the same payment twice; kill switch drains existing order', async () => {
    const next = await checkout(p.request(first.companyId));
    assert.equal(p.sessions.size, 2);
    const prior = (await p.pool.query("select payment_id from private.sc19_payment_orders where status='paid' and company_id=$1", [first.companyId])).rows[0];
    assert.notEqual((await notify(p.payment(next, { paymentId: prior.payment_id }))).status, 200);
    await assertBalance(12);
    await assert.rejects(runtime(first.owner, { enabled: false }).service.checkout(p.request(first.companyId)), /DISABLED/);
    assert.equal((await notify(p.payment(next), { extra: { enabled: false } })).status, 200);
    await assertBalance(24);
    assert.equal(await p.count('sc19_payment_grants'), 2);
    assert.equal((await audit()).filter(r => r.reason === 'paid_grant').length, 2);
  });

  await t.test('paid credits fund a second reviewed, ranked, shortlisted report with final audit', async () => {
    const candidate = await h.candidate(first, 'synthetic-paid-analysis');
    const started = await h.start(candidate), claimed = await h.claim(started);
    await h.finishClaim(started, claimed, Array(claimed.criteria_snapshot.length).fill('above'));
    await report({ ...candidate, ...started });
    await assertBalance(23);
    assert.equal((await audit()).filter(r => r.reason === 'paid_grant').every(r => r.delta === 12 && r.reference.startsWith('settlement:sc19:')), true);
    await h.asUser(second.owner);
    assert.equal((await exportScreeningReport(reportDatabaseClient(db, () => ({ id: second.owner })), first.companyId, first.recruitment.id, '5')).status, 404);
    await h.asAdmin(); await assertCurrentInventory(db);
  });
});
