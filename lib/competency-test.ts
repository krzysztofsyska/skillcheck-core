import { parseExerciseDefinition } from './exercise-definition.ts';
import type { ExerciseDefinition } from './exercise-definition.ts';

/** Pure SC-014 domain contract. The caller MUST authenticate and authorize the
 * candidate for the specific company/application/revision before invoking it. */
export const COMPETENCY_TEST_POLICY = Object.freeze({
  version: 'competency-test-rubric-v1',
  minimumCoverage: 0.6,
  points: Object.freeze({ below: 0, meets: 50, above: 100 }),
});

export type CompetencyRating = 'below' | 'meets' | 'above' | 'insufficient_data';
export type CompetencyObservation = {
  criterionIndex: number;
  rating: CompetencyRating;
  evidence: string;
};
export type CompetencyTestSubmission = { workSample: string };
export type CompetencyTestRevision = {
  id: string;
  version: number;
  definition: unknown;
};

const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Unicode regex constructors preserve compatibility with the project's ES5
// TypeScript target. Count actual textual/pictographic code points, not UTF-16
// length or whitespace/invisible padding.
const visibleSymbol = new RegExp(String.raw`[\p{L}\p{N}\p{Extended_Pictographic}]`, 'u');
const defaultIgnorable = new RegExp(String.raw`[\p{Default_Ignorable_Code_Point}]`, 'u');
const pictograph = new RegExp(String.raw`[\p{Extended_Pictographic}]`, 'u');
const letter = new RegExp(String.raw`[\p{L}]`, 'u');
const control = new RegExp(String.raw`[\p{Cc}\p{Cs}]`, 'u');

/** Returns -1 for forbidden invisible/control characters.
 * Permits contextually meaningful emoji joiners, emoji variation selectors
 * and mid-word soft hyphens without counting them as visible evidence. */
function visibleContentCount(value: string): number {
  const chars = Array.from(value);
  let visible = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '\n' || char === '\r' || char === '\t') continue;
    if (control.test(char)) return -1;
    if (defaultIgnorable.test(char)) {
      const previous = chars[index - 1] ?? '';
      const next = chars[index + 1] ?? '';
      const emojiVariation = (char === '\uFE0E' || char === '\uFE0F') && pictograph.test(previous);
      const emojiJoiner = char === '\u200D' && pictograph.test(previous) && pictograph.test(next);
      const softHyphen = char === '\u00AD' && letter.test(previous) && letter.test(next);
      if (!emojiVariation && !emojiJoiner && !softHyphen) return -1;
      continue;
    }
    // U+2800 looks blank but is classified as a symbol, not White_Space.
    if (char === '\u2800') continue;
    if (visibleSymbol.test(char)) visible += 1;
  }
  return visible;
}

function validatedTest(input: unknown): ExerciseDefinition {
  const definition = parseExerciseDefinition(input);
  if (definition.kind !== 'competency_test') {
    throw new Error('Ta wersja zadania nie jest testem kompetencji.');
  }
  return definition;
}

/** A public-facing DTO: rubric anchors and evaluator metadata are never sent
 * to a candidate. Supplied revision comes from an authorized server query. */
export function candidateTestView(revision: CompetencyTestRevision) {
  if (!revision || typeof revision.id !== 'string' || !uuidPattern.test(revision.id)
    || !Number.isSafeInteger(revision.version) || revision.version < 1) {
    throw new Error('Nieprawidłowa wersja testu kompetencji.');
  }
  const definition = validatedTest(revision.definition);
  return {
    revisionId: revision.id,
    version: revision.version,
    title: definition.title,
    instructions: definition.instructions,
    expectedOutput: definition.expectedOutput,
    durationMinutes: definition.durationMinutes,
  };
}

/** Only an answer, not company, actor, rubric, score, dates or time from the
 * browser, is accepted. Persistence must pin the authorized revision ID. */
export function parseCompetencyTestSubmission(definitionInput: unknown, input: unknown): CompetencyTestSubmission {
  validatedTest(definitionInput);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Nieprawidłowa odpowiedź na test.');
  }
  const workSample = (input as Record<string, unknown>).workSample;
  if (typeof workSample !== 'string' || workSample.length > 20_000 || visibleContentCount(workSample) < 1 || !workSample.trim()) {
    throw new Error('Odpowiedź powinna zawierać od 1 do 20 000 znaków.');
  }
  return { workSample: workSample.trim() };
}

/** Explicit, human-supplied rubric ratings. Every assessed rating must cite
 * an exact quote from the immutable answer. No LLM and no hiring decision. */
export function evaluateCompetencyTest(
  definitionInput: unknown,
  submissionInput: unknown,
  observationsInput: unknown,
) {
  const definition = validatedTest(definitionInput);
  const submission = parseCompetencyTestSubmission(definition, submissionInput);
  if (!Array.isArray(observationsInput) || observationsInput.length !== definition.criteria.length) {
    throw new Error('Ocena wymaga po jednej obserwacji na każde kryterium rubryki.');
  }
  // Array.from visits sparse slots; Array.prototype.map silently skips them.
  const observations: CompetencyObservation[] = Array.from(
    { length: definition.criteria.length },
    (_, index) => {
    if (!Object.prototype.hasOwnProperty.call(observationsInput, index)) {
      throw new Error('Brak obserwacji dla kryterium rubryki.');
    }
    const raw = observationsInput[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Nieprawidłowa obserwacja kryterium.');
    }
    const row = raw as Record<string, unknown>;
    if (row.criterionIndex !== index ||
      typeof row.rating !== 'string' || !['below', 'meets', 'above', 'insufficient_data'].includes(row.rating) ||
      typeof row.evidence !== 'string' || row.evidence.length > 10_000) {
      throw new Error('Nieprawidłowy indeks, poziom lub dowód oceny.');
    }
    const rating = row.rating as CompetencyRating;
    const evidence = row.evidence.trim();
    if (rating === 'insufficient_data') {
      if (evidence) throw new Error('Brak wystarczających danych nie może zawierać cytatu oceny.');
    } else if (visibleContentCount(evidence) < 3 || !submission.workSample.includes(evidence)) {
      throw new Error('Ocena wymaga dokładnego cytatu z odpowiedzi kandydata.');
    }
    return { criterionIndex: index, rating, evidence };
  });
  const known = observations.filter(item => item.rating !== 'insufficient_data');
  const coverage = known.length / definition.criteria.length;
  const rawScore = known.length
    ? known.reduce((sum, item) => sum + COMPETENCY_TEST_POLICY.points[item.rating as keyof typeof COMPETENCY_TEST_POLICY.points], 0) / known.length
    : null;
  return {
    policyVersion: COMPETENCY_TEST_POLICY.version,
    criterionResults: observations.map((item) => ({ ...item, competency: definition.criteria[item.criterionIndex].competency })),
    totalCriteria: definition.criteria.length,
    evidencedCriteria: known.length,
    coverage: Math.round(coverage * 10_000) / 10_000,
    score: coverage >= COMPETENCY_TEST_POLICY.minimumCoverage && rawScore !== null
      ? Math.round(rawScore * 100) / 100 : null,
    status: coverage >= COMPETENCY_TEST_POLICY.minimumCoverage ? 'review_required' : 'insufficient_evidence',
  } as const;
}
