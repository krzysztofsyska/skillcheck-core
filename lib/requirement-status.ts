// SC-015 / #268 — status wymagania u kandydata: czysty kontrakt widoków.
// Kontrakt: docs/sc-015-free-candidate-report.md.
//
// Ten moduł nie sięga do bazy ani do sieci. Czytają go raport pojedynczego CV,
// porównanie kandydatów i komponenty React, więc nie wolno mu wciągać klienta
// Supabase ani niczego, co przy imporcie potrzebuje zmiennych środowiskowych.
//
// Raport nie liczy wyniku ogólnego, nie układa rankingu i nie sugeruje decyzji
// o zatrudnieniu. screening_analysis_versions.overall_score jest w bazie trwale NULL
// i nic tutaj tego nie zastępuje. Brak informacji w CV nie przesądza o braku kwalifikacji.

import type { PositionRequirement, RequirementMark } from './requirement-flags.ts';

export const requirementStatuses = [
  'in_progress', 'awaiting_review', 'outdated', 'unavailable', 'legacy', 'rejected',
  'supported', 'partial', 'missing', 'contradicted',
] as const;
export type RequirementStatus = typeof requirementStatuses[number];

export const requirementStatusLabels: Record<RequirementStatus, string> = {
  // „Analiza w toku" i „Brak informacji w CV" to dwa różne stany i nigdy nie dzielą etykiety:
  // pierwszy znaczy, że nikt jeszcze nie sprawdził, drugi — że sprawdzono i w CV nic nie ma.
  in_progress: 'Analiza w toku',
  // Analiza jest gotowa, ale nikt jej jeszcze nie sprawdził — to też nie jest brak informacji w CV.
  awaiting_review: 'Oczekuje na sprawdzenie przez człowieka',
  outdated: 'Wynik nieaktualny',
  unavailable: 'Brak wyniku analizy',
  legacy: 'Analiza starszego typu',
  rejected: 'Wiersz odrzucony przez rekrutera',
  supported: 'Potwierdzone w CV',
  partial: 'Częściowo potwierdzone',
  missing: 'Brak informacji w CV',
  contradicted: 'Sprzeczne dane',
};

/**
 * Czy przy tym statusie widok pokazuje cytat, „czego brakuje" i pytanie.
 * Jedno źródło dla obu widoków — inaczej to samo wymaganie u tego samego
 * kandydata raz miałoby cytat, a raz nie.
 *
 * Publikują cztery werdykty oraz `outdated` i `awaiting_review`: zamknięta
 * rekrutacja, zatrudniony kandydat, zmienione CV czy brak sprawdzenia nie są
 * powodem, żeby wymazać rekruterowi dowód, który i tak widzi w macierzy — a
 * etykieta mówi wprost, że to jeszcze nie jest potwierdzenie.
 *
 * Nie publikują `rejected` (rekruter odrzucił ten dowód), `in_progress`,
 * `legacy` i `unavailable` — tam dowodu albo nie ma, albo został odrzucony.
 */
const publishingStatuses = new Set<RequirementStatus>([
  'supported', 'partial', 'missing', 'contradicted', 'outdated', 'awaiting_review',
]);
export const statusPublishesEvidence = (status: RequirementStatus) => publishingStatuses.has(status);

/** Statusy, przy których widok podaje pytanie na rozmowę. */
const gapStatuses = new Set<RequirementStatus>(['partial', 'missing', 'contradicted', 'rejected']);
export const isRequirementGap = (status: RequirementStatus) => gapStatuses.has(status);

/** To samo zdanie, którego używa „Przygotowanie do rozmowy": rekruter nie dostaje dwóch pytań o to samo. */
export const fallbackGapQuestion =
  'Poproś o konkretny przykład z pracy, który pokazuje to wymaganie: sytuację, własne działania i rezultat.';

export const noMissingDataDisclaimer = 'Brak informacji w CV nie przesądza o braku kwalifikacji.';

