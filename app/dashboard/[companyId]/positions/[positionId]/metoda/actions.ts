"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { companyAccess } from "../../../../../../lib/company-access";
import { methodProfileError, methodProfileProblems, parseMethodProfileForm } from "../../../../../../lib/method-profile";
import type { Json } from "../../../../../../lib/supabase/database.types";

export type MethodFormState = { error?: string; saved?: boolean; revision?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SC-METHOD / #275 — zapis szkicu profilu metody i jego zatwierdzenie.
// Zapis idzie wyłącznie przez funkcje bazy, które same sprawdzają członkostwo
// w firmie, rolę (właściciel lub rekruter), stanowisko i kompletność profilu.
// Nie dotyka public.positions, więc nie unieważnia analiz CV; nie zmienia też
// żadnej istniejącej definicji zadania ani rozpoczętej próby.
export async function saveMethodProfile(companyId: string, positionId: string, _state: MethodFormState, form: FormData): Promise<MethodFormState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: "Masz dostęp tylko do odczytu." };
  if (!uuid.test(positionId)) return { error: "Nie rozpoznano stanowiska. Odśwież stronę." };
  const expected = Number(form.get("expectedRevision"));
  if (!Number.isInteger(expected) || expected < 0) return { error: "Odśwież stronę, aby wczytać aktualny szkic." };
  let content;
  try { content = parseMethodProfileForm(form); }
  catch (error) { return { error: error instanceof Error ? error.message : "Sprawdź pola formularza." }; }

  const approve = form.get("intent") === "approve";
  if (approve) {
    // Czytelna lista braków przed zapisem; baza i tak sprawdza to samo ponownie.
    const position = await client.from("positions").select("required_competencies").eq("company_id", companyId).eq("id", positionId).maybeSingle();
    if (position.error || !position.data) return { error: "Nie udało się wczytać stanowiska. Twoje odpowiedzi pozostały w formularzu." };
    const problems = methodProfileProblems(content, position.data.required_competencies);
    if (problems.length) return { error: `Nie można jeszcze zatwierdzić. ${problems.slice(0, 5).join(" ")}` };
  }

  const saved = await client.rpc("method_profile_save_draft", {
    target_company: companyId, target_position: positionId, draft_content: content as unknown as Json, expected_revision: expected,
  });
  if (saved.error || typeof saved.data !== "number") return { error: methodProfileError(saved.error) };
  const path = `/dashboard/${companyId}/positions/${positionId}/metoda`;
  if (!approve) {
    revalidatePath(path);
    return { saved: true, revision: saved.data };
  }
  const approved = await client.rpc("method_profile_approve", {
    target_company: companyId, target_position: positionId, expected_revision: saved.data,
  });
  // Szkic jest już zapisany: formularz musi znać jego nowy numer, żeby kolejna próba nie skończyła się konfliktem.
  if (approved.error || !approved.data) return { error: methodProfileError(approved.error), revision: saved.data };
  revalidatePath(path);
  redirect(`${path}?zapisano=zatwierdzono`);
}
