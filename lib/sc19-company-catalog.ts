import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

const names = { FREE: 'FREE', PRESELEKCJA: 'PRESELEKCJA', WERYFIKACJA: 'WERYFIKACJA', ASSESSMENT_CENTER: 'ASSESSMENT CENTER' } as const;
// Only existing, customer-visible capabilities may be described. This is not
// an entitlement map: no add-on ordering/fulfilment contract is active yet.
const visibleAddons = { report: { name: 'Raport PDF/CSV', unit: 'raport' }, ocr_page: { name: 'Strona OCR', unit: 'strona' } } as const;
type PackageCode = keyof typeof names;
export type CompanyCatalog = {
  packages: { code: PackageCode; name: string; grossMinor: number; cvIncluded: number; availability: string }[];
  addons: { code: string; name: string; unit: string; grossMinor: number }[];
};
const whole = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const row = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Display-only published RPC results. Never use this model to price an order,
 * authorize a purchase or grant credits. No fallback prices or implied readiness. */
export function companyCatalogFromRows(packages: unknown, addons: unknown): CompanyCatalog | null {
  if (!Array.isArray(packages) || packages.length !== 4 || !Array.isArray(addons) || addons.length > 100) return null;
  const parsed = new Map<PackageCode, CompanyCatalog['packages'][number]>();
  let vat: number | undefined;
  for (const p of packages) {
    if (!row(p) || typeof p.package_code !== 'string' || !Object.hasOwn(names, p.package_code) ||
        !whole(p.gross_minor, 0, 100_000_000) || !whole(p.cv_included, 0, 10_000) ||
        !whole(p.cv_step, 1, 1000) || !whole(p.cv_max, p.cv_included, 10_000) ||
        !whole(p.overage_gross_per_cv_minor, 0, 100_000_000) || !whole(p.vat_basis_points, 0, 10_000) ||
        typeof p.sellable !== 'boolean' || (vat !== undefined && vat !== p.vat_basis_points)) return null;
    const code = p.package_code as PackageCode;
    if (parsed.has(code)) return null;
    vat = p.vat_basis_points;
    const supported = code === 'FREE' || code === 'PRESELEKCJA';
    parsed.set(code, { code, name: names[code], grossMinor: p.gross_minor, cvIncluded: p.cv_included,
      availability: !supported || !p.sellable ? 'Niedostępny do zakupu' : code === 'FREE'
        ? 'Aktywacja po weryfikacji firmy' : 'Dostępność zamówienia sprawdzana w kasie' });
  }
  const output: CompanyCatalog['addons'] = [];
  const seen = new Set<string>();
  for (const a of addons) {
    if (!row(a) || typeof a.code !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(a.code) || seen.has(a.code)) return null;
    seen.add(a.code);
    if (!Object.hasOwn(visibleAddons, a.code)) continue;
    if (!whole(a.gross_minor, 1, 100_000_000)) return null;
    output.push({ code: a.code, ...visibleAddons[a.code as keyof typeof visibleAddons], grossMinor: a.gross_minor });
  }
  return { packages: (Object.keys(names) as PackageCode[]).map(code => parsed.get(code)!), addons: output };
}

export async function loadCompanyCatalog(client: SupabaseClient<Database>): Promise<CompanyCatalog | null> {
  try {
    const [packages, addons] = await Promise.all([client.rpc('pricing_published_packages'), client.rpc('pricing_published_addons')]);
    if (packages.error || addons.error) return null;
    return companyCatalogFromRows(packages.data, addons.data);
  } catch { return null; }
}
