/** Server composition for the public checkout. Importing creates no client. */
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { appOrigin } from './auth-url.ts';
import { createCheckoutOrders, type Rpc } from './checkout-orders.ts';
import { createCheckoutService, createP24Client, readP24Config } from './p24-checkout.ts';
import { getSupabaseEnv } from './supabase/env.ts';

/** True when every server-side key is configured. Says nothing about which keys. */
export function checkoutConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readP24Config(env) !== null && Buffer.byteLength(env.CHECKOUT_ORDER_SECRET ?? '', 'utf8') >= 32;
}

export function resolveCheckoutService() {
  const config = readP24Config();
  const secret = process.env.CHECKOUT_ORDER_SECRET ?? '';
  if (!config || Buffer.byteLength(secret, 'utf8') < 32) return null;
  const origin = appOrigin();
  // Przelewy24 must reach urlStatus over HTTPS.
  if (!origin.startsWith('https://')) return null;
  const { url, key } = getSupabaseEnv();
  // Publishable key, no user session: the RPCs authenticate the HMAC, not a user.
  const supabase = createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const rpc: Rpc = (fn, args) => supabase.rpc(fn as never, args as never) as unknown as PromiseLike<{ data: unknown; error: unknown }>;
  return createCheckoutService({ config, orders: createCheckoutOrders(rpc, secret), p24: createP24Client(config), appOrigin: origin });
}
