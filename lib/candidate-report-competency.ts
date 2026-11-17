// R2-B (issue #367, propozycja R2-B-COMPETENCY) — sekcja „Test kompetencji"
// w raporcie jednego kandydata.
//
// Raport pokazuje wyłącznie ocenę człowieka (SC-014 C5): poziom per kryterium
// rubryki i dokładny cytat z odpowiedzi, który dołączył oceniający. Nie ma tu
// modelu AI, wyniku zbiorczego ani rankingu; zbiorczy wynik rubryki z bazy
// celowo nie jest pokazywany, żeby nie udawał decyzji o zatrudnieniu.
//
// Odczyt idzie wyłącznie przez klienta RLS zalogowanego użytkownika i te same
// funkcje RPC co ekran zadań (list_competency_test_attempts,
// read_competency_test_response). Baza sama sprawdza firmę, rolę (właściciel
// albo rekruter), wycofanie zgody i przynależność próby do zgłoszenia; tutaj
// dodatkowo sprawdzamy powiązanie firma → rekrutacja → zgłoszenie każdej
// odpowiedzi i każdej oceny (competencyReport). Błąd odczytu daje neutralny
// komunikat i nigdy nie psuje reszty raportu. Treść kandydata to dane, nie HTML.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { competencyReport } from './competency-staff.ts';
import { parseExerciseDefinition } from './exercise-definition.ts';
import type { CompetencyRating } from './competency-test.ts';

type Route = { companyId: string; recruitmentId: string; applicationId: string };
/** Kto czyta raport: potrzebne tylko do etykiety „kto ocenił" i do uprawnień. */
export type CompetencyReportViewer = { userId: string; ownerId: string | null; canEdit: boolean };

/** Najwyżej tyle prób pokazuje raport (najnowsze pierwsze, tak jak zwraca je baza). */
export const COMPETENCY_REPORT_LIMIT = 5;

export const competencyRatingLabels: Record<CompetencyRating, string> = {
  below: 'Poniżej wymagań',
  meets: 'Zgodnie z wymaganiami',
  above: 'Powyżej wymagań',
  insufficient_data: 'Brak wystarczających danych',
};

export const competencySectionMessages = {
  hidden: '',
  noAccess: 'Wynik testu kompetencji widzą właściciel konta firmy i rekruterzy tej firmy.',
  empty: 'Kandydat nie ma jeszcze testu kompetencji w tej rekrutacji.',
  unavailable: 'Testy kompetencji nie są jeszcze dostępne w tym środowisku.',
  error: 'Nie udało się teraz wczytać testu kompetencji. Odśwież raport — pozostała część raportu jest aktualna.',
} as const;

export type CompetencyReportCriterion = {
  criterionIndex: number;
  competency: string;
  rating: CompetencyRating;
  ratingLabel: string;
  /** Dokładny cytat z odpowiedzi kandydata; null przy braku danych. */
  evidence: string | null;
  /** Opis poziomu z rubryki; null przy braku danych. */
  rubric: string | null;
};
export type CompetencyReportReview = {
  version: number;
  reviewedAt: string;
  reviewer: string;
  totalCriteria: number;
  evidencedCriteria: number;
  criteria: CompetencyReportCriterion[];
};
export type CompetencyReportTest =
  | { attemptId: string; state: 'in_progress'; definitionVersion: number }
  | { attemptId: string; state: 'submitted'; definitionVersion: number; title: string; review: CompetencyReportReview | null };
export type CompetencyReportSection =
  | { kind: 'hidden' | 'no_access' | 'empty' | 'unavailable' | 'error'; message: string }
  | { kind: 'list'; tests: CompetencyReportTest[]; truncated: boolean };

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const missingFunctionCodes = ['PGRST202', '42883'];

/** Ten sam przełącznik co ekran zadań i akcje rekrutera (SC-014 tylko na Preview). */
export function competencyReportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.COMPETENCY_CANDIDATE_PREVIEW === 'true'
    && (env.VERCEL_ENV === 'preview' || env.NODE_ENV === 'development');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Niezgodne dane testu.');
  return value as Record<string, unknown>;
}

/** Bez nazwisk i adresów: tylko rola oceniającego, tak jak historia eksportu. */
export function competencyReviewerLabel(reviewerId: string, viewer: CompetencyReportViewer): string {
  const role = viewer.ownerId && reviewerId === viewer.ownerId ? 'Właściciel konta firmy' : 'Rekruter';
  return reviewerId === viewer.userId ? `Ty (${role.toLowerCase()})` : role;
}

function parseAttemptIndex(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Niezgodna lista prób.');
  const seen = new Set<string>();
  return value.map(item => {
    const row = record(item);
    if (typeof row.id !== 'string' || !uuid.test(row.id) || seen.has(row.id)
      || (row.state !== 'in_progress' && row.state !== 'submitted')
      || !Number.isSafeInteger(row.version) || Number(row.version) < 1) throw new Error('Niezgodna próba testu.');
    seen.add(row.id);
    return { id: row.id, state: row.state as 'in_progress' | 'submitted', version: Number(row.version) };
  });
}

