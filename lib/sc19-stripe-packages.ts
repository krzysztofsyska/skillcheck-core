/** R7: WERYFIKACJA and ASSESSMENT CENTER through Stripe Checkout (TEST mode only).
 *
 * The SC-019 orchestration (lib/sc19-payments.ts) and the Stripe adapter are the
 * same as for PRESELEKCJA. Only the storage differs: these orders live in
 * sc19_stripe.package_orders (migration 20261121150000_r7_stripe_packages.sql),
 * because private.sc19_payment_offers/orders are PRESELEKCJA-only and changing
 * them would change the SC-010 erasure schema signature. This module plugs that
 * table into the Postgres payment store inside the SAME database transaction, so
 * the company lock, the one-unresolved-purchase rule and the grant are atomic
 * across both order sources.
 *
 * A paid package is granted only by sc19_stripe.grant_package(): CV analyses on
 * the existing balance plus sc19_commerce.entitlements 'package:<code>', the row
 * the R3 Assessment Center gate reads.
 *
 * Offers are constants reviewed in code (prices only from STRIPE_CATALOG, which
 * tests compare with docs/cennik-2026-11-02.md; the database pins the same amounts
 * in a check constraint). Without the migration nothing here is offered or read,
 * so PRESELEKCJA works exactly as before.
 */
import type { PaymentOrder, PaymentTransaction } from './sc19-payments.ts';
import { Sc19PaymentError, orderPackage } from './sc19-payments.ts';
import type { CheckoutOffer, PaymentSqlClient, PaymentStoreExtension } from './sc19-payment-postgres.ts';
import { EXPIRED_CHECKOUT_MARKER, RETIRED_PAYMENT_PROVIDERS, closeExpiredInDatabase } from './sc19-payment-postgres.ts';
import { STRIPE_CATALOG } from './stripe-catalog.ts';

const fail = (code: string): never => { throw new Sc19PaymentError(code); };
/** 2027-12-31T23:59:59Z, the same finite validity as the PRESELEKCJA offer revision. */
const VALID_UNTIL_MS = 1_830_297_599_000;
const pln = (minor: number) => `${(minor / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} zł`;
const commonTerms = [
  'Analizy CV są ważne 3 miesiące od dnia ich przyznania i nie przechodzą na kolejny okres.',
  'Pakiet przyznajemy automatycznie po potwierdzeniu płatności online przez operatora płatności (Stripe).',
  'Faktura VAT jest wystawiana po zaksięgowaniu płatności i wysyłana e-mailem.',
  'Wyniki są informacją wspierającą rekrutera. SkillCheck nie podejmuje decyzji o zatrudnieniu — każdy wynik weryfikuje człowiek.',
  'Zasady reklamacji i odstąpienia opisuje Regulamin (§ 10–11); wzór formularza odstąpienia jest dostępny pod /regulamin/formularz-odstapienia.',
  'Dane osobowe kandydatów są przetwarzane na podstawie Umowy powierzenia (DPA), dostępnej pod /regulamin/umowa-powierzenia.',
];
function packageOffer(code: 'WERYFIKACJA' | 'ASSESSMENT_CENTER', id: string, revision: string, termsRevision: string,
  contents: string): CheckoutOffer {
  const pkg = STRIPE_CATALOG[code];
  return Object.freeze({
    id, revision, plan: code, active: true, approved: true, amountMinor: pkg.grossMinor, currency: 'PLN',
    credits: pkg.cvCredits, termsRevision, validUntilMs: VALID_UNTIL_MS,
    termsText: [`${pkg.name} — jednorazowy pakiet: ${pkg.cvCredits} analiz CV, ${contents}, za ${pln(pkg.grossMinor)} brutto (VAT 23% w cenie).`,
      ...commonTerms].join('\n'),
  });
}
/** Changing an offer's economics or terms is a NEW id and revision (paid orders keep the id they were bought under). */
export const STRIPE_PACKAGE_OFFERS: readonly CheckoutOffer[] = Object.freeze([
  packageOffer('WERYFIKACJA', 'weryfikacja-60-2026-11-r1', 'weryfikacja-60-v1', 'weryfikacja-terms-2026-11-v1',
    'testy kompetencji dla kandydatów z shortlisty i rozszerzony raport'),
  packageOffer('ASSESSMENT_CENTER', 'assessment-center-50-2026-11-r1', 'assessment-center-50-v1', 'assessment-center-terms-2026-11-v1',
    'testy kompetencji, zadania praktyczne i sesja Assessment Center dla finalistów (5–6 osób) z kompleksowym raportem'),
]);
const offerById = (id: string) => STRIPE_PACKAGE_OFFERS.find(o => o.id === id) ?? null;
const sellable = (o: CheckoutOffer) => STRIPE_CATALOG[o.plan].available && o.validUntilMs > Date.now();

