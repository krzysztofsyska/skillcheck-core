import type { ExerciseDefinition } from './exercise-definition.ts';
import {
  ExerciseAiError, exerciseDraftPayload, exerciseDraftProvenance, sanitizeExerciseAiError,
  buildExerciseDraftRequest, EXERCISE_AI_MAX_REQUEST_BYTES,
  type ExerciseDraftInput, type ExerciseDraftProvenance, type ExerciseAiErrorCode,
} from './exercise-ai.ts';

export type ExerciseGenerationResult = { error?: string; exerciseId?: string; terminalFailure?: boolean };
export type GenerationReservation = {
  claimed?: boolean; status: 'reserved' | 'completed' | 'failed';
  exercise_id?: string; error?: ExerciseAiErrorCode;
};
type Dependencies = {
  reserve: (fingerprint: string) => Promise<GenerationReservation>;
  finish: (fingerprint: string, definition: ExerciseDefinition | null, provenance: ExerciseDraftProvenance | null,
    error: ExerciseAiErrorCode | null) => Promise<GenerationReservation>;
  provide: (payload: ReturnType<typeof exerciseDraftPayload>) => Promise<{ definition: ExerciseDefinition }>;
};
const result = (item: GenerationReservation): ExerciseGenerationResult => item.status === 'completed' && item.exercise_id
  ? { exerciseId: item.exercise_id } : { ...(item.status === 'failed' ? {terminalFailure:true} : {}), error: item.status === 'failed'
    ? sanitizeExerciseAiError(item.error ?? 'exercise_ai_server_error')
    : 'To żądanie już trwa. Odśwież stronę później. Nie wysyłamy go ponownie do modelu.' };

/** Commit reservation before provider I/O, persist outcome before reporting success. */
export async function generateExerciseDraft(input: ExerciseDraftInput, position: {id:string;updated_at:string}, deps: Dependencies): Promise<ExerciseGenerationResult> {
  try {
    const payload = exerciseDraftPayload(input);
    // Envelope escaping may expand profile JSON further; check the actual wire
    // body before committing a reservation, as well as at the provider boundary.
    if (Buffer.byteLength(JSON.stringify(buildExerciseDraftRequest(payload)), 'utf8') > EXERCISE_AI_MAX_REQUEST_BYTES)
      throw new ExerciseAiError('exercise_ai_input_too_large', 'Provider request exceeds byte limit.');
    const provenance = exerciseDraftProvenance(payload, position);
    const reservation = await deps.reserve(provenance.input_fingerprint);
    if (!reservation.claimed) return result(reservation);
    let definition: ExerciseDefinition;
    try { ({definition} = await deps.provide(payload)); }
    catch (error) {
      const code = error instanceof ExerciseAiError ? error.code : 'exercise_ai_server_error';
      return result(await deps.finish(provenance.input_fingerprint, null, null, code));
    }
    // A completion transport failure does not invoke the provider again. The same
    // request key may recover a committed result; otherwise the slot stays spent.
    return result(await deps.finish(provenance.input_fingerprint, definition, provenance, null));
  } catch (error) {
    return {error: error instanceof ExerciseAiError ? sanitizeExerciseAiError(error.code)
      : 'Nie udało się potwierdzić zapisu propozycji. Spróbuj ponownie tym samym przyciskiem — nie ponowimy wywołania modelu.'};
  }
}
