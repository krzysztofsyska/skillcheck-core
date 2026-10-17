'use server';

import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { loadScreeningContext, runScreeningCommand } from '../../../../../../../../lib/screening-flow';
import { dispatchScreeningWorker, screeningAiUserEnabled } from '../../../../../../../../lib/screening-dispatch';
import { isUuid, readScreeningReview, screeningPath, type ScreeningFormState, type ScreeningRoute } from '../../../../../../../../lib/screening-ui';

export async function startAnalysis(route: ScreeningRoute, _state: ScreeningFormState, form: FormData): Promise<ScreeningFormState> {
  const { client, canEdit } = await companyAccess(route.companyId);
  try {
    const state = await runScreeningCommand({ client, canEdit, route, enabled: screeningAiUserEnabled(), command: 'start', idempotencyKey: String(form.get('requestId') ?? ''), dispatch: dispatchScreeningWorker });
    revalidatePath(screeningPath(route));
    return state;
  } catch (error) { return { error: error instanceof Error ? error.message : 'Nie udało się rozpocząć analizy.' }; }
}

export async function retryAnalysis(route: ScreeningRoute, analysisId: string, _state: ScreeningFormState, form: FormData): Promise<ScreeningFormState> {
  const { client, canEdit } = await companyAccess(route.companyId);
  try {
    const state = await runScreeningCommand({ client, canEdit, route, enabled: screeningAiUserEnabled(), command: 'retry', analysisId, idempotencyKey: String(form.get('requestId') ?? ''), dispatch: dispatchScreeningWorker });
    revalidatePath(screeningPath(route));
    return state;
  } catch (error) { return { error: error instanceof Error ? error.message : 'Nie udało się ponowić analizy.' }; }
}

export async function reviewAnalysis(route: ScreeningRoute, analysisId: string, _state: ScreeningFormState, form: FormData): Promise<ScreeningFormState> {
  const { client, canEdit } = await companyAccess(route.companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  if (!isUuid(analysisId)) return { error: 'Nie znaleziono analizy.' };
  try { await loadScreeningContext(client, route); }
  catch { return { error: 'Nie znaleziono zgłoszenia.' }; }
  const analysis = await client.from('screening_analysis_versions').select('id,execution_status,input_cv_text_snapshot,stale_at').eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId).eq('application_id', route.applicationId).eq('id', analysisId).maybeSingle();
  if (analysis.error || !analysis.data || analysis.data.execution_status !== 'completed') return { error: 'Przegląd jest dostępny tylko dla ukończonej analizy.' };
  const latest = await client.from('screening_analysis_versions').select('id')
    .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId).eq('application_id', route.applicationId)
    .order('analysis_version', { ascending: false }).limit(1).maybeSingle();
  if (latest.error || latest.data?.id !== analysisId) return { error: 'Analiza została zastąpiona. Otwórz najnowszy wynik i ponów przegląd.' };
  const criteria = await client.from('screening_criterion_results').select('*').eq('company_id', route.companyId).eq('analysis_id', analysisId).order('criterion_order');
  if (criteria.error) return { error: 'Nie udało się wczytać kryteriów.' };
  const versionText = String(form.get('reviewVersion') ?? '');
  if (!/^\d+$/.test(versionText) || !Number.isSafeInteger(Number(versionText))) return { error: 'Odśwież formularz przeglądu.' };
  let review;
  try { review = readScreeningReview(form, criteria.data, analysis.data.input_cv_text_snapshot); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Sprawdź formularz.' }; }
  if (analysis.data.stale_at && review.disposition !== 'needs_reanalysis') return { error: 'Nieaktualny wynik wymaga ponownej analizy.' };
  // The RPC independently checks current input freshness, tenant write access and review version under lock.
  const result = await client.rpc('review_screening_result', { target_analysis: analysisId, expected_review_version: Number(versionText), new_disposition: review.disposition, new_review_note: review.note, new_overrides: review.overrides });
  if (result.error) return { error: 'Nie zapisano przeglądu. Wynik, dane lub przegląd mogły się zmienić. Odśwież stronę i porównaj wersje.' };
  revalidatePath(screeningPath(route));
  return { saved: true, message: 'Zapisano przegląd. Oryginalny wynik AI pozostał bez zmian.' };
}
