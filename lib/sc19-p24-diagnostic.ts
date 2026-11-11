/** SC-P24-DIAG-001: why the Przelewy24 Sandbox checkout is not working on THIS
 * deployment, in a form an operator can read and nobody else can.
 *
 * Two independent layers fail with the same HTTP 503, which is why naming the
 * failure took hours of guessing:
 *   1. the deployment gate (`lib/sc19-payment-preview.ts`) refuses and
 *      `resolveSc19PaymentRuntime()` is null → `SC19_PAYMENTS_DISABLED`;
 *   2. the gate resolves, the order commits, and the Przelewy24 REST call then
 *      fails or is cut short → `SC19_PAYMENT_RETRY`.
 * This module reports on both: the gate's own refusal reason, and a read-only
 * credential probe against the operator's API.
 *
 * SECURITY: nothing here returns, logs or renders a key, a password, a CRC, a
 * connection string or any fragment of one. A gate refusal carries a condition
 * NAME plus a non-reversible shape hint; the probe carries an outcome and an
 * HTTP status. It is reachable only from the operator panel, which is behind
 * `platform_operator_status`, and it performs no payment action: `testAccess` is
 * a documented read-only credential check that creates no transaction.
 */
import { PRZELEWY24_ORIGIN } from './sc19-przelewy24-provider.ts';
import { publicShape, sc19SandboxPaymentGate, type Sc19GateReason } from './sc19-payment-preview.ts';

/** The deployment gate is not the only thing that can answer 503 before the
 * provider is ever called: `SC19_PACKAGES_ENABLED` becomes `enabled` in
 * `lib/sc19-payment-preview-runtime.ts`, then `checkoutEnabled` in
 * `lib/sc19-payments.ts`, and `lib/sc19-payment-http.ts` refuses on it. It is a
 * runtime switch, not a gate condition, so it is checked HERE and never inside
 * `sc19…PaymentGate()`: those decisions must stay exactly what #421 reviewed. */
export type Sc19DiagnosticReason = Sc19GateReason | 'packages_flag';
export type Sc19DiagnosticRefusal = Readonly<{ reason: Sc19DiagnosticReason; shape: string }>;

/** `null` when packages are switched on. Shared by the rendered panel and the
 * server action, so the page and the probe can never disagree. */
export const sc19PackagesRefusal = (env: NodeJS.ProcessEnv): Sc19DiagnosticRefusal | null =>
  env.SC19_PACKAGES_ENABLED === 'true' ? null
    : { reason: 'packages_flag', shape: publicShape(env.SC19_PACKAGES_ENABLED, 16) };

/** How the operator's API answered a read-only credential check.
 *  ok           — the POS id and API key are accepted (CRC is NOT checked by it)
 *  unauthorized — 401: the POS id or the API key is wrong for this environment
 *  http         — any other answer, with its status
 *  unreachable  — no answer at all: egress, DNS or a timeout */
export type Sc19P24ProbeOutcome = 'ok' | 'unauthorized' | 'http' | 'unreachable';
export type Sc19P24Probe = Readonly<{ outcome: Sc19P24ProbeOutcome; status: number | null }>;
export type Sc19P24Diagnostic = Readonly<{
  /** `null` when nothing in the configuration refuses: the payment runtime exists
   * on this deployment AND checkout is switched on. */
  refusal: Sc19DiagnosticRefusal | null;
  probe: Sc19P24Probe | null;
}>;

const PROBE_TIMEOUT_MS = 8_000;
type ProbeFetch = (url: string, init: {
  method: string; headers: Record<string, string>; redirect: 'error'; signal: AbortSignal;
}) => Promise<{ status: number }>;

/** Read-only: GET /api/v1/testAccess is the operator's own credential check. It
 * registers nothing, charges nothing and returns no customer data — only whether
 * the Basic credentials (POS id + API key) are accepted. The CRC key signs
 * requests but does not authenticate them, so a 200 here with a register that
 * still fails points at the CRC. */
export async function sc19P24CredentialProbe(
  credentials: { posId: number; apiKey: string }, fetchImpl: ProbeFetch = fetch as unknown as ProbeFetch,
): Promise<Sc19P24Probe> {
  const auth = 'Basic ' + Buffer.from(`${credentials.posId}:${credentials.apiKey}`).toString('base64');
  let status: number;
  try {
    const response = await fetchImpl(PRZELEWY24_ORIGIN.test + '/api/v1/testAccess', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { authorization: auth, accept: 'application/json' },
    });
    status = response.status;
  } catch {
    // No provider message is kept: it can repeat the request, which carries the key.
    return { outcome: 'unreachable', status: null };
  }
  if (status === 200) return { outcome: 'ok', status };
  if (status === 401) return { outcome: 'unauthorized', status };
  return { outcome: 'http', status };
}

/** The whole picture for one deployment, in the order the request path refuses:
 * first the deployment gate — the same function the request path calls, so the
 * panel can never claim the runtime is fine while checkout refuses — then the
 * `SC19_PACKAGES_ENABLED` switch, which also answers 503 before the provider is
 * reached. The probe runs only once BOTH pass: sending an operator to look at
 * Przelewy24 for a configuration fault is the confusion this module exists to
 * end, and without a configuration there are no credentials to check anyway. */
export async function sc19P24Diagnostic(
  env: NodeJS.ProcessEnv, fetchImpl?: ProbeFetch,
): Promise<Sc19P24Diagnostic> {
  // No request origin: the panel asks about the deployment, not about one request.
  const gate = sc19SandboxPaymentGate(env);
  if (!gate.ok) return { refusal: gate.refusal, probe: null };
  const packages = sc19PackagesRefusal(env);
  if (packages) return { refusal: packages, probe: null };
  return { refusal: null, probe: await sc19P24CredentialProbe(gate.config, fetchImpl) };
}

/** The panel's query string carries only this short code, never a shape hint or
 * a status, so nothing about the configuration is written into a URL, a referrer
 * or a browser history entry. The page renders the sentence from the code. */
export type Sc19P24DiagnosticCode = string;
export const sc19P24DiagnosticCode = (result: Sc19P24Diagnostic): Sc19P24DiagnosticCode =>
  result.refusal ? `gate_${result.refusal.reason}` :
    result.probe ? `provider_${result.probe.outcome}` : 'unknown';
