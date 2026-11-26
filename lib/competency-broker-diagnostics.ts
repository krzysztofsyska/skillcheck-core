/**
 * R1 diagnostics for the candidate competency broker. Every 503 path emits one
 * structured server log line with a FIXED code only. Never log env values,
 * DSNs, hostnames, IPs, headers, cookies, HMACs, error messages or stacks.
 * The HTTP response stays the generic {"error":"unavailable"}.
 */
export const COMPETENCY_BROKER_UNAVAILABLE_REASONS = [
  'disabled',
  'config_origin',
  'config_keys',
  'config_dsn',
  'config_limiter',
  'config_runtime',
  'backpressure',
  'source_untrusted',
  'limiter_unavailable',
  'gateway_unavailable',
  'operation_failed',
  'internal'
] as const;
export type CompetencyBrokerUnavailableReason = typeof COMPETENCY_BROKER_UNAVAILABLE_REASONS[number];

/** Optional fixed sub-code for limiter/gateway failures (where it failed, not why). */
export const COMPETENCY_BROKER_UNAVAILABLE_DETAILS = [
  'pool_backpressure',
  'connect',
  'verify_login',
  'verify_identity',
  'verify_privileges',
  'verify_logging',
  'verify_query',
  'rpc'
] as const;
export type CompetencyBrokerUnavailableDetail = typeof COMPETENCY_BROKER_UNAVAILABLE_DETAILS[number];

const REASONS = new Set<string>(COMPETENCY_BROKER_UNAVAILABLE_REASONS);
const DETAILS = new Set<string>(COMPETENCY_BROKER_UNAVAILABLE_DETAILS);
const DETAIL = Symbol('competencyBrokerDiagnostic');

/** Attach a fixed sub-code to an error object (non-enumerable, never serialized). */
export function tagCompetencyDiagnostic<E>(error: E, detail: CompetencyBrokerUnavailableDetail): E {
  if (error !== null && typeof error === 'object' && !Object.hasOwn(error, DETAIL)) {
    try { Object.defineProperty(error, DETAIL, { value: detail, enumerable: false }); } catch { /* frozen */ }
  }
  return error;
}
export function competencyDiagnosticDetail(error: unknown): CompetencyBrokerUnavailableDetail | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const value = (error as Record<symbol, unknown>)[DETAIL];
  return typeof value === 'string' && DETAILS.has(value) ? value as CompetencyBrokerUnavailableDetail : undefined;
}

export function logCompetencyBrokerUnavailable(reason: CompetencyBrokerUnavailableReason,
  detail?: CompetencyBrokerUnavailableDetail): void {
  try {
    const line: Record<string, string> = {
      event: 'competency_broker_unavailable',
      reason: REASONS.has(reason) ? reason : 'internal'
    };
    if (detail !== undefined && DETAILS.has(detail)) line.detail = detail;
    console.warn(JSON.stringify(line));
  } catch { /* diagnostics must never change the response */ }
}
