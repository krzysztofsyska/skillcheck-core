/** SC-CHECKOUT-P24-001: signed access to public.orders through SECURITY DEFINER RPCs.
 * Canonical form must match private.checkout_authenticate in
 * supabase/migrations/20261031120000_checkout_orders.sql.
 */
import { createHmac } from 'node:crypto';

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled';
export type StoredOrder = Readonly<{
  status: OrderStatus; product_code: string; quantity: number; amount_gross: number; currency: 'PLN';
  customer_email: string; p24_session_id: string; p24_order_id: number | null;
}>;
export type NewOrder = Readonly<{
  id: string; productCode: string; quantity: number; amountGross: number;
  customerName: string; customerEmail: string; customerPhone: string; companyName: string | null; nip: string | null;
}>;
/** Minimal RPC surface (supabase-js `client.rpc`), injectable for tests. */
export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export class CheckoutOrderError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'CheckoutOrderError'; this.code = code; }
}

export type CheckoutAction = 'create' | 'update' | 'read' | 'pending';
const field = (v: string | null) => v === null ? '-' : `${Buffer.byteLength(v, 'utf8')}:${v}`;
export function checkoutCanonical(action: CheckoutAction, issuedAtUs: number, fields: (string | null)[]): string {
  if (!Number.isSafeInteger(issuedAtUs)) throw new CheckoutOrderError('CHECKOUT_INVALID');
  return ['v1', action, String(issuedAtUs), ...fields.map(field)].join('\n');
}
export function signCheckout(action: CheckoutAction, issuedAtUs: number, fields: (string | null)[], secret: string) {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new CheckoutOrderError('CHECKOUT_DISABLED');
  return createHmac('sha256', secret).update(checkoutCanonical(action, issuedAtUs, fields), 'utf8').digest('hex');
}

export function createCheckoutOrders(rpc: Rpc, secret: string, now: () => number = Date.now) {
  const issued = () => now() * 1000;
  async function call(fn: string, args: Record<string, unknown>) {
    const { data, error } = await rpc(fn, args);
    if (error) {
      const message = String((error as { message?: unknown }).message ?? '');
      const known = /checkout_[a-z0-9_]+/.exec(message)?.[0];
      throw new CheckoutOrderError(known ? known.toUpperCase() : 'CHECKOUT_STORE_UNAVAILABLE');
    }
    return data;
  }
  return Object.freeze({
    async create(o: NewOrder): Promise<string> {
      const at = issued();
      const sig = signCheckout('create', at, [o.id, o.productCode, String(o.quantity), String(o.amountGross),
        o.customerName, o.customerEmail, o.customerPhone, o.companyName, o.nip], secret);
      const data = await call('checkout_create_order', { order_id: o.id, product_code: o.productCode, quantity: o.quantity,
        amount_gross: o.amountGross, customer_name: o.customerName, customer_email: o.customerEmail,
        customer_phone: o.customerPhone, company_name: o.companyName, nip: o.nip, issued_at_us: at, request_signature: sig });
      if (data !== `sc-ord-${o.id}`) throw new CheckoutOrderError('CHECKOUT_STORE_UNAVAILABLE');
      return data;
    },
    async update(orderId: string, status: Exclude<OrderStatus, 'pending'>, p24OrderId: number | null, paidAmount: number | null): Promise<OrderStatus> {
      const at = issued();
      const sig = signCheckout('update', at, [orderId, status, p24OrderId === null ? null : String(p24OrderId),
        paidAmount === null ? null : String(paidAmount)], secret);
      const data = await call('checkout_update_order', { order_id: orderId, new_status: status, p24_order_id: p24OrderId,
        paid_amount: paidAmount, issued_at_us: at, request_signature: sig });
      if (!['pending', 'paid', 'failed', 'cancelled'].includes(data as string)) throw new CheckoutOrderError('CHECKOUT_STORE_UNAVAILABLE');
      return data as OrderStatus;
    },
    async read(orderId: string): Promise<StoredOrder | null> {
      const at = issued();
      const data = await call('checkout_read_order', { order_id: orderId, issued_at_us: at,
        request_signature: signCheckout('read', at, [orderId], secret) });
      if (!Array.isArray(data) || data.length > 1) throw new CheckoutOrderError('CHECKOUT_STORE_UNAVAILABLE');
      if (!data.length) return null;
      const r = data[0] as Record<string, unknown>;
      // bigint may arrive as number or string depending on the driver.
      const p24 = r.p24_order_id === null ? null : Number(r.p24_order_id);
      return Object.freeze({ ...(r as StoredOrder), p24_order_id: p24 });
    },
    /** Ids of recent pending/failed orders older than `olderThanSeconds`, oldest first. */
    async pending(olderThanSeconds: number, maxRows: number): Promise<string[]> {
      const at = issued();
      const data = await call('checkout_pending_orders', { older_than_seconds: olderThanSeconds, max_rows: maxRows, issued_at_us: at,
        request_signature: signCheckout('pending', at, [String(olderThanSeconds), String(maxRows)], secret) });
      if (!Array.isArray(data)) throw new CheckoutOrderError('CHECKOUT_STORE_UNAVAILABLE');
      return data.map(r => String((r as { order_id: unknown }).order_id));
    },
  });
}
export type CheckoutOrders = ReturnType<typeof createCheckoutOrders>;
