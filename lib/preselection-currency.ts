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
  const seen = new Set<string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  while (true) {
    const page = await client.rpc('get_screening_ranking', { target_recruitment: recruitmentId, target_size: 10 })
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
    if (page.data.length < 500) break;
  }
  return new Map(rows.map(r => [r.application_id, r] as const));
}

/** Marks each bulk item's group as current or not, by the same rule as the report (fail closed). */
export function withGroupCurrency<T extends { application_id: string | null; group_key: unknown; group_analysis_id?: unknown }>(
  items: T[], ranking: Map<string, RankingRow> | null): (T & { group_current: boolean })[] {
  return items.map(i => ({ ...i, group_current: !!i.group_key && !!i.application_id
    && groupAnalysisCurrent(i.group_analysis_id, ranking?.get(i.application_id.toLowerCase())) }));
}
