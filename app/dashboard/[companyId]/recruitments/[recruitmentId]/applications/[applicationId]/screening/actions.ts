'use server';

import { revalidatePath } from 'next/cache';
import { verifySnapshotQuotes } from '../../../../../../../../lib/screening-evidence';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { loadScreeningContext, runScreeningCommand } from '../../../../../../../../lib/screening-flow';
import { dispatchScreeningWorker, screeningAiUserEnabled } from '../../../../../../../../lib/screening-dispatch';
import { evidenceReviewError, isUuid, readScreeningReview, screeningPath, type ScreeningFormState, type ScreeningRoute } from '../../../../../../../../lib/screening-ui';

export async function startAnalysis(route: ScreeningRoute, _state: ScreeningFormState, form: FormData): Promise<ScreeningFormState> {
  const { client, canEdit } = await companyAccess(route.companyId);
  try {
    const state = await runScreeningCommand({ client, canEdit, route, enabled: screeningAiUserEnabled(), command: 'start', upgrade: form.get('upgrade') === 'evidence', idempotencyKey: String(form.get('requestId') ?? ''), dispatch: dispatchScreeningWorker });
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
  const evidenceError = evidenceReviewError(review.disposition, criteria.data);
  if (evidenceError) return { error: evidenceError };
  if (analysis.data.stale_at && review.disposition !== 'needs_reanalysis') return { error: 'Nieaktualny wynik wymaga ponownej analizy.' };
  // The RPC independently checks current input freshness, tenant write access and review version under lock.
  const result = await client.rpc('review_screening_result', { target_analysis: analysisId, expected_review_version: Number(versionText), new_disposition: review.disposition, new_review_note: review.note, new_overrides: review.overrides });
  if (result.error) return { error: 'Nie zapisano przeglądu. Wynik, dane lub przegląd mogły się zmienić. Odśwież stronę i porównaj wersje.' };
  revalidatePath(screeningPath(route));
  return { saved: true, message: 'Zapisano przegląd. Oryginalny wynik AI pozostał bez zmian.' };
}

/** Per-row human verification: the original AI finding is never overwritten. */
export async function reviewEvidenceRow(
  route: ScreeningRoute, analysisId: string, criterionId: string,
  _previous: ScreeningFormState, form: FormData,
): Promise<ScreeningFormState> {
  if (![route.companyId, route.recruitmentId, route.applicationId, analysisId, criterionId].every(isUuid)) {
    return { error: 'Nieprawidłowe odwołanie do wyniku.' };
  }
  const { client, canEdit } = await companyAccess(route.companyId);
  if (!canEdit) return { error: 'Nie masz uprawnień do edycji.' };
  try { await loadScreeningContext(client, route); } catch { return { error: 'Nie znaleziono zgłoszenia.' }; }
  const analysis = await client.from('screening_analysis_versions')
    .select('id,company_id,candidate_document_id,input_cv_text_snapshot,execution_status')
    .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId)
    .eq('application_id', route.applicationId).eq('id', analysisId).maybeSingle();
  if (analysis.error || !analysis.data || analysis.data.execution_status !== 'completed') {
    return { error: 'Wynik nie jest gotowy.' };
  }
  const row = await client.from('screening_criterion_results').select('*')
    .eq('company_id', route.companyId).eq('analysis_id', analysisId).eq('id', criterionId).maybeSingle();
  if (row.error || !row.data || row.data.verdict === null) return { error: 'Nie znaleziono wiersza macierzy.' };
  const current = row.data;
  const suppliedTimestamp = String(form.get('updatedAt') ?? '');
  if (suppliedTimestamp !== (current.updated_at ?? '')) return { error: 'Wiersz zmieniono. Odśwież stronę.' };
  const intent = String(form.get('intent') ?? '');
  if (!['accepted', 'rejected', 'edited', 'note'].includes(intent)) return { error: 'Nieznana operacja.' };
  const nextStatus = intent === 'note' ? current.human_status : intent as 'accepted' | 'rejected' | 'edited';
  const note = String(form.get('note') ?? '').trim();
  if (note.length > 10000) return { error: 'Notatka jest zbyt długa.' };

  let nextVerdict: typeof current.verdict = null;
  let nextMissingInfo: string | null = null;
  let nextQuestion: string | null = null;
  let nextEvidence: typeof current.evidence | null = null;
  if (intent === 'edited') {
    const verdict = String(form.get('verdict') ?? '');
    if (!['supported', 'partial', 'missing', 'contradicted'].includes(verdict)) return { error: 'Nieprawidłowy werdykt.' };
    nextVerdict = verdict as NonNullable<typeof current.verdict>;
    nextMissingInfo = String(form.get('missingInfo') ?? '').trim();
    nextQuestion = String(form.get('question') ?? '').trim();
    // One field per citation, so a quote spanning several CV lines stays one quote.
    const quoteFields = form.getAll('quote').map(value => String(value));
    const quotes = quoteFields.map(s => s.trim()).filter(Boolean);
    if (quoteFields.length > 5 || quotes.some(q => q.length > 2000) || nextMissingInfo.length > 4000 || nextQuestion.length > 4000) {
      return { error: 'Przekroczono limit pól wiersza.' };
    }
    const verified = verifySnapshotQuotes(analysis.data.input_cv_text_snapshot, analysis.data.candidate_document_id, quotes);
    if (verified.length !== quotes.length) return { error: 'Każdy cytat musi być sprawdzalny w zatwierdzonym CV.' };
    nextEvidence = verified.map(({ start, end, quote }) => ({ start, end, quote }));
    if ((nextVerdict === 'missing') !== (nextEvidence.length === 0)) {
      return { error: 'Brak cytatów wymaga werdyktu „Brak informacji”.' };
    }
  } else if (intent === 'note' && current.human_status === 'edited') {
    nextVerdict = current.human_verdict;
    nextMissingInfo = current.human_missing_info;
    nextQuestion = current.human_suggested_question;
    nextEvidence = current.human_evidence;
  }
  const result = await client.rpc('review_screening_evidence_row', {
    target_company: route.companyId, target_analysis: analysisId, target_criterion: criterionId,
    expected_updated_at: current.updated_at,
    next_status: nextStatus, next_note: note || null,
    next_verdict: nextVerdict, next_missing_info: nextMissingInfo,
    next_question: nextQuestion, next_evidence: nextEvidence,
  });
  if (result.error) return { error: 'Nie zapisano zmiany. Wynik może być nieaktualny; odśwież stronę.' };
  revalidatePath(screeningPath(route));
  return { saved: true, message: 'Zapisano decyzję człowieka.' };
}
