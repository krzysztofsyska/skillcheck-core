import { Pool } from 'pg';
import { previewPoolTls } from './sc19-payment-preview-tls.ts';
import { createClient } from './supabase/server.ts';
import { composeSc19PaymentRuntime } from './sc19-payment-runtime.ts';
import { createPrzelewy24Provider, PRZELEWY24_ORIGIN } from './sc19-przelewy24-provider.ts';
import type { sc19SandboxPaymentConfig } from './sc19-payment-preview.ts';

type Config = NonNullable<ReturnType<typeof sc19SandboxPaymentConfig>>;
let pool: Pool | undefined;

export async function previewRuntime(config: Config) {
  const database = pool ??= new Pool({ connectionString: config.databaseUrl, ssl: previewPoolTls,
    max: 2, maxUses: 100, connectionTimeoutMillis: 6000, query_timeout: 12000,
    idleTimeoutMillis: 15000, allowExitOnIdle: true, options: '' }).on('error', () => {
      // pg discards a broken idle client. Do not log credentials or buyer data.
    });
  const client = await createClient();
  // This cache belongs to one request. Webhooks do not read a browser session.
  let identity: ReturnType<typeof client.auth.getUser> | undefined;
  const user = async () => {
    const result = await (identity ??= client.auth.getUser());
    return result.error ? null : result.data.user;
  };
  const scope = { provider: 'przelewy24', account: String(config.merchantId), mode: 'test' } as const;
  const provider = createPrzelewy24Provider({
    config: { mode: 'test', merchantId: config.merchantId, posId: config.posId, apiKey: config.apiKey, crc: config.crc }, scope,
    urlStatus: config.appOrigin + '/api/billing/webhook',
    urlReturn: order => config.appOrigin + '/dashboard/' + order.companyId + '/billing/checkout?p24=' + order.id,
    email: async order => {
      const buyer = await user();
      if (buyer?.id !== order.buyerId || !buyer.email_confirmed_at || !buyer.email) throw Error('P24_BUYER_UNVERIFIED');
      return buyer.email;
    },
    description: order => `SkillCheck PRESELEKCJA — ${order.credits} analiz CV (test)`,
  });
  return composeSc19PaymentRuntime({ pool: { async connect() {
    try { return await database.connect(); } catch (error) {
      // Keep provider messages, connection strings and buyer data out of runtime logs.
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const known = ['28P01', '28000', 'XX000', '3D000', '53300', 'ECONNREFUSED', 'ETIMEDOUT',
        'ENOTFOUND', 'ECONNRESET', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'];
      console.error('SC19_PREVIEW_DB_CONNECT', typeof code === 'string' && known.includes(code) ? code : 'OTHER');
      throw error;
    }
  } }, provider, scope, appOrigin: config.appOrigin,
    signatureHeader: null, checkoutOrigins: [PRZELEWY24_ORIGIN.test], liveApproved: false,
    enabled: process.env.SC19_PACKAGES_ENABLED === 'true',
    authenticate: async () => {
      const buyer = await user();
      return buyer?.email_confirmed_at && buyer.email ? { userId: buyer.id } : null;
    },
  });
}
