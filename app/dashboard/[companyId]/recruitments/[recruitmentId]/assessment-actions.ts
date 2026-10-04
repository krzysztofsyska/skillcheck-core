'use server';
import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../lib/company-access';
import { parseAssessmentStage, parseAssessmentProgress } from '../../../../../lib/assessment-fields';
import type { EditorState } from '../../../../../lib/position-fields';

const path = (companyId: string, recruitmentId: string) => `/dashboard/${companyId}/recruitments/${recruitmentId}`;
const conflict = 'Dane zmieniły się w innym oknie. Skopiuj notatkę, odśwież stronę i porównaj wersje.';

export async function addAssessmentStage(companyId: string, recruitmentId: string, _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  const recruitment = await client.from('recruitments').select('id').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error || !recruitment.data) return { error: 'Nie znaleziono rekrutacji w tej firmie.' };
  let values;
  try { values = parseAssessmentStage(form); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Sprawdź dane etapu.' }; }
  const result = await client.from('assessment_stages').insert({ company_id: companyId, recruitment_id: recruitmentId, ...values });
  if (result.error) return { error: result.error.code === '23505' ? 'Ten numer kolejności jest już zajęty. Wybierz inny numer lub odśwież listę.' : 'Nie udało się dodać etapu. Dane pozostały w formularzu.' };
  revalidatePath(path(companyId, recruitmentId), 'layout');
  return { saved: true };
}

export async function saveAssessmentProgress(companyId: string, recruitmentId: string, applicationId: string, stageId: string,
  expectedUpdatedAt: string | null, _state: EditorState, form: FormData): Promise<EditorState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  let values;
  try { values = parseAssessmentProgress(form); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Sprawdź dane oceny.' }; }
  const [application, stage] = await Promise.all([
    client.from('applications').select('id').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle(),
    client.from('assessment_stages').select('id').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', stageId).maybeSingle(),
  ]);
  if (application.error || stage.error || !application.data || !stage.data) return { error: 'Nie znaleziono zgłoszenia lub etapu w tej rekrutacji.' };
  const existing = await client.from('candidate_assessments').select('id,updated_at,status,completed_at')
    .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId).eq('stage_id', stageId).maybeSingle();
  if (existing.error) return { error: 'Nie udało się wczytać postępu etapu.' };
  if ((existing.data?.updated_at ?? null) !== expectedUpdatedAt) return { error: conflict };
  // Completion belongs to a human-entered stage record, never a hiring decision.
  const completed_at = values.status === 'completed' ? (existing.data?.completed_at ?? new Date().toISOString()) : null;
  if (existing.data) {
    const result = await client.from('candidate_assessments').update({ ...values, completed_at })
      .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId).eq('stage_id', stageId)
      .eq('id', existing.data.id).eq('updated_at', expectedUpdatedAt!).select('id').maybeSingle();
    if (result.error) return { error: 'Nie udało się zapisać postępu. Notatka pozostała w formularzu.' };
    if (!result.data) return { error: conflict };
  } else {
    const result = await client.from('candidate_assessments').insert({ company_id: companyId, recruitment_id: recruitmentId, application_id: applicationId, stage_id: stageId, ...values, completed_at });
    if (result.error) return { error: result.error.code === '23505' ? conflict : 'Nie udało się zapisać postępu. Notatka pozostała w formularzu.' };
  }
  revalidatePath(path(companyId, recruitmentId) + `/applications/${applicationId}/assessments`);
  return { saved: true };
}
