// SC-015 / #268 — wspólny odczyt dla raportu pojedynczego CV i dla porównania kandydatów.
// Kontrakt: docs/sc-015-free-candidate-report.md.
//
// Raport nie liczy wyniku ogólnego, nie układa rankingu i nie sugeruje decyzji
// o zatrudnieniu. screening_analysis_versions.overall_score jest w bazie trwale NULL
// i nic tutaj tego nie zastępuje. Brak informacji w CV nie przesądza o braku kwalifikacji.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { loadScreeningContext } from './screening-flow.ts';
import { prepareScreening } from './screening.ts';
import { screeningStatus, type ScreeningRoute } from './screening-ui.ts';
import {
  countRequirementMarks, parseRequirementFlagRows, positionRequirements, resolveRequirementMarks, sortByRequirementMark,
  type CriterionKind, type PositionRequirement, type RequirementFlagRow, type RequirementMark,
} from './requirement-flags.ts';
import {
  buildCandidateRequirement, criterionRowFor, summariseCandidateReport,
  type AnalysisState, type CandidateCriterionRow, type CandidateReportSummary, type CandidateRequirement,
} from './requirement-status.ts';

// Czysty kontrakt statusów mieszka w ./requirement-status.ts, żeby komponenty
// Reacta i porównanie nie wciągały klienta Supabase. Tutaj zostaje sam odczyt.
export * from './requirement-status.ts';

export class CandidateReportError extends Error {}

/**
 * Oznaczenia wymagań dla stanowiska. Odczyt idzie przez klienta RLS zalogowanego
 * użytkownika i funkcję, która sama sprawdza dostęp do firmy; brak funkcji (baza
 * sprzed tej migracji) znaczy „nikt jeszcze nic nie oznaczył", a nie błąd.
 */
export async function loadRequirementFlags(
  client: SupabaseClient<Database>, companyId: string, positionId: string,
): Promise<RequirementFlagRow[]> {
  const result = await client.rpc('position_requirement_flags' as never, {
    target_company: companyId, target_position: positionId,
  } as never);
  if (result.error) {
    if (['PGRST202', '42883'].includes(result.error.code ?? '')) return [];
    if (result.error.code === '42501') throw new CandidateReportError('Brak dostępu do oznaczeń wymagań.');
    throw new CandidateReportError('Nie udało się wczytać oznaczeń wymagań.');
  }
  // Ten sam kontrakt RPC obowiązuje raport pojedynczego CV i porównanie.
  const rows = parseRequirementFlagRows(result.data);
  if (!rows) throw new CandidateReportError('Oznaczenia wymagań są niespójne. Odśwież raport.');
  return rows;
}

export type CandidateReport = {
  recruitmentName: string;
  positionTitle: string;
  applicationId: string;
  analysisVersion: number | null;
  documentVersion: number | null;
  /** Analiza jest, ale CV albo wymagania zmieniły się po niej. */
  stale: boolean;
  /** Rekruter odesłał tę analizę do powtórzenia (`needs_reanalysis`). */
  reanalysisRequested: boolean;
  /** Analiza nie zawiera macierzy dowodów (sprzed Step 3). */
  legacyAnalysis: boolean;
  analysisStatus: string | null;
  requirements: CandidateRequirement[];
  summary: CandidateReportSummary;
  generatedAt: string;
};

