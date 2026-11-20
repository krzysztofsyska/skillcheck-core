import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { catalogEntitlements, catalogRpc } from './sc19-catalog-orders.ts';

/**
 * ROADMAP R3: an Assessment Center session needs the company's paid ASSESSMENT CENTER package.
 * The database enforces it (20261121090000_r3_ac_package_gate.sql: ac_session_create and opening
 * a draft are refused with PT402). This only lets the page say so before the owner fills a form.
 * 'unknown' (read failed or schema not there yet) keeps the forms: the database still decides.
 */
export const AC_PACKAGE_ENTITLEMENT = 'package:ASSESSMENT_CENTER';
export type AcPackageState = 'active' | 'missing' | 'unknown';
export { AC_PACKAGE_MISSING_TEXT } from './assessment-center-session.ts';

export function acPackageState(value: unknown): AcPackageState {
  try {
    return catalogEntitlements(value).some(row => row.code === AC_PACKAGE_ENTITLEMENT && row.available > 0) ? 'active' : 'missing';
  } catch { return 'unknown'; }
}

export async function loadAcPackageState(client: SupabaseClient<Database>, companyId: string): Promise<AcPackageState> {
  const result = await catalogRpc(client, 'sc19_catalog_entitlements', { target_company: companyId });
  return result.error ? 'unknown' : acPackageState(result.data);
}
