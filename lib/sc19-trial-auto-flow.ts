import { randomUUID } from 'node:crypto';
import { lookupCompanyByNip, normalizeNip, WhitelistError, type WhitelistFetch } from './mf-whitelist.ts';
import {
  decideTrialAuto, signTrialAuto, trialAutoClaimPayload, trialAutoEnabled,
  SC19_TRIAL_AUTO_TIMEOUT_MS, type TrialAutoDecision,
} from './sc19-trial-auto.ts';

/** SC-FREE-AUTO-001 server side: ask the Ministry of Finance registry, then hand
 * the answer to the signed RPC. Runs only in a server action, never in the
 * browser: the request secret must not reach a client bundle.
 *
 * ORDER OF ATTEMPTS. public.sc19_claim_trial is tried first, so a company the
 * operator already approved never costs a registry call — the MF API is a public,
 * keyless service with a low daily quota (see lib/mf-whitelist.ts), and this is
 * the only place in the product that calls it on a user action.
 *
 * FAIL-CLOSED. Anything other than a parsed, confirmed registry answer leaves
 * the company with no credits and on the existing manual list. No path here can
 * grant: only public.sc19_claim_trial grants, and it still demands the approval
 * row plus every guardrail it had before.
 *
 * ONE CANONICAL NIP. Every step uses the 10 digits normalizeNip() returns, never
 * the raw field value. The registration field accepts separators ("526-104-08-28"),
 * the database normalizes before it rebuilds the signed payload, and signing the
 * raw input instead made every formatted NIP fail the signature check and fall
 * through to manual review after the registry quota had already been spent.
 */

export type RpcError = { code?: string; message?: string } | null;

/** The three database calls this flow needs, wrapped the way
 * lib/sales-mail-server.ts wraps its own: the Supabase query builder is a
 * thenable with a generic, name-bound signature, so the server action adapts it
 * once and tests supply a plain object. */
export type TrialStore = {
  claim(companyId: string, nip: string): Promise<{ error: RpcError }>;
  /** Owner-gated, unsigned, grants nothing: tells us whether the automatic path
   * is open for this company and this NIP at all, and records its own refusal.
   * Called BEFORE the registry, so a switched-off automat or a second NIP from
   * the same account never spends the Ministry of Finance quota. */
  precheck(companyId: string, nip: string): Promise<{ data: unknown; error: RpcError }>;
  autoClaim(args: Record<string, string | number>): Promise<{ data: unknown; error: RpcError }>;
  recordFailure(args: Record<string, string | number>): Promise<void>;
};

export type TrialActivationStatus =
  | 'activated'   // FREE granted
  | 'manual'      // registry did not confirm, or automation is off: operator review
  | 'taken'       // this NIP or company already used its FREE
  | 'invalid'     // malformed NIP
  | 'failed';     // unexpected error

export type TrialActivationResult = Readonly<{
  status: TrialActivationStatus;
  decision: TrialDecisionRecord | null;
}>;

/** What the registry said, for logging without identifying data. */
export type TrialDecisionRecord = Readonly<{ outcome: TrialAutoDecision['outcome']; errorCode: string | null }>;

const CLAIM_ERRORS: Record<string, TrialActivationStatus> = {
  '23505': 'taken', '22023': 'invalid',
};

function claimStatus(error: { code?: string; message?: string }): TrialActivationStatus {
  const message = error.message ?? '';
  // The one error that automation can still resolve: no verified company yet.
  if (error.code === '42501' && message.includes('sc19_trial_requires_verified_company')) return 'manual';
  if (error.code === '42501') return 'failed';
  return CLAIM_ERRORS[error.code ?? ''] ?? 'failed';
}

