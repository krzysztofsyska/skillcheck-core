import { parseExerciseDefinition } from './exercise-definition.ts';

/** Pure AC evaluation contract. Caller must authorize the observer and bind the
 * immutable exercise revision to the company, recruitment and application. */
export type AssessmentCenterRating = 'below' | 'meets' | 'above' | 'insufficient_data';
export type AssessmentCenterObservation = {
  criterionIndex: number;
  rating: AssessmentCenterRating;
  evidence: string;
  context: string;
};

export function evaluateAssessmentCenter(
  definitionInput: unknown,
  observationsInput: unknown,
) {
  const definition = parseExerciseDefinition(definitionInput);
  if (definition.kind !== 'assessment_center') throw new Error('Nieprawidłowy rodzaj ćwiczenia AC.');
  if (!Array.isArray(observationsInput) || observationsInput.length !== definition.criteria.length) {
    throw new Error('Wymagana jest obserwacja każdego kryterium.');
  }
  const observations: AssessmentCenterObservation[] = Array.from({ length: definition.criteria.length }, (_, index) => {
    if (!Object.prototype.hasOwnProperty.call(observationsInput, index)) throw new Error('Brak obserwacji.');
    const raw = observationsInput[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Nieprawidłowa obserwacja.');
    const row = raw as Record<string, unknown>;
    if (row.criterionIndex !== index || !['below', 'meets', 'above', 'insufficient_data'].includes(String(row.rating))
      || typeof row.rating !== 'string' || typeof row.evidence !== 'string'
      || typeof row.context !== 'string' || row.evidence.length > 4000 || row.context.length > 2000) {
      throw new Error('Nieprawidłowa ocena, indeks lub uzasadnienie.');
    }
    const rating = row.rating as AssessmentCenterRating;
    const evidence = row.evidence.trim();
    const context = row.context.trim();
    if (rating === 'insufficient_data') {
      if (evidence) throw new Error('Brak danych nie może mieć dowodu oceny.');
    } else if (evidence.length < 10 || context.length < 5) {
      throw new Error('Ocena wymaga konkretnej obserwacji i kontekstu.');
    }
    return { criterionIndex: index, rating, evidence, context };
  });
  const evidencedCriteria = observations.filter(row => row.rating !== 'insufficient_data').length;
  return {
    version: 'ac-observation-v1',
    exerciseTitle: definition.title,
    totalCriteria: definition.criteria.length,
    evidencedCriteria,
    status: evidencedCriteria === definition.criteria.length ? 'review_required' : 'incomplete_evidence',
    criteria: observations.map(row => ({
      competency: definition.criteria[row.criterionIndex].competency,
      ...row,
    })),
  } as const;
}
