import type { Metadata } from "next";
import { BrandFrame } from "../../components/brand/brand-frame";
import { brandAssetHref, loadPublishedBrand } from "../../../lib/brand-server";
import { createClient } from "../../../lib/supabase/server";

// SC-020-A: panel firmy w opublikowanej marce klienta. Bez opublikowanej marki
// (albo gdy funkcja jest wyłączona) panel wygląda dokładnie jak wcześniej.
export async function generateMetadata({ params }: { params: Promise<{ companyId: string }> }): Promise<Metadata> {
  const { companyId } = await params;
  const brand = await loadPublishedBrand(companyId);
  if (!brand) return {};
  return {
    title: brand.config.brandName,
    ...(brand.faviconAssetId ? { icons: { icon: brandAssetHref(companyId, brand.faviconAssetId) } } : {}),
  };
}

export default async function CompanyLayout({ children, params }: {
  children: React.ReactNode; params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  const brand = await loadPublishedBrand(companyId);
  if (!brand) return children;
  const client = await createClient();
  const { data: company } = await client.from("companies").select("name").eq("id", companyId).maybeSingle();
  if (!company) return children;
  return <BrandFrame config={brand.config} controllerName={company.name} homeHref={`/dashboard/${companyId}`}
    logoHref={brand.logoAssetId ? brandAssetHref(companyId, brand.logoAssetId) : null}>{children}</BrandFrame>;
}
