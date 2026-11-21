// R7 (Codex P2 on PR #566, thread r4649510675): the operator AI cost and margin report
// attributes a WERYFIKACJA / ASSESSMENT CENTER package bought through Stripe to its own
// package, not PRESELEKCJA (20261121200000_r7_cost_report_stripe_packages.sql).
// Native disposable PostgreSQL (CI: PG16), full checked-in migration chain, synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';

const migration = '20261121200000_r7_cost_report_stripe_packages.sql';
const helper = 'ai_ledger.stripe_package_settlements()';
const operator = users.outsider;

test('R7 cost report: Stripe WERYFIKACJA / ASSESSMENT CENTER grants count for their own package; PRESELEKCJA unchanged; rollback',
  async t => {
  const e = await activeBoot(t, { fullChain: true, throughMigration: migration });
  const { db, h } = e;
  await h.asAdmin();
  const signature = (await db.query('select private.erasure_schema_signature() v')).rows[0].v;
  // Seeding grants each company one PRESELEKCJA pack (private.sc19_grant_paid), as an operator grant would.
  const a = await e.seed(), b = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);

  // The helper is owner-only, like the other ai_ledger helpers.
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  assert.equal(await one(`select count(*)::int v from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid=$1::regprocedure and a.grantee<>p.proowner`, [helper]), 0);
  assert.equal(await one('select prosecdef v from pg_proc where oid=$1::regprocedure', [helper]), false);
  for (const role of ['anon', 'authenticated', 'service_role', 'screening_worker', 'ai_ledger_writer', 'sc19_p24_preview', 'sc19_p24_checkout']) {
    if (!await one('select to_regrole($1) is not null v', [role])) continue;
    assert.equal(await one('select has_function_privilege($1,$2,$3) v', [role, helper, 'execute']), false, role);
  }
  // Signatures and ACL of the redefined functions are unchanged: the operator read is still for authenticated.
  assert.equal(await one("select has_function_privilege('authenticated','public.sc021_operator_margin(date,date,text)','execute') v"), true);
  assert.equal(await one("select has_function_privilege('anon','public.sc021_operator_margin(date,date,text)','execute') v"), false);

  // A paid TEST-mode Stripe package order, granted the one way the app does it (sc19_stripe.grant_package).
  const stripePackage = async (company, owner, code, status = 'paid') => {
    await h.asAdmin();
    const id = randomUUID(), sid = `cs_test_${id.replace(/-/g, '')}`;
    const [amount, credits] = code === 'WERYFIKACJA' ? [61500, 60] : [149900, 50];
    await db.query(`insert into sc19_stripe.package_orders(id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,terms_revision,
      amount_minor,currency,credits,provider,account,mode,status,session_id,checkout_url,checkout_deadline_ms)
      values($1,$2,$3,$4,$5,'synthetic-offer','r1','t1',$6,'PLN',$7,'stripe','ktig-consulting','test','awaiting_payment',$8,$9,1)`,
    [id, company, owner, randomUUID(), code, amount, credits, sid, `https://checkout.stripe.com/c/pay/${sid}`]);
    if (status === 'paid') {
      const key = `pi_synthetic_${id.replace(/-/g, '')}`;
      assert.equal(await one('select sc19_stripe.grant_package($1,$2) v', [id, key]), null);
      await db.query("update sc19_stripe.package_orders set status='paid', payment_id=$2 where id=$1", [id, key]);
    }
    return id;
  };
  const attempt = async company => {
    await h.asAdmin();
    await db.query(`insert into ai_ledger.attempts(attempt_id,operation_id,company_id,task,attempt_no,provider,model,model_key,policy_version,
      outcome,billing,status,input_tokens,cached_input_tokens,output_tokens,latency_ms,content_hash,settled_at,bounds_exceeded,created_at)
      values($1,$2,$3,'exercise_generation',1,'openai','m','k','v','completed','billed','settled',1,1,1,1,$4,now(),false,clock_timestamp())`,
    [randomUUID(), randomUUID(), company, 'a'.repeat(64)]);
  };
  const ranges = async company => { await h.asAdmin();
    return (await db.query('select package_code from ai_ledger.package_ranges() where company_id=$1 order by t_from, package_code', [company]))
      .rows.map(r => r.package_code); };
  const month = (await db.query("select to_char(ai_ledger.warsaw_month(now()),'YYYY-MM-DD') m")).rows[0].m;
  const byPackage = async (fn, company) => { await h.asUser(operator);
    const rows = (await db.query(`select * from public.${fn}($1,$1,'package')`, [month])).rows;
    await h.asAdmin(); return Object.fromEntries(rows.map(r => [r.group_key, r])); };
  const costPackages = async () => Object.fromEntries(Object.entries(await byPackage('sc021_operator_ai_costs')).map(([k, r]) => [k, Number(r.attempts)]));
  const marginPackages = async () => Object.fromEntries(Object.entries(await byPackage('sc021_operator_margin'))
    .map(([k, r]) => [k, [Number(r.paid_orders), Number(r.payments_without_amount), Number(r.revenue_gross_minor)]]));

  // A: one AI call on the PRESELEKCJA pack, then WERYFIKACJA via Stripe, then two calls.
  await attempt(a.companyId);
  await stripePackage(a.companyId, users.owner, 'WERYFIKACJA');
  await attempt(a.companyId); await attempt(a.companyId);
  // B: one call on PRESELEKCJA, a paid AC order, one call; then an UNPAID AC order, which changes nothing.
  await attempt(b.companyId);
  await stripePackage(b.companyId, users.otherOwner, 'ASSESSMENT_CENTER');
  await attempt(b.companyId);
  await stripePackage(b.companyId, users.otherOwner, 'ASSESSMENT_CENTER', 'awaiting_payment');

  await t.test('fixed: each Stripe grant starts its own package; PRESELEKCJA grants keep PRESELEKCJA', async () => {
    assert.deepEqual(await ranges(a.companyId), ['PRESELEKCJA', 'WERYFIKACJA']);
    assert.deepEqual(await ranges(b.companyId), ['PRESELEKCJA', 'ASSESSMENT_CENTER']);
    // Helper: paid orders only, one per company here, company-scoped.
    const s = (await db.query(`select company_id, package_code from ${helper.replace('()', '')}() order by package_code`)).rows;
    assert.deepEqual(s.map(r => [r.company_id, r.package_code]), [[b.companyId, 'ASSESSMENT_CENTER'], [a.companyId, 'WERYFIKACJA']]);
    // Costs: A's first call PRESELEKCJA, the next two WERYFIKACJA; B's call before the paid AC order PRESELEKCJA, after it AC.
    assert.deepEqual(await costPackages(), { ASSESSMENT_CENTER: 1, PRESELEKCJA: 2, WERYFIKACJA: 2 });
    // Margin: the test-mode Stripe payment is a payment WITHOUT amount of its own package (no money shown as revenue);
    // the two PRESELEKCJA grants stay PRESELEKCJA payments without amount.
    assert.deepEqual(await marginPackages(), { ASSESSMENT_CENTER: [0, 1, 0], PRESELEKCJA: [0, 2, 0], WERYFIKACJA: [0, 1, 0] });
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
  });

  const up = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  const down = await readFile(new URL(`../supabase/rollbacks/${migration.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8');

  await t.test('rollback restores the old bodies (the bug: everything PRESELEKCJA), forward again fixes it', async () => {
    await h.asAdmin();
    await assert.rejects(db.query(up), /already_installed/);
    await db.query('rollback').catch(() => {});
    await db.query(down);
    assert.equal(await one('select to_regprocedure($1) is null v', [helper]), true);
    assert.deepEqual(await ranges(a.companyId), ['PRESELEKCJA', 'PRESELEKCJA']);
    assert.deepEqual(await costPackages(), { PRESELEKCJA: 5 });
    assert.deepEqual(await marginPackages(), { PRESELEKCJA: [0, 4, 0] });
    assert.equal(await one("select has_function_privilege('authenticated','public.sc021_operator_margin(date,date,text)','execute') v"), true);
    await db.query(up);
    assert.deepEqual(await costPackages(), { ASSESSMENT_CENTER: 1, PRESELEKCJA: 2, WERYFIKACJA: 2 });
    assert.deepEqual(await marginPackages(), { ASSESSMENT_CENTER: [0, 1, 0], PRESELEKCJA: [0, 2, 0], WERYFIKACJA: [0, 1, 0] });
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
  });
});
