import { evaluateAssessmentCenter, type AssessmentCenterRating } from './assessment-center-evaluation.ts';
import { parseExerciseDefinition, type ExerciseDefinition } from './exercise-definition.ts';

/**
 * SC-AC-SESSION (#276). Pure, fail-closed projection of `public.ac_session_read`.
 * The RPC is the authorization boundary; this module never authorizes, never
 * computes a score, a rank or a hiring recommendation, and never fills a gap:
 * where no evidence exists the report says "brak danych".
 */
export const AC_FINALIST_LIMIT = 10;
export const AC_RECOMMENDED_FINALISTS = [5, 6] as const;
export const AC_STAGE_LIMIT = 8;
export const AC_NO_DATA = 'brak danych';
export const acStageTypes = [['case_study', 'Studium przypadku'], ['human_simulation', 'Symulacja z człowiekiem']] as const;
export const acChangeAssessments = [
  ['change_confirmed', 'Zmiana potwierdzona dowodem'], ['change_partial', 'Zmiana częściowa'],
  ['no_change_observed', 'Nie zaobserwowano zmiany'], ['insufficient_data', 'Niewystarczające dane'],
] as const;
export type AcStageType = typeof acStageTypes[number][0];
export type AcChangeAssessment = typeof acChangeAssessments[number][0];
type EntryKind = 'first_attempt' | 'feedback' | 'revised_attempt' | 'change_proof';

