// SC-020-A — odczyt marki po stronie serwera. Zawsze przez klienta RLS
// zalogowanego użytkownika (nigdy service_role); baza sprawdza członkostwo.
import { cache } from 'react';
import { createClient } from './supabase/server';
import { brandingEnabled, parseBrandConfig, type BrandConfig } from './brand-config';

export type PublishedBrand = {
  versionId: string;
  versionNo: number;
  config: BrandConfig;
  logoAssetId: string | null;
  faviconAssetId: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function brandAssetHref(companyId: string, assetId: string) {
  if (!uuid.test(companyId) || !uuid.test(assetId)) throw new Error('Nieprawidłowy plik marki.');
  return `/dashboard/${companyId}/marka/zasob/${assetId}`;
}

/**
 * Opublikowana marka firmy albo null (brak publikacji, brak uprawnień, funkcja
 * wyłączona, migracja jeszcze niezastosowana). Błąd nigdy nie psuje panelu:
 * wtedy panel wygląda jak bez marki. Konfiguracja jest walidowana ponownie.
 */
export const loadPublishedBrand = cache(async (companyId: string): Promise<PublishedBrand | null> => {
  if (!brandingEnabled() || !uuid.test(companyId)) return null;
  const client = await createClient();
  const { data, error } = await client.rpc('brand_published', { target_company: companyId });
  if (error || !data?.length) return null;
  const row = data[0];
  const config = parseBrandConfig(row.config);
  if (!config.ok) return null;
  return {
    versionId: row.version_id, versionNo: row.version_no, config: config.value,
    logoAssetId: row.logo_asset_id, faviconAssetId: row.favicon_asset_id,
  };
});

/** Komunikaty błędów z bazy -> tekst dla użytkownika. */
export function brandErrorStatus(message: string | undefined) {
  const text = message ?? '';
  for (const key of ['brand_contrast_insufficient', 'brand_color_invalid', 'brand_config_invalid', 'brand_asset_invalid',
    'brand_draft_changed', 'brand_asset_limit', 'brand_version_unavailable', 'brand_forbidden', 'brand_storage_unavailable']) {
    if (text.includes(key)) return key.replace(/^brand_/, '');
  }
  return 'failed';
}

/**
 * SC-020-C: tytuł karty/wydruku strony panelu firmy. Z opublikowaną marką —
 * „<tytuł> | <marka klienta>”, bez niej — dotychczasowe „<tytuł> | SkillCheck”.
 */
export async function brandedTitle(companyId: string, base: string) {
  const brand = await loadPublishedBrand(companyId);
  return `${base} | ${brand ? brand.config.brandName : 'SkillCheck'}`;
}
