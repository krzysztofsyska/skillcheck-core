import { sc19SandboxPaymentConfig } from './sc19-payment-preview.ts';
import type { PaymentDependencies } from './sc19-payments.ts';
import { createSc19Payments } from './sc19-payments.ts';
import { createPostgresPaymentStore, type PaymentSqlPool } from './sc19-payment-postgres.ts';
import type { PaymentHttpRuntime } from './sc19-payment-http.ts';
export function composeSc19PaymentRuntime(config: Omit<PaymentDependencies,'store'> & {
  pool: PaymentSqlPool; appOrigin: string; signatureHeader: PaymentHttpRuntime['signatureHeader'];
}): PaymentHttpRuntime {
  const origin=new URL(config.appOrigin);
  if(origin.origin!==config.appOrigin || !['https:','http:'].includes(origin.protocol) ||
    (origin.protocol==='http:' && !['localhost','127.0.0.1'].includes(origin.hostname)) ||
    (config.signatureHeader !== null && !/^[a-z0-9-]{1,80}$/.test(config.signatureHeader)))throw Error('SC19_PAYMENT_CONFIGURATION_INVALID');
  const store=createPostgresPaymentStore(config.pool);
  const service=createSc19Payments({...config,store});
  return Object.freeze({service, authenticate:config.authenticate,
    readOrder:store.readOrder,listOffers:store.listOffers,appOrigin:config.appOrigin,
    signatureHeader:config.signatureHeader});
}
export async function resolveSc19PaymentRuntime(request?: Request): Promise<PaymentHttpRuntime | null> {
  const config = sc19SandboxPaymentConfig(process.env, request && new URL(request.url).origin);
  if (!config) return null;
  const { previewRuntime } = await import('./sc19-payment-preview-runtime.ts');
  return previewRuntime(config);
}