async function submittedTest(
  client: SupabaseClient<Database>, route: Route, viewer: CompetencyReportViewer,
  attempt: { id: string; version: number },
): Promise<CompetencyReportTest> {
  const response = await client.rpc('read_competency_test_response', { target: attempt.id });
  if (response.error) throw new Error('Odpowiedź jest niedostępna.');
  const raw = record(response.data);
  if (typeof raw.definitionId !== 'string' || !uuid.test(raw.definitionId)) throw new Error('Niezgodna wersja testu.');
  const entry = await client.from('exercise_definition_entries').select('id,version,definition')
    .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId).eq('id', raw.definitionId).maybeSingle();
  if (entry.error || !entry.data || entry.data.id !== raw.definitionId || entry.data.version !== attempt.version) {
    throw new Error('Wersja zadania jest niedostępna.');
  }
  const definition = parseExerciseDefinition(entry.data.definition);
  // competencyReport sprawdza powiązanie odpowiedzi i każdej oceny z tym
  // zgłoszeniem i wersją zadania oraz przelicza ocenę z cytatów; niezgodny
  // zapis przerywa sekcję zamiast pokazać cudzy albo zmieniony wynik.
  const report = competencyReport(raw, route, attempt.id, entry.data.id, definition);
  let review: CompetencyReportReview | null = null;
  if (report.review) {
    const latest = (raw.reviews as unknown[]).map(record).find(row => Number(row.version) === report.review!.version);
    if (!latest || typeof latest.reviewer_id !== 'string' || !uuid.test(latest.reviewer_id)
      || typeof latest.created_at !== 'string' || !Number.isFinite(Date.parse(latest.created_at))) {
      throw new Error('Niezgodna ocena.');
    }
    review = {
      version: report.review.version,
      reviewedAt: latest.created_at,
      reviewer: competencyReviewerLabel(latest.reviewer_id, viewer),
      totalCriteria: report.review.totalCriteria,
      evidencedCriteria: report.review.evidencedCriteria,
      criteria: report.review.criterionResults.map(item => {
        const assessed = item.rating !== 'insufficient_data';
        const criterion = definition.criteria[item.criterionIndex];
        return {
          criterionIndex: item.criterionIndex,
          competency: item.competency,
          rating: item.rating,
          ratingLabel: competencyRatingLabels[item.rating],
          evidence: assessed ? item.evidence : null,
          rubric: assessed ? criterion[item.rating as 'below' | 'meets' | 'above'] : null,
        };
      }),
    };
  }
  return { attemptId: attempt.id, state: 'submitted', definitionVersion: entry.data.version, title: definition.title, review };
}

/**
 * Sekcja „Test kompetencji". Nigdy nie rzuca: każdy błąd, wyjątek albo
 * nieoczekiwany kształt danych daje neutralny komunikat.
 */
export async function loadCompetencyReportSection(
  client: SupabaseClient<Database>, route: Route, viewer: CompetencyReportViewer,
  enabled: boolean = competencyReportEnabled(),
): Promise<CompetencyReportSection> {
  if (!enabled) return { kind: 'hidden', message: competencySectionMessages.hidden };
  if (!viewer.canEdit) return { kind: 'no_access', message: competencySectionMessages.noAccess };
  try {
    if (![route.companyId, route.recruitmentId, route.applicationId].every(value => uuid.test(value))) {
      return { kind: 'error', message: competencySectionMessages.error };
    }
    const listed = await client.rpc('list_competency_test_attempts', { target: route.applicationId });
    if (listed.error) {
      return missingFunctionCodes.includes(listed.error.code ?? '')
        ? { kind: 'unavailable', message: competencySectionMessages.unavailable }
        : { kind: 'error', message: competencySectionMessages.error };
    }
    const attempts = parseAttemptIndex(listed.data);
    if (!attempts.length) return { kind: 'empty', message: competencySectionMessages.empty };
    const tests: CompetencyReportTest[] = [];
    // Obie funkcje blokują to samo zgłoszenie: odczyty idą po kolei, nie równolegle.
    for (const attempt of attempts.slice(0, COMPETENCY_REPORT_LIMIT)) {
      tests.push(attempt.state === 'in_progress'
        ? { attemptId: attempt.id, state: 'in_progress', definitionVersion: attempt.version }
        : await submittedTest(client, route, viewer, attempt));
    }
    return { kind: 'list', tests, truncated: attempts.length > COMPETENCY_REPORT_LIMIT };
  } catch {
    return { kind: 'error', message: competencySectionMessages.error };
  }
}
