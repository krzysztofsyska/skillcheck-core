import Link from 'next/link';
import { notFound } from 'next/navigation';
import { exerciseContext } from '../../../../../../lib/exercise-context';
import { behaviorRatings } from '../../../../../../lib/behavior-assessment';
import { assessmentCenterPreviewEnabled } from '../../../../../../lib/assessment-center-preview';
import { parseExerciseDefinition } from '../../../../../../lib/exercise-definition';
import {
  AC_FINALIST_LIMIT, AC_NO_DATA, AC_RECOMMENDED_FINALISTS, AC_STAGE_LIMIT, acChangeAssessments, acStageTypes,
  buildAssessmentCenterSessionReport, parseAssessmentCenterSession, type AcCriterionAgreement, type AssessmentCenterSession,
} from '../../../../../../lib/assessment-center-session';
import {
  addAcSessionFinalist, addAcSessionStage, assignAcSessionPair, confirmAcReconciliation, createAcSession, createAcSessionFromTemplate,
  recordAcReconciliation, recordAcSessionEntry, removeLastAcSessionStage, setAcSessionStatus,
} from './actions';
import { AcSessionForm } from './forms';

// SC-AC-SESSION (#276). Preview-only page behind AC_PAIRED_SHEETS_PREVIEW. It shows
// evidence for a human decision: no total, no ranking, no hire/reject suggestion.
export const dynamic = 'force-dynamic';
const ratingLabel = (value: string) => behaviorRatings.find(([key]) => key === value)?.[1] ?? AC_NO_DATA;
const stageTypeLabel = (value: string) => acStageTypes.find(([key]) => key === value)?.[1] ?? value;
const changeLabel = (value: string) => acChangeAssessments.find(([key]) => key === value)?.[1] ?? AC_NO_DATA;
const when = (value: string) => <time dateTime={value}>{new Date(value).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}</time>;
const statusLabel = { draft: 'Plan w przygotowaniu', open: 'Sesja otwarta', closed: 'Sesja zamknięta' } as const;

function Agreement({ value, who }: { value: AcCriterionAgreement; who: (id: string) => string }) {
  switch (value.status) {
    case 'not_assessed': return <p>Uzgodnienie: {AC_NO_DATA} — nie przypisano asesorów.</p>;
    case 'restricted': return <p>Arkusze widzą tylko dwaj asesorzy tego etapu i właściciel firmy.</p>;
    case 'awaiting_second_sheet': return <p>Uzgodnienie: {AC_NO_DATA} — porównanie będzie dostępne po oddaniu obu arkuszy.</p>;
    case 'not_reconciled': return <p>{value.ratingsDiffer ? 'Różne oceny asesorów — wymagane uzgodnienie albo zapis rozbieżności.' : 'Oceny zgodne — brak zapisu uzgodnienia.'}</p>;
    case 'awaiting_confirmation': return <p>Propozycja uzgodnienia ({who(value.recordedBy)}): {ratingLabel(value.rating)} — {value.justification}. Czeka na odpowiedź drugiego asesora.</p>;
    case 'agreed': return <p>Uzgodniono: {ratingLabel(value.rating)} — {value.justification} (zapis: {who(value.recordedBy)}, potwierdzony przez drugiego asesora).</p>;
    case 'discrepancy': return <p>Jawna rozbieżność — obie oceny pozostają: {value.note} (zapis: {who(value.recordedBy)}{value.awaitingConfirmation ? ', czeka na odpowiedź drugiego asesora' : ''}).</p>;
    case 'disputed': return <p>Zapis uzgodnienia zakwestionowany przez {who(value.disputedBy)}: {value.disputeNote}. Obie oceny pozostają jako rozbieżność.</p>;
  }
}

