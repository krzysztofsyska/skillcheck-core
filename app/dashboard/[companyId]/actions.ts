"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { companyAccess } from "../../../lib/company-access";
import { parsePosition, type EditorState } from "../../../lib/position-fields";

export async function savePosition(companyId: string, positionId: string | null, _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: "Masz dostęp tylko do odczytu." };
  let input;
  try { input = parsePosition(form); } catch (error) { return { error: error instanceof Error ? error.message : "Sprawdź formularz." }; }
  const query = positionId
    ? client.from("positions").update(input).eq("company_id", companyId).eq("id", positionId)
    : client.from("positions").insert({ ...input, company_id: companyId });
  const { data, error } = await query.select("id").single();
  if (error || !data) return { error: "Nie udało się zapisać stanowiska. Twoje odpowiedzi pozostały w formularzu." };
  revalidatePath("/dashboard/" + companyId);
  redirect("/dashboard/" + companyId + "/positions/" + data.id + "?saved=1");
}
export async function saveProfile(companyId: string, _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: "Masz dostęp tylko do odczytu." };
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const industry = text("industry"), description = text("description"), work_environment = text("work_environment");
  const company_values = text("company_values").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (industry.length > 200 || description.length > 10000 || work_environment.length > 5000 || company_values.length > 30 || company_values.some(s=>s.length>500)) return { error: "Skróć opis lub listę wartości firmy." };
  const { data, error } = await client.from("company_profiles").update({industry,description,work_environment,company_values}).eq("company_id",companyId).select("company_id").single();
  if (error || !data) return { error: "Nie udało się zapisać profilu." };
  revalidatePath("/dashboard/" + companyId);
  return { saved: true };
}
export async function createRecruitment(companyId: string, _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: "Masz dostęp tylko do odczytu." };
  const name = String(form.get("name") ?? "").trim();
  const positionId = String(form.get("position_id") ?? "");
  if (!name || name.length > 200) return { error: "Podaj nazwę rekrutacji (do 200 znaków)." };
  const { data: position, error: positionError } = await client.from("positions").select("id,status").eq("company_id", companyId).eq("id", positionId).maybeSingle();
  if (positionError || !position || position.status === "archived") return { error: "Wybierz dostępne stanowisko swojej firmy." };
  const { data, error } = await client.from("recruitments").insert({company_id:companyId,position_id:position.id,name}).select("id").single();
  if (error || !data) return { error: "Nie udało się utworzyć rekrutacji." };
  revalidatePath("/dashboard/" + companyId);
  redirect(`/dashboard/${companyId}/recruitments/${data.id}`);
}
