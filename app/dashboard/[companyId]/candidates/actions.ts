"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { companyAccess } from "../../../../lib/company-access";
import { parseCandidate } from "../../../../lib/candidate-fields";
import type { EditorState } from "../../../../lib/position-fields";

export async function addCandidate(companyId: string, _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: "Masz dostęp tylko do odczytu." };
  let input;
  try { input = parseCandidate(form); } catch (error) { return { error: error instanceof Error ? error.message : "Sprawdź dane." }; }
  const { data, error } = await client.from("candidates").insert({ ...input, company_id: companyId }).select("id").single();
  if (error || !data) return { error: "Nie udało się zapisać kandydata. Dane pozostały w formularzu." };
  revalidatePath(`/dashboard/${companyId}`);
  redirect(`/dashboard/${companyId}/candidates/${data.id}?saved=1`);
}

export async function assignCandidate(companyId: string, candidateId: string, _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: "Masz dostęp tylko do odczytu." };
  const recruitmentId = String(form.get("recruitment_id") ?? "");
  const [candidate, recruitment] = await Promise.all([
    client.from("candidates").select("id").eq("company_id", companyId).eq("id", candidateId).maybeSingle(),
    client.from("recruitments").select("id").eq("company_id", companyId).eq("id", recruitmentId).maybeSingle(),
  ]);
  if (candidate.error || recruitment.error || !candidate.data || !recruitment.data) return { error: "Wybierz kandydata i rekrutację swojej firmy." };
  const { error } = await client.from("applications").insert({ company_id: companyId, candidate_id: candidateId, recruitment_id: recruitmentId });
  if (error) return { error: error.code === "23505" ? "Kandydat jest już przypisany do tej rekrutacji." : "Nie udało się przypisać kandydata." };
  revalidatePath(`/dashboard/${companyId}/candidates/${candidateId}`);
  revalidatePath(`/dashboard/${companyId}/recruitments/${recruitmentId}`);
  return { saved: true };
}
