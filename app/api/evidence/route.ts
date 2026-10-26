import { NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { companyAccess } from '../../../lib/company-access';
import { loadScreeningContext } from '../../../lib/screening-flow';
import { prepareScreening } from '../../../lib/screening';
import { analyzeEvidence, buildEvidenceRequirements, EVIDENCE_MODEL, snapshotHash, verifyAnalysisInputs, type EvidenceRequirement } from '../../../lib/evidence-matrix';
import { isUuid } from '../../../lib/screening-ui';

export const runtime = 'nodejs';
export const maxDuration = 45;

const safeError = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

export async function POST(request: Request) {
  let input: { companyId?: string; recruitmentId?: string; applicationId?: string };
  try { input = await request.json(); }
  catch { return safeError('Nieprawidłowe dane żądania.'); }
  if (![input.companyId, input.recruitmentId, input.applicationId].every(isUuid)) return safeError('Nieprawidłowy identyfikator.');
  const route = { companyId: input.companyId!, recruitmentId: input.recruitmentId!, applicationId: input.applicationId! };

  // All source reads and authorization use the authenticated RLS client.
  let prepared: ReturnType<typeof prepareScreening>;
  let requirements: EvidenceRequirement[];
  let userId: string;
  let candidateId: string;
  try {
    const access = await companyAccess(route.companyId);
    if (!access.canEdit) return safeError('Masz dostęp tylko do odczytu.', 403);
    userId = access.user.id;
    const context = await loadScreeningContext(access.client, route);
    prepared = prepareScreening(context);
    requirements = buildEvidenceRequirements(prepared.payload.criteria,context.position);
    candidateId = context.application.candidate_id;
    verifyAnalysisInputs(requirements, prepared.payload.cv_text);
  } catch (error) {
    return safeError(error instanceof Error ? error.message : 'Brak dostępu do materiałów.', 403);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const aiKey = process.env.OPENAI_API_KEY;
  if (!url || !serviceKey || !aiKey) return safeError('Moduł analizy wymaga konfiguracji serwera.', 503);
  // Service-role credentials never reach a client component. They can execute
  // only narrow evidence RPCs: direct CRUD on public tables stays revoked.
  const admin = createServiceClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const organization_id = route.companyId;
  const material = {
    document_id: prepared.binding.document_id,
    version: prepared.binding.document_version,
    text: prepared.payload.cv_text,
  };
  const snapshot = [{ document_id: material.document_id, version: material.version, text: material.text }];
  // Database RPC serializes requests, checks the approved snapshot, quota
  // (5 analyses/24h) and active jobs in the same transaction.
  const created = await admin.rpc('begin_evidence_analysis', {
    p_organization_id: organization_id,
    p_candidate_id: candidateId,
    p_position_id: prepared.binding.position_id,
    p_recruitment_id: route.recruitmentId,
    p_application_id: route.applicationId,
    p_document_id: material.document_id,
    p_model: EVIDENCE_MODEL,
    p_created_by: userId,
    p_requirements: requirements,
    p_materials: snapshot,
    p_hash: snapshotHash(snapshot),
  });
  if (created.error || !created.data) {
    if (created.error?.code === 'PT429') return safeError('Wykorzystano limit 5 analiz w ciągu 24 godzin dla tego zgłoszenia.', 429);
    if (created.error?.code === 'PT409' || created.error?.code === '23505') return safeError('Analiza już trwa. Odśwież widok.', 409);
    return safeError('Nie udało się przygotować analizy. Sprawdź zatwierdzenie CV i konfigurację bazy.', 503);
  }
  const analysisId: string = created.data;

  try {
    const items = await analyzeEvidence(requirements, material, aiKey);
    const stored = await admin.rpc('complete_evidence_analysis', {
      p_organization_id: organization_id, p_analysis_id: analysisId,
      p_items: items,
    });
    if (stored.error) throw new Error('Nie udało się zapisać macierzy wyników.');
    return NextResponse.json({ analysis_id: analysisId, status: 'done' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analiza nie została ukończona.';
    const readable = /JSON|Wynik|Zod|invalid|parse|schema|expected|Unrecognized/i.test(message)
      ? 'Wynik modelu nie przeszedł walidacji danych. Możesz ponowić analizę.'
      : /abort|timeout|timed out/i.test(message) ? 'Upłynął limit czasu analizy. Możesz ponowić.'
      : message;
    await admin.rpc('fail_evidence_analysis', {
      p_organization_id: organization_id, p_analysis_id: analysisId, p_message: readable.slice(0,2000),
    });
    return safeError(readable, 502);
  }
}

export async function PATCH(request: Request) {
  let input: Record<string,unknown>;
  try { input = await request.json(); } catch { return safeError('Nieprawidłowy formularz.'); }
  const fields = ['organization_id','analysis_id','item_id','human_status','human_note','human_verdict','human_missing_info','human_question'];
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(k=>!fields.includes(k))
    || !isUuid(input.organization_id) || !isUuid(input.analysis_id) || !isUuid(input.item_id)
    || !['unreviewed','accepted','rejected','edited'].includes(String(input.human_status))
    || typeof input.human_note !== 'string' || input.human_note.length > 3000) return safeError('Nieprawidłowe dane weryfikacji.');
  const status = String(input.human_status);
  if (status === 'edited' && (
    !['supported','partial','missing','contradicted'].includes(String(input.human_verdict))
    || typeof input.human_missing_info !== 'string' || input.human_missing_info.length > 2000
    || typeof input.human_question !== 'string' || input.human_question.length > 2000
  )) return safeError('Uzupełnij poprawną korektę.');
  let access: Awaited<ReturnType<typeof companyAccess>>;
  try { access = await companyAccess(String(input.organization_id)); }
  catch { return safeError('Brak dostępu do firmy.', 403); }
  if (!access.canEdit) return safeError('Masz dostęp tylko do odczytu.',403);
  const analysis = await access.client.from('evidence_analysis').select('status')
    .eq('organization_id',String(input.organization_id)).eq('id',String(input.analysis_id)).maybeSingle();
  if (analysis.error || analysis.data?.status !== 'done') return safeError('Można sprawdzać tylko ukończone zestawienia.',409);
  const edited = status === 'edited';
  const result = await access.client.from('evidence_item').update({
    human_status: status as 'unreviewed'|'accepted'|'rejected'|'edited',
    human_note: String(input.human_note),
    human_verdict: edited ? String(input.human_verdict) as 'supported'|'partial'|'missing'|'contradicted' : null,
    human_missing_info: edited ? String(input.human_missing_info) : null,
    human_question: edited ? String(input.human_question) : null,
  }).eq('organization_id',String(input.organization_id))
    .eq('analysis_id',String(input.analysis_id)).eq('id',String(input.item_id)).select('id').maybeSingle();
  if(result.error || !result.data) return safeError('Nie zapisano weryfikacji. Odśwież widok i ponów próbę.',409);
  return NextResponse.json({saved:true});
}
