import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../../../lib/supabase/database.types';
import { ExerciseAiAutoReleaseSwitch } from './exercise-ai-auto-release';

type Props = { client: SupabaseClient<Database>; companyId: string; recruitmentId: string; canEdit: boolean; editable: boolean };

/** R1-SWITCH: tylko właściciel/rekruter i tylko przy włączonych propozycjach AI (EXERCISE_AI_ENABLED). */
export async function ExerciseAiAutoReleaseSection({ client, companyId, recruitmentId, canEdit, editable }: Props) {
  if (process.env.EXERCISE_AI_ENABLED !== 'true' || !canEdit) return null;
  const read = await client.rpc('read_exercise_ai_settings', { target_company: companyId, target_recruitment: recruitmentId });
  const current = read.error || typeof read.data !== 'boolean' ? null : read.data;
  return <ExerciseAiAutoReleaseSwitch companyId={companyId} recruitmentId={recruitmentId} current={current} editable={editable}/>;
}
