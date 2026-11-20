import { createSc19PaymentHttp } from '../../../../../lib/sc19-payment-http';
import { resolveSc19StripeRuntime } from '../../../../../lib/sc19-payment-runtime';
export const runtime = 'nodejs';
// R7: Stripe sends checkout.session.completed and charge.refunded here. The raw body
// is verified with STRIPE_WEBHOOK_SECRET (header Stripe-Signature) before anything
// is read; events of another application on the same Stripe account get 200 with
// no action. Room for a pooler connect, a query and one Stripe API read.
export const maxDuration = 60;
export async function POST(request: Request) {
  return createSc19PaymentHttp(await resolveSc19StripeRuntime(request)).webhook(request);
}
