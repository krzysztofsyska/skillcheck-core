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
  // Privileged API credentials never reach a client component. This client is
  // restricted to two evidence tables; no access to candidate source is needed.
  const admin = createServiceClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const organization_id = route.companyId;
  const material = {
    document_id: prepared.binding.document_id,
    version: prepared.binding.document_version,
    text: prepared.payload.cv_text,
  };
  const snapshot = [{ document_id: material.document_id, version: material.version, text: material.text }];
  const row = {
    organization_id, recruitment_id: route.recruitmentId, application_id: route.applicationId,
    candidate_id: candidateId,
    position_id: prepared.binding.position_id, document_id: material.document_id,
    status: 'running', model: EVIDENCE_MODEL, created_by: userId,
    requirements_snapshot: requirements, materials_snapshot: snapshot,
    materials_snapshot_hash: snapshotHash(snapshot),
  };
  // A crashed request may leave an orphaned running record. A new request may
  // recover it after the maximum server execution window has elapsed.
  // Hard quota blocks accidental repeated paid invocations per candidate/day.
  const since = new Date(Date.now()-24*60*60*1000).toISOString();
  const daily = await admin.from('evidence_analysis').select('id',{count:'exact',head:true})
    .eq('organization_id',organization_id).eq('application_id',route.applicationId).gte('created_at',since);
  if (daily.error) return safeError('Nie można sprawdzić limitu analiz.',503);
  if ((daily.count ?? 0)>=5) return safeError('Wykorzystano limit 5 analiz w ciągu 24 godzin dla tego zgłoszenia.',429);
  const active = await admin.from('evidence_analysis').select('id,created_at')
    .eq('organization_id',organization_id).eq('application_id',route.applicationId)
    .in('status',['pending','running']).limit(1).maybeSingle();
  if (active.error) return safeError('Nie można sprawdzić bieżącej analizy.', 503);
  if (active.data) {
    if (Date.now() - Date.parse(active.data.created_at) < 120000) {
      return safeError('Analiza już trwa. Odśwież widok.', 409);
    }
    await admin.from('evidence_analysis').update({ status: 'failed', failure_message: 'Przekroczono czas przetwarzania. Możesz ponowić analizę.', finished_at: new Date().toISOString() })
      .eq('id',active.data.id).eq('organization_id',organization_id).eq('status','running');
  }
  const created = await admin.from('evidence_analysis').insert(row).select('id').single();
  if (created.error || !created.data) return safeError('Analiza już trwa lub zapis jest niedostępny.', 409);
  const analysisId: string = created.data.id;

  try {
    const items = await analyzeEvidence(requirements, material, aiKey);
    const stored = await admin.from('evidence_item').insert(items.map(item => ({
      ...item, organization_id, analysis_id: analysisId,
    })));
    if (stored.error) throw new Error('Nie udało się zapisać macierzy wyników.');
    const finished = await admin.from('evidence_analysis').update({ status: 'done', finished_at: new Date().toISOString() })
      .eq('organization_id',organization_id).eq('id',analysisId).eq('status','running').select('id').maybeSingle();
    if (finished.error || !finished.data) throw new Error('Nie udało się zakończyć analizy.');
    return NextResponse.json({ analysis_id: analysisId, status: 'done' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analiza nie została ukończona.';
    const readable = /JSON|Wynik|Zod|invalid|parse|schema|expected|Unrecognized/i.test(message)
      ? 'Wynik modelu nie przeszedł walidacji danych. Możesz ponowić analizę.'
      : /abort|timeout|timed out/i.test(message) ? 'Upłynął limit czasu analizy. Możesz ponowić.'
      : message;
    await admin.from('evidence_analysis').update({ status: 'failed', finished_at: new Date().toISOString(), failure_message: readable.slice(0,2000) })
      .eq('organization_id',organization_id).eq('id',analysisId).eq('status','running');
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
