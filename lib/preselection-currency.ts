import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { groupAnalysisCurrent } from './screening-report.ts';

export type RankingRow = { application_id: string; analysis_id: unknown; eligibility_reason: unknown };

/**
 * Current ranking rows of a recruitment, by application id. Reads every page (a recruitment can exceed
 * one page). Returns null when any page fails, so callers treat every saved group as outdated (fail closed).
 */
export async function loadCurrentRanking(client: Pick<SupabaseClient<Database>, 'rpc'>, recruitmentId: string) {
  const rows: RankingRow[] = [];
  while (true) {
    const page = await client.rpc('get_screening_ranking', { target_recruitment: recruitmentId, target_size: 10 })
      .range(rows.length, rows.length + 499);
    if (page.error || !Array.isArray(page.data)) return null;
    rows.push(...(page.data as RankingRow[]));
    if (page.data.length < 500 || rows.length > 20000) break;
  }
  return new Map(rows.map(r => [r.application_id, r] as const));
}

/** Marks each bulk item's group as current or not, by the same rule as the report (fail closed). */
export function withGroupCurrency<T extends { application_id: string | null; group_key: unknown; group_analysis_id?: unknown }>(
  items: T[], ranking: Map<string, RankingRow> | null): (T & { group_current: boolean })[] {
  return items.map(i => ({ ...i, group_current: !!i.group_key && !!i.application_id
    && groupAnalysisCurrent(i.group_analysis_id, ranking?.get(i.application_id)) }));
}