export type EvidenceQuote = { start: number; end: number; quote: string };

/** Wiersz macierzy dowodów, w zakresie, którego potrzebują oba widoki. */
export type CandidateCriterionRow = {
  criterion_id: string;
  verdict: string | null;
  evidence: unknown;
  missing_info: string | null;
  suggested_question: string | null;
  human_status: string;
  human_verdict: string | null;
  human_missing_info: string | null;
  human_suggested_question: string | null;
  human_evidence: unknown;
};

export type AnalysisState = {
  execution_status: string;
  /** Materiał zmienił się po analizie albo rekruter odesłał ją do powtórzenia. */
  outdated?: boolean;
  /** Wiersze są, ale całej analizy nikt jeszcze nie zatwierdził. */
  awaitingReview?: boolean;
} | null;

const verdicts = new Set(['supported', 'partial', 'missing', 'contradicted']);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

function quotes(value: unknown): EvidenceQuote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const e = item as Record<string, unknown>;
    if (typeof e.quote !== 'string' || !e.quote.trim()) return [];
    // An absent or corrupt offset is not evidence of the beginning of the CV.
    // Never fabricate a citation range from the quote length; omit the damaged
    // citation while preserving any other correctly anchored evidence.
    if (!Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end)) return [];
    const start = e.start as number, end = e.end as number;
    if (start < 0 || end < start || end > 1_000_000) return [];
    return [{ start, end, quote: e.quote }];
  }).slice(0, 5);
}

/**
 * Status jednego wymagania u jednego kandydata. Jedyne miejsce, w którym kolumny
 * macierzy dowodów zamieniają się na stan pokazywany człowiekowi.
 */
export function requirementStatus(analysis: AnalysisState, row: CandidateCriterionRow | undefined): RequirementStatus {
  if (!analysis || analysis.execution_status === 'pending' || analysis.execution_status === 'processing') return 'in_progress';
  if (analysis.execution_status !== 'completed' || !row) return analysis.outdated ? 'outdated' : 'unavailable';
  if (row.verdict == null) return 'legacy';
  // Decyzje człowieka o pojedynczym wierszu idą PRZED stanem całej analizy.
  // Odrzucony wiersz nie jest dowodem w żadną stronę: wymaganie zostaje otwarte,
  // a rekruter układa pytanie sam. Ta sama zasada co w lib/interview-gaps.ts.
  // Gdyby `outdated` sprawdzać wcześniej, nieaktualna analiza przywracałaby na
  // ekran cytat AI, który rekruter wprost odrzucił.
  if (row.human_status === 'rejected') return 'rejected';
  // Rekruter odesłał analizę do powtórzenia albo materiał zmienił się po niej.
  // Wynik dalej stoi w bazie jako `completed` ze `stale_at` pustym, więc bez tego
  // raport pokazywałby „Potwierdzone w CV" dla analizy, którą człowiek już odrzucił.
  if (analysis.outdated) return 'outdated';
  const edited = row.human_status === 'edited';
  const verdict = edited ? row.human_verdict ?? row.verdict : row.verdict;
  if (!verdicts.has(verdict)) return 'unavailable';
  // Potwierdzenie, którego nikt nie sprawdził, nie jest potwierdzeniem. To ta sama
  // zasada, którą stosuje lib/interview-gaps.ts (`source: 'unverified'` zamiast
  // `supported`) i którą pokazuje macierz dowodów („Niezweryfikowane"). Werdykty
  // mówiące o luce idą dalej: one o nic nie przesądzają, tylko rodzą pytanie.
  //
  // Sprawdzenie jest dwustopniowe — najpierw wiersze, potem cała analiza — i oba
  // stopnie muszą być domknięte. Inaczej rekruter, który zaakceptował jeden wiersz,
  // widziałby w raporcie potwierdzone wymaganie, którego porównanie tych samych
  // danych pokazać odmawia.
  //
  // Domyślnie „niesprawdzone": liczy się wyłącznie wyraźna akceptacja człowieka.
  // Gdyby doszedł piąty stan przeglądu wiersza, ma czytać się jako oczekujący na
  // sprawdzenie, a nie jako „Potwierdzone w CV".
  const rowReviewed = row.human_status === 'accepted' || edited;
  if (verdict === 'supported' && (!rowReviewed || analysis.awaitingReview)) return 'awaiting_review';
  return verdict as RequirementStatus;
}

