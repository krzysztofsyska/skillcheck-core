import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import type { ScreeningRoute } from '../../../../../../../../lib/screening-ui';
import {
  parseVoiceTranscriptRows, voiceTranscriptErrorState, voiceTranscriptLoadLabels, voiceTranscriptPageAllowed,
} from '../../../../../../../../lib/voice/transcript-view';
import { VoiceTranscriptList } from '../../../../../../../../components/voice/VoiceTranscriptList';

// ROADMAP R6 (#542). Preview-only page behind VOICE_PLAN_PREVIEW (never on in
// Production). Read-only: no edit, no export, nothing sent to the candidate.
// The transcript text is candidate data: it is rendered here and never logged.
export const dynamic = 'force-dynamic';

export default async function InterviewTranscriptPreview({ params }: { params: Promise<ScreeningRoute> }) {
  const route = await params;
  if (!voiceTranscriptPageAllowed({ route })) notFound();
  const { companyId, recruitmentId, applicationId } = route;
  const { client, canEdit } = await companyAccess(companyId);
  if (!voiceTranscriptPageAllowed({ route, canEdit })) notFound();
  // The database re-checks membership and the company -> recruitment -> application
  // binding, hides transcripts past retention and logs the read.
  const { data, error } = await client.rpc('read_voice_interview_transcripts', {
    target_company: companyId, target_recruitment: recruitmentId, target_application: applicationId,
  });
  const failure = error ? voiceTranscriptErrorState(error) : null;
  if (failure === 'not_found') notFound();
  const calls = failure ? null : parseVoiceTranscriptRows(data);
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applicationId}`;

  return <main className="workspace"><section>
    <Link href={`${base}/interview`}>← Przygotowanie do rozmowy</Link>
    <h1>Transkrypt rozmowy głosowej — podgląd</h1>
    <p className="notice">Zapis rozmowy do przeczytania przez człowieka. Transkrypt nie jest oceną kandydata, aplikacja go nie
      analizuje i nie podejmuje decyzji. Kolejny krok wybiera człowiek. Transkrypt jest usuwany 90 dni po zamknięciu rekrutacji.</p>
    {calls
      ? <VoiceTranscriptList calls={calls} />
      : <p role="status">{voiceTranscriptLoadLabels[failure === 'withdrawn' ? 'withdrawn' : 'unavailable']}</p>}
  </section></main>;
}
