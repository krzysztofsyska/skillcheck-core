import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './supabase/database.types';

export type CatalogQuote = { versionId: string; kind: 'package' | 'addon'; code: string; packageCode: string;
 quantity: number; grossMinor: number; cvCredits: number; serviceCode: string | null; serviceUnits: number;
 termsRevision: string; termsText: string };
export type CatalogOrder = { id: string; company_id: string; code: string; package_code: string;
 quantity: number; gross_minor: number; cv_credits: number; service_units: number; terms_text: string;
 status: 'pending' | 'paid' | 'cancelled'; accepted_at: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const catalogUuid = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100_000_000;
const str = (v: unknown, max = 160) => typeof v === 'string' && v.length > 0 && v.length <= max;
export function catalogQuotes(value: unknown): CatalogQuote[] {
 if (!Array.isArray(value) || value.length > 100) throw Error('Catalog unavailable');
 for (const r of value) if (!obj(r) || !catalogUuid(r.versionId) || !['package','addon'].includes(String(r.kind)) ||
  !str(r.code) || !str(r.packageCode) || !num(r.quantity) || Number(r.quantity)<1 || Number(r.quantity)>1000 || !num(r.grossMinor) || Number(r.grossMinor)<1 || !num(r.cvCredits) ||
  !num(r.serviceUnits) || !(r.serviceCode === null || str(r.serviceCode)) || !str(r.termsRevision) || !str(r.termsText,20000))
  throw Error('Catalog unavailable');
 return value as CatalogQuote[];
}
export function catalogOrders(value: unknown): CatalogOrder[] {
 if (!Array.isArray(value) || value.length > 100) throw Error('Orders unavailable');
 for (const r of value) if (!obj(r) || !catalogUuid(r.id) || !catalogUuid(r.company_id) || !str(r.code) ||
  !str(r.package_code) || !num(r.quantity) || !num(r.gross_minor) || !num(r.cv_credits) || !num(r.service_units) ||
  !str(r.terms_text,20000) || !str(r.accepted_at) || !['pending','paid','cancelled'].includes(String(r.status)))
  throw Error('Orders unavailable');
 return value as CatalogOrder[];
}
export function catalogEntitlements(value: unknown): {code:string;available:number;used:number}[] {
 if(!Array.isArray(value)||value.length>100||value.some(r=>!obj(r)||!str(r.code)||!num(r.available)||!num(r.used)))throw Error('Entitlements unavailable');
 return value;
}

type RpcName = 'sc19_catalog_order_options' | 'sc19_catalog_orders' | 'sc19_catalog_entitlements' | 'sc19_create_catalog_order'
 | 'sc19_cancel_catalog_order' | 'sc19_settle_catalog_order';
/** Narrow RPC facade until generated DB types are refreshed; all read results
 * are decoded above, inputs are revalidated by the database under its lock. */
export function catalogRpc(client: SupabaseClient<Database>, name: RpcName, args: Record<string, Json> = {}) {
 return client.rpc(name as never, args as never);
}
export const catalogOrderName = (code: string) => ({ skill_test: 'Test kompetencji',
 ASSESSMENT_CENTER: 'ASSESSMENT CENTER' }[code] ?? code);