export async function activateFreeWithWhitelist(input: {
  store: TrialStore;
  companyId: string;
  nip: string;
  fetchImpl?: WhitelistFetch;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<TrialActivationResult> {
  const { store, companyId } = input;
  const env = input.env ?? process.env;

  // 0. One canonical NIP for every later step: the signature, the RPC arguments
  //    and the registry lookup must all see the same 10 digits the database
  //    normalizes to, or a formatted NIP can never pass the signature check.
  const canonical = normalizeNip(input.nip);
  if (!canonical) return Object.freeze({ status: 'invalid', decision: null });

  // 1. Already approved (automatically earlier, or by an operator)? Grant now.
  const claimed = await store.claim(companyId, canonical);
  if (!claimed.error) return Object.freeze({ status: 'activated', decision: null });
  const firstStatus = claimStatus(claimed.error);
  if (firstStatus !== 'manual') return Object.freeze({ status: firstStatus, decision: null });

  // 2. No approval yet. Ask the database whether the automatic path is open
  //    before spending a registry call: the operator switch, the configured
  //    secret and the one-NIP-per-account rule are all checked there, and the
  //    refusal writes its own audit row so the operator can see who is waiting.
  const gate = await store.precheck(companyId, canonical);
  const gateRow = (Array.isArray(gate.data) ? gate.data[0] : gate.data) as
    { allowed?: unknown; reason?: unknown } | null;
  if (gate.error || !gateRow || gateRow.allowed !== true) {
    const reason = typeof gateRow?.reason === 'string' ? gateRow.reason : null;
    return Object.freeze({ status: 'manual', decision: Object.freeze({ outcome: 'refused', errorCode: reason }) });
  }
  // Without the server secret nothing after this point can be signed, so the
  // registry is not called at all; the precheck row above is the audit trail.
  if (!trialAutoEnabled(env)) {
    return Object.freeze({ status: 'manual', decision: Object.freeze({ outcome: 'unavailable', errorCode: 'NO_SERVER_SECRET' }) });
  }
  const secret = env.SC19_TRIAL_AUTO_SECRET!;
  const fetchImpl = (input.fetchImpl ?? (globalThis.fetch as unknown as WhitelistFetch));

  // 3. Ask the registry. Every failure mode is caught; none of them grants.
  let decision: TrialAutoDecision;
  try {
    const record = await lookupCompanyByNip(canonical, fetchImpl, { timeoutMs: SC19_TRIAL_AUTO_TIMEOUT_MS, now: input.now });
    decision = decideTrialAuto(record);
  } catch (error) {
    decision = decideTrialAuto(error instanceof WhitelistError ? error : new WhitelistError('WHITELIST_UNAVAILABLE'));
  }
  const record: TrialDecisionRecord = Object.freeze({ outcome: decision.outcome, errorCode: decision.errorCode });

  // 4. The registry refused, or we got no usable answer: record BOTH, with the
  //    registry's own code, so the operator sees the company is waiting and
  //    why. Recording is best effort; it never grants and its own failure must
  //    not change the outcome the company sees.
  if (decision.outcome !== 'granted') {
    const code = decision.errorCode ?? 'WHITELIST_RESPONSE_INVALID';
    const requestId = randomUUID(), issuedAtMs = Date.now();
    const payload = [companyId.toLowerCase(), canonical, decision.outcome, code].join('\n');
    try {
      await store.recordFailure({
        target_company: companyId, supplied_nip: canonical,
        failure_outcome: decision.outcome, failure_code: code,
        request_id: requestId, issued_at_ms: issuedAtMs,
        request_signature: signTrialAuto('auto_failure', requestId, issuedAtMs, payload, secret),
      });
    } catch { /* audit is best effort; the company still goes to manual review */ }
    return Object.freeze({ status: 'manual', decision: record });
  }

  // 5. Confirmed registered taxpayer: the database re-checks owner, signature,
  //    switch and status before it approves and claims.
  const requestId = randomUUID(), issuedAtMs = Date.now();
  const signed = {
    requestId, issuedAtMs, companyId, nip: canonical,
    mfRequestId: decision.mfRequestId, mfStatus: decision.mfStatus, mfName: decision.mfName,
  };
  const granted = await store.autoClaim({
    target_company: companyId, supplied_nip: canonical,
    mf_request_id: decision.mfRequestId, mf_status: decision.mfStatus, mf_name: decision.mfName,
    request_id: requestId, issued_at_ms: issuedAtMs,
    request_signature: signTrialAuto('auto_claim', requestId, issuedAtMs, trialAutoClaimPayload(signed), secret),
  });
  if (granted.error) {
    const status = claimStatus(granted.error);
    // sc19_auto_disabled (the operator switch is off) and a rejected signature
    // both mean: no automation today, review by hand.
    return Object.freeze({ status: status === 'failed' ? 'manual' : status, decision: record });
  }
  const row = Array.isArray(granted.data) ? granted.data[0] : granted.data;
  const outcome = (row as { outcome?: unknown } | null)?.outcome;
  return Object.freeze({ status: outcome === 'granted' ? 'activated' : 'manual', decision: record });
}

/** Adapts a Supabase server client to TrialStore. The only place that names the
 * RPCs, so the flow above stays independent of the generated client types. */
export function trialStore(client: {
  rpc: {
    (name: 'sc19_claim_trial', args: { target_company: string; supplied_nip: string }): PromiseLike<{ error: RpcError }>;
    (name: 'sc19_auto_free_precheck', args: { target_company: string; supplied_nip: string }): PromiseLike<{ data: unknown; error: RpcError }>;
    (name: 'sc19_auto_claim_trial', args: never): PromiseLike<{ data: unknown; error: RpcError }>;
    (name: 'sc19_auto_record_failure', args: never): PromiseLike<{ error: RpcError }>;
  };
}): TrialStore {
  return {
    async claim(companyId, nip) {
      const { error } = await client.rpc('sc19_claim_trial', { target_company: companyId, supplied_nip: nip });
      return { error };
    },
    async precheck(companyId, nip) {
      const { data, error } = await client.rpc('sc19_auto_free_precheck', { target_company: companyId, supplied_nip: nip });
      return { data, error };
    },
    async autoClaim(args) {
      const { data, error } = await client.rpc('sc19_auto_claim_trial', args as never);
      return { data, error };
    },
    async recordFailure(args) {
      await client.rpc('sc19_auto_record_failure', args as never);
    },
  };
}
