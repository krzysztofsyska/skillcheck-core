'use server';

import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../lib/company-access';
import { parseHumanDecision, parseInterviewNote, parseStageDirection } from '../../../../../lib/interview-decision';
import { step4Client } from '../../../../../lib/step4-database';
import type { EditorState } from '../../../../../lib/position-fields';

const route = (company: string, recruitment: string) => `/dashboard/${company}/recruitments/${recruitment}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Sprawdź formularz.';

async function editor(companyId: string, recruitmentId: string) {
  const access = await companyAccess(companyId);
  if (!access.canEdit) throw new Error('Masz dostęp tylko do odczytu.');
  const { data, error } = await access.client.from('recruitments').select('id')
    .eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (error || !data) throw new Error('Nie znaleziono rekrutacji w tej firmie.');
  return access.client;
}

export async function renameRecruitmentStage(companyId: string, recruitmentId: string, stageId: string,
  _state: EditorState, form: FormData): Promise<EditorState> {
  try {
    const name = form.get('name');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) throw new Error('Podaj nazwę etapu do 200 znaków.');
    const client = step4Client(await editor(companyId, recruitmentId));
    const { data, error } = await client.from('assessment_stages').update({ name: name.trim() })
      .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', stageId).select('id').maybeSingle();
    if (error || !data) throw new Error('Nie udało się zmienić nazwy etapu.');
    revalidatePath(route(companyId, recruitmentId));
    return { saved: true };
  } catch (error) { return { error: errorMessage(error) }; }
}

export async function reorderRecruitmentStage(companyId: string, recruitmentId: string, stageId: string,
  direction: -1 | 1, _state: EditorState, _form: FormData): Promise<EditorState> {
  try {
    const client = step4Client(await editor(companyId, recruitmentId));
    const { error } = await client.rpc('move_assessment_stage', {
      target_company: companyId, target_recruitment: recruitmentId, target_stage: stageId,
      move_direction: parseStageDirection(direction),
    });
    if (error) throw new Error('Nie udało się zmienić kolejności etapu.');
    revalidatePath(route(companyId, recruitmentId));
    return { saved: true };
  } catch (error) { return { error: errorMessage(error) }; }
}

export async function removeUnusedRecruitmentStage(companyId: string, recruitmentId: string, stageId: string,
  _state: EditorState, _form: FormData): Promise<EditorState> {
  try {
    const client = step4Client(await editor(companyId, recruitmentId));
    const { count, error: usageError } = await client.from('candidate_assessments')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('stage_id', stageId);
    if (usageError) throw new Error('Nie udało się sprawdzić historii etapu.');
    if (count) throw new Error('Nie można usunąć etapu używanego w ocenach.');
    // DB FKs also protect past stage events and current application-stage assignments.
    const { data, error } = await client.from('assessment_stages').delete()
      .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', stageId).select('id').maybeSingle();
    if (error || !data) throw new Error('Etap jest używany lub nie istnieje. Nie został usunięty.');
    revalidatePath(route(companyId, recruitmentId));
    return { saved: true };
  } catch (error) { return { error: errorMessage(error) }; }
}

export async function moveCandidateStage(companyId: string, recruitmentId: string, applicationId: string,
  _state: EditorState, form: FormData): Promise<EditorState> {
  try {
    const stage = form.get('stageId');
    if (typeof stage !== 'string') throw new Error('Wybierz etap.');
    const client = step4Client(await editor(companyId, recruitmentId));
    const { error } = await client.rpc('move_application_stage', {
      target_company: companyId, target_recruitment: recruitmentId,
      target_application: applicationId, target_stage: stage || null,
    });
    if (error) throw new Error('Przesunięcie kandydata nie powiodło się.');
    revalidatePath(route(companyId, recruitmentId) + `/applications/${applicationId}/assessments`);
    return { saved: true };
  } catch (error) { return { error: errorMessage(error) }; }
}

export async function saveHumanDecision(companyId: string, recruitmentId: string, applicationId: string,
  _state: EditorState, form: FormData): Promise<EditorState> {
  try {
    // Never invoked by AI, automatic transitions, the page loader or a default.
    // Only the explicit, user-submitted decision form calls this server action.
    const { decision, reason } = parseHumanDecision(form.get('decision'), form.get('reason'));
    const client = step4Client(await editor(companyId, recruitmentId));
    const { error } = await client.rpc('set_application_human_decision', {
      target_company: companyId, target_recruitment: recruitmentId,
      target_application: applicationId, requested_decision: decision, justification: reason,
    });
    if (error) throw new Error('Nie zapisano decyzji. Sprawdź dane i uprawnienia.');
    revalidatePath(route(companyId, recruitmentId) + `/applications/${applicationId}/assessments`);
    return { saved: true };
  } catch (error) { return { error: errorMessage(error) }; }
}

export type NoteSaveResult = { saved?: boolean; updatedAt?: string; error?: string };
export async function autosaveInterviewNote(companyId: string, recruitmentId: string, applicationId: string,
  stageId: string, text: string, expectedUpdatedAt: string | null): Promise<NoteSaveResult> {
  try {
    const notes = parseInterviewNote(text);
    const client = step4Client(await editor(companyId, recruitmentId));
    const [application, stage] = await Promise.all([
      client.from('applications').select('id').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle(),
      client.from('assessment_stages').select('id').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', stageId).maybeSingle(),
    ]);
    if (application.error || stage.error || !application.data || !stage.data) throw new Error('Nie znaleziono etapu ani zgłoszenia.');
    const current = await client.from('candidate_assessments').select('id,updated_at,status')
      .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId).eq('stage_id', stageId).maybeSingle();
    if (current.error) throw new Error('Nie można sprawdzić wersji notatki.');
    if ((current.data?.updated_at ?? null) !== expectedUpdatedAt)
      throw new Error('Notatka zmieniła się w innym oknie. Odśwież przed nadpisaniem.');
    // Same rule as the status form: a completed or skipped stage keeps its note.
    if (!notes && current.data && ['completed', 'skipped'].includes(current.data.status))
      throw new Error('Zakończony lub pominięty etap wymaga notatki. Wpisz obserwacje albo powód pominięcia.');
    const write = current.data
      ? await client.from('candidate_assessments').update({ notes }).eq('company_id', companyId).eq('recruitment_id', recruitmentId)
          .eq('application_id', applicationId).eq('stage_id', stageId).eq('id', current.data.id)
          .eq('updated_at', expectedUpdatedAt!).select('updated_at').maybeSingle()
      : await client.from('candidate_assessments').insert({
          company_id: companyId, recruitment_id: recruitmentId, application_id: applicationId, stage_id: stageId, notes,
        }).select('updated_at').maybeSingle();
    if (write.error || !write.data) throw new Error('Nie zapisano notatki; odśwież i sprawdź konflikt.');
    revalidatePath(route(companyId, recruitmentId) + `/applications/${applicationId}/assessments`);
    return { saved: true, updatedAt: write.data.updated_at };
  } catch (error) { return { error: errorMessage(error) }; }
}
