import { createClient } from '../supabase/server';
import { isPaidOptionsEnabled, paidOptionsFromRows, vatFromPackageRows, type PaidOption } from './paid-options';

export type PaidOptionsOffer = { options: PaidOption[]; vatBasisPoints: number };

/**
 * SC-PRICING-W3: opcje płatne z opublikowanego katalogu (tylko odczyt, publiczne RPC).
 * Flaga wyłączona = zero zapytań i `null`, więc strona wygląda i liczy jak dotąd.
 * Błąd odczytu, pusty katalog albo niespójny wiersz także dają `null` — bez cen zastępczych.
 */
export async function loadPaidOptions(env: Record<string, string | undefined> = process.env): Promise<PaidOptionsOffer | null> {
  if (!isPaidOptionsEnabled(env)) return null;
  try {
    const client = await createClient();
    const [packages, addons] = await Promise.all([client.rpc('pricing_published_packages'), client.rpc('pricing_published_addons')]);
    if (packages.error || addons.error) return null;
    const vatBasisPoints = vatFromPackageRows(packages.data);
    const options = paidOptionsFromRows(addons.data);
    if (vatBasisPoints === null || !options || options.length === 0) return null;
    return { options, vatBasisPoints };
  } catch {
    return null;
  }
}
