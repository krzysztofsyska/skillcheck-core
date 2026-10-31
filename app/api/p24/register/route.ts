import { appOrigin } from '../../../../lib/auth-url';
import { createP24CheckoutHttp } from '../../../../lib/p24-checkout-http';
import { resolveCheckoutService } from '../../../../lib/p24-checkout-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let origin: string | null = null, service = null;
  try { origin = appOrigin(); service = resolveCheckoutService(); } catch { service = null; }
  return createP24CheckoutHttp(service, origin).register(request);
}
