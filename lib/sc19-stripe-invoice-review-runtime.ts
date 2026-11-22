/** R7: server read of the LIVE invoices to review (lib/sc19-stripe-invoice-review.ts)
 * for the operator Fakturownia page. The CALLER checks the operator first
 * (app/operator/sales/access.ts, salesOperator) — this module never decides access.
 *
 * Database: the payment adapter's own restricted login from the Stripe configuration
 * gate (sc19_p24_preview on the integration Preview, sc19_p24_checkout on
 * https://skillcheck.pl), the same connection the Stripe webhook uses to write these
 * rows; never a service key. Only its URL is used from the configuration. Read only.
 */
import { Pool } from 'pg';
import { previewPoolTls } from './sc19-payment-preview-tls.ts';
import { sc19StripeGate } from './sc19-stripe-config.ts';
import { readInvoicesToReview, type InvoiceReview } from './sc19-stripe-invoice-review.ts';

export type InvoiceReviewResult = InvoiceReview | Readonly<{ state: 'not_configured' }> | Readonly<{ state: 'unavailable' }>;

let pool: Pool | undefined;

export async function loadInvoicesToReview(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): Promise<InvoiceReviewResult> {
  const gate = sc19StripeGate(env);
  if (!gate.ok) return { state: 'not_configured' };
  const database = pool ??= new Pool({ connectionString: gate.config.databaseUrl, ssl: previewPoolTls,
    max: 1, maxUses: 100, connectionTimeoutMillis: 6000, query_timeout: 12000,
    idleTimeoutMillis: 15000, allowExitOnIdle: true, options: '' }).on('error', () => {
      // pg discards a broken idle client. Never log the connection string.
    });
  try {
    return await readInvoicesToReview(async (sql, values) => {
      const connection = await database.connect();
      try { return (await connection.query(sql, values)).rows; } finally { connection.release(); }
    }, now());
  } catch {
    console.error('SC19_STRIPE_INVOICE_REVIEW_DB');
    return { state: 'unavailable' };
  }
}
