import { createP24CheckoutHttp } from '../../../../lib/p24-checkout-http';
import { resolveCheckoutService } from '../../../../lib/p24-checkout-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Przelewy24 urlStatus. Authenticated by the notification signature, not by cookies or origin. */
export async function POST(request: Request) {
  let service = null;
  try { service = resolveCheckoutService(); } catch { service = null; }
  return createP24CheckoutHttp(service, null).notify(request);
}
