'use server';
import { revalidatePath } from 'next/cache';
import { exerciseContext } from '../../../../../lib/exercise-context';
import { exerciseAiAutoReleaseError } from '../../../../../lib/exercise-ai-review';
import type { ExerciseAiAutoReleaseState } from '../../../../../lib/exercise-ai-review';

// R1-SWITCH: rekruter wybiera dla całej rekrutacji, czy sam zatwierdza zadania przygotowane
// przez AI, czy są zatwierdzane automatycznie. Uprawnienia, powiązanie firmy z rekrutacją
// i zamknięcie rekrutacji sprawdza baza (public.set_exercise_ai_auto_release); tu tylko
// odrzucamy wcześniej to, czego nie warto wysyłać. Ta akcja niczego nie wysyła kandydatom.
export async function setExerciseAiAutoRelease(companyId: string, recruitmentId: string,
  _previous: ExerciseAiAutoReleaseState, form: FormData): Promise<ExerciseAiAutoReleaseState> {
  if (process.env.EXERCISE_AI_ENABLED !== 'true') return { error: 'Propozycje AI są wyłączone.' };
  const modes = form.getAll('mode');
  if (modes.length !== 1 || (modes[0] !== 'manual' && modes[0] !== 'auto')) return { error: 'Wybierz jeden tryb zatwierdzania.' };
  const { client, canEdit, editable } = await exerciseContext(companyId, recruitmentId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  if (!editable) return { error: exerciseAiAutoReleaseError('55000') };
  const enabled = modes[0] === 'auto';
  const result = await client.rpc('set_exercise_ai_auto_release', {
    target_company: companyId, target_recruitment: recruitmentId, enabled,
  });
  if (result.error || result.data !== enabled) return { error: exerciseAiAutoReleaseError(result.error?.code) };
  revalidatePath(`/dashboard/${companyId}/recruitments/${recruitmentId}`, 'layout');
  return { autoRelease: enabled };
}
