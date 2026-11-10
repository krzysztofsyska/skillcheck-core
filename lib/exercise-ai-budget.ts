// SC-021-C: budget gate of one exercise generation, run by the server action on the AI gateway
// path BEFORE the generation slot is reserved, so a refused budget never uses up a draft slot.
import { parseBudgetDecision } from './ai-gateway/budget.ts';
import { sanitizeExerciseAiError, type ExerciseAiErrorCode } from './exercise-ai.ts';
import type { ExerciseBudgetClient } from './ai-ledger-writer.ts';

/**
 * Reserves the generation's budget, runs `generate`, then frees what it did not use (only when
 * this call created the reservation). The database also refuses the release while the generation
 * of this key is still 'reserved', so a concurrent duplicate that lost the draft slot never frees
 * the hold of the call that won it. Refusals return a Polish message instead.
 */
export async function withExerciseBudget<T extends { error?: string }>(budget: ExerciseBudgetClient, requestKey: string,
  generate: () => Promise<T>): Promise<T | { error: string }> {
  let created = false;
  try {
    const decision = parseBudgetDecision(await budget.reserve(requestKey));
    if (!decision.allowed) {
      const code: ExerciseAiErrorCode = decision.code === 'budget_exceeded' ? 'exercise_ai_budget_exceeded' : 'exercise_ai_budget_unavailable';
      return { error: sanitizeExerciseAiError(code) };
    }
    created = decision.created;
  } catch {
    return { error: sanitizeExerciseAiError('exercise_ai_budget_unavailable') };
  }
  try {
    return await generate();
  } finally {
    // A failed release only keeps the remainder held until the reservation expires (5 minutes).
    if (created) await budget.release(requestKey).catch(() => {});
  }
}
