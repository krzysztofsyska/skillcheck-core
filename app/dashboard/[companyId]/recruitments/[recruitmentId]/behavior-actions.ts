'use server';
import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../lib/company-access';
import { behaviorAreas } from '../../../../../lib/position-fields';
import type { EditorState } from '../../../../../lib/position-fields';
import { parseBehaviorAssessment, behaviorSaveError } from '../../../../../lib/behavior-assessment';

export async function saveBehaviorAssessment(companyId: string, recruitmentId: string, applicationId: string,
  areaKey: string, expectedVersion: number, positionId: string, positionUpdatedAt: string,
  _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  if (!behaviorAreas.some(([key]) => key === areaKey) || !Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2147483647
    || ![applicationId, recruitmentId, positionId].every(id => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    || typeof positionUpdatedAt !== 'string' || !Number.isFinite(Date.parse(positionUpdatedAt))) return { error: 'Odśwież stronę, aby wczytać bieżące dane.' };
  let values;
  try { values = parseBehaviorAssessment(form); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Sprawdź ocenę.' }; }
  const application = await client.from('applications').select('id').eq('company_id', companyId)
    .eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle();
  if (application.error || !application.data) return { error: 'Nie znaleziono zgłoszenia w tej rekrutacji.' };
  // The RPC repeats authorization and locks parents, checks versions and derives
  // author, requirement and full snapshot from the database in one transaction.
  const result = await client.rpc('save_behavior_assessment', { target_application: applicationId, target_area: areaKey,
    new_rating: values.rating, new_evidence: values.evidence, expected_version: expectedVersion,
    expected_position_id: positionId, expected_position_updated_at: positionUpdatedAt });
  if (result.error) return { error: behaviorSaveError(result.error.code) };
  revalidatePath(`/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applicationId}/behaviors`, 'layout');
  return { saved: true };
}
