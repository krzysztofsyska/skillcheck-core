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
  'in_progress', 'unavailable', 'legacy', 'rejected',
  'supported', 'partial', 'missing', 'contradicted',
] as const;
export type RequirementStatus = typeof requirementStatuses[number];

export const requirementStatusLabels: Record<RequirementStatus, string> = {
  // „Analiza w toku" i „Brak informacji w CV" to dwa różne stany i nigdy nie dzielą etykiety:
  // pierwszy znaczy, że nikt jeszcze nie sprawdził, drugi — że sprawdzono i w CV nic nie ma.
  in_progress: 'Analiza w toku',
  unavailable: 'Brak wyniku analizy',
  legacy: 'Analiza starszego typu',
  rejected: 'Wiersz odrzucony przez rekrutera',
  supported: 'Potwierdzone w CV',
  partial: 'Częściowo potwierdzone',
  missing: 'Brak informacji w CV',
  contradicted: 'Sprzeczne dane',
};

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

export type AnalysisState = { execution_status: string } | null;

const verdicts = new Set(['supported', 'partial', 'missing', 'contradicted']);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

function quotes(value: unknown): EvidenceQuote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const e = item as Record<string, unknown>;
    if (typeof e.quote !== 'string' || !e.quote.trim()) return [];
    const start = Number.isSafeInteger(e.start) ? e.start as number : 0;
    const end = Number.isSafeInteger(e.end) ? e.end as number : start + e.quote.length;
    return [{ start, end, quote: e.quote }];
  }).slice(0, 5);
}

/**
 * Status jednego wymagania u jednego kandydata. Jedyne miejsce, w którym kolumny
 * macierzy dowodów zamieniają się na stan pokazywany człowiekowi.
 */
export function requirementStatus(analysis: AnalysisState, row: CandidateCriterionRow | undefined): RequirementStatus {
  if (!analysis || analysis.execution_status === 'pending' || analysis.execution_status === 'processing') return 'in_progress';
  if (analysis.execution_status !== 'completed' || !row) return 'unavailable';
  if (row.verdict == null) return 'legacy';
  // Odrzucony wiersz nie jest dowodem w żadną stronę: wymaganie zostaje otwarte,
  // a rekruter układa pytanie sam. Ta sama zasada co w lib/interview-gaps.ts.
  if (row.human_status === 'rejected') return 'rejected';
  const edited = row.human_status === 'edited';
  const verdict = edited ? row.human_verdict ?? row.verdict : row.verdict;
  return verdicts.has(verdict) ? verdict as RequirementStatus : 'unavailable';
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
  const rejected = status === 'rejected';
  // Przy odrzuconym wierszu nie publikujemy ani werdyktu AI, ani jego cytatów.
  const evidence = rejected || !row ? [] : quotes(edited ? row.human_evidence ?? row.evidence : row.evidence);
  const missingInfo = rejected || !row ? null : text(edited ? row.human_missing_info ?? row.missing_info : row.missing_info);
  const saved = rejected || !row ? null : text(edited ? row.human_suggested_question ?? row.suggested_question : row.suggested_question);
  return {
    ...requirement, mark, status,
    quotes: evidence,
    missingInfo,
    question: isRequirementGap(status) ? saved ?? fallbackGapQuestion : null,
    corrected: edited || rejected,
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
    requiredPending: required.filter(r => r.status === 'in_progress' || r.status === 'unavailable' || r.status === 'legacy').length,
    unmarkedTotal: rows.filter(r => r.mark === 'unmarked').length,
    additionalTotal: rows.filter(r => r.mark === 'additional').length,
  };
}

