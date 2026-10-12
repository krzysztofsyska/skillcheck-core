import type { LedgerStore, Reservation } from './runtime.ts';

// A trusted PostgreSQL worker calls this inside its own transaction after SET LOCAL ROLE ai_meter_worker.
// Never expose this adapter to a browser or a user-scoped Supabase RPC client.
export type AiWorkerQuery = (sql: string, values: readonly (string | number | null)[]) => Promise<unknown[]>;

function rowOf(rows: unknown[]): Record<string, unknown> {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object'
    || Array.isArray(rows[0])) throw new Error('SC021_LEDGER_INVALID_RESPONSE');
  return rows[0] as Record<string, unknown>;
}

export function postgresAiLedger(query: AiWorkerQuery): LedgerStore {
  return {
    async reserve(input): Promise<Reservation> {
      const row = rowOf(await query(
        'select * from public.ai_gateway_reserve(' +
          '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,' +
          '$7::text,$8::text,$9::text,$10::text,$11::bigint)',
        [
          input.companyId, input.requestKey, input.operationId, input.processId,
          input.candidatePseudonym, input.task, input.provider, input.model,
          input.policyVersion, input.priceVersion, input.estimatedMicroUsd,
        ],
      ));
      if (typeof row.usage_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.usage_id)
          || typeof row.created !== 'boolean' || typeof row.warning !== 'boolean') {
        throw new Error('SC021_LEDGER_INVALID_RESPONSE');
      }
      return { usageId: row.usage_id, created: row.created, warning: row.warning };
    },
    async settle(input) {
      const row = rowOf(await query(
        'select public.ai_gateway_settle(' +
          '$1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::bigint,$6::bigint,$7::text) as settled',
        [
          input.companyId, input.requestKey, input.costMicroUsd,
          input.usage.inputTokens, input.usage.cachedInputTokens, input.usage.outputTokens,
          input.providerRequestId,
        ],
      ));
      if (typeof row.settled !== 'boolean') throw new Error('SC021_LEDGER_INVALID_RESPONSE');
      return row.settled;
    },
    async markUnknown(input) {
      const row = rowOf(await query(
        'select public.ai_gateway_mark_unknown($1::uuid,$2::uuid) as marked',
        [input.companyId, input.requestKey],
      ));
      if (typeof row.marked !== 'boolean') throw new Error('SC021_LEDGER_INVALID_RESPONSE');
      return row.marked;
    },
  };
}
