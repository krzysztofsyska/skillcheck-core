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
import { sc19SandboxPaymentGate, type Sc19GateRefusal } from './sc19-payment-preview.ts';

/** How the operator's API answered a read-only credential check.
 *  ok           — the POS id and API key are accepted (CRC is NOT checked by it)
 *  unauthorized — 401: the POS id or the API key is wrong for this environment
 *  http         — any other answer, with its status
 *  unreachable  — no answer at all: egress, DNS or a timeout */
export type Sc19P24ProbeOutcome = 'ok' | 'unauthorized' | 'http' | 'unreachable';
export type Sc19P24Probe = Readonly<{ outcome: Sc19P24ProbeOutcome; status: number | null }>;
export type Sc19P24Diagnostic = Readonly<{
  /** `null` when the gate resolved: the payment runtime exists on this deployment. */
  refusal: Sc19GateRefusal | null;
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

/** The whole picture for one deployment. The gate verdict is the real one: it is
 * the same function the request path calls, so the panel can never claim the
 * runtime is fine while checkout refuses. The probe runs only when the gate
 * resolved, because without a configuration there are no credentials to check. */
export async function sc19P24Diagnostic(
  env: NodeJS.ProcessEnv, fetchImpl?: ProbeFetch,
): Promise<Sc19P24Diagnostic> {
  // No request origin: the panel asks about the deployment, not about one request.
  const gate = sc19SandboxPaymentGate(env);
  if (!gate.ok) return { refusal: gate.refusal, probe: null };
  return { refusal: null, probe: await sc19P24CredentialProbe(gate.config, fetchImpl) };
}

/** The panel's query string carries only this short code, never a shape hint or
 * a status, so nothing about the configuration is written into a URL, a referrer
 * or a browser history entry. The page renders the sentence from the code. */
export type Sc19P24DiagnosticCode = string;
export const sc19P24DiagnosticCode = (result: Sc19P24Diagnostic): Sc19P24DiagnosticCode =>
  result.refusal ? `gate_${result.refusal.reason}` :
    result.probe ? `provider_${result.probe.outcome}` : 'unknown';