/**
 * Wiersz analizy dla wymagania — albo nic, gdy wiersz dotyczy innego wymagania.
 * Identyfikator kryterium (`task:1`, `competency:1`) jest pozycyjny, więc po zmianie
 * profilu stanowiska wskazuje inny tekst niż ten, na którym analiza pracowała.
 * Bez tego sprawdzenia nowe wymaganie dostałoby werdykt i cytat poprzedniego.
 * Ta sama zasada rządzi oznaczeniami (lib/requirement-flags.ts) i porównaniem.
 */
export function criterionRowFor<T extends { criterion_text_snapshot?: string | null }>(
  requirement: Pick<PositionRequirement, 'text'>, row: T | undefined,
): T | undefined {
  if (!row) return undefined;
  return (row.criterion_text_snapshot ?? '').trim() === requirement.text.trim() ? row : undefined;
}

export type CandidateRequirement = PositionRequirement & {
  mark: RequirementMark;
  status: RequirementStatus;
  quotes: EvidenceQuote[];
  missingInfo: string | null;
  /** Pytanie z przewodnika; null przy statusach, które o nic nie pytają. */
  question: string | null;
  /** Rekruter zmienił albo odrzucił ten wiersz. */
  corrected: boolean;
};

export function buildCandidateRequirement(
  requirement: PositionRequirement, mark: RequirementMark,
  analysis: AnalysisState, row: CandidateCriterionRow | undefined,
): CandidateRequirement {
  const status = requirementStatus(analysis, row);
  const edited = !!row && row.human_status === 'edited';
  const publishes = !!row && statusPublishesEvidence(status);
  const evidence = publishes ? quotes(edited ? row.human_evidence ?? row.evidence : row.evidence) : [];
  const missingInfo = publishes ? text(edited ? row.human_missing_info ?? row.missing_info : row.missing_info) : null;
  const saved = publishes ? text(edited ? row.human_suggested_question ?? row.suggested_question : row.suggested_question) : null;
  return {
    ...requirement, mark, status,
    quotes: evidence,
    missingInfo,
    question: isRequirementGap(status) ? saved ?? fallbackGapQuestion : null,
    corrected: edited || status === 'rejected',
  };
}

export type CandidateReportSummary = {
  /** Liczby liczone wyłącznie wśród wymagań koniecznych — tych, które rekruter sam tak oznaczył. */
  requiredTotal: number;
  requiredSupported: number;
  requiredGaps: number;
  requiredPending: number;
  unmarkedTotal: number;
  additionalTotal: number;
};

export function summariseCandidateReport(rows: readonly CandidateRequirement[]): CandidateReportSummary {
  const required = rows.filter(r => r.mark === 'required');
  return {
    requiredTotal: required.length,
    requiredSupported: required.filter(r => r.status === 'supported').length,
    requiredGaps: required.filter(r => isRequirementGap(r.status)).length,
    // Wszystko, co nie mówi nic o treści CV: czeka na wynik, na sprawdzenie, jest
    // nieaktualne, starszego typu albo wyniku nie ma. Nigdy nie jest to „brak informacji".
    requiredPending: required.filter(r => !verdicts.has(r.status) && r.status !== 'rejected').length,
    unmarkedTotal: rows.filter(r => r.mark === 'unmarked').length,
    additionalTotal: rows.filter(r => r.mark === 'additional').length,
  };
}

