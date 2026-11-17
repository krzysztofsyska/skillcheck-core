// R2-B (ROADMAP R2, krok B) — dane sekcji „Ćwiczenia / Assessment Center"
// w raporcie jednego kandydata (docs/sc-015-extended-candidate-report.md, sekcja 2).
//
// Raport pokazuje wyłącznie obserwacje wpisane przez człowieka: poziom per
// kryterium i notatkę obserwatora jako dowód. Nie ma tu modelu AI, wyniku
// zbiorczego ani rankingu. Arkusze sesji z dwoma asesorami (ślepa ocena,
// AC_PAIRED_SHEETS_PREVIEW) celowo nie są czytane: tekst drugiego asesora nie
// może trafić do raportu przed oddaniem własnego arkusza.
//
// Odczyt idzie wyłącznie przez klienta RLS zalogowanego użytkownika (nigdy
// service_role), nazwanymi kolumnami, bez tekstu pracy kandydata. Każdy wiersz
// jest dodatkowo sprawdzany w kodzie (firma → rekrutacja → zgłoszenie → wersja
// ćwiczenia) przez buildAssessmentCenterReport; niezgodny zapis przerywa sekcję
// zamiast pokazać częściowe albo cudze oceny. Błąd odczytu daje neutralny
// komunikat i nigdy nie psuje reszty raportu. Treść to dane, nie HTML.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { buildAssessmentCenterReport } from './assessment-center-report.ts';
import type { AssessmentCenterRating } from './assessment-center-evaluation.ts';

export type ReportRoute = { companyId: string; recruitmentId: string; applicationId: string };
/** Kto czyta raport: potrzebne tylko do etykiety „kto ocenił" i do uprawnień. */
export type ReportViewer = { userId: string; ownerId: string | null; canEdit: boolean };

/** Najwyżej tyle ćwiczeń pokazuje raport (najnowsze wersje pierwsze). */
export const EXERCISES_REPORT_LIMIT = 5;
/** Górna granica wierszy czytanych w jednym zapytaniu; więcej = informacja o skróceniu. */
export const EXERCISES_SCAN_LIMIT = 100;

export const exerciseRatingLabels: Record<AssessmentCenterRating, string> = {
  below: 'Poniżej wymagań',
  meets: 'Zgodnie z wymaganiami',
  above: 'Powyżej wymagań',
  insufficient_data: 'Brak wystarczających danych',
};

export const exerciseStatusLabels = {
  not_assessed: 'Nieocenione',
  incomplete_evidence: 'Niepełne dowody',
  review_required: 'Do sprawdzenia przez człowieka',
} as const;
export type ExerciseReportStatus = keyof typeof exerciseStatusLabels;

export const exercisesSectionMessages = {
  noAccess: 'Wyniki ćwiczeń widzą właściciel konta firmy i rekruterzy tej firmy.',
  empty: 'Kandydat nie ma jeszcze ćwiczenia w tej rekrutacji.',
  unavailable: 'Ćwiczenia nie są jeszcze dostępne w tym środowisku.',
  error: 'Raport ćwiczenia jest teraz niedostępny. Odśwież raport — pozostała część raportu jest aktualna.',
} as const;

export type ExerciseReportCriterion = {
  criterionIndex: number;
  competency: string;
  rating: AssessmentCenterRating;
  ratingLabel: string;
  /** Notatka obserwatora (dowód); null przy braku danych. */
  observerNote: string | null;
};
export type ExerciseReportItem = {
  definitionEntryId: string;
  title: string;
  definitionVersion: number;
  status: ExerciseReportStatus;
  statusLabel: string;
  totalCriteria: number;
  evidencedCriteria: number;
  /** null, gdy ćwiczenie nie ma jeszcze obserwacji. */
  observation: { version: number; observedAt: string; observer: string } | null;
  criteria: ExerciseReportCriterion[];
};
export type ExercisesReportSection =
  | { kind: 'no_access' | 'empty' | 'unavailable' | 'error'; message: string }
  | { kind: 'list'; exercises: ExerciseReportItem[]; truncated: boolean };

export const reportUuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Brak tabeli, widoku albo funkcji w bazie danego środowiska. */
export function reportSchemaMissing(code?: string | null): boolean {
  return ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(code ?? '');
}
export function reportRouteValid(route: ReportRoute): boolean {
  return [route.companyId, route.recruitmentId, route.applicationId].every(value => reportUuid.test(value));
}

/** Bez nazwisk, adresów i identyfikatorów: tylko rola osoby, która zapisała wpis. */
export function reportActorLabel(actorId: string, viewer: ReportViewer): string {
  const role = viewer.ownerId && actorId === viewer.ownerId ? 'Właściciel konta firmy' : 'Rekruter';
  return actorId === viewer.userId ? `Ty (${role.toLowerCase()})` : role;
}

export function reportTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Niezgodny czas wpisu.');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Niezgodne dane ćwiczenia.');
  return value as Record<string, unknown>;
}

