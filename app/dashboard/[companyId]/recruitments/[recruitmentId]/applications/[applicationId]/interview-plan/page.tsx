import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { prepareScreening } from '../../../../../../../../lib/screening';
import { loadScreeningContext, ScreeningNotFoundError } from '../../../../../../../../lib/screening-flow';
import { isUuid, type ScreeningRoute } from '../../../../../../../../lib/screening-ui';
import {
  buildVoicePlanPreview, voicePlanPreviewEnabled, voicePlanPreviewStateLabels, type VoicePlanPreviewSource,
} from '../../../../../../../../lib/voice/plan-preview';
import { VoicePlanApprovalPanel } from '../../../../../../../../components/voice/VoicePlanApprovalPanel';

// ROADMAP R6-1d. Preview-only page behind VOICE_PLAN_PREVIEW (never on in
// Production). Read-only: nothing is saved, approved or sent to a candidate.
export const dynamic = 'force-dynamic';

export default async function InterviewPlanPreview({ params }: { params: Promise<ScreeningRoute> }) {
  if (!voicePlanPreviewEnabled()) notFound();
  const route = await params;
  if (!Object.values(route).every(isUuid)) notFound();
  const { companyId, recruitmentId, applicationId } = route;
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) notFound();
  // Every read goes through the signed-in user's RLS client and is scoped by company.
  const context = await loadScreeningContext(client, route).catch(error => {
    if (error instanceof ScreeningNotFoundError) notFound();
    throw error;
  });
  let fingerprint: string | undefined;
  try { fingerprint = prepareScreening(context).fingerprint; } catch { fingerprint = undefined; }

  const [shortlist, analysis] = await Promise.all([
    client.from('recruitment_shortlist_entries').select('application_id,analysis_id,review_id,removed_at')
      .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId)
      .is('removed_at', null).limit(2),
    client.from('screening_analysis_versions')
      .select('id,application_id,execution_status,input_fingerprint,stale_at,latest_review_version,criteria_snapshot')
      .eq('company_id', companyId).eq('application_id', applicationId).eq('recruitment_id', recruitmentId)
      .order('analysis_version', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (shortlist.error || analysis.error || !Array.isArray(shortlist.data) || shortlist.data.length > 1) {
    throw new Error('Nie udało się wczytać danych zgłoszenia.');
  }
  const current = analysis.data;
  const [review, results] = current?.execution_status === 'completed' ? await Promise.all([
    client.from('screening_result_reviews').select('id,analysis_id,review_version,disposition')
      .eq('company_id', companyId).eq('analysis_id', current.id).order('review_version', { ascending: false }).limit(1).maybeSingle(),
    client.from('screening_criterion_results').select('id,analysis_id,criterion_id,rating')
      .eq('company_id', companyId).eq('analysis_id', current.id).order('criterion_order'),
  ]) : [{ data: null, error: null }, { data: [], error: null }];
  if (review.error || results.error) throw new Error('Nie udało się wczytać analizy CV.');
  const overrides = review.data ? await client.from('screening_criterion_review_overrides')
    .select('review_id,criterion_result_id,rating_override')
    .eq('company_id', companyId).eq('review_id', review.data.id) : { data: [], error: null };
  if (overrides.error) throw new Error('Nie udało się wczytać korekt analizy.');

  const preview = buildVoicePlanPreview({
    companyId, applicationId, position: context.position, fingerprint,
    entry: shortlist.data[0] ?? null, analysis: current, review: review.data,
    results: (results.data ?? []) as VoicePlanPreviewSource['results'],
    overrides: (overrides.data ?? []) as VoicePlanPreviewSource['overrides'],
  });
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}`;

  return <main className="workspace"><section>
    <Link href={`${base}/applications/${applicationId}/interview`}>← Przygotowanie do rozmowy</Link>
    <h1>Scenariusz rozmowy — podgląd</h1>
    <p className="notice">Podgląd do sprawdzenia. Scenariusz nie jest zapisywany ani zatwierdzany i nikt nie kontaktuje się
      z kandydatem. Pytania nie są oceną kandydata. Kolejny krok wybiera człowiek.</p>
    {preview.state === 'ready'
      ? <VoicePlanApprovalPanel plan={preview.plan} role="recruiter" backendReady={false} />
      : <p role="status">{voicePlanPreviewStateLabels[preview.state]}</p>}
  </section></main>;
}
