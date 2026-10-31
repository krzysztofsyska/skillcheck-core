import { appOrigin } from '../../../../lib/auth-url';
import { createP24CheckoutHttp } from '../../../../lib/p24-checkout-http';
import { resolveCheckoutService } from '../../../../lib/p24-checkout-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Any configured address of this deployment (e.g. Preview branch URL and deployment URL). */
const allowedOrigin = (origin: string) => {
  try { return appOrigin(origin) === origin; } catch { return false; }
};

export async function POST(request: Request) {
  let service = null;
  try { service = resolveCheckoutService(); } catch { service = null; }
  return createP24CheckoutHttp(service, allowedOrigin).register(request);
}
