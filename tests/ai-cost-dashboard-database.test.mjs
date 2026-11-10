// SC-021-D: AI cost and contribution-margin reads (operator only). Native PostgreSQL (CI: PG16), full migration chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';

const migration = '20261110090000_sc021_cost_dashboard.sql';
const r15 = '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44';
const denied = (...codes) => error => codes.includes(error.code);
const operator = users.outsider;

async function boot(t) {
  const e = await activeBoot(t, { fullChain: true, throughMigration: migration });
  const { db, h } = e;
  await h.asAdmin();
  assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value, r15, 'SC-010 signature unchanged');
  const a = await e.seed(), b = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [a.companyId, users.recruiter]);
  const price = async (version, model, currency, placeholder) => (await db.query(`insert into ai_ledger.prices(provider,model,price_version,currency,
    input_per_mtok_micros,cached_input_per_mtok_micros,output_per_mtok_micros,placeholder,approved,valid_from)
    values('openai',$1,$2,$3,1,1,1,$4,not $4,'2026-01-01') returning id, price_version, placeholder, currency`, [model, version, currency, placeholder])).rows[0];
  const placeholderPrice = (await db.query("select id, price_version, placeholder, currency from ai_ledger.prices where price_version='placeholder-test-2026-11-09'")).rows[0];
  const prices = { placeholder: placeholderPrice, usd: await price('synthetic-approved-usd', 'synthetic-usd', 'USD', false),
    eur: await price('synthetic-approved-eur', 'synthetic-eur', 'EUR', false) };
  const month = (await db.query("select to_char(ai_ledger.warsaw_month(now()),'YYYY-MM-DD') m, to_char(ai_ledger.warsaw_month(now()) + interval '1 month','YYYY-MM-DD') n, to_char(ai_ledger.warsaw_month(now() - interval '2 months'),'YYYY-MM-DD') old")).rows[0];
  // Direct rows (as the table owner) give exact control over every cost class; the write path itself is covered by SC-021-B.
  const insert = async ({ company, process = null, candidate = null, task = 'cv_screening', op = randomUUID(), kind, p = null, cost = null,
    reserved = null, bounds = false, createdAt = null }) => {
    await h.asAdmin();
    const settled = kind === 'settled';
    const row = {
      billing: { settled: 'billed', unknown: 'maybe_billed', released: 'not_billed', reserved: 'maybe_billed' }[kind],
      outcome: { settled: 'completed', unknown: 'timeout', released: 'rate_limit', reserved: 'pending' }[kind],
      tokens: settled ? 1 : null,
    };
    await db.query(`insert into ai_ledger.attempts(attempt_id,operation_id,company_id,process_id,candidate_ref,task,attempt_no,provider,model,
      model_key,policy_version,outcome,billing,status,input_tokens,cached_input_tokens,output_tokens,price_id,price_version,price_placeholder,
      currency,cost_micros,reserved_micros,latency_ms,content_hash,settled_at,bounds_exceeded,created_at)
      values($1,$2,$3,$4,$5,$6,1,'openai','m','k','v',$7,$8,$9,$10,$10,$10,$11,$12,$13,$14,$15,$16,1,$17,$18,$19,coalesce($20::timestamptz,clock_timestamp()))`,
    [randomUUID(), op, company, process, candidate, task, row.outcome, row.billing, kind, row.tokens, p?.id ?? null, p?.price_version ?? null,
      p ? p.placeholder : null, p?.currency ?? null, kind === 'released' ? 0 : cost, reserved, 'a'.repeat(64), settled ? new Date() : null, bounds, createdAt]);
    return op;
  };
  const asOperator = () => h.asUser(operator);
  const costs = async (group, from = month.m, to = month.n) => { await asOperator();
    return (await db.query('select * from public.sc021_operator_ai_costs($1,$2,$3)', [from, to, group])).rows; };
  const margin = async (group, from = month.m, to = month.n) => { await asOperator();
    return (await db.query('select * from public.sc021_operator_margin($1,$2,$3)', [from, to, group])).rows; };
  return { ...e, a, b, prices, month, insert, asOperator, costs, margin };
}

const n = v => v === null ? null : Number(v);
const classes = r => ({ attempts: n(r.attempts), operations: n(r.operations), confirmed: n(r.confirmed_count), placeholder: n(r.placeholder_count),
  unpriced: n(r.unpriced_count), unknown: n(r.unknown_count), released: n(r.released_count), reserved: n(r.reserved_count), bounds: n(r.bounds_exceeded_count) });

