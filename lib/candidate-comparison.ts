// SC-015 / #268 — porównanie kandydatów: wiersze to wymagania, kolumny to kandydaci.
// Kontrakt: docs/sc-015-free-candidate-report.md.
//
// Statusy i etykiety są te same, co w raporcie pojedynczego CV (lib/candidate-report.ts),
// żeby to samo wymaganie u tego samego kandydata nie nazywało się w dwóch widokach inaczej.
// Porównanie nie liczy wyniku, nie ustawia kolejności merytorycznej i nie sugeruje decyzji.

import { statusPublishesEvidence, type RequirementStatus } from './requirement-status.ts';
import {
  positionRequirements, resolveRequirementMarks, sortByRequirementMark,
  type PositionRequirement, type RequirementFlagRow, type RequirementMark,
} from './requirement-flags.ts';
import type { ReportApplication, ReportCriterion, ScreeningReport } from './screening-report.ts';

/** Limit z #268. Celowo osobny od parametru `size` raportu (ten steruje wielkością sugestii shortlisty). */
export const MAX_COMPARISON_CANDIDATES = 5;

export type ComparisonCell = {
  applicationId: string;
  status: RequirementStatus;
  /** Pierwszy dostępny cytat dla tego wymagania; null, gdy go nie ma. */
  quote: string | null;
  corrected: boolean;
};
export type ComparisonRow = PositionRequirement & { mark: RequirementMark; cells: ComparisonCell[] };
export type ComparisonCandidate = {
  applicationId: string;
  rank: number | null;
  shortlisted: boolean;
  /** Analiza trwa — kolumna nie znaczy „brak informacji", tylko „jeszcze nie wiadomo". */
  inProgress: boolean;
};
export type CandidateComparison = {
  candidates: ComparisonCandidate[];
  rows: ComparisonRow[];
  /** Ilu kandydatów nie zmieściło się w limicie pięciu. */
  omitted: number;
};

const inProgressReasons = new Set(['pending', 'processing']);
// Raport rekrutacji wczytuje wiersze macierzy tylko dla analiz sprawdzonych przez
// człowieka (lib/screening-report-source.ts), więc pusta lista kryteriów ma kilka
// różnych znaczeń. Komórka ma mówić, które z nich zaszło — „brak wyniku analizy"
// przy wyniku, który istnieje i tylko czeka na sprawdzenie, byłoby nieprawdą.
const reasonStatuses: Record<string, RequirementStatus> = {
  pending: 'in_progress', processing: 'in_progress',
  no_human_review: 'awaiting_review',
  stale: 'outdated', needs_reanalysis: 'outdated', review_inconsistent: 'outdated',
};

/**
 * Wymagania aktualnego profilu z identyfikatorami analizy. Raport niesie wymagania
 * w kolejności zadania → KPI → kompetencje (lib/screening-report-source.ts), czyli
 * dokładnie tej, z której lib/screening.ts buduje `task:1`, `kpi:2`, `competency:3`.
 */
export function comparisonRequirements(requirements: ScreeningReport['requirements']): PositionRequirement[] {
  return positionRequirements({
    tasks: requirements.filter(r => r.kind === 'task').map(r => r.text),
    kpis: requirements.filter(r => r.kind === 'kpi').map(r => r.text),
    required_competencies: requirements.filter(r => r.kind === 'competency').map(r => r.text),
  });
}

/**
 * Status jednego wymagania u jednego kandydata w porównaniu. Raport rekrutacji
 * rozstrzyga już korektę rekrutera (lib/screening-report-source.ts), więc tutaj
 * zostaje przełożenie jego werdyktu na ten sam zestaw statusów, co w raporcie
 * pojedynczego CV — włącznie z rozróżnieniem analizy w toku od braku informacji.
 */
export function comparisonStatus(application: ReportApplication, criterion: ReportCriterion | undefined): RequirementStatus {
  const fromReason = reasonStatuses[application.ranking.eligibility_reason];
  if (fromReason) return fromReason;
  if (!criterion) return 'unavailable';
  if (criterion.matrixVerdict === null) return 'legacy';
  if (criterion.matrixVerdict === 'rejected') return 'rejected';
  return criterion.matrixVerdict;
}

/** Shortlista człowieka najpierw, potem miejsce w rankingu, na końcu identyfikator — deterministycznie. */
export function comparisonCandidates(report: ScreeningReport): { chosen: ReportApplication[]; omitted: number } {
  const ordered = [...report.applications].sort((a, b) => {
    const shortlist = Number(!!b.shortlist) - Number(!!a.shortlist);
    if (shortlist) return shortlist;
    const rank = (a.ranking.rank ?? Infinity) - (b.ranking.rank ?? Infinity);
    if (rank) return rank;
    return a.ranking.application_id.localeCompare(b.ranking.application_id);
  });
  return {
    chosen: ordered.slice(0, MAX_COMPARISON_CANDIDATES),
    omitted: Math.max(0, ordered.length - MAX_COMPARISON_CANDIDATES),
  };
}

export function buildCandidateComparison(
  report: ScreeningReport, flags: readonly RequirementFlagRow[] = report.requirementFlags ?? [],
): CandidateComparison {
  const requirements = comparisonRequirements(report.requirements);
  const marks = resolveRequirementMarks(requirements, flags);
  const { chosen, omitted } = comparisonCandidates(report);
  const rows = sortByRequirementMark(requirements, marks).map(requirement => ({
    ...requirement,
    mark: marks.get(requirement.id) ?? 'unmarked' as RequirementMark,
    cells: chosen.map(application => {
      // Kandydat analizowany na innej wersji wymagań nie ma w tym wierszu wyniku:
      // komórka mówi „brak wyniku analizy", nigdy „brak informacji w CV".
      const criterion = application.criteria.find(c => c.id === requirement.id && c.text === requirement.text);
      const status = comparisonStatus(application, criterion);
      return {
        applicationId: application.ranking.application_id,
        status,
        // Ta sama reguła publikowania, co w raporcie pojedynczego CV — jedna
        // funkcja, żeby widoki nie rozjechały się przy żadnym statusie.
        quote: statusPublishesEvidence(status) ? criterion?.evidence[0]?.quote ?? null : null,
        corrected: !!criterion?.reviewedChange,
      };
    }),
  }));
  return {
    candidates: chosen.map(application => ({
      applicationId: application.ranking.application_id,
      rank: application.ranking.rank,
      shortlisted: !!application.shortlist,
      inProgress: inProgressReasons.has(application.ranking.eligibility_reason),
    })),
    rows,
    omitted,
  };
}
