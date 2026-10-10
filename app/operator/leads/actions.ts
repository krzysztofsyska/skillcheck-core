"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";

export type CloseLeadState = { message: string; done: boolean };
export async function closeLead(_previous: CloseLeadState, form: FormData): Promise<CloseLeadState> {
  const failure = { message: "Nie udało się zakończyć zgłoszenia. Odśwież stronę i spróbuj ponownie.", done: false };
  const id = form.get("lead_id");
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    || form.get("confirm") !== "yes") return failure;
  try {
    const client = await createClient();
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) return failure;
    // The database authorizes against the current operator allowlist under its lock.
    const { data, error } = await client.rpc("close_sales_lead", { target_lead: id });
    if (error || data !== "ok") return failure;
    revalidatePath("/operator/leads");
    return { message: "Rozmowa zakończona. Zgłoszenie zostanie usunięte po 6 miesiącach.", done: true };
  } catch { return failure; }
}
