import Link from 'next/link';
import {
  individualQuestionsStatusLabels, INDIVIDUAL_QUESTIONS_MAX_CANDIDATES, type ShortlistCandidateQuestions,
} from '../../../../../lib/individual-questions';

/**
 * Widok tylko do odczytu. Pytania indywidualne są osobną częścią: nie liczą się
 * do wspólnego wyniku testu kompetencji i nie wchodzą do porównania kandydatów.
 */
export function IndividualQuestionsSection({ companyId, recruitmentId, candidates, truncated }: {
  companyId: string; recruitmentId: string; candidates: ShortlistCandidateQuestions[]; truncated: boolean;
}) {
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  return <section aria-labelledby="individual-questions">
    <h2 id="individual-questions">Pytania indywidualne z luk w CV</h2>
    <p className="notice">To są pytania dla jednej osoby, ułożone z braków w jej CV, które rekruter sprawdził i zatwierdził.
      Ocenia się je osobno. Nie wchodzą do wspólnego wyniku testu kompetencji, który jest taki sam dla wszystkich
      i służy do porównania kandydatów. Pytania widzi tylko zespół rekrutacji: nic nie zostało wysłane kandydatowi.</p>
    <p>Lista obejmuje wyłącznie kandydatów z shortlisty tej rekrutacji. Brak informacji w CV oznacza brak danych, a nie ocenę negatywną.</p>
    {!candidates.length && <p role="status">Shortlista jest pusta. Dodaj kandydatów do shortlisty, aby zobaczyć pytania.</p>}
    {candidates.map(candidate => <article key={candidate.applicationId}>
      <h3>{candidate.label}</h3>
      {candidate.status === 'ready'
        ? <ol>{candidate.questions.map(question => <li key={question.sourceResultId}>
          <p><strong>{question.question}</strong></p>
          <p>Wymaganie: {question.requirement}{question.source === 'edited' && <small> · skorygowane przez człowieka</small>}</p>
          {question.missingInfo && <p>Czego brakuje: {question.missingInfo}</p>}
        </li>)}</ol>
        : <p role="status">{individualQuestionsStatusLabels[candidate.status]}</p>}
      <p><Link href={`${base}/applications/${candidate.applicationId}/screening`}>Analiza CV tego kandydata</Link></p>
    </article>)}
    {truncated && <p role="status">Pokazano pierwszych {INDIVIDUAL_QUESTIONS_MAX_CANDIDATES} kandydatów z shortlisty.</p>}
  </section>;
}
