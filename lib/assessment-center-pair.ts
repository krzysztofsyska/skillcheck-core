import { evaluateAssessmentCenter } from './assessment-center-evaluation.ts';
import { parseExerciseDefinition } from './exercise-definition.ts';

/** The RPC remains the authorization boundary. This parser binds its response to
 * the immutable revision already loaded for this application. */
export function parseAssessmentCenterPair(definitionId: string, definitionInput: unknown, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Nieprawidłowy raport.');
  const report = input as Record<string, unknown>;
  if (report.state === 'pending' && [true, false, null].includes(report.ownSubmitted as boolean | null)) {
    return { state: 'pending', ownSubmitted: report.ownSubmitted as boolean | null } as const;
  }
  if (report.state !== 'ready' || report.definitionId !== definitionId || !Array.isArray(report.sheets)
    || report.sheets.length !== 2) throw new Error('Nieprawidłowy raport.');
  const sheets = Array.from(report.sheets, raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Brak arkusza.');
    const sheet = raw as Record<string, unknown>;
    if (typeof sheet.authorId !== 'string' || !sheet.authorId
      || typeof sheet.submittedAt !== 'string' || !Number.isFinite(Date.parse(sheet.submittedAt))) {
      throw new Error('Brak autora lub daty oceny.');
    }
    return { authorId: sheet.authorId, submittedAt: sheet.submittedAt,
      evaluation: evaluateAssessmentCenter(definitionInput, sheet.observations) };
  });
  if (sheets[0].authorId === sheets[1].authorId) throw new Error('Arkusze wymagają dwóch autorów.');
  return { state: 'ready', definitionId, sheets } as const;
}

export function parseAssessmentCenterSheetForm(definitionInput: unknown, form: FormData) {
  const definition = parseExerciseDefinition(definitionInput);
  const fields = ['rating', 'evidence', 'context'] as const;
  const values = Object.fromEntries(fields.map(field => [field, form.getAll(field)]));
  if (fields.some(field => values[field].length !== definition.criteria.length
    || values[field].some(value => typeof value !== 'string'))) throw new Error('Uzupełnij każde kryterium.');
  const evaluated = evaluateAssessmentCenter(definition, definition.criteria.map((_, index) => ({
    criterionIndex: index, rating: values.rating[index], evidence: values.evidence[index], context: values.context[index],
  })));
  return evaluated.criteria.map(({ criterionIndex, rating, evidence, context }) => ({ criterionIndex, rating, evidence, context }));
}
