import { createSc19PaymentHttp } from '../../../../../lib/sc19-payment-http';
import { resolveSc19PaymentRuntime } from '../../../../../lib/sc19-payment-runtime';
export const runtime='nodejs';
export async function GET(request: Request,context: {params: Promise<{orderId: string}>}) {
  return createSc19PaymentHttp(await resolveSc19PaymentRuntime(request)).order(request,(await context.params).orderId);
}

// Explicit same-origin refresh can reconcile a delayed or protected webhook.
export const POST = GET;