/** Same exact key as SQL `private.ac_competency_key`: NFKC, trim, single spaces. No case folding. */
export function competencyKey(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Non-blocking advice. The hard limit of ten is a database constraint, not this text. */
export function finalistAdvice(count: number) {
  if (!Number.isInteger(count) || count < 0) throw new Error('Nieprawidłowa liczba finalistów.');
  const [low, high] = AC_RECOMMENDED_FINALISTS;
  if (count >= AC_FINALIST_LIMIT) return { level: 'limit', message: `Osiągnięto limit ${AC_FINALIST_LIMIT} finalistów. Kolejnej osoby nie można dodać.` } as const;
  if (count > high) return { level: 'above', message: `Zalecane jest ${low}–${high} finalistów. Przy ${count} osobach obserwacja każdej z nich będzie krótsza.` } as const;
  if (count < low) return { level: 'below', message: `Zalecane jest ${low}–${high} finalistów. Obecnie: ${count}.` } as const;
  return { level: 'recommended', message: `Liczba finalistów (${count}) mieści się w zalecanym zakresie ${low}–${high}.` } as const;
}

/** Which stage rubrics cover each planned competency. A plan with a gap cannot be opened. */
export function planCoverage(planned: readonly string[], stages: ReadonlyArray<{ title: string; definition: unknown }>) {
  const rows = planned.map(raw => {
    const competency = competencyKey(raw);
    const coveredBy = stages.filter(stage => parseExerciseDefinition(stage.definition).criteria
      .some(criterion => competencyKey(criterion.competency) === competency)).map(stage => stage.title);
    return { competency, coveredBy };
  });
  return { rows, uncovered: rows.filter(row => row.coveredBy.length === 0).map(row => row.competency) };
}

const fail = (message = 'Nieprawidłowe dane sesji Assessment Center.'): never => { throw new Error(message); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return Array.from({ length: (value as unknown[]).length }, (_, index) => {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail();
    return (value as unknown[])[index];
  });
}
const text = (value: unknown, max = 20000): string => typeof value === 'string' && value.length <= max ? value : fail();
const id = (value: unknown): string => typeof value === 'string' && value ? value : fail();
const time = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fail();
const optionalTime = (value: unknown) => value === null || value === undefined ? null : time(value);
const ratings = ['below', 'meets', 'above', 'insufficient_data'];
const rating = (value: unknown): AssessmentCenterRating => typeof value === 'string' && ratings.includes(value)
  ? value as AssessmentCenterRating : fail();

type Observation = { criterionIndex: number; rating: AssessmentCenterRating; evidence: string; context: string };
type Sheet = { authorId: string; submittedAt: string; observations: Observation[] };
export type AcReconciliationItem =
  | { criterionIndex: number; outcome: 'agreed'; rating: AssessmentCenterRating; justification: string; firstRating: AssessmentCenterRating; secondRating: AssessmentCenterRating }
  | { criterionIndex: number; outcome: 'discrepancy'; note: string; firstRating: AssessmentCenterRating; secondRating: AssessmentCenterRating };
type Reconciliation = { items: AcReconciliationItem[]; recordedBy: string; recordedAt: string;
  confirmation: 'confirmed' | 'disputed' | null; confirmedBy: string | null; confirmedAt: string | null; disputeNote: string | null };
type Pair =
  | { state: 'unassigned' } | { state: 'restricted' }
  | { state: 'pending'; pairId: string; ownSubmitted: boolean | null }
  | { state: 'ready'; pairId: string; sheets: [Sheet, Sheet]; reconciliation: Reconciliation | null };
type Entry = { kind: EntryKind; body: Record<string, string>; authorId: string; createdAt: string };

function parseReconciliation(input: unknown, sheets: [Sheet, Sheet]): Reconciliation | null {
  if (input === null || input === undefined) return null;
  const raw = object(input);
  const items = list(raw.items, 12);
  if (items.length !== sheets[0].observations.length) fail();
  const confirmation = raw.confirmation === null || raw.confirmation === undefined ? null
    : raw.confirmation === 'confirmed' || raw.confirmation === 'disputed' ? raw.confirmation : fail();
  const recordedBy = id(raw.recordedBy);
  if (!sheets.some(sheet => sheet.authorId === recordedBy)) fail();
  const confirmedBy = confirmation ? id(raw.confirmedBy) : null;
  if (confirmedBy && (confirmedBy === recordedBy || !sheets.some(sheet => sheet.authorId === confirmedBy))) fail();
  return {
    recordedBy, recordedAt: time(raw.recordedAt), confirmation, confirmedBy,
    confirmedAt: confirmation ? time(raw.confirmedAt) : null,
    disputeNote: confirmation === 'disputed' ? text(raw.disputeNote, 2000) : null,
    items: items.map((value, index): AcReconciliationItem => {
      const item = object(value);
      const firstRating = rating(item.firstRating), secondRating = rating(item.secondRating);
      // The stored copy must still equal the two immutable sheets it reconciles.
      if (item.criterionIndex !== index || firstRating !== sheets[0].observations[index].rating
        || secondRating !== sheets[1].observations[index].rating) fail();
      if (item.outcome === 'agreed') {
        const agreed = rating(item.rating);
        if (agreed !== firstRating && agreed !== secondRating) fail('Uzgodniona ocena musi być jedną z dwóch oddanych ocen.');
        return { criterionIndex: index, outcome: 'agreed', rating: agreed, justification: text(item.justification, 2000), firstRating, secondRating };
      }
      if (item.outcome !== 'discrepancy' || firstRating === secondRating) fail();
      return { criterionIndex: index, outcome: 'discrepancy', note: text(item.note, 2000), firstRating, secondRating };
    }),
  };
}

function parsePair(input: unknown, definitionId: string, definition: ExerciseDefinition): Pair {
  const raw = object(input);
  if (raw.state === 'unassigned' || raw.state === 'restricted') return { state: raw.state };
  if (raw.state === 'pending') {
    if (![true, false, null].includes(raw.ownSubmitted as boolean | null)) fail();
    return { state: 'pending', pairId: id(raw.pairId), ownSubmitted: raw.ownSubmitted as boolean | null };
  }
  if (raw.state !== 'ready' || raw.definitionId !== definitionId) fail();
  const sheets = list(raw.sheets, 2).map((value): Sheet => {
    const sheet = object(value);
    const evaluation = evaluateAssessmentCenter(definition, sheet.observations);
    return { authorId: id(sheet.authorId), submittedAt: time(sheet.submittedAt),
      observations: evaluation.criteria.map(({ criterionIndex, rating: given, evidence, context }) => ({ criterionIndex, rating: given, evidence, context })) };
  });
  if (sheets.length !== 2 || sheets[0].authorId === sheets[1].authorId) fail('Arkusze wymagają dwóch autorów.');
  const pair = sheets as [Sheet, Sheet];
  return { state: 'ready', pairId: id(raw.pairId), sheets: pair, reconciliation: parseReconciliation(raw.reconciliation, pair) };
}

const entryFields: Record<EntryKind, string[]> = {
  first_attempt: ['work'], feedback: ['feedback'], revised_attempt: ['work'], change_proof: ['changes', 'evidence', 'assessment'],
};
function parseEntries(input: unknown): Entry[] {
  const seen = new Set<string>();
  return list(input, 4).map(value => {
    const raw = object(value);
    const kind = raw.kind as EntryKind;
    if (!Object.prototype.hasOwnProperty.call(entryFields, kind) || seen.has(kind)) fail();
    seen.add(kind);
    const body = object(raw.body);
    if (Object.keys(body).length !== entryFields[kind].length) fail();
    const clean = Object.fromEntries(entryFields[kind].map(field => [field, text(body[field])]));
    if (kind === 'change_proof' && !acChangeAssessments.some(([key]) => key === clean.assessment)) fail();
    return { kind, body: clean, authorId: id(raw.authorId), createdAt: time(raw.createdAt) };
  });
}

/** Validates the whole RPC payload. Any unknown shape fails closed instead of rendering a partial report. */
export function parseAssessmentCenterSession(input: unknown) {
  const root = object(input), session = object(root.session);
  const status = session.status === 'draft' || session.status === 'open' || session.status === 'closed'
    ? session.status as 'draft' | 'open' | 'closed' : fail();
  const stages = list(root.stages, AC_STAGE_LIMIT).map((value, index) => {
    const raw = object(value);
    const type = acStageTypes.some(([key]) => key === raw.type) ? raw.type as AcStageType : fail();
    const definition = parseExerciseDefinition(raw.definition);
    if (definition.kind !== 'assessment_center' || raw.ordinal !== index + 1) fail();
    const counterpartBrief = type === 'human_simulation' ? text(raw.counterpartBrief, 2000) : null;
    return { id: id(raw.id), ordinal: index + 1, type, title: text(raw.title, 200), definitionId: id(raw.definitionId), definition, counterpartBrief };
  });
  if (new Set(stages.map(stage => stage.id)).size !== stages.length) fail();
  const finalists = list(root.finalists, AC_FINALIST_LIMIT).map(value => {
    const raw = object(value);
    if (!Number.isInteger(raw.slot) || (raw.slot as number) < 1 || (raw.slot as number) > AC_FINALIST_LIMIT) fail();
    const stageRows = list(raw.stages, AC_STAGE_LIMIT);
    if (stageRows.length !== stages.length) fail();
    return {
      applicationId: id(raw.applicationId), slot: raw.slot as number,
      expertNotes: list(raw.expertNotes, 200).map(note => {
        const item = object(note);
        return { note: text(item.note, 8000), authorId: id(item.authorId), createdAt: time(item.createdAt) };
      }),
      stages: stageRows.map((value2, index) => {
        const row = object(value2), stage = stages[index];
        if (row.stageId !== stage.id) fail();
        return { stageId: stage.id, pair: parsePair(row.pair, stage.definitionId, stage.definition), entries: parseEntries(row.entries) };
      }),
    };
  });
  if (new Set(finalists.map(finalist => finalist.applicationId)).size !== finalists.length) fail();
  const planned = list(session.plannedCompetencies, 24).map(value => competencyKey(text(value, 200)));
  return {
    session: { id: id(session.id), recruitmentId: id(session.recruitmentId), title: text(session.title, 200), status,
      plannedCompetencies: planned, createdAt: time(session.createdAt), openedAt: optionalTime(session.openedAt), closedAt: optionalTime(session.closedAt) },
    stages, finalists,
  };
}
export type AssessmentCenterSession = ReturnType<typeof parseAssessmentCenterSession>;

export type AcCriterionAgreement =
  | { status: 'not_assessed' | 'restricted' | 'awaiting_second_sheet' }
  | { status: 'not_reconciled'; ratingsDiffer: boolean }
  | { status: 'awaiting_confirmation' | 'agreed'; rating: AssessmentCenterRating; justification: string; recordedBy: string }
  | { status: 'discrepancy'; note: string; recordedBy: string; awaitingConfirmation: boolean }
  | { status: 'disputed'; disputeNote: string; recordedBy: string; disputedBy: string };

function agreement(pair: Pair, index: number): AcCriterionAgreement {
  if (pair.state === 'unassigned') return { status: 'not_assessed' };
  if (pair.state === 'restricted') return { status: 'restricted' };
  if (pair.state === 'pending') return { status: 'awaiting_second_sheet' };
  const record = pair.reconciliation;
  if (!record) return { status: 'not_reconciled', ratingsDiffer: pair.sheets[0].observations[index].rating !== pair.sheets[1].observations[index].rating };
  // A disputed record is never presented as an agreement: both ratings stay visible.
  if (record.confirmation === 'disputed') return { status: 'disputed', disputeNote: record.disputeNote ?? '', recordedBy: record.recordedBy, disputedBy: record.confirmedBy ?? '' };
  const item = record.items[index];
  if (item.outcome === 'discrepancy') return { status: 'discrepancy', note: item.note, recordedBy: record.recordedBy, awaitingConfirmation: record.confirmation === null };
  return { status: record.confirmation === 'confirmed' ? 'agreed' : 'awaiting_confirmation', rating: item.rating, justification: item.justification, recordedBy: record.recordedBy };
}

/**
 * Per finalist and per planned competency: both assessors' evidence, agreed versus
 * discrepant items, first versus revised attempt and the expert's notes. Finalists
 * keep the order in which they were added. There is no total, no rank, no verdict.
 */
export function buildAssessmentCenterSessionReport(session: AssessmentCenterSession) {
  const coverage = planCoverage(session.session.plannedCompetencies, session.stages);
  return {
    title: session.session.title, status: session.session.status,
    coverage: coverage.rows, uncovered: coverage.uncovered,
    finalistAdvice: finalistAdvice(session.finalists.length),
    stages: session.stages.map(({ id: stageId, ordinal, type, title, counterpartBrief, definition }) => ({ id: stageId, ordinal, type, title, counterpartBrief, exerciseTitle: definition.title })),
    finalists: session.finalists.map(finalist => ({
      applicationId: finalist.applicationId, slot: finalist.slot,
      competencies: session.session.plannedCompetencies.map(competency => {
        const evidence = session.stages.flatMap((stage, stageIndex) => {
          const criterionIndex = stage.definition.criteria.findIndex(criterion => competencyKey(criterion.competency) === competency);
          if (criterionIndex < 0) return [];
          const pair = finalist.stages[stageIndex].pair;
          const assessors = pair.state === 'ready' ? pair.sheets.map(sheet => {
            const item = sheet.observations[criterionIndex];
            return { authorId: sheet.authorId, rating: item.rating, evidence: item.evidence, context: item.context, hasEvidence: item.rating !== 'insufficient_data' };
          }) : [];
          return [{ stageId: stage.id, stageTitle: stage.title, criterionIndex, assessors, agreement: agreement(pair, criterionIndex) }];
        });
        return { competency, evidence, hasEvidence: evidence.some(row => row.assessors.some(item => item.hasEvidence)) };
      }),
      attempts: session.stages.map((stage, stageIndex) => {
        const entries = finalist.stages[stageIndex].entries;
        const find = (kind: EntryKind) => entries.find(entry => entry.kind === kind) ?? null;
        const first = find('first_attempt'), feedback = find('feedback'), revised = find('revised_attempt'), proof = find('change_proof');
        return {
          stageId: stage.id, stageTitle: stage.title,
          firstAttempt: first && { work: first.body.work, authorId: first.authorId, createdAt: first.createdAt },
          feedback: feedback && { feedback: feedback.body.feedback, authorId: feedback.authorId, createdAt: feedback.createdAt },
          revisedAttempt: revised && { work: revised.body.work, authorId: revised.authorId, createdAt: revised.createdAt },
          changeProof: proof && { changes: proof.body.changes, evidence: proof.body.evidence,
            assessment: proof.body.assessment as AcChangeAssessment, authorId: proof.authorId, createdAt: proof.createdAt },
        };
      }),
      expertNotes: finalist.expertNotes,
    })),
  } as const;
}
export type AssessmentCenterSessionReport = ReturnType<typeof buildAssessmentCenterSessionReport>;

/** Reconciliation form: one decision per criterion, in rubric order. SQL validates again. */
export function parseReconciliationForm(criteriaCount: number, form: FormData) {
  const outcomes = form.getAll('outcome'), ratingValues = form.getAll('rating'), notes = form.getAll('note');
  if (![outcomes, ratingValues, notes].every(column => column.length === criteriaCount && column.every(value => typeof value === 'string'))) {
    throw new Error('Uzupełnij każde kryterium.');
  }
  return Array.from({ length: criteriaCount }, (_, index) => {
    const note = (notes[index] as string).trim();
    if (note.length < 10 || note.length > 2000) throw new Error('Każde kryterium wymaga uzasadnienia (co najmniej 10 znaków).');
    if (outcomes[index] === 'discrepancy') return { criterionIndex: index, outcome: 'discrepancy' as const, note };
    if (outcomes[index] !== 'agreed' || !ratings.includes(ratingValues[index] as string)) throw new Error('Wybierz uzgodnioną ocenę albo zapisz rozbieżność.');
    return { criterionIndex: index, outcome: 'agreed' as const, rating: ratingValues[index] as AssessmentCenterRating, justification: note };
  });
}
