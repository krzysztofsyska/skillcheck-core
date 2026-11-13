"use server";
import { revalidatePath } from "next/cache";
import { companyAccess } from "../../../../../../lib/company-access";
import { diagnosticProblems, parseDiagnosticForm, processError } from "../../../../../../lib/process-diagnostics";
import type { Json } from "../../../../../../lib/supabase/database.types";

export type DiagnosticFormState = { error?: string; saved?: boolean; recordNo?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SC-PROCESS / #277 część A — zapis diagnozy rekrutacji przy małym napływie CV.
// Zapis idzie wyłącznie przez funkcję bazy, która sama sprawdza członkostwo
// w firmie, rolę (właściciel lub rekruter), rekrutację oraz regułę: zalecenia
// „zmień budżet" nie da się zapisać, dopóki którykolwiek obszar nie jest
// sprawdzony. Zapis jest notatką rekrutera: niczego nie zmienia w rekrutacji,
// budżecie ani pakiecie i nie dotyczy żadnego kandydata.
export async function recordDiagnostic(companyId: string, recruitmentId: string, _state: DiagnosticFormState, form: FormData): Promise<DiagnosticFormState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: "Masz dostęp tylko do odczytu." };
  if (!uuid.test(recruitmentId)) return { error: "Nie rozpoznano rekrutacji. Odśwież stronę." };
  const expected = Number(form.get("expectedRecordNo"));
  if (!Number.isInteger(expected) || expected < 0) return { error: "Odśwież stronę, aby wczytać aktualną historię diagnoz." };
  let submission;
  try { submission = parseDiagnosticForm(form); }
  catch (error) { return { error: error instanceof Error ? error.message : "Sprawdź pola formularza." }; }
  // Czytelna lista braków przed zapisem; baza i tak sprawdza to samo ponownie.
  const problems = diagnosticProblems(submission);
  if (problems.length) return { error: `Nie można jeszcze zapisać. ${problems.join(" ")}` };

  const saved = await client.rpc("process_record_diagnostic", {
    target_company: companyId, target_recruitment: recruitmentId, diagnostic: submission.content as unknown as Json,
    recommendation_kind: submission.recommendationKind, recommendation: submission.recommendation, expected_record_no: expected,
  });
  if (saved.error || typeof saved.data !== "number") return { error: processError(saved.error) };
  revalidatePath(`/dashboard/${companyId}/recruitments/${recruitmentId}/diagnostyka`);
  return { saved: true, recordNo: saved.data };
}