/** Raport jednego kandydata. Wszystko przez klienta RLS użytkownika, nigdy service_role. */
export async function loadCandidateReport(
  client: SupabaseClient<Database>, route: ScreeningRoute,
): Promise<CandidateReport> {
  const context = await loadScreeningContext(client, route);
  const { companyId, recruitmentId, applicationId } = route;
  let fingerprint: string | undefined;
  try { fingerprint = prepareScreening(context).fingerprint; } catch { fingerprint = undefined; }

  const readLatestAnalysis = () => client.from('screening_analysis_versions')
    .select('id,company_id,application_id,recruitment_id,analysis_version,execution_status,input_fingerprint,stale_at,candidate_document_version,latest_review_version')
    .eq('company_id', companyId).eq('application_id', applicationId).eq('recruitment_id', recruitmentId)
    .order('analysis_version', { ascending: false }).limit(1).maybeSingle();
  const latest = await readLatestAnalysis();
  if (latest.error) throw new CandidateReportError('Nie udało się wczytać analizy.');
  const analysis = latest.data;
  // Wynik z innej firmy, innej rekrutacji albo innego zgłoszenia przerywa raport,
  // zamiast zostać po cichu pominięty.
  if (analysis && (analysis.company_id !== companyId || analysis.application_id !== applicationId
    || analysis.recruitment_id !== recruitmentId)) {
    throw new CandidateReportError('Dane analizy nie pasują do tego zgłoszenia.');
  }

  const resultRows = analysis
    ? await client.from('screening_criterion_results')
      .select('analysis_id,criterion_id,criterion_text_snapshot,verdict,evidence,missing_info,suggested_question,human_status,human_verdict,human_missing_info,human_suggested_question,human_evidence')
      .eq('company_id', companyId).eq('analysis_id', analysis.id).order('criterion_order')
    : { data: [], error: null };
  if (resultRows.error) throw new CandidateReportError('Nie udało się wczytać macierzy dowodów.');
  if (resultRows.data !== null && !Array.isArray(resultRows.data)) {
    throw new CandidateReportError('Macierz dowodów ma nieprawidłowy format.');
  }
  const rows = (resultRows.data ?? []) as (CandidateCriterionRow & { analysis_id?: string; criterion_text_snapshot?: string })[];
  if (analysis) {
    // Każdy dowód musi należeć do odczytanej analizy. Brak analysis_id, pusty
    // criterion_id lub duplikat nie może nadpisać wcześniejszego werdyktu
    // w Map i niejawnie zmienić podsumowania raportu.
    const seenCriteria = new Set<string>();
    for (const row of rows) {
      if (!row || row.analysis_id !== analysis.id
        || typeof row.criterion_id !== 'string' || !row.criterion_id
        || seenCriteria.has(row.criterion_id)) {
        throw new CandidateReportError('Macierz dowodów jest niespójna. Odśwież raport.');
      }
      seenCriteria.add(row.criterion_id);
    }
  }

  // Rekruter mógł odesłać całą analizę do powtórzenia. Taki wynik zostaje w bazie
  // jako `completed` ze `stale_at` pustym, więc bez tego odczytu raport pokazywałby
  // werdykty z analizy, którą człowiek już odrzucił.
  const readLatestReview = () => client.from('screening_result_reviews')
    .select('analysis_id,review_version,disposition')
    .eq('company_id', companyId).eq('analysis_id', analysis!.id)
    .order('review_version', { ascending: false }).limit(1);
  const reviewRows = analysis ? await readLatestReview() : { data: [], error: null };
  if (reviewRows.error) throw new CandidateReportError('Nie udało się wczytać historii sprawdzenia.');
  // Lista z filtrem i limit(1) musi być tablicą z najwyżej jednym wierszem.
  // W przeciwnym razie uszkodzona odpowiedź Data API mogłaby potwierdzić
  // dowody przeglądem bez powiązania z bieżącą analizą (albo złej rewizji).
  if (!Array.isArray(reviewRows.data) || reviewRows.data.length > 1) {
    throw new CandidateReportError('Historia sprawdzenia jest niespójna. Odśwież raport.');
  }
  const latestReview = reviewRows.data[0] as
    { analysis_id?: string; review_version?: number; disposition?: string } | undefined;
  if (reviewRows.data.length && (!analysis || !latestReview || typeof latestReview !== 'object'
    || latestReview.analysis_id !== analysis.id
    || typeof latestReview.review_version !== 'number' || !Number.isSafeInteger(latestReview.review_version)
    || latestReview.review_version < 1
    || typeof latestReview.disposition !== 'string' || !latestReview.disposition.trim())) {
    throw new CandidateReportError('Historia sprawdzenia jest niespójna. Odśwież raport.');
  }
  const reanalysisRequested = latestReview?.disposition === 'needs_reanalysis';
  // Sprawdzenie jest dwustopniowe: najpierw wiersze macierzy, potem cała analiza.
  // Dopóki drugiego stopnia nie ma, raport nie nazywa niczego potwierdzonym — tak
  // samo jak porównanie, które dla takiej analizy pokazuje „oczekuje na sprawdzenie".
  // Korekta macierzy podbija rewizję analizy bez usuwania starego przeglądu.
  // Historyczna akceptacja nie zatwierdza nowych wierszy; jak w rankingu,
  // niezgodne rewizje oznaczają review_inconsistent / wynik nieaktualny.
  const reviewInconsistent = !!analysis && (latestReview?.review_version ?? 0) !== analysis.latest_review_version;
  const awaitingReview = !latestReview || reviewInconsistent
    || !['approved', 'approved_with_changes'].includes(latestReview.disposition ?? '');

  const flags = await loadRequirementFlags(client, companyId, context.position.id);
  // Odczyty przez Data API nie są jedną transakcją. Zmiana wiersza pomiędzy
  // odczytem analizy a macierzy unieważnia ich wspólny obraz także wtedy, gdy
  // oba historyczne numery przeglądu początkowo się zgadzały.
  const rechecked = await readLatestAnalysis();
  if (rechecked.error || JSON.stringify(rechecked.data) !== JSON.stringify(analysis)) {
    throw new CandidateReportError('Wynik lub przegląd zmienił się podczas odczytu. Odśwież raport.');
  }
  // A review can change independently of the analysis row between Data API reads.
  // Never publish a mixed snapshot where a revoked/changed review still approves evidence.
  if (analysis) {
    const recheckedReview = await readLatestReview();
    if (recheckedReview.error || JSON.stringify(recheckedReview.data) !== JSON.stringify(reviewRows.data)) {
      throw new CandidateReportError('Wynik lub przegląd zmienił się podczas odczytu. Odśwież raport.');
    }
  }
  const requirements = positionRequirements(context.position);
  const marks = resolveRequirementMarks(requirements, flags);
  const byCriterion = new Map(rows.map(row => [row.criterion_id, row]));
  const stale = !!analysis && screeningStatus(analysis, fingerprint) === 'stale';
  const analysisState: AnalysisState = analysis
    ? { execution_status: analysis.execution_status, outdated: stale || reanalysisRequested || reviewInconsistent, awaitingReview }
    : null;
  const built = sortByRequirementMark(requirements, marks).map(requirement =>
    buildCandidateRequirement(requirement, marks.get(requirement.id) ?? 'unmarked', analysisState,
      criterionRowFor(requirement, byCriterion.get(requirement.id))));

  return {
    recruitmentName: context.recruitment.name,
    positionTitle: context.position.title,
    applicationId,
    analysisVersion: analysis?.analysis_version ?? null,
    documentVersion: analysis?.candidate_document_version ?? null,
    stale,
    /** Rekruter odesłał tę analizę do powtórzenia. */
    reanalysisRequested,
    // Analiza częściowo zmigrowana też zasługuje na ostrzeżenie: wystarczy jeden wiersz bez werdyktu.
    // Zakończona analiza bez żadnych wierszy też nie ma macierzy dowodów;
    // nie może być przedstawiana jako raport nowego typu.
    legacyAnalysis: !!analysis && analysis.execution_status === 'completed'
      && (rows.length === 0 || rows.some(row => row.verdict == null)),
    analysisStatus: analysis?.execution_status ?? null,
    requirements: built,
    summary: summariseCandidateReport(built),
    generatedAt: new Date().toISOString(),
  };
}

export type { CriterionKind, PositionRequirement, RequirementMark, RequirementFlagRow };
export { countRequirementMarks };