async function scenario(e) {
  const { a, b, prices, insert } = e;
  const shared = randomUUID();
  // Company A: one screening operation with a retry chain (confirmed, unknown, released), one placeholder-priced
  // operation over the route bounds, one unpriced exercise generation keyed `shared`.
  const op1 = randomUUID();
  await insert({ company: a.companyId, process: a.recruitment.id, candidate: a.application.id, op: op1, kind: 'settled', p: prices.usd, cost: 1000000 });
  await insert({ company: a.companyId, process: a.recruitment.id, candidate: a.application.id, op: op1, kind: 'unknown' });
  await insert({ company: a.companyId, process: a.recruitment.id, candidate: a.application.id, op: op1, kind: 'released' });
  await insert({ company: a.companyId, process: a.recruitment.id, candidate: a.application.id, kind: 'settled', p: prices.placeholder, cost: 500000, bounds: true });
  await insert({ company: a.companyId, process: a.recruitment.id, task: 'exercise_generation', op: shared, kind: 'settled' });
  // Company B: the same client-chosen exercise key in another company is another operation; an EUR-priced
  // screening; a reservation (SC-021-C extension point); and a row two months back (outside the period).
  await insert({ company: b.companyId, process: b.recruitment.id, task: 'exercise_generation', op: shared, kind: 'settled', p: prices.usd, cost: 2000000 });
  await insert({ company: b.companyId, process: b.recruitment.id, candidate: b.application.id, kind: 'settled', p: prices.eur, cost: 1000000 });
  await insert({ company: b.companyId, process: b.recruitment.id, candidate: b.application.id, kind: 'reserved', reserved: 300 });
  await insert({ company: b.companyId, process: b.recruitment.id, candidate: b.application.id, kind: 'settled', p: prices.usd, cost: 7000000,
    createdAt: `${e.month.old.slice(0, 8)}11T12:00:00Z` });
  // SC-021-C budget reservations (rows matching C's schema). Live: an exercise hold without attempts (1000),
  // the `shared` exercise hold with one recorded attempt of unknown cost (3000 − 1000 = 2000), and a screening
  // hold on an attempt the worker is processing (1000). Not live: released, expired.
  const { db, h } = e;
  const c = await h.candidate(b); const started = await h.start(c); await h.claim(started);
  await h.asAdmin();
  const estimate = async task => (await db.query('select id from ai_ledger.budget_estimates where task=$1 order by created_at desc limit 1', [task])).rows[0].id;
  const hold = async ({ task = 'exercise_generation', company, process, op = randomUUID(), per, attempts = 1, created = "now()",
    expires = "now() + interval '1 hour'", released = false }) => {
    await h.asAdmin();
    await db.query(`insert into ai_ledger.budget_reservations(task,company_id,process_id,operation_id,period_start,currency,per_attempt_micros,
      attempts,reserved_micros,estimate_id,price_id,created_at,expires_at,released_at)
      values($1,$2,$3,$4,ai_ledger.warsaw_month(now())::timestamp at time zone 'Europe/Warsaw','USD',$5::bigint,$6::int,$5::bigint*$6::int,$7,$8,${created},${expires},
      case when $9 then now() end)`, [task, company, process, op, per, attempts, await estimate(task), prices.placeholder.id, released]);
    return op;
  };
  await hold({ company: a.companyId, process: a.recruitment.id, per: 1000 });
  await hold({ company: a.companyId, process: a.recruitment.id, op: shared, per: 1000, attempts: 3 });
  await hold({ task: 'cv_screening', company: b.companyId, process: b.recruitment.id, op: started.attempt_id, per: 500, attempts: 2 });
  await hold({ company: b.companyId, process: b.recruitment.id, per: 9000, released: true });
  await hold({ company: b.companyId, process: b.recruitment.id, per: 9000, created: "now() - interval '2 hours'", expires: "now() - interval '1 hour'" });
}

