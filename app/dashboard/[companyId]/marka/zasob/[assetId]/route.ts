import { createHash } from "node:crypto";
import { brandAssetHeaders, brandingEnabled, validateBrandAsset, BRAND_ASSET_BUCKET, type BrandAssetKind } from "../../../../../../lib/brand-config";
import { createClient } from "../../../../../../lib/supabase/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("Nie znaleziono.", {
  status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
});

// SC-020-A: plik marki dla członków firmy. Metadane i bajty czytane klientem RLS
// zalogowanego użytkownika; zawartość walidowana ponownie przed wysłaniem, a
// typ odpowiedzi pochodzi z walidacji, nie z tego, co zapisano w Storage.
export async function GET(_request: Request, { params }: { params: Promise<{ companyId: string; assetId: string }> }) {
  const { companyId, assetId } = await params;
  if (!brandingEnabled() || !uuid.test(companyId) || !uuid.test(assetId)) return notFound();
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return notFound();
  const { data, error } = await client.rpc("brand_asset", { target_company: companyId, target_asset: assetId });
  if (error || !data?.length) return notFound();
  const meta = data[0];
  const download = await client.storage.from(BRAND_ASSET_BUCKET).download(meta.object_path);
  if (download.error || !download.data) return notFound();
  const bytes = new Uint8Array(await download.data.arrayBuffer());
  const checked = validateBrandAsset(bytes, meta.kind as BrandAssetKind);
  if (!checked.ok || checked.value.mime !== meta.mime || bytes.length !== meta.byte_size
    || createHash("sha256").update(bytes).digest("hex") !== meta.sha256) return notFound();
  return new Response(bytes, { headers: brandAssetHeaders(checked.value.mime, bytes.length) });
}
