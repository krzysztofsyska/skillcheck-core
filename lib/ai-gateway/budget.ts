// SC-021-C: AI cost budgets (migration 20261109220000_sc021_ai_budgets.sql).
// Server-only; bundled into the screening worker (Deno), so no Node-only APIs here.
//
// Before the first physical attempt of an operation the caller reserves the operation's worst-case
// cost in the database (ai_ledger.reserve_budget). The database decides; this module only parses
// its answer and fails closed on anything unexpected. An operation that already holds a reservation
// is always allowed again (retries are never cut off); only NEW operations are refused.
import { AiGatewayError } from './contract.ts';
import type { AiCallContext } from './gateway.ts';

export type BudgetRefusal = 'budget_exceeded' | 'budget_unconfigured';
export type BudgetDecision =
  | { allowed: true; created: boolean }
  | { allowed: false; code: BudgetRefusal };

/** Reserves the operation's budget; resolves with the raw database answer (jsonb). */
export type BudgetReserver = (operationId: string) => Promise<unknown>;

/**
 * Mirror of the seeded rows of `ai_ledger.budget_estimates`. Tests pin both to the code limits
 * (screening and exercise request limits, retry counts) and to the migration.
 *
 * Screening's 120 000 input tokens is an approximation, not an enforced cap: the gateway path does
 * not cap screening requests by tokens (a byte cap at that size would refuse Polish CVs of up to
 * 100 000 characters that work today). Settled attempts always carry their exact cost; only unknown
 * attempts and the hold use this estimate. Exercise generation is bounded (48 000-byte request).
 */
export const BUDGET_ESTIMATES = Object.freeze({
  cv_screening: Object.freeze({ max_input_tokens: 120_000, max_output_tokens: 4_000, attempts_per_operation: 3 }),
  exercise_generation: Object.freeze({ max_input_tokens: 48_000, max_output_tokens: 4_000, attempts_per_operation: 1 }),
});

/** Anything but a well-formed answer is `budget_unavailable` (fail closed, nothing was sent). */
export function parseBudgetDecision(raw: unknown): BudgetDecision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AiGatewayError('budget_unavailable');
  const value = raw as Record<string, unknown>;
  if (value.allowed === true && typeof value.created === 'boolean') return { allowed: true, created: value.created };
  if (value.allowed === false && (value.code === 'budget_exceeded' || value.code === 'budget_unconfigured')) {
    return { allowed: false, code: value.code };
  }
  throw new AiGatewayError('budget_unavailable');
}

/**
 * Gateway `beforeOperation` hook: reserves the operation's budget, refusing with a not-billed
 * AiGatewayError before any provider call. Database errors never leave this function as text.
 */
export function createBudgetGuard(reserve: BudgetReserver | null | undefined) {
  return async function reserveBudget(ctx: AiCallContext): Promise<void> {
    if (typeof reserve !== 'function') throw new AiGatewayError('budget_unavailable');
    let raw: unknown;
    try { raw = await reserve(ctx.operationId); } catch { throw new AiGatewayError('budget_unavailable'); }
    const decision = parseBudgetDecision(raw);
    if (!decision.allowed) throw new AiGatewayError(decision.code);
  };
}