test('SC-021-D cost views: grouping rules, cost classes, placeholder/missing FX, pseudonymous candidates', async t => {
  const e = await boot(t), { db, h, a, b } = e;
  await scenario(e);

  const [total] = await e.costs('total');
  // 8 attempts in the period; operations: op1, placeholder op, A exercise, B exercise (same key, other company), EUR op, reservation.
  assert.deepEqual(classes(total), { attempts: 8, operations: 6, confirmed: 3, placeholder: 1, unpriced: 1, unknown: 1, released: 1, reserved: 1, bounds: 1 });
  // Live SC-021-C reservations: shown separately (count + unused amount), never as cost or attempts.
  assert.equal(n(total.live_reservations), 3);
  assert.deepEqual(total.reservations_unused_micros, { USD: 4000 });
  // C's own usage function agrees on the unused amount held (same liveness and remainder rule).
  await h.asAdmin();
  for (const [company, held] of [[a.companyId, 3000], [b.companyId, 1000]]) {
    const pb = (await db.query('select * from ai_ledger.period_bounds(now())')).rows[0];
    const c = (await db.query("select reserved_micros from ai_ledger.budget_usage($1,$2,$3,'USD',now())", [company, pb.period_start, pb.period_end])).rows[0];
    const d = (await db.query('select coalesce(sum(unused_micros),0)::bigint v from ai_ledger.live_reservations($1,$2,now()) where company_id=$3',
      [pb.period_start, pb.period_end, company])).rows[0];
    assert.equal(Number(c.reserved_micros), held); assert.equal(Number(d.v), held);
  }
  assert.deepEqual(total.cost_micros, { USD: { confirmed: 3000000, placeholder: 500000, reserved: 0 }, EUR: { confirmed: 1000000, placeholder: 0, reserved: 0 },
    '?': { confirmed: 0, placeholder: 0, reserved: 300 } });
  // EUR has no rate: confirmed PLN cost is unavailable, never guessed. Placeholder USD→PLN 4.000000: 0.5 USD → 200 gr.
  assert.equal(total.fx_missing, true); assert.equal(total.confirmed_pln_minor, null);
  assert.equal(n(total.placeholder_pln_minor), 200); assert.equal(total.fx_placeholder, true);

  const byCompany = Object.fromEntries((await e.costs('company')).map(r => [r.group_key, r]));
  assert.deepEqual(Object.keys(byCompany).sort(), [a.companyId, b.companyId].sort());
  assert.deepEqual(classes(byCompany[a.companyId]), { attempts: 5, operations: 3, confirmed: 1, placeholder: 1, unpriced: 1, unknown: 1, released: 1, reserved: 0, bounds: 1 });
  assert.equal(n(byCompany[a.companyId].confirmed_pln_minor), 400); assert.equal(byCompany[a.companyId].fx_missing, false);
  assert.equal(byCompany[a.companyId].company_id, a.companyId); assert.ok(byCompany[a.companyId].company_name);
  assert.deepEqual(classes(byCompany[b.companyId]), { attempts: 3, operations: 3, confirmed: 2, placeholder: 0, unpriced: 0, unknown: 0, released: 0, reserved: 1, bounds: 0 });
  assert.deepEqual([n(byCompany[a.companyId].live_reservations), byCompany[a.companyId].reservations_unused_micros], [2, { USD: 3000 }]);
  assert.deepEqual([n(byCompany[b.companyId].live_reservations), byCompany[b.companyId].reservations_unused_micros], [1, { USD: 1000 }]);
  assert.equal(byCompany[b.companyId].confirmed_pln_minor, null); assert.equal(byCompany[b.companyId].fx_missing, true);

  const byRecruitment = await e.costs('recruitment');
  await h.asAdmin();
  const names = Object.fromEntries((await db.query('select id::text, name from public.recruitments where id = any($1)', [[a.recruitment.id, b.recruitment.id]])).rows.map(r => [r.id, r.name]));
  assert.deepEqual(byRecruitment.map(r => [r.group_label, n(r.attempts), r.company_id]).sort(),
    [[names[a.recruitment.id], 5, a.companyId], [names[b.recruitment.id], 3, b.companyId]].sort());

  // Candidates appear only as a pseudonym; the application id never leaves the function.
  const byCandidate = await e.costs('candidate');
  // A, B, `none` (exercise rows and holds) and the candidate whose screening is only reserved so far.
  assert.equal(byCandidate.length, 4);
  assert.deepEqual(byCandidate.filter(r => n(r.attempts) === 0).map(r => n(r.live_reservations)), [1]);
  const none = byCandidate.find(r => r.group_key === 'none');
  assert.equal(n(none.attempts), 2); assert.equal(n(none.operations), 2, 'exercise operation = (company, recruitment, key)');
  for (const r of byCandidate.filter(r => r.group_key !== 'none')) assert.match(r.group_key, /^K-[0-9A-F]{16}$/);
  assert.deepEqual(byCandidate.filter(r => r.group_key !== 'none' && n(r.attempts) > 0).map(r => n(r.attempts)).sort(), [2, 4]);
  const serialized = JSON.stringify(byCandidate);
  for (const id of [a.application.id, b.application.id, a.candidate?.id, b.candidate?.id].filter(Boolean)) assert.ok(!serialized.includes(id));

  const byModel = await e.costs('provider');
  assert.deepEqual(byModel.map(r => [r.group_key, n(r.attempts)]), [['openai', 8]]);
  const byTask = Object.fromEntries((await e.costs('task')).map(r => [r.group_key, r]));
  assert.equal(n(byTask.cv_screening.operations), 4); assert.equal(n(byTask.exercise_generation.operations), 2);
  assert.equal(byTask.exercise_generation.group_label, 'Generowanie zadań');
  // Package of the company when the attempt was made: both companies hold a paid PRESELEKCJA grant from the fixture.
  assert.deepEqual((await e.costs('package')).map(r => [r.group_key, r.group_label, n(r.attempts)]), [['PRESELEKCJA', 'PRESELEKCJA', 8]]);
  // A wider period includes the older row; months are grouped in Europe/Warsaw time.
  const byMonth = await e.costs('month', e.month.old, e.month.n);
  assert.equal(byMonth.reduce((s, r) => s + n(r.attempts), 0), 9);
  assert.ok(byMonth.some(r => r.group_key === e.month.old.slice(0, 7) && n(r.attempts) === 1));

  // Operator enters a real EUR rate and later a real USD rate: real wins over placeholder; corrections are new rows.
  await e.asOperator();
  const add = (key, cur, rate, note, placeholder = false) => db.query('select public.sc021_operator_add_fx_rate($1,$2,$3,$4,$5,$6) id',
    [key, cur, rate, '2026-01-01T00:00:00Z', note, placeholder]);
  const eurKey = randomUUID();
  const eur = (await add(eurKey, 'EUR', 4300000, 'Synthetic test rate')).rows[0].id;
  assert.equal((await add(eurKey, 'EUR', 4300000, 'Synthetic test rate')).rows[0].id, eur, 'idempotent replay');
  await assert.rejects(add(eurKey, 'EUR', 4300001, 'Synthetic test rate'), denied('PT409'));
  for (const bad of [['GBP', 4000000, 'x note'], ['USD', 0, 'x note'], ['USD', 1000000001, 'x note'], ['USD', 4000000, 'no']]) {
    await assert.rejects(add(randomUUID(), ...bad), denied('22023'), JSON.stringify(bad));
  }
  let [withEur] = await e.costs('total');
  // USD on the placeholder rate (3 USD → 1200 gr) + EUR at 4.3 (1 EUR → 430 gr).
  assert.equal(withEur.fx_missing, false); assert.equal(n(withEur.confirmed_pln_minor), 1630); assert.equal(withEur.fx_placeholder, true);
  await e.asOperator();
  await add(randomUUID(), 'USD', 4100000, 'Synthetic real-flagged test rate');
  [withEur] = await e.costs('total');
  assert.equal(n(withEur.confirmed_pln_minor), 1660); assert.equal(n(withEur.placeholder_pln_minor), 205); assert.equal(withEur.fx_placeholder, false);
  // A real rate beats a placeholder even when old; a rate older than 45 days at the call is flagged.
  assert.equal(withEur.fx_stale, true);
  await e.asOperator();
  const rates = (await db.query('select * from public.sc021_operator_fx_rates()')).rows;
  assert.equal(rates.length, 3);
  assert.deepEqual(rates.filter(r => r.from_migration).map(r => [r.base_currency, n(r.rate_micros), r.placeholder]), [['USD', 4000000, true]]);
});

