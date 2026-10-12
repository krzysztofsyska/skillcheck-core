import {
  selectModel, usageCostMicroUsd,
  type AiRoutingPolicy, type AiTask, type ModelRate, type TokenUsage,
} from './core.ts';

export type UsageContext = {
  // These identifiers must be derived from a trusted worker claim, never raw browser JSON.
  companyId: string;
  requestKey: string; // unique per physical provider attempt; retries require a fresh requestKey.
  operationId: string; // stable business operation across retries.
  processId: string | null;
  candidatePseudonym: string | null;
  task: AiTask;
};
export type Reservation = { usageId: string; created: boolean; warning: boolean };
export type LedgerStore = {
  reserve(input: UsageContext & {
    provider: string; model: string; policyVersion: string; priceVersion: string;
    estimatedMicroUsd: number;
  }): Promise<Reservation>;
  settle(input: {
    companyId: string; requestKey: string; costMicroUsd: number;
    usage: TokenUsage; providerRequestId: string | null;
  }): Promise<boolean>;
  markUnknown(input: { companyId: string; requestKey: string }): Promise<boolean>;
};
export type ModelInvocation<T> = {
  data: T;
  usage: TokenUsage | null;
  providerRequestId: string | null;
};
export type ProviderAdapter<T> = (
  rate: ModelRate, correlationId: string,
) => Promise<ModelInvocation<T>>;

export class AiGatewayError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'AiGatewayError';
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertContext(ctx: UsageContext) {
  if (![ctx.companyId, ctx.requestKey, ctx.operationId].every(x => uuid.test(x))
    || (ctx.processId !== null && !uuid.test(ctx.processId))
    || (ctx.candidatePseudonym !== null
      && !/^[A-Za-z0-9:_-]{1,80}$/.test(ctx.candidatePseudonym))) {
    throw new AiGatewayError('SC021_INVALID_CONTEXT');
  }
}

export async function runMeteredOperation<T>(input: {
  context: UsageContext;
  policy: AiRoutingPolicy;
  // A trusted upper-bound forecast; a low estimate weakens preflight budget protection.
  maxExpectedUsage: TokenUsage;
  ledger: LedgerStore;
  invoke: ProviderAdapter<T>;
  correlationId?: string;
}): Promise<{ data: T; costMicroUsd: number; warning: boolean; correlationId: string }> {
  assertContext(input.context);
  const rate = selectModel(input.policy, input.context.task);
  const estimatedMicroUsd = usageCostMicroUsd(rate, input.maxExpectedUsage);
  // Exactly the persisted physical-attempt ID must be sent to the provider.
  // A different caller-supplied ID would make an unknown charge unreconcilable.
  const correlationId = input.context.requestKey;
  if (input.correlationId !== undefined && input.correlationId !== correlationId) {
    throw new AiGatewayError('SC021_INVALID_CONTEXT');
  }

  const reservation = await input.ledger.reserve({
    ...input.context,
    provider: rate.provider,
    model: rate.model,
    policyVersion: input.policy.version,
    priceVersion: rate.priceVersion,
    estimatedMicroUsd,
  });
  // A replay MUST NOT repeat the physical provider call, even if a prior attempt is unresolved.
  if (!reservation.created) throw new AiGatewayError('SC021_DUPLICATE_ATTEMPT');

  let reply: ModelInvocation<T>;
  try {
    reply = await input.invoke(rate, correlationId);
  } catch {
    // On network errors usage may have been billed. Hold reservation for reconciliation.
    await input.ledger.markUnknown({
      companyId: input.context.companyId, requestKey: input.context.requestKey,
    });
    throw new AiGatewayError('SC021_PROVIDER_FAILURE');
  }

  if (reply.usage === null) {
    await input.ledger.markUnknown({
      companyId: input.context.companyId, requestKey: input.context.requestKey,
    });
    throw new AiGatewayError('SC021_USAGE_UNAVAILABLE');
  }
  // The provider has already responded: invalid/unknown usage and settlement errors
  // must hold the reservation as unknown, rather than leaving it as in-flight.
  try {
    const costMicroUsd = usageCostMicroUsd(rate, reply.usage);
    const wasSettled = await input.ledger.settle({
      companyId: input.context.companyId,
      requestKey: input.context.requestKey,
      costMicroUsd,
      usage: reply.usage,
      providerRequestId: reply.providerRequestId,
    });
    if (!wasSettled) throw new AiGatewayError('SC021_ALREADY_SETTLED');
    return { data: reply.data, costMicroUsd, warning: reservation.warning, correlationId };
  } catch (error) {
    await input.ledger.markUnknown({
      companyId: input.context.companyId, requestKey: input.context.requestKey,
    });
    throw error;
  }
}
