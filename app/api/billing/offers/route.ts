import { createSc19PaymentHttp } from '../../../../lib/sc19-payment-http';
import { resolveSc19PaymentRuntime } from '../../../../lib/sc19-payment-runtime';
import { resolveSc19OfferCatalog } from '../../../../lib/sc19-offer-catalog-runtime';
export const runtime='nodejs';
// Reading an approved offer needs no payment provider; only registering a
// transaction does. The catalog is read-only and cannot create an order, so the
// checkout POST and the webhook stay refused while the provider is null.
export async function GET(request: Request) {
  const [payments,catalog]=await Promise.all([resolveSc19PaymentRuntime(),resolveSc19OfferCatalog()]);
  return createSc19PaymentHttp(payments,catalog).offers(request);
}