async function installed(c: PaymentSqlClient): Promise<boolean> {
  const r = await c.query("select to_regclass('sc19_stripe.package_orders') is not null as ok");
  return r.rows[0]?.ok === true;
}
function packageRow(r: Record<string, unknown>): PaymentOrder {
  const code = r.package_code;
  if (code !== 'WERYFIKACJA' && code !== 'ASSESSMENT_CENTER') return fail('SC19_PAYMENT_RETRY');
  return {
    id: String(r.id), companyId: String(r.company_id), buyerId: String(r.buyer_id), requestId: String(r.request_id),
    offerId: String(r.offer_id), offerRevision: String(r.offer_revision), termsRevision: String(r.terms_revision),
    amountMinor: Number(r.amount_minor), currency: 'PLN', credits: Number(r.credits),
    scope: { provider: String(r.provider), account: String(r.account), mode: r.mode as 'test' | 'live' },
    status: r.status as PaymentOrder['status'], sessionId: r.session_id as string | null,
    checkoutUrl: r.checkout_url as string | null, paymentId: r.payment_id as string | null,
    checkoutDeadlineMs: Number(r.checkout_deadline_ms), packageCode: code,
  };
}
const isPackage = (o: PaymentOrder) => orderPackage(o) !== 'PRESELEKCJA';

