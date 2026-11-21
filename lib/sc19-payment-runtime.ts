import { sc19StripeConfig } from './sc19-stripe-config.ts';
import type { PaymentDependencies } from './sc19-payments.ts';
import { createSc19Payments } from './sc19-payments.ts';
import { createPostgresPaymentStore, type PaymentSqlPool, type PaymentStoreExtension } from './sc19-payment-postgres.ts';
import type { PaymentHttpRuntime } from './sc19-payment-http.ts';
export function composeSc19PaymentRuntime(config: Omit<PaymentDependencies,'store'> & {
  pool: PaymentSqlPool; appOrigin: string; signatureHeader: PaymentHttpRuntime['signatureHeader'];
  /** R7: the Stripe runtime adds the WERYFIKACJA / ASSESSMENT CENTER order source. */
  storeExtension?: PaymentStoreExtension;
  /** R7: Stripe charge.refunded (see PaymentHttpRuntime.events). */
  events?: PaymentHttpRuntime['events'];
}): PaymentHttpRuntime {
  const origin=new URL(config.appOrigin);
  if(origin.origin!==config.appOrigin || !['https:','http:'].includes(origin.protocol) ||
    (origin.protocol==='http:' && !['localhost','127.0.0.1'].includes(origin.hostname)) ||
    !/^[a-z0-9-]{1,80}$/.test(config.signatureHeader))throw Error('SC19_PAYMENT_CONFIGURATION_INVALID');
  const store=createPostgresPaymentStore(config.pool,config.storeExtension);
  const service=createSc19Payments({...config,store});
  return Object.freeze({service, authenticate:config.authenticate,
    readOrder:store.readOrder,listOffers:store.listOffers,appOrigin:config.appOrigin,
    signatureHeader:config.signatureHeader,...(config.events ? {events:config.events} : {})});
}
/** R7: the Stripe runtime, or null when this deployment has no Stripe configuration. */
export async function resolveSc19StripeRuntime(request?: Request): Promise<PaymentHttpRuntime | null> {
  const stripe = sc19StripeConfig(process.env, request && new URL(request.url).origin);
  if (!stripe) return null;
  const { stripeRuntime } = await import('./sc19-stripe-runtime.ts');
  return stripeRuntime(stripe);
}
/** Checkout, offers, order reads and the webhook: Stripe only (R7). The
 * Przelewy24 runtime was removed (owner decision 19.11.2026); without a Stripe
 * configuration every payment route answers SC19_PAYMENTS_DISABLED. */
export async function resolveSc19PaymentRuntime(request?: Request): Promise<PaymentHttpRuntime | null> {
  return resolveSc19StripeRuntime(request);
}
