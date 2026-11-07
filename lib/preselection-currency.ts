import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { groupAnalysisCurrent, isUuid } from './screening-report.ts';

export type RankingRow = { application_id: string; analysis_id: unknown; eligibility_reason: unknown };

/**
 * Current ranking rows of a recruitment, by application id. Reads every page (a recruitment can exceed
 * one page). Returns null when any page fails, so callers treat every saved group as outdated (fail closed).
 */
export async function loadCurrentRanking(client: Pick<SupabaseClient<Database>, 'rpc'>, recruitmentId: string) {
  const rows: RankingRow[] = [];
  const seen = new Set<string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  while (true) {
    // Offset pagination needs a deterministic key, not the RPC's implicit row order.
    // Otherwise a multi-page recruitment can silently miss or duplicate candidates.
    const page = await client.rpc('get_screening_ranking', { target_recruitment: recruitmentId, target_size: 10 })
      .order('application_id', { ascending: true })
      .range(rows.length, rows.length + 499);
    if (page.error || !Array.isArray(page.data)) return null;
    for (const value of page.data as unknown[]) {
      const row = value as Partial<RankingRow> | null;
      // Duplicate or malformed ranking rows must never override an older status
      // and make a saved group appear current. UUIDs are case-insensitive in SQL.
      if (!row || typeof row.application_id !== 'string' || !uuid.test(row.application_id)) return null;
      const id = row.application_id.toLowerCase();
      if (seen.has(id)) return null;
      seen.add(id);
      rows.push({ ...row, application_id: id } as RankingRow);
    }
    // A truncated ranking cannot establish currency for *any* group.
    if (rows.length > 20000) return null;
    // PostgREST may cap RPC responses below the requested 500 rows. A short page
    // is not proof of EOF: only an empty page is. Otherwise later candidates
    // could be omitted while their earlier saved group scores appear current.
    if (page.data.length === 0) break;
  }
  return new Map(rows.map(r => [r.application_id, r] as const));
}

/** Both RPCs expose a group analysis ID, but the batch RPC calls it group_analysis_id
 * and the recruitment RPC calls it analysis_id. Apply the same fail-closed rule to both.
 * An explicitly null group_analysis_id never falls back to an unrelated analysis_id. */
export function withGroupCurrency<T extends {
  application_id: string | null; group_key: unknown; group_analysis_id?: unknown; analysis_id?: unknown;
}>(items: T[], ranking: Map<string, RankingRow> | null): (T & { group_current: boolean })[] {
  return items.map(i => ({ ...i, group_current: !!i.group_key
    && isUuid(i.application_id)
    && groupAnalysisCurrent(
      Object.prototype.hasOwnProperty.call(i, 'group_analysis_id') ? i.group_analysis_id : i.analysis_id,
      ranking?.get(i.application_id.toLowerCase()),
    ) }));
}
