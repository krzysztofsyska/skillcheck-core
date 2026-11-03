import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { buyPreselekcjaTarget } from "../../../lib/buy-preselekcja";

// SC-BUY-001: the single entry point behind every "Kup PRESELEKCJĘ" button.
// It never renders; it only resolves where the visitor belongs.
export const dynamic = "force-dynamic";

export default async function BuyPreselekcja() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  let companyId: string | null = null;
  if (user) {
    const { data, error } = await client.from("companies").select("id").order("name").limit(1);
    if (error) throw new Error("Nie udało się odczytać firm. Spróbuj ponownie.");
    companyId = data?.[0]?.id ?? null;
  }
  redirect(buyPreselekcjaTarget({ signedIn: Boolean(user), companyId }));
}
