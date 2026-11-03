import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { buyPreselekcjaTarget } from "../../../lib/buy-preselekcja";

// SC-BUY-001: the single entry point behind every "Kup PRESELEKCJĘ" button.
// It never renders; it only resolves where the visitor belongs.
export const dynamic = "force-dynamic";

export default async function BuyPreselekcja() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  let companies: { id: string; owner_id: string | null }[] = [];
  if (user) {
    const { data, error } = await client.from("companies").select("id,owner_id").order("name");
    if (error) throw new Error("Nie udało się odczytać firm. Spróbuj ponownie.");
    companies = data ?? [];
  }
  redirect(buyPreselekcjaTarget({ userId: user?.id ?? null, companies }));
}
