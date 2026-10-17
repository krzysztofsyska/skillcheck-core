import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { prepareScreening } from './screening.ts';
import { screeningAiContract } from './screening-ai.ts';
import { isUuid, type ScreeningRoute } from './screening-ui.ts';
import type { ScreeningDispatchResult } from './screening-dispatch.ts';

export class ScreeningNotFoundError extends Error {}

export async function loadScreeningContext(client: SupabaseClient<Database>, route: ScreeningRoute) {
  if (!Object.values(route).every(isUuid)) throw new ScreeningNotFoundError('Nie znaleziono zgłoszenia.');
  const { companyId, recruitmentId, applicationId } = route;
  const application = await client.from('applications').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle();
  if (application.error) throw new Error('Nie udało się wczytać zgłoszenia.');
  if (!application.data) throw new ScreeningNotFoundError('Nie znaleziono zgłoszenia.');
  const recruitment = await client.from('recruitments').select('*').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error) throw new Error('Nie udało się wczytać rekrutacji.');
  if (!recruitment.data) throw new ScreeningNotFoundError('Nie znaleziono rekrutacji.');
  const [position, document] = await Promise.all([
    client.from('positions').select('*').eq('company_id', companyId).eq('id', recruitment.data.position_id).maybeSingle(),
    client.from('candidate_documents').select('id,company_id,candidate_id,version,status,reviewed_by,reviewed_at,redacted_text').eq('company_id', companyId).eq('candidate_id', application.data.candidate_id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (position.error || document.error) throw new Error('Nie udało się wczytać wymagań lub CV.');
  if (!position.data) throw new ScreeningNotFoundError('Nie znaleziono stanowiska.');
  return { companyId, application: application.data, recruitment: recruitment.data, position: position.data, document: document.data };
}

export async function runScreeningCommand(input: {
  client: SupabaseClient<Database>; canEdit: boolean; enabled: boolean; route: ScreeningRoute;
  command: 'start' | 'retry'; analysisId?: string; idempotencyKey: string;
  dispatch: (attempt: string) => Promise<ScreeningDispatchResult>;
}) {
  if (!input.canEdit) throw new Error('Masz dostęp tylko do odczytu.');
  if (!input.enabled) throw new Error('Uruchamianie analizy AI jest obecnie wyłączone.');
  if (!isUuid(input.idempotencyKey)) throw new Error('Odśwież formularz i spróbuj ponownie.');
  const prepared = prepareScreening(await loadScreeningContext(input.client, input.route));
  let attemptId: string | null;
  if (input.command === 'retry') {
    if (!isUuid(input.analysisId)) throw new Error('Nie znaleziono analizy.');
    const analysis = await input.client.from('screening_analysis_versions').select('id,execution_status,stale_at,input_fingerprint').eq('company_id', input.route.companyId).eq('application_id', input.route.applicationId).eq('recruitment_id', input.route.recruitmentId).eq('id', input.analysisId).maybeSingle();
    if (analysis.error || !analysis.data || analysis.data.stale_at || analysis.data.input_fingerprint !== prepared.fingerprint) throw new Error('Wynik jest nieaktualny. Uruchom nową analizę.');
    const result = await input.client.rpc('retry_screening_analysis', { target_analysis: analysis.data.id, request_idempotency_key: input.idempotencyKey });
    if (result.error?.code === 'PT402') throw new Error('Wykorzystano dostępny limit analiz CV. Wybierz pakiet PRESELEKCJA.');
    if (result.error || !result.data?.[0]) throw new Error('Nie można ponowić tej analizy. Odśwież stronę i sprawdź jej stan.');
    attemptId = result.data[0].attempt_id;
  } else {
    const contract = screeningAiContract;
    const result = await input.client.rpc('start_screening_analysis', {
      target_application: input.route.applicationId, expected_input_fingerprint: prepared.fingerprint,
      expected_payload_schema_version: contract.payload_schema_version, requested_result_schema_version: contract.result_schema_version,
      requested_prompt_version: contract.prompt_version, requested_provider: contract.provider, requested_model: contract.model,
      requested_model_revision: contract.model_revision, request_idempotency_key: input.idempotencyKey,
    });
    if (result.error?.code === 'PT402') throw new Error('Wykorzystano dostępny limit analiz CV. Wybierz pakiet PRESELEKCJA.');
    if (result.error || !result.data?.[0]) throw new Error('Nie udało się rozpocząć analizy. Dane mogły się zmienić — odśwież stronę.');
    attemptId = result.data[0].attempt_id;
    if (result.data[0].execution_status === 'completed') return { saved: true, message: 'Wczytano aktualny, istniejący wynik.' };
  }
  // Only a capability returned by the authenticated RPC is ever signed/dispatched.
  if (!attemptId) throw new Error('Nie udało się przygotować zadania analizy.');
  try {
    const result = await input.dispatch(attemptId);
    if (result.accepted) return { saved: true, message: 'Zlecono analizę. Wynik pojawi się po zakończeniu przetwarzania.' };
  } catch { /* Never expose network errors or configuration to the browser. */ }
  return { saved: true, message: 'Zadanie zapisano, ale nie potwierdzono jego wysłania. Odśwież stan; jeśli nadal oczekuje, wybierz „Ponów wysłanie”.' };
}
