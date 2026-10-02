import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { assessmentStatuses } from '../../../../../../../../lib/assessment-fields';
import { AssessmentForm } from '../../../assessment-forms';

export default async function Assessments({ params }: { params: Promise<{ companyId: string; recruitmentId: string; applicationId: string }> }) {
  const { companyId, recruitmentId, applicationId } = await params;
  const { client, canEdit } = await companyAccess(companyId);
  const application = await client.from('applications').select('id,candidate_id').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle();
  if (application.error) throw new Error('Nie udało się wczytać zgłoszenia.');
  if (!application.data) notFound();
  const [recruitment, candidate, stages, assessments] = await Promise.all([
    client.from('recruitments').select('name').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle(),
    client.from('candidates').select('first_name,last_name').eq('company_id', companyId).eq('id', application.data.candidate_id).maybeSingle(),
    client.from('assessment_stages').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).order('sequence'),
    client.from('candidate_assessments').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId),
  ]);
  if (recruitment.error || candidate.error || stages.error || assessments.error) throw new Error('Nie udało się wczytać etapów oceny.');
  if (!recruitment.data || !candidate.data) notFound();
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  return <main className="workspace"><section><Link href={base}>← Rekrutacja</Link>
    <h1>Etapy oceny — {candidate.data.first_name} {candidate.data.last_name}</h1><p>{recruitment.data.name}</p>
    <p className="notice">Postęp i notatki zapisuje rekruter. Zakończenie etapu nie oznacza przyjęcia ani odrzucenia kandydata i nie uruchamia żadnej wiadomości.</p>
    <p><Link href={`${base}/applications/${applicationId}/screening`}>Przygotowanie preselekcji</Link> · <Link href={`${base}/interview-guide`}>Przewodnik rozmowy</Link> · <Link href={`${base}/applications/${applicationId}/behaviors`}>Oceny z dowodami i historią</Link></p>
    {!stages.data.length && <p>Najpierw dodaj etapy na stronie rekrutacji.</p>}
    {stages.data.map(stage => {
      const assessment = assessments.data.find(row => row.stage_id === stage.id);
      return <article key={stage.id}><h2>{stage.sequence}. {stage.name}</h2>
        {stage.description && <p className="cv-text">{stage.description}</p>}
        <p>Status: {assessmentStatuses.find(([value]) => value === (assessment?.status ?? 'pending'))?.[1]}</p>
        {assessment?.completed_at && <p>Zakończono: {new Date(assessment.completed_at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}.</p>}
        {canEdit ? <AssessmentForm key={assessment?.updated_at ?? 'new'} companyId={companyId} recruitmentId={recruitmentId} applicationId={applicationId} stageId={stage.id} assessment={assessment}/>
          : <p className="cv-text">{assessment?.notes ?? 'Brak notatki.'}</p>}
      </article>;
    })}
  </section></main>;
}