test('SC-021-D margin: net revenue from paid catalog orders, other variable costs (versioned), FX and status flags', async t => {
  const e = await boot(t), { db, h, a, b } = e;
  await scenario(e);
  // Integer net from gross (round half up), VAT basis from the catalog version.
  await h.asAdmin();
  for (const [gross, bp, net] of [[30000, 2300, 24390], [61500, 2300, 50000], [1, 2300, 1], [123, 0, 123], [1, 10000, 1], [3, 10000, 2]]) {
    assert.equal(Number((await db.query('select ai_ledger.net_from_gross($1,$2) v', [gross, bp])).rows[0].v), net, `${gross}/${bp}`);
  }
  // A paid catalog order for A (as public.sc19_settle_catalog_order would record it, with its journal line).
  const version = (await db.query("select id, vat_basis_points from pricing.catalog_versions where status='PUBLISHED'")).rows[0];
  assert.equal(version.vat_basis_points, 2300);
  await db.query(`insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,quantity,gross_minor,cv_credits,
    service_units,terms_revision,terms_text,status,settlement_reference,settled_by,settled_at)
    values($1,$2,$3,$4,'package','PRESELEKCJA','PRESELEKCJA',1,30000,60,0,'t','t','paid','FV/SYNTH/0001',$5,now())`,
  [a.companyId, users.owner, randomUUID(), version.id, operator]);
  await db.query("insert into private.sc19_credit_journal(company_id,reason,delta,reference) values($1,'paid_grant',60,'settlement:FV/SYNTH/0001')", [a.companyId]);
  // A pending order is not revenue.
  await db.query(`insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,quantity,gross_minor,cv_credits,
    service_units,terms_revision,terms_text) values($1,$2,$3,$4,'package','WERYFIKACJA','WERYFIKACJA',1,61500,60,0,'t','t')`,
  [b.companyId, users.otherOwner, randomUUID(), version.id]);

  // Other variable costs: operator only, versioned by supersession, idempotent by request key.
  await e.asOperator();
  const addCost = (key, over = {}) => { const v = { month: e.month.m, company: a.companyId, pkg: 'PRESELEKCJA', category: 'payment_fee', amount: 150,
    note: 'Synthetic fee', supersedes: null, ...over };
  return db.query('select public.sc021_operator_add_other_cost($1,$2,$3,$4,$5,$6,$7,$8) id', [key, v.month, v.company, v.pkg, v.category, v.amount, v.note, v.supersedes]); };
  const k1 = randomUUID();
  const first = (await addCost(k1)).rows[0].id;
  assert.equal((await addCost(k1)).rows[0].id, first);
  await assert.rejects(addCost(k1, { amount: 151 }), denied('PT409'));
  const fix = (await addCost(randomUUID(), { amount: 120, supersedes: first })).rows[0].id;
  await assert.rejects(addCost(randomUUID(), { amount: 110, supersedes: first }), denied('PT409'), 'a version is corrected once');
  await assert.rejects(addCost(randomUUID(), { amount: 110, supersedes: fix, category: 'sms' }), denied('22023'), 'correction keeps the scope');
  await assert.rejects(addCost(randomUUID(), { company: randomUUID() }), denied('PT404'));
  for (const bad of [{ month: e.month.m.slice(0, 8) + '15' }, { category: 'salary' }, { pkg: 'GOLD' }, { amount: -1 }, { note: 'x'.repeat(301) }]) {
    await assert.rejects(addCost(randomUUID(), bad), denied('22023'), JSON.stringify(bad));
  }
  await addCost(randomUUID(), { month: e.month.old, company: b.companyId, pkg: null, category: 'sms', amount: 999 });
  // Without a package: attributed to the company's package at the end of that month (A: PRESELEKCJA order).
  await addCost(randomUUID(), { company: a.companyId, pkg: null, category: 'email', amount: 30 });
  const listed = (await db.query('select * from public.sc021_operator_other_costs($1,$2)', [e.month.old, e.month.n])).rows;
  assert.deepEqual(listed.map(r => [n(r.amount_minor), r.superseded]).sort(), [[120, false], [150, true], [30, false], [999, false]]);
  // Paging and company filter: every line that affects the margin can be found and corrected.
  for (let i = 0; i < 3; i++) await addCost(randomUUID(), { company: a.companyId, pkg: null, category: 'other', amount: 1, note: `page ${i}` });
  const page = async (offset, size, company = null) => (await db.query('select * from public.sc021_operator_other_costs($1,$2,$3,$4,$5)',
    [e.month.old, e.month.n, company, offset, size])).rows;
  const all = await page(0, 500);
  assert.equal(all.length, 7);
  const pages = [await page(0, 3), await page(3, 3), await page(6, 3)];
  assert.deepEqual(pages.map(p => p.length), [3, 3, 1]);
  assert.deepEqual(pages.flat().map(r => r.id), all.map(r => r.id), 'stable order across pages');
  const last = pages[2][0];
  // The oldest line (B's 999 in the earlier month) sits on the last page; correct it there (same amount, new note).
  assert.deepEqual([n(last.amount_minor), last.company_id, last.superseded], [999, b.companyId, false]);
  await addCost(randomUUID(), { month: e.month.old, company: b.companyId, pkg: null, category: 'sms', amount: 999, note: 'corrected',
    supersedes: last.id });
  assert.equal((await page(0, 500)).find(r => r.id === last.id).superseded, true);
  assert.deepEqual([...new Set((await page(0, 500, b.companyId)).map(r => r.company_id))], [b.companyId]);
  for (const [offset, size] of [[-1, 3], [0, 0], [0, 501]]) await assert.rejects(page(offset, size), denied('22023'));
  // Remove the extra lines' effect from the totals below: correct them to 0.
  for (const r of (await page(0, 500, a.companyId)).filter(r => !r.superseded && r.category === 'other' && n(r.amount_minor) === 1)) {
    await addCost(randomUUID(), { company: a.companyId, pkg: null, category: 'other', amount: 0, note: null, supersedes: r.id });
  }

  // Only the placeholder USD rate: B has an EUR cost without a rate → margin unavailable; A is estimated.
  let byCompany = Object.fromEntries((await e.margin('company')).map(r => [r.group_key, r]));
  const ma = byCompany[a.companyId], mb = byCompany[b.companyId];
  assert.deepEqual([n(ma.paid_orders), n(ma.revenue_gross_minor), n(ma.revenue_net_minor), n(ma.payments_without_amount)], [1, 30000, 24390, 1]);
  // A's AI cost: (1.0 + 0.5) USD × 4.000000 → 600 gr; other 120 (the corrected version only) + 30.
  assert.deepEqual([n(ma.ai_cost_pln_minor), n(ma.other_costs_minor), n(ma.margin_minor), ma.margin_status], [600, 150, 24390 - 600 - 150, 'estimated']);
  assert.deepEqual(ma.reasons.sort(), ['fx_placeholder', 'payments_without_amount', 'placeholder_prices', 'reserved_not_counted', 'unknown_attempts', 'unpriced_attempts']);
  assert.deepEqual([n(mb.revenue_net_minor), mb.ai_cost_pln_minor, mb.margin_minor, mb.margin_status], [0, null, null, 'unavailable']);
  assert.ok(mb.reasons.includes('fx_missing') && mb.reasons.includes('reserved_not_counted'));
  let [total] = await e.margin('total');
  assert.equal(total.margin_status, 'unavailable'); assert.equal(total.margin_minor, null);

  // Real (operator-entered) rates for both currencies.
  await e.asOperator();
  await db.query("select public.sc021_operator_add_fx_rate($1,'EUR',4300000,'2026-01-01',$2,false)", [randomUUID(), 'Synthetic test rate']);
  await db.query("select public.sc021_operator_add_fx_rate($1,'USD',4100000,'2026-01-01',$2,false)", [randomUUID(), 'Synthetic test rate']);
  byCompany = Object.fromEntries((await e.margin('company')).map(r => [r.group_key, r]));
  assert.deepEqual([n(byCompany[a.companyId].ai_cost_pln_minor), n(byCompany[a.companyId].margin_minor)], [615, 24390 - 615 - 150]);
  assert.ok(!byCompany[a.companyId].reasons.includes('fx_placeholder'));
  assert.ok(byCompany[a.companyId].reasons.includes('fx_stale'), 'real rate from January is older than 45 days');
  // B: 2 USD × 4.1 + 1 EUR × 4.3 = 1250 gr; no revenue with an amount → negative margin, still estimated.
  assert.deepEqual([n(byCompany[b.companyId].ai_cost_pln_minor), n(byCompany[b.companyId].margin_minor), byCompany[b.companyId].margin_status],
    [1250, -1250, 'estimated']);
  [total] = await e.margin('total');
  assert.deepEqual([n(total.revenue_net_minor), n(total.ai_cost_pln_minor), n(total.other_costs_minor), n(total.margin_minor)],
    [24390, 1865, 150, 24390 - 1865 - 150]);
  const byPackage = await e.margin('package');
  assert.deepEqual(byPackage.map(r => [r.group_key, n(r.other_costs_minor)]), [['PRESELEKCJA', 150]]);
  // A fresh real rate for the older month (same value): that month is no longer stale.
  await e.asOperator();
  await db.query("select public.sc021_operator_add_fx_rate($1,'USD',4100000,$2,$3,false)", [randomUUID(), `${e.month.old}T00:00:00Z`, 'Synthetic test rate']);
  const byMonth = Object.fromEntries((await e.margin('month', e.month.old, e.month.n)).map(r => [r.group_key, r]));
  assert.equal(n(byMonth[e.month.old.slice(0, 7)].other_costs_minor), 999);
  assert.equal(n(byMonth[e.month.old.slice(0, 7)].ai_cost_pln_minor), 2870, '7 USD × 4.1');
  // That month has only an approved price, a real rate and operator costs: the margin is confirmed.
  assert.deepEqual([n(byMonth[e.month.old.slice(0, 7)].margin_minor), byMonth[e.month.old.slice(0, 7)].margin_status, byMonth[e.month.old.slice(0, 7)].reasons],
    [-2870 - 999, 'confirmed', []]);
});

