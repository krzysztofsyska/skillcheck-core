import { individualQuestionsStatusLabels, type CandidateQuestions } from '../../../../../lib/individual-questions';

/**
 * ROADMAP R1 / C6: pytania indywidualne z luk w CV jednego kandydata, przy
 * wydawaniu testu kompetencji. Tylko do odczytu: bez formularza, bez zapisu,
 * nic nie trafia do kandydata.
 */
export function CandidateIndividualQuestions({ result }: { result: CandidateQuestions }) {
  return <section aria-labelledby="candidate-individual-questions">
    <h2 id="candidate-individual-questions">Pytania indywidualne z luk w CV</h2>
    <p className="notice">Pytania ułożone z braków w CV tej osoby, które rekruter sprawdził i zatwierdził. Ocenia się je osobno:
      nie wchodzą do wspólnego wyniku testu kompetencji, który jest taki sam dla wszystkich kandydatów.
      Pytania widzi tylko zespół rekrutacji, nic nie zostało wysłane kandydatowi.</p>
    {result.status === 'ready'
      ? <ol>{result.questions.map(question => <li key={question.sourceResultId}>
        <p><strong>{question.question}</strong></p>
        <p>Wymaganie: {question.requirement}{question.source === 'edited' && <small> · skorygowane przez człowieka</small>}</p>
        {question.missingInfo && <p>Czego brakuje: {question.missingInfo}</p>}
      </li>)}</ol>
      : <p role="status">{individualQuestionsStatusLabels[result.status]}</p>}
    <p>Brak informacji w CV oznacza brak danych, a nie ocenę negatywną.</p>
  </section>;
}