const definitionColumns = 'id,exercise_id,company_id,recruitment_id,version,definition,created_at';
// Bez work_sample: tekst pracy kandydata nie jest potrzebny w raporcie.
const observationColumns = 'id,company_id,recruitment_id,application_id,definition_entry_id,version,observations,author_id,created_at';

/**
 * Sekcja „Ćwiczenia / Assessment Center". Nigdy nie rzuca: każdy błąd,
 * wyjątek albo nieoczekiwany kształt danych daje neutralny komunikat.
 */
export async function loadExercisesReportSection(
  client: SupabaseClient<Database>, route: ReportRoute, viewer: ReportViewer,
): Promise<ExercisesReportSection> {
  if (!viewer.canEdit) return { kind: 'no_access', message: exercisesSectionMessages.noAccess };
  try {
    if (!reportRouteValid(route)) return { kind: 'error', message: exercisesSectionMessages.error };
    const [definitions, observations] = await Promise.all([
      client.from('exercise_definition_entries').select(definitionColumns)
        .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId)
        .order('created_at', { ascending: false }).limit(EXERCISES_SCAN_LIMIT + 1),
      client.from('latest_exercise_observations').select(observationColumns)
        .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId)
        .eq('application_id', route.applicationId).limit(EXERCISES_SCAN_LIMIT + 1),
    ]);
    if (definitions.error || observations.error) {
      return reportSchemaMissing(definitions.error?.code) || reportSchemaMissing(observations.error?.code)
        ? { kind: 'unavailable', message: exercisesSectionMessages.unavailable }
        : { kind: 'error', message: exercisesSectionMessages.error };
    }
    if (!Array.isArray(definitions.data) || !Array.isArray(observations.data)) throw new Error('Niezgodna lista.');
    let truncated = definitions.data.length > EXERCISES_SCAN_LIMIT || observations.data.length > EXERCISES_SCAN_LIMIT;

    // Najnowsza obserwacja per wersja ćwiczenia; duplikat to niezgodny zapis.
    const latest = new Map<string, Record<string, unknown>>();
    for (const item of observations.data.slice(0, EXERCISES_SCAN_LIMIT)) {
      const row = record(item);
      if (typeof row.definition_entry_id !== 'string' || latest.has(row.definition_entry_id)) {
        throw new Error('Niezgodna obserwacja.');
      }
      latest.set(row.definition_entry_id, row);
    }

    // Tylko ćwiczenia AC. Każda oceniona wersja zostaje; ćwiczenie bez żadnej
    // obserwacji pokazujemy raz, w najnowszej wersji, jako „nieocenione".
    const rows = definitions.data.slice(0, EXERCISES_SCAN_LIMIT).map(record)
      .filter(row => record(row.definition).kind === 'assessment_center');
    const observedExercises = new Set(rows.filter(row => latest.has(String(row.id))).map(row => String(row.exercise_id)));
    const shownUnobserved = new Set<string>();
    const chosen = rows.filter(row => {
      if (typeof row.id !== 'string' || !reportUuid.test(row.id) || typeof row.exercise_id !== 'string') {
        throw new Error('Niezgodna wersja ćwiczenia.');
      }
      if (latest.has(row.id)) return true;
      if (observedExercises.has(row.exercise_id) || shownUnobserved.has(row.exercise_id)) return false;
      shownUnobserved.add(row.exercise_id);
      return true;
    });
    if (!chosen.length) return { kind: 'empty', message: exercisesSectionMessages.empty };
    if (chosen.length > EXERCISES_REPORT_LIMIT) truncated = true;

    const exercises = chosen.slice(0, EXERCISES_REPORT_LIMIT).map((row): ExerciseReportItem => {
      const observation = latest.get(row.id as string) ?? null;
      // Sprawdza powiązanie z firmą, rekrutacją, zgłoszeniem i wersją oraz
      // spójność dowodów; każda niezgodność rzuca i przerywa całą sekcję.
      const report = buildAssessmentCenterReport({ ...route, definitionEntryId: row.id as string }, row, observation);
      return {
        definitionEntryId: report.definitionEntryId,
        title: report.exerciseTitle,
        definitionVersion: report.definitionVersion,
        status: report.status,
        statusLabel: exerciseStatusLabels[report.status],
        totalCriteria: report.totalCriteria,
        evidencedCriteria: report.evidencedCriteria,
        observation: observation === null ? null : {
          version: report.reviewVersion as number,
          observedAt: reportTimestamp(observation.created_at),
          observer: reportActorLabel(report.authorId as string, viewer),
        },
        criteria: report.criteria.map(criterion => ({
          criterionIndex: criterion.criterionIndex,
          competency: criterion.competency,
          rating: criterion.rating,
          ratingLabel: exerciseRatingLabels[criterion.rating],
          observerNote: criterion.source === 'observer_note' ? criterion.observerNote : null,
        })),
      };
    });
    return { kind: 'list', exercises, truncated };
  } catch {
    return { kind: 'error', message: exercisesSectionMessages.error };
  }
}