test('SC-021-D access: operator only; members, revoked operators and anon are refused; tables are append-only', async t => {
  const e = await boot(t), { db, h, a } = e;
  await scenario(e);
  const calls = [
    ['select * from public.sc021_operator_ai_costs($1,$2,$3)', [e.month.m, e.month.m, 'total']],
    ['select * from public.sc021_operator_margin($1,$2,$3)', [e.month.m, e.month.m, 'total']],
    ['select * from public.sc021_operator_fx_rates()', []],
    ['select * from public.sc021_operator_other_costs($1,$2,$3,$4,$5)', [e.month.m, e.month.m, null, 0, 100]],
    ['select public.sc021_operator_add_fx_rate($1,$2,$3,$4,$5,$6)', [randomUUID(), 'USD', 4000000, '2026-01-01', 'Synthetic', false]],
    ['select public.sc021_operator_add_other_cost($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), e.month.m, a.companyId, null, 'sms', 1, null, null]],
  ];
  for (const [role, id] of [['authenticated', users.owner], ['authenticated', users.recruiter], ['authenticated', users.otherOwner], ['anon', null], ['screening_worker', null]]) {
    await h.asUser(id, role);
    for (const [sql, args] of calls) await assert.rejects(db.query(sql, args), denied('42501'), `${role}/${id}: ${sql}`);
    for (const table of ['ai_ledger.fx_rates', 'ai_ledger.other_cost_lines']) await assert.rejects(db.query(`select * from ${table}`), denied('42501'));
    await assert.rejects(db.query('select * from ai_ledger.cost_rows(now() - interval \'1 day\', now())'), denied('42501'));
  }
  // The operator reads and writes only through the functions, never the tables.
  await e.asOperator();
  for (const [sql, args] of calls) await db.query(sql, args);
  await assert.rejects(db.query('select * from ai_ledger.fx_rates'), denied('42501'));
  await assert.rejects(db.query("insert into ai_ledger.other_cost_lines(request_key,period_month,company_id,category,amount_minor,created_by) values($1,$2,$3,'sms',1,$4)",
    [randomUUID(), e.month.m, a.companyId, operator]), denied('42501'));
  for (const [from, to, group] of [[e.month.m, e.month.old, 'total'], ['2024-01-01', '2026-01-01', 'total'], [e.month.m, e.month.m, 'nope'],
    [e.month.m, e.month.m, null]]) {
    await assert.rejects(db.query('select * from public.sc021_operator_ai_costs($1,$2,$3)', [from, to, group]), denied('22023'), `${from}..${to} ${group}`);
  }
  await assert.rejects(db.query('select * from public.sc021_operator_margin($1,$2,$3)', [e.month.m, e.month.m, 'candidate']), denied('22023'));
  // Revocation takes effect immediately.
  await h.asAdmin();
  await db.query('update public.platform_operators set revoked_at=now() where user_id=$1', [operator]);
  await e.asOperator();
  for (const [sql, args] of calls) await assert.rejects(db.query(sql, args), denied('42501'));
  // Append-only, even for the table owner.
  await h.asAdmin();
  await assert.rejects(db.query('update ai_ledger.fx_rates set rate_micros=1'), denied('42501'));
  await assert.rejects(db.query('delete from ai_ledger.fx_rates'), denied('42501'));
  await assert.rejects(db.query('update ai_ledger.other_cost_lines set amount_minor=0'), denied('42501'));
  await assert.rejects(db.query('delete from ai_ledger.other_cost_lines'), denied('42501'));
  // The migration seeds one placeholder rate and no other cost lines; members still read only their own ledger rows (SC-021-B RLS).
  assert.deepEqual((await db.query('select base_currency, rate_micros::int, placeholder, created_by from ai_ledger.fx_rates where created_by is null')).rows,
    [{ base_currency: 'USD', rate_micros: 4000000, placeholder: true, created_by: null }]);
  await h.asUser(users.recruiter);
  assert.deepEqual([...new Set((await db.query('select company_id from ai_ledger.attempts')).rows.map(r => r.company_id))], [a.companyId]);
  // Functions are SECURITY DEFINER with an empty search_path.
  await h.asAdmin();
  const defs = (await db.query(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname='public' and p.proname like 'sc021_operator_%' order by 1`)).rows;
  assert.equal(defs.length, 6);
  for (const d of defs) { assert.equal(d.prosecdef, true, d.proname); assert.deepEqual(d.proconfig, ['search_path=""'], d.proname); }
});

test('SC-021-D rollback refuses with operator data; pseudonym key is private', async t => {
  const e = await boot(t), { db, h, a } = e;
  await scenario(e);
  const { readFile } = await import('node:fs/promises');
  const up = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  const down = await readFile(new URL('../supabase/rollbacks/20261110090000_sc021_cost_dashboard_down.sql', import.meta.url), 'utf8');
  const signature = async () => (await db.query('select private.erasure_schema_signature() v')).rows[0].v;
  await h.asAdmin();
  const ledgerRows = (await db.query('select count(*)::int n from ai_ledger.attempts')).rows[0].n;
  // The pseudonym key is never readable by API roles; pseudonyms are keyed (not a plain hash of the id).
  const pseudonym = (await db.query('select ai_ledger.candidate_pseudonym($1) p', [a.application.id])).rows[0].p;
  assert.match(pseudonym, /^K-[0-9A-F]{16}$/);
  const plain = (await db.query("select upper(left(encode(sha256(convert_to($1::text,'UTF8')),'hex'),16)) p", [a.application.id])).rows[0].p;
  assert.notEqual(pseudonym.slice(2), plain);
  for (const [role, id] of [['authenticated', users.owner], ['authenticated', operator], ['anon', null]]) {
    await h.asUser(id, role);
    await assert.rejects(db.query('select * from ai_ledger.pseudonym_key'), denied('42501'));
    await assert.rejects(db.query('select ai_ledger.candidate_pseudonym($1)', [a.application.id]), denied('42501'));
  }
  // Operator-entered data blocks the rollback.
  await e.asOperator();
  await db.query("select public.sc021_operator_add_fx_rate($1,'EUR',4300000,'2026-01-01','Synthetic',false)", [randomUUID()]);
  await h.asAdmin();
  await assert.rejects(db.query(down), error => error.message.includes('sc021d_rollback_operator_data_present'));
  await db.query('rollback').catch(() => {});
  assert.notEqual((await db.query("select to_regclass('ai_ledger.fx_rates') v")).rows[0].v, null);
  assert.equal(await signature(), r15);
  assert.equal((await db.query('select count(*)::int n from ai_ledger.attempts')).rows[0].n, ledgerRows);
});

test('SC-021-D rollback: up → down → up with only the migration seed, SC-010 signature unchanged', async t => {
  const fresh = await boot(t);
  await scenario(fresh);
  const { readFile } = await import('node:fs/promises');
  const up = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  const down = await readFile(new URL('../supabase/rollbacks/20261110090000_sc021_cost_dashboard_down.sql', import.meta.url), 'utf8');
  await fresh.h.asAdmin();
  await fresh.db.query(down);
  for (const name of ['ai_ledger.fx_rates', 'ai_ledger.other_cost_lines', 'ai_ledger.pseudonym_key']) {
    assert.equal((await fresh.db.query('select to_regclass($1) v', [name])).rows[0].v, null, name);
  }
  assert.equal((await fresh.db.query("select to_regprocedure('public.sc021_operator_margin(date,date,text)') v")).rows[0].v, null);
  assert.notEqual((await fresh.db.query("select to_regclass('ai_ledger.attempts') v")).rows[0].v, null, 'B ledger untouched');
  assert.equal((await fresh.db.query('select private.erasure_schema_signature() v')).rows[0].v, r15);
  await fresh.db.query(up);
  assert.equal((await fresh.db.query('select private.erasure_schema_signature() v')).rows[0].v, r15);
  assert.equal((await fresh.db.query('select count(*)::int n from ai_ledger.fx_rates')).rows[0].n, 1);
  await fresh.h.asUser(operator);
  // B ledger rows survive the round trip and are read again.
  assert.equal(Number((await fresh.db.query("select attempts from public.sc021_operator_ai_costs($1,$1,'total')", [fresh.month.m])).rows[0].attempts), 8);
});
