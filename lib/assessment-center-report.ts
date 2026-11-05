import { parseExerciseDefinition } from './exercise-definition.ts';
import type { AssessmentCenterRating } from './assessment-center-evaluation.ts';

/**
 * Pure, fail-closed projection of an already-authorized AC observation.
 * Caller MUST authorize the user and fetch both DB rows under company RLS.
 * This helper is not an access-control boundary and never writes a score.
 */
export type AssessmentCenterReportScope = {
  companyId: string;
  recruitmentId: string;
  applicationId: string;
  definitionEntryId: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Nieprawidłowy rekord raportu AC.');
  }
  return value as Record<string, unknown>;
}
function matches(row: Record<string, unknown>, expected: Record<string, string>) {
  for (const [key, id] of Object.entries(expected)) {
    if (!id || row[key] !== id) throw new Error('Niezgodne powiązanie raportu AC.');
  }
}
const ratings = ['below', 'meets', 'above', 'insufficient_data'] as const;

export function buildAssessmentCenterReport(
  scope: AssessmentCenterReportScope,
  revisionInput: unknown,
  observationInput: unknown | null,
) {
  const revision = object(revisionInput);
  matches(revision, {
    company_id: scope.companyId,
    recruitment_id: scope.recruitmentId,
    id: scope.definitionEntryId,
  });
  if (!Number.isSafeInteger(revision.version) || (revision.version as number) < 1) {
    throw new Error('Nieprawidłowa wersja ćwiczenia AC.');
  }
  const definition = parseExerciseDefinition(revision.definition);
  if (definition.kind !== 'assessment_center') throw new Error('To nie jest ćwiczenie AC.');

  let observations: Array<{ criterionIndex: number; rating: AssessmentCenterRating; evidence: string }> = [];
  let reviewVersion: number | null = null;
  let authorId: string | null = null;
  if (observationInput !== null) {
    const row = object(observationInput);
    matches(row, {
      company_id: scope.companyId,
      recruitment_id: scope.recruitmentId,
      application_id: scope.applicationId,
      definition_entry_id: scope.definitionEntryId,
    });
    if (!Number.isSafeInteger(row.version) || (row.version as number) < 1 ||
        typeof row.author_id !== 'string' || !row.author_id ||
        !Array.isArray(row.observations) || row.observations.length !== definition.criteria.length) {
      throw new Error('Nieprawidłowa historia obserwacji AC.');
    }
    reviewVersion = row.version as number;
    authorId = row.author_id;
    observations = row.observations.map((raw, i) => {
      const item = object(raw);
      if (item.criterionIndex !== i || typeof item.rating !== 'string' ||
          !ratings.includes(item.rating as AssessmentCenterRating) ||
          typeof item.evidence !== 'string' || item.evidence.length > 10000) {
        throw new Error('Nieprawidłowe kryterium oceny AC.');
      }
      const evidence = item.evidence.trim();
      if ((item.rating === 'insufficient_data' && evidence) ||
          (item.rating !== 'insufficient_data' && !evidence)) {
        throw new Error('Niezgodny dowód obserwacji AC.');
      }
      return { criterionIndex: i, rating: item.rating as AssessmentCenterRating, evidence };
    });
  }

  const evidencedCriteria = observations.filter(x => x.rating !== 'insufficient_data').length;
  return {
    exerciseTitle: definition.title,
    definitionVersion: revision.version as number,
    definitionEntryId: scope.definitionEntryId,
    reviewVersion,
    authorId,
    totalCriteria: definition.criteria.length,
    evidencedCriteria,
    status: observationInput === null ? 'not_assessed' :
      evidencedCriteria === definition.criteria.length ? 'review_required' : 'incomplete_evidence',
    criteria: definition.criteria.map((criterion, i) => ({
      criterionIndex: i,
      competency: criterion.competency,
      rating: observations[i]?.rating ?? 'insufficient_data',
      observerNote: observations[i]?.evidence ?? '',
      // The existing SQL stores no separate context: never invent it.
      context: null as null,
      source: observations[i]?.rating !== 'insufficient_data' && observations[i] ?
        'observer_note' as const : 'missing' as const,
    })),
  } as const;
}
