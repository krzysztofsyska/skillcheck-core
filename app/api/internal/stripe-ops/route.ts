import { STRIPE_OPS_HEADER, stripeOpsAuthorized, stripeOpsGate, stripeOpsSetup, stripeOpsStatus, StripeOpsError } from '../../../../lib/stripe-ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** R7: one-off Stripe setup (lib/stripe-ops.ts). Header `x-skillcheck-ops` with the
 * one-time token (only its SHA-256 is in the code); body {"action":"status"|"setup"}.
 * Without the token: 401 and nothing is read. `setup` runs on the production
 * deployment only. Never logs a key, a secret or a response body. */
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!stripeOpsAuthorized(request.headers.get(STRIPE_OPS_HEADER))) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  let action: unknown;
  try { action = ((await request.json()) as { action?: unknown })?.action; } catch { action = null; }
  if (action !== 'status' && action !== 'setup') return Response.json({ error: 'invalid_action' }, { status: 400, headers });
  try {
    if (action === 'status') return Response.json(await stripeOpsStatus(process.env), { headers });
    const gate = stripeOpsGate(process.env);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 409, headers });
    if (!gate.production) return Response.json({ error: 'production_only' }, { status: 409, headers });
    return Response.json(await stripeOpsSetup(gate.key, gate.mode), { headers });
  } catch (e) {
    console.error('STRIPE_OPS_FAILED', e instanceof StripeOpsError ? e.status : 0, e instanceof StripeOpsError ? e.stripeCode ?? '-' : '-');
    return Response.json({ error: 'stripe_api', status: e instanceof StripeOpsError ? e.status : 0,
      code: e instanceof StripeOpsError ? e.stripeCode : null }, { status: 502, headers });
  }
}