export const stripePackageExtension: PaymentStoreExtension = Object.freeze({
  tx(base: PaymentTransaction, c: PaymentSqlClient, lockCompany: (companyId: string) => Promise<void>): PaymentTransaction {
    let ready: Promise<boolean> | undefined;
    const isReady = () => (ready ??= installed(c));
    const one = async (sql: string, values: unknown[]) => {
      const r = await c.query(sql, values);
      return r.rows[0] ? packageRow(r.rows[0]) : null;
    };
    const pendingPackage = async (companyId: string) => (await isReady()) &&
      (await c.query("select 1 from sc19_stripe.package_orders where company_id=$1 and status='awaiting_payment'", [companyId])).rows.length > 0;
    return {
      companyAccess: (companyId, userId) => base.companyAccess(companyId, userId),
      async offer(id) {
        const own = offerById(id);
        if (!own) return base.offer(id);
        return (await isReady()) ? { ...own } : null;
      },
      async orderByRequest(companyId, requestId) {
        const found = await base.orderByRequest(companyId, requestId);
        if (found || !(await isReady())) return found;
        return one(`select o.* from sc19_stripe.package_orders o
          join sc19_stripe.package_requests r on r.company_id=o.company_id and r.order_id=o.id
          where r.company_id=$1 and r.request_id=$2 for update of o`, [companyId, requestId]);
      },
      async unresolvedOrder(companyId) {
        const found = await base.unresolvedOrder(companyId);
        if (found || !(await isReady())) return found;
        return one(`select * from sc19_stripe.package_orders where company_id=$1 and status='awaiting_payment' for update`, [companyId]);
      },
      async bindRequest(companyId, requestId, orderId) {
        if ((await isReady()) &&
            (await c.query('select 1 from sc19_stripe.package_orders where id=$1 and company_id=$2', [orderId, companyId])).rows.length) {
          await c.query('insert into sc19_stripe.package_requests(company_id,request_id,order_id) values($1,$2,$3)',
            [companyId, requestId, orderId]);
          return;
        }
        return base.bindRequest(companyId, requestId, orderId);
      },
      async order(id) {
        const found = await base.order(id);
        if (found || !(await isReady())) return found;
        const owner = await c.query('select company_id from sc19_stripe.package_orders where id=$1', [id]);
        if (!owner.rows[0]) return null;
        await lockCompany(String(owner.rows[0].company_id));
        return one('select * from sc19_stripe.package_orders where id=$1 for update', [id]);
      },
      async insertOrder(o) {
        if (!isPackage(o)) {
          // A PRESELEKCJA order never opens next to an unpaid package order.
          if (await pendingPackage(o.companyId)) return fail('SC19_PAYMENT_REQUEST_CONFLICT');
          return base.insertOrder(o);
        }
        if (!(await isReady())) return fail('SC19_PAYMENT_OFFER_UNAVAILABLE');
        // Same boundary as the PRESELEKCJA insert: company lock, verified company,
        // no unresolved catalog order and no unresolved PRESELEKCJA order.
        await lockCompany(o.companyId);
        const approved = await c.query('select company_id from private.sc19_trial_approvals where company_id=$1 for share', [o.companyId]);
        if (!approved.rows.length) return fail('SC19_PAYMENT_FORBIDDEN');
        const commerce = await c.query("select to_regprocedure('private.sc19_has_pending_catalog_order(uuid)') as routine");
        if (commerce.rows[0]?.routine) {
          const pending = await c.query('select private.sc19_has_pending_catalog_order($1) as pending', [o.companyId]);
          if (pending.rows[0]?.pending === true) return fail('SC19_PAYMENT_REQUEST_CONFLICT');
        }
        // A retired provider's unpaid order (Przelewy24) can never be paid and does not count.
        // A closed PRESELEKCJA order (expired Stripe session, R7) does not count either.
        const open = await c.query(`select 1 from private.sc19_payment_orders where company_id=$1 and status='awaiting_payment'
          and provider<>all($2::text[]) and checkout_url is distinct from $3`, [o.companyId, RETIRED_PAYMENT_PROVIDERS, EXPIRED_CHECKOUT_MARKER]);
        if (open.rows.length) return fail('SC19_PAYMENT_REQUEST_CONFLICT');
        await c.query(`insert into sc19_stripe.package_orders
          (id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,
           provider,account,mode,status,session_id,checkout_url,payment_id,checkout_deadline_ms)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [o.id, o.companyId, o.buyerId, o.requestId, o.packageCode, o.offerId, o.offerRevision, o.termsRevision, o.amountMinor,
          o.currency, o.credits, o.scope.provider, o.scope.account, o.scope.mode, o.status, o.sessionId, o.checkoutUrl, o.paymentId,
          o.checkoutDeadlineMs]);
      },
      async saveOrder(o) {
        if (!isPackage(o)) return base.saveOrder(o);
        const r = await c.query(`update sc19_stripe.package_orders set status=$2,session_id=$3,checkout_url=$4,payment_id=$5
          where id=$1 and company_id=$6`, [o.id, o.status, o.sessionId, o.checkoutUrl, o.paymentId, o.companyId]);
        if (r.rowCount !== 1) fail('SC19_PAYMENT_ORDER_MISSING');
      },
      // One database function closes an expired order in either table (R7).
      closeExpired: (o, sessionId) => closeExpiredInDatabase(c, o.id, sessionId),
      async grantOnce(key, o) {
        if (!isPackage(o)) return base.grantOnce(key, o);
        // The database grants CV analyses AND the package entitlement, once per key.
        const r = await c.query('select sc19_stripe.grant_package($1,$2) as prior', [o.id, key]);
        const prior = r.rows[0]?.prior;
        return prior === null || prior === undefined ? null : String(prior);
      },
    };
  },
  async readOrder(c: PaymentSqlClient, companyId: string, orderId: string) {
    if (!(await installed(c))) return null;
    const r = await c.query('select * from sc19_stripe.package_orders where id=$1 and company_id=$2', [orderId, companyId]);
    return r.rows[0] ? packageRow(r.rows[0]) : null;
  },
  async offers(c: PaymentSqlClient) {
    if (!(await installed(c))) return [];
    return STRIPE_PACKAGE_OFFERS.filter(sellable).map(o => ({ ...o }));
  },
});
