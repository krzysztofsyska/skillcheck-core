import { loadSc19PackageSizes, loadSc19PublicOfferSizes, type Sc19PackageSizes } from "../../../lib/sc19-package-sizes";
import { createClient } from "../../../lib/supabase/server";

// Current PRESELEKCJA offer approved by the owner on 2026-10-28.
// The paid grant reads private.sc19_package_policy, so once the SC-019 catalog
// is enabled its quota wins and an enabled but failing catalog shows no number.
export const preselekcjaOffer = {
  analyses: 60,
  grossPln: 300,
  netPln: "243,90",
  validityMonths: 3,
} as const;

export const preselekcjaPrice = `${preselekcjaOffer.grossPln} zł brutto`;
export const preselekcjaScope = `${preselekcjaOffer.analyses} analiz CV`;

export const isSc19CatalogEnabled = () => process.env.SC19_PACKAGES_ENABLED === "true";

export function preselekcjaAnalyses(catalogEnabled: boolean, sizes: Sc19PackageSizes | null): number | null {
  if (sizes) return sizes.PRESELEKCJA;
  return catalogEnabled ? null : preselekcjaOffer.analyses;
}

export async function loadPublicOffer() {
  const catalogEnabled = isSc19CatalogEnabled();
  const sizes = await loadSc19PublicOfferSizes(catalogEnabled, async () => loadSc19PackageSizes(await createClient()));
  return { catalogEnabled, sizes, preselekcja: preselekcjaAnalyses(catalogEnabled, sizes) };
}
