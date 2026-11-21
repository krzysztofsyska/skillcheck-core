/** R7: server composition of the Stripe checkout on the SC-019 payment orchestration.
 *
 * Database: the payment adapter's own restricted login (the same roles the
 * Przelewy24 sandbox used, sc19_p24_preview / sc19_p24_checkout), never a service
 * key. Migration 20261121110000_r7_stripe_checkout.sql lets those roles handle
 * TEST-mode Stripe orders and read the buyer's company name and NIP through one
 * security-definer function.
 *
 * Sales switch: the existing SC19_PACKAGES_ENABLED (=== 'true') opens new
 * checkouts, exactly as for the previous adapter. Webhooks keep settling orders
 * that already exist even when it is off.
 *
 * LIVE (R7, owner decision 20.11.2026, 18:29, point 5): the mode comes from
 * STRIPE_SECRET_KEY. A live key opens real PRESELEKCJA payments on
 * https://skillcheck.pl only, with SC19_PACKAGES_ENABLED=true, a working
 * FAKTUROWNIA_* configuration and migration 20261122090000 (without it the
 * database refuses a live order). Each live payment gets one Fakturownia VAT
 * invoice; a refund (charge.refunded) gets a correction invoice.
 */
import { Pool } from 'pg';
import { previewPoolTls } from './sc19-payment-preview-tls.ts';
import { createClient } from './supabase/server.ts';
import { composeSc19PaymentRuntime } from './sc19-payment-runtime.ts';
import type { PaymentOrder, PaymentMode } from './sc19-payments.ts';
import { Sc19PaymentError } from './sc19-payments.ts';
import { createStripeProvider, readStripeBuyerCompany, STRIPE_CHECKOUT_ORIGIN, type StripeCustomerStore } from './sc19-stripe-provider.ts';
import type { Sc19StripeConfig } from './sc19-stripe-config.ts';
import { stripeLivePackageExtension, stripePackageExtension } from './sc19-stripe-packages.ts';
import { orderRow } from './sc19-payment-postgres.ts';
import { afterStripePayment, postgresInvoiceStore, stripeInvoiceClient, stripeLiveApproved, stripeRefundEvent, type InvoiceDeps } from './sc19-stripe-invoices.ts';

let pool: Pool | undefined;

/** Scope of every Stripe order: one KTIG Consulting Stripe account, mode from the key. */
export const stripeScope = (mode: PaymentMode) => ({ provider: 'stripe', account: 'ktig-consulting', mode }) as const;

/** THE post-grant call site (lib/sc19-stripe-invoices.ts, afterStripePayment). */
export { afterStripePayment };

export async function stripeRuntime(config: Sc19StripeConfig) {
  const database = pool ??= new Pool({ connectionString: config.databaseUrl, ssl: previewPoolTls,
    max: 2, maxUses: 100, connectionTimeoutMillis: 6000, query_timeout: 12000,
    idleTimeoutMillis: 15000, allowExitOnIdle: true, options: '' }).on('error', () => {
      // pg discards a broken idle client. Do not log credentials or buyer data.
    });
  const client = await createClient();
  let identity: ReturnType<typeof client.auth.getUser> | undefined;
  const user = async () => {
    const result = await (identity ??= client.auth.getUser());
    return result.error ? null : result.data.user;
  };
  const query = async (sql: string, values: unknown[]) => {
    let connection: Awaited<ReturnType<Pool['connect']>> | undefined;
    try { connection = await database.connect(); return (await connection.query(sql, values)).rows; }
    catch { console.error('SC19_STRIPE_DB'); throw new Sc19PaymentError('SC19_PAYMENT_RETRY'); }
    finally { connection?.release(); }
  };
  const customers: StripeCustomerStore = {
    async find(companyId, mode) {
      const rows = await query('select customer_id from sc19_stripe.customers where company_id=$1 and mode=$2', [companyId, mode]);
      return rows[0] ? String(rows[0].customer_id) : null;
    },
    async save(companyId, mode, customerId) {
      await query(`insert into sc19_stripe.customers(company_id,mode,customer_id) values($1,$2,$3)
        on conflict (company_id,mode) do nothing`, [companyId, mode, customerId]);
      const stored = await this.find(companyId, mode);
      if (!stored) throw new Sc19PaymentError('SC19_PAYMENT_RETRY');
      return stored;
    },
    async replace(companyId, mode, staleId, customerId) {
      const rows = await query('select sc19_stripe.replace_customer($1,$2,$3,$4) as customer_id', [companyId, mode, staleId, customerId]);
      if (!rows[0] || typeof rows[0].customer_id !== 'string') throw new Sc19PaymentError('SC19_PAYMENT_RETRY');
      return rows[0].customer_id;
    },
  };
  const scope = stripeScope(config.mode);
  const fakturownia = stripeInvoiceClient(process.env);
  const live = config.mode === 'live';
  const provider = createStripeProvider({
    secretKey: config.secretKey, webhookSecret: config.webhookSecret, mode: config.mode,
    appOrigin: config.appOrigin, scope, customers,
    async buyer(order) {
      const buyer = await user();
      if (buyer?.id !== order.buyerId || !buyer.email_confirmed_at || !buyer.email) throw new Sc19PaymentError('SC19_PAYMENT_FORBIDDEN');
      const company = await readStripeBuyerCompany(query, order.companyId);
      return { email: buyer.email, ...company };
    },
  });
  const invoices: InvoiceDeps = { fakturownia, store: postgresInvoiceStore(query, orderRow),
    paymentFacts: order => provider.paymentFacts(order) };
  return composeSc19PaymentRuntime({ pool: { async connect() {
    try { return await database.connect(); }
    catch (error) { console.error('SC19_STRIPE_DB_CONNECT'); throw error; }
  } }, provider, scope, appOrigin: config.appOrigin, signatureHeader: 'stripe-signature',
  checkoutOrigins: [STRIPE_CHECKOUT_ORIGIN],
  // R7: WERYFIKACJA and ASSESSMENT CENTER orders (sc19_stripe.package_orders), Stripe
  // only, TEST mode; with a LIVE key they stay „wkrótce” (PRESELEKCJA only).
  storeExtension: live ? stripeLivePackageExtension : stripePackageExtension,
  // R7 (owner decision 20.11.2026, 18:29, point 5): LIVE payments on the production
  // deployment only, and only with a working Fakturownia configuration.
  liveApproved: stripeLiveApproved(config, fakturownia !== null),
  enabled: process.env.SC19_PACKAGES_ENABLED === 'true',
  // R5 W2b: the CV pool from the slider is accepted (and validated) only with the
  // slider flag on; default off keeps the request shape unchanged.
  cvPoolEnabled: process.env.PRICING_CV_SLIDER_ENABLED === 'true',
  onPaid: order => afterStripePayment(order, invoices),
  onPaidAgain: order => afterStripePayment(order, invoices),
  events: (raw, signature) => stripeRefundEvent(() => provider.verifyRefund(raw, signature), invoices),
  authenticate: async () => {
    const buyer = await user();
    return buyer?.email_confirmed_at && buyer.email ? { userId: buyer.id } : null;
  },
  });
}
