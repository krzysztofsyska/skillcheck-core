import type { CheckoutOffer } from './sc19-payment-postgres.ts';
import type { PaymentOrder, createSc19Payments } from './sc19-payments.ts';
import { Sc19PaymentError } from './sc19-payments.ts';
export type PaymentHttpRuntime = Readonly<{
  service: ReturnType<typeof createSc19Payments>;
  authenticate(): Promise<{userId: string} | null>;
  readOrder(companyId: string,userId: string,orderId: string): Promise<PaymentOrder | null>;
  listOffers(companyId: string,userId: string): Promise<CheckoutOffer[]>;
  appOrigin: string;
  signatureHeader: string;
  checkoutEnabled: boolean;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (data: unknown, status=200) => Response.json(data,{status,headers:{
  'Cache-Control':'no-store', 'Vary':'Cookie', 'X-Content-Type-Options':'nosniff',
}});
export const paymentsUnavailable = () => json({error:'SC19_PAYMENTS_DISABLED'},503);
async function bodyBytes(request: Request, max: number) {
  if (!request.body) throw new Sc19PaymentError('SC19_PAYMENT_INVALID');
  const announced = request.headers.get('content-length');
  if (announced && (!/^\d+$/.test(announced) || Number(announced)>max))
    throw new Sc19PaymentError('SC19_PAYMENT_BODY_TOO_LARGE');
  const reader=request.body.getReader(); const chunks: Uint8Array[]=[]; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if(done)break;
      size+=value.byteLength;
      if(size>max) { await reader.cancel(); throw new Sc19PaymentError('SC19_PAYMENT_BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all=new Uint8Array(size); let offset=0;
  for(const chunk of chunks) { all.set(chunk,offset); offset+=chunk.byteLength; }
  return all;
}
function errorResponse(error: unknown, webhook=false) {
  const code=error instanceof Sc19PaymentError ? error.code : 'SC19_PAYMENT_RETRY';
  const map: Record<string,number> = {
    SC19_PAYMENTS_DISABLED:503, SC19_PAYMENT_RETRY:503, SC19_PAYMENT_FORBIDDEN:403, SC19_PAYMENT_INVALID:400,
    SC19_PAYMENT_BODY_TOO_LARGE:413, SC19_PAYMENT_ORIGIN:403, SC19_PAYMENT_CONTENT_TYPE:415,
    SC19_PAYMENT_OFFER_UNAVAILABLE:409, SC19_PAYMENT_REQUEST_CONFLICT:409,
    SC19_PAYMENT_NOTIFICATION_INVALID:400, SC19_PAYMENT_ORDER_MISSING:404,
  };
  // No successful acknowledgment until verification AND transaction commit.
  return json({error:code},map[code] ?? (webhook ? 503 : 409));
}
export function createSc19PaymentHttp(runtime: PaymentHttpRuntime | null) {
  async function user() {
    const auth=await runtime!.authenticate();
    if(!auth || !uuid.test(auth.userId))throw new Sc19PaymentError('SC19_PAYMENT_FORBIDDEN');
    return auth.userId;
  }
  return {
    async checkout(request: Request) {
      if(!runtime || !runtime.checkoutEnabled)return paymentsUnavailable();
      try {
        // Trusted configured origin, never Host/X-Forwarded-Host from the request.
        if(request.headers.get('origin')!==runtime.appOrigin ||
          ['cross-site','none'].includes(request.headers.get('sec-fetch-site') ?? ''))
          throw new Sc19PaymentError('SC19_PAYMENT_ORIGIN');
        if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')
          throw new Sc19PaymentError('SC19_PAYMENT_CONTENT_TYPE');
        await user();
        let input: unknown;
        try { input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bodyBytes(request,4096))); }
        catch(e) { if(e instanceof Sc19PaymentError)throw e; throw new Sc19PaymentError('SC19_PAYMENT_INVALID'); }
        const result=await runtime.service.checkout(input);
        return json('paid' in result ? {orderId:result.orderId,status:'paid'} :
          {orderId:result.orderId,status:'awaiting_payment',checkoutUrl:result.url});
      } catch(e) { return errorResponse(e); }
    },
    async offers(request: Request) {
      if(!runtime)return paymentsUnavailable();
      try {
        const uid=await user(); const companyId=new URL(request.url).searchParams.get('companyId') ?? '';
        if(!uuid.test(companyId))throw new Sc19PaymentError('SC19_PAYMENT_INVALID');
        if(!runtime.checkoutEnabled)return paymentsUnavailable();
        const offers=await runtime.listOffers(companyId,uid);
        return json({offers:offers.map(o=>({id:o.id,revision:o.revision,amountMinor:o.amountMinor,currency:o.currency,
          credits:o.credits,termsRevision:o.termsRevision,termsText:o.termsText,validUntilMs:o.validUntilMs}))});
      } catch(e) { return errorResponse(e); }
    },
    async order(request: Request,orderId: string) {
      if(!runtime)return paymentsUnavailable();
      try {
        const uid=await user(); const companyId=new URL(request.url).searchParams.get('companyId') ?? '';
        if(!uuid.test(companyId)||!uuid.test(orderId))throw new Sc19PaymentError('SC19_PAYMENT_INVALID');
        const o=await runtime.readOrder(companyId,uid,orderId);
        if(!o)return json({error:'SC19_PAYMENT_ORDER_MISSING'},404);
        // No payment IDs, merchant, buyer, NIP, or hosted-session URL in status reads.
        return json({orderId:o.id,status:o.status,amountMinor:o.amountMinor,currency:o.currency,
          credits:o.credits,termsRevision:o.termsRevision});
      } catch(e) { return errorResponse(e); }
    },
    async webhook(request: Request) {
      // Deliberately independent of checkoutEnabled; outstanding orders must drain.
      if(!runtime)return paymentsUnavailable();
      try {
        const signature=request.headers.get(runtime.signatureHeader) ?? '';
        const result=await runtime.service.notification(await bodyBytes(request,262144),signature);
        return json({state:result.state});
      } catch(e) { return errorResponse(e,true); }
    },
  };
}
