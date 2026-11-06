import { loadBehaviorContext, type BehaviorRoute } from '../../../../../lib/behavior-context';
import { behaviorRatings } from '../../../../../lib/behavior-assessment';
import type { ExerciseDefinition } from '../../../../../lib/exercise-definition';
import { parseAssessmentCenterPair } from '../../../../../lib/assessment-center-pair';
import { assessmentCenterPreviewEnabled } from '../../../../../lib/assessment-center-preview';
import { assignAssessmentCenterPair, submitAssessmentCenterSheet } from './paired-assessor-actions';
import { PairedAssessorAssignmentForm, PairedAssessorForm } from './paired-assessor-form';

export async function PairedAssessorSheets({ route, definition }: {
  route: BehaviorRoute & { definitionId: string }; definition: ExerciseDefinition;
}) {
  if (!assessmentCenterPreviewEnabled() || definition.kind !== 'assessment_center') return null;
  const { client, company, user, canEdit, application, recruitment, position } = await loadBehaviorContext(route);
  if (!canEdit) return null;
  const processOpen = ['new', 'in_progress'].includes(application.status)
    && ['draft', 'open'].includes(recruitment.status) && position.status !== 'archived';
  const pair = await client.rpc('ac_find_pair', { application: route.applicationId, revision: route.definitionId });
  if (pair.error) return <p>Arkusze dwóch asesorów są niedostępne w tym środowisku.</p>;
  if (!pair.data) {
    if (company.owner_id !== user.id || !processOpen) return null;
    const members = await client.from('company_members').select('user_id').eq('company_id', company.id).eq('role', 'recruiter');
    if (members.error) return <p>Nie udało się wczytać asesorów.</p>;
    const ids = Array.from(new Set([user.id, ...members.data.map(row => row.user_id)]));
    if (ids.length < 2) return <p>Do niezależnej oceny potrzeba dwóch asesorów z dostępem do rekrutacji.</p>;
    return <section><h2>Niezależne arkusze asesorów</h2>
      <PairedAssessorAssignmentForm action={assignAssessmentCenterPair.bind(null, route)} ids={ids} userId={user.id} />
    </section>;
  }
  const result = await client.rpc('ac_read_pair', { pair_id: pair.data });
  if (result.error) return <p>Nie udało się wczytać arkuszy.</p>;
  let report;
  try { report = parseAssessmentCenterPair(route.definitionId, definition, result.data); }
  catch { return <p>Nie udało się zweryfikować arkuszy dla tej wersji ćwiczenia.</p>; }
  if (report.state === 'ready') {
    const { sheets } = report;
    return <section><h2>Porównanie dwóch arkuszy</h2>
      <p>Oceny i dowody wymagają przeglądu człowieka. Raport nie podejmuje decyzji o zatrudnieniu.</p>
      {definition.criteria.map((criterion, index) => <article key={index}><h3>{criterion.competency}</h3>
        {sheets[0].evaluation.criteria[index].rating !== sheets[1].evaluation.criteria[index].rating && <p>Różne oceny asesorów</p>}
        {sheets.map((sheet, sheetIndex) => {
          const item = sheet.evaluation.criteria[index];
          return <div key={sheet.authorId}><strong>Asesor {sheetIndex + 1} · {sheet.authorId === user.id ? 'Ty' : sheet.authorId}</strong>
            <p>Oddano: <time dateTime={sheet.submittedAt}>{new Date(sheet.submittedAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}</time></p>
            <p>{behaviorRatings.find(([value]) => value === item.rating)?.[1]}</p>
            {item.evidence && <p className="cv-text">{item.evidence}</p>}
            {item.context && <p className="cv-text">Okoliczności: {item.context}</p>}
          </div>;
        })}
      </article>)}
    </section>;
  }
  if (report.ownSubmitted !== false) return <p>Porównanie będzie dostępne po oddaniu obu arkuszy.</p>;
  if (!processOpen) return <p>Proces jest zamknięty. Nie można oddać kolejnego arkusza.</p>;
  return <section><h2>Niezależna ocena</h2>
    <p>Przy ocenie wpisz dowód (co najmniej 10 znaków) oraz kontekst obserwacji (co najmniej 5 znaków). Przy braku danych pozostaw dowód pusty. Po oddaniu arkusz zostaje zamknięty.</p>
    <PairedAssessorForm action={submitAssessmentCenterSheet.bind(null, route, pair.data)} definition={definition} />
  </section>;
}
