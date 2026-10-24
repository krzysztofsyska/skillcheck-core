/** Server composition seam. Provider/account and commercial approval are pending.
 * No environment switch can activate a fake provider or a LIVE checkout here.
 * The eventual reviewed adapter registers at resolveSc19PaymentRuntime below.
 */
import type { PaymentDependencies } from './sc19-payments.ts';
import { createSc19Payments } from './sc19-payments.ts';
import { createPostgresPaymentStore, type PaymentSqlPool } from './sc19-payment-postgres.ts';
import type { PaymentHttpRuntime } from './sc19-payment-http.ts';
export function composeSc19PaymentRuntime(config: Omit<PaymentDependencies,'store'> & {
  pool: PaymentSqlPool; appOrigin: string; signatureHeader: string;
}): PaymentHttpRuntime {
  const origin=new URL(config.appOrigin);
  if(origin.origin!==config.appOrigin || !['https:','http:'].includes(origin.protocol) ||
    (origin.protocol==='http:' && !['localhost','127.0.0.1'].includes(origin.hostname)) ||
    !/^[a-z0-9-]{1,80}$/.test(config.signatureHeader))throw Error('SC19_PAYMENT_CONFIGURATION_INVALID');
  const store=createPostgresPaymentStore(config.pool);
  const service=createSc19Payments({...config,store});
  return Object.freeze({service, authenticate:config.authenticate,
    readOrder:store.readOrder,listOffers:store.listOffers,appOrigin:config.appOrigin,
    signatureHeader:config.signatureHeader});
}
export async function resolveSc19PaymentRuntime(): Promise<PaymentHttpRuntime | null> {
  // Intentional deployment gate. Replace only with a reviewed REAL provider,
  // server auth.getUser(), scoped DB pool, immutable catalog and migration receipt.
  // Tests exercise composeSc19PaymentRuntime with real PostgreSQL and synthetic I/O.
  return null;
}
