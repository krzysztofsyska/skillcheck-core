import { Przelewy24Error, przelewy24NotificationSignature } from './sc19-przelewy24-provider.ts';
import type { CheckoutOffer } from './sc19-payment-postgres.ts';
import type { OfferCatalog } from './sc19-offer-catalog.ts';
import { SC19_VAT_BASIS_POINTS, sc19OfferAmounts } from './sc19-offer-amounts.ts';
import type { PaymentOrder, createSc19Payments } from './sc19-payments.ts';
import { Sc19PaymentError } from './sc19-payments.ts';
export type PaymentHttpRuntime = Readonly<{
  service: ReturnType<typeof createSc19Payments>;
  authenticate(): Promise<{userId: string} | null>;
  readOrder(companyId: string,userId: string,orderId: string): Promise<PaymentOrder | null>;
  listOffers(companyId: string,userId: string): Promise<CheckoutOffer[]>;
  appOrigin: string;
  signatureHeader: string | null;
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
const P24_DETAIL=/^P24_[A-Z_]{3,40}$/;
function errorResponse(error: unknown, webhook=false) {
  const code=error instanceof Sc19PaymentError ? error.code : 'SC19_PAYMENT_RETRY';
  // Name the Przelewy24 failure: fixed code and numeric HTTP status only, never
  // the provider's message, the request or a credential. The public webhook
  // body stays unchanged; the authenticated buyer gets the code as `detail`.
  let detail: string | null=null;
  if(error instanceof Przelewy24Error) {
    const p24=P24_DETAIL.test(error.code) ? error.code : 'P24_UNKNOWN';
    const status=Number.isSafeInteger(error.httpStatus) ? error.httpStatus : null;
    console.error('SC19_P24_FAILURE',p24,status ?? '-');
    if(!webhook && p24!=='P24_UNKNOWN')detail=p24;
  }
  const map: Record<string,number> = {
    SC19_PAYMENTS_DISABLED:503, SC19_PAYMENT_RETRY:503, SC19_PAYMENT_FORBIDDEN:403, SC19_PAYMENT_INVALID:400,
    SC19_PAYMENT_BODY_TOO_LARGE:413, SC19_PAYMENT_ORIGIN:403, SC19_PAYMENT_CONTENT_TYPE:415,
    SC19_PAYMENT_OFFER_UNAVAILABLE:409, SC19_PAYMENT_REQUEST_CONFLICT:409,
    SC19_PAYMENT_NOTIFICATION_INVALID:400, SC19_PAYMENT_ORDER_MISSING:404,
  };
  // No successful acknowledgment until verification AND transaction commit.
  return json(detail ? {error:code,detail} : {error:code},map[code] ?? (webhook ? 503 : 409));
}
/** Serialized offer. `checkoutAvailable` says whether a payment can actually be
 * taken right now; the gross `amountMinor` stays authoritative and net/VAT are
 * derived from it, never the other way round. No provider, account, mode,
 * session or merchant data is ever included. */
const serializeOffer = (o: CheckoutOffer) => {
  const amounts=sc19OfferAmounts(o.amountMinor,SC19_VAT_BASIS_POINTS);
  return {id:o.id,revision:o.revision,amountMinor:o.amountMinor,currency:o.currency,
    credits:o.credits,termsRevision:o.termsRevision,termsText:o.termsText,validUntilMs:o.validUntilMs,
    netMinor:amounts?.netMinor ?? null,vatMinor:amounts?.vatMinor ?? null,
    vatBasisPoints:amounts?.vatBasisPoints ?? null};
};
/** `catalog` is a READ-ONLY offer source used only when no payment provider is
 * composed. It cannot create an order: checkout and the webhook stay bound to
 * `runtime` and keep answering SC19_PAYMENTS_DISABLED while it is null. */
export function createSc19PaymentHttp(runtime: PaymentHttpRuntime | null, catalog: OfferCatalog | null=null) {
  async function identify(source: {authenticate(): Promise<{userId: string} | null>}) {
    const auth=await source.authenticate();
    if(!auth || !uuid.test(auth.userId))throw new Sc19PaymentError('SC19_PAYMENT_FORBIDDEN');
    return auth.userId;
  }
  return {
    async checkout(request: Request) {
      if(!runtime || !runtime.service.checkoutEnabled)return paymentsUnavailable();
      try {
        // Trusted configured origin, never Host/X-Forwarded-Host from the request.
        if(request.headers.get('origin')!==runtime.appOrigin ||
          ['cross-site','none'].includes(request.headers.get('sec-fetch-site') ?? ''))
          throw new Sc19PaymentError('SC19_PAYMENT_ORIGIN');
        if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')
          throw new Sc19PaymentError('SC19_PAYMENT_CONTENT_TYPE');
        await identify(runtime);
        let input: unknown;
        try { input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bodyBytes(request,4096))); }
        catch(e) { if(e instanceof Sc19PaymentError)throw e; throw new Sc19PaymentError('SC19_PAYMENT_INVALID'); }
        const result=await runtime.service.checkout(input);
        return json('paid' in result ? {orderId:result.orderId,status:'paid'} :
          {orderId:result.orderId,status:'awaiting_payment',checkoutUrl:result.url});
      } catch(e) { return errorResponse(e); }
    },
    /** Reading an approved offer needs no payment provider, so this is the one
     * route that still answers while checkout is gated: the price, the terms and
     * the order summary must be verifiable (Przelewy24 integration review). The
     * authorization is unchanged either way — a server-authenticated user who
     * owns the company AND whose company has a private.sc19_trial_approvals row.
     * `checkoutAvailable:false` tells the client a payment cannot be taken; it
     * is never faked, and no order can be created down this path. */
    async offers(request: Request) {
      const source=runtime && runtime.service.checkoutEnabled ? runtime : catalog;
      if(!source)return paymentsUnavailable();
      try {
        const uid=await identify(source); const companyId=new URL(request.url).searchParams.get('companyId') ?? '';
        if(!uuid.test(companyId))throw new Sc19PaymentError('SC19_PAYMENT_INVALID');
        const checkoutAvailable=source===runtime;
        const offers=await source.listOffers(companyId,uid);
        return json({checkoutAvailable,offers:offers.map(serializeOffer)});
      } catch(e) { return errorResponse(e); }
    },
    async order(request: Request,orderId: string) {
      if(!runtime)return paymentsUnavailable();
      try {
        const uid=await identify(runtime); const companyId=new URL(request.url).searchParams.get('companyId') ?? '';
        if(!uuid.test(companyId)||!uuid.test(orderId))throw new Sc19PaymentError('SC19_PAYMENT_INVALID');
        let o=await runtime.readOrder(companyId,uid,orderId);
        if(!o)return json({error:'SC19_PAYMENT_ORDER_MISSING'},404);
        if (request.method === 'POST') {
          if (request.headers.get('origin') !== runtime.appOrigin ||
              ['cross-site','none'].includes(request.headers.get('sec-fetch-site') ?? ''))
            throw new Sc19PaymentError('SC19_PAYMENT_ORIGIN');
          if (o.status === 'awaiting_payment' && o.sessionId) {
            await runtime.service.refreshSettlement(o);
            o = await runtime.readOrder(companyId,uid,orderId);
            if (!o) return json({error:'SC19_PAYMENT_ORDER_MISSING'},404);
          }
        }
        // No payment IDs, merchant, buyer, NIP, or hosted-session URL in status reads.
        return json({orderId:o.id,status:o.status,amountMinor:o.amountMinor,currency:o.currency,
          credits:o.credits,offerId:o.offerId,termsRevision:o.termsRevision});
      } catch(e) { return errorResponse(e); }
    },
    async webhook(request: Request) {
      // Deliberately independent of the new-checkout gate; orders must drain.
      if(!runtime)return paymentsUnavailable();
      try {
        const raw = await bodyBytes(request,262144);
        const signature = runtime.signatureHeader === null ? przelewy24NotificationSignature(raw) :
          request.headers.get(runtime.signatureHeader) ?? '';
        const result=await runtime.service.notification(raw,signature);
        return json({state:result.state});
      } catch(e) { return errorResponse(e,true); }
    },
  };
}
