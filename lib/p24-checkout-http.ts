/** HTTP layer for /api/p24/register and /api/p24/notify. Service is injected (tests use fakes). */
import { timingSafeEqual } from 'node:crypto';
import { CheckoutOrderError } from './checkout-orders.ts';
import { P24CheckoutError, validateCheckout, type createCheckoutService } from './p24-checkout.ts';

type Service = ReturnType<typeof createCheckoutService>;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: HEADERS });

async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  const announced = request.headers.get('content-length');
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > max)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return all;
}
const codeOf = (e: unknown) => e instanceof P24CheckoutError || e instanceof CheckoutOrderError ? e.code : 'UNEXPECTED';

/** Bearer check for the scheduler-only reconcile endpoint. */
export function authorizedReconciler(header: string | null, secret: string | undefined): boolean {
  if (!secret || Buffer.byteLength(secret) < 32 || !header) return false;
  const a = Buffer.from(header), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** allowedOrigin: true only for an origin of this deployment's configured addresses. */
export function createP24CheckoutHttp(service: Service | null, allowedOrigin: ((origin: string) => boolean) | null) {
  return Object.freeze({
    async register(request: Request): Promise<Response> {
      if (!service || !allowedOrigin) return json({ error: 'CHECKOUT_DISABLED' }, 503);
      // Only our own /checkout page may start a payment.
      const origin = request.headers.get('origin');
      if (!origin || !allowedOrigin(origin) || ['cross-site', 'none'].includes(request.headers.get('sec-fetch-site') ?? ''))
        return json({ error: 'CHECKOUT_ORIGIN' }, 403);
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({ error: 'CHECKOUT_CONTENT_TYPE' }, 415);
      const raw = await readBody(request, 4096);
      if (!raw) return json({ error: 'CHECKOUT_INVALID' }, 400);
      let input: unknown;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return json({ error: 'CHECKOUT_INVALID' }, 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'CHECKOUT_INVALID' }, 400);
      const valid = validateCheckout(input as Parameters<typeof validateCheckout>[0]);
      if ('field' in valid) return json({ error: 'CHECKOUT_FIELD', field: valid.field }, 400);
      try {
        const { orderId, redirectUrl } = await service.start(valid);
        return json({ orderId, redirectUrl });
      } catch (e) {
        const code = codeOf(e);
        console.error('p24_register_failed', code); // enum only: no buyer data, no keys
        return json({ error: code === 'CHECKOUT_RATE_LIMITED' ? code : 'CHECKOUT_UNAVAILABLE' }, code === 'CHECKOUT_RATE_LIMITED' ? 429 : 503);
      }
    },
    async notify(request: Request): Promise<Response> {
      if (!service) return json({ error: 'CHECKOUT_DISABLED' }, 503);
      const raw = await readBody(request, 16384);
      if (!raw) return json({ error: 'P24_NOTIFICATION_INVALID' }, 400);
      try {
        const status = await service.notify(raw);
        return json({ status });
      } catch (e) {
        const code = codeOf(e);
        console.error('p24_notify_failed', code);
        // Non-2xx makes Przelewy24 retry; authentication failures are not retried usefully but stay non-2xx.
        const client = ['P24_NOTIFICATION_INVALID', 'P24_NOTIFICATION_UNAUTHENTICATED', 'P24_SCOPE_MISMATCH',
          'P24_ORDER_UNKNOWN', 'P24_AMOUNT_MISMATCH'].includes(code);
        return json({ error: client ? code : 'P24_RETRY' }, client ? 400 : 503);
      }
    },
    /** Scheduler-only safety net (no cron registered here; enabling one is an owner decision). */
    async reconcile(request: Request, secret: string | undefined): Promise<Response> {
      if (!authorizedReconciler(request.headers.get('authorization'), secret)) return json({ error: 'unauthorized' }, 401);
      if (!service) return json({ error: 'CHECKOUT_DISABLED' }, 503);
      try { return json(await service.reconcile()); }
      catch (e) { console.error('p24_reconcile_failed', codeOf(e)); return json({ error: 'P24_RETRY' }, 503); }
    },
  });
}
