'use server';
import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../lib/company-access';
import { parseExerciseFormData } from '../../../../../lib/exercise-definition';
import { validExerciseEditorContext, exerciseSaveError } from '../../../../../lib/exercise-editor';
import type { ExerciseEditorContext } from '../../../../../lib/exercise-editor';

export async function saveExerciseDefinition(companyId: string, context: ExerciseEditorContext,
  _previous: { error?: string; entryId?: string }, form: FormData): Promise<{ error?: string; entryId?: string }> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  if (!context || !validExerciseEditorContext(context)) return { error: 'Odśwież stronę, aby wczytać bieżące dane zadania.' };
  let definition;
  try { definition = parseExerciseFormData(form); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Sprawdź pola zadania.' }; }
  // Reject a foreign recruitment even when the caller belongs to both companies.
  const recruitment = await client.from('recruitments').select('id').eq('company_id', companyId)
    .eq('id', context.recruitmentId).maybeSingle();
  if (recruitment.error) return { error: 'Nie udało się sprawdzić rekrutacji. Dane pozostają w formularzu.' };
  if (!recruitment.data) return { error: 'Nie znaleziono rekrutacji w tej firmie.' };
  // SQL independently checks membership, workflow, rubric, stable ID and both versions.
  const result = await client.rpc('save_exercise_definition', {
    target_recruitment: context.recruitmentId, target_exercise: context.exerciseId,
    new_definition: definition, expected_version: context.expectedVersion,
    expected_position_id: context.positionId, expected_position_updated_at: context.positionUpdatedAt,
  });
  if (result.error) return { error: exerciseSaveError(result.error.code) };
  if (!result.data) return { error: exerciseSaveError() };
  revalidatePath(`/dashboard/${companyId}/recruitments/${context.recruitmentId}/exercises`, 'layout');
  return { entryId: result.data };
}
