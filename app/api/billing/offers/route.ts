import { createSc19PaymentHttp, paymentsUnavailable } from '../../../../lib/sc19-payment-http';
import { resolveSc19PaymentRuntime } from '../../../../lib/sc19-payment-runtime';
import { resolveSc19OfferCatalog } from '../../../../lib/sc19-offer-catalog-runtime';
export const runtime='nodejs';
// SC-P24-DIAG-001: the platform default (10 s Hobby / 15 s Pro) is SHORTER than
// this handler's own worst case — a Supabase auth round trip, a pooler connect
// (6 s) and a query (12 s) budget, then the Przelewy24 REST call (10 s). Below
// the default the invocation is killed mid-request, the client receives the
// platform's HTML 503 instead of our JSON error code, and nothing is recorded
// anywhere. 60 s is allowed on every plan and leaves the handler room to fail
// cleanly and say why.
export const maxDuration = 60;
// Reading an approved offer needs no payment provider; only registering a
// transaction does. The catalog is read-only and cannot create an order, so the
// checkout POST and the webhook stay refused while the provider is null.
//
// The read is still behind SC19_PACKAGES_ENABLED, the same release switch as
// billing/page.tsx, billing/checkout/page.tsx and billing/actions.ts. With the
// flag unset or false those pages hide the Pakiety entry and refuse the purchase,
// so a direct GET here must not hand the price, the credit count and the terms to
// a signed-in owner of a verified company either; otherwise the switch would not
// really keep the offer unavailable.
//
// The flag-off answer is deliberately the ordinary unavailable one — the same
// 503 SC19_PAYMENTS_DISABLED that createSc19PaymentHttp(null,null).offers()
// returns when no provider and no catalog are composed. The checkout client
// already handles exactly that shape, and a distinct code would both leak the
// state of the switch and give the UI something it does not understand.
export async function GET(request: Request) {
  if(process.env.SC19_PACKAGES_ENABLED!=='true')return paymentsUnavailable();
  const [payments,catalog]=await Promise.all([resolveSc19PaymentRuntime(request),resolveSc19OfferCatalog()]);
  return createSc19PaymentHttp(payments,catalog).offers(request);
}
