import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { reviewedGaps } from '../../../../../../../../lib/interview-workflow';
import { InterviewWorkbench } from './controls';
import styles from './interview.module.css';

type Route = { companyId:string; recruitmentId:string; applicationId:string };
export default async function InterviewPage({params}:{params:Promise<Route>}) {
  const route=await params;
  const {companyId,recruitmentId,applicationId}=route;
  const {client,canEdit}=await companyAccess(companyId);
  const application=await client.from('applications').select('id,candidate_id')
    .eq('company_id',companyId).eq('recruitment_id',recruitmentId)
    .eq('id',applicationId).maybeSingle();
  if(application.error) throw new Error('Nie udało się odczytać zgłoszenia.');
  if(!application.data) notFound();
  const [recruitment,candidate,analysis,stages,stageHistory,decisions]=await Promise.all([
    client.from('recruitments').select('name,position_id')
      .eq('company_id',companyId).eq('id',recruitmentId).maybeSingle(),
    client.from('candidates').select('first_name,last_name')
      .eq('company_id',companyId).eq('id',application.data.candidate_id).maybeSingle(),
    client.from('evidence_analysis').select('*')
      .eq('organization_id',companyId).eq('recruitment_id',recruitmentId)
      .eq('application_id',applicationId).eq('status','done')
      .order('created_at',{ascending:false}).limit(1),
    client.from('assessment_stages').select('*')
      .eq('company_id',companyId).eq('recruitment_id',recruitmentId).order('sequence'),
    client.from('application_stage_transitions').select('*')
      .eq('organization_id',companyId).eq('recruitment_id',recruitmentId)
      .eq('application_id',applicationId).order('created_at',{ascending:false})
      .order('id',{ascending:false}).limit(100),
    client.from('human_candidate_decisions').select('*')
      .eq('organization_id',companyId).eq('recruitment_id',recruitmentId)
      .eq('application_id',applicationId).order('decided_at',{ascending:false})
      .order('id',{ascending:false}).limit(100),
  ]);
  if([recruitment,candidate,analysis,stages,stageHistory,decisions].some(v=>v.error))
    throw new Error('Nie udało się odczytać danych rozmowy. Sprawdź migrację kroku 4.');
  if(!recruitment.data||!candidate.data) notFound();
  const selected=analysis.data?.[0];
  const [items,questionRows]=await Promise.all([
    selected ? client.from('evidence_item').select('*')
      .eq('organization_id',companyId).eq('analysis_id',selected.id) : Promise.resolve({data:[],error:null}),
    selected ? client.from('interview_questions').select('*')
      .eq('organization_id',companyId).eq('recruitment_id',recruitmentId)
      .eq('application_id',applicationId).eq('analysis_id',selected.id).order('sort_order')
      : Promise.resolve({data:[],error:null}),
  ]);
  if(items.error || questionRows.error) throw new Error('Nie udało się odczytać pytań i dowodów.');
  const gaps=selected ? reviewedGaps(items.data||[],selected.requirements_snapshot) : [];
  // Revoked reviews never silently remain active in a guide.
  const allowed=new Set(gaps.map(g=>g.itemId));
  const questions=(questionRows.data||[]).filter(q=>allowed.has(q.evidence_item_id));
  const invalidCount=(questionRows.data||[]).length-questions.length;
  const noteRows=questions.length ? await client.from('interview_question_notes').select('*')
    .eq('organization_id',companyId).in('question_id',questions.map(q=>q.id)) : {data:[],error:null};
  if(noteRows.error) throw new Error('Nie udało się odczytać notatek.');
  const revisions=(noteRows.data||[]).length ? await client.from('interview_note_revisions').select('*')
    .eq('organization_id',companyId).in('note_id',(noteRows.data||[]).map(n=>n.id))
    .order('version',{ascending:false}).limit(500) : {data:[],error:null};
  if(revisions.error) throw new Error('Nie udało się odczytać historii notatek.');
  const base=`/dashboard/${companyId}/recruitments/${recruitmentId}`;
  return <main className={`workspace ${styles.page}`}><section>
    <div className={styles.noPrint}><Link href={base}>← Rekrutacja</Link></div>
    <h1>Przygotowanie rozmowy — {candidate.data.first_name} {candidate.data.last_name}</h1>
    <p>{recruitment.data.name}</p>
    <p className={styles.notice}>Odpowiedzi i obserwacje zapisuje człowiek. Wnioski z AI nie są decyzjami rekrutacyjnymi.</p>
    <p className={styles.noPrint}>
      <Link href={`${base}/applications/${applicationId}/evidence`}>Wróć do dowodów i weryfikacji</Link>
      {' · '}<Link href={`${base}/interview-guide`}>Przewodnik zachowań</Link>
      {' · '}<Link href={base}>Edytuj listę etapów</Link>
    </p>
    {selected&&<p className={styles.metadata}>Analiza źródłowa z {new Date(selected.created_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})}. Nowa analiza wymaga ponownego przygotowania przewodnika; wcześniejsze notatki pozostają w historii.</p>}
    {invalidCount>0&&<p role="status">Ukryto {invalidCount} pytań, których źródłowe wiersze nie są już zatwierdzonymi lukami. Historia pozostaje w bazie.</p>}
    <InterviewWorkbench route={route} canEdit={canEdit} analysisId={selected?.id??null}
      gaps={gaps} questions={questions} notes={noteRows.data||[]} noteHistory={revisions.data||[]}
      stages={stages.data||[]} stageHistory={stageHistory.data||[]} decisions={decisions.data||[]}/>
  </section></main>;
}
