import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { assessmentStatuses } from '../../../../../../../../lib/assessment-fields';
import { humanDecisions } from '../../../../../../../../lib/interview-decision';
import { step4Client } from '../../../../../../../../lib/step4-database';
import { AssessmentForm, CandidateStageForm, HumanDecisionForm } from '../../../assessment-forms';

const displayTime = (time: string) => new Date(time).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });

export default async function Assessments({ params }: { params: Promise<{ companyId: string; recruitmentId: string; applicationId: string }> }) {
  const { companyId, recruitmentId, applicationId } = await params;
  const { client: originalClient, canEdit } = await companyAccess(companyId);
  const client = step4Client(originalClient);
  const application = await client.from('applications')
    .select('id,candidate_id,current_stage_id,human_decision,human_decision_reason')
    .eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle();
  if (application.error) throw new Error('Nie udało się wczytać zgłoszenia.');
  if (!application.data) notFound();
  const [recruitment, candidate, stages, assessments, stageHistory, decisionHistory, noteHistory] = await Promise.all([
    client.from('recruitments').select('name,position_id').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle(),
    client.from('candidates').select('first_name,last_name').eq('company_id', companyId).eq('id', application.data.candidate_id).maybeSingle(),
    client.from('assessment_stages').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).order('sequence'),
    client.from('candidate_assessments').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId),
    client.from('application_stage_events').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId).order('created_at', { ascending: false }),
    client.from('application_decision_events').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId).order('created_at', { ascending: false }),
    client.from('candidate_assessment_note_revisions').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('application_id', applicationId).order('created_at', { ascending: false }),
  ]);
  if (recruitment.error || candidate.error || stages.error || assessments.error || stageHistory.error || decisionHistory.error || noteHistory.error)
    throw new Error('Nie udało się wczytać danych rozmowy.');
  if (!recruitment.data || !candidate.data) notFound();
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  const stageName = (id: string | null) => stages.data.find(stage => stage.id === id)?.name ?? (id ? 'Usunięty etap' : 'Nieprzypisany');
  const decisionName = (value: string | null) => humanDecisions.find(([key]) => key === value)?.[1] ?? 'Brak decyzji';

  return <main className="workspace"><section><Link href={base}>← Rekrutacja</Link>
    <h1>Etapy oceny — {candidate.data.first_name} {candidate.data.last_name}</h1>
    <p>{recruitment.data.name} · <Link href={`/dashboard/${companyId}/positions/${recruitment.data.position_id}`}>Stanowisko</Link></p>
    <p className="notice">Postęp, notatki i decyzję zapisuje wyłącznie człowiek. Status etapu nie jest decyzją o zatrudnieniu. Nie uruchamia wiadomości do kandydata.</p>
    <p><Link href={`${base}/applications/${applicationId}/screening`}>Przygotowanie preselekcji</Link> · <Link href={`${base}/interview-guide`}>Przewodnik rozmowy</Link> · <Link href={`${base}/applications/${applicationId}/behaviors`}>Oceny z dowodami i historią</Link> · <Link href={`${base}/applications/${applicationId}/exercises`}>Wykonanie zadań i historia</Link></p>

    <h2>Aktualny etap</h2>
    <p><strong>{stageName(application.data.current_stage_id)}</strong></p>
    {canEdit && <CandidateStageForm companyId={companyId} recruitmentId={recruitmentId} applicationId={applicationId}
      currentStageId={application.data.current_stage_id} stages={stages.data}/>}
    <details><summary>Historia zmian etapu ({stageHistory.data.length})</summary>
      {stageHistory.data.length ? <ol>{stageHistory.data.map(event => <li key={event.id}>
        {stageName(event.from_stage_id)} → {stageName(event.to_stage_id)}; {displayTime(event.created_at)}; autor: {event.actor_id}
      </li>)}</ol> : <p>Brak wcześniejszych przesunięć.</p>}
    </details>

    <h2>Notatki i obserwacje z rozmowy</h2>
    {!stages.data.length && <p>Najpierw dodaj etapy na stronie rekrutacji.</p>}
    {stages.data.map(stage => {
      const assessment = assessments.data.find(row => row.stage_id === stage.id);
      const revisions = noteHistory.data.filter(row => row.assessment_id === assessment?.id);
      return <article key={stage.id}><h3>{stage.sequence}. {stage.name}</h3>
        {stage.description && <p className="cv-text">{stage.description}</p>}
        <p>Status: {assessmentStatuses.find(([value]) => value === (assessment?.status ?? 'pending'))?.[1]}</p>
        {assessment?.completed_at && <p>Zakończono: {displayTime(assessment.completed_at)}.</p>}
        {canEdit ? <AssessmentForm key={stage.id} companyId={companyId} recruitmentId={recruitmentId}
          applicationId={applicationId} stageId={stage.id} assessment={assessment ?? undefined}/>
          : <p className="cv-text">{assessment?.notes ?? 'Brak notatki.'}</p>}
        <p>Przypisane pytanie przewodnika: {assessment?.guide_question_id ?? 'Brak (pole opcjonalne; integracja po PR #171)'}</p>
        <details><summary>Historia edycji notatki ({revisions.length})</summary>
          {revisions.length ? <ol>{revisions.map(revision => <li key={revision.id}>
            <strong>{displayTime(revision.created_at)}</strong> · autor: {revision.author_id}
            <p className="cv-text">{revision.body ?? '(notatka wyczyszczona)'}</p>
          </li>)}</ol> : <p>Brak wcześniejszych zapisów.</p>}
        </details>
      </article>;
    })}

    <h2>Decyzja człowieka</h2>
    <p>Aktualna decyzja: <strong>{decisionName(application.data.human_decision)}</strong>.</p>
    {application.data.human_decision_reason && <p className="cv-text">Uzasadnienie: {application.data.human_decision_reason}</p>}
    {canEdit && <HumanDecisionForm companyId={companyId} recruitmentId={recruitmentId} applicationId={applicationId}/>}
    <details><summary>Historia decyzji ({decisionHistory.data.length})</summary>
      {decisionHistory.data.length ? <ol>{decisionHistory.data.map(event => <li key={event.id}>
        {decisionName(event.previous_decision)} → {decisionName(event.new_decision)};
        {' '}{displayTime(event.created_at)}; autor: {event.actor_id}
        <p className="cv-text">Uzasadnienie: {event.reason}</p>
      </li>)}</ol> : <p>Żadna decyzja nie została podjęta.</p>}
    </details>
  </section></main>;
}
