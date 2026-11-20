import { sc19SandboxPaymentConfig } from './sc19-payment-preview.ts';
import { sc19StripeConfig } from './sc19-stripe-config.ts';
import type { PaymentDependencies } from './sc19-payments.ts';
import { createSc19Payments } from './sc19-payments.ts';
import { createPostgresPaymentStore, type PaymentSqlPool, type PaymentStoreExtension } from './sc19-payment-postgres.ts';
import type { PaymentHttpRuntime } from './sc19-payment-http.ts';
export function composeSc19PaymentRuntime(config: Omit<PaymentDependencies,'store'> & {
  pool: PaymentSqlPool; appOrigin: string; signatureHeader: PaymentHttpRuntime['signatureHeader'];
  /** R7: the Stripe runtime adds the WERYFIKACJA / ASSESSMENT CENTER order source. */
  storeExtension?: PaymentStoreExtension;
}): PaymentHttpRuntime {
  const origin=new URL(config.appOrigin);
  if(origin.origin!==config.appOrigin || !['https:','http:'].includes(origin.protocol) ||
    (origin.protocol==='http:' && !['localhost','127.0.0.1'].includes(origin.hostname)) ||
    (config.signatureHeader !== null && !/^[a-z0-9-]{1,80}$/.test(config.signatureHeader)))throw Error('SC19_PAYMENT_CONFIGURATION_INVALID');
  const store=createPostgresPaymentStore(config.pool,config.storeExtension);
  const service=createSc19Payments({...config,store});
  return Object.freeze({service, authenticate:config.authenticate,
    readOrder:store.readOrder,listOffers:store.listOffers,appOrigin:config.appOrigin,
    signatureHeader:config.signatureHeader});
}
/** R7: the Stripe runtime, or null when this deployment has no Stripe configuration. */
export async function resolveSc19StripeRuntime(request?: Request): Promise<PaymentHttpRuntime | null> {
  const stripe = sc19StripeConfig(process.env, request && new URL(request.url).origin);
  if (!stripe) return null;
  const { stripeRuntime } = await import('./sc19-stripe-runtime.ts');
  return stripeRuntime(stripe);
}
/** Checkout, offers and order reads. Stripe (R7) replaces the Przelewy24 sandbox
 * when it is configured with a TEST key, or when there is no Przelewy24 sandbox at
 * all. With a LIVE key and the sandbox still configured, nothing changes for the
 * sandbox (live Stripe stays closed until the owner opens it). */
export async function resolveSc19PaymentRuntime(request?: Request): Promise<PaymentHttpRuntime | null> {
  const origin = request && new URL(request.url).origin;
  const stripe = sc19StripeConfig(process.env, origin);
  const config = sc19SandboxPaymentConfig(process.env, origin);
  if (stripe && (stripe.mode === 'test' || !config)) return resolveSc19StripeRuntime(request);
  return resolveSc19P24Runtime(request);
}
/** The Przelewy24 sandbox runtime ONLY, whatever provider takes new purchases.
 * The Przelewy24 notification URL (urlStatus) is /api/billing/webhook, so that
 * route stays bound here: orders already opened with Przelewy24 keep settling
 * after new purchases move to Stripe. */
export async function resolveSc19P24Runtime(request?: Request): Promise<PaymentHttpRuntime | null> {
  const config = sc19SandboxPaymentConfig(process.env, request && new URL(request.url).origin);
  if (!config) return null;
  const { previewRuntime } = await import('./sc19-payment-preview-runtime.ts');
  return previewRuntime(config);
}
