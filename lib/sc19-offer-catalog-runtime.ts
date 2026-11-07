/** Server composition of the READ-ONLY checkout catalog.
 *
 * Unlike resolveSc19PaymentRuntime() this is not gated on a payment provider:
 * showing an approved price and its terms needs no provider, and this seam can
 * never create an order. It exposes one SECURITY DEFINER read,
 * public.sc19_checkout_offers(uuid), which itself requires the authenticated
 * caller to own the company AND the company to have an approved
 * private.sc19_trial_approvals row — the same authorization
 * lib/sc19-payment-postgres.ts enforces for listOffers.
 *
 * The user comes from the server session (auth.getUser()), never from the
 * request body or a browser-supplied id.
 */
import { createClient } from './supabase/server.ts';
import { composeSc19OfferCatalog, type OfferCatalog, type OfferRow } from './sc19-offer-catalog.ts';

export async function resolveSc19OfferCatalog(): Promise<OfferCatalog | null> {
  try {
    const client = await createClient();
    return composeSc19OfferCatalog({
      async authenticate() {
        const { data, error } = await client.auth.getUser();
        return error || !data.user ? null : { userId: data.user.id };
      },
      async readOffers(companyId: string) {
        const { data, error } = await client.rpc('sc19_checkout_offers', { target_company: companyId });
        // Only the SQLSTATE travels on; no database message, NIP or company name.
        if (error) return { rows: null, code: error.code ?? 'unknown' };
        return { rows: (data ?? []) as readonly OfferRow[] };
      },
    });
  } catch {
    // Missing Supabase configuration must not expose a different failure shape
    // than a gated deployment: the caller answers "payments unavailable".
    return null;
  }
}
