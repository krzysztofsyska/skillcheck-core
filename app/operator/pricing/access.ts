import 'server-only';
import { notFound } from 'next/navigation';
import { salesOperator } from '../sales/access';

/** Owner gate for the internal pricing calculator. `platform_operator_status` alone is not enough
 * (sc-pricing-contract: pricing owner is independent of the sales operator role), so the caller must
 * also be listed in the server-only PRICING_OWNER_EMAILS with a confirmed e-mail. Interim until the
 * database pricing-owner role (#142) exists; fails closed when the variable is unset. */
export async function pricingOwner() {
  const client = await salesOperator();
  const { data: { user } } = await client.auth.getUser();
  const owners = (process.env.PRICING_OWNER_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const email = user?.email?.toLowerCase();
  if (!user?.email_confirmed_at || !email || !owners.includes(email)) notFound();
}
