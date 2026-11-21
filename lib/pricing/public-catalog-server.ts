import { createClient } from '../supabase/server';
import { isPublicCatalogEnabled, publicPricesFromRows, type PublicPrices } from './public-catalog';

/**
 * SC-PRICING-W4: ceny pakietów z opublikowanego katalogu (tylko odczyt, publiczne RPC).
 * Flaga wyłączona = zero zapytań i `null`, więc strona wygląda jak dotąd.
 * Błąd odczytu albo wiersz łamiący kontrakt także dają `null` — bez cen zastępczych.
 */
export async function loadPublicCatalogPrices(env: Record<string, string | undefined> = process.env): Promise<PublicPrices | null> {
  if (!isPublicCatalogEnabled(env)) return null;
  try {
    const client = await createClient();
    const { data, error } = await client.rpc('pricing_published_packages');
    return error ? null : publicPricesFromRows(data);
  } catch {
    return null;
  }
}
