'use server';
import { revalidatePath } from 'next/cache';
import { loadBehaviorContext, type BehaviorRoute } from '../../../../../lib/behavior-context';
import { parseAssessmentCenterSheetForm } from '../../../../../lib/assessment-center-pair';
import { assessmentCenterPreviewEnabled } from '../../../../../lib/assessment-center-preview';

type Route = BehaviorRoute & { definitionId: string };
export type PairedAssessorActionState = { error?: string; saved?: boolean };
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function path(route: Route) {
  return `/dashboard/${route.companyId}/recruitments/${route.recruitmentId}/applications/${route.applicationId}/exercises/${route.definitionId}`;
}

export async function assignAssessmentCenterPair(route: Route, _previous: PairedAssessorActionState, form: FormData): Promise<PairedAssessorActionState> {
  if (!assessmentCenterPreviewEnabled()) return { error: 'Arkusze są niedostępne.' };
  const { client, company, user, canEdit } = await loadBehaviorContext(route);
  if (!canEdit || company.owner_id !== user.id || !uuid.test(route.definitionId)) return { error: 'Brak dostępu do przypisania asesorów.' };
  const first = form.get('first'), second = form.get('second');
  if (typeof first !== 'string' || typeof second !== 'string' || !uuid.test(first) || !uuid.test(second) || first === second) {
    return { error: 'Wybierz dwie różne osoby z zespołu.' };
  }
  const result = await client.rpc('ac_assign_pair', { application: route.applicationId, revision: route.definitionId, first_id: first, second_id: second });
  if (result.error) return { error: result.error.code === 'PT409'
    ? 'Asesorzy zostali już przypisani. Odśwież stronę.'
    : 'Nie przypisano asesorów. Sprawdź skład zespołu i stan rekrutacji.' };
  revalidatePath(path(route));
  return { saved: true };
}

export async function submitAssessmentCenterSheet(route: Route, pairId: string, _previous: PairedAssessorActionState, form: FormData): Promise<PairedAssessorActionState> {
  if (!assessmentCenterPreviewEnabled()) return { error: 'Arkusze są niedostępne.' };
  const { client, canEdit } = await loadBehaviorContext(route);
  if (!canEdit || !uuid.test(pairId) || !uuid.test(route.definitionId)) return { error: 'Brak dostępu do oceny.' };
  const [revision, pair] = await Promise.all([
    client.from('exercise_definition_entries').select('definition').eq('company_id', route.companyId)
      .eq('recruitment_id', route.recruitmentId).eq('id', route.definitionId).maybeSingle(),
    client.rpc('ac_find_pair', { application: route.applicationId, revision: route.definitionId }),
  ]);
  if (revision.error || !revision.data || pair.error || pair.data !== pairId) return { error: 'Arkusz jest niedostępny. Odśwież stronę.' };
  let sheet;
  try { sheet = parseAssessmentCenterSheetForm(revision.data.definition, form); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Sprawdź oceny i uzasadnienia.' }; }
  const result = await client.rpc('ac_submit_sheet', { pair_id: pairId, sheet });
  if (result.error) return { error: result.error.code === 'PT409'
    ? 'Nie zmieniono arkusza. Mógł zostać już oddany albo dostęp został wstrzymany. Odśwież stronę, aby sprawdzić zapis.'
    : 'Nie potwierdzono zapisu. Sprawdź dostęp i stan rekrutacji; wpisana treść pozostaje w formularzu.' };
  revalidatePath(path(route));
  return { saved: true };
}
