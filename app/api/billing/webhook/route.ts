import { createSc19PaymentHttp } from '../../../../lib/sc19-payment-http';
import { resolveSc19PaymentRuntime } from '../../../../lib/sc19-payment-runtime';
export const runtime='nodejs';
export async function POST(request: Request) {
  return createSc19PaymentHttp(await resolveSc19PaymentRuntime()).webhook(request);
}
