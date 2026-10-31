import { createP24CheckoutHttp } from '../../../../lib/p24-checkout-http';
import { resolveCheckoutService } from '../../../../lib/p24-checkout-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Prepared for a scheduler (Bearer CHECKOUT_RECONCILE_SECRET). No cron is registered by this change. */
export async function GET(request: Request) {
  let service = null;
  try { service = resolveCheckoutService(); } catch { service = null; }
  return createP24CheckoutHttp(service, null).reconcile(request, process.env.CHECKOUT_RECONCILE_SECRET);
}
