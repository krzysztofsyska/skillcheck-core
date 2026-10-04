import { notFound, redirect } from "next/navigation";
import { createClient } from "./supabase/server";

export async function companyAccess(companyId: string) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) notFound();
  const { data: company, error } = await client.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (error) throw new Error("Nie udało się wczytać firmy.");
  if (!company) notFound();
  const { data: membership, error: memberError } = await client.from("company_members").select("role").eq("company_id", companyId).eq("user_id", user.id).maybeSingle();
  if (memberError) throw new Error("Nie udało się sprawdzić uprawnień.");
  return { client, company, user, canEdit: company.owner_id === user.id || membership?.role === "recruiter" };
}
