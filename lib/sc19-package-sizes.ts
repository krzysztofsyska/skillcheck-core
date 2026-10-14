import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

export const sc19Plans = ['FREE', 'PRESELEKCJA'] as const;
export type Sc19Plan = (typeof sc19Plans)[number];
export type Sc19PackageSizes = Record<Sc19Plan, number>;

export const sc19PolicyPendingScope = 'Liczba analiz CV według zatwierdzonej polityki';
export const sc19PolicyPendingCell = 'Według polityki';

const packageSizeError = 'Nie można odczytać wielkości pakietów.';

export function sc19AnalysisScope(credits: number): string {
  if (!Number.isInteger(credits) || credits < 1 || credits > 100000) throw new Error(packageSizeError);
  return `${credits} analiz CV`;
}

export function sc19PackageSizesFromRows(
  rows: readonly { plan: string; credits: number }[] | null,
): Sc19PackageSizes {
  const found = new Map<Sc19Plan, number>();
  for (const row of rows ?? []) {
    if (row.plan !== 'FREE' && row.plan !== 'PRESELEKCJA') continue;
    if (!Number.isInteger(row.credits) || row.credits < 1 || row.credits > 100000) throw new Error(packageSizeError);
    if (found.has(row.plan)) throw new Error(packageSizeError);
    found.set(row.plan, row.credits);
  }
  const free = found.get('FREE');
  const preselection = found.get('PRESELEKCJA');
  if (free === undefined || preselection === undefined) throw new Error(packageSizeError);
  return { FREE: free, PRESELEKCJA: preselection };
}

export function sc19OfferScopes(sizes: Sc19PackageSizes | null) {
  if (!sizes) {
    return {
      freeScope: sc19PolicyPendingScope,
      preselectionScope: sc19PolicyPendingScope,
      freeAnalyses: sc19PolicyPendingCell,
      preselectionAnalyses: sc19PolicyPendingCell,
    };
  }
  return {
    freeScope: sc19AnalysisScope(sizes.FREE),
    preselectionScope: sc19AnalysisScope(sizes.PRESELEKCJA),
    freeAnalyses: String(sizes.FREE),
    preselectionAnalyses: String(sizes.PRESELEKCJA),
  };
}

export async function loadSc19PackageSizes(client: SupabaseClient<Database>): Promise<Sc19PackageSizes> {
  const { data, error } = await client.rpc('sc19_package_sizes');
  if (error) throw new Error(packageSizeError);
  return sc19PackageSizesFromRows(data);
}
