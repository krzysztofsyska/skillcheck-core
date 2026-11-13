'use server';
import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { followupForm, observationForm, followupError, validId } from '../../../../../../../../lib/process-followup';
import type { Json } from '../../../../../../../../lib/supabase/database.types';
export type FollowupFormState = { error?: string; saved?: boolean };
export async function saveFollowup(companyId: string, recruitmentId: string, applicationId: string, _state: FollowupFormState, form: FormData): Promise<FollowupFormState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit || ![recruitmentId,applicationId].every(validId)) return { error: 'Brak uprawnienia lub nieprawidłowe zgłoszenie.' };
  const application = await client.from('applications').select('id').eq('company_id',companyId).eq('recruitment_id',recruitmentId).eq('id',applicationId).maybeSingle();
  if (application.error || !application.data) return { error: 'Zgłoszenie jest niedostępne.' };
  let result;
  try {
    const operation = form.get('operation');
    if (operation === 'create') result = await client.rpc('process_followup_create', { target_application: applicationId, ...followupForm(form) });
    else {
      const target_case = form.get('case_id');
      if (!validId(target_case)) return { error: 'Nieprawidłowy cel obserwacji.' };
      // Bind this case to the application shown in this route before any mutation.
      const { data, error } = await client.rpc('process_followup_read', { target_application: applicationId });
      const cases = (data as { cases?: { id: string }[] } | null)?.cases;
      if (error || !Array.isArray(cases) || !cases.some(c => c.id === target_case)) return { error: 'Cel oceny jest niedostępny.' };
      if (operation === 'record') {
        const parsed = observationForm(form);
        result = await client.rpc('process_followup_record', { target_case, checkpoint: parsed.checkpoint, observation: parsed.observation as unknown as Json });
      } else if (operation === 'grant') {
        const target_user = form.get('target_user');
        if (!validId(target_user) || !['true','false'].includes(String(form.get('allowed')))) return { error: 'Wybierz osobę i rodzaj zmiany dostępu.' };
        result = await client.rpc('process_followup_grant', { target_case, target_user, allowed: form.get('allowed') === 'true' });
      } else return { error: 'Nieprawidłowa operacja.' };
    }
  } catch (e) { return { error: e instanceof Error ? e.message : 'Sprawdź formularz.' }; }
  if (result.error) return { error: followupError(result.error) };
  revalidatePath(`/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applicationId}/followup`);
  return { saved: true };
}
