import { createSc19PaymentHttp } from '../../../../lib/sc19-payment-http';
import { resolveSc19PaymentRuntime } from '../../../../lib/sc19-payment-runtime';
export const runtime='nodejs';
// SC-P24-DIAG-001: the platform default (10 s Hobby / 15 s Pro) is SHORTER than
// this handler's own worst case — a Supabase auth round trip, a pooler connect
// (6 s) and a query (12 s) budget, then the Przelewy24 REST call (10 s). Below
// the default the invocation is killed mid-request, the client receives the
// platform's HTML 503 instead of our JSON error code, and nothing is recorded
// anywhere. 60 s is allowed on every plan and leaves the handler room to fail
// cleanly and say why.
export const maxDuration = 60;
export async function POST(request: Request) {
  return createSc19PaymentHttp(await resolveSc19PaymentRuntime(request)).webhook(request);
}