export default async function AssessmentCenterSessionPage({ params }: { params: Promise<{ companyId: string; recruitmentId: string }> }) {
  if (!assessmentCenterPreviewEnabled()) notFound();
  const route = await params;
  const { client, company, user, canEdit, editable, recruitment } = await exerciseContext(route.companyId, route.recruitmentId);
  if (!canEdit) notFound();
  const { companyId, recruitmentId } = route;
  const recruitmentPath = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  const isOwner = company.owner_id === user.id;
  const who = (id: string) => id === user.id ? 'Ty' : id;
  const frame = (body: React.ReactNode) => <main className="workspace"><section>
    <Link href={recruitmentPath}>← Rekrutacja</Link>
    <h1>Sesja Assessment Center — {recruitment.name}</h1>
    <p>Strona pokazuje dowody z obserwacji. Nie wylicza wyniku, nie tworzy rankingu i nie podejmuje decyzji o zatrudnieniu — decyzję podejmuje człowiek.</p>
    {body}
  </section></main>;

  const found = await client.rpc('ac_session_find', { recruitment: recruitmentId });
  if (found.error) return frame(<p role="status">Sesje Assessment Center nie są jeszcze dostępne w tym środowisku.</p>);
  if (!found.data) {
    if (!isOwner || !editable) return frame(<p>Dla tej rekrutacji nie zaplanowano jeszcze sesji. Sesję planuje właściciel firmy.</p>);
    return frame(<>
      <h2>Zaplanuj sesję</h2>
      <p>Jedna sesja na rekrutację. Zalecane {AC_RECOMMENDED_FINALISTS[0]}–{AC_RECOMMENDED_FINALISTS[1]} finalistów, najwyżej {AC_FINALIST_LIMIT}.</p>
      <AcSessionForm action={createAcSession.bind(null, route)} legend="Nowa sesja" button="Utwórz sesję" saved="Utworzono sesję.">
        <label>Nazwa sesji<input name="title" maxLength={200} required /></label>
        <label>Kompetencje do oceny — jedna w wierszu, nazwy dokładnie jak w kryteriach ćwiczeń
          <textarea name="competencies" rows={5} required /></label>
      </AcSessionForm>
      <AcSessionForm action={createAcSessionFromTemplate.bind(null, route)} legend="Szablon: case HRBP (dane syntetyczne)"
        button="Utwórz sesję z szablonu HRBP" saved="Utworzono sesję z szablonu.">
        <p>Trzy etapy studium przypadku (diagnoza przyczyn, konsekwencje finansowe, plan zmiany) i symulacja rozmowy z człowiekiem. Firma i liczby w szablonie są zmyślone.</p>
      </AcSessionForm>
    </>);
  }

  const read = await client.rpc('ac_session_read', { session: found.data });
  if (read.error) return frame(<p role="alert">Nie udało się wczytać sesji.</p>);
  let session: AssessmentCenterSession;
  try { session = parseAssessmentCenterSession(read.data); }
  catch { return frame(<p role="alert">Nie udało się zweryfikować danych sesji. Raport nie jest wyświetlany.</p>); }
  const report = buildAssessmentCenterSessionReport(session);
  const { status } = session.session;

  const [applications, shortlist, definitions, members] = await Promise.all([
    client.from('applications').select('id,candidate_id').eq('company_id', companyId).eq('recruitment_id', recruitmentId),
    isOwner && status !== 'closed' ? client.from('recruitment_shortlist_entries').select('application_id').eq('company_id', companyId)
      .eq('recruitment_id', recruitmentId).is('removed_at', null) : null,
    isOwner && status === 'draft' ? client.from('latest_exercise_definitions').select('id,version,definition').eq('company_id', companyId)
      .eq('recruitment_id', recruitmentId).limit(100) : null,
    isOwner && status === 'open' ? client.from('company_members').select('user_id').eq('company_id', companyId).eq('role', 'recruiter') : null,
  ]);
  if (applications.error) return frame(<p role="alert">Nie udało się wczytać zgłoszeń.</p>);
  const candidateIds = Array.from(new Set(applications.data.map(row => row.candidate_id)));
  const candidates = candidateIds.length ? await client.from('candidates').select('id,first_name,last_name').eq('company_id', companyId).in('id', candidateIds) : null;
  const names = new Map((candidates?.data ?? []).map(row => [row.id, `${row.first_name} ${row.last_name}`.trim()]));
  const nameOf = (applicationId: string) => names.get(applications.data.find(row => row.id === applicationId)?.candidate_id ?? '') ?? 'Finalista';
  const finalistIds = new Set(session.finalists.map(finalist => finalist.applicationId));
  const available = (shortlist?.data ?? []).filter(row => !finalistIds.has(row.application_id));
  const usedRevisions = new Set(session.stages.map(stage => stage.definitionId));
  const acDefinitions = (definitions?.data ?? []).flatMap(row => {
    try { const definition = parseExerciseDefinition(row.definition); return definition.kind === 'assessment_center' && !usedRevisions.has(row.id) ? [{ id: row.id, version: row.version, title: definition.title }] : []; }
    catch { return []; }
  });
  const assessors = Array.from(new Set([company.owner_id, ...(members?.data ?? []).map(row => row.user_id)]));
  const processOpen = editable && status === 'open';

  return frame(<>
    <h2>{session.session.title}</h2>
    <p><strong>{statusLabel[status]}</strong>{session.session.openedAt && <> · otwarta {when(session.session.openedAt)}</>}{session.session.closedAt && <> · zamknięta {when(session.session.closedAt)}</>}</p>

    <h2>Plan pokrycia kompetencji</h2>
    <dl>{report.coverage.map(row => <div key={row.competency}><dt>{row.competency}</dt>
      <dd>{row.coveredBy.length ? row.coveredBy.join('; ') : <strong>Brak etapu oceniającego tę kompetencję</strong>}</dd></div>)}</dl>
    {report.uncovered.length > 0 && <p role="alert">Sesji nie można otworzyć: {report.uncovered.length === 1 ? 'kompetencja bez etapu' : 'kompetencje bez etapu'} — {report.uncovered.join(', ')}.</p>}

    <h2>Etapy</h2>
    {!report.stages.length && <p>Brak etapów.</p>}
    <ol>{report.stages.map(stage => <li key={stage.id}><strong>{stage.title}</strong> — {stageTypeLabel(stage.type)}; ćwiczenie: {stage.exerciseTitle}
      {stage.counterpartBrief && <p className="cv-text">Rola rozmówcy: {stage.counterpartBrief}</p>}</li>)}</ol>
    {isOwner && editable && status === 'draft' && report.stages.length < AC_STAGE_LIMIT && (acDefinitions.length
      ? <AcSessionForm action={addAcSessionStage.bind(null, route)} legend="Dodaj etap" button="Dodaj etap" saved="Dodano etap.">
        <label>Rodzaj<select name="kind">{acStageTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Nazwa etapu<input name="title" maxLength={200} required /></label>
        <label>Ćwiczenie Assessment Center (dokładna wersja)<select name="revision">{acDefinitions.map(row => <option key={row.id} value={row.id}>{row.title} — wersja {row.version}</option>)}</select></label>
        <label>Rola człowieka w symulacji (tylko dla symulacji, co najmniej 10 znaków)<textarea name="counterpart" maxLength={2000} /></label>
      </AcSessionForm>
      : <p>Aby dodać etap, najpierw <Link href={`${recruitmentPath}/exercises/new`}>utwórz ćwiczenie Assessment Center</Link> z kryteriami oceny.</p>)}

    {isOwner && editable && status === 'draft' && report.stages.length > 0 && <AcSessionForm key={report.stages.length} action={removeLastAcSessionStage.bind(null, route)}
      legend="Korekta planu" button="Usuń ostatni etap" saved="Usunięto ostatni etap."><p>Etapów nie edytuje się w miejscu. Przed otwarciem sesji można cofnąć ostatnio dodany etap i dodać go ponownie.</p></AcSessionForm>}

    <h2>Finaliści</h2>
    <p>{report.finalistAdvice.message} Twardy limit: {AC_FINALIST_LIMIT}. Finalistą może być tylko osoba z krótkiej listy tej rekrutacji.</p>
    {isOwner && editable && status !== 'closed' && session.finalists.length < AC_FINALIST_LIMIT && (available.length
      ? <AcSessionForm action={addAcSessionFinalist.bind(null, route)} legend="Dodaj finalistę z krótkiej listy" button="Dodaj finalistę" saved="Dodano finalistę.">
        <label>Osoba<select name="application">{available.map(row => <option key={row.application_id} value={row.application_id}>{nameOf(row.application_id)}</option>)}</select></label>
      </AcSessionForm>
      : <p>Na krótkiej liście nie ma kolejnych osób do dodania.</p>)}

    {isOwner && editable && status === 'draft' && <AcSessionForm action={setAcSessionStatus.bind(null, route, 'open')} legend="Otwarcie sesji"
      button="Otwórz sesję" saved="Sesja została otwarta."><p>Po otwarciu plan i etapy są zamrożone. Sesja otworzy się tylko wtedy, gdy każda kompetencja ma etap, który ją ocenia.</p></AcSessionForm>}
    {isOwner && status === 'open' && <AcSessionForm action={setAcSessionStatus.bind(null, route, 'closed')} legend="Zamknięcie sesji"
      button="Zamknij sesję" saved="Sesja została zamknięta."><p>Po zamknięciu raport pozostaje dostępny, ale nie można dodawać kolejnych zapisów.</p></AcSessionForm>}

    <h2>Raport sesji</h2>
    <p>Kolejność finalistów to kolejność dodania do sesji — nie jest rankingiem.</p>
    {!report.finalists.length && <p>Brak finalistów.</p>}
    {report.finalists.map((finalist, finalistIndex) => {
      const raw = session.finalists[finalistIndex];
      return <article key={finalist.applicationId}>
        <h3>{nameOf(finalist.applicationId)}</h3>

        <h4>Dowody według kompetencji</h4>
        {finalist.competencies.map(item => <section key={item.competency}><h5>{item.competency}</h5>
          {!item.hasEvidence && <p><strong>{AC_NO_DATA}</strong> — żaden asesor nie zapisał jeszcze dowodu dla tej kompetencji.</p>}
          {item.evidence.map(row => <div key={row.stageId}><p><em>{row.stageTitle}</em></p>
            {row.assessors.map((assessor, index) => <div key={assessor.authorId}><strong>Asesor {index + 1} · {who(assessor.authorId)}</strong>: {ratingLabel(assessor.rating)}
              {assessor.hasEvidence ? <><p className="cv-text">{assessor.evidence}</p><p className="cv-text">Okoliczności: {assessor.context}</p></> : <p>{AC_NO_DATA}</p>}</div>)}
            <Agreement value={row.agreement} who={who} />
          </div>)}
        </section>)}

        <h4>Etapy: arkusze, pierwsza próba i poprawiona praca</h4>
        {session.stages.map((stage, stageIndex) => {
          const { pair } = raw.stages[stageIndex], attempt = finalist.attempts[stageIndex];
          const isAssessor = pair.state === 'ready' && pair.sheets.some(sheet => sheet.authorId === user.id);
          const entry = (kind: Parameters<typeof recordAcSessionEntry>[3]) => recordAcSessionEntry.bind(null, route, finalist.applicationId, stage.id, kind);
          return <section key={stage.id}><h5>{stage.title}</h5>
            {pair.state === 'unassigned' && <p>Asesorzy: {AC_NO_DATA} — nie przypisano.</p>}
            {pair.state === 'unassigned' && isOwner && processOpen && (assessors.length >= 2
              ? <AcSessionForm action={assignAcSessionPair.bind(null, route, stage.id, finalist.applicationId)} legend="Przypisz dwóch niezależnych asesorów" button="Przypisz asesorów" saved="Przypisano asesorów.">
                {(['first', 'second'] as const).map((name, index) => <label key={name}>Asesor {index + 1}
                  <select name={name} defaultValue={assessors[index]}>{assessors.map(id => <option key={id} value={id}>{who(id)}</option>)}</select></label>)}
              </AcSessionForm>
              : <p>Do niezależnej oceny potrzeba dwóch asesorów z dostępem do rekrutacji.</p>)}
            {pair.state === 'restricted' && <p>Arkusze tego etapu widzą tylko dwaj przypisani asesorzy i właściciel firmy.</p>}
            {pair.state === 'pending' && <p>{pair.ownSubmitted === false
              ? <Link href={`${recruitmentPath}/applications/${finalist.applicationId}/exercises/${stage.definitionId}`}>Oddaj swój niezależny arkusz</Link>
              : 'Porównanie arkuszy będzie dostępne po oddaniu obu. Do tego czasu żaden asesor nie widzi arkusza drugiego.'}</p>}
            {pair.state === 'ready' && !pair.reconciliation && (isAssessor && editable
              ? <AcSessionForm action={recordAcReconciliation.bind(null, route, pair.pairId)} legend="Uzgodnienie ocen" button="Zapisz uzgodnienie" saved="Zapisano uzgodnienie. Czeka na odpowiedź drugiego asesora.">
                <p>Uzgodniona ocena musi być jedną z dwóch oddanych ocen. Jeśli pozostajecie przy różnych ocenach, zapisz rozbieżność — obie oceny zostaną w raporcie.</p>
                {stage.definition.criteria.map((criterion, index) => {
                  const given = pair.sheets.map(sheet => sheet.observations[index].rating);
                  const differ = given[0] !== given[1];
                  return <fieldset key={index}><legend>{criterion.competency}: {ratingLabel(given[0])} / {ratingLabel(given[1])}</legend>
                    <label>Wynik<select name="outcome" defaultValue="agreed"><option value="agreed">Uzgodniona ocena</option>{differ && <option value="discrepancy">Jawna rozbieżność</option>}</select></label>
                    <label>Uzgodniona ocena<select name="rating" defaultValue={given[0]}>{Array.from(new Set(given)).map(value => <option key={value} value={value}>{ratingLabel(value)}</option>)}</select></label>
                    <label>Uzasadnienie albo opis rozbieżności<textarea name="note" minLength={10} maxLength={2000} required /></label>
                  </fieldset>;
                })}
              </AcSessionForm>
              : <p>Uzgodnienie: {AC_NO_DATA} — zapisuje je jeden z dwóch asesorów tego etapu.</p>)}
            {pair.state === 'ready' && pair.reconciliation && pair.reconciliation.confirmation === null && isAssessor && pair.reconciliation.recordedBy !== user.id && editable
              && <AcSessionForm action={confirmAcReconciliation.bind(null, route, pair.pairId)} legend="Odpowiedź na zapis uzgodnienia" button="Zapisz odpowiedź" saved="Zapisano odpowiedź.">
                <label>Odpowiedź<select name="verdict"><option value="confirmed">Potwierdzam zapis</option><option value="disputed">Nie zgadzam się z zapisem</option></select></label>
                <label>Powód niezgody (wymagany przy niezgodzie)<textarea name="note" maxLength={2000} /></label>
              </AcSessionForm>}

            <dl>
              <dt>Pierwsza próba</dt><dd>{attempt.firstAttempt ? <><span className="cv-text">{attempt.firstAttempt.work}</span> ({who(attempt.firstAttempt.authorId)}, {when(attempt.firstAttempt.createdAt)})</> : AC_NO_DATA}</dd>
              <dt>Informacja zwrotna asesora</dt><dd>{attempt.feedback ? <><span className="cv-text">{attempt.feedback.feedback}</span> ({who(attempt.feedback.authorId)}, {when(attempt.feedback.createdAt)})</> : AC_NO_DATA}</dd>
              <dt>Poprawiona praca</dt><dd>{attempt.revisedAttempt ? <><span className="cv-text">{attempt.revisedAttempt.work}</span> ({who(attempt.revisedAttempt.authorId)}, {when(attempt.revisedAttempt.createdAt)})</> : AC_NO_DATA}</dd>
              <dt>Dowód zmiany</dt><dd>{attempt.changeProof ? <><strong>{changeLabel(attempt.changeProof.assessment)}</strong>. Co się zmieniło: <span className="cv-text">{attempt.changeProof.changes}</span>
                {attempt.changeProof.evidence ? <> Dowód: <span className="cv-text">{attempt.changeProof.evidence}</span></> : <> Dowód: {AC_NO_DATA}</>} ({who(attempt.changeProof.authorId)}, {when(attempt.changeProof.createdAt)})</> : AC_NO_DATA}</dd>
            </dl>
            {processOpen && !attempt.firstAttempt && <AcSessionForm action={entry('first_attempt')} legend="Zapisz pierwszą próbę" button="Zapisz pierwszą próbę" saved="Zapisano pierwszą próbę. Tego zapisu nie można zmienić.">
              <label>Praca finalisty w pierwszej próbie (co najmniej 20 znaków)<textarea name="work" minLength={20} maxLength={20000} required /></label></AcSessionForm>}
            {processOpen && attempt.firstAttempt && !attempt.feedback && isAssessor && <AcSessionForm action={entry('feedback')} legend="Informacja zwrotna asesora" button="Zapisz informację zwrotną" saved="Zapisano informację zwrotną.">
              <label>Informacja zwrotna po pierwszej próbie (co najmniej 20 znaków)<textarea name="feedback" minLength={20} maxLength={8000} required /></label></AcSessionForm>}
            {processOpen && attempt.feedback && !attempt.revisedAttempt && <AcSessionForm action={entry('revised_attempt')} legend="Zapisz poprawioną pracę" button="Zapisz poprawioną pracę" saved="Zapisano poprawioną pracę. Pierwsza próba pozostaje bez zmian.">
              <label>Poprawiona praca finalisty (co najmniej 20 znaków)<textarea name="work" minLength={20} maxLength={20000} required /></label></AcSessionForm>}
            {processOpen && attempt.revisedAttempt && !attempt.changeProof && isAssessor && <AcSessionForm action={entry('change_proof')} legend="Dowód zmiany" button="Zapisz dowód zmiany" saved="Zapisano dowód zmiany.">
              <label>Co się zmieniło między pierwszą próbą a poprawioną pracą (co najmniej 20 znaków)<textarea name="changes" minLength={20} maxLength={8000} required /></label>
              <label>Ocena dowodu<select name="assessment">{acChangeAssessments.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>Dowód zmiany — konkretny fragment pracy (pozostaw pusty przy „Niewystarczające dane”)<textarea name="evidence" maxLength={4000} /></label></AcSessionForm>}
          </section>;
        })}

        <h4>Konsultacja eksperta</h4>
        {!finalist.expertNotes.length && <p>{AC_NO_DATA}</p>}
        <ul>{finalist.expertNotes.map((note, index) => <li key={index}><span className="cv-text">{note.note}</span> ({who(note.authorId)}, {when(note.createdAt)})</li>)}</ul>
        {processOpen && <AcSessionForm key={finalist.expertNotes.length} action={recordAcSessionEntry.bind(null, route, finalist.applicationId, null, 'expert_consultation')}
          legend="Dodaj notatkę z konsultacji eksperta" button="Dodaj notatkę" saved="Dodano notatkę.">
          <label>Notatka (co najmniej 10 znaków). Wcześniejszych notatek nie można zmienić.<textarea name="note" minLength={10} maxLength={8000} required /></label></AcSessionForm>}
      </article>;
    })}
  </>);
}
