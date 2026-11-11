import { loadSc19PackageSizes, loadSc19PublicOfferSizes, type Sc19PackageSizes } from "../../../lib/sc19-package-sizes";
import { createClient } from "../../../lib/supabase/server";
import { freeOffer, preselekcjaOffer } from "../../../lib/preselekcja-offer";

// The approved figures live in lib/preselekcja-offer.ts so the checkout client
// component can read them too. The paid grant reads private.sc19_package_policy,
// so once the SC-019 catalog is enabled its quota wins and an enabled but
// failing catalog shows no number. FREE follows the same catalog precedence.
export { preselekcjaOffer, freeOffer } from "../../../lib/preselekcja-offer";

export const preselekcjaPrice = `${preselekcjaOffer.grossPln} zł brutto`;
export const preselekcjaScope = `${preselekcjaOffer.analyses} analiz CV`;
export const freePrice = `${freeOffer.grossPln} zł`;

export const isSc19CatalogEnabled = () => process.env.SC19_PACKAGES_ENABLED === "true";

export function preselekcjaAnalyses(catalogEnabled: boolean, sizes: Sc19PackageSizes | null): number | null {
  if (sizes) return sizes.PRESELEKCJA;
  return catalogEnabled ? null : preselekcjaOffer.analyses;
}

export function freeAnalyses(catalogEnabled: boolean, sizes: Sc19PackageSizes | null): number | null {
  if (sizes) return sizes.FREE;
  return catalogEnabled ? null : freeOffer.analyses;
}

export async function loadPublicOffer() {
  const catalogEnabled = isSc19CatalogEnabled();
  const sizes = await loadSc19PublicOfferSizes(catalogEnabled, async () => loadSc19PackageSizes(await createClient()));
  return {
    catalogEnabled,
    sizes,
    preselekcja: preselekcjaAnalyses(catalogEnabled, sizes),
    free: freeAnalyses(catalogEnabled, sizes),
  };
}
